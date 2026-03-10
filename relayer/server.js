/**
 * TokenCloak Privacy Relayer
 * Submits withdraw transactions on behalf of users so their original wallet
 * never appears as a signer in the withdrawal transaction.
 */
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
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
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || '8S2ZM3hqavr7JNwzEEKTXeF5ZXHJyBscfUFYBMTY2fTK');

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
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
}));

// Rate limiting: 1 request per 30 seconds per IP
const limiter = rateLimit({
    windowMs: 30 * 1000,
    max: 1,
    message: { error: 'Rate limited. Please wait 30 seconds between withdrawals.' },
});

// ============================================================================
// Health check
// ============================================================================

app.get('/health', async (req, res) => {
    try {
        const balance = await connection.getBalance(relayerKeypair.publicKey);
        res.json({
            status: 'ok',
            relayer: relayerKeypair.publicKey.toBase58(),
            balance: balance / 1e9,
            program: PROGRAM_ID.toBase58(),
        });
    } catch (err) {
        res.status(500).json({ error: 'Relayer unhealthy', details: err.message });
    }
});

// ============================================================================
// Relay withdraw endpoint
// ============================================================================

app.post('/relay', limiter, async (req, res) => {
    try {
        const {
            tokenMint,
            depositAmount,
            proof,        // number[] (256 elements)
            root,         // number[] (32 elements)
            nullifierHash,// number[] (32 elements)
            recipientField, // number[] (32 elements)
            recipientAddress,
        } = req.body;

        // Basic validation
        if (!tokenMint || !depositAmount || !proof || !root || !nullifierHash || !recipientField || !recipientAddress) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (proof.length !== 256) return res.status(400).json({ error: 'Proof must be 256 bytes' });
        if (root.length !== 32) return res.status(400).json({ error: 'Root must be 32 bytes' });
        if (nullifierHash.length !== 32) return res.status(400).json({ error: 'NullifierHash must be 32 bytes' });
        if (recipientField.length !== 32) return res.status(400).json({ error: 'RecipientField must be 32 bytes' });

        console.log(`[RELAY] Withdraw request for ${recipientAddress}`);

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
        if (merkleAccounts.length === 0) {
            return res.status(400).json({ error: 'No merkle tree found for this pool' });
        }
        const merkleTreeKey = merkleAccounts[0].publicKey;

        // Find vault
        const vaultAccounts = await connection.getTokenAccountsByOwner(poolPda, { mint: mintPubkey });
        if (vaultAccounts.value.length === 0) {
            return res.status(400).json({ error: 'No vault found' });
        }
        const vaultKey = vaultAccounts.value[0].pubkey;

        // Detect token program
        const mintInfo = await connection.getAccountInfo(mintPubkey);
        const tokenProgramId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

        // Get or create recipient ATA
        const recipientAta = await getAssociatedTokenAddress(mintPubkey, recipientPubkey, false, tokenProgramId);
        let preInstructions = [];
        try {
            await getAccount(connection, recipientAta);
        } catch {
            preInstructions.push(
                createAssociatedTokenAccountInstruction(
                    relayerKeypair.publicKey, recipientAta, recipientPubkey, mintPubkey, tokenProgramId
                )
            );
        }

        // Nullifier PDA
        const [nullifierPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('nullifier'), Buffer.from(nullifierHash)],
            PROGRAM_ID
        );

        // Build and send the withdraw transaction
        const tx = await program.methods
            .withdraw(
                proof,
                root,
                nullifierHash,
                recipientField,
            )
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

        console.log(`[RELAY] Withdraw success: ${tx}`);
        res.json({ signature: tx, recipient: recipientAddress });

    } catch (err) {
        console.error('[RELAY] Error:', err.message);
        res.status(500).json({
            error: 'Relay failed',
            details: err.message,
        });
    }
});

// ============================================================================
// Start server
// ============================================================================

app.listen(PORT, () => {
    console.log(`TokenCloak Relayer running on port ${PORT}`);
    console.log(`Program: ${PROGRAM_ID.toBase58()}`);
    console.log(`Relayer: ${relayerKeypair.publicKey.toBase58()}`);
});
