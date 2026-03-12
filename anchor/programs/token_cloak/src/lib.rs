use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token_interface::{self, TokenInterface, TokenAccount, Mint, TransferChecked};
use groth16_solana::groth16::{Groth16Verifier};
use solana_poseidon::{hashv, PoseidonHash, Endianness, Parameters};

mod verifying_key;
use verifying_key::VERIFYING_KEY;

declare_id!("EQfV5pm72GfrifQX3LCiRzUf7zZdJ6hS7PbM9o6x6FVs");

pub const TREE_DEPTH: usize = 5;
pub const ROOT_HISTORY_SIZE: usize = 5;

// Fee configuration
pub const TREASURY: Pubkey = pubkey!("FukM6TdFpsKPEmzjhKAoES7qcuGYq8kGn4ZiByraKzWH");
pub const RELAYER_WALLET: Pubkey = pubkey!("En5imPirNXRw3T2m1kLy237UWz5FNSKoagu4p7j7KV9M");
pub const TREASURY_FEE: u64 = 50_000_000;  // 0.05 SOL
pub const RELAYER_FEE: u64 = 20_000_000;   // 0.02 SOL

#[program]
pub mod token_cloak {
    use super::*;

    pub fn create_pool(ctx: Context<CreatePool>, deposit_amount: u64) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.token_mint = ctx.accounts.token_mint.key();
        pool.deposit_amount = deposit_amount;
        pool.total_deposits = 0;
        pool.bump = ctx.bumps.pool;
        msg!("Pool created");
        Ok(())
    }

    pub fn init_merkle_tree(ctx: Context<InitMerkleTree>) -> Result<()> {
        let merkle = &mut ctx.accounts.merkle_tree;
        merkle.pool = ctx.accounts.pool.key();

        // Use precomputed Poseidon zero root (avoids BPF stack overflow)
        // Computed offline: Poseidon(0,0) → Poseidon(h1,0) → ... for 5 levels
        const ZERO_ROOT: [u8; 32] = [
            0x1b, 0xfd, 0x36, 0xfc, 0x52, 0x04, 0xb2, 0x7c,
            0xc2, 0xd0, 0x20, 0x0e, 0x18, 0x40, 0x2d, 0xe5,
            0xeb, 0x46, 0x3b, 0x4b, 0x67, 0xce, 0xba, 0x00,
            0x13, 0x79, 0xf4, 0xbd, 0x9c, 0x57, 0xd0, 0xe4,
        ];
        merkle.roots[0] = ZERO_ROOT;
        // filled_subtrees default to [0u8; 32] which is correct for an empty tree

        msg!("Merkle tree initialized");
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, commitment: [u8; 32]) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let merkle = &mut ctx.accounts.merkle_tree;

        require!((merkle.next_index as usize) < (1 << TREE_DEPTH), TokenCloakError::MerkleTreeFull);

        // Collect privacy fee: 0.05 SOL to treasury
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            TREASURY_FEE,
        )?;

        // Collect privacy fee: 0.02 SOL to relayer wallet (gas reimbursement)
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: ctx.accounts.relayer_wallet.to_account_info(),
                },
            ),
            RELAYER_FEE,
        )?;

        // Transfer tokens to vault
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.depositor_ata.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                },
            ),
            pool.deposit_amount,
            ctx.accounts.token_mint.decimals,
        )?;

        let leaf_index = merkle.next_index;
        insert_leaf(merkle, commitment)?;
        pool.total_deposits += 1;

        emit!(DepositEvent { commitment, leaf_index, timestamp: Clock::get()?.unix_timestamp });
        msg!("Deposit #{} | Fee: {} lamports", leaf_index, TREASURY_FEE + RELAYER_FEE);
        Ok(())
    }

    /// Pad the Merkle tree with a random commitment (no token transfer).
    /// Only callable by the relayer. Creates unwithdrawable entries
    /// that inflate the anonymity set.
    pub fn pad_tree(ctx: Context<PadTree>, commitment: [u8; 32]) -> Result<()> {
        let merkle = &mut ctx.accounts.merkle_tree;
        require!((merkle.next_index as usize) < (1 << TREE_DEPTH), TokenCloakError::MerkleTreeFull);

        let leaf_index = merkle.next_index;
        insert_leaf(merkle, commitment)?;

        msg!("Pad #{}", leaf_index);
        Ok(())
    }

    /// Withdraw tokens with a verified Groth16 proof.
    pub fn withdraw(
        ctx: Context<Withdraw>,
        proof: [u8; 256],
        root: [u8; 32],
        nullifier_hash: [u8; 32],
        recipient_field: [u8; 32],
    ) -> Result<()> {
        let merkle = &ctx.accounts.merkle_tree;
        let nf = &mut ctx.accounts.nullifier_account;

        require!(!nf.is_spent, TokenCloakError::NullifierAlreadySpent);
        require!(merkle.roots.iter().any(|r| *r == root), TokenCloakError::InvalidMerkleRoot);

        // Verify the recipient field matches the actual recipient account
        let recipient_key = ctx.accounts.recipient.key();
        let expected_recipient_field = pubkey_to_field_element(&recipient_key);
        require!(recipient_field == expected_recipient_field, TokenCloakError::InvalidProof);

        // --- Groth16 ZK Proof Verification ---
        let public_inputs: [[u8; 32]; 3] = [root, nullifier_hash, recipient_field];
        let proof_a: [u8; 64] = proof[0..64].try_into().unwrap();
        let proof_b: [u8; 128] = proof[64..192].try_into().unwrap();
        let proof_c: [u8; 64] = proof[192..256].try_into().unwrap();
        let proof_a_neg = negate_g1(&proof_a)?;

        let mut verifier = Groth16Verifier::new(
            &proof_a_neg,
            &proof_b,
            &proof_c,
            &public_inputs,
            &VERIFYING_KEY,
        ).map_err(|_| TokenCloakError::InvalidProof)?;

        verifier.verify().map_err(|_| TokenCloakError::InvalidProof)?;
        msg!("ZK proof verified!");

        // Mark nullifier as spent
        nf.is_spent = true;
        nf.nullifier_hash = nullifier_hash;

        // Transfer tokens to recipient
        let pool = &ctx.accounts.pool;
        let mint_key = pool.token_mint;
        let amt = pool.deposit_amount.to_le_bytes();
        let bump = pool.bump;
        let seeds: &[&[&[u8]]] = &[&[b"pool", mint_key.as_ref(), &amt, &[bump]]];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.recipient_ata.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                },
                seeds,
            ),
            pool.deposit_amount,
            ctx.accounts.token_mint.decimals,
        )?;

        emit!(WithdrawEvent { nullifier_hash, recipient: ctx.accounts.recipient.key(), timestamp: Clock::get()?.unix_timestamp });
        Ok(())
    }

    /// Initialize an exit vault for a token mint.
    /// The exit vault is a PDA-controlled token account the relayer routes tokens
    /// through before the final transfer to the recipient.
    /// This makes the final transfer appear as a protocol withdrawal on Bubblemaps.
    pub fn init_exit_vault(ctx: Context<InitExitVault>) -> Result<()> {
        let ev = &mut ctx.accounts.exit_vault_account;
        ev.token_mint = ctx.accounts.token_mint.key();
        ev.bump = ctx.bumps.exit_vault_account;
        msg!("Exit vault initialized for mint {}", ctx.accounts.token_mint.key());
        Ok(())
    }

    /// Release tokens from the exit vault to a recipient.
    /// Only callable by the relayer. The transfer comes from a PDA-owned token
    /// account, which Bubblemaps treats as a protocol interaction.
    pub fn release_exit(
        ctx: Context<ReleaseExit>,
        amount: u64,
    ) -> Result<()> {
        let ev = &ctx.accounts.exit_vault_account;
        let mint_key = ev.token_mint;
        let bump = ev.bump;
        let seeds: &[&[&[u8]]] = &[&[b"exit_vault", mint_key.as_ref(), &[bump]]];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.exit_token_account.to_account_info(),
                    to: ctx.accounts.recipient_ata.to_account_info(),
                    authority: ctx.accounts.exit_vault_account.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                },
                seeds,
            ),
            amount,
            ctx.accounts.token_mint.decimals,
        )?;

        msg!("Exit release: {} tokens to {}", amount, ctx.accounts.recipient.key());
        Ok(())
    }
}

// ============================================================================
// Poseidon Hash — matches circom's Poseidon(2) on BN254
// ============================================================================

fn poseidon_hash_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let hash: PoseidonHash = hashv(
        Parameters::Bn254X5,
        Endianness::BigEndian,
        &[left, right],
    ).expect("Poseidon hash failed");
    hash.to_bytes()
}

fn insert_leaf(merkle: &mut Account<MerkleTreeAccount>, leaf: [u8; 32]) -> Result<()> {
    let mut idx = merkle.next_index;
    let mut current = leaf;
    let zero = [0u8; 32];

    for i in 0..TREE_DEPTH {
        if idx % 2 == 0 {
            merkle.filled_subtrees[i] = current;
            current = poseidon_hash_pair(&current, &zero);
        } else {
            current = poseidon_hash_pair(&merkle.filled_subtrees[i], &current);
        }
        idx /= 2;
    }

    let ri = ((merkle.current_root_index + 1) % ROOT_HISTORY_SIZE as u32) as usize;
    merkle.roots[ri] = current;
    merkle.current_root_index = ri as u32;
    merkle.next_index += 1;
    Ok(())
}

// ============================================================================
// Groth16 Helpers
// ============================================================================

/// Negate a G1 point (flip y-coordinate in BN254 field)
fn negate_g1(point: &[u8; 64]) -> Result<[u8; 64]> {
    // The BN254 field modulus p
    let p = [
        0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
        0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
        0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d,
        0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
    ];

    let mut result = [0u8; 64];
    result[0..32].copy_from_slice(&point[0..32]); // x stays the same

    // y_neg = p - y
    let y = &point[32..64];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let diff = (p[i] as i16) - (y[i] as i16) - borrow;
        if diff < 0 {
            result[32 + i] = (diff + 256) as u8;
            borrow = 1;
        } else {
            result[32 + i] = diff as u8;
            borrow = 0;
        }
    }

    Ok(result)
}

/// Convert a Solana Pubkey to a BN254 field element (big-endian, mod p)
fn pubkey_to_field_element(pubkey: &Pubkey) -> [u8; 32] {
    // BN254 scalar field order r (big-endian)
    // r = 21888242871839275222246405745257275088548364400416034343698204186575808495617
    let r: [u8; 32] = [
        0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
        0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
        0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91,
        0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
    ];

    let mut current = pubkey.to_bytes();

    // A 32-byte value can be up to ~4*r, so loop subtract r until < r
    for _ in 0..5 {
        // Check if current >= r
        let mut ge = true;
        for i in 0..32 {
            if current[i] < r[i] { ge = false; break; }
            if current[i] > r[i] { break; }
        }

        if !ge { break; }

        // Subtract r
        let mut borrow = 0i16;
        let mut result = [0u8; 32];
        for i in (0..32).rev() {
            let diff = (current[i] as i16) - (r[i] as i16) - borrow;
            if diff < 0 {
                result[i] = (diff + 256) as u8;
                borrow = 1;
            } else {
                result[i] = diff as u8;
                borrow = 0;
            }
        }
        current = result;
    }
    current
}

// ============================================================================
// Accounts
// ============================================================================

#[account]
pub struct Pool {
    pub token_mint: Pubkey,
    pub deposit_amount: u64,
    pub total_deposits: u64,
    pub bump: u8,
}

#[account]
pub struct MerkleTreeAccount {
    pub pool: Pubkey,
    pub roots: [[u8; 32]; ROOT_HISTORY_SIZE],
    pub current_root_index: u32,
    pub next_index: u32,
    pub filled_subtrees: [[u8; 32]; TREE_DEPTH],
}

#[account]
pub struct NullifierAccount {
    pub is_spent: bool,
    pub nullifier_hash: [u8; 32],
}

/// Exit vault — a PDA-controlled account for the final hop.
/// Tokens sent FROM this PDA look like protocol interactions on Bubblemaps.
#[account]
pub struct ExitVaultAccount {
    pub token_mint: Pubkey,
    pub bump: u8,
}

// ============================================================================
// Contexts
// ============================================================================

#[derive(Accounts)]
#[instruction(deposit_amount: u64)]
pub struct CreatePool<'info> {
    #[account(init, payer = authority, space = 57,
        seeds = [b"pool", token_mint.key().as_ref(), &deposit_amount.to_le_bytes()], bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(init, payer = authority, token::mint = token_mint, token::authority = pool)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct InitMerkleTree<'info> {
    pub pool: Box<Account<'info, Pool>>,
    #[account(init, payer = authority, space = 368)]
    pub merkle_tree: Box<Account<'info, MerkleTreeAccount>>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PadTree<'info> {
    #[account(mut)]
    pub merkle_tree: Box<Account<'info, MerkleTreeAccount>>,
    #[account(constraint = relayer.key() == RELAYER_WALLET)]
    pub relayer: Signer<'info>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut,
        seeds = [b"pool", pool.token_mint.as_ref(), &pool.deposit_amount.to_le_bytes()],
        bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, constraint = merkle_tree.pool == pool.key())]
    pub merkle_tree: Box<Account<'info, MerkleTreeAccount>>,
    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, constraint = depositor_ata.mint == pool.token_mint,
        constraint = depositor_ata.owner == depositor.key())]
    pub depositor_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub depositor: Signer<'info>,
    /// CHECK: Treasury address validated by constraint
    #[account(mut, constraint = treasury.key() == TREASURY)]
    pub treasury: AccountInfo<'info>,
    /// CHECK: Relayer wallet validated by constraint
    #[account(mut, constraint = relayer_wallet.key() == RELAYER_WALLET)]
    pub relayer_wallet: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(proof: [u8; 256], root: [u8; 32], nullifier_hash: [u8; 32], recipient_field: [u8; 32])]
pub struct Withdraw<'info> {
    #[account(seeds = [b"pool", pool.token_mint.as_ref(), &pool.deposit_amount.to_le_bytes()],
        bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(constraint = merkle_tree.pool == pool.key())]
    pub merkle_tree: Box<Account<'info, MerkleTreeAccount>>,
    #[account(init, payer = relayer, space = 41,
        seeds = [b"nullifier", nullifier_hash.as_ref()], bump)]
    pub nullifier_account: Account<'info, NullifierAccount>,
    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: recipient
    pub recipient: AccountInfo<'info>,
    #[account(mut, constraint = recipient_ata.mint == pool.token_mint)]
    pub recipient_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub relayer: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct InitExitVault<'info> {
    #[account(init, payer = authority, space = 41,
        seeds = [b"exit_vault", token_mint.key().as_ref()], bump)]
    pub exit_vault_account: Box<Account<'info, ExitVaultAccount>>,
    /// The PDA-controlled token account for holding tokens before release
    #[account(init, payer = authority,
        token::mint = token_mint, token::authority = exit_vault_account)]
    pub exit_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ReleaseExit<'info> {
    #[account(seeds = [b"exit_vault", exit_vault_account.token_mint.as_ref()],
        bump = exit_vault_account.bump)]
    pub exit_vault_account: Box<Account<'info, ExitVaultAccount>>,
    #[account(mut, constraint = exit_token_account.owner == exit_vault_account.key())]
    pub exit_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: recipient
    pub recipient: AccountInfo<'info>,
    #[account(mut, constraint = recipient_ata.mint == exit_vault_account.token_mint)]
    pub recipient_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(constraint = relayer.key() == RELAYER_WALLET)]
    pub relayer: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct DepositEvent { pub commitment: [u8; 32], pub leaf_index: u32, pub timestamp: i64 }
#[event]
pub struct WithdrawEvent { pub nullifier_hash: [u8; 32], pub recipient: Pubkey, pub timestamp: i64 }

#[error_code]
pub enum TokenCloakError {
    #[msg("Merkle tree is full")] MerkleTreeFull,
    #[msg("Nullifier already spent")] NullifierAlreadySpent,
    #[msg("Invalid Merkle root")] InvalidMerkleRoot,
    #[msg("Invalid ZK proof")] InvalidProof,
}
