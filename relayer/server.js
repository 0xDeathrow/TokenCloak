/**
 * TokenCloak Privacy Relayer v3 — Multi-Hop
 * 
 * Features:
 * 1. Multi-hop withdrawals: Vault → Hop A → Hop B → Recipient
 * 2. Time-delayed processing (1-10 min random delay before first hop)
 * 3. Random delays between hops (1-3 min each)
 * 4. Background commitment padding
 * 5. /relay/prepare endpoint for frontend to get intermediate address
 */
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const { Program, AnchorProvider, Wallet, BN } = require('@coral-xyz/anchor');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferInstruction, getAccount } = require('@solana/spl-token');
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
const MAX_DELAY_MS = 120_000;    // 2 minutes
const MIN_HOP_DELAY_MS = 10_000; // 10s between hops
const MAX_HOP_DELAY_MS = 30_000; // 30s between hops

// Padding config
const PAD_INTERVAL_MS = 180_000;
const PAD_ENABLED = process.env.PAD_ENABLED !== 'false';

// ============================================================================
// Load Keypairs
// ============================================================================

function loadKeypair(envVar, filePath) {
    let data;
    if (process.env[envVar]) {
        data = JSON.parse(process.env[envVar]);
    } else if (fs.existsSync(filePath)) {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } else {
        return null;
    }
    return Keypair.fromSecretKey(new Uint8Array(data));
}

const relayerKeypair = loadKeypair('RELAYER_KEY', path.join(__dirname, 'relayer-keypair.json'));
if (!relayerKeypair) { console.error('Relayer keypair not found'); process.exit(1); }

// Load hop wallets (intermediate relay wallets)
const hopWallets = [];
for (let i = 1; i <= 3; i++) {
    const kp = loadKeypair(`HOP${i}_KEY`, path.join(__dirname, `hop${i}-keypair.json`));
    if (kp) {
        hopWallets.push(kp);
        console.log(`Hop ${i}: ${kp.publicKey.toBase58()}`);
    }
}
if (hopWallets.length < 2) {
    console.error('Need at least 2 hop wallets'); process.exit(1);
}

console.log(`Relayer wallet: ${relayerKeypair.publicKey.toBase58()}`);
console.log(`Hop wallets: ${hopWallets.length}`);

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

const limiter = rateLimit({
    windowMs: 30 * 1000,
    max: 2,
    message: { error: 'Rate limited. Wait 30 seconds.' },
});

// ============================================================================
// Withdrawal Queue
// ============================================================================

const withdrawalQueue = new Map();

function generateJobId() {
    return crypto.randomBytes(8).toString('hex');
}

function getRandomDelay() {
    return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

function getHopDelay() {
    return MIN_HOP_DELAY_MS + Math.random() * (MAX_HOP_DELAY_MS - MIN_HOP_DELAY_MS);
}

function pickRandomHopWallets() {
    // Pick 2 different hop wallets for the relay chain
    const shuffled = [...hopWallets].sort(() => Math.random() - 0.5);
    return [shuffled[0], shuffled[1]];
}

// ============================================================================
// SPL Token Transfer Helper
// ============================================================================

async function transferSPLTokens(fromKeypair, toPublicKey, mintPubkey, amount, tokenProgramId) {
    const fromAta = await getAssociatedTokenAddress(mintPubkey, fromKeypair.publicKey, true, tokenProgramId);
    const toAta = await getAssociatedTokenAddress(mintPubkey, toPublicKey, true, tokenProgramId);

    const tx = new Transaction();

    // Create recipient ATA if it doesn't exist
    try { await getAccount(connection, toAta); }
    catch {
        tx.add(createAssociatedTokenAccountInstruction(
            fromKeypair.publicKey, toAta, toPublicKey, mintPubkey, tokenProgramId
        ));
    }

    // Transfer tokens
    tx.add(createTransferInstruction(fromAta, toAta, fromKeypair.publicKey, amount, [], tokenProgramId));

    const sig = await sendAndConfirmTransaction(connection, tx, [fromKeypair]);
    return sig;
}

// ============================================================================
// Multi-Hop Withdrawal Processing
// ============================================================================

async function processWithdrawal(jobId) {
    const job = withdrawalQueue.get(jobId);
    if (!job) return;

    try {
        job.status = 'processing';
        const { tokenMint, depositAmount, proof, root, nullifierHash, recipientField, intermediateAddress, finalRecipient } = job.data;

        const mintPubkey = new PublicKey(tokenMint);
        const intermediatePubkey = new PublicKey(intermediateAddress);
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

        // depositAmount is already in raw on-chain units (e.g. 1000000000 for 1000 tokens with 6 decimals)
        // The on-chain withdraw sends pool.deposit_amount which matches this value
        const onChainDecimals = mintInfo.data[44];
        const rawTokenAmount = BigInt(depositAmount);

        // Get or create intermediate wallet ATA
        const intermediateAta = await getAssociatedTokenAddress(mintPubkey, intermediatePubkey, false, tokenProgramId);
        let preInstructions = [];
        try { await getAccount(connection, intermediateAta); }
        catch { preInstructions.push(createAssociatedTokenAccountInstruction(relayerKeypair.publicKey, intermediateAta, intermediatePubkey, mintPubkey, tokenProgramId)); }

        // Nullifier PDA
        const [nullifierPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('nullifier'), Buffer.from(nullifierHash)],
            PROGRAM_ID
        );

        // ===== HOP 1: On-chain withdraw (Vault → Intermediate A) =====
        console.log(`[HOP1] Job ${jobId}: Vault → ${intermediateAddress.slice(0, 8)}...`);
        const tx1 = await program.methods
            .withdraw(proof, root, nullifierHash, recipientField)
            .accounts({
                pool: poolPda,
                merkleTree: merkleTreeKey,
                nullifierAccount: nullifierPda,
                vault: vaultKey,
                tokenMint: mintPubkey,
                recipient: intermediatePubkey,
                recipientAta: intermediateAta,
                relayer: relayerKeypair.publicKey,
                systemProgram: SystemProgram.programId,
                tokenProgram: tokenProgramId,
            })
            .preInstructions(preInstructions)
            .signers([relayerKeypair])
            .rpc();
        console.log(`[HOP1] Done: ${tx1}`);

        // Find which hop wallet is the intermediate
        const hopA = hopWallets.find(kp => kp.publicKey.equals(intermediatePubkey));
        if (!hopA) throw new Error('Intermediate wallet not found in hop wallets');

        // Pick a different hop wallet for the second hop
        const hopB = hopWallets.find(kp => !kp.publicKey.equals(intermediatePubkey));
        if (!hopB) throw new Error('Need at least 2 hop wallets');

        // ===== HOP 2: Intermediate A → Intermediate B (after delay) =====
        const hop2Delay = getHopDelay();
        console.log(`[HOP2] Job ${jobId}: waiting ${Math.round(hop2Delay / 1000)}s before ${hopA.publicKey.toBase58().slice(0, 8)}... → ${hopB.publicKey.toBase58().slice(0, 8)}...`);
        job.status = 'hop2-pending';
        await new Promise(r => setTimeout(r, hop2Delay));

        const sig2 = await transferSPLTokens(hopA, hopB.publicKey, mintPubkey, rawTokenAmount, tokenProgramId);
        console.log(`[HOP2] Done: ${sig2}`);

        // ===== HOP 3: Intermediate B → Exit Vault PDA (after delay) =====
        const hop3Delay = getHopDelay();

        // Derive the exit vault PDA and its token account
        const [exitVaultPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('exit_vault'), mintPubkey.toBuffer()],
            PROGRAM_ID
        );

        // Check if exit vault exists — if not, auto-initialize it
        let exitVaultTokenAccounts = await connection.getTokenAccountsByOwner(exitVaultPda, { mint: mintPubkey });
        if (exitVaultTokenAccounts.value.length === 0) {
            console.log(`[EXIT] Auto-initializing exit vault for mint ${tokenMint.slice(0, 8)}...`);
            const exitKp = Keypair.generate();
            const INIT_EXIT_DISC = Buffer.from([34, 26, 19, 189, 45, 228, 118, 155]);
            const initIx = new (require('@solana/web3.js').TransactionInstruction)({
                programId: PROGRAM_ID,
                keys: [
                    { pubkey: exitVaultPda, isSigner: false, isWritable: true },
                    { pubkey: exitKp.publicKey, isSigner: true, isWritable: true },
                    { pubkey: mintPubkey, isSigner: false, isWritable: false },
                    { pubkey: relayerKeypair.publicKey, isSigner: true, isWritable: true },
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                    { pubkey: tokenProgramId, isSigner: false, isWritable: false },
                    { pubkey: require('@solana/web3.js').SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
                ],
                data: INIT_EXIT_DISC,
            });
            const initTx = new Transaction().add(initIx);
            await sendAndConfirmTransaction(connection, initTx, [relayerKeypair, exitKp]);
            console.log(`[EXIT] Exit vault initialized. Token account: ${exitKp.publicKey.toBase58()}`);
            // Re-fetch
            exitVaultTokenAccounts = await connection.getTokenAccountsByOwner(exitVaultPda, { mint: mintPubkey });
        }
        const exitTokenAccount = exitVaultTokenAccounts.value[0].pubkey;

        console.log(`[HOP3] Job ${jobId}: waiting ${Math.round(hop3Delay / 1000)}s before ${hopB.publicKey.toBase58().slice(0, 8)}... → Exit Vault`);
        job.status = 'hop3-pending';
        await new Promise(r => setTimeout(r, hop3Delay));

        // Transfer from hop B to the exit vault PDA token account
        const sig3 = await transferSPLTokens(hopB, exitVaultPda, mintPubkey, rawTokenAmount, tokenProgramId);
        console.log(`[HOP3] Done (→ Exit Vault): ${sig3}`);

        // ===== HOP 4: Exit Vault PDA → Final Recipient (after delay) =====
        const hop4Delay = getHopDelay();
        const finalPubkey = new PublicKey(finalRecipient);
        console.log(`[HOP4] Job ${jobId}: waiting ${Math.round(hop4Delay / 1000)}s before Exit Vault → ${finalRecipient.slice(0, 8)}...`);
        job.status = 'exit-pending';
        await new Promise(r => setTimeout(r, hop4Delay));

        // Get or create recipient ATA
        const recipientAta = await getAssociatedTokenAddress(mintPubkey, finalPubkey, false, tokenProgramId);
        let releasePreIx = [];
        try { await getAccount(connection, recipientAta); }
        catch { releasePreIx.push(createAssociatedTokenAccountInstruction(relayerKeypair.publicKey, recipientAta, finalPubkey, mintPubkey, tokenProgramId)); }

        // Call release_exit via raw instruction (SDK version mismatch workaround)
        // This appears as a PROTOCOL interaction on Bubblemaps, not wallet-to-wallet
        const RELEASE_EXIT_DISC = Buffer.from([35, 55, 129, 211, 18, 67, 16, 112]);
        const amountBuf = Buffer.alloc(8);
        amountBuf.writeBigUInt64LE(rawTokenAmount);
        const releaseData = Buffer.concat([RELEASE_EXIT_DISC, amountBuf]);

        const releaseIx = new (require('@solana/web3.js').TransactionInstruction)({
            programId: PROGRAM_ID,
            keys: [
                { pubkey: exitVaultPda, isSigner: false, isWritable: false },
                { pubkey: exitTokenAccount, isSigner: false, isWritable: true },
                { pubkey: mintPubkey, isSigner: false, isWritable: false },
                { pubkey: finalPubkey, isSigner: false, isWritable: false },
                { pubkey: recipientAta, isSigner: false, isWritable: true },
                { pubkey: relayerKeypair.publicKey, isSigner: true, isWritable: false },
                { pubkey: tokenProgramId, isSigner: false, isWritable: false },
            ],
            data: releaseData,
        });

        const releaseTx = new Transaction();
        releasePreIx.forEach(ix => releaseTx.add(ix));
        releaseTx.add(releaseIx);
        const sig4 = await sendAndConfirmTransaction(connection, releaseTx, [relayerKeypair]);
        console.log(`[HOP4] Done (Exit Vault → Recipient): ${sig4}`);

        job.status = 'completed';
        job.signature = sig4; // Final delivery signature
        job.hops = [tx1, sig2, sig3, sig4];
        console.log(`[RELAY] Job ${jobId} completed via 4 hops (exit vault)`);
    } catch (err) {
        job.status = 'failed';
        const errMsg = err.message || err.toString();
        const logs = err.logs ? err.logs.join(' | ') : '';
        job.error = logs || errMsg;
        console.error(`[RELAY] Job ${jobId} failed:`, errMsg);
        if (err.logs) console.error('[RELAY] Logs:', err.logs);
    }
}

// ============================================================================
// Commitment Padding
// ============================================================================

async function padMerkleTrees() {
    if (!PAD_ENABLED) return;
    try {
        const allTrees = await program.account.merkleTreeAccount.all();
        for (const tree of allTrees) {
            const treeData = tree.account;
            const maxLeaves = 1 << 5;
            if (treeData.nextIndex >= maxLeaves) continue;

            const randomCommitment = Array.from(crypto.randomBytes(32));
            try {
                await program.methods
                    .padTree(randomCommitment)
                    .accounts({ merkleTree: tree.publicKey, relayer: relayerKeypair.publicKey })
                    .signers([relayerKeypair])
                    .rpc();
                console.log(`[PAD] Padded tree ${tree.publicKey.toBase58().slice(0, 8)}... (idx ${treeData.nextIndex})`);
            } catch (err) {
                if (!err.message.includes('MerkleTreeFull')) console.error(`[PAD] Error:`, err.message);
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
        const hopBalances = await Promise.all(hopWallets.map(async (kp) => ({
            address: kp.publicKey.toBase58(),
            balance: (await connection.getBalance(kp.publicKey)) / 1e9,
        })));
        res.json({
            status: 'ok',
            relayer: relayerKeypair.publicKey.toBase58(),
            balance: balance / 1e9,
            hopWallets: hopBalances,
            program: PROGRAM_ID.toBase58(),
            queueSize: withdrawalQueue.size,
            paddingEnabled: PAD_ENABLED,
        });
    } catch (err) {
        res.status(500).json({ error: 'Unhealthy', details: err.message });
    }
});

// Prepare endpoint — returns an intermediate address for the ZK proof
app.post('/relay/prepare', (req, res) => {
    const [hopA] = pickRandomHopWallets();
    res.json({
        intermediateAddress: hopA.publicKey.toBase58(),
    });
});

app.post('/relay', limiter, async (req, res) => {
    try {
        const { tokenMint, depositAmount, proof, root, nullifierHash, recipientField, intermediateAddress, finalRecipient } = req.body;

        // Validation
        if (!tokenMint || !depositAmount || !proof || !root || !nullifierHash || !recipientField || !intermediateAddress || !finalRecipient) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (proof.length !== 256) return res.status(400).json({ error: 'Proof must be 256 bytes' });
        if (root.length !== 32) return res.status(400).json({ error: 'Root must be 32 bytes' });

        // Verify intermediate address is one of our hop wallets
        const isValidHop = hopWallets.some(kp => kp.publicKey.toBase58() === intermediateAddress);
        if (!isValidHop) return res.status(400).json({ error: 'Invalid intermediate address' });

        // Create delayed job
        const jobId = generateJobId();
        const delay = getRandomDelay();
        const scheduledAt = Date.now() + delay;

        withdrawalQueue.set(jobId, {
            status: 'queued',
            data: req.body,
            scheduledAt,
            signature: null,
            hops: [],
            error: null,
        });

        setTimeout(() => processWithdrawal(jobId), delay);

        const totalEstimate = delay + getHopDelay() + getHopDelay();
        const delayMin = Math.round(totalEstimate / 60000 * 10) / 10;
        console.log(`[RELAY] Job ${jobId} queued, est. total: ${delayMin} min (3 hops)`);

        res.json({
            jobId,
            status: 'queued',
            estimatedCompletionMs: totalEstimate,
            message: `Withdrawal queued with 3-hop privacy relay. Est. ~${delayMin} minutes.`,
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
    console.log(`TokenCloak Relayer v3 (Multi-Hop) running on port ${PORT}`);
    console.log(`Program: ${PROGRAM_ID.toBase58()}`);
    console.log(`Relayer: ${relayerKeypair.publicKey.toBase58()}`);
    console.log(`Hop wallets: ${hopWallets.map(kp => kp.publicKey.toBase58().slice(0, 8) + '...').join(', ')}`);
    console.log(`Initial delay: ${MIN_DELAY_MS / 1000}s - ${MAX_DELAY_MS / 1000}s`);
    console.log(`Hop delay: ${MIN_HOP_DELAY_MS / 1000}s - ${MAX_HOP_DELAY_MS / 1000}s`);
    console.log(`Padding: ${PAD_ENABLED ? `enabled (every ${PAD_INTERVAL_MS / 1000}s)` : 'disabled'}`);

    if (PAD_ENABLED) {
        setInterval(padMerkleTrees, PAD_INTERVAL_MS);
        console.log('[PAD] Background padding loop started');
    }

    // Clean up old jobs every 30 minutes
    setInterval(() => {
        const cutoff = Date.now() - 3600_000;
        for (const [id, job] of withdrawalQueue) {
            if (job.scheduledAt < cutoff && job.status !== 'queued') {
                withdrawalQueue.delete(id);
            }
        }
    }, 1800_000);
});
