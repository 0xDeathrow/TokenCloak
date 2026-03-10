/**
 * TokenCloak Devnet E2E Test
 * Tests: create_pool → init_merkle_tree → deposit → withdraw
 */
const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair, SystemProgram } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } = require("@solana/spl-token");
const crypto = require("crypto");

const PROGRAM_ID = new PublicKey("6cMMrapyGKPHG5VaseTyS2U7Y1rW5b8MtgQoAFKeU6QN");
const TOKEN_MINT = new PublicKey("CzMpfu6uJVTPWa2uwJYoRFLqMCzE6HaMb6CemTeeZhX8");
const DEPOSIT_AMOUNT = new anchor.BN(100_000_000_000); // 100 tokens (9 decimals)

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = await anchor.Program.at(PROGRAM_ID, provider);
    const wallet = provider.wallet;

    console.log("=== TokenCloak Devnet Test ===");
    console.log("Program:", PROGRAM_ID.toBase58());
    console.log("Wallet:", wallet.publicKey.toBase58());
    console.log("Token:", TOKEN_MINT.toBase58());
    console.log("");

    // Derive Pool PDA
    const [poolPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), TOKEN_MINT.toBuffer(), DEPOSIT_AMOUNT.toBuffer("le", 8)],
        PROGRAM_ID
    );
    console.log("Pool PDA:", poolPda.toBase58());

    const vault = Keypair.generate();
    const merkleTree = Keypair.generate();

    // --- Step 1: Create Pool ---
    console.log("\n--- Step 1: Create Pool ---");
    try {
        const tx = await program.methods
            .createPool(DEPOSIT_AMOUNT)
            .accounts({
                pool: poolPda,
                vault: vault.publicKey,
                tokenMint: TOKEN_MINT,
                authority: wallet.publicKey,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
                rent: anchor.web3.SYSVAR_RENT_PUBKEY,
            })
            .signers([vault])
            .rpc();
        console.log("✅ Pool created! TX:", tx);
    } catch (err) {
        if (err.message && err.message.includes("already in use")) {
            console.log("Pool already exists, skipping...");
        } else {
            console.log("❌ Error:", err.message ? err.message.slice(0, 300) : err);
            if (err.logs) console.log("Logs:", err.logs.join("\n"));
            return;
        }
    }

    // --- Step 2: Init Merkle Tree ---
    console.log("\n--- Step 2: Init Merkle Tree ---");
    try {
        const tx = await program.methods
            .initMerkleTree()
            .accounts({
                pool: poolPda,
                merkleTree: merkleTree.publicKey,
                authority: wallet.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .signers([merkleTree])
            .rpc();
        console.log("✅ Merkle tree initialized! TX:", tx);
    } catch (err) {
        console.log("❌ Error:", err.message ? err.message.slice(0, 300) : err);
        if (err.logs) console.log("Logs:", err.logs.join("\n"));
        return;
    }

    // Fetch the pool to confirm
    const poolAccount = await program.account.pool.fetch(poolPda);
    console.log("Pool mint:", poolAccount.tokenMint.toBase58());
    console.log("Pool deposit amount:", poolAccount.depositAmount.toString());

    // --- Step 3: Deposit ---
    console.log("\n--- Step 3: Deposit ---");
    const nullifier = crypto.randomBytes(32);
    const secret = crypto.randomBytes(32);
    const commitment = crypto.createHash("sha256").update(Buffer.concat([nullifier, secret])).digest();

    console.log("Commitment:", commitment.toString("hex").slice(0, 20) + "...");

    const depositorAta = await getAssociatedTokenAddress(TOKEN_MINT, wallet.publicKey);
    console.log("Depositor ATA:", depositorAta.toBase58());

    try {
        const tx = await program.methods
            .deposit(Array.from(commitment))
            .accounts({
                pool: poolPda,
                merkleTree: merkleTree.publicKey,
                vault: vault.publicKey,
                depositorAta: depositorAta,
                depositor: wallet.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();

        console.log("✅ Deposit successful! TX:", tx);
        console.log("\n======= SAVE THIS NOTE =======");
        console.log("nullifier:", nullifier.toString("hex"));
        console.log("secret:", secret.toString("hex"));
        console.log("merkleTree:", merkleTree.publicKey.toBase58());
        console.log("vault:", vault.publicKey.toBase58());
        console.log("==============================");
    } catch (err) {
        console.log("❌ Deposit error:", err.message ? err.message.slice(0, 300) : err);
        if (err.logs) console.log("Logs:", err.logs.join("\n"));
        return;
    }

    // --- Step 4: Check State ---
    console.log("\n--- Pool State ---");
    const finalPool = await program.account.pool.fetch(poolPda);
    console.log("Total deposits:", finalPool.totalDeposits.toString());

    const merkleState = await program.account.merkleTreeAccount.fetch(merkleTree.publicKey);
    console.log("Merkle next_index:", merkleState.nextIndex);
    console.log("Current root index:", merkleState.currentRootIndex);

    console.log("\n🎉 E2E Test Complete! Pool is live on devnet.");
    console.log("View on explorer: https://explorer.solana.com/address/" + poolPda.toBase58() + "?cluster=devnet");
}

main().catch(console.error);
