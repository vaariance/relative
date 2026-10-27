use crate::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum InstanceLifecycle { #[default] Preparing, Active, Archived }

pub fn pool_lifecycle(pool: &Pool) -> Result<InstanceLifecycle> {
    match pool.lifecycle_version {
        0 => Ok(if pool.schema_version == 3 { InstanceLifecycle::Archived } else { InstanceLifecycle::Active }),
        1 => Ok(pool.lifecycle),
        _ => err!(CoxError::InvalidAccount),
    }
}
pub fn ensure_pool_mutable(pool: &Pool) -> Result<()> {
    require!(pool_lifecycle(pool)? != InstanceLifecycle::Archived, CoxError::PoolRetired);
    Ok(())
}
pub fn ensure_pool_active(pool: &Pool) -> Result<()> {
    require!(pool_lifecycle(pool)? == InstanceLifecycle::Active, CoxError::Paused);
    Ok(())
}

#[account]
#[derive(Debug)]
pub struct AssetRegistry {
    pub schema_version: u16,
    pub bump: u8,
    pub generation: [u8; 32],
    pub authority_registry: Pubkey,
    pub source_pool: Pubkey,
    pub active_version: Pubkey,
    pub active_digest: [u8; 32],
    pub active_from: u64,
    pub pending_activation: u64,
}
#[account]
#[derive(Debug)]
pub struct AssetRegistryVersion {
    pub schema_version: u16,
    pub bump: u8,
    pub registry: Pubkey,
    pub generation: [u8; 32],
    pub methodology: Pubkey,
    pub digest: [u8; 32],
    pub predecessor: [u8; 32],
    pub effective_from: u64,
    pub effective_until: u64,
    pub sealed: bool,
}

pub fn validate_registry_version(version_info: &AccountInfo, methodology_info: &AccountInfo, registry: Pubkey, generation: [u8; 32], opening: u64) -> Result<UniverseVersion> {
    require_keys_eq!(*version_info.owner, crate::ID, CoxError::InvalidAccount);
    require_keys_eq!(*methodology_info.owner, crate::ID, CoxError::InvalidAccount);
    let version = AssetRegistryVersion::try_deserialize(&mut version_info.try_borrow_data()?.as_ref())?;
    require!(matches!(version.schema_version, 1 | 2) && version.sealed && version.registry == registry && version.generation == generation
        && version.effective_from <= opening && (version.effective_until == 0 || opening < version.effective_until), CoxError::InvalidManifest);
    require_keys_eq!(Pubkey::find_program_address(&[b"asset-version", registry.as_ref(), version.digest.as_ref()], &crate::ID).0, version_info.key(), CoxError::InvalidAccount);
    require_keys_eq!(version.methodology, methodology_info.key(), CoxError::InvalidAccount);
    let methodology = Methodology::try_deserialize(&mut methodology_info.try_borrow_data()?.as_ref())?;
    require_keys_eq!(Pubkey::find_program_address(&[b"methodology", methodology.digest.as_ref()], &crate::ID).0, methodology_info.key(), CoxError::InvalidAccount);
    require!(methodology.digest == version.digest, CoxError::InvalidManifest);
    let universe = read_dynamic_manifest(&methodology)?;
    require!(if version.schema_version == 1 { universe.capture.timestamp == version.effective_from } else { universe.capture.timestamp <= version.effective_from }, CoxError::InvalidManifest);
    Ok(universe)
}

#[derive(Accounts)]
pub struct SealGenesisMethodology<'info> {
    pub runtime: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=runtime)]
    pub registry: Account<'info, Registry>,
    #[account(mut,seeds=[b"methodology",methodology.digest.as_ref()],bump=methodology.bump)]
    pub methodology: Account<'info, Methodology>,
}
pub fn seal_genesis(ctx: Context<SealGenesisMethodology>) -> Result<()> {
    let m = &mut ctx.accounts.methodology;
    require!(!m.sealed && m.schema_version == 3 && m.canonical.len() == m.expected_length as usize, CoxError::InvalidManifest);
    let universe = UniverseVersion::from_canonical(&m.canonical)?;
    require!(universe.digest == m.digest && universe.operator == ctx.accounts.runtime.key() && universe.version == 1
        && universe.schema_version == 2 && universe.predecessor_digest == [0;32] && universe.capture.predecessor_sequence == 0 && universe.capture.predecessor_state_digest == [0;32]
        && universe.capture.benchmark == 100 * math::SCALE, CoxError::InvalidManifest);
    require!(universe.instruments.iter().zip(&universe.capture.prices_e8).all(|(i,p)| i.original_price_e8 == *p
        && i.original_benchmark == universe.capture.benchmark && i.original_timestamp == universe.capture.timestamp), CoxError::InvalidOrigin);
    m.origin = universe.capture.timestamp; m.roster = (0..universe.instruments.len()).map(|i| i as u8).collect();
    m.bybit = false; m.activation_batch = 0; m.sealed = true;
    Ok(())
}
pub fn initialize_fresh_dynamic_pool(ctx: Context<InitializePool>, pool_id: u64, trading_opens_at: u64) -> Result<()> {
    let universe = read_dynamic_manifest(&ctx.accounts.methodology)?;
    require!(pool_id == ctx.accounts.registry.next_pool_id, CoxError::Replay);
    require!(universe.schema_version == 2 && universe.version == 1 && universe.predecessor_digest == [0;32] && universe.pool == ctx.accounts.pool.key()
        && universe.operator == ctx.accounts.registry.runtime && universe.capture.predecessor_sequence == 0 && universe.capture.predecessor_state_digest == [0;32]
        && universe.capture.benchmark == 100 * math::SCALE && trading_opens_at >= universe.capture.timestamp
        && ctx.accounts.mint.decimals == 6, CoxError::InvalidOrigin);
    let p = &mut ctx.accounts.pool;
    p.schema_version = 5; p.bump = ctx.bumps.pool; p.pool_id = pool_id; p.registry = ctx.accounts.registry.key();
    p.methodology = ctx.accounts.methodology.key(); p.collateral_mint = ctx.accounts.mint.key(); p.vault = ctx.accounts.vault.key();
    p.origin = universe.capture.timestamp; p.benchmark = 100 * math::SCALE; p.trading_opens_at = trading_opens_at;
    p.lifecycle_version = 1; p.lifecycle = InstanceLifecycle::Preparing; p.crypto_class = universe.crypto_class();
    p.fee_version = 1; p.fee_next_version = 1; p.fee_bps = 2; p.fee_cap = 200_000; p.fee_initial_scheduled = true;
    ctx.accounts.registry.next_pool_id = add(ctx.accounts.registry.next_pool_id, 1)?;
    reconcile(p, &ctx.accounts.vault, ctx.accounts.test_vault.as_ref())
}
#[derive(Accounts)]
pub struct PrepareDynamicPool<'info> {
    pub admin: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=admin)]
    pub registry: Account<'info, Registry>,
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=methodology)]
    pub pool: Account<'info, Pool>,
    #[account(seeds=[b"methodology",methodology.digest.as_ref()],bump=methodology.bump)]
    pub methodology: Account<'info, Methodology>,
}
pub fn prepare_fresh_dynamic_pool(ctx: Context<PrepareDynamicPool>) -> Result<()> {
    let p = &mut ctx.accounts.pool;
    require!(p.schema_version == 5 && p.lifecycle_version == 1 && p.lifecycle == InstanceLifecycle::Preparing
        && !p.initialized && p.stage.is_none() && p.classes.is_empty(), CoxError::InvalidAccount);
    let universe = read_dynamic_manifest(&ctx.accounts.methodology)?;
    let n = universe.instruments.len();
    p.classes = vec![Class::default(); n+1]; p.references = vec![100 * math::SCALE; n+1];
    p.origin_prices = universe.capture.prices_e8.clone(); p.last_prices = universe.capture.prices_e8;
    require_account_capacity(&p.to_account_info(), &**p)
}
#[derive(Accounts)]
pub struct ManagePoolLifecycle<'info> {
    pub admin: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=admin)]
    pub registry: Account<'info, Registry>,
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry)]
    pub pool: Account<'info, Pool>,
    #[account(seeds=[b"asset-registry",asset_registry.generation.as_ref()],bump=asset_registry.bump,constraint=asset_registry.source_pool==pool.key() @ CoxError::InvalidAccount)]
    pub asset_registry: Option<Account<'info, AssetRegistry>>,
}
pub fn change_pool_lifecycle(ctx: Context<ManagePoolLifecycle>, lifecycle: InstanceLifecycle) -> Result<()> {
    let p = &mut ctx.accounts.pool;
    ensure_pool_mutable(p)?;
    require!(p.stage.is_none(), CoxError::BatchBusy);
    let previous = pool_lifecycle(p)?;
    require!(lifecycle != InstanceLifecycle::Preparing && (lifecycle == InstanceLifecycle::Archived || previous == InstanceLifecycle::Preparing), CoxError::InvalidAccount);
    if lifecycle == InstanceLifecycle::Active {
        let registry = ctx.accounts.asset_registry.as_ref().ok_or(CoxError::InvalidAccount)?;
        require!(p.initialized && now()? >= p.trading_opens_at && registry.key() == p.asset_registry
            && registry.active_version != Pubkey::default() && registry.generation == p.generation, CoxError::TooEarly);
    }
    if p.lifecycle_version == 0 { p.crypto_class = if p.schema_version == 5 { 30 } else { p.classes.len().saturating_sub(1) as u16 }; }
    p.lifecycle_version = 1; p.lifecycle = lifecycle;
    Ok(())
}
#[derive(Accounts)]
#[instruction(generation: [u8;32])]
pub struct InitializeAssetRegistry<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=admin)]
    pub registry: Account<'info, Registry>,
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry)]
    pub pool: Account<'info, Pool>,
    #[account(init,payer=admin,space=256,seeds=[b"asset-registry",generation.as_ref()],bump)]
    pub asset_registry: Account<'info, AssetRegistry>,
    pub system_program: Program<'info, System>,
}
pub fn create_asset_registry(ctx: Context<InitializeAssetRegistry>, generation: [u8;32]) -> Result<()> {
    let p = &mut ctx.accounts.pool;
    require!(generation != [0;32] && p.lifecycle_version == 1 && p.lifecycle == InstanceLifecycle::Preparing
        && p.asset_registry == Pubkey::default(), CoxError::InvalidAccount);
    let r = &mut ctx.accounts.asset_registry;
    r.schema_version = 1; r.bump = ctx.bumps.asset_registry; r.generation = generation;
    r.authority_registry = ctx.accounts.registry.key(); r.source_pool = p.key();
    p.generation = generation; p.asset_registry = r.key();
    Ok(())
}
#[derive(Accounts)]
pub struct RegisterAssetRegistryVersion<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry)]
    pub pool: Account<'info, Pool>,
    #[account(seeds=[b"asset-registry",asset_registry.generation.as_ref()],bump=asset_registry.bump,constraint=asset_registry.source_pool==pool.key() && asset_registry.authority_registry==registry.key() @ CoxError::InvalidAccount)]
    pub asset_registry: Account<'info, AssetRegistry>,
    #[account(seeds=[b"methodology",methodology.digest.as_ref()],bump=methodology.bump)]
    pub methodology: Account<'info, Methodology>,
    #[account(init,payer=payer,space=256,seeds=[b"asset-version",asset_registry.key().as_ref(),methodology.digest.as_ref()],bump)]
    pub version: Account<'info, AssetRegistryVersion>,
    pub system_program: Program<'info, System>,
}
pub fn create_registry_version(ctx: Context<RegisterAssetRegistryVersion>) -> Result<()> {
    ensure_pool_mutable(&ctx.accounts.pool)?;
    let universe = read_dynamic_manifest(&ctx.accounts.methodology)?;
    let registry = &ctx.accounts.asset_registry;
    require!(universe.pool == registry.source_pool && ctx.accounts.pool.asset_registry == registry.key()
        && universe.operator == ctx.accounts.registry.runtime, CoxError::InvalidManifest);
    let version = &mut ctx.accounts.version;
    version.schema_version = 1; version.bump = ctx.bumps.version; version.registry = registry.key();
    version.generation = registry.generation; version.methodology = ctx.accounts.methodology.key(); version.digest = universe.digest;
    version.predecessor = universe.predecessor_digest; version.effective_from = universe.capture.timestamp;
    Ok(())
}
#[derive(Accounts)]
pub struct ActivateAssetRegistryVersion<'info> {
    pub runtime: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=runtime)]
    pub registry: Account<'info, Registry>,
    #[account(seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=methodology)]
    pub pool: Account<'info, Pool>,
    #[account(seeds=[b"methodology",methodology.digest.as_ref()],bump=methodology.bump)]
    pub methodology: Account<'info, Methodology>,
    #[account(mut,seeds=[b"asset-registry",asset_registry.generation.as_ref()],bump=asset_registry.bump,constraint=asset_registry.source_pool==pool.key() && asset_registry.authority_registry==registry.key() @ CoxError::InvalidAccount)]
    pub asset_registry: Account<'info, AssetRegistry>,
    #[account(mut,seeds=[b"asset-version",asset_registry.key().as_ref(),version.digest.as_ref()],bump=version.bump,constraint=version.registry==asset_registry.key() @ CoxError::InvalidAccount)]
    pub version: Account<'info, AssetRegistryVersion>,
    #[account(mut)]
    pub previous_version: Option<Account<'info, AssetRegistryVersion>>,
}
pub fn apply_registry_activation(registry: &mut Account<AssetRegistry>, next: &mut Account<AssetRegistryVersion>, previous_version: Option<&mut Account<AssetRegistryVersion>>, pool: &Pool, pool_key: Pubkey, methodology: Pubkey, digest: [u8;32]) -> Result<()> {
    require!(!next.sealed && matches!(next.schema_version, 1 | 2) && next.generation == registry.generation
        && registry.source_pool == pool_key && pool.asset_registry == registry.key()
        && next.registry == registry.key() && next.methodology == pool.methodology && next.methodology == methodology
        && next.digest == digest && next.effective_from <= now()?
        && next.predecessor == registry.active_digest && pool.stage.is_none(), CoxError::InvalidManifest);
    require_keys_eq!(Pubkey::find_program_address(&[b"asset-version",registry.key().as_ref(),next.digest.as_ref()],&crate::ID).0,next.key(),CoxError::InvalidAccount);
    if registry.active_version == Pubkey::default() {
        require!(next.predecessor == [0;32] && previous_version.is_none() && next.effective_from == pool.origin, CoxError::InvalidManifest);
    } else {
        let previous = previous_version.ok_or(CoxError::InvalidAccount)?;
        require!(previous.key() == registry.active_version && previous.registry == registry.key()
            && previous.digest == registry.active_digest && previous.sealed && previous.effective_until == 0
            && next.effective_from > previous.effective_from && (next.schema_version == 2 && registry.pending_activation == 0 || next.schema_version == 1 && registry.pending_activation == next.effective_from), CoxError::WrongPredecessor);
        require_keys_eq!(Pubkey::find_program_address(&[b"asset-version",registry.key().as_ref(),previous.digest.as_ref()],&crate::ID).0,previous.key(),CoxError::InvalidAccount);
        previous.effective_until = next.effective_from;
    }
    next.sealed = true; registry.active_version = next.key(); registry.active_digest = next.digest; registry.active_from = next.effective_from; registry.pending_activation = 0;
    Ok(())
}
pub fn advance_asset_registry(ctx: Context<ActivateAssetRegistryVersion>) -> Result<()> {
    let p = &ctx.accounts.pool; ensure_pool_mutable(p)?;
    require!(ctx.accounts.asset_registry.active_version == Pubkey::default(), CoxError::AlreadyProcessed);
    apply_registry_activation(&mut ctx.accounts.asset_registry, &mut ctx.accounts.version, ctx.accounts.previous_version.as_mut(), p, p.key(), ctx.accounts.methodology.key(), ctx.accounts.methodology.digest)
}

pub fn validate_bound_registry(registry: &Account<AssetRegistry>, pool: &Pool, pool_key: Pubkey) -> Result<()> {
    require!(registry.schema_version == 1 && registry.key() == pool.asset_registry && registry.generation == pool.generation
        && registry.source_pool == pool_key && registry.authority_registry == pool.registry, CoxError::InvalidAccount);
    require_keys_eq!(Pubkey::find_program_address(&[b"asset-registry",registry.generation.as_ref()],&crate::ID).0,registry.key(),CoxError::InvalidAccount);
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeDynamicStaging<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(init,payer=payer,space=8192,seeds=[b"batch",pool.key().as_ref()],bump)]
    pub batch: Account<'info, Batch>,
    #[account(init,payer=payer,space=8192,seeds=[b"publication",pool.key().as_ref()],bump)]
    pub publication: Account<'info, Publication>,
    pub system_program: Program<'info, System>,
}
pub fn initialize_staging(ctx: Context<InitializeDynamicStaging>) -> Result<()> {
    let p = &ctx.accounts.pool;
    require!(p.schema_version == 5 && p.lifecycle_version == 1 && p.lifecycle == InstanceLifecycle::Preparing
        && !p.initialized && p.stage.is_none(), CoxError::InvalidAccount);
    Ok(())
}
