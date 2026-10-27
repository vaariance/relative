#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{hash::hashv, program_option::COption};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use cox_epoch::{self as engine, math, Asset, EntryLot, Epoch, OperatorSnapshot, Price};

declare_id!("4RRBbmzExtPDMYNUgCaetfz3wNYkF2mrAYKZVY4iXz2w");

pub const INITIAL_SPACE: usize = 2_048;
pub const EPOCH_SPACE: usize = 64_000;
pub const SNAPSHOT_SPACE: usize = 14_000;
pub const LOT_SPACE: usize = 1_024;
pub const PAGE_SIZE: usize = 8;
pub const ATOMIC_MAX_PRICES: usize = 30;
pub const MAX_GROWTH: usize = 8_192;
pub const REQUIRED_HEAP_BYTES: u32 = 256 * 1_024;

#[cfg(all(target_os = "solana", feature = "custom-heap"))]
#[global_allocator]
static ALLOCATOR: anchor_lang::solana_program::entrypoint::BumpAllocator = anchor_lang::solana_program::entrypoint::BumpAllocator {
    start: anchor_lang::solana_program::entrypoint::HEAP_START_ADDRESS as usize,
    len: REQUIRED_HEAP_BYTES as usize,
};

#[program]
pub mod relative_epoch {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>, config_id: u64, operator: Pubkey,
        methodology: [u8; 32], origin_benchmark: u128, max_entry_price_age: u64, max_lots: u32) -> Result<()> {
        require!(operator != Pubkey::default() && operator != ctx.accounts.admin.key(), EpochError::InvalidConfiguration);
        require!(methodology != [0; 32] && origin_benchmark > 0 && origin_benchmark <= math::MAX_REFERENCE
            && max_entry_price_age > 0 && max_lots > 0 && max_lots <= engine::MAX_LOTS,
            EpochError::InvalidConfiguration);
        require!(ctx.accounts.mint.decimals == math::COLLATERAL_DECIMALS, EpochError::InvalidCollateral);
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.config_id = config_id;
        config.operator = operator;
        config.mint = ctx.accounts.mint.key();
        config.test_mint = None;
        config.methodology = methodology;
        config.origin_benchmark = origin_benchmark;
        config.max_entry_price_age = max_entry_price_age;
        config.max_lots = max_lots;
        config.bump = ctx.bumps.config;
        config.lifecycle_version = 1;
        config.lifecycle = ConfigLifecycle::Active;
        config.asset_registry = Pubkey::default();
        Ok(())
    }

    pub fn initialize_devnet_config(ctx: Context<InitializeDevnetConfig>, config_id: u64, operator: Pubkey,
        methodology: [u8; 32], origin_benchmark: u128, max_entry_price_age: u64, max_lots: u32) -> Result<()> {
        require!(cfg!(feature = "devnet-collateral"), EpochError::DualCollateralDisabled);
        require!(operator != Pubkey::default() && operator != ctx.accounts.admin.key(), EpochError::InvalidConfiguration);
        require!(methodology != [0; 32] && origin_benchmark > 0 && origin_benchmark <= math::MAX_REFERENCE
            && max_entry_price_age > 0 && max_lots > 0 && max_lots <= engine::MAX_LOTS,
            EpochError::InvalidConfiguration);
        require!(ctx.accounts.mint.decimals == math::COLLATERAL_DECIMALS
            && ctx.accounts.test_mint.decimals == math::COLLATERAL_DECIMALS
            && ctx.accounts.mint.key() != ctx.accounts.test_mint.key(), EpochError::InvalidCollateral);
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.config_id = config_id;
        config.operator = operator;
        config.mint = ctx.accounts.mint.key();
        config.test_mint = Some(ctx.accounts.test_mint.key());
        config.methodology = methodology;
        config.origin_benchmark = origin_benchmark;
        config.max_entry_price_age = max_entry_price_age;
        config.max_lots = max_lots;
        config.bump = ctx.bumps.config;
        config.lifecycle_version = 1;
        config.lifecycle = ConfigLifecycle::Active;
        config.asset_registry = Pubkey::default();
        Ok(())
    }

    pub fn initialize_registry_config(ctx: Context<InitializeConfig>, config_id: u64, operator: Pubkey,
        methodology: [u8; 32], origin_benchmark: u128, max_entry_price_age: u64, max_lots: u32, asset_registry: Pubkey) -> Result<()> {
        require!(operator != Pubkey::default() && operator != ctx.accounts.admin.key(), EpochError::InvalidConfiguration);
        require!(methodology != [0; 32] && origin_benchmark > 0 && origin_benchmark <= math::MAX_REFERENCE
            && max_entry_price_age > 0 && max_lots > 0 && max_lots <= engine::MAX_LOTS,
            EpochError::InvalidConfiguration);
        require!(ctx.accounts.mint.decimals == math::COLLATERAL_DECIMALS, EpochError::InvalidCollateral);
        require!(asset_registry != Pubkey::default(), EpochError::InvalidConfiguration);
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.config_id = config_id;
        config.operator = operator;
        config.mint = ctx.accounts.mint.key();
        config.test_mint = None;
        config.methodology = methodology;
        config.origin_benchmark = origin_benchmark;
        config.max_entry_price_age = max_entry_price_age;
        config.max_lots = max_lots;
        config.bump = ctx.bumps.config;
        config.lifecycle_version = 1;
        config.lifecycle = ConfigLifecycle::Preparing;
        config.asset_registry = asset_registry;
        Ok(())
    }
    pub fn initialize_registry_devnet_config(ctx: Context<InitializeDevnetConfig>, config_id: u64, operator: Pubkey,
        methodology: [u8; 32], origin_benchmark: u128, max_entry_price_age: u64, max_lots: u32, asset_registry: Pubkey) -> Result<()> {
        require!(cfg!(feature = "devnet-collateral"), EpochError::DualCollateralDisabled);
        require!(operator != Pubkey::default() && operator != ctx.accounts.admin.key(), EpochError::InvalidConfiguration);
        require!(methodology != [0; 32] && origin_benchmark > 0 && origin_benchmark <= math::MAX_REFERENCE
            && max_entry_price_age > 0 && max_lots > 0 && max_lots <= engine::MAX_LOTS,
            EpochError::InvalidConfiguration);
        require!(ctx.accounts.mint.decimals == math::COLLATERAL_DECIMALS
            && ctx.accounts.test_mint.decimals == math::COLLATERAL_DECIMALS
            && ctx.accounts.mint.key() != ctx.accounts.test_mint.key(), EpochError::InvalidCollateral);
        require!(asset_registry != Pubkey::default(), EpochError::InvalidConfiguration);
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.config_id = config_id;
        config.operator = operator;
        config.mint = ctx.accounts.mint.key();
        config.test_mint = Some(ctx.accounts.test_mint.key());
        config.methodology = methodology;
        config.origin_benchmark = origin_benchmark;
        config.max_entry_price_age = max_entry_price_age;
        config.max_lots = max_lots;
        config.bump = ctx.bumps.config;
        config.lifecycle_version = 1;
        config.lifecycle = ConfigLifecycle::Preparing;
        config.asset_registry = asset_registry;
        Ok(())
    }

    pub fn set_config_lifecycle(ctx: Context<ManageConfig>, lifecycle: ConfigLifecycle) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let previous = config_lifecycle(config)?;
        require!(previous != ConfigLifecycle::Archived, EpochError::Archived);
        require!(lifecycle != ConfigLifecycle::Preparing || previous == ConfigLifecycle::Preparing,
            EpochError::InvalidConfiguration);
        config.lifecycle_version = 1;
        config.lifecycle = lifecycle;
        Ok(())
    }

    pub fn initialize_current_epoch(ctx: Context<InitializeCurrentEpoch>, opens_at: u64) -> Result<()> {
        require_preparable(&ctx.accounts.config)?;
        require_current_time(opens_at)?;
        require!(ctx.accounts.asset_registry.key() == ctx.accounts.config.asset_registry,
            EpochError::InvalidRegistry);
        let generation = ctx.accounts.asset_registry.generation;
        validate_registry_interval(&ctx.accounts.asset_registry, ctx.accounts.registry_version.key(), opens_at)?;
        let version = cox::validate_registry_version(&ctx.accounts.registry_version.to_account_info(),
            &ctx.accounts.methodology.to_account_info(), ctx.accounts.config.asset_registry, generation, opens_at)?;
        let registry_version = read_registry_version(&ctx.accounts.registry_version.to_account_info())?;
        require!(registry_version.effective_until != 0 || ctx.accounts.asset_registry.active_version == ctx.accounts.registry_version.key(), EpochError::InvalidRegistry);
        require!(version.instruments.len() >= engine::BASKET_SIZE, EpochError::InvalidRegistry);
        let epoch = &mut ctx.accounts.epoch;
        epoch.config = ctx.accounts.config.key();
        epoch.opens_at = opens_at;
        epoch.vault = ctx.accounts.vault.key();
        epoch.test_vault = ctx.accounts.test_vault.key();
        epoch.bump = ctx.bumps.epoch;
        epoch.universe = Vec::new();
        epoch.state = None;
        epoch.binding_version = 1;
        epoch.registry_origin_benchmarks = Vec::new();
        epoch.registry_version = ctx.accounts.registry_version.key();
        epoch.universe_digest = registry_version.digest;
        Ok(())
    }

    pub fn grow_current_epoch(ctx: Context<ManageCurrentEpochDraft>, additional_bytes: u32) -> Result<()> {
        validate_current_draft(&ctx.accounts)?;
        grow(&ctx.accounts.epoch.to_account_info(), &ctx.accounts.payer.to_account_info(),
            &ctx.accounts.system_program.to_account_info(), additional_bytes, EPOCH_SPACE)
    }

    pub fn copy_registry_assets(ctx: Context<ManageCurrentEpochDraft>, start: u16, count: u16) -> Result<()> {
        let version = validate_current_draft(&ctx.accounts)?;
        let start = start as usize;
        let count = count as usize;
        require!(count > 0 && count <= PAGE_SIZE && start == ctx.accounts.epoch.universe.len()
            && start.checked_add(count).map_or(false, |end| end <= version.instruments.len()), EpochError::InvalidPage);
        for instrument in &version.instruments[start..start + count] {
            require!(instrument.original_benchmark > 0 && instrument.original_benchmark as u128 <= math::MAX_REFERENCE, EpochError::InvalidRegistry);
            ctx.accounts.epoch.universe.push(Asset { id: instrument.epoch_id,
                feed_id: instrument.pyth_core_feed_id, origin_price: instrument.original_price_e8 as u128 });
            ctx.accounts.epoch.registry_origin_benchmarks.push(instrument.original_benchmark as u128);
        }
        check_space(&**ctx.accounts.epoch, &ctx.accounts.epoch.to_account_info())
    }

    pub fn seal_current_epoch(ctx: Context<ManageCurrentEpochDraft>) -> Result<()> {
        let version = validate_current_draft(&ctx.accounts)?;
        require!(ctx.accounts.epoch.universe.len() == version.instruments.len()
            && ctx.accounts.epoch.registry_origin_benchmarks.len() == version.instruments.len(), EpochError::InvalidPage);
        require!(ctx.accounts.epoch.to_account_info().data_len() >= EPOCH_SPACE, EpochError::InsufficientSpace);
        let config = &ctx.accounts.config;
        let state_config = state_config(config, config.key());
        ctx.accounts.epoch.state = Some(map_engine(Epoch::create_current(state_config,
            ctx.accounts.epoch.opens_at, now()?, ctx.accounts.epoch.universe.clone()))?);
        ctx.accounts.epoch.universe.clear();
        check_space(&**ctx.accounts.epoch, &ctx.accounts.epoch.to_account_info())
    }

    pub fn finalize_empty(ctx: Context<ManageSettlement>) -> Result<()> {
        require!(!ctx.accounts.epoch.empty_finalized, EpochError::Immutable);
        let timestamp = now()?;
        require!(timestamp >= ctx.accounts.epoch.opens_at.checked_add(engine::EPOCH_SECONDS)
            .ok_or(EpochError::InvalidTime)?, EpochError::InvalidTime);
        if ctx.accounts.epoch.state.is_some() {
            reconcile(&mut ctx.accounts.epoch, &ctx.accounts.vault, &ctx.accounts.test_vault, &ctx.accounts.config)?;
            map_engine(ctx.accounts.epoch.state.as_mut().ok_or(EpochError::UnsealedEpoch)?
                .finalize_empty(timestamp, vault_total(&ctx.accounts.vault, &ctx.accounts.test_vault)?))?;
        } else {
            validate_vault(&ctx.accounts.vault, ctx.accounts.epoch.key(), ctx.accounts.config.mint)?;
            validate_vault(&ctx.accounts.test_vault, ctx.accounts.epoch.key(), ctx.accounts.config.test_mint.unwrap_or(ctx.accounts.config.mint))?;
        }
        ctx.accounts.epoch.empty_finalized = true;
        Ok(())
    }

    pub fn initialize_epoch(ctx: Context<InitializeEpoch>, opens_at: u64) -> Result<()> {
        require_legacy_active(&ctx.accounts.config)?;
        require!(opens_at % engine::EPOCH_SECONDS == 0 && now()? <= opens_at, EpochError::InvalidTime);
        opens_at.checked_add(engine::EPOCH_SECONDS).and_then(|close| close.checked_add(engine::CLOSING_GRACE_SECONDS))
            .ok_or(EpochError::InvalidTime)?;
        let epoch = &mut ctx.accounts.epoch;
        epoch.config = ctx.accounts.config.key();
        epoch.opens_at = opens_at;
        epoch.vault = ctx.accounts.vault.key();
        epoch.test_vault = ctx.accounts.test_vault.key();
        epoch.bump = ctx.bumps.epoch;
        epoch.universe = Vec::new();
        epoch.state = None;
        Ok(())
    }

    pub fn grow_epoch(ctx: Context<ManageEpochDraft>, additional_bytes: u32) -> Result<()> {
        require_legacy_active(&ctx.accounts.config)?;
        require!(ctx.accounts.epoch.state.is_none() && now()? <= ctx.accounts.epoch.opens_at, EpochError::Immutable);
        grow(&ctx.accounts.epoch.to_account_info(), &ctx.accounts.admin.to_account_info(),
            &ctx.accounts.system_program.to_account_info(), additional_bytes, EPOCH_SPACE)
    }

    pub fn append_universe(ctx: Context<ManageEpochDraft>, assets: Vec<Asset>) -> Result<()> {
        require_legacy_active(&ctx.accounts.config)?;
        require!(ctx.accounts.epoch.state.is_none() && now()? <= ctx.accounts.epoch.opens_at, EpochError::Immutable);
        require!(!assets.is_empty() && assets.len() <= PAGE_SIZE
            && ctx.accounts.epoch.universe.len() + assets.len() <= engine::MAX_UNIVERSE, EpochError::InvalidPage);
        let mut universe = ctx.accounts.epoch.universe.clone();
        for asset in assets {
            require!((asset.id as usize) < engine::MAX_UNIVERSE && asset.feed_id != [0; 32]
                && asset.origin_price > 0 && asset.origin_price <= math::MAX_REFERENCE
                && !universe.iter().any(|prior| prior.id == asset.id || prior.feed_id == asset.feed_id), EpochError::InvalidPage);
            universe.push(asset);
        }
        ctx.accounts.epoch.universe = universe;
        check_space(&**ctx.accounts.epoch, &ctx.accounts.epoch.to_account_info())
    }

    pub fn seal_epoch(ctx: Context<ManageEpochDraft>) -> Result<()> {
        require_legacy_active(&ctx.accounts.config)?;
        require!(ctx.accounts.epoch.state.is_none(), EpochError::Immutable);
        require!(ctx.accounts.epoch.to_account_info().data_len() >= EPOCH_SPACE, EpochError::InsufficientSpace);
        let config = &ctx.accounts.config;
        let state_config = engine::Config { pool: config.key().to_bytes(), admin: config.admin.to_bytes(),
            operator: config.operator.to_bytes(), collateral_mint: config.mint.to_bytes(), collateral_decimals: math::COLLATERAL_DECIMALS,
            methodology: config.methodology, origin_benchmark: config.origin_benchmark,
            max_entry_price_age: config.max_entry_price_age, max_lots: config.max_lots };
        let state = map_engine(Epoch::create(state_config, ctx.accounts.admin.key().to_bytes(),
            ctx.accounts.epoch.opens_at, now()?, ctx.accounts.epoch.universe.clone()))?;
        ctx.accounts.epoch.state = Some(state);
        ctx.accounts.epoch.universe.clear();
        check_space(&**ctx.accounts.epoch, &ctx.accounts.epoch.to_account_info())
    }

    pub fn initialize_snapshot(ctx: Context<InitializeSnapshot>, sequence: u64, oracle_timestamp: u64,
        benchmark: u128, expected_prices: u16) -> Result<()> {
        require_active(&ctx.accounts.config)?;
        require!(oracle_timestamp <= now()? && benchmark > 0 && benchmark <= math::MAX_REFERENCE
            && expected_prices > 0 && expected_prices as usize <= engine::MAX_UNIVERSE, EpochError::InvalidSnapshot);
        let snapshot = &mut ctx.accounts.snapshot;
        snapshot.config = ctx.accounts.config.key();
        snapshot.sequence = sequence;
        snapshot.oracle_timestamp = oracle_timestamp;
        snapshot.benchmark = benchmark;
        snapshot.expected_prices = expected_prices;
        snapshot.methodology = ctx.accounts.config.methodology;
        snapshot.prices = Vec::new();
        snapshot.sealed = false;
        snapshot.digest = [0; 32];
        snapshot.bump = ctx.bumps.snapshot;
        Ok(())
    }

    pub fn publish_snapshot(ctx: Context<InitializeSnapshot>, sequence: u64, oracle_timestamp: u64,
        benchmark: u128, prices: Vec<Price>) -> Result<()> {
        require_active(&ctx.accounts.config)?;
        require!(oracle_timestamp <= now()? && benchmark > 0 && benchmark <= math::MAX_REFERENCE
            && !prices.is_empty() && prices.len() <= ATOMIC_MAX_PRICES, EpochError::InvalidSnapshot);
        for (index, price) in prices.iter().enumerate() {
            require!((price.asset_id as usize) < engine::MAX_UNIVERSE && price.feed_id != [0; 32]
                && price.value > 0 && price.value <= math::MAX_REFERENCE
                && (index == 0 || prices[index - 1].asset_id < price.asset_id)
                && !prices[..index].iter().any(|previous| previous.feed_id == price.feed_id), EpochError::InvalidPage);
        }
        let snapshot = &mut ctx.accounts.snapshot;
        snapshot.config = ctx.accounts.config.key();
        snapshot.sequence = sequence;
        snapshot.oracle_timestamp = oracle_timestamp;
        snapshot.benchmark = benchmark;
        snapshot.expected_prices = prices.len() as u16;
        snapshot.methodology = ctx.accounts.config.methodology;
        snapshot.prices = prices;
        snapshot.bump = ctx.bumps.snapshot;
        let encoded = SnapshotCommitment { config: snapshot.config, sequence, timestamp: oracle_timestamp,
            benchmark, methodology: snapshot.methodology, prices: snapshot.prices.clone() }.try_to_vec()?;
        snapshot.digest = hashv(&[b"RELATIVE/EPOCH/OPERATOR-SNAPSHOT/V1", &encoded]).to_bytes();
        snapshot.sealed = true;
        check_space(&**snapshot, &snapshot.to_account_info())
    }

    pub fn close_snapshot(_ctx: Context<CloseSnapshot>) -> Result<()> { Ok(()) }

    pub fn grow_snapshot(ctx: Context<ManageSnapshot>, additional_bytes: u32) -> Result<()> {
        require_active(&ctx.accounts.config)?;
        require!(!ctx.accounts.snapshot.sealed, EpochError::Immutable);
        grow(&ctx.accounts.snapshot.to_account_info(), &ctx.accounts.operator.to_account_info(),
            &ctx.accounts.system_program.to_account_info(), additional_bytes, SNAPSHOT_SPACE)
    }

    pub fn append_prices(ctx: Context<ManageSnapshot>, prices: Vec<Price>) -> Result<()> {
        require_active(&ctx.accounts.config)?;
        let snapshot = &mut ctx.accounts.snapshot;
        require!(!snapshot.sealed, EpochError::Immutable);
        require!(!prices.is_empty() && prices.len() <= PAGE_SIZE
            && snapshot.prices.len() + prices.len() <= snapshot.expected_prices as usize, EpochError::InvalidPage);
        let mut combined = snapshot.prices.clone();
        for price in prices {
            require!((price.asset_id as usize) < engine::MAX_UNIVERSE && price.feed_id != [0; 32]
                && price.value > 0 && price.value <= math::MAX_REFERENCE
                && combined.last().map_or(true, |previous| previous.asset_id < price.asset_id)
                && !combined.iter().any(|previous| previous.feed_id == price.feed_id), EpochError::InvalidPage);
            combined.push(price);
        }
        snapshot.prices = combined;
        check_space(&**snapshot, &snapshot.to_account_info())
    }

    pub fn seal_snapshot(ctx: Context<ManageSnapshot>) -> Result<()> {
        require_active(&ctx.accounts.config)?;
        let snapshot = &mut ctx.accounts.snapshot;
        require!(!snapshot.sealed, EpochError::Immutable);
        require!(snapshot.prices.len() == snapshot.expected_prices as usize && snapshot.oracle_timestamp <= now()?, EpochError::InvalidSnapshot);
        let encoded = SnapshotCommitment { config: snapshot.config, sequence: snapshot.sequence,
            timestamp: snapshot.oracle_timestamp, benchmark: snapshot.benchmark,
            methodology: snapshot.methodology, prices: snapshot.prices.clone() }.try_to_vec()?;
        snapshot.digest = hashv(&[b"RELATIVE/EPOCH/OPERATOR-SNAPSHOT/V1", &encoded]).to_bytes();
        snapshot.sealed = true;
        Ok(())
    }

    pub fn queue(ctx: Context<Queue>, nonce: u64, gross_stake: u64, basket: [u16; engine::BASKET_SIZE], backed_asset: u16) -> Result<()> {
        require_active(&ctx.accounts.config)?;
        validate_vault(&ctx.accounts.vault, ctx.accounts.epoch.key(), ctx.accounts.config.mint)?;
        validate_vault(&ctx.accounts.test_vault, ctx.accounts.epoch.key(), ctx.accounts.config.test_mint.unwrap_or(ctx.accounts.config.mint))?;
        let state = ctx.accounts.epoch.state.as_mut().ok_or(EpochError::UnsealedEpoch)?;
        map_engine(state.reconcile_surplus(vault_total(&ctx.accounts.vault, &ctx.accounts.test_vault)?))?;
        let deposit_vault = if ctx.accounts.source.mint == ctx.accounts.config.mint { &ctx.accounts.vault } else { &ctx.accounts.test_vault };
        token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer {
            from: ctx.accounts.source.to_account_info(), to: deposit_vault.to_account_info(), authority: ctx.accounts.owner.to_account_info(),
        }), gross_stake)?;
        ctx.accounts.vault.reload()?;
        ctx.accounts.test_vault.reload()?;
        let lot = map_engine(state.queue(ctx.accounts.owner.key().to_bytes(), nonce, gross_stake,
            basket, backed_asset, now()?, vault_total(&ctx.accounts.vault, &ctx.accounts.test_vault)?))?;
        ctx.accounts.lot.epoch = ctx.accounts.epoch.key();
        ctx.accounts.lot.nonce = nonce;
        ctx.accounts.lot.bump = ctx.bumps.lot;
        ctx.accounts.lot.state = Some(lot);
        Ok(())
    }

    pub fn execute(ctx: Context<Execute>) -> Result<()> {
        require_active(&ctx.accounts.config)?;
        validate_vault(&ctx.accounts.vault, ctx.accounts.epoch.key(), ctx.accounts.config.mint)?;
        validate_vault(&ctx.accounts.test_vault, ctx.accounts.epoch.key(), ctx.accounts.config.test_mint.unwrap_or(ctx.accounts.config.mint))?;
        let origin_benchmarks = bound_origins(&ctx.accounts.epoch)?;
        let state = ctx.accounts.epoch.state.as_mut().ok_or(EpochError::UnsealedEpoch)?;
        map_engine(state.reconcile_surplus(vault_total(&ctx.accounts.vault, &ctx.accounts.test_vault)?))?;
        let snapshot = select_snapshot(state, &ctx.accounts.snapshot)?;
        let lot = ctx.accounts.lot.state.as_mut().ok_or(EpochError::InvalidLot)?;
        map_engine(state.execute_with_origins(ctx.accounts.operator.key().to_bytes(), lot, &snapshot, now()?,
            vault_total(&ctx.accounts.vault, &ctx.accounts.test_vault)?, &origin_benchmarks))
    }

    pub fn begin_close(ctx: Context<BeginClose>) -> Result<()> {
        validate_vault(&ctx.accounts.vault, ctx.accounts.epoch.key(), ctx.accounts.config.mint)?;
        validate_vault(&ctx.accounts.test_vault, ctx.accounts.epoch.key(), ctx.accounts.config.test_mint.unwrap_or(ctx.accounts.config.mint))?;
        let origin_benchmarks = bound_origins(&ctx.accounts.epoch)?;
        let state = ctx.accounts.epoch.state.as_mut().ok_or(EpochError::UnsealedEpoch)?;
        map_engine(state.reconcile_surplus(vault_total(&ctx.accounts.vault, &ctx.accounts.test_vault)?))?;
        let snapshot = select_snapshot(state, &ctx.accounts.snapshot)?;
        map_engine(state.begin_close_with_origins(ctx.accounts.operator.key().to_bytes(), snapshot, now()?,
            vault_total(&ctx.accounts.vault, &ctx.accounts.test_vault)?, &origin_benchmarks))
    }

    pub fn score(ctx: Context<ManageLot>) -> Result<()> {
        reconcile(&mut ctx.accounts.epoch, &ctx.accounts.vault, &ctx.accounts.test_vault, &ctx.accounts.config)?;
        let state = ctx.accounts.epoch.state.as_mut().ok_or(EpochError::UnsealedEpoch)?;
        let lot = ctx.accounts.lot.state.as_mut().ok_or(EpochError::InvalidLot)?;
        map_engine(state.score_entry(lot, vault_total(&ctx.accounts.vault, &ctx.accounts.test_vault)?))?;
        Ok(())
    }

    pub fn finalize_scores(ctx: Context<ManageSettlement>) -> Result<()> {
        reconcile(&mut ctx.accounts.epoch, &ctx.accounts.vault, &ctx.accounts.test_vault, &ctx.accounts.config)?;
        map_engine(ctx.accounts.epoch.state.as_mut().ok_or(EpochError::UnsealedEpoch)?.finalize_scores(vault_total(&ctx.accounts.vault, &ctx.accounts.test_vault)?))
    }

    pub fn allocate(ctx: Context<ManageLot>) -> Result<()> {
        reconcile(&mut ctx.accounts.epoch, &ctx.accounts.vault, &ctx.accounts.test_vault, &ctx.accounts.config)?;
        let state = ctx.accounts.epoch.state.as_mut().ok_or(EpochError::UnsealedEpoch)?;
        let lot = ctx.accounts.lot.state.as_mut().ok_or(EpochError::InvalidLot)?;
        map_engine(state.allocate(lot, vault_total(&ctx.accounts.vault, &ctx.accounts.test_vault)?))?;
        Ok(())
    }

    pub fn refund(ctx: Context<ManageLot>) -> Result<()> {
        reconcile(&mut ctx.accounts.epoch, &ctx.accounts.vault, &ctx.accounts.test_vault, &ctx.accounts.config)?;
        let state = ctx.accounts.epoch.state.as_mut().ok_or(EpochError::UnsealedEpoch)?;
        let lot = ctx.accounts.lot.state.as_mut().ok_or(EpochError::InvalidLot)?;
        map_engine(state.refund(lot, now()?, vault_total(&ctx.accounts.vault, &ctx.accounts.test_vault)?))?;
        Ok(())
    }

    pub fn void_epoch(ctx: Context<ManageSettlement>) -> Result<()> {
        reconcile(&mut ctx.accounts.epoch, &ctx.accounts.vault, &ctx.accounts.test_vault, &ctx.accounts.config)?;
        map_engine(ctx.accounts.epoch.state.as_mut().ok_or(EpochError::UnsealedEpoch)?.void(now()?, vault_total(&ctx.accounts.vault, &ctx.accounts.test_vault)?))
    }

    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        withdraw_claim(ctx, None)
    }

    pub fn withdraw_partial(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        withdraw_claim(ctx, Some(amount))
    }

    pub fn withdraw_fees(ctx: Context<WithdrawFees>, amount: u64) -> Result<()> {
        reconcile(&mut ctx.accounts.epoch, &ctx.accounts.vault, &ctx.accounts.test_vault, &ctx.accounts.config)?;
        map_engine(ctx.accounts.epoch.state.as_mut().ok_or(EpochError::UnsealedEpoch)?.withdraw_fees(
            ctx.accounts.admin.key().to_bytes(), amount, vault_total(&ctx.accounts.vault, &ctx.accounts.test_vault)?))?;
        let config_key = ctx.accounts.config.key();
        let opens_at = ctx.accounts.epoch.opens_at.to_le_bytes();
        let bump = [ctx.accounts.epoch.bump];
        let signer: &[&[u8]] = &[b"epoch", config_key.as_ref(), &opens_at, &bump];
        let withdrawal_vault = if ctx.accounts.destination.mint == ctx.accounts.config.mint { &ctx.accounts.vault } else { &ctx.accounts.test_vault };
        token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
            from: withdrawal_vault.to_account_info(), to: ctx.accounts.destination.to_account_info(),
            authority: ctx.accounts.epoch.to_account_info(),
        }, &[signer]), amount)?;
        ctx.accounts.vault.reload()?;
        ctx.accounts.test_vault.reload()?;
        map_engine(ctx.accounts.epoch.state.as_ref().ok_or(EpochError::UnsealedEpoch)?.ledger().check(vault_total(&ctx.accounts.vault, &ctx.accounts.test_vault)?))
    }
}

#[derive(AnchorSerialize, AnchorDeserialize)]
struct SnapshotCommitment {
    config: Pubkey,
    sequence: u64,
    timestamp: u64,
    benchmark: u128,
    methodology: [u8; 32],
    prices: Vec<Price>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigLifecycle { Preparing, Active, Archived }

#[account]
pub struct PoolConfig {
    pub admin: Pubkey,
    pub config_id: u64,
    pub operator: Pubkey,
    pub mint: Pubkey,
    pub test_mint: Option<Pubkey>,
    pub methodology: [u8; 32],
    pub origin_benchmark: u128,
    pub max_entry_price_age: u64,
    pub max_lots: u32,
    pub bump: u8,
    pub lifecycle_extension: ConfigLifecycleExtension,
}
pub const CONFIG_LIFECYCLE_MAGIC: [u8; 8] = *b"RLCFG001";
#[derive(AnchorSerialize, Clone, Debug)]
pub struct ConfigLifecycleExtension {
    pub magic: [u8; 8],
    pub lifecycle_version: u8,
    pub lifecycle: ConfigLifecycle,
    pub asset_registry: Pubkey,
}
impl Default for ConfigLifecycleExtension {
    fn default() -> Self { Self { magic: CONFIG_LIFECYCLE_MAGIC, lifecycle_version: 0,
        lifecycle: ConfigLifecycle::Active, asset_registry: Pubkey::default() } }
}
impl AnchorDeserialize for ConfigLifecycleExtension {
    fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        let mut magic = [0; 8];
        match reader.read_exact(&mut magic) {
            Ok(()) if magic == CONFIG_LIFECYCLE_MAGIC => {},
            Ok(()) => return Ok(Self::default()),
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(Self::default()),
            Err(error) => return Err(error),
        }
        let lifecycle_version = u8::deserialize_reader(reader)?;
        if lifecycle_version > 1 { return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "unsupported config lifecycle")); }
        Ok(Self { magic, lifecycle_version, lifecycle: ConfigLifecycle::deserialize_reader(reader)?,
            asset_registry: Pubkey::deserialize_reader(reader)? })
    }
}
impl std::ops::Deref for PoolConfig {
    type Target = ConfigLifecycleExtension;
    fn deref(&self) -> &Self::Target { &self.lifecycle_extension }
}
impl std::ops::DerefMut for PoolConfig {
    fn deref_mut(&mut self) -> &mut Self::Target { &mut self.lifecycle_extension }
}

#[account]
pub struct EpochAccount {
    pub config: Pubkey,
    pub opens_at: u64,
    pub vault: Pubkey,
    pub test_vault: Pubkey,
    pub bump: u8,
    pub universe: Vec<Asset>,
    pub state: Option<Epoch>,
    pub registry_binding: EpochRegistryBinding,
}
pub const EPOCH_REGISTRY_MAGIC: [u8; 8] = *b"RLEPCH01";
#[derive(AnchorSerialize, Clone, Debug)]
pub struct EpochRegistryBinding {
    pub magic: [u8; 8],
    pub binding_version: u8,
    pub registry_version: Pubkey,
    pub registry_origin_benchmarks: Vec<u128>,
    pub universe_digest: [u8; 32],
    pub empty_finalized: bool,
}
impl Default for EpochRegistryBinding {
    fn default() -> Self { Self { magic: EPOCH_REGISTRY_MAGIC, binding_version: 0,
        registry_version: Pubkey::default(), registry_origin_benchmarks: Vec::new(),
        universe_digest: [0; 32], empty_finalized: false } }
}
impl AnchorDeserialize for EpochRegistryBinding {
    fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        let mut magic = [0; 8];
        match reader.read_exact(&mut magic) {
            Ok(()) if magic == EPOCH_REGISTRY_MAGIC => {},
            Ok(()) => return Ok(Self::default()),
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(Self::default()),
            Err(error) => return Err(error),
        }
        let binding_version = u8::deserialize_reader(reader)?;
        if binding_version > 1 { return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "unsupported epoch binding")); }
        let registry_version = Pubkey::deserialize_reader(reader)?;
        let count = u32::deserialize_reader(reader)? as usize;
        if count > engine::MAX_UNIVERSE { return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid epoch origin count")); }
        let mut registry_origin_benchmarks = Vec::with_capacity(count);
        for _ in 0..count { registry_origin_benchmarks.push(u128::deserialize_reader(reader)?); }
        Ok(Self { magic, binding_version, registry_version, registry_origin_benchmarks,
            universe_digest: <[u8; 32]>::deserialize_reader(reader)?, empty_finalized: bool::deserialize_reader(reader)? })
    }
}
impl std::ops::Deref for EpochAccount {
    type Target = EpochRegistryBinding;
    fn deref(&self) -> &Self::Target { &self.registry_binding }
}
impl std::ops::DerefMut for EpochAccount {
    fn deref_mut(&mut self) -> &mut Self::Target { &mut self.registry_binding }
}

#[account]
pub struct LotAccount {
    pub epoch: Pubkey,
    pub nonce: u64,
    pub bump: u8,
    pub state: Option<EntryLot>,
}

#[account]
pub struct SnapshotAccount {
    pub config: Pubkey,
    pub sequence: u64,
    pub oracle_timestamp: u64,
    pub benchmark: u128,
    pub expected_prices: u16,
    pub methodology: [u8; 32],
    pub prices: Vec<Price>,
    pub sealed: bool,
    pub digest: [u8; 32],
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(config_id: u64)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(init, payer = admin, space = 256, seeds = [b"config", admin.key().as_ref(), &config_id.to_le_bytes()], bump)]
    pub config: Account<'info, PoolConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(config_id: u64)]
pub struct InitializeDevnetConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub mint: Account<'info, Mint>,
    pub test_mint: Account<'info, Mint>,
    #[account(init, payer = admin, space = 256, seeds = [b"config", admin.key().as_ref(), &config_id.to_le_bytes()], bump)]
    pub config: Account<'info, PoolConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ManageConfig<'info> {
    #[account(address = config.admin)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config", config.admin.as_ref(), &config.config_id.to_le_bytes()], bump = config.bump)]
    pub config: Account<'info, PoolConfig>,
}

#[derive(Accounts)]
#[instruction(opens_at: u64)]
pub struct InitializeCurrentEpoch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config", config.admin.as_ref(), &config.config_id.to_le_bytes()], bump = config.bump)]
    pub config: Account<'info, PoolConfig>,
    pub asset_registry: Account<'info, cox::AssetRegistry>,
    pub registry_version: UncheckedAccount<'info>,
    pub methodology: UncheckedAccount<'info>,
    #[account(address = config.mint)]
    pub mint: Account<'info, Mint>,
    #[account(constraint = test_mint.key() == config.test_mint.unwrap_or(config.mint))]
    pub test_mint: Account<'info, Mint>,
    #[account(init, payer = payer, space = INITIAL_SPACE, seeds = [b"epoch", config.key().as_ref(), &opens_at.to_le_bytes()], bump)]
    pub epoch: Box<Account<'info, EpochAccount>>,
    #[account(init, payer = payer, seeds = [b"vault", epoch.key().as_ref()], bump, token::mint = mint, token::authority = epoch)]
    pub vault: Account<'info, TokenAccount>,
    #[account(init, payer = payer, seeds = [b"test-vault", epoch.key().as_ref()], bump, token::mint = test_mint, token::authority = epoch)]
    pub test_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ManageCurrentEpochDraft<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config", config.admin.as_ref(), &config.config_id.to_le_bytes()], bump = config.bump)]
    pub config: Account<'info, PoolConfig>,
    #[account(address = config.asset_registry)]
    pub asset_registry: Account<'info, cox::AssetRegistry>,
    pub registry_version: UncheckedAccount<'info>,
    pub methodology: UncheckedAccount<'info>,
    #[account(mut, has_one = config, has_one = registry_version,
        seeds = [b"epoch", config.key().as_ref(), &epoch.opens_at.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, EpochAccount>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(opens_at: u64)]
pub struct InitializeEpoch<'info> {
    #[account(mut, address = config.admin)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config", config.admin.as_ref(), &config.config_id.to_le_bytes()], bump = config.bump)]
    pub config: Account<'info, PoolConfig>,
    #[account(address = config.mint)]
    pub mint: Account<'info, Mint>,
    #[account(constraint = test_mint.key() == config.test_mint.unwrap_or(config.mint))]
    pub test_mint: Account<'info, Mint>,
    #[account(init, payer = admin, space = INITIAL_SPACE, seeds = [b"epoch", config.key().as_ref(), &opens_at.to_le_bytes()], bump)]
    pub epoch: Box<Account<'info, EpochAccount>>,
    #[account(init, payer = admin, seeds = [b"vault", epoch.key().as_ref()], bump, token::mint = mint, token::authority = epoch)]
    pub vault: Account<'info, TokenAccount>,
    #[account(init, payer = admin, seeds = [b"test-vault", epoch.key().as_ref()], bump, token::mint = test_mint, token::authority = epoch)]
    pub test_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ManageEpochDraft<'info> {
    #[account(mut, address = config.admin)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config", config.admin.as_ref(), &config.config_id.to_le_bytes()], bump = config.bump)]
    pub config: Account<'info, PoolConfig>,
    #[account(mut, has_one = config, seeds = [b"epoch", config.key().as_ref(), &epoch.opens_at.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, EpochAccount>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(sequence: u64)]
pub struct InitializeSnapshot<'info> {
    #[account(mut, address = config.operator)]
    pub operator: Signer<'info>,
    #[account(seeds = [b"config", config.admin.as_ref(), &config.config_id.to_le_bytes()], bump = config.bump)]
    pub config: Account<'info, PoolConfig>,
    #[account(init, payer = operator, space = INITIAL_SPACE, seeds = [b"snapshot", config.key().as_ref(), &sequence.to_le_bytes()], bump)]
    pub snapshot: Account<'info, SnapshotAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseSnapshot<'info> {
    #[account(mut, address = config.operator)]
    pub operator: Signer<'info>,
    #[account(seeds = [b"config", config.admin.as_ref(), &config.config_id.to_le_bytes()], bump = config.bump)]
    pub config: Account<'info, PoolConfig>,
    #[account(mut, close = operator, has_one = config, seeds = [b"snapshot", config.key().as_ref(), &snapshot.sequence.to_le_bytes()], bump = snapshot.bump)]
    pub snapshot: Account<'info, SnapshotAccount>,
}

#[derive(Accounts)]
pub struct ManageSnapshot<'info> {
    #[account(mut, address = config.operator)]
    pub operator: Signer<'info>,
    #[account(seeds = [b"config", config.admin.as_ref(), &config.config_id.to_le_bytes()], bump = config.bump)]
    pub config: Account<'info, PoolConfig>,
    #[account(mut, has_one = config, seeds = [b"snapshot", config.key().as_ref(), &snapshot.sequence.to_le_bytes()], bump = snapshot.bump)]
    pub snapshot: Account<'info, SnapshotAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct Queue<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"config", config.admin.as_ref(), &config.config_id.to_le_bytes()], bump = config.bump)]
    pub config: Account<'info, PoolConfig>,
    #[account(mut, has_one = config, has_one = vault, has_one = test_vault, seeds = [b"epoch", config.key().as_ref(), &epoch.opens_at.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, EpochAccount>>,
    #[account(init, payer = owner, space = LOT_SPACE, seeds = [b"lot", epoch.key().as_ref(), &nonce.to_le_bytes()], bump)]
    pub lot: Box<Account<'info, LotAccount>>,
    #[account(mut, constraint = source.owner == owner.key(), constraint = source.mint == config.mint || Some(source.mint) == config.test_mint)]
    pub source: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault", epoch.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"test-vault", epoch.key().as_ref()], bump)]
    pub test_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(address = config.operator)]
    pub operator: Signer<'info>,
    #[account(seeds = [b"config", config.admin.as_ref(), &config.config_id.to_le_bytes()], bump = config.bump)]
    pub config: Account<'info, PoolConfig>,
    #[account(mut, has_one = config, has_one = vault, has_one = test_vault, seeds = [b"epoch", config.key().as_ref(), &epoch.opens_at.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, EpochAccount>>,
    #[account(mut, has_one = epoch, seeds = [b"lot", epoch.key().as_ref(), &lot.nonce.to_le_bytes()], bump = lot.bump)]
    pub lot: Box<Account<'info, LotAccount>>,
    #[account(seeds = [b"vault", epoch.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(seeds = [b"test-vault", epoch.key().as_ref()], bump)]
    pub test_vault: Account<'info, TokenAccount>,
    #[account(has_one = config, constraint = snapshot.sealed @ EpochError::InvalidSnapshot,
        seeds = [b"snapshot", config.key().as_ref(), &snapshot.sequence.to_le_bytes()], bump = snapshot.bump)]
    pub snapshot: Account<'info, SnapshotAccount>,
}

#[derive(Accounts)]
pub struct BeginClose<'info> {
    #[account(address = config.operator)]
    pub operator: Signer<'info>,
    #[account(seeds = [b"config", config.admin.as_ref(), &config.config_id.to_le_bytes()], bump = config.bump)]
    pub config: Account<'info, PoolConfig>,
    #[account(mut, has_one = config, has_one = vault, has_one = test_vault, seeds = [b"epoch", config.key().as_ref(), &epoch.opens_at.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, EpochAccount>>,
    #[account(seeds = [b"vault", epoch.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(seeds = [b"test-vault", epoch.key().as_ref()], bump)]
    pub test_vault: Account<'info, TokenAccount>,
    #[account(has_one = config, constraint = snapshot.sealed @ EpochError::InvalidSnapshot,
        seeds = [b"snapshot", config.key().as_ref(), &snapshot.sequence.to_le_bytes()], bump = snapshot.bump)]
    pub snapshot: Account<'info, SnapshotAccount>,
}

#[derive(Accounts)]
pub struct ManageLot<'info> {
    #[account(seeds = [b"config", config.admin.as_ref(), &config.config_id.to_le_bytes()], bump = config.bump)]
    pub config: Account<'info, PoolConfig>,
    #[account(mut, has_one = config, has_one = vault, has_one = test_vault, seeds = [b"epoch", config.key().as_ref(), &epoch.opens_at.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, EpochAccount>>,
    #[account(mut, has_one = epoch, seeds = [b"lot", epoch.key().as_ref(), &lot.nonce.to_le_bytes()], bump = lot.bump)]
    pub lot: Box<Account<'info, LotAccount>>,
    #[account(seeds = [b"vault", epoch.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(seeds = [b"test-vault", epoch.key().as_ref()], bump)]
    pub test_vault: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct ManageSettlement<'info> {
    #[account(seeds = [b"config", config.admin.as_ref(), &config.config_id.to_le_bytes()], bump = config.bump)]
    pub config: Account<'info, PoolConfig>,
    #[account(mut, has_one = config, has_one = vault, has_one = test_vault, seeds = [b"epoch", config.key().as_ref(), &epoch.opens_at.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, EpochAccount>>,
    #[account(seeds = [b"vault", epoch.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(seeds = [b"test-vault", epoch.key().as_ref()], bump)]
    pub test_vault: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [b"config", config.admin.as_ref(), &config.config_id.to_le_bytes()], bump = config.bump)]
    pub config: Account<'info, PoolConfig>,
    #[account(mut, has_one = config, has_one = vault, has_one = test_vault, seeds = [b"epoch", config.key().as_ref(), &epoch.opens_at.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, EpochAccount>>,
    #[account(mut, has_one = epoch, seeds = [b"lot", epoch.key().as_ref(), &lot.nonce.to_le_bytes()], bump = lot.bump)]
    pub lot: Box<Account<'info, LotAccount>>,
    #[account(mut, seeds = [b"vault", epoch.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"test-vault", epoch.key().as_ref()], bump)]
    pub test_vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = destination.owner == owner.key(), constraint = destination.mint == config.mint || Some(destination.mint) == config.test_mint)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    #[account(address = config.admin)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config", config.admin.as_ref(), &config.config_id.to_le_bytes()], bump = config.bump)]
    pub config: Account<'info, PoolConfig>,
    #[account(mut, has_one = config, has_one = vault, has_one = test_vault, seeds = [b"epoch", config.key().as_ref(), &epoch.opens_at.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, EpochAccount>>,
    #[account(mut, seeds = [b"vault", epoch.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"test-vault", epoch.key().as_ref()], bump)]
    pub test_vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = destination.owner == admin.key(), constraint = destination.mint == config.mint || Some(destination.mint) == config.test_mint)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

fn bound_origins(epoch: &EpochAccount) -> Result<Vec<u128>> {
    match epoch.binding_version {
        0 => Ok(Vec::new()),
        1 => {
            let state = epoch.state.as_ref().ok_or(EpochError::UnsealedEpoch)?;
            require!(epoch.registry_version != Pubkey::default() && epoch.universe_digest != [0; 32]
                && epoch.registry_origin_benchmarks.len() == state.universe().len()
                && epoch.registry_origin_benchmarks.iter().all(|value| *value > 0 && *value <= math::MAX_REFERENCE), EpochError::InvalidRegistry);
            Ok(epoch.registry_origin_benchmarks.clone())
        }
        _ => err!(EpochError::InvalidRegistry),
    }
}

fn config_lifecycle(config: &PoolConfig) -> Result<ConfigLifecycle> {
    match config.lifecycle_version {
        0 => Ok(ConfigLifecycle::Active),
        1 => Ok(config.lifecycle),
        _ => err!(EpochError::InvalidConfiguration),
    }
}

fn require_preparable(config: &PoolConfig) -> Result<()> {
    require!(config_lifecycle(config)? != ConfigLifecycle::Archived, EpochError::Archived);
    Ok(())
}

fn require_active(config: &PoolConfig) -> Result<()> {
    require!(config_lifecycle(config)? == ConfigLifecycle::Active, EpochError::Inactive);
    Ok(())
}

fn require_legacy_active(config: &PoolConfig) -> Result<()> {
    require_active(config)?;
    require!(config.asset_registry == Pubkey::default(), EpochError::InvalidRegistry);
    Ok(())
}

fn require_current_time(opens_at: u64) -> Result<()> {
    let timestamp = now()?;
    require!(opens_at % engine::EPOCH_SECONDS == 0 && timestamp >= opens_at
        && timestamp < opens_at.checked_add(engine::EPOCH_SECONDS).ok_or(EpochError::InvalidTime)?, EpochError::InvalidTime);
    Ok(())
}

fn validate_registry_interval(registry: &Account<cox::AssetRegistry>, version: Pubkey, _opening: u64) -> Result<()> {
    let (key, bump) = Pubkey::find_program_address(&[b"asset-registry", &registry.generation], &cox::ID);
    require!(key == registry.key() && registry.bump == bump && registry.schema_version == 1, EpochError::InvalidRegistry);
    require!(version != Pubkey::default(), EpochError::InvalidRegistry);
    Ok(())
}

fn read_registry_version(info: &AccountInfo) -> Result<cox::AssetRegistryVersion> {
    require_keys_eq!(*info.owner, cox::ID, EpochError::InvalidRegistry);
    cox::AssetRegistryVersion::try_deserialize(&mut info.try_borrow_data()?.as_ref())
}

fn validate_current_draft(accounts: &ManageCurrentEpochDraft) -> Result<cox::UniverseVersion> {
    require_preparable(&accounts.config)?;
    require_current_time(accounts.epoch.opens_at)?;
    require!(accounts.epoch.binding_version == 1 && accounts.epoch.state.is_none() && accounts.config.asset_registry != Pubkey::default(), EpochError::Immutable);
    validate_registry_interval(&accounts.asset_registry, accounts.registry_version.key(), accounts.epoch.opens_at)?;
    let version = read_registry_version(&accounts.registry_version.to_account_info())?;
    require!(version.digest == accounts.epoch.universe_digest
        && (version.effective_until != 0 || accounts.asset_registry.active_version == accounts.registry_version.key()), EpochError::InvalidRegistry);
    cox::validate_registry_version(&accounts.registry_version.to_account_info(), &accounts.methodology.to_account_info(),
        accounts.config.asset_registry, accounts.asset_registry.generation, accounts.epoch.opens_at)
}

fn state_config(config: &PoolConfig, key: Pubkey) -> engine::Config {
    engine::Config { pool: key.to_bytes(), admin: config.admin.to_bytes(), operator: config.operator.to_bytes(),
        collateral_mint: config.mint.to_bytes(), collateral_decimals: math::COLLATERAL_DECIMALS,
        methodology: config.methodology, origin_benchmark: config.origin_benchmark,
        max_entry_price_age: config.max_entry_price_age, max_lots: config.max_lots }
}

fn now() -> Result<u64> { u64::try_from(Clock::get()?.unix_timestamp).map_err(|_| error!(EpochError::InvalidTime)) }

fn map_engine<T>(value: engine::Result<T>) -> Result<T> {
    value.map_err(|reason| { msg!("Epoch transition rejected: {:?}", reason); error!(EpochError::TransitionRejected) })
}

fn validate_vault(vault: &TokenAccount, authority: Pubkey, mint: Pubkey) -> Result<()> {
    require!(vault.owner == authority && vault.mint == mint && vault.delegate == COption::None
        && vault.close_authority == COption::None && vault.is_native == COption::None,
        EpochError::InvalidCollateral);
    require!(vault.state == token::spl_token::state::AccountState::Initialized, EpochError::InvalidCollateral);
    Ok(())
}

fn withdraw_claim(ctx: Context<Withdraw>, amount: Option<u64>) -> Result<()> {
        reconcile(&mut ctx.accounts.epoch, &ctx.accounts.vault, &ctx.accounts.test_vault, &ctx.accounts.config)?;
        let state = ctx.accounts.epoch.state.as_mut().ok_or(EpochError::UnsealedEpoch)?;
        let lot = ctx.accounts.lot.state.as_mut().ok_or(EpochError::InvalidLot)?;
        let balance = vault_total(&ctx.accounts.vault, &ctx.accounts.test_vault)?;
        let amount = map_engine(match amount {
            Some(value) => state.withdraw_partial(ctx.accounts.owner.key().to_bytes(), lot, value, balance),
            None => state.withdraw(ctx.accounts.owner.key().to_bytes(), lot, balance),
        })?;
        let config_key = ctx.accounts.config.key();
        let opens_at = ctx.accounts.epoch.opens_at.to_le_bytes();
        let bump = [ctx.accounts.epoch.bump];
        let signer: &[&[u8]] = &[b"epoch", config_key.as_ref(), &opens_at, &bump];
        let withdrawal_vault = if ctx.accounts.destination.mint == ctx.accounts.config.mint { &ctx.accounts.vault } else { &ctx.accounts.test_vault };
        if amount > 0 {
            token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
                from: withdrawal_vault.to_account_info(), to: ctx.accounts.destination.to_account_info(), authority: ctx.accounts.epoch.to_account_info(),
            }, &[signer]), amount)?;
        }
        ctx.accounts.vault.reload()?;
        ctx.accounts.test_vault.reload()?;
        map_engine(ctx.accounts.epoch.state.as_ref().ok_or(EpochError::UnsealedEpoch)?.ledger().check(vault_total(&ctx.accounts.vault, &ctx.accounts.test_vault)?))
    }


fn vault_total(vault: &TokenAccount, test_vault: &TokenAccount) -> Result<u64> {
    vault.amount.checked_add(test_vault.amount).ok_or_else(|| error!(EpochError::InvalidCollateral))
}

fn reconcile(epoch: &mut Account<EpochAccount>, vault: &Account<TokenAccount>, test_vault: &Account<TokenAccount>, config: &PoolConfig) -> Result<()> {
    validate_vault(vault, epoch.key(), config.mint)?;
    validate_vault(test_vault, epoch.key(), config.test_mint.unwrap_or(config.mint))?;
    map_engine(epoch.state.as_mut().ok_or(EpochError::UnsealedEpoch)?.reconcile_surplus(vault_total(vault, test_vault)?))?;
    Ok(())
}

fn select_snapshot(epoch: &Epoch, snapshot: &SnapshotAccount) -> Result<OperatorSnapshot> {
    require!(snapshot.sealed && snapshot.digest != [0; 32], EpochError::InvalidSnapshot);
    Ok(OperatorSnapshot { id: snapshot.digest, methodology: snapshot.methodology, sequence: snapshot.sequence,
        oracle_timestamp: snapshot.oracle_timestamp, benchmark: snapshot.benchmark,
        prices: snapshot.prices.iter().filter(|price| epoch.universe().iter().any(|asset| asset.id == price.asset_id)).cloned().collect() })
}

struct SerializedLength(usize);
impl std::io::Write for SerializedLength {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self.0.checked_add(bytes.len()).ok_or(std::io::ErrorKind::InvalidData)?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}

fn check_space<T: AnchorSerialize>(value: &T, account: &AccountInfo) -> Result<()> {
    let mut size = SerializedLength(8);
    value.serialize(&mut size)?;
    require!(size.0 <= account.data_len(), EpochError::InsufficientSpace);
    Ok(())
}

fn grow<'info>(account: &AccountInfo<'info>, payer: &AccountInfo<'info>, system: &AccountInfo<'info>,
    additional_bytes: u32, maximum: usize) -> Result<()> {
    let additional = additional_bytes as usize;
    let target = account.data_len().checked_add(additional).ok_or(EpochError::InsufficientSpace)?;
    require!(additional > 0 && additional <= MAX_GROWTH && target <= maximum, EpochError::InsufficientSpace);
    let rent = Rent::get()?.minimum_balance(target);
    if account.lamports() < rent {
        anchor_lang::system_program::transfer(CpiContext::new(system.clone(), anchor_lang::system_program::Transfer {
            from: payer.clone(), to: account.clone(),
        }), rent - account.lamports())?;
    }
    account.realloc(target, true)?;
    Ok(())
}

#[error_code]
pub enum EpochError {
    InvalidConfiguration,
    InvalidCollateral,
    InvalidTime,
    InvalidPage,
    InvalidSnapshot,
    InvalidLot,
    Immutable,
    InsufficientSpace,
    UnsealedEpoch,
    TransitionRejected,
    DualCollateralDisabled,
    InvalidRegistry,
    Inactive,
    Archived,
}
