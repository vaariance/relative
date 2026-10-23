#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use cox_math as math;
use serde_json::json;
mod adaptive_manifest;
pub use adaptive_manifest::*;
mod dynamic_universe;
pub use dynamic_universe::*;

declare_id!("G6iQGoupNSfduw1QJxQ9vcVi9FnCC6cbippXsi4QQzJF");
pub const REQUIRED_HEAP_BYTES: u32 = 256 * 1024;
#[cfg(all(target_os = "solana", feature = "custom-heap", not(feature = "no-entrypoint")))]
struct DynamicAllocator;
#[cfg(all(target_os = "solana", feature = "custom-heap", not(feature = "no-entrypoint")))]
unsafe impl std::alloc::GlobalAlloc for DynamicAllocator {
    unsafe fn alloc(&self, layout: std::alloc::Layout) -> *mut u8 {
        let start = anchor_lang::solana_program::entrypoint::HEAP_START_ADDRESS as usize;
        let cursor = start as *mut usize;
        let position = (*cursor).max(start + std::mem::size_of::<usize>());
        let Some(aligned) = position.checked_add(layout.align() - 1).map(|value| value & !(layout.align() - 1)) else { return std::ptr::null_mut(); };
        let Some(end) = aligned.checked_add(layout.size()) else { return std::ptr::null_mut(); };
        if end > start + REQUIRED_HEAP_BYTES as usize { return std::ptr::null_mut(); }
        *cursor = end;
        aligned as *mut u8
    }
    unsafe fn dealloc(&self, _: *mut u8, _: std::alloc::Layout) {}
}
#[cfg(all(target_os = "solana", feature = "custom-heap", not(feature = "no-entrypoint")))]
#[global_allocator]
static ALLOCATOR: DynamicAllocator = DynamicAllocator;
pub const COLLATERAL_LIMIT: u64 = 100_000_000_000;
pub const UNIT_LIMIT: u128 = 1_000_000_000_000_000_000_000_000;
pub const MANIFEST_LIMIT: usize = 8192;
pub const IDS: [&str; 30] = [
    "BTC", "ETH", "SOL", "XRP", "BNB", "TRX", "AVAX", "DOT", "NEAR", "SUI", "APT", "UNI", "ARB",
    "OP", "INJ", "AAVE", "ZEC", "STRK", "HYPE", "TAO", "WLD", "ONDO", "ENA", "ZRO", "FET", "JUP",
    "AERO", "RENDER", "TIA", "W",
];

#[program]
pub mod cox {
    use super::*;
    pub fn initialize_registry(ctx: Context<InitializeRegistry>, runtime: Pubkey) -> Result<()> {
        require!(
            runtime != ctx.accounts.admin.key()
                && runtime != Pubkey::default()
                && runtime != ctx.accounts.upgrade_authority.key()
                && ctx.accounts.admin.key() != ctx.accounts.upgrade_authority.key(),
            CoxError::InvalidAuthority
        );
        require!(
            ctx.accounts.program_data.upgrade_authority_address
                == Some(ctx.accounts.upgrade_authority.key()),
            CoxError::Unauthorized
        );
        let data = ctx.accounts.program_account.try_borrow_data()?;
        require!(
            data.len() >= 36
                && data[..4] == 2u32.to_le_bytes()
                && data[4..36] == ctx.accounts.program_data.key().to_bytes(),
            CoxError::InvalidAuthority
        );
        let r = &mut ctx.accounts.registry;
        r.schema_version = 1;
        r.bump = ctx.bumps.registry;
        r.admin = ctx.accounts.admin.key();
        r.runtime = runtime;
        Ok(())
    }
    pub fn register_methodology(
        ctx: Context<RegisterMethodology>,
        digest: [u8; 32],
        length: u32,
        activation_batch: u64,
    ) -> Result<()> {
        require!(
            length > 0 && length as usize <= MANIFEST_LIMIT,
            CoxError::InvalidManifest
        );
        let m = &mut ctx.accounts.methodology;
        m.schema_version = 1;
        m.bump = ctx.bumps.methodology;
        m.digest = digest;
        m.expected_length = length;
        m.activation_batch = activation_batch;
        Ok(())
    }
    pub fn upload_methodology(
        ctx: Context<ManageMethodology>,
        offset: u32,
        bytes: Vec<u8>,
    ) -> Result<()> {
        let m = &mut ctx.accounts.methodology;
        require!(
            !m.sealed
                && bytes.len() <= 700
                && offset as usize == m.canonical.len()
                && m.canonical.len() + bytes.len() <= m.expected_length as usize,
            CoxError::InvalidManifest
        );
        m.canonical.extend(bytes);
        Ok(())
    }
    pub fn seal_methodology(ctx: Context<ManageMethodology>, config: ManifestConfig) -> Result<()> {
        let m = &mut ctx.accounts.methodology;
        require!(
            !m.sealed && m.canonical.len() == m.expected_length as usize,
            CoxError::InvalidManifest
        );
        let canonical = canonical_manifest(&config, ctx.accounts.registry.runtime)?;
        require!(
            canonical == m.canonical && math::artifact_digest(&canonical) == m.digest,
            CoxError::InvalidManifest
        );
        m.roster = config.roster;
        m.origin = config.origin;
        m.bybit = config.bybit;
        m.sealed = true;
        Ok(())
    }
    pub fn seal_adaptive_methodology(ctx: Context<ManageMethodology>, config: AdaptiveManifestConfig) -> Result<()> {
        let m = &mut ctx.accounts.methodology;
        require!(!m.sealed && m.canonical.len() == m.expected_length as usize, CoxError::InvalidManifest);
        let canonical = canonical_adaptive_manifest(&config, ctx.accounts.registry.runtime)?;
        require!(canonical == m.canonical && math::artifact_digest(&canonical) == m.digest, CoxError::InvalidManifest);
        m.schema_version = 2;
        m.roster = config.roster;
        m.origin = config.origin;
        m.bybit = false;
        m.sealed = true;
        Ok(())
    }
    pub fn initialize_pool(ctx: Context<InitializePool>, pool_id: u64) -> Result<()> {
        initialize_pool_inner(ctx, pool_id, None)
    }
    pub fn initialize_adaptive_pool(ctx: Context<InitializePool>, pool_id: u64, trading_opens_at: u64) -> Result<()> {
        require!(trading_opens_at >= ctx.accounts.methodology.origin, CoxError::InvalidOrigin);
        initialize_pool_inner(ctx, pool_id, Some(trading_opens_at))
    }
    pub fn initialize_devnet_collateral(ctx: Context<InitializeDevnetCollateral>) -> Result<()> {
        require!(cfg!(feature = "devnet-collateral"), CoxError::DualCollateralDisabled);
        let p = &mut ctx.accounts.pool;
        require!(p.schema_version == 4 && !p.initialized && p.stage.is_none() && p.test_collateral_mint.is_none()
            && p.next_request_nonce == 0 && p.active == 0 && p.pending == 0 && p.payable == 0 && p.residual == 0 && p.fees == 0,
            CoxError::InvalidAccount);
        require!(ctx.accounts.test_mint.decimals == 6 && ctx.accounts.test_mint.key() != p.collateral_mint
            && ctx.accounts.test_mint.mint_authority == COption::Some(ctx.accounts.admin.key())
            && ctx.accounts.test_mint.freeze_authority == COption::None, CoxError::InvalidCollateral);
        p.test_collateral_mint = Some(ctx.accounts.test_mint.key());
        reconcile(p, &ctx.accounts.vault, Some(&ctx.accounts.test_vault))
    }
    pub fn migrate_pool(ctx: Context<MigratePool>) -> Result<()> {
        require!(ctx.accounts.registry.paused, CoxError::Paused);
        let info = ctx.accounts.pool.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        require!(
            data.len() == 4096 && data[..8] == Pool::DISCRIMINATOR[..],
            CoxError::InvalidAccount
        );
        let legacy = LegacyPool::deserialize(&mut &data[8..])?;
        require!(legacy.schema_version == 1, CoxError::AlreadyProcessed);
        require!(legacy.stage.is_none(), CoxError::BatchBusy);
        let expected = Pubkey::create_program_address(
            &[b"pool", &legacy.pool_id.to_le_bytes(), &[legacy.bump]],
            &crate::ID,
        )
        .map_err(|_| error!(CoxError::InvalidAccount))?;
        require_keys_eq!(expected, info.key(), CoxError::InvalidAccount);
        require_keys_eq!(
            legacy.registry,
            ctx.accounts.registry.key(),
            CoxError::InvalidAccount
        );
        require_keys_eq!(
            legacy.vault,
            ctx.accounts.vault.key(),
            CoxError::InvalidAccount
        );
        require_keys_eq!(
            legacy.collateral_mint,
            ctx.accounts.vault.mint,
            CoxError::InvalidCollateral
        );
        let mut clean = Vec::with_capacity(data.len());
        clean.extend_from_slice(Pool::DISCRIMINATOR);
        legacy.serialize(&mut clean)?;
        clean.resize(data.len(), 0);
        let mut p = Pool::try_deserialize(&mut clean.as_slice())?;
        reconcile(&mut p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
        p.schema_version = 2;
        data.fill(0);
        p.try_serialize(&mut &mut data[..])?;
        Ok(())
    }
    pub fn begin_retirement(ctx: Context<BeginRetirement>) -> Result<()> {
        require!(ctx.accounts.registry.paused, CoxError::Paused);
        let p = &mut ctx.accounts.pool;
        require!(p.test_collateral_mint.is_none(), CoxError::DualRetirementUnsupported);
        reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
        require!(p.schema_version != 3, CoxError::PoolRetired);
        require!(matches!(p.schema_version, 2 | 4), CoxError::InvalidAccount);
        require!(p.initialized, CoxError::InvalidOrigin);
        require!(p.stage.is_none(), CoxError::BatchBusy);
        let retirement = &mut ctx.accounts.retirement;
        retirement.schema_version = 1;
        retirement.bump = ctx.bumps.retirement;
        retirement.pool = p.key();
        retirement.sequence = p.sequence;
        retirement.state_digest = p.state_digest;
        retirement.classes = p.classes.clone();
        p.schema_version = 3;
        p.fee_pending = false;
        emit!(RetirementStarted {
            pool: p.key(),
            sequence: p.sequence,
            state_digest: p.state_digest,
        });
        Ok(())
    }
    pub fn retire_request(ctx: Context<ManageRequest>) -> Result<()> {
        require!(ctx.accounts.pool.schema_version == 3, CoxError::NotRetired);
        release_request(ctx, false)
    }
    pub fn retire_position(ctx: Context<RetirePosition>) -> Result<()> {
        let p = &mut ctx.accounts.pool;
        reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
        require!(
            p.schema_version == 3 && p.stage.is_none(),
            CoxError::NotRetired
        );
        let retirement = &ctx.accounts.retirement;
        require!(
            retirement.sequence == p.sequence && retirement.state_digest == p.state_digest,
            CoxError::WrongPredecessor
        );
        materialize(&mut ctx.accounts.position, p)?;
        let position = &mut ctx.accounts.position;
        require!(!position.staged, CoxError::BatchBusy);
        require!(
            position.classes.len() == retirement.classes.len(),
            CoxError::InvalidAccount
        );
        require!(
            position.classes.iter().all(|c| c.locked == 0),
            CoxError::InsufficientUnlockedUnits
        );
        require!(
            position.classes.iter().any(|c| c.units > 0),
            CoxError::AlreadyProcessed
        );
        let mut payable = 0;
        for (index, holding) in position.classes.iter_mut().enumerate() {
            let fixed = &retirement.classes[index];
            let class = &mut p.classes[index];
            if holding.units == 0 {
                continue;
            }
            require!(
                fixed.units > 0 && holding.units <= class.units,
                CoxError::InvalidAccount
            );
            let value = u64::try_from(
                holding.units.checked_mul(fixed.backing as u128)
                    .ok_or(CoxError::ArithmeticOverflow)? / fixed.units,
            ).map_err(|_| error!(CoxError::ArithmeticOverflow))?;
            class.units = class.units.checked_sub(holding.units)
                .ok_or(CoxError::ArithmeticOverflow)?;
            class.backing = sub(class.backing, value)?;
            let residual = if class.units == 0 {
                let remaining = class.backing;
                class.backing = 0;
                remaining
            } else {
                0
            };
            p.active = sub(p.active, add(value, residual)?)?;
            p.residual = add(p.residual, residual)?;
            payable = add(payable, value)?;
            holding.units = 0;
        }
        position.payable = add(position.payable, payable)?;
        p.payable = add(p.payable, payable)?;
        emit!(PositionRetired {
            pool: p.key(),
            owner: position.owner,
            payable,
        });
        reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())
    }
    pub fn pay_retirement(ctx: Context<RetirementPayout>) -> Result<()> {
        let p = &mut ctx.accounts.pool;
        require!(p.schema_version == 3 && p.stage.is_none(), CoxError::NotRetired);
        reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
        materialize(&mut ctx.accounts.position, p)?;
        let position = &mut ctx.accounts.position;
        require!(position.classes.iter().all(|class| class.units == 0 && class.locked == 0), CoxError::InsufficientUnlockedUnits);
        let amount = position.payable;
        require!(amount > 0, CoxError::InsufficientPayable);
        position.payable = 0;
        p.payable = sub(p.payable, amount)?;
        transfer_out(p, &ctx.accounts.vault, &ctx.accounts.user_token, &ctx.accounts.token_program, amount)?;
        emit!(WithdrawalPaid { pool: p.key(), owner: position.owner, amount });
        ctx.accounts.vault.reload()?;
        if let Some(vault) = ctx.accounts.test_vault.as_mut() { vault.reload()?; }
        reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())
    }
    pub fn schedule_fees(
        ctx: Context<ManageFees>,
        bps: u16,
        cap: u64,
        activation_cutoff: u64,
    ) -> Result<()> {
        let p = &mut ctx.accounts.pool;
        require!(p.schema_version != 3, CoxError::PoolRetired);
        require!(matches!(p.schema_version, 2 | 4 | 5), CoxError::InvalidAccount);
        require!(bps <= 100 && cap <= 2_000_000, CoxError::InvalidFee);
        require!(
            !p.fee_pending
                || p.stage.is_none()
                || p.stage_batch
                    .checked_mul(publication_interval(p))
                    .and_then(|v| p.origin.checked_add(v))
                    .is_some_and(|v| v < p.fee_pending_cutoff),
            CoxError::BatchBusy
        );
        let t = now()?;
        require!(
            activation_cutoff > t
                && activation_cutoff >= p.origin
                && (activation_cutoff - p.origin) % publication_interval(p) == 0,
            CoxError::InvalidFeeActivation
        );
        if p.fee_initial_scheduled {
            require!(
                activation_cutoff >= add(t, 86_400)?,
                CoxError::InvalidFeeActivation
            );
        }
        p.fee_next_version = add(p.fee_next_version, 1)?;
        p.fee_pending = true;
        p.fee_pending_version = p.fee_next_version;
        p.fee_pending_bps = bps;
        p.fee_pending_cap = cap;
        p.fee_pending_cutoff = activation_cutoff;
        p.fee_initial_scheduled = true;
        emit!(FeesScheduled {
            pool: p.key(),
            version: p.fee_pending_version,
            bps,
            cap,
            activation_cutoff
        });
        Ok(())
    }
    pub fn cancel_fees(ctx: Context<ManageFees>) -> Result<()> {
        let p = &mut ctx.accounts.pool;
        require!(p.fee_pending, CoxError::InvalidFeeActivation);
        require!(
            p.stage.is_none()
                || p.stage_batch
                    .checked_mul(publication_interval(p))
                    .and_then(|v| p.origin.checked_add(v))
                    .is_some_and(|v| v < p.fee_pending_cutoff),
            CoxError::BatchBusy
        );
        emit!(FeesCancelled {
            pool: p.key(),
            version: p.fee_pending_version
        });
        p.fee_pending = false;
        Ok(())
    }
    pub fn withdraw_fees(ctx: Context<WithdrawFees>, amount: u64) -> Result<()> {
        let p = &mut ctx.accounts.pool;
        reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
        require!(amount > 0 && amount <= p.fees, CoxError::InsufficientFees);
        p.fees = sub(p.fees, amount)?;
        transfer_out_collateral(
            p,
            &ctx.accounts.vault,
            ctx.accounts.test_vault.as_ref(),
            &ctx.accounts.treasury_token,
            &ctx.accounts.token_program,
            amount,
        )?;
        ctx.accounts.vault.reload()?;
        if let Some(vault) = ctx.accounts.test_vault.as_mut() { vault.reload()?; }
        reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
        emit!(FeesWithdrawn {
            pool: p.key(),
            admin: ctx.accounts.admin.key(),
            amount
        });
        Ok(())
    }
    pub fn deposit_with_fee(
        ctx: Context<Submit>,
        to: u8,
        amount: u64,
        minimum_units: u128,
        expiry: u64,
        expected_fee_version: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.pool.fee_version == expected_fee_version,
            CoxError::FeeVersionChanged
        );
        submit(
            ctx,
            Submission {
                op: 0,
                from: u16::MAX,
                to: if to == 255 { u16::MAX } else { u16::from(to) },
                amount,
                units: 0,
                min_units: minimum_units,
                min_proceeds: 0,
                expiry,
            },
        )
    }
    pub fn switch_with_fee(
        ctx: Context<Submit>,
        from: u8,
        to: u8,
        units: u128,
        minimum_units: u128,
        expiry: u64,
        expected_fee_version: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.pool.fee_version == expected_fee_version,
            CoxError::FeeVersionChanged
        );
        submit(
            ctx,
            Submission {
                op: 1,
                from: if from == 255 { u16::MAX } else { u16::from(from) },
                to: if to == 255 { u16::MAX } else { u16::from(to) },
                amount: 0,
                units,
                min_units: minimum_units,
                min_proceeds: 0,
                expiry,
            },
        )
    }
    pub fn redeem_with_fee(
        ctx: Context<Submit>,
        from: u8,
        units: u128,
        minimum_proceeds: u64,
        expiry: u64,
        expected_fee_version: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.pool.fee_version == expected_fee_version,
            CoxError::FeeVersionChanged
        );
        submit(
            ctx,
            Submission {
                op: 2,
                from: if from == 255 { u16::MAX } else { u16::from(from) },
                to: u16::MAX,
                amount: 0,
                units,
                min_units: 0,
                min_proceeds: minimum_proceeds,
                expiry,
            },
        )
    }
    pub fn deposit(
        ctx: Context<Submit>,
        to: u8,
        amount: u64,
        minimum_units: u128,
        expiry: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.pool.fee_version == 0,
            CoxError::FeeVersionChanged
        );
        submit(
            ctx,
            Submission {
                op: 0,
                from: u16::MAX,
                to: if to == 255 { u16::MAX } else { u16::from(to) },
                amount,
                units: 0,
                min_units: minimum_units,
                min_proceeds: 0,
                expiry,
            },
        )
    }
    pub fn switch(
        ctx: Context<Submit>,
        from: u8,
        to: u8,
        units: u128,
        minimum_units: u128,
        expiry: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.pool.fee_version == 0,
            CoxError::FeeVersionChanged
        );
        submit(
            ctx,
            Submission {
                op: 1,
                from: if from == 255 { u16::MAX } else { u16::from(from) },
                to: if to == 255 { u16::MAX } else { u16::from(to) },
                amount: 0,
                units,
                min_units: minimum_units,
                min_proceeds: 0,
                expiry,
            },
        )
    }
    pub fn redeem(
        ctx: Context<Submit>,
        from: u8,
        units: u128,
        minimum_proceeds: u64,
        expiry: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.pool.fee_version == 0,
            CoxError::FeeVersionChanged
        );
        submit(
            ctx,
            Submission {
                op: 2,
                from: if from == 255 { u16::MAX } else { u16::from(from) },
                to: u16::MAX,
                amount: 0,
                units,
                min_units: 0,
                min_proceeds: minimum_proceeds,
                expiry,
            },
        )
    }
    pub fn deposit_v2(ctx: Context<Submit>, to: u16, amount: u64, minimum_units: u128, expiry: u64, expected_fee_version: u64) -> Result<()> {
        require!(ctx.accounts.pool.schema_version == 5 && ctx.accounts.pool.fee_version == expected_fee_version, CoxError::FeeVersionChanged);
        submit(ctx, Submission { op: 0, from: u16::MAX, to, amount, units: 0, min_units: minimum_units, min_proceeds: 0, expiry })
    }
    pub fn switch_v2(ctx: Context<Submit>, from: u16, to: u16, units: u128, minimum_units: u128, expiry: u64, expected_fee_version: u64) -> Result<()> {
        require!(ctx.accounts.pool.schema_version == 5 && ctx.accounts.pool.fee_version == expected_fee_version, CoxError::FeeVersionChanged);
        submit(ctx, Submission { op: 1, from, to, amount: 0, units, min_units: minimum_units, min_proceeds: 0, expiry })
    }
    pub fn redeem_v2(ctx: Context<Submit>, from: u16, units: u128, minimum_proceeds: u64, expiry: u64, expected_fee_version: u64) -> Result<()> {
        require!(ctx.accounts.pool.schema_version == 5 && ctx.accounts.pool.fee_version == expected_fee_version, CoxError::FeeVersionChanged);
        submit(ctx, Submission { op: 2, from, to: u16::MAX, amount: 0, units, min_units: 0, min_proceeds: minimum_proceeds, expiry })
    }
    pub fn register_dynamic_methodology(ctx: Context<RegisterDynamicMethodology>, digest: [u8; 32], length: u32, activation_batch: u64) -> Result<()> {
        require!(length > 0 && length as usize <= DYNAMIC_MAX_ACCOUNT_BYTES - 512, CoxError::InvalidManifest);
        let m = &mut ctx.accounts.methodology;
        m.schema_version = 3; m.bump = ctx.bumps.methodology; m.digest = digest;
        m.expected_length = length; m.activation_batch = activation_batch;
        Ok(())
    }
    pub fn seal_dynamic_methodology(ctx: Context<SealDynamicMethodology>) -> Result<()> {
        let p = &ctx.accounts.pool;
        require!(p.initialized && p.stage.is_none(), CoxError::BatchBusy);
        let next = &mut ctx.accounts.next_methodology;
        require!(!next.sealed && next.canonical.len() == next.expected_length as usize, CoxError::InvalidManifest);
        let mut value = UniverseVersion::from_canonical(&next.canonical)?;
        require!(value.digest == next.digest && value.pool == p.key()
            && value.operator == ctx.accounts.runtime.key()
            && value.capture.predecessor_sequence == p.sequence
            && value.capture.predecessor_state_digest == p.state_digest, CoxError::WrongPredecessor);
        value.sealed = false;
        if p.schema_version == 4 {
            require!(value.source_methodology == ctx.accounts.methodology.digest, CoxError::IncompatibleMethodology);
            value.seal_initial(&read_adaptive_manifest(&ctx.accounts.methodology)?.config)?;
        } else {
            require!(p.schema_version == 5, CoxError::InvalidAccount);
            let previous = read_dynamic_manifest(&ctx.accounts.methodology)?;
            require!(value.capture.timestamp == add(p.origin, p.last_batch)?
                && value.capture.benchmark == p.benchmark
                && value.capture.prices_e8.get(..p.last_prices.len()) == Some(p.last_prices.as_slice()), CoxError::WrongPredecessor);
            value.seal_successor(&previous, p.benchmark)?;
        }
        next.schema_version = 3; next.origin = p.origin;
        next.roster = (0..value.instruments.len()).map(|i| i as u8).collect();
        next.bybit = false; next.sealed = true;
        Ok(())
    }
    pub fn migrate_dynamic_pool(ctx: Context<MigrateDynamicPool>) -> Result<()> {
        require!(ctx.accounts.registry.paused && ctx.accounts.registry.active_batches == 0, CoxError::Paused);
        let p = &mut ctx.accounts.pool;
        reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
        require!(p.schema_version == 4 && p.initialized && p.stage.is_none()
            && p.classes.len() == 31 && p.origin_prices.len() == 30, CoxError::InvalidAccount);
        let universe = read_dynamic_manifest(&ctx.accounts.next_methodology)?;
        require!(universe.version == 1 && universe.pool == p.key()
            && universe.operator == ctx.accounts.registry.runtime
            && universe.source_methodology == ctx.accounts.methodology.digest
            && universe.capture.predecessor_sequence == p.sequence
            && universe.capture.predecessor_state_digest == p.state_digest
            && universe.instruments.iter().map(|i| i.original_price_e8).eq(p.origin_prices.iter().copied()), CoxError::WrongPredecessor);
        p.schema_version = 5;
        p.methodology = ctx.accounts.next_methodology.key();
        Ok(())
    }
    pub fn activate_universe(ctx: Context<ActivateUniverse>) -> Result<()> {
        let p = &mut ctx.accounts.pool;
        reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
        require!(p.schema_version == 5 && p.stage.is_none(), CoxError::BatchBusy);
        let previous = read_dynamic_manifest(&ctx.accounts.methodology)?;
        let next = read_dynamic_manifest(&ctx.accounts.next_methodology)?;
        ctx.accounts.schedule.eligible(p.key(), now()?)?;
        ctx.accounts.schedule.validate_successor(&previous, &next)?;
        require!(next.pool == p.key() && next.operator == ctx.accounts.runtime.key()
            && next.predecessor_digest == previous.digest && next.version == add(previous.version, 1)?
            && next.capture.predecessor_sequence == p.sequence && next.capture.predecessor_state_digest == p.state_digest
            && next.capture.timestamp == add(p.origin, p.last_batch)?
            && next.capture.benchmark == p.benchmark && now()? >= next.capture.timestamp
            && next.capture.prices_e8.get(..p.last_prices.len()) == Some(p.last_prices.as_slice())
            && next.instruments.len() > previous.instruments.len()
            && next.instruments.starts_with(&previous.instruments), CoxError::WrongPredecessor);
        let additional = next.instruments.len() - previous.instruments.len();
        p.origin_prices.reserve_exact(additional); p.last_prices.reserve_exact(additional);
        p.references.reserve_exact(additional); p.classes.reserve_exact(additional);
        for instrument in next.instruments.iter().skip(previous.instruments.len()) {
            p.origin_prices.push(instrument.original_price_e8);
            p.last_prices.push(instrument.original_price_e8);
            p.references.push(100 * math::SCALE);
            p.classes.push(Class::default());
        }
        p.methodology = ctx.accounts.next_methodology.key();
        ctx.accounts.schedule.consumed = true;
        require_account_capacity(&p.to_account_info(), &***p)?;
        emit!(UniverseActivated { pool: p.key(), version: next.version, digest: next.digest, timestamp: next.capture.timestamp });
        Ok(())
    }
    pub fn schedule_universe(ctx: Context<ScheduleUniverse>, version: u64, identities_digest: [u8; 32], expected_instruments: u16, activation_timestamp: u64, expires_at: u64) -> Result<()> {
        let p = &ctx.accounts.pool;
        require!(p.schema_version == 5 && p.stage.is_none(), CoxError::BatchBusy);
        let previous = read_dynamic_manifest(&ctx.accounts.methodology)?;
        require!(version == add(previous.version, 1)? && identities_digest != [0; 32]
            && usize::from(expected_instruments) > previous.instruments.len()
            && usize::from(expected_instruments) <= DYNAMIC_MAX_ASSETS
            && activation_timestamp > now()? && activation_timestamp > add(p.origin, p.last_batch)?
            && expires_at >= activation_timestamp && expires_at <= add(activation_timestamp, 86_400)?, CoxError::InvalidManifest);
        let schedule = &mut ctx.accounts.schedule;
        require!(schedule.schema_version == 0 || schedule.cancelled && !schedule.consumed, CoxError::AlreadyProcessed);
        schedule.schema_version = 1; schedule.bump = ctx.bumps.schedule; schedule.pool = p.key();
        schedule.predecessor_digest = previous.digest; schedule.source_methodology = previous.source_methodology;
        schedule.version = version; schedule.identities_digest = identities_digest; schedule.expected_instruments = expected_instruments;
        schedule.activation_timestamp = activation_timestamp; schedule.expires_at = expires_at; schedule.cancelled = false; schedule.consumed = false;
        Ok(())
    }
    pub fn cancel_universe_schedule(ctx: Context<CancelUniverseSchedule>) -> Result<()> {
        require!(!ctx.accounts.schedule.consumed, CoxError::AlreadyProcessed);
        ctx.accounts.schedule.cancelled = true;
        Ok(())
    }
    pub fn register_scheduled_methodology(ctx: Context<RegisterScheduledMethodology>, digest: [u8; 32], length: u32) -> Result<()> {
        let p = &ctx.accounts.pool;
        ctx.accounts.schedule.eligible(p.key(), now()?)?;
        require!(p.schema_version == 5 && p.stage.is_none() && add(p.origin, p.last_batch)? == ctx.accounts.schedule.activation_timestamp
            && ctx.accounts.methodology.digest == ctx.accounts.schedule.predecessor_digest
            && length > 0 && length as usize <= DYNAMIC_MAX_ACCOUNT_BYTES - 512 && digest != [0; 32], CoxError::InvalidManifest);
        let m = &mut ctx.accounts.next_methodology;
        m.schema_version = 3; m.bump = ctx.bumps.next_methodology; m.digest = digest; m.expected_length = length;
        m.activation_batch = ctx.accounts.schedule.activation_timestamp.checked_sub(p.origin).ok_or(CoxError::InvalidOrigin)?;
        Ok(())
    }
    pub fn upload_scheduled_methodology(ctx: Context<ManageScheduledMethodology>, offset: u32, bytes: Vec<u8>) -> Result<()> {
        ctx.accounts.schedule.eligible(ctx.accounts.pool.key(), now()?)?;
        let m = &mut ctx.accounts.next_methodology;
        require!(m.schema_version == 3 && !m.sealed && offset as usize == m.canonical.len()
            && !bytes.is_empty() && bytes.len() <= 900
            && m.canonical.len().checked_add(bytes.len()).is_some_and(|size| size <= m.expected_length as usize), CoxError::InvalidManifest);
        m.canonical.extend(bytes);
        require_account_capacity(&m.to_account_info(), &**m)
    }
    pub fn seal_scheduled_methodology(ctx: Context<ManageScheduledMethodology>) -> Result<()> {
        let p = &ctx.accounts.pool;
        ctx.accounts.schedule.eligible(p.key(), now()?)?;
        require!(p.schema_version == 5 && p.stage.is_none(), CoxError::BatchBusy);
        let previous = read_dynamic_manifest(&ctx.accounts.methodology)?;
        let m = &mut ctx.accounts.next_methodology;
        require!(m.schema_version == 3 && !m.sealed && m.canonical.len() == m.expected_length as usize, CoxError::InvalidManifest);
        let mut next = UniverseVersion::from_canonical(&m.canonical)?;
        ctx.accounts.schedule.validate_successor(&previous, &next)?;
        require!(next.digest == m.digest && next.operator == ctx.accounts.runtime.key()
            && next.capture.predecessor_sequence == p.sequence && next.capture.predecessor_state_digest == p.state_digest
            && next.capture.timestamp == add(p.origin, p.last_batch)? && next.capture.benchmark == p.benchmark
            && next.capture.prices_e8.get(..p.last_prices.len()) == Some(p.last_prices.as_slice()), CoxError::WrongPredecessor);
        next.sealed = false; let canonical_digest = next.digest; next.seal_validated_successor(&previous, p.benchmark, canonical_digest)?;
        m.origin = p.origin; m.roster = (0..next.instruments.len()).map(|index| index as u8).collect(); m.bybit = false; m.sealed = true;
        Ok(())
    }
    pub fn grow_dynamic_account(ctx: Context<GrowDynamicAccount>, additional_bytes: u32) -> Result<()> {
        let p = &ctx.accounts.pool;
        require!(matches!(p.schema_version, 4 | 5) && p.stage.is_none(), CoxError::BatchBusy);
        let target = &ctx.accounts.target;
        let key = target.key();
        let pool_key = p.key();
        let fixed = [pool_key, Pubkey::find_program_address(&[b"batch", pool_key.as_ref()], &crate::ID).0,
            Pubkey::find_program_address(&[b"publication", pool_key.as_ref()], &crate::ID).0];
        let authority = ctx.accounts.payer.key();
        let privileged = authority == ctx.accounts.registry.admin || authority == ctx.accounts.registry.runtime;
        let mut valid = privileged && fixed.contains(&key);
        let mut limit = if key == pool_key { 32768 } else { dynamic_batch_space(p.classes.len()) };
        if !valid {
            let data = target.try_borrow_data()?;
            if let Ok(position) = Position::try_deserialize(&mut data.as_ref()) {
                valid = (privileged || position.owner == authority) && position.pool == pool_key
                    && Pubkey::find_program_address(&[b"position", pool_key.as_ref(), position.owner.as_ref()], &crate::ID).0 == key;
                limit = dynamic_position_space(p.classes.len());
            }
            if !valid && privileged {
                if let Ok(methodology) = Methodology::try_deserialize(&mut data.as_ref()) {
                    valid = !methodology.sealed && methodology.schema_version == 3
                        && Pubkey::find_program_address(&[b"methodology", methodology.digest.as_ref()], &crate::ID).0 == key;
                    limit = methodology.expected_length as usize + 512;
                }
            }
        }
        require!(valid, CoxError::Unauthorized);
        let next = validate_growth(target.data_len(), additional_bytes as usize)?;
        require!(next <= limit, CoxError::CapacityExceeded);
        let rent = Rent::get()?.minimum_balance(next);
        let needed = rent.saturating_sub(target.lamports());
        if needed > 0 { anchor_lang::system_program::transfer(CpiContext::new(ctx.accounts.system_program.to_account_info(), anchor_lang::system_program::Transfer {
            from: ctx.accounts.payer.to_account_info(), to: target.to_account_info(),
        }), needed)?; }
        target.to_account_info().realloc(next, false)?;
        Ok(())
    }
    pub fn begin_dynamic_publication(ctx: Context<BeginDynamicPublication>, batch_id: u64, sequence: u64, predecessor: [u8; 32], snapshot: [u8; 32], benchmark: i128) -> Result<()> {
        let p = &mut ctx.accounts.pool;
        reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
        require!(p.schema_version == 5 && p.initialized && p.stage.is_none() && !ctx.accounts.registry.paused, CoxError::BatchBusy);
        let universe = read_dynamic_manifest(&ctx.accounts.methodology)?;
        require!(universe.pool == p.key(), CoxError::InvalidManifest);
        let cutoff = add(p.origin, batch_id)?;
        let timestamp = now()?;
        require!(timestamp >= cutoff && timestamp <= add(cutoff, 5)?, CoxError::CommitDeadlinePassed);
        require!(batch_id > p.last_batch && batch_id > p.stage_batch && sequence == add(p.sequence, 1)? && predecessor == p.state_digest
            && benchmark > 0 && snapshot != [0; 32] && ctx.accounts.methodology.activation_batch <= batch_id, CoxError::WrongPredecessor);
        if let Some(next) = ctx.accounts.registry.pending_runtime {
            if batch_id >= ctx.accounts.registry.runtime_effective_batch {
                ctx.accounts.registry.runtime = next;
                ctx.accounts.registry.pending_runtime = None;
            }
        }
        require_keys_eq!(ctx.accounts.registry.runtime, ctx.accounts.runtime.key(), CoxError::Unauthorized);
        let b = &mut ctx.accounts.batch;
        let committed = matches!(b.schema_version, 2 | 3 | 4) && b.pool == p.key()
            && b.phase == 2 && b.sequence == p.sequence && b.batch_id == p.last_batch;
        let cancelled = b.schema_version == 4 && b.pool == p.key() && b.phase == DynamicPhase::Cancelled as u8
            && b.batch_id == p.stage_batch && b.sequence == add(p.sequence, 1)?
            && b.predecessor_sequence == p.sequence && b.predecessor_digest == p.state_digest;
        require!(b.schema_version == 0 || committed || cancelled, CoxError::BatchBusy);
        b.schema_version = 4; b.bump = ctx.bumps.batch; b.pool = p.key(); b.batch_id = batch_id;
        b.sequence = sequence; b.cutoff = cutoff; b.predecessor_sequence = p.sequence;
        b.predecessor_digest = predecessor; b.snapshot_digest = snapshot; b.benchmark = benchmark;
        b.prices.clear(); b.references.clear(); b.fixed.clear(); b.burns.clear(); b.mints.clear(); b.incoming.clear(); b.blocked.clear();
        b.accepted_deposits = 0; b.new_payable = 0; b.fees = 0; b.transfer_residual = 0;
        b.executed = 0; b.rejected = 0; b.phase = DynamicPhase::Prices as u8; b.safety_changed = false;
        b.closed_queue_end = p.next_request_nonce; b.queue_start = p.queue_start;
        b.cursor = p.queue_start; b.next_queue_start = p.next_request_nonce;
        b.receipt_root = mm(math::digest("COX/RECEIPTS/V2", &[]))?;
        b.staged_root = mm(math::digest("COX/STAGE/V1", &[]))?; b.accepted_at = timestamp;
        require!(b.closed_queue_end - b.queue_start <= u32::MAX as u64, CoxError::CapacityExceeded);
        p.stage = Some(b.key()); p.stage_batch = batch_id; p.stage_closed_end = b.closed_queue_end;
        ctx.accounts.registry.active_batches = add(ctx.accounts.registry.active_batches, 1)?;
        ctx.accounts.registry.max_accepted_batch = ctx.accounts.registry.max_accepted_batch.max(batch_id);
        emit!(BatchAccepted { pool: p.key(), batch: batch_id, snapshot });
        Ok(())
    }
    pub fn append_dynamic_prices(ctx: Context<StageDynamicPublication>, offset: u16, prices: Vec<PriceWire>) -> Result<()> {
        require!(!ctx.accounts.registry.paused, CoxError::Paused);
        let b = &mut ctx.accounts.batch;
        let universe = read_dynamic_manifest(&ctx.accounts.methodology)?;
        require!(b.phase == DynamicPhase::Prices as u8 && offset as usize == b.prices.len()
            && !prices.is_empty() && prices.len() <= 16
            && b.prices.len() + prices.len() <= universe.instruments.len(), CoxError::InvalidPrice);
        for price in &prices { validate_dynamic_price(price, b.cutoff)?; }
        b.prices.extend(prices);
        require_account_capacity(&b.to_account_info(), &***b)?;
        Ok(())
    }
    pub fn seal_dynamic_publication(ctx: Context<StageDynamicPublication>) -> Result<()> {
        require!(!ctx.accounts.registry.paused, CoxError::Paused);
        let p = &ctx.accounts.pool; let b = &mut ctx.accounts.batch;
        require!(b.phase == DynamicPhase::Prices as u8 && b.predecessor_sequence == p.sequence && b.predecessor_digest == p.state_digest, CoxError::WrongPredecessor);
        let universe = read_dynamic_manifest(&ctx.accounts.methodology)?;
        require!(dynamic_snapshot_digest(b.cutoff, b.benchmark, &universe, &b.prices)? == b.snapshot_digest, CoxError::InvalidSnapshotDigest);
        if universe.instruments.len() > 32 {
            let n = p.classes.len();
            b.references = vec![100 * math::SCALE; n]; b.burns = vec![0; n]; b.mints = vec![0];
            b.cursor = 0; b.phase = DynamicPhase::References as u8; b.fixed.clear(); b.transfer_residual = p.active;
            return require_account_capacity(&b.to_account_info(), &***b);
        }
        let reference = dynamic_reference(p, &universe, &b.prices.iter().map(|price| price.price_e8).collect::<Vec<_>>(), b.benchmark)?;
        let revaluation = mm(math::revalue_dynamic(&to_math(&p.classes), &reference.h))?;
        b.references = reference.relative; b.fixed = from_math(&revaluation.classes); b.transfer_residual = revaluation.residual;
        let n = p.classes.len(); b.burns = vec![0; n]; b.mints = vec![0; n]; b.incoming = vec![0; n]; b.blocked = vec![false; n];
        b.phase = 0;
        require_account_capacity(&b.to_account_info(), &***b)?;
        Ok(())
    }
    pub fn prepare_dynamic_revaluation(ctx: Context<StageDynamicPublication>, offset: u16, limit: u16) -> Result<()> {
        require!(!ctx.accounts.registry.paused, CoxError::Paused);
        let p = &ctx.accounts.pool; let b = &mut ctx.accounts.batch;
        let universe = read_dynamic_manifest(&ctx.accounts.methodology)?;
        require!(b.phase == DynamicPhase::References as u8 && b.cursor == u64::from(offset) && limit > 0 && limit <= 16
            && usize::from(offset) < universe.instruments.len() && b.burns.len() == p.classes.len() && b.mints.len() == 1, CoxError::InvalidPrice);
        let end = (usize::from(offset) + usize::from(limit)).min(universe.instruments.len());
        for index in usize::from(offset)..end {
            let instrument = &universe.instruments[index];
            let (relative, h) = dynamic_asset_reference(p, instrument, index, b.prices[index].price_e8, b.benchmark)?;
            let class = usize::from(instrument.class_id);
            let score = (p.classes[class].backing as i128).checked_mul(h).ok_or(CoxError::ArithmeticOverflow)?;
            let score = u128::try_from(score).map_err(|_| CoxError::InvalidPrice)?;
            b.references[class] = relative; b.burns[class] = score; b.mints[0] = addu(b.mints[0], score)?;
        }
        b.cursor = end as u64;
        if end == universe.instruments.len() {
            let score = (p.classes[30].backing as u128).checked_mul(math::SCALE as u128).ok_or(CoxError::ArithmeticOverflow)?;
            b.burns[30] = score; b.mints[0] = addu(b.mints[0], score)?;
            require!(b.mints[0] <= i128::MAX as u128 && (p.active == 0 || b.mints[0] > 0), CoxError::ArithmeticOverflow);
            b.cursor = 0; b.phase = DynamicPhase::Backings as u8;
        }
        Ok(())
    }
    pub fn finish_dynamic_revaluation(ctx: Context<StageDynamicPublication>, offset: u16, limit: u16) -> Result<()> {
        require!(!ctx.accounts.registry.paused, CoxError::Paused);
        let p = &ctx.accounts.pool; let b = &mut ctx.accounts.batch;
        require!(b.phase == DynamicPhase::Backings as u8 && b.cursor == u64::from(offset) && b.fixed.len() == usize::from(offset)
            && limit > 0 && limit <= 16 && usize::from(offset) < p.classes.len() && b.mints.len() == 1, CoxError::InvalidPrice);
        let end = (usize::from(offset) + usize::from(limit)).min(p.classes.len());
        for class in usize::from(offset)..end {
            let backing = if p.active == 0 { p.classes[class].backing } else {
                let score = i128::try_from(b.burns[class]).map_err(|_| CoxError::ArithmeticOverflow)?;
                let numerator = (p.active as i128).checked_mul(score).ok_or(CoxError::ArithmeticOverflow)?;
                u64::try_from(numerator / i128::try_from(b.mints[0]).map_err(|_| CoxError::ArithmeticOverflow)?).map_err(|_| CoxError::ArithmeticOverflow)?
            };
            b.transfer_residual = sub(b.transfer_residual, backing)?;
            b.fixed.push(Class { backing, units: p.classes[class].units });
        }
        b.cursor = end as u64;
        if end == p.classes.len() {
            let n = p.classes.len();
            b.burns = vec![0; n]; b.mints = vec![0; n]; b.incoming = vec![0; n]; b.blocked = vec![false; n];
            b.phase = 0; b.cursor = b.queue_start;
        }
        require_account_capacity(&b.to_account_info(), &***b)
    }
    pub fn cancel_dynamic_preparation(ctx: Context<CancelDynamicPreparation>) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        require!(registry.paused, CoxError::Paused);
        let p = &mut ctx.accounts.pool; let b = &mut ctx.accounts.batch;
        require!(p.schema_version == 5 && registry.active_batches > 0
            && matches!(b.phase, 4 | 5 | 6) && b.sequence == add(p.sequence, 1)?
            && b.batch_id == p.stage_batch && b.predecessor_sequence == p.sequence && b.predecessor_digest == p.state_digest
            && b.closed_queue_end == p.stage_closed_end && b.queue_start == p.queue_start && b.closed_queue_end <= p.next_request_nonce
            && b.executed == 0 && b.rejected == 0 && b.accepted_deposits == 0 && b.new_payable == 0 && b.fees == 0,
            CoxError::BatchBusy);
        p.stage = None;
        registry.active_batches = sub(registry.active_batches, 1)?;
        let cancelled_phase = b.phase;
        b.phase = DynamicPhase::Cancelled as u8;
        b.prices.clear(); b.references.clear(); b.fixed.clear(); b.burns.clear(); b.mints.clear(); b.incoming.clear(); b.blocked.clear();
        emit!(DynamicPreparationCancelled { pool: p.key(), batch: b.batch_id, sequence: p.sequence, snapshot: b.snapshot_digest, phase: cancelled_phase });
        Ok(())
    }
    pub fn cancel(ctx: Context<ManageRequest>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.request.owner,
            ctx.accounts.authority.key(),
            CoxError::Unauthorized
        );
        release_request(ctx, false)
    }
    pub fn expire(ctx: Context<ManageRequest>) -> Result<()> {
        release_request(ctx, true)
    }
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        refund_inner(ctx, None)
    }
    pub fn refund_partial(ctx: Context<Refund>, amount: u64) -> Result<()> {
        refund_inner(ctx, Some(amount))
    }
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let p = &mut ctx.accounts.pool;
        reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
        require!(p.schema_version == 3 || !halted(p, now()?)?, CoxError::Halted);
        materialize(&mut ctx.accounts.position, p)?;
        require!(
            amount > 0 && ctx.accounts.position.payable >= amount,
            CoxError::InsufficientPayable
        );
        ctx.accounts.position.payable = sub(ctx.accounts.position.payable, amount)?;
        p.payable = sub(p.payable, amount)?;
        transfer_out_collateral(
            p,
            &ctx.accounts.vault,
            ctx.accounts.test_vault.as_ref(),
            &ctx.accounts.user_token,
            &ctx.accounts.token_program,
            amount,
        )?;
        emit!(WithdrawalPaid {
            pool: p.key(),
            owner: ctx.accounts.owner.key(),
            amount
        });
        ctx.accounts.vault.reload()?;
        if let Some(vault) = ctx.accounts.test_vault.as_mut() { vault.reload()?; }
        reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
        Ok(())
    }
    pub fn publish(
        ctx: Context<Publish>,
        batch_id: u64,
        sequence: u64,
        predecessor: [u8; 32],
        prices: Vec<PriceWire>,
        snapshot: [u8; 32],
        archive_time: u64,
    ) -> Result<()> {
        require!(ctx.accounts.pool.schema_version < 4, CoxError::InvalidAccount);
        publish_inner(ctx, batch_id, sequence, predecessor, prices, snapshot, archive_time, None)
    }
    pub fn publish_adaptive(
        ctx: Context<Publish>,
        batch_id: u64,
        sequence: u64,
        predecessor: [u8; 32],
        prices: Vec<PriceWire>,
        snapshot: [u8; 32],
        archive_time: u64,
        benchmark: i128,
    ) -> Result<()> {
        require!(ctx.accounts.pool.schema_version == 4, CoxError::InvalidAccount);
        publish_inner(ctx, batch_id, sequence, predecessor, prices, snapshot, archive_time, Some(benchmark))
    }
    pub fn evaluate(ctx: Context<Process>) -> Result<()> {
        let p = &mut ctx.accounts.pool;
        reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
        require!(!ctx.accounts.registry.paused, CoxError::Paused);
        let b = &mut ctx.accounts.batch;
        require!(
            b.phase == 0 && b.cursor < b.closed_queue_end,
            CoxError::BatchIncomplete
        );
        let r = &mut ctx.accounts.request;
        require!(r.nonce == b.cursor, CoxError::Replay);
        refresh_request(r, p);
        if r.status == 0 && r.target_batch <= b.batch_id {
            r.bound_batch = b.batch_id;
            r.bound_sequence = b.sequence;
            r.evaluated = true;
            let request = math::Request {
                id: r.key().to_string(),
                expiry: r.expiry_batch,
                operation: operation(r),
            };
            match if p.schema_version == 5 { math::batch_with_fees_dynamic(&to_math(&b.fixed), &[request], b.batch_id, &[fee_terms(r)]) } else { math::batch_with_fees(&to_math(&b.fixed), &[request], b.batch_id, &[fee_terms(r)]) }
            {
                Ok(result) => {
                    let receipt = &result.receipts[0];
                    r.receipt_status = match receipt.outcome {
                        math::Outcome::Filled => 0,
                        math::Outcome::ConditionFailed => 1,
                        math::Outcome::Expired => 2,
                        math::Outcome::ZeroValueClass => 3,
                    };
                    r.minted = receipt.minted;
                    r.proceeds = receipt.proceeds;
                    r.gross = receipt.gross;
                    r.fee = receipt.fee;
                    if r.receipt_status == 0 && request_to(r) != u16::MAX {
                        let i = request_to(r) as usize;
                        match b.incoming[i].checked_add(r.minted) {
                            Some(total) => b.incoming[i] = total,
                            None => b.blocked[i] = true,
                        };
                    }
                }
                Err(_) => {
                    r.receipt_status = 4;
                    r.minted = 0;
                    r.proceeds = 0;
                    r.gross = 0;
                    r.fee = 0;
                }
            }
        } else if r.status == 0 {
            b.next_queue_start = b.next_queue_start.min(r.nonce);
        }
        b.cursor = add(b.cursor, 1)?;
        Ok(())
    }
    pub fn safety(ctx: Context<Process>) -> Result<()> {
        let p = &mut ctx.accounts.pool;
        reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
        require!(!ctx.accounts.registry.paused, CoxError::Paused);
        let b = &mut ctx.accounts.batch;
        require!(
            b.phase == 3 && b.cursor < b.closed_queue_end,
            CoxError::BatchIncomplete
        );
        let r = &ctx.accounts.request;
        require!(r.nonce == b.cursor, CoxError::Replay);
        if r.evaluated
            && !r.applied
            && r.bound_sequence == b.sequence
            && r.bound_batch == b.batch_id
            && r.receipt_status == 0
            && (request_to(r) == u16::MAX || !b.blocked[request_to(r) as usize])
        {
            if request_from(r) != u16::MAX {
                let i = request_from(r) as usize;
                b.burns[i] = addu(b.burns[i], r.units)?;
            }
            if request_to(r) != u16::MAX {
                let i = request_to(r) as usize;
                if let Some(sum) = b.mints[i].checked_add(r.minted) {
                    b.mints[i] = sum;
                } else {
                    b.blocked[i] = true;
                    b.safety_changed = true;
                }
            }
        }
        b.cursor = add(b.cursor, 1)?;
        Ok(())
    }
    pub fn seal_evaluation(ctx: Context<BatchOnly>) -> Result<()> {
        let p = &mut ctx.accounts.pool;
        reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
        require!(!ctx.accounts.registry.paused, CoxError::Paused);
        let b = &mut ctx.accounts.batch;
        require!(
            (b.phase == 0 || b.phase == 3) && b.cursor == b.closed_queue_end,
            CoxError::BatchIncomplete
        );
        if b.phase == 0 {
            b.phase = 3;
            b.cursor = b.queue_start;
            b.burns.fill(0);
            b.mints.fill(0);
            return Ok(());
        }
        let mut changed = b.safety_changed;
        for i in 0..b.fixed.len() {
            let units = b.fixed[i]
                .units
                .checked_sub(b.burns[i])
                .and_then(|u| u.checked_add(b.mints[i]));
            if units.is_none_or(|u| u > UNIT_LIMIT) && !b.blocked[i] {
                b.blocked[i] = true;
                changed = true;
            }
        }
        b.burns.fill(0);
        b.mints.fill(0);
        b.cursor = b.queue_start;
        b.safety_changed = false;
        b.phase = if changed { 3 } else { 1 };
        Ok(())
    }
    pub fn execute(ctx: Context<Process>) -> Result<()> {
        let p = &mut ctx.accounts.pool;
        reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
        require!(!ctx.accounts.registry.paused, CoxError::Paused);
        let b = &mut ctx.accounts.batch;
        require!(
            b.phase == 1 && b.cursor < b.closed_queue_end,
            CoxError::BatchIncomplete
        );
        let r = &mut ctx.accounts.request;
        require!(r.nonce == b.cursor, CoxError::Replay);
        if r.evaluated
            && !r.applied
            && r.bound_sequence == b.sequence
            && r.bound_batch == b.batch_id
        {
            let position = &mut ctx.accounts.position;
            require_keys_eq!(position.owner, r.owner, CoxError::InvalidAccount);
            materialize(position, p)?;
            extend_dynamic_position(position, p)?;
            if position.staged {
                require!(position.staged_sequence == b.sequence, CoxError::BatchBusy);
            } else {
                position.staged = true;
                position.staged_sequence = b.sequence;
                position.staged_burns = vec![0; p.classes.len()];
                position.staged_mints = vec![0; p.classes.len()];
                position.staged_unlocks = vec![0; p.classes.len()];
            }
            if r.receipt_status == 0 && request_to(r) != u16::MAX && b.blocked[request_to(r) as usize] {
                r.receipt_status = 4;
                r.minted = 0;
                r.proceeds = 0;
                r.fee = 0;
            }
            if request_from(r) != u16::MAX {
                let i = request_from(r) as usize;
                position.staged_unlocks[i] = addu(position.staged_unlocks[i], r.units)?;
            }
            if r.receipt_status == 0 {
                b.fees = add(b.fees, r.fee)?;
                if request_from(r) != u16::MAX {
                    let i = request_from(r) as usize;
                    b.burns[i] = addu(b.burns[i], r.units)?;
                    position.staged_burns[i] = addu(position.staged_burns[i], r.units)?;
                } else {
                    b.accepted_deposits = add(b.accepted_deposits, r.amount)?;
                }
                if request_to(r) != u16::MAX {
                    let i = request_to(r) as usize;
                    b.mints[i] = addu(b.mints[i], r.minted)?;
                    position.staged_mints[i] = addu(position.staged_mints[i], r.minted)?;
                } else {
                    b.new_payable = add(b.new_payable, r.proceeds)?;
                    position.staged_payable = add(position.staged_payable, r.proceeds)?;
                }
                b.executed = b
                    .executed
                    .checked_add(1)
                    .ok_or(CoxError::ArithmeticOverflow)?;
            } else {
                r.fee = 0;
                if r.operation == 0 {
                    position.staged_refundable = add(position.staged_refundable, r.amount)?;
                }
                b.rejected = b
                    .rejected
                    .checked_add(1)
                    .ok_or(CoxError::ArithmeticOverflow)?;
            }
            let mut bytes = Vec::new();
            bytes.extend_from_slice(&b.receipt_root);
            bytes.extend_from_slice(r.key().as_ref());
            bytes.push(r.receipt_status);
            bytes.extend_from_slice(&r.minted.to_le_bytes());
            bytes.extend_from_slice(&r.proceeds.to_le_bytes());
            if b.schema_version >= 3 {
                bytes.extend_from_slice(&r.gross.to_le_bytes());
                bytes.extend_from_slice(&r.fee.to_le_bytes());
                bytes.extend_from_slice(&r.fee_version.to_le_bytes());
                bytes.extend_from_slice(&r.fee_bps.to_le_bytes());
                bytes.extend_from_slice(&r.fee_cap.to_le_bytes());
            }
            b.receipt_root = math::artifact_digest(&bytes);
            let mut staged = Vec::new();
            staged.extend_from_slice(&b.staged_root);
            staged.extend_from_slice(r.key().as_ref());
            staged.extend_from_slice(&b.receipt_root);
            b.staged_root = math::artifact_digest(&staged);
            r.applied = true;
        }
        require_account_capacity(&ctx.accounts.position.to_account_info(), &**ctx.accounts.position)?;
        b.cursor = add(b.cursor, 1)?;
        Ok(())
    }
    pub fn finalize(ctx: Context<Finalize>) -> Result<()> {
        let p = &mut ctx.accounts.pool;
        reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
        require!(!ctx.accounts.registry.paused, CoxError::Paused);
        let previous_publication = &ctx.accounts.publication;
        if p.initialized {
            require!(
                matches!(previous_publication.schema_version, 2 | 3 | 4)
                    && previous_publication.pool == p.key()
                    && previous_publication.sequence == p.sequence
                    && previous_publication.batch == p.last_batch
                    && previous_publication.state_digest == p.state_digest,
                CoxError::InvalidAccount
            );
        } else {
            require!(
                previous_publication.schema_version == 0,
                CoxError::InvalidAccount
            );
        }
        let b = &mut ctx.accounts.batch;
        require!(
            b.phase == 1 && b.cursor == b.closed_queue_end,
            CoxError::BatchIncomplete
        );
        require!(
            p.sequence == b.predecessor_sequence && p.state_digest == b.predecessor_digest,
            CoxError::WrongPredecessor
        );
        let mut classes = Vec::new();
        for i in 0..b.fixed.len() {
            let c = &b.fixed[i];
            let units = addu(
                c.units
                    .checked_sub(b.burns[i])
                    .ok_or(CoxError::ArithmeticOverflow)?,
                b.mints[i],
            )?;
            require!(units <= UNIT_LIMIT, CoxError::CapacityExceeded);
            let backing = if c.units == 0 {
                units / (math::SCALE as u128)
            } else {
                units
                    .checked_mul(c.backing as u128)
                    .ok_or(CoxError::ArithmeticOverflow)?
                    .checked_div(c.units)
                    .ok_or(CoxError::ArithmeticOverflow)?
            };
            classes.push(Class {
                backing: u64::try_from(backing).map_err(|_| CoxError::ArithmeticOverflow)?,
                units,
            });
        }
        if p.schema_version == 5 { mm(math::validate_dynamic_classes(&to_math(&classes)))?; } else { mm(math::validate_classes(&to_math(&classes)))?; }
        let fixed_total = total(&b.fixed)?;
        let active = total(&classes)?;
        let flow = sub(
            sub(
                sub(add(fixed_total, b.accepted_deposits)?, b.new_payable)?,
                b.fees,
            )?,
            active,
        )?;
        let before = p.classes.clone();
        p.active = active;
        p.pending = sub(p.pending, b.accepted_deposits)?;
        p.payable = add(p.payable, b.new_payable)?;
        p.fees = add(p.fees, b.fees)?;
        p.residual = add(p.residual, add(b.transfer_residual, flow)?)?;
        let current = b.prices.iter().map(|x| x.price_e8).collect::<Vec<_>>();
        if !p.initialized {
            p.origin_prices = current.clone();
        }
        p.last_prices = current;
        p.benchmark = b.benchmark;
        p.references = b.references.clone();
        p.classes = classes;
        p.last_batch = b.batch_id;
        p.sequence = b.sequence;
        p.initialized = true;
        p.stage = None;
        p.queue_start = b.next_queue_start;
        if p.fee_pending && b.cutoff >= p.fee_pending_cutoff {
            p.fee_version = p.fee_pending_version;
            p.fee_bps = p.fee_pending_bps;
            p.fee_cap = p.fee_pending_cap;
            p.fee_pending = false;
            emit!(FeesActivated {
                pool: p.key(),
                version: p.fee_version,
                bps: p.fee_bps,
                cap: p.fee_cap
            });
        }
        ctx.accounts.registry.active_batches = sub(ctx.accounts.registry.active_batches, 1)?;
        let state = state_bytes(
            &crate::ID,
            &p.key(),
            p,
            &before,
            b,
            &ctx.accounts.methodology.digest,
        )?;
        p.state_digest = if p.schema_version == 5 { dynamic_digest(&state) } else { math::artifact_digest(&state) };
        b.phase = 2;
        let publication = &mut ctx.accounts.publication;
        publication.schema_version = if p.schema_version == 5 { 4 } else if p.schema_version >= 2 { 3 } else { 2 };
        publication.bump = ctx.bumps.publication;
        publication.pool = p.key();
        publication.sequence = p.sequence;
        publication.batch = b.batch_id;
        publication.state_digest = p.state_digest;
        publication.snapshot_digest = b.snapshot_digest;
        publication.manifest_digest = ctx.accounts.methodology.digest;
        publication.state_preimage = state;
        publication.prices = b.prices.clone();
        publication.committed_at = now()?;
        emit!(PublicationCommitted {
            pool: p.key(),
            sequence: p.sequence,
            batch: b.batch_id,
            state_digest: p.state_digest,
            snapshot: b.snapshot_digest,
            manifest: ctx.accounts.methodology.digest
        });
        reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
        Ok(())
    }
    pub fn initialize_dynamic_position(ctx: Context<InitializeDynamicPosition>) -> Result<()> {
        require!(ctx.accounts.pool.schema_version == 5, CoxError::InvalidAccount);
        let position = &mut ctx.accounts.position;
        position.schema_version = 1; position.bump = ctx.bumps.position;
        position.pool = ctx.accounts.pool.key(); position.owner = ctx.accounts.owner.key();
        Ok(())
    }
    pub fn read_reference_v2(ctx: Context<ReadPool>, class: u16) -> Result<ReferenceRead> {
        let p = &ctx.accounts.pool;
        require!(p.schema_version == 5 && p.initialized && usize::from(class) < p.classes.len(), CoxError::InvalidAccount);
        let c = &p.classes[usize::from(class)];
        Ok(ReferenceRead { sequence: p.sequence, batch: p.last_batch, cutoff: add(p.origin, p.last_batch)?,
            reference: p.references[usize::from(class)], backing: c.backing, units: c.units, state_digest: p.state_digest })
    }
    pub fn quote_request_v2(ctx: Context<ReadPool>, operation: u8, from: u16, to: u16, amount: u64, units: u128, expected_fee_version: u64) -> Result<FeeQuoteRead> {
        let p = &ctx.accounts.pool;
        require!(p.schema_version == 5 && p.initialized && operation <= 2, CoxError::InvalidRequest);
        require!(p.fee_version == expected_fee_version, CoxError::FeeVersionChanged);
        let operation = match operation {
            0 => math::Operation::Deposit { to: usize::from(to), amount, min_units: 0 },
            1 => math::Operation::Switch { from: usize::from(from), to: usize::from(to), units, min_units: 0 },
            _ => math::Operation::Redeem { from: usize::from(from), units, min_proceeds: 0 },
        };
        let result = mm(math::batch_with_fees_dynamic(&to_math(&p.classes), &[math::Request {
            id: "quote".into(), expiry: u64::MAX, operation,
        }], p.last_batch, &[math::FeeTerms { version: p.fee_version, bps: p.fee_bps, cap: p.fee_cap }]))?;
        let receipt = &result.receipts[0];
        Ok(FeeQuoteRead { sequence: p.sequence, minted: receipt.minted, proceeds: receipt.proceeds,
            gross: receipt.gross, fee: receipt.fee, fee_version: p.fee_version })
    }
    pub fn read_reference(ctx: Context<ReadPool>, class: u8) -> Result<ReferenceRead> {
        let p = &ctx.accounts.pool;
        require!(
            matches!(p.schema_version, 1 | 2 | 3 | 4 | 5)
                && p.initialized
                && (class as usize) < p.classes.len(),
            CoxError::InvalidAccount
        );
        let c = &p.classes[class as usize];
        Ok(ReferenceRead {
            sequence: p.sequence,
            batch: p.last_batch,
            cutoff: add(
                p.origin,
                p.last_batch
                    .checked_mul(publication_interval(p))
                    .ok_or(CoxError::ArithmeticOverflow)?,
            )?,
            reference: p.references[class as usize],
            backing: c.backing,
            units: c.units,
            state_digest: p.state_digest,
        })
    }
    pub fn read_position(ctx: Context<ReadPosition>, owner: Pubkey) -> Result<PositionRead> {
        let p = &ctx.accounts.pool;
        let position = &ctx.accounts.position;
        require!(p.schema_version != 5 || p.classes.len() <= 31, CoxError::CapacityExceeded);
        require_keys_eq!(position.owner, owner, CoxError::Unauthorized);
        let mut classes = position.classes.clone();
        let mut payable = position.payable;
        let mut refundable = position.refundable;
        if position.staged && p.initialized && position.staged_sequence <= p.sequence {
            for (i, c) in classes.iter_mut().enumerate() {
                c.units = addu(
                    c.units
                        .checked_sub(position.staged_burns[i])
                        .ok_or(CoxError::ArithmeticOverflow)?,
                    position.staged_mints[i],
                )?;
                c.locked = c
                    .locked
                    .checked_sub(position.staged_unlocks[i])
                    .ok_or(CoxError::ArithmeticOverflow)?;
            }
            payable = add(payable, position.staged_payable)?;
            refundable = add(refundable, position.staged_refundable)?;
        }
        if p.schema_version == 5 {
            require!(classes.len() <= p.classes.len(), CoxError::InvalidAccount);
            classes.resize_with(p.classes.len(), PositionClass::default);
        }
        Ok(PositionRead {
            sequence: p.sequence,
            classes,
            payable,
            refundable,
        })
    }
    pub fn quote_request(
        ctx: Context<ReadPool>,
        operation: u8,
        from: u8,
        to: u8,
        amount: u64,
        units: u128,
    ) -> Result<QuoteRead> {
        let p = &ctx.accounts.pool;
        require!(p.schema_version != 3, CoxError::PoolRetired);
        require!(p.fee_version == 0, CoxError::FeeVersionChanged);
        require!(operation <= 2 && p.initialized, CoxError::InvalidRequest);
        let operation = match operation {
            0 => math::Operation::Deposit {
                to: to as usize,
                amount,
                min_units: 0,
            },
            1 => math::Operation::Switch {
                from: from as usize,
                to: to as usize,
                units,
                min_units: 0,
            },
            _ => math::Operation::Redeem {
                from: from as usize,
                units,
                min_proceeds: 0,
            },
        };
        let result = mm(math::batch(
            &to_math(&p.classes),
            &[math::Request {
                id: "quote".into(),
                expiry: u64::MAX,
                operation,
            }],
            p.last_batch,
        ))?;
        Ok(QuoteRead {
            sequence: p.sequence,
            minted: result.receipts[0].minted,
            proceeds: result.receipts[0].proceeds,
        })
    }
    pub fn quote_request_with_fee(
        ctx: Context<ReadPool>,
        operation: u8,
        from: u8,
        to: u8,
        amount: u64,
        units: u128,
        expected_fee_version: u64,
    ) -> Result<FeeQuoteRead> {
        let p = &ctx.accounts.pool;
        require!(p.schema_version != 3, CoxError::PoolRetired);
        require!(p.initialized && operation <= 2, CoxError::InvalidRequest);
        require!(
            p.fee_version == expected_fee_version,
            CoxError::FeeVersionChanged
        );
        let operation = match operation {
            0 => math::Operation::Deposit {
                to: to as usize,
                amount,
                min_units: 0,
            },
            1 => math::Operation::Switch {
                from: from as usize,
                to: to as usize,
                units,
                min_units: 0,
            },
            _ => math::Operation::Redeem {
                from: from as usize,
                units,
                min_proceeds: 0,
            },
        };
        let result = mm(math::batch_with_fees(
            &to_math(&p.classes),
            &[math::Request {
                id: "quote".into(),
                expiry: u64::MAX,
                operation,
            }],
            p.last_batch,
            &[math::FeeTerms {
                version: p.fee_version,
                bps: p.fee_bps,
                cap: p.fee_cap,
            }],
        ))?;
        let receipt = &result.receipts[0];
        Ok(FeeQuoteRead {
            sequence: p.sequence,
            minted: receipt.minted,
            proceeds: receipt.proceeds,
            gross: receipt.gross,
            fee: receipt.fee,
            fee_version: p.fee_version,
        })
    }
    pub fn materialize_position(ctx: Context<MaterializePosition>) -> Result<()> {
        reconcile(&mut ctx.accounts.pool, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
        materialize(&mut ctx.accounts.position, &ctx.accounts.pool)?;
        extend_dynamic_position(&mut ctx.accounts.position, &ctx.accounts.pool)?;
        require_account_capacity(&ctx.accounts.position.to_account_info(), &*ctx.accounts.position)
    }
    pub fn pause(ctx: Context<Admin>) -> Result<()> {
        ctx.accounts.registry.paused = true;
        emit!(PauseChanged {
            registry: ctx.accounts.registry.key(),
            paused: true
        });
        Ok(())
    }
    pub fn unpause(ctx: Context<Admin>) -> Result<()> {
        ctx.accounts.registry.paused = false;
        emit!(PauseChanged {
            registry: ctx.accounts.registry.key(),
            paused: false
        });
        Ok(())
    }
    pub fn rotate_runtime(
        ctx: Context<Admin>,
        new_runtime: Pubkey,
        effective_batch: u64,
    ) -> Result<()> {
        require!(
            new_runtime != ctx.accounts.registry.admin
                && new_runtime != Pubkey::default()
                && effective_batch > ctx.accounts.registry.max_accepted_batch
                && ctx.accounts.registry.active_batches == 0,
            CoxError::InvalidAuthority
        );
        ctx.accounts.registry.pending_runtime = Some(new_runtime);
        ctx.accounts.registry.runtime_effective_batch = effective_batch;
        emit!(RuntimeScheduled {
            registry: ctx.accounts.registry.key(),
            key: new_runtime,
            effective_batch
        });
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ManifestConfig {
    pub version: String,
    pub roster: Vec<u8>,
    pub origin: u64,
    pub bybit: bool,
    pub feed_check_digest: [u8; 32],
}
fn initialize_pool_inner(ctx: Context<InitializePool>, pool_id: u64, trading_opens_at: Option<u64>) -> Result<()> {
        require!(ctx.accounts.methodology.sealed, CoxError::UnsealedManifest);
        if trading_opens_at.is_some() {
            read_adaptive_manifest(&ctx.accounts.methodology)?;
        } else {
            require!(ctx.accounts.methodology.schema_version == 1, CoxError::InvalidManifest);
        }
        require!(ctx.accounts.mint.decimals == 6, CoxError::InvalidCollateral);
        require!(
            pool_id == ctx.accounts.registry.next_pool_id,
            CoxError::Replay
        );
        let p = &mut ctx.accounts.pool;
        p.schema_version = if trading_opens_at.is_some() { 4 } else { 1 };
        p.trading_opens_at = trading_opens_at.unwrap_or(0);
        p.test_collateral_mint = None;
        p.bump = ctx.bumps.pool;
        p.pool_id = pool_id;
        p.registry = ctx.accounts.registry.key();
        p.methodology = ctx.accounts.methodology.key();
        p.collateral_mint = ctx.accounts.mint.key();
        p.vault = ctx.accounts.vault.key();
        p.origin = ctx.accounts.methodology.origin;
        let n = ctx.accounts.methodology.roster.len();
        p.classes = vec![Class::default(); n + 1];
        p.benchmark = 100 * math::SCALE;
        p.references = vec![100 * math::SCALE; n + 1];
        ctx.accounts.registry.next_pool_id = add(ctx.accounts.registry.next_pool_id, 1)?;
        reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
        Ok(())

}
fn publish_inner(
    ctx: Context<Publish>, batch_id: u64, sequence: u64, predecessor: [u8; 32],
    prices: Vec<PriceWire>, snapshot: [u8; 32], archive_time: u64,
    supplied_benchmark: Option<i128>,
) -> Result<()> {
        let p = &mut ctx.accounts.pool;
        reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
        require!(p.schema_version != 3, CoxError::PoolRetired);
        require!(!ctx.accounts.registry.paused, CoxError::Paused);
        require!(p.stage.is_none(), CoxError::BatchBusy);
        let previous_batch = &ctx.accounts.batch;
        if p.initialized {
            require!(
                matches!(previous_batch.schema_version, 2 | 3 | 4)
                    && previous_batch.pool == p.key()
                    && previous_batch.phase == 2
                    && previous_batch.batch_id == p.last_batch
                    && previous_batch.sequence == p.sequence,
                CoxError::InvalidAccount
            );
        } else {
            require!(previous_batch.schema_version == 0, CoxError::InvalidAccount);
        }
        let t = now()?;
        let cutoff = add(
            p.origin,
            batch_id
                .checked_mul(publication_interval(p))
                .ok_or(CoxError::ArithmeticOverflow)?,
        )?;
        require!(t >= cutoff, CoxError::TooEarly);
        let preparation = p.schema_version == 4 && !p.initialized && t < p.trading_opens_at;
        require!(preparation || t <= add(cutoff, if p.schema_version == 4 { 5 } else { 55 })?, CoxError::CommitDeadlinePassed);
        require!(
            archive_time >= cutoff && archive_time <= t && archive_time <= add(cutoff, 30)?
                && (p.schema_version != 4 || archive_time == cutoff),
            CoxError::ArchiveDeadlinePassed
        );
        require!(
            ctx.accounts.methodology.activation_batch <= batch_id,
            CoxError::UnsealedManifest
        );
        if p.initialized {
            require!(
                batch_id > p.last_batch
                    && sequence == add(p.sequence, 1)?
                    && predecessor == p.state_digest,
                CoxError::WrongPredecessor
            );
        } else {
            require!(
                batch_id == 0 && sequence == 0 && predecessor == [0; 32],
                CoxError::InvalidOrigin
            );
        }
        let r = &mut ctx.accounts.registry;
        if let Some(next) = r.pending_runtime {
            if batch_id >= r.runtime_effective_batch {
                r.runtime = next;
                r.pending_runtime = None;
            }
        }
        require_keys_eq!(
            r.runtime,
            ctx.accounts.runtime.key(),
            CoxError::Unauthorized
        );
        let m = &ctx.accounts.methodology;
        require!(prices.len() == m.roster.len(), CoxError::InvalidRoster);
        if let Some(benchmark) = supplied_benchmark {
            require!(m.schema_version == 2, CoxError::InvalidManifest);
            if !p.initialized {
                let manifest = read_adaptive_manifest(m)?;
                require!(prices.iter().map(|price| price.price_e8).eq(manifest.config.origin_prices.iter().copied()), CoxError::InvalidPrice);
            }
            let encoded = adaptive_snapshot_bytes(cutoff, benchmark, &m.roster, &prices)?;
            require!(math::artifact_digest(&encoded) == snapshot, CoxError::InvalidSnapshotDigest);
        } else {
        let full = prices
            .iter()
            .zip(&m.roster)
            .map(|(w, i)| {
                let id = IDS[*i as usize];
                require!(
                    !(w.venue == 1 && matches!(id, "TRX" | "JUP"))
                        && !(w.venue == 2 && (!m.bybit || matches!(id, "ZEC" | "TAO"))),
                    CoxError::InvalidVenueStep
                );
                Ok(math::Price {
                    asset_id: id.into(),
                    venue: w.venue,
                    step: w.step,
                    candle_start: w.candle_start,
                    price_e8: w.price_e8,
                    trade_age_minutes: w.trade_age_minutes,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let roster = m
            .roster
            .iter()
            .map(|i| IDS[*i as usize].to_string())
            .collect::<Vec<_>>();
        let computed = math::artifact_digest(
            &math::snapshot_bytes(cutoff, &full, &roster)
                .map_err(|_| error!(CoxError::InvalidPrice))?,
        );
        require!(snapshot == computed, CoxError::InvalidSnapshotDigest);
        }
        let current = prices.iter().map(|x| x.price_e8).collect::<Vec<_>>();
        let (benchmark, references, fixed, transfer_residual) = if p.initialized {
            let reference = if let Some(benchmark) = supplied_benchmark {
                adaptive_reference(p, &current, benchmark)?
            } else {
                mm(math::reference(&p.last_prices, &current, &p.origin_prices, p.benchmark))?
            };
            let revaluation = mm(math::revalue(&to_math(&p.classes), &reference.h))?;
            let mut references = reference.relative;
            references.push(100 * math::SCALE);
            (
                reference.benchmark,
                references,
                from_math(&revaluation.classes),
                revaluation.residual,
            )
        } else {
            require!(supplied_benchmark.is_none_or(|v| v == 100 * math::SCALE), CoxError::InvalidPrice);
            (
                100 * math::SCALE,
                vec![100 * math::SCALE; prices.len() + 1],
                p.classes.clone(),
                0,
            )
        };
        let b = &mut ctx.accounts.batch;
        b.schema_version = if p.schema_version >= 2 { 3 } else { 2 };
        b.bump = ctx.bumps.batch;
        b.pool = p.key();
        b.batch_id = batch_id;
        b.sequence = sequence;
        b.cutoff = cutoff;
        b.predecessor_sequence = p.sequence;
        b.predecessor_digest = p.state_digest;
        b.snapshot_digest = snapshot;
        b.prices = prices;
        b.benchmark = benchmark;
        b.references = references;
        b.fixed = fixed;
        let n = p.classes.len();
        b.burns = vec![0; n];
        b.mints = vec![0; n];
        b.incoming = vec![0; n];
        b.blocked = vec![false; n];
        b.accepted_deposits = 0;
        b.new_payable = 0;
        b.fees = 0;
        b.executed = 0;
        b.rejected = 0;
        b.phase = 0;
        b.safety_changed = false;
        b.transfer_residual = transfer_residual;
        b.closed_queue_end = p.next_request_nonce;
        b.queue_start = p.queue_start;
        b.cursor = p.queue_start;
        b.next_queue_start = p.next_request_nonce;
        b.receipt_root = mm(math::digest(
            if b.schema_version >= 3 {
                "COX/RECEIPTS/V2"
            } else {
                "COX/RECEIPTS/V1"
            },
            &[],
        ))?;
        b.staged_root = mm(math::digest("COX/STAGE/V1", &[]))?;
        b.accepted_at = t;
        r.max_accepted_batch = r.max_accepted_batch.max(batch_id);
        r.active_batches = add(r.active_batches, 1)?;
        emit!(BatchAccepted {
            pool: p.key(),
            batch: batch_id,
            snapshot
        });
        p.stage = Some(b.key());
        p.stage_batch = batch_id;
        p.stage_closed_end = b.closed_queue_end;
        require!(
            b.closed_queue_end - b.queue_start <= u32::MAX as u64,
            CoxError::CapacityExceeded
        );
        Ok(())

}
fn publication_interval(pool: &Pool) -> u64 {
    if pool.schema_version >= 4 { 1 } else { 60 }
}
pub fn adaptive_snapshot_bytes(
    timestamp: u64, benchmark: i128, roster: &[u8], prices: &[PriceWire],
) -> Result<Vec<u8>> {
    require!(benchmark > 0 && roster.len() == prices.len(), CoxError::InvalidPrice);
    require!((2..=30).contains(&roster.len()) && roster.iter().all(|id| (*id as usize) < IDS.len())
        && roster.windows(2).all(|pair| pair[0] < pair[1]), CoxError::InvalidRoster);
    let mut bytes = Vec::new();
    "COX/ADAPTIVE-SNAPSHOT/V1".to_string().serialize(&mut bytes)?;
    timestamp.serialize(&mut bytes)?;
    benchmark.serialize(&mut bytes)?;
    roster.serialize(&mut bytes)?;
    for price in prices {
        require!(price.price_e8 > 0 && price.venue == 3 && price.step == 0
            && price.candle_start == timestamp && price.trade_age_minutes == 0, CoxError::InvalidPrice);
        price.price_e8.serialize(&mut bytes)?;
    }
    Ok(bytes)
}
fn adaptive_reference(pool: &Pool, current: &[u64], benchmark: i128) -> Result<math::Reference> {
    require!(benchmark > 0 && pool.benchmark > 0 && current.len() == pool.last_prices.len()
        && current.len() == pool.origin_prices.len(), CoxError::InvalidPrice);
    let scaled = |value: i128, scale: i128, divisor: i128| -> Result<i128> {
        let product = value.checked_mul(scale).ok_or(CoxError::ArithmeticOverflow)?;
        mm(math::rounded_div(product, divisor))
    };
    let benchmark_gross = scaled(benchmark, math::SCALE, pool.benchmark)?;
    let origin_benchmark = scaled(benchmark, math::SCALE, 100 * math::SCALE)?;
    require!(benchmark_gross > 0 && origin_benchmark > 0, CoxError::InvalidPrice);
    let mut gross = Vec::with_capacity(current.len());
    let mut relative = Vec::with_capacity(current.len());
    let mut h = Vec::with_capacity(current.len() + 1);
    for ((price, previous), origin) in current.iter().zip(&pool.last_prices).zip(&pool.origin_prices) {
        require!(*price > 0 && *previous > 0 && *origin > 0, CoxError::InvalidPrice);
        let asset_gross = scaled(*price as i128, math::SCALE, *previous as i128)?;
        gross.push(asset_gross);
        h.push(scaled(asset_gross, math::SCALE, benchmark_gross)?);
        let since_origin = scaled(*price as i128, math::SCALE, *origin as i128)?;
        relative.push(scaled(100 * math::SCALE, since_origin, origin_benchmark)?);
    }
    h.push(math::SCALE);
    Ok(math::Reference { gross, benchmark_gross, benchmark, relative, h })
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct Class {
    pub backing: u64,
    pub units: u128,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct PositionClass {
    pub units: u128,
    pub locked: u128,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PriceWire {
    pub price_e8: u64,
    pub venue: u8,
    pub step: u8,
    pub candle_start: u64,
    pub trade_age_minutes: u16,
}
#[account]
pub struct Registry {
    pub schema_version: u16,
    pub bump: u8,
    pub admin: Pubkey,
    pub runtime: Pubkey,
    pub pending_runtime: Option<Pubkey>,
    pub runtime_effective_batch: u64,
    pub paused: bool,
    pub next_pool_id: u64,
    pub max_accepted_batch: u64,
    pub active_batches: u64,
}
#[account]
pub struct Methodology {
    pub schema_version: u16,
    pub bump: u8,
    pub digest: [u8; 32],
    pub canonical: Vec<u8>,
    pub sealed: bool,
    pub activation_batch: u64,
    pub expected_length: u32,
    pub roster: Vec<u8>,
    pub origin: u64,
    pub bybit: bool,
}
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct LegacyPool {
    pub schema_version: u16,
    pub bump: u8,
    pub pool_id: u64,
    pub registry: Pubkey,
    pub methodology: Pubkey,
    pub collateral_mint: Pubkey,
    pub vault: Pubkey,
    pub origin: u64,
    pub last_batch: u64,
    pub sequence: u64,
    pub state_digest: [u8; 32],
    pub benchmark: i128,
    pub origin_prices: Vec<u64>,
    pub last_prices: Vec<u64>,
    pub references: Vec<i128>,
    pub classes: Vec<Class>,
    pub active: u64,
    pub pending: u64,
    pub payable: u64,
    pub residual: u64,
    pub next_request_nonce: u64,
    pub stage: Option<Pubkey>,
    pub initialized: bool,
    pub queue_start: u64,
    pub stage_batch: u64,
    pub stage_closed_end: u64,
}
#[account]
pub struct Pool {
    pub schema_version: u16,
    pub bump: u8,
    pub pool_id: u64,
    pub registry: Pubkey,
    pub methodology: Pubkey,
    pub collateral_mint: Pubkey,
    pub vault: Pubkey,
    pub origin: u64,
    pub last_batch: u64,
    pub sequence: u64,
    pub state_digest: [u8; 32],
    pub benchmark: i128,
    pub origin_prices: Vec<u64>,
    pub last_prices: Vec<u64>,
    pub references: Vec<i128>,
    pub classes: Vec<Class>,
    pub active: u64,
    pub pending: u64,
    pub payable: u64,
    pub residual: u64,
    pub next_request_nonce: u64,
    pub stage: Option<Pubkey>,
    pub initialized: bool,
    pub queue_start: u64,
    pub stage_batch: u64,
    pub stage_closed_end: u64,
    pub fee_version: u64,
    pub fee_bps: u16,
    pub fee_cap: u64,
    pub fees: u64,
    pub fee_next_version: u64,
    pub fee_pending: bool,
    pub fee_pending_version: u64,
    pub fee_pending_bps: u16,
    pub fee_pending_cap: u64,
    pub fee_pending_cutoff: u64,
    pub fee_initial_scheduled: bool,
    pub trading_opens_at: u64,
    pub test_collateral_mint: Option<Pubkey>,
}
#[account]
pub struct Position {
    pub schema_version: u16,
    pub bump: u8,
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub applied_sequence: u64,
    pub classes: Vec<PositionClass>,
    pub payable: u64,
    pub refundable: u64,
    pub staged: bool,
    pub staged_sequence: u64,
    pub staged_burns: Vec<u128>,
    pub staged_mints: Vec<u128>,
    pub staged_unlocks: Vec<u128>,
    pub staged_payable: u64,
    pub staged_refundable: u64,
}
#[account]
pub struct Request {
    pub schema_version: u16,
    pub bump: u8,
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub nonce: u64,
    pub target_batch: u64,
    pub expiry_batch: u64,
    pub operation: u8,
    pub from: u8,
    pub to: u8,
    pub amount: u64,
    pub units: u128,
    pub minimum_units: u128,
    pub minimum_proceeds: u64,
    pub status: u8,
    pub eligible_batch: u64,
    pub evaluated: bool,
    pub bound_batch: u64,
    pub bound_sequence: u64,
    pub receipt_status: u8,
    pub minted: u128,
    pub proceeds: u64,
    pub applied: bool,
    pub fee_version: u64,
    pub fee_bps: u16,
    pub fee_cap: u64,
    pub gross: u64,
    pub fee: u64,
    pub refunded_amount: u64,
    pub from_id: u16,
    pub to_id: u16,
}
#[account]
pub struct Batch {
    pub schema_version: u16,
    pub bump: u8,
    pub pool: Pubkey,
    pub batch_id: u64,
    pub sequence: u64,
    pub cutoff: u64,
    pub predecessor_sequence: u64,
    pub predecessor_digest: [u8; 32],
    pub snapshot_digest: [u8; 32],
    pub prices: Vec<PriceWire>,
    pub benchmark: i128,
    pub references: Vec<i128>,
    pub fixed: Vec<Class>,
    pub burns: Vec<u128>,
    pub mints: Vec<u128>,
    pub incoming: Vec<u128>,
    pub blocked: Vec<bool>,
    pub accepted_deposits: u64,
    pub new_payable: u64,
    pub transfer_residual: u64,
    pub executed: u32,
    pub rejected: u32,
    pub closed_queue_end: u64,
    pub queue_start: u64,
    pub cursor: u64,
    pub next_queue_start: u64,
    pub staged_root: [u8; 32],
    pub receipt_root: [u8; 32],
    pub accepted_at: u64,
    pub phase: u8,
    pub safety_changed: bool,
    pub fees: u64,
}
#[account]
pub struct Publication {
    pub schema_version: u16,
    pub bump: u8,
    pub pool: Pubkey,
    pub sequence: u64,
    pub batch: u64,
    pub state_digest: [u8; 32],
    pub snapshot_digest: [u8; 32],
    pub manifest_digest: [u8; 32],
    pub state_preimage: Vec<u8>,
    pub prices: Vec<PriceWire>,
    pub committed_at: u64,
}

#[derive(Accounts)]
pub struct InitializeRegistry<'info> {
    pub upgrade_authority: Signer<'info>,
    #[account(executable,address=crate::ID,owner=anchor_lang::solana_program::bpf_loader_upgradeable::ID)]
    pub program_account: UncheckedAccount<'info>,
    #[account(seeds=[crate::ID.as_ref()],bump,seeds::program=anchor_lang::solana_program::bpf_loader_upgradeable::ID)]
    pub program_data: Account<'info, ProgramData>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init,payer=admin,space=160,seeds=[b"registry"],bump)]
    pub registry: Account<'info, Registry>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(digest:[u8;32])]
pub struct RegisterMethodology<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=admin)]
    pub registry: Account<'info, Registry>,
    #[account(init,payer=admin,space=MANIFEST_LIMIT+160,seeds=[b"methodology",digest.as_ref()],bump)]
    pub methodology: Account<'info, Methodology>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct ManageMethodology<'info> {
    pub admin: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=admin)]
    pub registry: Account<'info, Registry>,
    #[account(mut,seeds=[b"methodology",methodology.digest.as_ref()],bump=methodology.bump)]
    pub methodology: Account<'info, Methodology>,
}
#[derive(Accounts)]
#[instruction(pool_id:u64)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut,seeds=[b"registry"],bump=registry.bump,has_one=admin)]
    pub registry: Account<'info, Registry>,
    #[account(seeds=[b"methodology",methodology.digest.as_ref()],bump=methodology.bump)]
    pub methodology: Account<'info, Methodology>,
    #[account(init,payer=admin,space=4096,seeds=[b"pool",pool_id.to_le_bytes().as_ref()],bump)]
    pub pool: Account<'info, Pool>,
    pub mint: Account<'info, Mint>,
    #[account(init,payer=admin,seeds=[b"vault",pool.key().as_ref()],bump,token::mint=mint,token::authority=pool)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub test_vault: Option<Account<'info, TokenAccount>>,
}
#[derive(Accounts)]
pub struct InitializeDevnetCollateral<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=admin)]
    pub registry: Account<'info, Registry>,
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=vault)]
    pub pool: Account<'info, Pool>,
    pub test_mint: Account<'info, Mint>,
    #[account(token::authority=pool,token::mint=pool.collateral_mint)]
    pub vault: Account<'info, TokenAccount>,
    #[account(init,payer=admin,seeds=[b"test-vault",pool.key().as_ref()],bump,token::mint=test_mint,token::authority=pool)]
    pub test_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Submit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=vault)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(init_if_needed,payer=owner,space=if pool.schema_version == 5 { dynamic_position_space(pool.classes.len()) } else { 4096 },seeds=[b"position",pool.key().as_ref(),owner.key().as_ref()],bump)]
    pub position: Account<'info, Position>,
    #[account(init,payer=owner,space=320,seeds=[b"request",pool.key().as_ref(),pool.next_request_nonce.to_le_bytes().as_ref()],bump)]
    pub request: Account<'info, Request>,
    #[account(mut,token::authority=pool,token::mint=pool.collateral_mint)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut,token::authority=owner,constraint=user_token.mint==pool.collateral_mint || pool.test_collateral_mint==Some(user_token.mint) @ CoxError::InvalidCollateral)]
    pub user_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    #[account(mut)]
    pub test_vault: Option<Account<'info, TokenAccount>>,
}
#[derive(Accounts)]
pub struct MigratePool<'info> {
    pub admin: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=admin)]
    pub registry: Account<'info, Registry>,
    #[account(mut,owner=crate::ID)]
    pub pool: UncheckedAccount<'info>,
    #[account(token::authority=pool)]
    pub vault: Account<'info, TokenAccount>,
    pub test_vault: Option<Account<'info, TokenAccount>>,
}
#[account]
pub struct Retirement {
    pub schema_version: u16,
    pub bump: u8,
    pub pool: Pubkey,
    pub sequence: u64,
    pub state_digest: [u8; 32],
    pub classes: Vec<Class>,
}
#[derive(Accounts)]
pub struct BeginRetirement<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=admin)]
    pub registry: Account<'info, Registry>,
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=vault)]
    pub pool: Account<'info, Pool>,
    #[account(init,payer=admin,space=4096,seeds=[b"retirement",pool.key().as_ref()],bump)]
    pub retirement: Account<'info, Retirement>,
    #[account(token::authority=pool,token::mint=pool.collateral_mint)]
    pub vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub test_vault: Option<Account<'info, TokenAccount>>,
}
#[derive(Accounts)]
pub struct RetirePosition<'info> {
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=vault)]
    pub pool: Account<'info, Pool>,
    #[account(seeds=[b"retirement",pool.key().as_ref()],bump=retirement.bump,has_one=pool,constraint=retirement.schema_version==1 @ CoxError::InvalidAccount)]
    pub retirement: Account<'info, Retirement>,
    #[account(mut,seeds=[b"position",pool.key().as_ref(),position.owner.as_ref()],bump=position.bump,has_one=pool)]
    pub position: Account<'info, Position>,
    #[account(token::authority=pool,token::mint=pool.collateral_mint)]
    pub vault: Account<'info, TokenAccount>,
    pub test_vault: Option<Account<'info, TokenAccount>>,
}
#[derive(Accounts)]
pub struct RetirementPayout<'info> {
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=vault)]
    pub pool: Account<'info, Pool>,
    #[account(mut,seeds=[b"position",pool.key().as_ref(),position.owner.as_ref()],bump=position.bump,has_one=pool)]
    pub position: Account<'info, Position>,
    #[account(mut,token::authority=pool,token::mint=pool.collateral_mint)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut,token::authority=position.owner,token::mint=pool.collateral_mint)]
    pub user_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    #[account(mut)]
    pub test_vault: Option<Account<'info, TokenAccount>>,
}
#[derive(Accounts)]
pub struct ManageFees<'info> {
    pub admin: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=admin)]
    pub registry: Account<'info, Registry>,
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=vault)]
    pub pool: Account<'info, Pool>,
    #[account(token::authority=pool,token::mint=pool.collateral_mint)]
    pub vault: Account<'info, TokenAccount>,
}
#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    pub admin: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=admin)]
    pub registry: Account<'info, Registry>,
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=vault)]
    pub pool: Account<'info, Pool>,
    #[account(mut,token::authority=pool,token::mint=pool.collateral_mint)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut,token::authority=admin,constraint=treasury_token.mint==pool.collateral_mint || pool.test_collateral_mint==Some(treasury_token.mint) @ CoxError::InvalidCollateral)]
    pub treasury_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    #[account(mut)]
    pub test_vault: Option<Account<'info, TokenAccount>>,
}
#[derive(Accounts)]
pub struct ManageRequest<'info> {
    pub authority: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=vault)]
    pub pool: Account<'info, Pool>,
    #[account(mut,seeds=[b"request",pool.key().as_ref(),request.nonce.to_le_bytes().as_ref()],bump=request.bump,has_one=pool)]
    pub request: Account<'info, Request>,
    #[account(mut,seeds=[b"position",pool.key().as_ref(),request.owner.as_ref()],bump=position.bump,has_one=pool,constraint=position.owner==request.owner @ CoxError::InvalidAccount)]
    pub position: Account<'info, Position>,
    #[account(token::authority=pool,token::mint=pool.collateral_mint)]
    pub vault: Account<'info, TokenAccount>,
    pub test_vault: Option<Account<'info, TokenAccount>>,
}
#[derive(Accounts)]
pub struct Refund<'info> {
    pub owner: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=vault)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut,seeds=[b"request",pool.key().as_ref(),request.nonce.to_le_bytes().as_ref()],bump=request.bump,has_one=pool,has_one=owner)]
    pub request: Account<'info, Request>,
    #[account(mut,seeds=[b"position",pool.key().as_ref(),owner.key().as_ref()],bump=position.bump,has_one=pool,has_one=owner)]
    pub position: Account<'info, Position>,
    #[account(mut,token::authority=pool,token::mint=pool.collateral_mint)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut,token::authority=owner,constraint=user_token.mint==pool.collateral_mint || pool.test_collateral_mint==Some(user_token.mint) @ CoxError::InvalidCollateral)]
    pub user_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    #[account(mut)]
    pub test_vault: Option<Account<'info, TokenAccount>>,
}
#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=vault)]
    pub pool: Account<'info, Pool>,
    #[account(mut,seeds=[b"position",pool.key().as_ref(),owner.key().as_ref()],bump=position.bump,has_one=pool,has_one=owner)]
    pub position: Account<'info, Position>,
    #[account(mut,token::authority=pool,token::mint=pool.collateral_mint)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut,token::authority=owner,constraint=user_token.mint==pool.collateral_mint || pool.test_collateral_mint==Some(user_token.mint) @ CoxError::InvalidCollateral)]
    pub user_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    #[account(mut)]
    pub test_vault: Option<Account<'info, TokenAccount>>,
}
#[derive(Accounts)]
#[instruction(batch_id:u64)]
pub struct Publish<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub runtime: Signer<'info>,
    #[account(mut,seeds=[b"registry"],bump=registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=vault,has_one=methodology)]
    pub pool: Account<'info, Pool>,
    #[account(seeds=[b"methodology",methodology.digest.as_ref()],bump=methodology.bump)]
    pub methodology: Account<'info, Methodology>,
    #[account(init_if_needed,payer=payer,space=if pool.schema_version == 5 { dynamic_batch_space(pool.classes.len()) } else { 8192 },seeds=[b"batch",pool.key().as_ref()],bump)]
    pub batch: Account<'info, Batch>,
    #[account(token::authority=pool,token::mint=pool.collateral_mint)]
    pub vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub test_vault: Option<Account<'info, TokenAccount>>,
}
#[derive(Accounts)]
pub struct Process<'info> {
    #[account(seeds=[b"registry"],bump=registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=vault,constraint=pool.stage==Some(batch.key()) @ CoxError::BatchBusy)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut,seeds=[b"batch",pool.key().as_ref()],bump=batch.bump,has_one=pool,constraint=matches!(batch.schema_version, 2 | 3 | 4) @ CoxError::InvalidAccount)]
    pub batch: Box<Account<'info, Batch>>,
    #[account(mut,seeds=[b"request",pool.key().as_ref(),request.nonce.to_le_bytes().as_ref()],bump=request.bump,has_one=pool)]
    pub request: Account<'info, Request>,
    #[account(mut,seeds=[b"position",pool.key().as_ref(),request.owner.as_ref()],bump=position.bump,has_one=pool)]
    pub position: Box<Account<'info, Position>>,
    #[account(token::authority=pool,token::mint=pool.collateral_mint)]
    pub vault: Account<'info, TokenAccount>,
    pub test_vault: Option<Account<'info, TokenAccount>>,
}
#[derive(Accounts)]
pub struct BatchOnly<'info> {
    #[account(seeds=[b"registry"],bump=registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=vault,constraint=pool.stage==Some(batch.key()) @ CoxError::BatchBusy)]
    pub pool: Account<'info, Pool>,
    #[account(mut,seeds=[b"batch",pool.key().as_ref()],bump=batch.bump,has_one=pool,constraint=matches!(batch.schema_version, 2 | 3 | 4) @ CoxError::InvalidAccount)]
    pub batch: Account<'info, Batch>,
    #[account(token::authority=pool,token::mint=pool.collateral_mint)]
    pub vault: Account<'info, TokenAccount>,
    pub test_vault: Option<Account<'info, TokenAccount>>,
}
#[derive(Accounts)]
pub struct Finalize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut,seeds=[b"registry"],bump=registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=vault,has_one=methodology,constraint=pool.stage==Some(batch.key()) @ CoxError::BatchBusy)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut,seeds=[b"batch",pool.key().as_ref()],bump=batch.bump,has_one=pool,constraint=matches!(batch.schema_version, 2 | 3 | 4) @ CoxError::InvalidAccount)]
    pub batch: Box<Account<'info, Batch>>,
    #[account(seeds=[b"methodology",methodology.digest.as_ref()],bump=methodology.bump)]
    pub methodology: Account<'info, Methodology>,
    #[account(init_if_needed,payer=payer,space=if pool.schema_version == 5 { dynamic_batch_space(pool.classes.len()) } else { 8192 },seeds=[b"publication",pool.key().as_ref()],bump)]
    pub publication: Box<Account<'info, Publication>>,
    #[account(token::authority=pool,token::mint=pool.collateral_mint)]
    pub vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub test_vault: Option<Account<'info, TokenAccount>>,
}
#[derive(Accounts)]
pub struct MaterializePosition<'info> {
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=vault)]
    pub pool: Account<'info, Pool>,
    #[account(mut,seeds=[b"position",pool.key().as_ref(),position.owner.as_ref()],bump=position.bump,has_one=pool)]
    pub position: Account<'info, Position>,
    #[account(token::authority=pool,token::mint=pool.collateral_mint)]
    pub vault: Account<'info, TokenAccount>,
    pub test_vault: Option<Account<'info, TokenAccount>>,
}
#[derive(Accounts)]
pub struct Admin<'info> {
    pub admin: Signer<'info>,
    #[account(mut,seeds=[b"registry"],bump=registry.bump,has_one=admin)]
    pub registry: Account<'info, Registry>,
}

pub fn canonical_manifest(c: &ManifestConfig, runtime: Pubkey) -> Result<Vec<u8>> {
    require!(
        !c.version.is_empty()
            && c.version.len() <= 64
            && c.version
                .bytes()
                .all(|x| x.is_ascii_alphanumeric() || matches!(x, b'.' | b'_' | b'-')),
        CoxError::InvalidManifest
    );
    require!(
        (2..=30).contains(&c.roster.len())
            && c.roster.iter().all(|i| (*i as usize) < IDS.len())
            && c.roster.windows(2).all(|w| w[0] < w[1]),
        CoxError::InvalidRoster
    );
    require!(
        c.origin > 0 && c.origin % 60 == 0 && c.feed_check_digest != [0; 32],
        CoxError::InvalidOrigin
    );
    let feed = c
        .feed_check_digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let assets = c
        .roster
        .iter()
        .map(|i| {
            let id = IDS[*i as usize];
            let rest = match id {
                "BTC" => "XXBTZUSD".into(),
                "ETH" => "XETHZUSD".into(),
                "XRP" => "XXRPZUSD".into(),
                "ZEC" => "XZECZUSD".into(),
                _ => format!("{id}USD"),
            };
            json!([
                id,
                format!("{id}/USD"),
                rest,
                if matches!(id, "TRX" | "JUP") {
                    None
                } else {
                    Some(format!("{id}-USD"))
                },
                if matches!(id, "ZEC" | "TAO") {
                    None
                } else {
                    Some(format!("{id}USDT"))
                },
                "1",
                c.roster.len().to_string()
            ])
        })
        .collect::<Vec<_>>();
    serde_json::to_vec(&json!([
        "COX/METHODOLOGY/V1",
        c.version,
        "sealed",
        feed,
        assets,
        ["USD", "100000000"],
        ["COMMON_ORIGIN_SNAPSHOT", c.origin, "100000000000000"],
        [
            "UTC_CLOSED_MINUTE",
            60,
            "COX/PRICE-FALLBACK/V1",
            c.bybit,
            ["USDT/USD", "USDTZUSD", "USDT-USD"],
            "COX/USDT-USD/V1",
            "HALF_AWAY",
            30
        ],
        [
            60,
            30,
            55,
            "SNAPSHOT_ACCEPTANCE_ONLY",
            "NO_FILL_DEADLINE",
            60,
            "EXECUTION_CAPACITY_TARGET_SECONDS",
            3,
            60,
            "REBALANCE_FREEZE"
        ],
        ["solana-devnet", "oracle-operator", runtime.to_string()],
        ["COX/TRANSFER/MVP-0", "TEST_COLLATERAL_ONLY", "0"],
        [
            "1000000000000",
            "i128-checked",
            "HALF_AWAY",
            "u64",
            "u128",
            "1000000000000",
            "FLOOR_USER",
            "FLOOR_AGGREGATE_CLASS",
            "POOL_RESIDUAL_NO_DISTRIBUTION"
        ],
        ["COX/ACCOUNTING/V1", "COX/BATCH/ASYNC/V1", "COX/WIRE/V1"]
    ]))
    .map_err(|_| error!(CoxError::InvalidManifest))
}
fn now() -> Result<u64> {
    u64::try_from(Clock::get()?.unix_timestamp).map_err(|_| error!(CoxError::InvalidOrigin))
}
fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .ok_or_else(|| error!(CoxError::ArithmeticOverflow))
}
fn sub(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b)
        .ok_or_else(|| error!(CoxError::ArithmeticOverflow))
}
fn addu(a: u128, b: u128) -> Result<u128> {
    a.checked_add(b)
        .ok_or_else(|| error!(CoxError::ArithmeticOverflow))
}
fn mm<T>(r: math::Result<T>) -> Result<T> {
    r.map_err(|_| error!(CoxError::ArithmeticOverflow))
}
fn total(c: &[Class]) -> Result<u64> {
    c.iter().try_fold(0, |a, c| add(a, c.backing))
}
fn to_math(c: &[Class]) -> Vec<math::Class> {
    c.iter()
        .map(|c| math::Class {
            backing: c.backing,
            units: c.units,
        })
        .collect()
}
fn from_math(c: &[math::Class]) -> Vec<Class> {
    c.iter()
        .map(|c| Class {
            backing: c.backing,
            units: c.units,
        })
        .collect()
}
fn halted(p: &Pool, t: u64) -> Result<bool> {
    Ok(p.schema_version < 4 && p.initialized
        && t.saturating_sub(add(
            p.origin,
            p.last_batch
                .checked_mul(publication_interval(p))
                .ok_or(CoxError::ArithmeticOverflow)?,
        )?) >= 3600)
}
fn fee_terms(r: &Request) -> math::FeeTerms {
    if r.schema_version == 1 {
        math::FeeTerms::default()
    } else {
        math::FeeTerms {
            version: r.fee_version,
            bps: r.fee_bps,
            cap: r.fee_cap,
        }
    }
}
fn refund_inner(ctx: Context<Refund>, amount: Option<u64>) -> Result<()> {
    let p = &mut ctx.accounts.pool;
    reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
    materialize(&mut ctx.accounts.position, p)?;
    let r = &mut ctx.accounts.request;
    refresh_request(r, p);
    require!(r.operation == 0 && matches!(r.status, 2 | 3 | 4 | 5 | 7), CoxError::NotRefundable);
    let remaining = sub(r.amount, r.refunded_amount)?;
    let value = amount.unwrap_or(remaining);
    require!(value > 0 && value <= remaining && ctx.accounts.position.refundable >= value, CoxError::NotRefundable);
    ctx.accounts.position.refundable = sub(ctx.accounts.position.refundable, value)?;
    p.pending = sub(p.pending, value)?;
    r.refunded_amount = add(r.refunded_amount, value)?;
    if r.refunded_amount == r.amount { r.status = 6; }
    transfer_out_collateral(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref(), &ctx.accounts.user_token, &ctx.accounts.token_program, value)?;
    emit!(DepositRefunded { pool: p.key(), request: r.key(), amount: value });
    ctx.accounts.vault.reload()?;
    if let Some(vault) = ctx.accounts.test_vault.as_mut() { vault.reload()?; }
    reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())
}
fn selected_vault<'a, 'info>(p: &Pool, vault: &'a Account<'info, TokenAccount>, test: Option<&'a Account<'info, TokenAccount>>, mint: Pubkey) -> Result<&'a Account<'info, TokenAccount>> {
    if mint == p.collateral_mint { return Ok(vault); }
    require!(cfg!(feature = "devnet-collateral") && p.schema_version >= 4 && p.test_collateral_mint == Some(mint), CoxError::InvalidCollateral);
    test.ok_or_else(|| error!(CoxError::MissingCollateralVault))
}
fn transfer_out_collateral<'info>(p: &Account<'info, Pool>, vault: &Account<'info, TokenAccount>, test: Option<&Account<'info, TokenAccount>>, destination: &Account<'info, TokenAccount>, program: &Program<'info, Token>, amount: u64) -> Result<()> {
    let selected = selected_vault(p, vault, test, destination.mint)?;
    require!(selected.amount >= amount, CoxError::CollateralLiquidity);
    transfer_out(p, selected, destination, program, amount)
}
fn vault_total(p: &Pool, v: &Account<TokenAccount>, test: Option<&Account<TokenAccount>>) -> Result<u64> {
    let pool = Pubkey::create_program_address(&[b"pool", &p.pool_id.to_le_bytes(), &[p.bump]], &crate::ID)
        .map_err(|_| error!(CoxError::InvalidAccount))?;
    require_keys_eq!(v.key(), p.vault, CoxError::InvalidCollateral);
    validate_collateral_vault(v, pool, p.collateral_mint)?;
    match p.test_collateral_mint {
        None => { require!(test.is_none(), CoxError::InvalidCollateral); Ok(v.amount) },
        Some(mint) => {
            require!(cfg!(feature = "devnet-collateral"), CoxError::DualCollateralDisabled);
            require!(p.schema_version >= 4 && mint != p.collateral_mint, CoxError::InvalidCollateral);
            let test = test.ok_or(CoxError::MissingCollateralVault)?;
            require_keys_eq!(test.key(), Pubkey::find_program_address(&[b"test-vault", pool.as_ref()], &crate::ID).0, CoxError::InvalidCollateral);
            require!(test.key() != v.key(), CoxError::InvalidCollateral);
            validate_collateral_vault(test, pool, mint)?;
            add(v.amount, test.amount)
        }
    }
}
fn validate_collateral_vault(v: &Account<TokenAccount>, authority: Pubkey, mint: Pubkey) -> Result<()> {
    require_keys_eq!(v.owner, authority, CoxError::InvalidCollateral);
    require_keys_eq!(v.mint, mint, CoxError::InvalidCollateral);
    require!(v.state == anchor_spl::token::spl_token::state::AccountState::Initialized
        && v.delegate == COption::None && v.close_authority == COption::None && v.is_native == COption::None,
        CoxError::InvalidCollateral);
    Ok(())
}
fn reconcile(p: &mut Pool, v: &Account<TokenAccount>, test: Option<&Account<TokenAccount>>) -> Result<()> {
    require!(matches!(p.schema_version, 1 | 2 | 3 | 4 | 5), CoxError::InvalidAccount);
    require!(
        p.schema_version >= 2 || (p.fees == 0 && p.fee_version == 0 && !p.fee_pending),
        CoxError::InvalidAccount
    );
    let expected = add(
        add(add(p.active, p.pending)?, add(p.payable, p.residual)?)?,
        p.fees,
    )?;
    let actual = vault_total(p, v, test)?;
    require!(actual >= expected, CoxError::VaultMismatch);
    p.residual = add(p.residual, actual - expected)?;
    require!(p.active == total(&p.classes)?, CoxError::VaultMismatch);
    Ok(())
}
fn materialize(position: &mut Position, p: &Pool) -> Result<()> {
    if !position.staged {
        return Ok(());
    }
    if !p.initialized || position.staged_sequence > p.sequence {
        return Ok(());
    }
    if p.stage.is_some() && position.staged_sequence == p.sequence + 1 {
        return Ok(());
    }
    for i in 0..position.classes.len() {
        let c = &mut position.classes[i];
        c.units = addu(
            c.units
                .checked_sub(position.staged_burns[i])
                .ok_or(CoxError::ArithmeticOverflow)?,
            position.staged_mints[i],
        )?;
        c.locked = c
            .locked
            .checked_sub(position.staged_unlocks[i])
            .ok_or(CoxError::ArithmeticOverflow)?;
        require!(c.locked <= c.units, CoxError::InsufficientUnlockedUnits);
    }
    position.payable = add(position.payable, position.staged_payable)?;
    position.refundable = add(position.refundable, position.staged_refundable)?;
    position.applied_sequence = position.staged_sequence;
    position.staged = false;
    position.staged_payable = 0;
    position.staged_refundable = 0;
    position.staged_burns.clear();
    position.staged_mints.clear();
    position.staged_unlocks.clear();
    Ok(())
}
fn refresh_request(r: &mut Request, p: &Pool) {
    if r.status == 0 && r.applied && p.initialized && r.bound_sequence <= p.sequence {
        r.status = match r.receipt_status {
            0 => 1,
            1 => 2,
            2 => 3,
            3 => 4,
            _ => 7,
        };
    }
}
fn request_from(r: &Request) -> u16 { if r.schema_version == 3 { r.from_id } else if r.from == 255 { u16::MAX } else { u16::from(r.from) } }
fn request_to(r: &Request) -> u16 { if r.schema_version == 3 { r.to_id } else if r.to == 255 { u16::MAX } else { u16::from(r.to) } }
fn operation(r: &Request) -> math::Operation {
    match r.operation {
        0 => math::Operation::Deposit {
            to: request_to(r) as usize,
            amount: r.amount,
            min_units: r.minimum_units,
        },
        1 => math::Operation::Switch {
            from: request_from(r) as usize,
            to: request_to(r) as usize,
            units: r.units,
            min_units: r.minimum_units,
        },
        _ => math::Operation::Redeem {
            from: request_from(r) as usize,
            units: r.units,
            min_proceeds: r.minimum_proceeds,
        },
    }
}
struct Submission {
    op: u8,
    from: u16,
    to: u16,
    amount: u64,
    units: u128,
    min_units: u128,
    min_proceeds: u64,
    expiry: u64,
}
fn submit(ctx: Context<Submit>, submission: Submission) -> Result<()> {
    let Submission {
        op,
        from,
        to,
        amount,
        units,
        min_units,
        min_proceeds,
        expiry,
    } = submission;
    let p = &mut ctx.accounts.pool;
    reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
    let t = now()?;
    require!(p.schema_version != 3, CoxError::PoolRetired);
    require!(p.initialized, CoxError::InvalidOrigin);
    require!(p.schema_version < 4 || t >= p.trading_opens_at, CoxError::TooEarly);
    require!(!ctx.accounts.registry.paused, CoxError::Paused);
    require!(!halted(p, t)?, CoxError::Halted);
    let n = p.classes.len();
    require!(
        (from == u16::MAX || (from as usize) < n) && (to == u16::MAX || (to as usize) < n) && from != to,
        CoxError::InvalidRequest
    );
    require!(
        (op == 0 && amount > 0 && from == u16::MAX && to != u16::MAX) || (op == 1 && from != u16::MAX && to != u16::MAX && units > 0 && units <= UNIT_LIMIT) || (op == 2 && from != u16::MAX && to == u16::MAX && units > 0 && units <= UNIT_LIMIT),
        CoxError::InvalidRequest
    );
    let target = add(
        t.checked_sub(p.origin).ok_or(CoxError::InvalidOrigin)? / publication_interval(p),
        1,
    )?
    .max(add(p.last_batch, 1)?);
    let target = if p.stage.is_some() || p.schema_version == 5 {
        target.max(add(p.stage_batch, 1)?)
    } else {
        target
    };
    require!(expiry >= target, CoxError::InvalidExpiry);
    let pos = &mut ctx.accounts.position;
    if pos.schema_version == 0 {
        pos.schema_version = 1;
        pos.bump = ctx.bumps.position;
        pos.pool = p.key();
        pos.owner = ctx.accounts.owner.key();
        pos.classes = vec![PositionClass::default(); n];
    }
    require_keys_eq!(pos.owner, ctx.accounts.owner.key(), CoxError::Unauthorized);
    materialize(pos, p)?;
    extend_dynamic_position(pos, p)?;
    if op == 0 {
        require!(
            add(add(p.active, p.pending)?, amount)? <= COLLATERAL_LIMIT,
            CoxError::CapacityExceeded
        );
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token.to_account_info(),
                    to: selected_vault(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref(), ctx.accounts.user_token.mint)?.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;
        p.pending = add(p.pending, amount)?;
    } else {
        let c = &mut pos.classes[from as usize];
        require!(
            c.units
                .checked_sub(c.locked)
                .is_some_and(|free| free >= units),
            CoxError::InsufficientUnlockedUnits
        );
        c.locked = addu(c.locked, units)?;
    }
    let r = &mut ctx.accounts.request;
    r.schema_version = if p.schema_version == 5 { 3 } else { p.schema_version };
    r.refunded_amount = 0;
    r.bump = ctx.bumps.request;
    r.pool = p.key();
    r.owner = ctx.accounts.owner.key();
    r.nonce = p.next_request_nonce;
    r.target_batch = target;
    r.eligible_batch = target;
    r.expiry_batch = expiry;
    r.operation = op;
    r.from = u8::try_from(from).unwrap_or(255);
    r.to = u8::try_from(to).unwrap_or(255);
    r.from_id = from;
    r.to_id = to;
    r.amount = amount;
    r.units = units;
    r.minimum_units = min_units;
    r.minimum_proceeds = min_proceeds;
    r.fee_version = p.fee_version;
    r.fee_bps = p.fee_bps;
    r.fee_cap = p.fee_cap;
    emit!(RequestQueued {
        pool: p.key(),
        request: r.key(),
        owner: r.owner,
        target_batch: target,
        expiry,
        operation: op
    });
    p.next_request_nonce = add(p.next_request_nonce, 1)?;
    ctx.accounts.vault.reload()?;
        if let Some(vault) = ctx.accounts.test_vault.as_mut() { vault.reload()?; }
    reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
    require_account_capacity(&pos.to_account_info(), &**pos)?;
    Ok(())
}
fn release_request(ctx: Context<ManageRequest>, expire: bool) -> Result<()> {
    let p = &mut ctx.accounts.pool;
    reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())?;
    let t = now()?;
    let r = &mut ctx.accounts.request;
    refresh_request(r, p);
    require!(r.status == 0, CoxError::AlreadyProcessed);
    require!(
        !r.evaluated || r.bound_sequence <= p.sequence,
        CoxError::CancellationClosed
    );
    if p.stage.is_some() {
        require!(
            r.nonce >= p.stage_closed_end || r.target_batch > p.stage_batch,
            CoxError::CancellationClosed
        );
    }
    let current = t.saturating_sub(p.origin) / publication_interval(p);
    if expire {
        require!(current > r.expiry_batch, CoxError::InvalidExpiry);
    } else {
        let rolled = if p.last_batch >= r.target_batch {
            add(p.last_batch, 1)?
        } else {
            r.target_batch
        };
        let cutoff = add(
            p.origin,
            rolled.checked_mul(publication_interval(p)).ok_or(CoxError::ArithmeticOverflow)?,
        )?;
        require!(
            p.schema_version == 3 || t < cutoff || halted(p, t)? || ctx.accounts.registry.paused,
            CoxError::CancellationClosed
        );
    }
    materialize(&mut ctx.accounts.position, p)?;
    if r.operation == 0 {
        ctx.accounts.position.refundable = add(ctx.accounts.position.refundable, r.amount)?;
    } else {
        let c = &mut ctx.accounts.position.classes[request_from(r) as usize];
        c.locked = c
            .locked
            .checked_sub(r.units)
            .ok_or(CoxError::ArithmeticOverflow)?;
    }
    r.status = if expire { 3 } else { 5 };
    if expire {
        emit!(RequestRejected {
            pool: p.key(),
            request: r.key(),
            status: 3
        });
    } else {
        emit!(RequestCancelled {
            pool: p.key(),
            request: r.key()
        });
    }
    Ok(())
}
fn transfer_out<'info>(
    p: &Account<'info, Pool>,
    vault: &Account<'info, TokenAccount>,
    destination: &Account<'info, TokenAccount>,
    program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    let id = p.pool_id.to_le_bytes();
    let bump = [p.bump];
    let seeds: &[&[u8]] = &[b"pool", &id, &bump];
    token::transfer(
        CpiContext::new_with_signer(
            program.to_account_info(),
            Transfer {
                from: vault.to_account_info(),
                to: destination.to_account_info(),
                authority: p.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}
pub fn state_bytes(
    program: &Pubkey,
    pool: &Pubkey,
    p: &Pool,
    before: &[Class],
    b: &Batch,
    manifest: &[u8; 32],
) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    (if p.schema_version == 5 {
        "COX/STATE/DYNAMIC/V1"
    } else if p.schema_version == 4 {
        "COX/STATE/ADAPTIVE/V1"
    } else if p.schema_version >= 2 {
        "COX/STATE/V2"
    } else {
        "COX/STATE/V1"
    })
    .to_string()
    .serialize(&mut bytes)?;
    bytes.extend_from_slice(program.as_ref());
    bytes.extend_from_slice(pool.as_ref());
    b.sequence.serialize(&mut bytes)?;
    b.batch_id.serialize(&mut bytes)?;
    b.cutoff.serialize(&mut bytes)?;
    bytes.extend_from_slice(&b.predecessor_digest);
    bytes.extend_from_slice(manifest);
    bytes.extend_from_slice(&b.snapshot_digest);
    b.benchmark.serialize(&mut bytes)?;
    p.last_prices.serialize(&mut bytes)?;
    p.references.serialize(&mut bytes)?;
    (before.len() as u32).serialize(&mut bytes)?;
    for (pre, post) in before.iter().zip(&p.classes) {
        pre.backing.serialize(&mut bytes)?;
        pre.units.serialize(&mut bytes)?;
        post.backing.serialize(&mut bytes)?;
        post.units.serialize(&mut bytes)?;
    }
    b.executed.serialize(&mut bytes)?;
    b.rejected.serialize(&mut bytes)?;
    p.active.serialize(&mut bytes)?;
    p.pending.serialize(&mut bytes)?;
    p.payable.serialize(&mut bytes)?;
    p.residual.serialize(&mut bytes)?;
    bytes.extend_from_slice(&b.receipt_root);
    if p.schema_version >= 2 {
        p.fees.serialize(&mut bytes)?;
        b.fees.serialize(&mut bytes)?;
        p.fee_version.serialize(&mut bytes)?;
        p.fee_bps.serialize(&mut bytes)?;
        p.fee_cap.serialize(&mut bytes)?;
        p.fee_next_version.serialize(&mut bytes)?;
        p.fee_pending.serialize(&mut bytes)?;
        p.fee_pending_version.serialize(&mut bytes)?;
        p.fee_pending_bps.serialize(&mut bytes)?;
        p.fee_pending_cap.serialize(&mut bytes)?;
        p.fee_pending_cutoff.serialize(&mut bytes)?;
        p.fee_initial_scheduled.serialize(&mut bytes)?;
        let mut policy = Vec::new();
        "COX/FEES/V1".to_string().serialize(&mut policy)?;
        policy.extend_from_slice(manifest);
        100u16.serialize(&mut policy)?;
        2_000_000u64.serialize(&mut policy)?;
        86_400u64.serialize(&mut policy)?;
        bytes.extend_from_slice(&math::artifact_digest(&policy));
    }
    if p.schema_version >= 4 { p.trading_opens_at.serialize(&mut bytes)?; p.test_collateral_mint.serialize(&mut bytes)?; }
    Ok(bytes)
}
#[error_code]
pub enum CoxError {
    Unauthorized,
    Paused,
    Halted,
    InvalidAccount,
    InvalidManifest,
    UnsealedManifest,
    InvalidRoster,
    InvalidPrice,
    InvalidVenueStep,
    InvalidCandle,
    InvalidSnapshotDigest,
    TooEarly,
    CommitDeadlinePassed,
    ArchiveDeadlinePassed,
    WrongPredecessor,
    Replay,
    BatchBusy,
    BatchIncomplete,
    InvalidRequest,
    InvalidExpiry,
    CancellationClosed,
    AlreadyProcessed,
    InsufficientUnlockedUnits,
    ConditionFailed,
    ZeroValueClass,
    ArithmeticOverflow,
    ZeroTransferDenominator,
    InvalidBenchmark,
    VaultMismatch,
    InvalidCollateral,
    InsufficientPayable,
    NotRefundable,
    IncompatibleMethodology,
    InvalidAuthority,
    InvalidOrigin,
    CapacityExceeded,
    InvalidFee,
    InvalidFeeActivation,
    FeeVersionChanged,
    InsufficientFees,
    PoolRetired,
    NotRetired,
    DualCollateralDisabled,
    MissingCollateralVault,
    CollateralLiquidity,
    DualRetirementUnsupported,
}
#[derive(Accounts)]
pub struct ReadPool<'info> {
    #[account(seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump)]
    pub pool: Account<'info, Pool>,
}
#[derive(Accounts)]
pub struct ReadPosition<'info> {
    #[account(seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(seeds=[b"position",pool.key().as_ref(),position.owner.as_ref()],bump=position.bump,has_one=pool)]
    pub position: Account<'info, Position>,
}
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ReferenceRead {
    pub sequence: u64,
    pub batch: u64,
    pub cutoff: u64,
    pub reference: i128,
    pub backing: u64,
    pub units: u128,
    pub state_digest: [u8; 32],
}
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct PositionRead {
    pub sequence: u64,
    pub classes: Vec<PositionClass>,
    pub payable: u64,
    pub refundable: u64,
}
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct QuoteRead {
    pub sequence: u64,
    pub minted: u128,
    pub proceeds: u64,
}
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct FeeQuoteRead {
    pub sequence: u64,
    pub minted: u128,
    pub proceeds: u64,
    pub gross: u64,
    pub fee: u64,
    pub fee_version: u64,
}
#[event]
pub struct FeesScheduled {
    pub pool: Pubkey,
    pub version: u64,
    pub bps: u16,
    pub cap: u64,
    pub activation_cutoff: u64,
}
#[event]
pub struct FeesCancelled {
    pub pool: Pubkey,
    pub version: u64,
}
#[event]
pub struct FeesActivated {
    pub pool: Pubkey,
    pub version: u64,
    pub bps: u16,
    pub cap: u64,
}
#[event]
pub struct FeesWithdrawn {
    pub pool: Pubkey,
    pub admin: Pubkey,
    pub amount: u64,
}
#[event]
pub struct PublicationCommitted {
    pub pool: Pubkey,
    pub sequence: u64,
    pub batch: u64,
    pub state_digest: [u8; 32],
    pub snapshot: [u8; 32],
    pub manifest: [u8; 32],
}
#[event]
pub struct BatchAccepted {
    pub pool: Pubkey,
    pub batch: u64,
    pub snapshot: [u8; 32],
}
#[event]
pub struct RequestQueued {
    pub pool: Pubkey,
    pub request: Pubkey,
    pub owner: Pubkey,
    pub target_batch: u64,
    pub expiry: u64,
    pub operation: u8,
}
#[event]
pub struct DepositRefunded {
    pub pool: Pubkey,
    pub request: Pubkey,
    pub amount: u64,
}
#[event]
pub struct WithdrawalPaid {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}
#[event]
pub struct RequestCancelled {
    pub pool: Pubkey,
    pub request: Pubkey,
}
#[event]
pub struct RequestRejected {
    pub pool: Pubkey,
    pub request: Pubkey,
    pub status: u8,
}
#[event]
pub struct PauseChanged {
    pub registry: Pubkey,
    pub paused: bool,
}
#[event]
pub struct RuntimeScheduled {
    pub registry: Pubkey,
    pub key: Pubkey,
    pub effective_batch: u64,
}

#[event]
pub struct RetirementStarted {
    pub pool: Pubkey,
    pub sequence: u64,
    pub state_digest: [u8; 32],
}
#[event]
pub struct PositionRetired {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub payable: u64,
}

#[derive(Accounts)]
#[instruction(digest: [u8; 32])]
pub struct RegisterDynamicMethodology<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=admin)]
    pub registry: Account<'info, Registry>,
    #[account(init,payer=admin,space=8192,seeds=[b"methodology",digest.as_ref()],bump)]
    pub methodology: Account<'info, Methodology>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct SealDynamicMethodology<'info> {
    pub runtime: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=runtime)]
    pub registry: Account<'info, Registry>,
    #[account(seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=methodology)]
    pub pool: Account<'info, Pool>,
    #[account(seeds=[b"methodology",methodology.digest.as_ref()],bump=methodology.bump)]
    pub methodology: Account<'info, Methodology>,
    #[account(mut,seeds=[b"methodology",next_methodology.digest.as_ref()],bump=next_methodology.bump)]
    pub next_methodology: Account<'info, Methodology>,
}
#[derive(Accounts)]
pub struct MigrateDynamicPool<'info> {
    pub admin: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=admin)]
    pub registry: Account<'info, Registry>,
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=methodology,has_one=vault)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds=[b"methodology",methodology.digest.as_ref()],bump=methodology.bump)]
    pub methodology: Account<'info, Methodology>,
    #[account(seeds=[b"methodology",next_methodology.digest.as_ref()],bump=next_methodology.bump)]
    pub next_methodology: Account<'info, Methodology>,
    #[account(token::authority=pool,token::mint=pool.collateral_mint)]
    pub vault: Account<'info, TokenAccount>,
    pub test_vault: Option<Account<'info, TokenAccount>>,
}
#[derive(Accounts)]
pub struct ActivateUniverse<'info> {
    pub runtime: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=runtime)]
    pub registry: Account<'info, Registry>,
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=methodology,has_one=vault)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds=[b"methodology",methodology.digest.as_ref()],bump=methodology.bump)]
    pub methodology: Account<'info, Methodology>,
    #[account(seeds=[b"methodology",next_methodology.digest.as_ref()],bump=next_methodology.bump)]
    pub next_methodology: Account<'info, Methodology>,
    #[account(token::authority=pool,token::mint=pool.collateral_mint)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut,seeds=[b"universe-schedule",pool.key().as_ref(),schedule.version.to_le_bytes().as_ref()],bump=schedule.bump,has_one=pool)]
    pub schedule: Account<'info, UniverseSchedule>,
    pub test_vault: Option<Account<'info, TokenAccount>>,
}
#[derive(Accounts)]
pub struct GrowDynamicAccount<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry)]
    pub pool: Account<'info, Pool>,
    #[account(mut,owner=crate::ID)]
    pub target: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct BeginDynamicPublication<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub runtime: Signer<'info>,
    #[account(mut,seeds=[b"registry"],bump=registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=methodology,has_one=vault)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds=[b"methodology",methodology.digest.as_ref()],bump=methodology.bump)]
    pub methodology: Account<'info, Methodology>,
    #[account(init_if_needed,payer=payer,space=if pool.schema_version == 5 { dynamic_batch_space(pool.classes.len()) } else { 8192 },seeds=[b"batch",pool.key().as_ref()],bump)]
    pub batch: Box<Account<'info, Batch>>,
    #[account(token::authority=pool,token::mint=pool.collateral_mint)]
    pub vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub test_vault: Option<Account<'info, TokenAccount>>,
}
#[derive(Accounts)]
pub struct StageDynamicPublication<'info> {
    pub runtime: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=runtime)]
    pub registry: Account<'info, Registry>,
    #[account(seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=methodology,constraint=pool.stage==Some(batch.key()) @ CoxError::BatchBusy)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds=[b"methodology",methodology.digest.as_ref()],bump=methodology.bump)]
    pub methodology: Account<'info, Methodology>,
    #[account(mut,seeds=[b"batch",pool.key().as_ref()],bump=batch.bump,has_one=pool,constraint=batch.schema_version==4 @ CoxError::InvalidAccount)]
    pub batch: Box<Account<'info, Batch>>,
}

fn require_account_capacity<T: AnchorSerialize>(account: &AccountInfo, value: &T) -> Result<()> {
    struct Size(usize);
    impl std::io::Write for Size {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.checked_add(bytes.len()).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "SizeOverflow"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }
    let mut size = Size(8);
    value.serialize(&mut size)?;
    require!(size.0 <= account.data_len(), CoxError::CapacityExceeded);
    Ok(())
}
fn extend_dynamic_position(position: &mut Position, pool: &Pool) -> Result<()> {
    if pool.schema_version == 5 {
        require!(!position.staged || position.classes.len() == pool.classes.len(), CoxError::BatchBusy);
        require!(position.classes.len() <= pool.classes.len(), CoxError::InvalidAccount);
        if !position.staged { position.classes.resize_with(pool.classes.len(), PositionClass::default); }
    }
    Ok(())
}
fn validate_dynamic_price(price: &PriceWire, timestamp: u64) -> Result<()> {
    require!(price.price_e8 > 0 && price.venue == 3 && price.step == 0
        && price.candle_start == timestamp && price.trade_age_minutes == 0, CoxError::InvalidPrice);
    Ok(())
}
pub fn dynamic_snapshot_digest(timestamp: u64, benchmark: i128, universe: &UniverseVersion, prices: &[PriceWire]) -> Result<[u8; 32]> {
    require!(benchmark > 0 && prices.len() == universe.instruments.len(), CoxError::InvalidPrice);
    let mut bytes = Vec::new();
    "COX/SNAPSHOT/DYNAMIC/V1".to_string().serialize(&mut bytes)?;
    timestamp.serialize(&mut bytes)?; benchmark.serialize(&mut bytes)?;
    universe.digest.serialize(&mut bytes)?;
    (prices.len() as u32).serialize(&mut bytes)?;
    for (instrument, price) in universe.instruments.iter().zip(prices) {
        validate_dynamic_price(price, timestamp)?;
        instrument.class_id.serialize(&mut bytes)?;
        instrument.epoch_id.serialize(&mut bytes)?;
        instrument.pyth_pro_feed_id.serialize(&mut bytes)?;
        price.price_e8.serialize(&mut bytes)?;
    }
    Ok(dynamic_digest(&bytes))
}
fn dynamic_asset_reference(pool: &Pool, instrument: &Instrument, index: usize, price: u64, benchmark: i128) -> Result<(i128, i128)> {
    let scaled = |a: i128, b: i128, c: i128| -> Result<i128> {
        mm(math::rounded_div(a.checked_mul(b).ok_or(CoxError::ArithmeticOverflow)?, c))
    };
    require!(pool.benchmark > 0 && benchmark > 0 && price > 0 && pool.last_prices[index] > 0
        && instrument.original_price_e8 == pool.origin_prices[index], CoxError::InvalidPrice);
    let benchmark_gross = scaled(benchmark, math::SCALE, pool.benchmark)?;
    let asset_gross = scaled(price as i128, math::SCALE, pool.last_prices[index] as i128)?;
    let h = scaled(asset_gross, math::SCALE, benchmark_gross)?;
    let since_asset = scaled(price as i128, math::SCALE, instrument.original_price_e8 as i128)?;
    let since_benchmark = scaled(benchmark, math::SCALE, instrument.original_benchmark)?;
    let relative = scaled(100 * math::SCALE, since_asset, since_benchmark)?;
    Ok((relative, h))
}
fn dynamic_reference(pool: &Pool, universe: &UniverseVersion, prices: &[u64], benchmark: i128) -> Result<math::Reference> {
    require!(pool.schema_version == 5 && pool.benchmark > 0 && benchmark > 0
        && prices.len() == universe.instruments.len() && prices.len() == pool.origin_prices.len()
        && prices.len() == pool.last_prices.len() && pool.classes.len() == prices.len()+1, CoxError::InvalidPrice);
    let scaled = |a: i128, b: i128, c: i128| -> Result<i128> {
        mm(math::rounded_div(a.checked_mul(b).ok_or(CoxError::ArithmeticOverflow)?, c))
    };
    let benchmark_gross = scaled(benchmark, math::SCALE, pool.benchmark)?;
    let mut gross = Vec::with_capacity(prices.len());
    let mut relative = vec![100 * math::SCALE; prices.len()+1];
    let mut h = vec![math::SCALE; prices.len()+1];
    for (index, instrument) in universe.instruments.iter().enumerate() {
        let previous = pool.last_prices[index]; let price = prices[index];
        require!(previous > 0 && price > 0 && instrument.original_price_e8 == pool.origin_prices[index], CoxError::InvalidPrice);
        let asset_gross = scaled(price as i128, math::SCALE, previous as i128)?;
        gross.push(asset_gross);
        let class = usize::from(instrument.class_id);
        h[class] = scaled(asset_gross, math::SCALE, benchmark_gross)?;
        let since_asset = scaled(price as i128, math::SCALE, instrument.original_price_e8 as i128)?;
        let since_benchmark = scaled(benchmark, math::SCALE, instrument.original_benchmark)?;
        relative[class] = scaled(100 * math::SCALE, since_asset, since_benchmark)?;
    }
    Ok(math::Reference { gross, benchmark_gross, benchmark, relative, h })
}
pub fn dynamic_batch_space(classes: usize) -> usize {
    (4096usize.saturating_add(classes.saturating_mul(128))).div_ceil(8192).max(1) * 8192
}
pub fn dynamic_position_space(classes: usize) -> usize {
    (512usize.saturating_add(classes.saturating_mul(80))).div_ceil(4096).max(1) * 4096
}
#[derive(Accounts)]
pub struct InitializeDynamicPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(init,payer=owner,space=4096,seeds=[b"position",pool.key().as_ref(),owner.key().as_ref()],bump)]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(version: u64)]
pub struct ScheduleUniverse<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=admin)]
    pub registry: Account<'info, Registry>,
    #[account(seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=methodology)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds=[b"methodology",methodology.digest.as_ref()],bump=methodology.bump)]
    pub methodology: Account<'info, Methodology>,
    #[account(init_if_needed,payer=admin,space=256,seeds=[b"universe-schedule",pool.key().as_ref(),version.to_le_bytes().as_ref()],bump)]
    pub schedule: Account<'info, UniverseSchedule>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct CancelUniverseSchedule<'info> {
    pub admin: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=admin)]
    pub registry: Account<'info, Registry>,
    #[account(seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry)]
    pub pool: Account<'info, Pool>,
    #[account(mut,seeds=[b"universe-schedule",pool.key().as_ref(),schedule.version.to_le_bytes().as_ref()],bump=schedule.bump,has_one=pool)]
    pub schedule: Account<'info, UniverseSchedule>,
}
#[derive(Accounts)]
#[instruction(digest: [u8; 32])]
pub struct RegisterScheduledMethodology<'info> {
    #[account(mut)]
    pub runtime: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=runtime)]
    pub registry: Account<'info, Registry>,
    #[account(seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=methodology)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds=[b"methodology",methodology.digest.as_ref()],bump=methodology.bump)]
    pub methodology: Account<'info, Methodology>,
    #[account(seeds=[b"universe-schedule",pool.key().as_ref(),schedule.version.to_le_bytes().as_ref()],bump=schedule.bump,has_one=pool)]
    pub schedule: Account<'info, UniverseSchedule>,
    #[account(init,payer=runtime,space=8192,seeds=[b"methodology",digest.as_ref()],bump)]
    pub next_methodology: Account<'info, Methodology>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct ManageScheduledMethodology<'info> {
    pub runtime: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=runtime)]
    pub registry: Account<'info, Registry>,
    #[account(seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=methodology)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds=[b"methodology",methodology.digest.as_ref()],bump=methodology.bump)]
    pub methodology: Account<'info, Methodology>,
    #[account(seeds=[b"universe-schedule",pool.key().as_ref(),schedule.version.to_le_bytes().as_ref()],bump=schedule.bump,has_one=pool)]
    pub schedule: Account<'info, UniverseSchedule>,
    #[account(mut,seeds=[b"methodology",next_methodology.digest.as_ref()],bump=next_methodology.bump)]
    pub next_methodology: Account<'info, Methodology>,
}
#[event]
pub struct UniverseActivated { pub pool: Pubkey, pub version: u64, pub digest: [u8; 32], pub timestamp: u64 }

#[derive(Accounts)]
pub struct CancelDynamicPreparation<'info> {
    pub admin: Signer<'info>,
    #[account(mut,seeds=[b"registry"],bump=registry.bump,has_one=admin)]
    pub registry: Account<'info, Registry>,
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,constraint=pool.stage==Some(batch.key()) @ CoxError::BatchBusy)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut,seeds=[b"batch",pool.key().as_ref()],bump=batch.bump,has_one=pool,constraint=batch.schema_version==4 @ CoxError::InvalidAccount)]
    pub batch: Box<Account<'info, Batch>>,
}
#[event]
pub struct DynamicPreparationCancelled { pub pool: Pubkey, pub batch: u64, pub sequence: u64, pub snapshot: [u8; 32], pub phase: u8 }
