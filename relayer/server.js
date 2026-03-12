/**
 * TokenCloak Privacy Relayer v2
 * 
 * Features:
 * 1. Time-delayed withdrawals (1-10 min random delay)
 * 2. Background commitment padding (fake entries in Merkle tree)
 * 3. Rate limiting and validation
 */
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { Connection, Keypair, PublicKey, SystemProgram } = require('@solana/web3.js');
const { Program, AnchorProvider, Wallet, BN } = require('@coral-xyz/anchor');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, getAccount } = require('@solana/spl-token');
const fs = require('fs');
const path = require('path');

// ============================================================================
// Configuration
// ============================================================================

const PORT = process.env.PORT || 3001;
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) { console.error('RPC_URL env var is required'); process.exit(1); }
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || 'EQfV5pm72GfrifQX3LCiRzUf7zZdJ6hS7PbM9o6x6FVs');
// Delay config (milliseconds)
const MIN_DELAY_MS = 60_000;     // 1 minute
const MAX_DELAY_MS = 600_000;    // 10 minutes

// Padding config
const PAD_INTERVAL_MS = 180_000; // Pad every 3 minutes
const PAD_ENABLED = process.env.PAD_ENABLED !== 'false';

// Load relayer keypair
const keypairPath = process.env.KEYPAIR_PATH || path.join(__dirname, 'relayer-keypair.json');
const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf8'));
const relayerKeypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
console.log(`Relayer wallet: ${relayerKeypair.publicKey.toBase58()}`);

// Load IDL
const idl = JSON.parse(fs.readFileSync(path.join(__dirname, 'idl.json'), 'utf8'));

// ============================================================================
// Setup
// ============================================================================

const connection = new Connection(RPC_URL, 'confirmed');
const wallet = new Wallet(relayerKeypair);
const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
const program = new Program(idl, provider);

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

// Rate limiting: 1 request per 30 seconds per IP
const limiter = rateLimit({
    windowMs: 30 * 1000,
    max: 1,
    message: { error: 'Rate limited. Wait 30 seconds.' },
});

// ============================================================================
// Withdrawal Queue (time-delayed processing)
// ============================================================================

const withdrawalQueue = new Map(); // jobId → { status, data, scheduledAt, signature, error }

function generateJobId() {
    return crypto.randomBytes(8).toString('hex');
}

function getRandomDelay() {
    return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

async function processWithdrawal(jobId) {
    const job = withdrawalQueue.get(jobId);
    if (!job) return;

    try {
        job.status = 'processing';
        const { tokenMint, depositAmount, proof, root, nullifierHash, recipientField, recipientAddress } = job.data;

        const mintPubkey = new PublicKey(tokenMint);
        const recipientPubkey = new PublicKey(recipientAddress);
        const rawAmount = new BN(depositAmount);

        // Derive pool PDA
        const [poolPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('pool'), mintPubkey.toBuffer(), rawAmount.toBuffer('le', 8)],
            PROGRAM_ID
        );

        // Find merkle tree
        const merkleAccounts = await program.account.merkleTreeAccount.all([
            { memcmp: { offset: 8, bytes: poolPda.toBase58() } }
        ]);
        if (merkleAccounts.length === 0) throw new Error('No merkle tree found');
        const merkleTreeKey = merkleAccounts[0].publicKey;

        // Find vault
        const vaultAccounts = await connection.getTokenAccountsByOwner(poolPda, { mint: mintPubkey });
        if (vaultAccounts.value.length === 0) throw new Error('No vault found');
        const vaultKey = vaultAccounts.value[0].pubkey;

        // Detect token program
        const mintInfo = await connection.getAccountInfo(mintPubkey);
        const tokenProgramId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

        // Get or create recipient ATA
        const recipientAta = await getAssociatedTokenAddress(mintPubkey, recipientPubkey, false, tokenProgramId);
        let preInstructions = [];
        try { await getAccount(connection, recipientAta); }
        catch { preInstructions.push(createAssociatedTokenAccountInstruction(relayerKeypair.publicKey, recipientAta, recipientPubkey, mintPubkey, tokenProgramId)); }

        // Nullifier PDA
        const [nullifierPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('nullifier'), Buffer.from(nullifierHash)],
            PROGRAM_ID
        );

        // Submit withdrawal
        const tx = await program.methods
            .withdraw(proof, root, nullifierHash, recipientField)
            .accounts({
                pool: poolPda,
                merkleTree: merkleTreeKey,
                nullifierAccount: nullifierPda,
                vault: vaultKey,
                tokenMint: mintPubkey,
                recipient: recipientPubkey,
                recipientAta,
                relayer: relayerKeypair.publicKey,
                systemProgram: SystemProgram.programId,
                tokenProgram: tokenProgramId,
            })
            .preInstructions(preInstructions)
            .signers([relayerKeypair])
            .rpc();

        job.status = 'completed';
        job.signature = tx;
        console.log(`[RELAY] Job ${jobId} completed: ${tx}`);
    } catch (err) {
        job.status = 'failed';
        job.error = err.message;
        console.error(`[RELAY] Job ${jobId} failed:`, err.message);
    }
}

// ============================================================================
// Commitment Padding (background loop)
// ============================================================================

async function padMerkleTrees() {
    if (!PAD_ENABLED) return;
    try {
        // Find all merkle trees
        const allTrees = await program.account.merkleTreeAccount.all();
        for (const tree of allTrees) {
            const treeData = tree.account;
            const maxLeaves = 1 << 5; // TREE_DEPTH = 5 → 32 leaves
            if (treeData.nextIndex >= maxLeaves) continue; // Full

            // Generate random commitment (unwithdrawable — nobody knows the preimage)
            const randomCommitment = Array.from(crypto.randomBytes(32));

            try {
                await program.methods
                    .padTree(randomCommitment)
                    .accounts({
                        merkleTree: tree.publicKey,
                        relayer: relayerKeypair.publicKey,
                    })
                    .signers([relayerKeypair])
                    .rpc();
                console.log(`[PAD] Padded tree ${tree.publicKey.toBase58().slice(0, 8)}... (idx ${treeData.nextIndex})`);
            } catch (err) {
                // Silently skip if tree is full or other transient error
                if (!err.message.includes('MerkleTreeFull')) {
                    console.error(`[PAD] Error:`, err.message);
                }
            }
        }
    } catch (err) {
        console.error('[PAD] Loop error:', err.message);
    }
}

// ============================================================================
// Routes
// ============================================================================

app.get('/health', async (req, res) => {
    try {
        const balance = await connection.getBalance(relayerKeypair.publicKey);
        res.json({
            status: 'ok',
            relayer: relayerKeypair.publicKey.toBase58(),
            balance: balance / 1e9,
            program: PROGRAM_ID.toBase58(),
            queueSize: withdrawalQueue.size,
            paddingEnabled: PAD_ENABLED,
        });
    } catch (err) {
        res.status(500).json({ error: 'Unhealthy', details: err.message });
    }
});

app.post('/relay', limiter, async (req, res) => {
    try {
        const { tokenMint, depositAmount, proof, root, nullifierHash, recipientField, recipientAddress } = req.body;

        // Validation
        if (!tokenMint || !depositAmount || !proof || !root || !nullifierHash || !recipientField || !recipientAddress) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (proof.length !== 256) return res.status(400).json({ error: 'Proof must be 256 bytes' });
        if (root.length !== 32) return res.status(400).json({ error: 'Root must be 32 bytes' });
        if (nullifierHash.length !== 32) return res.status(400).json({ error: 'NullifierHash must be 32 bytes' });
        if (recipientField.length !== 32) return res.status(400).json({ error: 'RecipientField must be 32 bytes' });

        // Create delayed job
        const jobId = generateJobId();
        const delay = getRandomDelay();
        const scheduledAt = Date.now() + delay;

        withdrawalQueue.set(jobId, {
            status: 'queued',
            data: req.body,
            scheduledAt,
            signature: null,
            error: null,
        });

        // Schedule execution after random delay
        setTimeout(() => processWithdrawal(jobId), delay);

        const delayMin = Math.round(delay / 60000 * 10) / 10;
        console.log(`[RELAY] Job ${jobId} queued, delay: ${delayMin} min`);

        res.json({
            jobId,
            status: 'queued',
            estimatedCompletionMs: delay,
            message: `Withdrawal queued. Estimated processing in ~${delayMin} minutes for privacy.`,
        });
    } catch (err) {
        console.error('[RELAY] Queue error:', err.message);
        res.status(500).json({ error: 'Relay failed', details: err.message });
    }
});

app.get('/status/:jobId', (req, res) => {
    const job = withdrawalQueue.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const response = {
        jobId: req.params.jobId,
        status: job.status,
        signature: job.signature,
        error: job.error,
    };

    if (job.status === 'queued') {
        response.estimatedWaitMs = Math.max(0, job.scheduledAt - Date.now());
    }

    res.json(response);
});

// ============================================================================
// Start
// ============================================================================

app.listen(PORT, () => {
    console.log(`TokenCloak Relayer v2 running on port ${PORT}`);
    console.log(`Program: ${PROGRAM_ID.toBase58()}`);
    console.log(`Relayer: ${relayerKeypair.publicKey.toBase58()}`);
    console.log(`Delays:  ${MIN_DELAY_MS / 1000}s - ${MAX_DELAY_MS / 1000}s`);
    console.log(`Padding: ${PAD_ENABLED ? `enabled (every ${PAD_INTERVAL_MS / 1000}s)` : 'disabled'}`);

    // Start padding loop
    if (PAD_ENABLED) {
        setInterval(padMerkleTrees, PAD_INTERVAL_MS);
        console.log('[PAD] Background padding loop started');
    }

    // Clean up old jobs every 30 minutes
    setInterval(() => {
        const cutoff = Date.now() - 3600_000; // 1 hour
        for (const [id, job] of withdrawalQueue) {
            if (job.scheduledAt < cutoff && job.status !== 'queued') {
                withdrawalQueue.delete(id);
            }
        }
    }, 1800_000);
});
