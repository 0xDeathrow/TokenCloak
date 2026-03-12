const { Connection, PublicKey } = require('@solana/web3.js');
const PROGRAM_ID = new PublicKey('EQfV5pm72GfrifQX3LCiRzUf7zZdJ6hS7PbM9o6x6FVs');
const mint = new PublicKey('CnbALMqQdGKtcYrBk6f9DqMh8oCcsp6BvtXta8DVpump');
const [evPda] = PublicKey.findProgramAddressSync([Buffer.from('exit_vault'), mint.toBuffer()], PROGRAM_ID);
async function main() {
    const con = new Connection('https://mainnet.helius-rpc.com/?api-key=cc8e156f-f39f-466a-8ea9-43a5143e84ad', 'confirmed');
    const info = await con.getAccountInfo(evPda);
    console.log('Exit vault PDA:', evPda.toBase58());
    console.log('Account exists:', !!info);
    if (info) {
        console.log('Size:', info.data.length);
        console.log('Owner:', info.owner.toBase58());
    }
    const vaultTA = await con.getTokenAccountsByOwner(evPda, { mint });
    console.log('Token accounts owned by PDA:', vaultTA.value.length);
    if (vaultTA.value.length > 0) {
        console.log('Token account:', vaultTA.value[0].pubkey.toBase58());
    }
}
main().catch(e => console.error(e.message));
