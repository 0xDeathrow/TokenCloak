/**
 * Convert verification_key.json to Rust constants for groth16-solana
 * Outputs a verifying_key.rs file
 */
const fs = require('fs');

const vk = JSON.parse(fs.readFileSync('build/verification_key.json', 'utf8'));

function bigIntTo32BytesBE(n) {
    let hex = BigInt(n).toString(16).padStart(64, '0');
    let bytes = [];
    for (let i = 0; i < 64; i += 2) {
        bytes.push('0x' + hex.substr(i, 2));
    }
    return bytes;
}

function formatG1(p) {
    // G1 point: x, y each 32 bytes BE
    const x = bigIntTo32BytesBE(p[0]);
    const y = bigIntTo32BytesBE(p[1]);
    return [...x, ...y];
}

function formatG2(p) {
    // G2 point: x = (x0, x1), y = (y0, y1), each 32 bytes BE
    // groth16-solana expects: x1, x0, y1, y0 (reversed within pairs)
    const x1 = bigIntTo32BytesBE(p[0][1]);
    const x0 = bigIntTo32BytesBE(p[0][0]);
    const y1 = bigIntTo32BytesBE(p[1][1]);
    const y0 = bigIntTo32BytesBE(p[1][0]);
    return [...x1, ...x0, ...y1, ...y0];
}

// Build VERIFYING_KEY array for groth16-solana
// Format: [alpha_g1 (64), beta_g2 (128), gamma_g2 (128), delta_g2 (128), IC[0] (64), IC[1] (64), ...]
let vkBytes = [];

// alpha_g1: 2 * 32 = 64 bytes
vkBytes.push(...formatG1(vk.vk_alpha_1));

// beta_g2: 4 * 32 = 128 bytes
vkBytes.push(...formatG2(vk.vk_beta_2));

// gamma_g2: 4 * 32 = 128 bytes
vkBytes.push(...formatG2(vk.vk_gamma_2));

// delta_g2: 4 * 32 = 128 bytes
vkBytes.push(...formatG2(vk.vk_delta_2));

// IC points: nPublic + 1 G1 points (each 64 bytes)
for (const ic of vk.IC) {
    vkBytes.push(...formatG1(ic));
}

// Total size: 64 + 128*3 + (nPublic+1)*64 = 64 + 384 + 256 = 704 bytes for 3 public inputs

let totalRows = vkBytes.length / 32; // Each row is 32 bytes (one [u8; 32])

let rust = `/// Auto-generated verification key for the TokenCloak withdraw circuit
/// Circuit: Withdraw(5) — 5-level Merkle tree, Poseidon commitment
/// Public inputs: [root, nullifierHash, recipient]
/// Generated from: circuits/build/verification_key.json

pub const VERIFYING_KEY: [[u8; 32]; ${totalRows}] = [\n`;

for (let i = 0; i < vkBytes.length; i += 32) {
    const row = vkBytes.slice(i, i + 32);
    rust += `    [${row.join(', ')}],\n`;
}

rust += '];\n';

fs.writeFileSync('build/verifying_key.rs', rust);
console.log(`Generated verifying_key.rs: ${totalRows} rows of [u8; 32]`);
console.log(`Total bytes: ${vkBytes.length}`);
console.log(`nPublic: ${vk.nPublic}`);
console.log(`IC points: ${vk.IC.length}`);
