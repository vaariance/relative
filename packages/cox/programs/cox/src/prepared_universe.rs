use crate::*;
use anchor_lang::solana_program::sysvar::instructions::{load_current_index_checked, load_instruction_at_checked};

#[account]
#[derive(Debug)]
pub struct UniverseHandoff {
    pub schema_version: u16,
    pub bump: u8,
    pub pool: Pubkey,
    pub schedule: Pubkey,
    pub methodology: Pubkey,
    pub predecessor_sequence: u64,
    pub predecessor_state_digest: [u8; 32],
    pub sequence: u64,
    pub snapshot_digest: [u8; 32],
    pub timestamp: u64,
    pub benchmark: i128,
    pub accepted_at: u64,
    pub effective_from: u64,
    pub committed_state_digest: [u8; 32],
    pub prices_e8: Vec<u64>,
}

pub fn prepare_universe_schedule(ctx: Context<ScheduleUniverse>, version: u64, identities_digest: [u8;32], expected_instruments: u16, activation_timestamp: u64, expires_at: u64) -> Result<()> {
    let p = &ctx.accounts.pool;
    ensure_pool_mutable(p)?;
    let previous = read_dynamic_manifest(&ctx.accounts.methodology)?;
    require!(p.schema_version == 5 && version == add(previous.version,1)? && identities_digest != [0;32]
        && usize::from(expected_instruments) > previous.instruments.len() && usize::from(expected_instruments) <= DYNAMIC_MAX_ASSETS
        && activation_timestamp > now()? && activation_timestamp > add(p.origin,p.last_batch)?
        && expires_at >= activation_timestamp && expires_at <= add(activation_timestamp,86_400)?, CoxError::InvalidManifest);
    if p.asset_registry != Pubkey::default() {
        let registry = ctx.accounts.asset_registry.as_ref().ok_or(CoxError::InvalidAccount)?;
        validate_bound_registry(registry,p,p.key())?;
        require!(registry.pending_activation == 0 && registry.active_digest == previous.digest, CoxError::BatchBusy);
    }
    let s = &mut ctx.accounts.schedule;
    require!(s.schema_version == 0 || s.cancelled && !s.consumed || s.schema_version == 2 && !s.consumed && now()? > s.expires_at, CoxError::AlreadyProcessed);
    s.schema_version=2; s.bump=ctx.bumps.schedule; s.pool=p.key(); s.predecessor_digest=previous.digest;
    s.source_methodology=previous.source_methodology; s.version=version; s.identities_digest=identities_digest;
    s.expected_instruments=expected_instruments; s.activation_timestamp=activation_timestamp; s.expires_at=expires_at;
    s.cancelled=false; s.consumed=false;
    Ok(())
}

#[derive(Accounts)]
pub struct BeginUniverseHandoff<'info> {
    #[account(mut)]
    pub runtime: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=runtime)]
    pub registry: Account<'info, Registry>,
    #[account(seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=methodology,constraint=pool.stage==Some(batch.key()) @ CoxError::BatchBusy)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds=[b"batch",pool.key().as_ref()],bump=batch.bump,has_one=pool)]
    pub batch: Box<Account<'info, Batch>>,
    #[account(seeds=[b"methodology",methodology.digest.as_ref()],bump=methodology.bump)]
    pub methodology: Box<Account<'info, Methodology>>,
    #[account(seeds=[b"methodology",next_methodology.digest.as_ref()],bump=next_methodology.bump)]
    pub next_methodology: Box<Account<'info, Methodology>>,
    #[account(seeds=[b"universe-schedule",pool.key().as_ref(),schedule.version.to_le_bytes().as_ref()],bump=schedule.bump,has_one=pool)]
    pub schedule: Box<Account<'info, UniverseSchedule>>,
    #[account(init_if_needed,payer=runtime,space=8192,seeds=[b"universe-handoff",pool.key().as_ref(),next_methodology.digest.as_ref()],bump)]
    pub handoff: Box<Account<'info, UniverseHandoff>>,
    pub system_program: Program<'info, System>,
}

pub fn begin_handoff(ctx: Context<BeginUniverseHandoff>) -> Result<()> {
    let p=&ctx.accounts.pool; let b=&ctx.accounts.batch; let s=&ctx.accounts.schedule;
    ensure_pool_mutable(p)?;
    require!(!ctx.accounts.registry.paused && p.schema_version==5 && s.schema_version==2, CoxError::InvalidManifest);
    s.eligible(p.key(),now()?)?;
    let previous=read_dynamic_manifest(&ctx.accounts.methodology)?;
    let next=read_dynamic_manifest(&ctx.accounts.next_methodology)?;
    s.validate_successor(&previous,&next)?;
    require!(next.instruments.starts_with(&previous.instruments) && next.instruments.len()>previous.instruments.len()
        && next.operator==ctx.accounts.runtime.key() && b.schema_version==4 && b.phase==DynamicPhase::Prices as u8
        && b.prices.is_empty() && b.predecessor_sequence==p.sequence && b.predecessor_digest==p.state_digest
        && b.sequence==add(p.sequence,1)? && b.cutoff>=s.activation_timestamp
        && now()? >= b.cutoff && now()? <= add(b.cutoff,5)?, CoxError::WrongPredecessor);
    let h=&mut ctx.accounts.handoff;
    require!(h.schema_version==0 || h.effective_from==0, CoxError::AlreadyProcessed);
    if h.schema_version!=0 && h.sequence==b.sequence && h.snapshot_digest==b.snapshot_digest {
        require!(h.pool==p.key() && h.schedule==s.key() && h.methodology==ctx.accounts.next_methodology.key(), CoxError::InvalidAccount);
        return Ok(());
    }
    h.schema_version=1; h.bump=ctx.bumps.handoff; h.pool=p.key(); h.schedule=s.key(); h.methodology=ctx.accounts.next_methodology.key();
    h.predecessor_sequence=b.predecessor_sequence; h.predecessor_state_digest=b.predecessor_digest;
    h.sequence=b.sequence; h.snapshot_digest=b.snapshot_digest; h.timestamp=b.cutoff; h.benchmark=b.benchmark;
    h.accepted_at=b.accepted_at; h.effective_from=0; h.committed_state_digest=[0;32]; h.prices_e8.clear();
    Ok(())
}

#[derive(Accounts)]
pub struct AppendUniverseHandoffPrices<'info> {
    pub runtime: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=runtime)]
    pub registry: Account<'info, Registry>,
    #[account(seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=methodology,constraint=pool.stage==Some(batch.key()) @ CoxError::BatchBusy)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds=[b"batch",pool.key().as_ref()],bump=batch.bump,has_one=pool)]
    pub batch: Box<Account<'info, Batch>>,
    #[account(seeds=[b"methodology",methodology.digest.as_ref()],bump=methodology.bump)]
    pub methodology: Box<Account<'info, Methodology>>,
    #[account(seeds=[b"methodology",next_methodology.digest.as_ref()],bump=next_methodology.bump)]
    pub next_methodology: Box<Account<'info, Methodology>>,
    #[account(mut,seeds=[b"universe-handoff",pool.key().as_ref(),next_methodology.digest.as_ref()],bump=handoff.bump,has_one=pool)]
    pub handoff: Box<Account<'info, UniverseHandoff>>,
}

fn validate_handoff_batch(h:&UniverseHandoff,b:&Batch) -> Result<()> {
    require!(h.schema_version==1 && h.effective_from==0 && h.sequence==b.sequence && h.snapshot_digest==b.snapshot_digest
        && h.predecessor_sequence==b.predecessor_sequence && h.predecessor_state_digest==b.predecessor_digest
        && h.timestamp==b.cutoff && h.benchmark==b.benchmark && h.accepted_at==b.accepted_at, CoxError::WrongPredecessor);
    Ok(())
}

pub fn append_handoff_prices(ctx: Context<AppendUniverseHandoffPrices>, offset:u16, prices:Vec<u64>) -> Result<()> {
    ensure_pool_mutable(&ctx.accounts.pool)?;
    let previous=read_dynamic_manifest(&ctx.accounts.methodology)?;
    let next=read_dynamic_manifest(&ctx.accounts.next_methodology)?;
    let h=&mut ctx.accounts.handoff;
    validate_handoff_batch(h,&ctx.accounts.batch)?;
    require!(h.methodology==ctx.accounts.next_methodology.key() && offset as usize==h.prices_e8.len()
        && !prices.is_empty() && prices.len()<=16 && prices.iter().all(|p|*p>0)
        && h.prices_e8.len()+prices.len()<=next.instruments.len().checked_sub(previous.instruments.len()).ok_or(CoxError::InvalidRoster)?, CoxError::InvalidPrice);
    h.prices_e8.extend(prices);
    require_account_capacity(&h.to_account_info(),&***h)
}

#[derive(Accounts)]
pub struct ActivatePreparedUniverse<'info> {
    pub runtime: Signer<'info>,
    #[account(seeds=[b"registry"],bump=registry.bump,has_one=runtime)]
    pub registry: Account<'info, Registry>,
    #[account(mut,seeds=[b"pool",pool.pool_id.to_le_bytes().as_ref()],bump=pool.bump,has_one=registry,has_one=methodology,has_one=vault)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds=[b"batch",pool.key().as_ref()],bump=batch.bump,has_one=pool)]
    pub batch: Box<Account<'info, Batch>>,
    #[account(seeds=[b"methodology",methodology.digest.as_ref()],bump=methodology.bump)]
    pub methodology: Box<Account<'info, Methodology>>,
    #[account(seeds=[b"methodology",next_methodology.digest.as_ref()],bump=next_methodology.bump)]
    pub next_methodology: Box<Account<'info, Methodology>>,
    #[account(mut,seeds=[b"universe-schedule",pool.key().as_ref(),schedule.version.to_le_bytes().as_ref()],bump=schedule.bump,has_one=pool)]
    pub schedule: Box<Account<'info, UniverseSchedule>>,
    #[account(mut,seeds=[b"universe-handoff",pool.key().as_ref(),next_methodology.digest.as_ref()],bump=handoff.bump,has_one=pool)]
    pub handoff: Box<Account<'info, UniverseHandoff>>,
    #[account(token::authority=pool,token::mint=pool.collateral_mint)]
    pub vault: Account<'info, TokenAccount>,
    #[account(address=anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub test_vault: Option<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub asset_registry: Option<Box<Account<'info, AssetRegistry>>>,
    #[account(mut)]
    pub next_registry_version: Option<Box<Account<'info, AssetRegistryVersion>>>,
    #[account(mut)]
    pub previous_registry_version: Option<Box<Account<'info, AssetRegistryVersion>>>,
}

pub fn activate_prepared(ctx: Context<ActivatePreparedUniverse>) -> Result<()> {
    let p=&mut ctx.accounts.pool; let b=&ctx.accounts.batch; let h=&mut ctx.accounts.handoff;
    ensure_pool_mutable(p)?;
    require!(!ctx.accounts.registry.paused && p.schema_version==5 && p.stage.is_none() && ctx.accounts.schedule.schema_version==2, CoxError::BatchBusy);
    let timestamp=now()?;
    require!(timestamp%14_400!=0, CoxError::TooEarly);
    ctx.accounts.schedule.eligible(p.key(),timestamp)?;
    validate_handoff_batch(h,b)?;
    require!(b.phase==2 && b.sequence==p.sequence && b.batch_id==p.last_batch && b.benchmark==p.benchmark
        && h.methodology==ctx.accounts.next_methodology.key() && h.schedule==ctx.accounts.schedule.key()
        && h.timestamp==add(p.origin,p.last_batch)? && h.timestamp<=timestamp && h.accepted_at>=h.timestamp && h.accepted_at<=add(h.timestamp,5)?, CoxError::WrongPredecessor);
    let index=load_current_index_checked(&ctx.accounts.instructions.to_account_info())?;
    require!(index>0, CoxError::InvalidAccount);
    let preceding=load_instruction_at_checked((index-1) as usize,&ctx.accounts.instructions.to_account_info())?;
    let discriminator=anchor_lang::solana_program::hash::hash(b"global:finalize").to_bytes();
    require!(preceding.program_id==crate::ID && preceding.data.as_slice()==&discriminator[..8]
        && preceding.accounts.get(1).is_some_and(|a|a.pubkey==ctx.accounts.registry.key())
        && preceding.accounts.get(2).is_some_and(|a|a.pubkey==p.key())
        && preceding.accounts.get(3).is_some_and(|a|a.pubkey==b.key())
        && preceding.accounts.get(4).is_some_and(|a|a.pubkey==ctx.accounts.methodology.key()), CoxError::InvalidAccount);
    reconcile(p,&ctx.accounts.vault,ctx.accounts.test_vault.as_ref())?;
    let previous=read_dynamic_manifest(&ctx.accounts.methodology)?;
    let next=read_dynamic_manifest(&ctx.accounts.next_methodology)?;
    ctx.accounts.schedule.validate_successor(&previous,&next)?;
    require!(next.operator==ctx.accounts.runtime.key() && next.instruments.starts_with(&previous.instruments)
        && next.instruments.len()>previous.instruments.len() && b.prices.len()==previous.instruments.len()
        && b.prices.iter().map(|v|v.price_e8).eq(p.last_prices.iter().copied())
        && h.prices_e8.len()==next.instruments.len()-previous.instruments.len(), CoxError::InvalidPrice);
    let added=h.prices_e8.clone();
    for (instrument,price) in next.instruments.iter().skip(previous.instruments.len()).zip(&added) {
        let scaled=|a:i128,b:i128,c:i128|->Result<i128> { mm(math::rounded_div(a.checked_mul(b).ok_or(CoxError::ArithmeticOverflow)?,c)) };
        let since_asset=scaled(*price as i128,math::SCALE,instrument.original_price_e8 as i128)?;
        let since_benchmark=scaled(p.benchmark,math::SCALE,instrument.original_benchmark)?;
        let relative=scaled(100*math::SCALE,since_asset,since_benchmark)?;
        require!(relative>0,CoxError::InvalidPrice);
        p.origin_prices.push(instrument.original_price_e8); p.last_prices.push(*price); p.references.push(relative); p.classes.push(Class::default());
    }
    p.methodology=ctx.accounts.next_methodology.key();
    if p.asset_registry!=Pubkey::default() {
        let registry=ctx.accounts.asset_registry.as_mut().ok_or(CoxError::InvalidAccount)?;
        validate_bound_registry(registry,p,p.key())?;
        let version=ctx.accounts.next_registry_version.as_mut().ok_or(CoxError::InvalidAccount)?;
        require!(!version.sealed && version.effective_from==next.capture.timestamp,CoxError::InvalidManifest);
        version.schema_version=2; version.effective_from=timestamp;
        apply_registry_activation(registry,version,ctx.accounts.previous_registry_version.as_deref_mut(),p,p.key(),ctx.accounts.next_methodology.key(),next.digest)?;
    }
    h.prices_e8=b.prices.iter().map(|v|v.price_e8).chain(added).collect();
    h.effective_from=timestamp; h.committed_state_digest=p.state_digest;
    ctx.accounts.schedule.consumed=true;
    require_account_capacity(&p.to_account_info(),&***p)?;
    require_account_capacity(&h.to_account_info(),&***h)?;
    emit!(PreparedUniverseActivated {pool:p.key(),version:next.version,digest:next.digest,anchor:h.key(),capture_timestamp:next.capture.timestamp,handoff_timestamp:h.timestamp,effective_from:timestamp});
    Ok(())
}

#[event]
pub struct PreparedUniverseActivated { pub pool:Pubkey,pub version:u64,pub digest:[u8;32],pub anchor:Pubkey,pub capture_timestamp:u64,pub handoff_timestamp:u64,pub effective_from:u64 }
