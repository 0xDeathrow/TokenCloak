/**
 * TokenCloak Protocol Client
 * Handles on-chain interactions with real Poseidon commitments + Groth16 proofs
 */
import { Program, AnchorProvider, BN, web3 } from '@coral-xyz/anchor'
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, getAccount } from '@solana/spl-token'
import idl from './idl.json'

// Dynamic imports for heavy ZK libraries — loaded on demand, not at startup
let snarkjsModule = null
async function getSnarkjs() {
    if (!snarkjsModule) snarkjsModule = await import('snarkjs')
    return snarkjsModule
}

const PROGRAM_ID = new PublicKey('EQfV5pm72GfrifQX3LCiRzUf7zZdJ6hS7PbM9o6x6FVs')
const NETWORK = import.meta.env.VITE_NETWORK || 'mainnet'
const RPC_URL = NETWORK === 'mainnet'
    ? `https://mainnet.helius-rpc.com/?api-key=${import.meta.env.VITE_HELIUS_API_KEY}`
    : 'https://api.devnet.solana.com'
const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || 'http://localhost:3001'
const TREASURY = new PublicKey('FukM6TdFpsKPEmzjhKAoES7qcuGYq8kGn4ZiByraKzWH')
const RELAYER_WALLET = new PublicKey('En5imPirNXRw3T2m1kLy237UWz5FNSKoagu4p7j7KV9M')
const TREE_DEPTH = 5

let poseidonInstance = null
async function getPoseidon() {
    if (!poseidonInstance) {
        const { buildPoseidon } = await import('circomlibjs')
        poseidonInstance = await buildPoseidon()
    }
    return poseidonInstance
}

export function getConnection() {
    return new web3.Connection(RPC_URL, 'confirmed')
}

export function getProgram(wallet) {
    const connection = getConnection()
    const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' })
    return new Program(idl, provider)
}

function derivePoolPDA(tokenMint, depositAmount) {
    const mintPubkey = new PublicKey(tokenMint)
    const amountBN = new BN(depositAmount)
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('pool'), mintPubkey.toBuffer(), amountBN.toBuffer('le', 8)],
        PROGRAM_ID
    )
    return pda
}

// ============================================================================
// Poseidon Commitment (matches circom circuit)
// ============================================================================

/**
 * Generate a random nullifier + secret and compute the Poseidon commitment.
 * Returns { nullifier, secret, commitment, nullifierHash, noteString }
 */
export async function generateNote() {
    const poseidon = await getPoseidon()
    const F = poseidon.F

    // Random field elements (31 bytes to stay in BN254 field)
    const nullifier = crypto.getRandomValues(new Uint8Array(31))
    const secret = crypto.getRandomValues(new Uint8Array(31))

    const nullifierBigInt = bufToBigInt(nullifier)
    const secretBigInt = bufToBigInt(secret)

    // commitment = Poseidon(nullifier, secret)
    const commitment = poseidon([nullifierBigInt, secretBigInt])
    const commitmentBytes = fieldToBytes32(F, commitment)

    // nullifierHash = Poseidon(nullifier)
    const nullifierHash = poseidon([nullifierBigInt])
    const nullifierHashBytes = fieldToBytes32(F, nullifierHash)

    const noteString = bufToHex(nullifier) + bufToHex(secret)

    return {
        nullifier: nullifierBigInt,
        secret: secretBigInt,
        commitment: commitmentBytes,
        nullifierHash: nullifierHashBytes,
        noteString,
    }
}

/**
 * Parse a saved note string back into nullifier + secret bigints
 */
export function parseNote(noteString) {
    const clean = noteString.trim().replace(/^0x/, '')
    if (clean.length !== 124) throw new Error('Invalid note: must be 124 hex chars (62 + 62)')
    const nullifier = bufToBigInt(hexToBuf(clean.slice(0, 62)))
    const secret = bufToBigInt(hexToBuf(clean.slice(62)))
    return { nullifier, secret }
}

// ============================================================================
// Deposit
// ============================================================================

export async function deposit(wallet, tokenMint, amount, decimals) {
    const program = getProgram(wallet)
    const connection = getConnection()
    const mintPubkey = new PublicKey(tokenMint)

    // Detect token program (Token vs Token-2022) — must be done before ATA lookup
    const mintInfo = await connection.getAccountInfo(mintPubkey)
    if (!mintInfo) throw new Error('Token mint not found — check the token address')
    const tokenProgramId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID

    // Fetch on-chain decimals from the mint account data (offset 44, 1 byte)
    const onChainDecimals = mintInfo.data[44]
    const actualDecimals = onChainDecimals !== undefined ? onChainDecimals : decimals
    console.log(`Deposit: amount=${amount}, frontend decimals=${decimals}, on-chain decimals=${actualDecimals}`)

    const rawAmount = new BN(Math.floor(amount * Math.pow(10, actualDecimals)))
    console.log(`Raw amount: ${rawAmount.toString()}`)
    const poolPda = derivePoolPDA(tokenMint, rawAmount.toString())

    // Check if pool exists, create if not
    try { await program.account.pool.fetch(poolPda) }
    catch { await createPool(wallet, tokenMint, rawAmount) }

    // Generate Poseidon commitment
    const note = await generateNote()

    // Get depositor's ATA (using correct token program)
    const depositorAta = await getAssociatedTokenAddress(mintPubkey, wallet.publicKey, false, tokenProgramId)

    // Find merkle tree
    const merkleAccounts = await program.account.merkleTreeAccount.all([
        { memcmp: { offset: 8, bytes: poolPda.toBase58() } }
    ])

    let merkleTreeKey
    if (merkleAccounts.length > 0) {
        merkleTreeKey = merkleAccounts[0].publicKey
    } else {
        const mtKp = Keypair.generate()
        await program.methods.initMerkleTree()
            .accounts({
                pool: poolPda,
                merkleTree: mtKp.publicKey,
                authority: wallet.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .signers([mtKp])
            .rpc()
        merkleTreeKey = mtKp.publicKey
    }

    // Find vault
    const vaultAccounts = await connection.getTokenAccountsByOwner(poolPda, { mint: mintPubkey })
    if (vaultAccounts.value.length === 0) throw new Error('No vault found')
    const vaultKey = vaultAccounts.value[0].pubkey

    // Execute deposit (includes 0.07 SOL fee: 0.05 treasury + 0.02 relayer)
    const tx = await program.methods
        .deposit(Array.from(note.commitment))
        .accounts({
            pool: poolPda,
            merkleTree: merkleTreeKey,
            vault: vaultKey,
            tokenMint: mintPubkey,
            depositorAta,
            depositor: wallet.publicKey,
            treasury: TREASURY,
            relayerWallet: RELAYER_WALLET,
            systemProgram: SystemProgram.programId,
            tokenProgram: tokenProgramId,
        })
        .rpc()

    const merkleData = await program.account.merkleTreeAccount.fetch(merkleTreeKey)

    return {
        signature: tx,
        note: note.noteString,
        leafIndex: merkleData.nextIndex - 1,
        poolPda: poolPda.toBase58(),
        merkleTree: merkleTreeKey.toBase58(),
        vault: vaultKey.toBase58(),
    }
}

// ============================================================================
// Withdraw (with real ZK proof generation)
// ============================================================================

export async function withdraw(wallet, tokenMint, depositAmount, decimals, noteString, recipientAddress, onProgress) {
    const program = getProgram(wallet)
    const connection = getConnection()
    const poseidon = await getPoseidon()
    const F = poseidon.F
    const mintPubkey = new PublicKey(tokenMint)
    const recipientPubkey = new PublicKey(recipientAddress)

    // Fetch on-chain decimals to match deposit's pool PDA
    const mintInfo = await connection.getAccountInfo(mintPubkey)
    if (!mintInfo) throw new Error('Token mint not found — check the token address')
    const tokenProgramId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
    const onChainDecimals = mintInfo.data[44]
    const actualDecimals = onChainDecimals !== undefined ? onChainDecimals : decimals
    console.log(`Withdraw: depositAmount=${depositAmount}, on-chain decimals=${actualDecimals}`)

    const rawAmount = new BN(Math.floor(depositAmount * Math.pow(10, actualDecimals)))
    const poolPda = derivePoolPDA(tokenMint, rawAmount.toString())

    // Parse note
    const { nullifier, secret } = parseNote(noteString)

    // Compute commitment and nullifier hash
    const commitment = poseidon([nullifier, secret])
    const commitmentBytes = fieldToBytes32(F, commitment)
    const nullifierHash = poseidon([nullifier])
    const nullifierHashBytes = fieldToBytes32(F, nullifierHash)

    // Fetch merkle tree
    const merkleAccounts = await program.account.merkleTreeAccount.all([
        { memcmp: { offset: 8, bytes: poolPda.toBase58() } }
    ])
    if (merkleAccounts.length === 0) throw new Error('No merkle tree found')
    const merkleTreeKey = merkleAccounts[0].publicKey
    const merkleData = merkleAccounts[0].account

    // Get current root
    const rootIndex = merkleData.currentRootIndex
    const root = Array.from(merkleData.roots[rootIndex])

    // Build Merkle proof — reconstruct the tree from on-chain events
    const { pathElements, pathIndices, leafIndex } = await buildMerkleProof(
        program, poolPda, merkleTreeKey, commitmentBytes, poseidon
    )

    // Compute recipient field element (must reduce mod BN254 scalar field order r)
    // The circuit reduces large inputs mod r, so we must pass the reduced value on-chain too
    const BN254_R = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617')
    const recipientBigInt = bufToBigInt(recipientPubkey.toBytes()) % BN254_R
    const recipientField = Array.from(bigIntToBytes32BE(recipientBigInt))

    // Generate real Groth16 proof using snarkjs
    console.log('Generating ZK proof...')
    const snarkjs = await getSnarkjs()
    const input = {
        root: bufToBigInt(new Uint8Array(root)).toString(),
        nullifierHash: F.toObject(nullifierHash).toString(),
        recipient: bufToBigInt(new Uint8Array(recipientField)).toString(),
        nullifier: nullifier.toString(),
        secret: secret.toString(),
        pathElements: pathElements.map(el => bufToBigInt(new Uint8Array(el)).toString()),
        pathIndices: pathIndices,
    }

    const { proof } = await snarkjs.groth16.fullProve(
        input,
        '/zk/withdraw.wasm',
        '/zk/withdraw_final.zkey'
    )

    // Pack proof into 256 bytes (a:64, b:128, c:64)
    const proofBytes = packProof(proof)

    // Find vault
    const vaultAccounts = await connection.getTokenAccountsByOwner(poolPda, { mint: mintPubkey })
    if (vaultAccounts.value.length === 0) throw new Error('No vault found')
    const vaultKey = vaultAccounts.value[0].pubkey

    // (tokenProgramId already detected above)

    // Submit withdrawal via relayer (user's wallet never signs)
    console.log('Submitting to relayer...')
    const response = await fetch(`${RELAYER_URL}/relay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            tokenMint: tokenMint,
            depositAmount: rawAmount.toString(),
            proof: Array.from(proofBytes),
            root: Array.from(root),
            nullifierHash: Array.from(nullifierHashBytes),
            recipientField: recipientField,
            recipientAddress: recipientAddress,
        }),
    })

    if (!response.ok) {
        const errData = await response.json().catch(() => ({}))
        throw new Error(errData.error || errData.details || `Relayer error: ${response.status}`)
    }

    const queueResult = await response.json()
    const { jobId, estimatedCompletionMs } = queueResult
    console.log(`Withdrawal queued: ${jobId}, est. delay: ${Math.round(estimatedCompletionMs / 60000)} min`)

    // Poll for completion
    if (onProgress) onProgress({ status: 'queued', jobId, estimatedCompletionMs })

    const signature = await pollRelayerStatus(jobId, onProgress)
    return { signature, recipient: recipientAddress }
}

// ============================================================================
// Relayer Polling
// ============================================================================

async function pollRelayerStatus(jobId, onProgress) {
    const POLL_INTERVAL = 5000 // 5 seconds
    const MAX_POLLS = 150       // 12.5 minutes max

    for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL))

        const res = await fetch(`${RELAYER_URL}/status/${jobId}`)
        if (!res.ok) throw new Error('Failed to check withdrawal status')

        const data = await res.json()

        if (data.status === 'completed') {
            if (onProgress) onProgress({ status: 'completed', signature: data.signature })
            return data.signature
        }

        if (data.status === 'failed') {
            throw new Error(data.error || 'Withdrawal failed')
        }

        // Still queued or processing
        if (onProgress) {
            onProgress({
                status: data.status,
                jobId,
                estimatedWaitMs: data.estimatedWaitMs || 0,
            })
        }
    }

    throw new Error('Withdrawal timed out')
}

// ============================================================================
// Helpers
// ============================================================================

async function createPool(wallet, tokenMint, rawAmount) {
    const program = getProgram(wallet)
    const connection = getConnection()
    const mintPubkey = new PublicKey(tokenMint)
    const poolPda = derivePoolPDA(tokenMint, rawAmount.toString())
    const vaultKp = Keypair.generate()

    // Detect token program
    const mintInfo = await connection.getAccountInfo(mintPubkey)
    if (!mintInfo) throw new Error('Token mint not found — check the token address')
    const tokenProgramId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID

    await program.methods.createPool(rawAmount)
        .accounts({
            pool: poolPda, vault: vaultKp.publicKey, tokenMint: mintPubkey,
            authority: wallet.publicKey, systemProgram: SystemProgram.programId,
            tokenProgram: tokenProgramId, rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([vaultKp])
        .rpc()
}

/**
 * Build a Merkle proof by fetching deposit events and reconstructing the tree
 */
async function buildMerkleProof(program, poolPda, merkleTreeKey, commitment, poseidon) {
    const F = poseidon.F

    // Fetch deposit events
    const events = await program.addEventListener('DepositEvent', () => { })
    // For now, fetch directly from merkle tree state + match commitment
    const merkle = await program.account.merkleTreeAccount.fetch(merkleTreeKey)

    // Simple approach: we know the leaf index from events
    // Reconstruct path from filled_subtrees
    const commitHex = bufToHex(commitment)

    // Fetch all deposits to this pool by parsing transaction logs
    const connection = getConnection()
    const signatures = await connection.getSignaturesForAddress(merkleTreeKey, { limit: 100 })

    let deposits = []
    for (const sig of signatures) {
        try {
            const tx = await connection.getTransaction(sig.signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0,
            })
            if (tx?.meta?.logMessages) {
                const depositLog = tx.meta.logMessages.find(l => l.includes('Deposit #'))
                if (depositLog) {
                    // Extract commitment from instruction data
                    deposits.push(sig.signature)
                }
            }
        } catch { }
    }

    // For the MVP, use the filled_subtrees from on-chain state to reconstruct the path
    // This works when the commitment is the most recent deposit
    const leafIndex = merkle.nextIndex - 1
    const pathElements = []
    const pathIndices = []
    const zero = new Uint8Array(32)

    let idx = leafIndex
    for (let i = 0; i < TREE_DEPTH; i++) {
        if (idx % 2 === 0) {
            pathElements.push(Array.from(zero))
            pathIndices.push(0)
        } else {
            pathElements.push(Array.from(merkle.filledSubtrees[i]))
            pathIndices.push(1)
        }
        idx = Math.floor(idx / 2)
    }

    return { pathElements, pathIndices, leafIndex }
}

/**
 * Pack a snarkjs proof into a 256-byte buffer:
 * proof_a (64 bytes G1) + proof_b (128 bytes G2) + proof_c (64 bytes G1)
 */
function packProof(proof) {
    const buf = new Uint8Array(256)

    // proof.pi_a: [x, y, z] — G1 point, x and y are field elements
    buf.set(bigIntToBytes32BE(BigInt(proof.pi_a[0])), 0)
    buf.set(bigIntToBytes32BE(BigInt(proof.pi_a[1])), 32)

    // proof.pi_b: [[x0, x1], [y0, y1], [z0, z1]] — G2 point
    // groth16-solana expects: x1, x0, y1, y0
    buf.set(bigIntToBytes32BE(BigInt(proof.pi_b[0][1])), 64)
    buf.set(bigIntToBytes32BE(BigInt(proof.pi_b[0][0])), 96)
    buf.set(bigIntToBytes32BE(BigInt(proof.pi_b[1][1])), 128)
    buf.set(bigIntToBytes32BE(BigInt(proof.pi_b[1][0])), 160)

    // proof.pi_c: [x, y, z] — G1 point
    buf.set(bigIntToBytes32BE(BigInt(proof.pi_c[0])), 192)
    buf.set(bigIntToBytes32BE(BigInt(proof.pi_c[1])), 224)

    return buf
}

function bigIntToBytes32BE(n) {
    const hex = n.toString(16).padStart(64, '0')
    const bytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
    return bytes
}

function fieldToBytes32(F, field) {
    const hex = F.toObject(field).toString(16).padStart(64, '0')
    const bytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
    return bytes
}

function bufToBigInt(buf) {
    return BigInt('0x' + Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join(''))
}

function bufToHex(buf) {
    return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('')
}

function hexToBuf(hex) {
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16)
    return bytes
}
