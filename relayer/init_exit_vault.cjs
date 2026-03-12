/**
 * Initialize an exit vault for a token mint.
 * Usage: node init_exit_vault.cjs <MINT_ADDRESS>
 */
const { Connection, Keypair, PublicKey, SystemProgram } = require('@solana/web3.js');
const { Program, AnchorProvider, Wallet } = require('@coral-xyz/anchor');
const fs = require('fs');
const path = require('path');

const PROGRAM_ID = new PublicKey('EQfV5pm72GfrifQX3LCiRzUf7zZdJ6hS7PbM9o6x6FVs');
const RPC_URL = process.env.RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=cc8e156f-f39f-466a-8ea9-43a5143e84ad';

const mintAddress = process.argv[2];
if (!mintAddress) { console.error('Usage: node init_exit_vault.cjs <MINT_ADDRESS>'); process.exit(1); }

async function main() {
    const connection = new Connection(RPC_URL, 'confirmed');

    // Load deploy wallet
    const keyData = JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.config/solana/id.json'), 'utf8'));
    const authority = Keypair.fromSecretKey(new Uint8Array(keyData));
    console.log('Authority:', authority.publicKey.toBase58());

    const wallet = new Wallet(authority);
    const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
    const idl = JSON.parse(fs.readFileSync(path.join(__dirname, 'idl.json'), 'utf8'));
    const program = new Program(idl, provider);

    const mintPubkey = new PublicKey(mintAddress);

    // Derive exit vault PDA
    const [exitVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('exit_vault'), mintPubkey.toBuffer()],
        PROGRAM_ID
    );
    console.log('Exit vault PDA:', exitVaultPda.toBase58());

    // Create a new keypair for the exit token account
    const exitTokenAccountKp = Keypair.generate();
    console.log('Exit token account:', exitTokenAccountKp.publicKey.toBase58());

    // Detect token program
    const mintInfo = await connection.getAccountInfo(mintPubkey);
    if (!mintInfo) { console.error('Mint not found'); process.exit(1); }

    const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
    const tokenProgramId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

    // Call init_exit_vault
    const sig = await program.methods
        .initExitVault()
        .accounts({
            exitVaultAccount: exitVaultPda,
            exitTokenAccount: exitTokenAccountKp.publicKey,
            tokenMint: mintPubkey,
            authority: authority.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: tokenProgramId,
            rent: require('@solana/web3.js').SYSVAR_RENT_PUBKEY,
        })
        .signers([authority, exitTokenAccountKp])
        .rpc();

    console.log('Exit vault initialized!');
    console.log('Signature:', sig);
    console.log('');
    console.log('Exit Vault PDA:', exitVaultPda.toBase58());
    console.log('Exit Token Account:', exitTokenAccountKp.publicKey.toBase58());
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
