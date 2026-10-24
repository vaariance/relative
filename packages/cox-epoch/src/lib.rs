pub mod math;

use math::{COLLATERAL_DECIMALS, MAX_REFERENCE};
use std::collections::BTreeSet;

pub const EPOCH_SECONDS: u64 = 14_400;
pub const CLOSING_GRACE_SECONDS: u64 = 86_400;
pub const BASKET_SIZE: usize = 30;
pub const MAX_UNIVERSE: usize = 256;
pub const MAX_LOTS: u32 = 1_000_000;
pub type Key = [u8; 32];
pub type AssetId = u16;
pub type Result<T> = core::result::Result<T, Error>;

#[cfg_attr(feature = "borsh", derive(anchor_lang::AnchorSerialize, anchor_lang::AnchorDeserialize))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Unauthorized,
    InvalidAuthority,
    InvalidEpoch,
    InvalidUniverse,
    InvalidBasket,
    InvalidStake,
    InvalidReference,
    InvalidScore,
    InvalidSnapshot,
    IneligibleSnapshot,
    WrongEntry,
    WrongPhase,
    WrongLotState,
    InvalidNonce,
    EntryLimit,
    Overflow,
    DivisionByZero,
    Insolvent,
    ClosingDataExists,
    ClosingDataMissing,
    ScoresIncomplete,
}

#[cfg_attr(feature = "borsh", derive(anchor_lang::AnchorSerialize, anchor_lang::AnchorDeserialize))]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Asset {
    pub id: u16,
    pub feed_id: [u8; 32],
    pub origin_price: u128,
}

#[cfg_attr(feature = "borsh", derive(anchor_lang::AnchorSerialize, anchor_lang::AnchorDeserialize))]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Price {
    pub asset_id: u16,
    pub feed_id: [u8; 32],
    pub value: u128,
}

#[cfg_attr(feature = "borsh", derive(anchor_lang::AnchorSerialize, anchor_lang::AnchorDeserialize))]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperatorSnapshot {
    pub id: [u8; 32],
    pub methodology: [u8; 32],
    pub sequence: u64,
    pub oracle_timestamp: u64,
    pub benchmark: u128,
    pub prices: Vec<Price>,
}

#[cfg_attr(feature = "borsh", derive(anchor_lang::AnchorSerialize, anchor_lang::AnchorDeserialize))]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub pool: [u8; 32],
    pub admin: [u8; 32],
    pub operator: [u8; 32],
    pub collateral_mint: [u8; 32],
    pub collateral_decimals: u8,
    pub methodology: [u8; 32],
    pub origin_benchmark: u128,
    pub max_entry_price_age: u64,
    pub max_lots: u32,
}

#[cfg_attr(feature = "borsh", derive(anchor_lang::AnchorSerialize, anchor_lang::AnchorDeserialize))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Phase {
    Open,
    Scoring,
    Allocating,
    Settled,
    Voided,
}

#[cfg_attr(feature = "borsh", derive(anchor_lang::AnchorSerialize, anchor_lang::AnchorDeserialize))]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Ledger {
    pub pending_gross: u64,
    pub active_net: u64,
    pub held_fees: u64,
    pub claimable: u64,
    pub committed_fees: u64,
    pub residual: u64,
}

impl Ledger {
    pub fn liabilities(self) -> Result<u64> {
        [self.pending_gross, self.active_net, self.held_fees, self.claimable, self.committed_fees, self.residual]
            .into_iter().try_fold(0u64, |sum, item| sum.checked_add(item).ok_or(Error::Overflow))
    }

    pub fn check(self, actual_vault_balance: u64) -> Result<()> {
        if self.liabilities()? != actual_vault_balance {
            return Err(Error::Insolvent);
        }
        Ok(())
    }
}

#[cfg_attr(feature = "borsh", derive(anchor_lang::AnchorSerialize, anchor_lang::AnchorDeserialize))]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LotState {
    Pending,
    Executed,
    Scored {
        score: u128,
        weight: u128,
    },
    Claimable {
        amount: u64,
    },
    Withdrawn,
}

#[cfg_attr(feature = "borsh", derive(anchor_lang::AnchorSerialize, anchor_lang::AnchorDeserialize))]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EntryExecution {
    pub snapshot_id: [u8; 32],
    pub timestamp: u64,
    pub references: [u128; BASKET_SIZE],
}

#[cfg_attr(feature = "borsh", derive(anchor_lang::AnchorSerialize, anchor_lang::AnchorDeserialize))]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EntryLot {
    pool: [u8; 32],
    epoch: u64,
    nonce: u64,
    owner: [u8; 32],
    gross_stake: u64,
    fee: u64,
    admitted_at: u64,
    basket: [u16; BASKET_SIZE],
    backed_asset: u16,
    execution: Option<EntryExecution>,
    state: LotState,
}

impl EntryLot {
    pub fn nonce(&self) -> u64 { self.nonce }
    pub fn admitted_at(&self) -> u64 { self.admitted_at }
    pub fn owner(&self) -> Key { self.owner }
    pub fn gross_stake(&self) -> u64 { self.gross_stake }
    pub fn fee(&self) -> u64 { self.fee }
    pub fn basket(&self) -> &[AssetId; BASKET_SIZE] { &self.basket }
    pub fn backed_asset(&self) -> AssetId { self.backed_asset }
    pub fn state(&self) -> &LotState { &self.state }
    pub fn execution(&self) -> Option<&EntryExecution> { self.execution.as_ref() }
}

#[cfg_attr(feature = "borsh", derive(anchor_lang::AnchorSerialize, anchor_lang::AnchorDeserialize))]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClosingReference {
    pub asset_id: u16,
    pub value: u128,
}

#[cfg_attr(feature = "borsh", derive(anchor_lang::AnchorSerialize, anchor_lang::AnchorDeserialize))]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Epoch {
    config: Config,
    opens_at: u64,
    closes_at: u64,
    universe: Vec<Asset>,
    phase: Phase,
    next_nonce: u64,
    executed_lots: u32,
    scored_lots: u32,
    allocated_lots: u32,
    total_weight: u128,
    settlement_pot: u64,
    all_zero: bool,
    closing_snapshot: Option<OperatorSnapshot>,
    closing_references: Vec<ClosingReference>,
    last_entry_snapshot: Option<OperatorSnapshot>,
    ledger: Ledger,
}

impl Epoch {
    pub fn create(config: Config, admin: Key, opens_at: u64, now: u64, universe: Vec<Asset>) -> Result<Self> {
        if admin != config.admin { return Err(Error::Unauthorized); }
        Self::create_checked(config, opens_at, now, universe, false)
    }

    pub fn create_current(config: Config, opens_at: u64, now: u64, universe: Vec<Asset>) -> Result<Self> {
        Self::create_checked(config, opens_at, now, universe, true)
    }

    fn create_checked(config: Config, opens_at: u64, now: u64, universe: Vec<Asset>, current: bool) -> Result<Self> {
        if [config.pool, config.admin, config.operator, config.collateral_mint, config.methodology].contains(&[0; 32])
            || config.admin == config.operator { return Err(Error::InvalidAuthority); }
        if opens_at % EPOCH_SECONDS != 0 || (!current && now > opens_at)
            || (current && (now < opens_at || now >= opens_at.checked_add(EPOCH_SECONDS).ok_or(Error::Overflow)?))
            || config.collateral_decimals != COLLATERAL_DECIMALS
            || config.max_lots == 0 || config.max_lots > MAX_LOTS || config.max_entry_price_age == 0 {
            return Err(Error::InvalidEpoch);
        }
        if config.origin_benchmark == 0 || config.origin_benchmark > MAX_REFERENCE {
            return Err(Error::InvalidReference);
        }
        if universe.len() < BASKET_SIZE || universe.len() > MAX_UNIVERSE { return Err(Error::InvalidUniverse); }
        let mut asset_ids = BTreeSet::new();
        let mut feed_ids = BTreeSet::new();
        for asset in &universe {
            if asset.id as usize >= MAX_UNIVERSE || asset.feed_id == [0; 32] || asset.origin_price == 0 || asset.origin_price > MAX_REFERENCE
                || !asset_ids.insert(asset.id) || !feed_ids.insert(asset.feed_id) {
                return Err(Error::InvalidUniverse);
            }
        }
        let closes_at = opens_at.checked_add(EPOCH_SECONDS).ok_or(Error::Overflow)?;
        closes_at.checked_add(CLOSING_GRACE_SECONDS).ok_or(Error::Overflow)?;
        Ok(Self { config, opens_at, closes_at, universe, phase: Phase::Open, next_nonce: 0, executed_lots: 0,
            scored_lots: 0, allocated_lots: 0, total_weight: 0, settlement_pot: 0, all_zero: false,
            closing_snapshot: None, closing_references: Vec::new(), last_entry_snapshot: None, ledger: Ledger::default() })
    }

    pub fn ledger(&self) -> Ledger { self.ledger }
    pub fn phase(&self) -> Phase { self.phase }
    pub fn closes_at(&self) -> u64 { self.closes_at }
    pub fn next_nonce(&self) -> u64 { self.next_nonce }
    pub fn executed_lots(&self) -> u32 { self.executed_lots }
    pub fn scored_lots(&self) -> u32 { self.scored_lots }
    pub fn allocated_lots(&self) -> u32 { self.allocated_lots }
    pub fn total_weight(&self) -> u128 { self.total_weight }
    pub fn universe(&self) -> &[Asset] { &self.universe }

    pub fn reconcile_surplus(&mut self, actual_vault_balance: u64) -> Result<u64> {
        let surplus = actual_vault_balance.checked_sub(self.ledger.liabilities()?).ok_or(Error::Insolvent)?;
        self.ledger.residual = self.ledger.residual.checked_add(surplus).ok_or(Error::Overflow)?;
        Ok(surplus)
    }

    pub fn queue(&mut self, owner: Key, nonce: u64, gross_stake: u64, basket: [u16; BASKET_SIZE],
        backed_asset: u16, now: u64, vault_balance_after_deposit: u64) -> Result<EntryLot> {
        if self.phase != Phase::Open || now < self.opens_at || now >= self.closes_at { return Err(Error::WrongPhase); }
        if owner == [0; 32] { return Err(Error::InvalidAuthority); }
        if nonce != self.next_nonce { return Err(Error::InvalidNonce); }
        if self.next_nonce >= self.config.max_lots as u64 { return Err(Error::EntryLimit); }
        if !basket.contains(&backed_asset) { return Err(Error::InvalidBasket); }
        for (index, asset) in basket.iter().enumerate() {
            if basket[..index].contains(asset) || !self.universe.iter().any(|member| member.id == *asset) {
                return Err(Error::InvalidBasket);
            }
        }
        let fee = math::fee(gross_stake)?;
        let next_pending = self.ledger.pending_gross.checked_add(gross_stake).ok_or(Error::Overflow)?;
        if self.ledger.liabilities()?.checked_add(gross_stake).ok_or(Error::Overflow)? != vault_balance_after_deposit {
            return Err(Error::Insolvent);
        }
        let lot = EntryLot { pool: self.config.pool, epoch: self.opens_at, nonce, owner, gross_stake,
            fee, admitted_at: now, basket, backed_asset, execution: None, state: LotState::Pending };
        self.ledger.pending_gross = next_pending;
        self.next_nonce += 1;
        Ok(lot)
    }

    pub fn execute(&mut self, operator: Key, lot: &mut EntryLot, snapshot: &OperatorSnapshot, now: u64, vault_balance: u64) -> Result<()> {
        self.execute_with_origins(operator, lot, snapshot, now, vault_balance, &[])
    }

    pub fn execute_with_origins(&mut self, operator: Key, lot: &mut EntryLot, snapshot: &OperatorSnapshot,
        now: u64, vault_balance: u64, origin_benchmarks: &[u128]) -> Result<()> {
        self.validate_origins(origin_benchmarks)?;
        self.authorize(operator)?;
        self.check_lot(lot)?;
        self.ledger.check(vault_balance)?;
        if self.phase != Phase::Open || now >= self.closes_at { return Err(Error::WrongPhase); }
        if lot.state != LotState::Pending { return Err(Error::WrongLotState); }
        if snapshot.oracle_timestamp <= lot.admitted_at || snapshot.oracle_timestamp >= self.closes_at
            || snapshot.oracle_timestamp > now || now - snapshot.oracle_timestamp > self.config.max_entry_price_age {
            return Err(Error::IneligibleSnapshot);
        }
        self.validate_snapshot(snapshot)?;
        if let Some(previous) = &self.last_entry_snapshot {
            if snapshot.sequence < previous.sequence || snapshot.oracle_timestamp < previous.oracle_timestamp
                || (snapshot.sequence == previous.sequence && snapshot != previous)
                || (snapshot.id == previous.id && snapshot != previous) {
                return Err(Error::InvalidSnapshot);
            }
        }
        let mut references = [0; BASKET_SIZE];
        for (index, asset) in lot.basket.iter().enumerate() { references[index] = self.reference(snapshot, *asset, origin_benchmarks)?; }
        let net = lot.gross_stake - lot.fee;
        let next_net = self.ledger.active_net.checked_add(net).ok_or(Error::Overflow)?;
        let next_held = self.ledger.held_fees.checked_add(lot.fee).ok_or(Error::Overflow)?;
        let next_pending = self.ledger.pending_gross.checked_sub(lot.gross_stake).ok_or(Error::Insolvent)?;
        self.ledger.active_net = next_net;
        self.ledger.held_fees = next_held;
        self.ledger.pending_gross = next_pending;
        self.executed_lots += 1;
        self.last_entry_snapshot = Some(snapshot.clone());
        lot.execution = Some(EntryExecution { snapshot_id: snapshot.id, timestamp: snapshot.oracle_timestamp, references });
        lot.state = LotState::Executed;
        Ok(())
    }

    pub fn begin_close(&mut self, operator: Key, snapshot: OperatorSnapshot, now: u64, vault_balance: u64) -> Result<()> {
        self.begin_close_with_origins(operator, snapshot, now, vault_balance, &[])
    }

    pub fn begin_close_with_origins(&mut self, operator: Key, snapshot: OperatorSnapshot,
        now: u64, vault_balance: u64, origin_benchmarks: &[u128]) -> Result<()> {
        self.validate_origins(origin_benchmarks)?;
        self.authorize(operator)?;
        self.ledger.check(vault_balance)?;
        if self.phase != Phase::Open { return Err(Error::WrongPhase); }
        if now < self.closes_at || now > self.closes_at + CLOSING_GRACE_SECONDS || snapshot.oracle_timestamp != self.closes_at {
            return Err(Error::IneligibleSnapshot);
        }
        self.validate_snapshot(&snapshot)?;
        if snapshot.prices.len() != self.universe.len() { return Err(Error::ClosingDataMissing); }
        if let Some(previous) = &self.last_entry_snapshot {
            if snapshot.sequence <= previous.sequence || snapshot.id == previous.id { return Err(Error::InvalidSnapshot); }
        }
        let mut prices_by_id = vec![0; MAX_UNIVERSE];
        for price in &snapshot.prices { prices_by_id[price.asset_id as usize] = price.value; }
        let mut closing_references = Vec::with_capacity(self.universe.len());
        for (index, asset) in self.universe.iter().enumerate() {
            let origin_benchmark = origin_benchmarks.get(index).copied().unwrap_or(self.config.origin_benchmark);
            let value = math::relative_reference(prices_by_id[asset.id as usize], asset.origin_price,
                snapshot.benchmark, origin_benchmark)?;
            closing_references.push(ClosingReference { asset_id: asset.id, value });
        }
        self.closing_references = closing_references;
        self.closing_snapshot = Some(snapshot);
        self.phase = Phase::Scoring;
        Ok(())
    }

    pub fn score_entry(&mut self, lot: &mut EntryLot, vault_balance: u64) -> Result<u128> {
        self.check_lot(lot)?;
        self.ledger.check(vault_balance)?;
        if self.phase != Phase::Scoring { return Err(Error::WrongPhase); }
        if lot.state != LotState::Executed { return Err(Error::WrongLotState); }
        let references = &lot.execution.as_ref().ok_or(Error::WrongLotState)?.references;
        let mut close = [0; BASKET_SIZE];
        for (index, asset) in lot.basket.iter().enumerate() {
            close[index] = self.closing_references.iter().find(|reference| reference.asset_id == *asset).ok_or(Error::ClosingDataMissing)?.value;
        }
        let backed_index = lot.basket.iter().position(|id| *id == lot.backed_asset).ok_or(Error::InvalidBasket)?;
        let score = math::score(references, &close, backed_index)?;
        let weight = math::weight(lot.gross_stake - lot.fee, score)?;
        let total_weight = self.total_weight.checked_add(weight).ok_or(Error::Overflow)?;
        self.total_weight = total_weight;
        self.scored_lots += 1;
        lot.state = LotState::Scored { score, weight };
        Ok(score)
    }

    pub fn finalize_scores(&mut self, vault_balance: u64) -> Result<()> {
        self.ledger.check(vault_balance)?;
        if self.phase != Phase::Scoring { return Err(Error::WrongPhase); }
        if self.scored_lots != self.executed_lots { return Err(Error::ScoresIncomplete); }
        self.all_zero = self.total_weight == 0;
        self.settlement_pot = self.ledger.active_net;
        self.phase = if self.executed_lots == 0 { Phase::Settled } else { Phase::Allocating };
        Ok(())
    }

    pub fn allocate(&mut self, lot: &mut EntryLot, vault_balance: u64) -> Result<u64> {
        self.check_lot(lot)?;
        self.ledger.check(vault_balance)?;
        if self.phase != Phase::Allocating { return Err(Error::WrongPhase); }
        let weight = match lot.state { LotState::Scored { weight, .. } => weight, _ => return Err(Error::WrongLotState) };
        let amount = if self.all_zero { lot.gross_stake } else { math::payout(self.settlement_pot, weight, self.total_weight)? };
        let net_release = if self.all_zero { lot.gross_stake - lot.fee } else { amount };
        let active_net = self.ledger.active_net.checked_sub(net_release).ok_or(Error::Insolvent)?;
        let held_fees = if self.all_zero { self.ledger.held_fees.checked_sub(lot.fee).ok_or(Error::Insolvent)? } else { self.ledger.held_fees };
        let claimable = self.ledger.claimable.checked_add(amount).ok_or(Error::Overflow)?;
        let last = self.allocated_lots + 1 == self.executed_lots;
        let residual = if last { self.ledger.residual.checked_add(active_net).ok_or(Error::Overflow)? } else { self.ledger.residual };
        let committed_fees = if last && !self.all_zero {
            self.ledger.committed_fees.checked_add(held_fees).ok_or(Error::Overflow)?
        } else { self.ledger.committed_fees };
        self.ledger.active_net = if last { 0 } else { active_net };
        self.ledger.held_fees = if last { 0 } else { held_fees };
        self.ledger.committed_fees = committed_fees;
        self.ledger.claimable = claimable;
        self.ledger.residual = residual;
        self.allocated_lots += 1;
        if last { self.phase = Phase::Settled; }
        lot.state = LotState::Claimable { amount };
        Ok(amount)
    }

    pub fn finalize_empty(&mut self, now: u64, vault_balance: u64) -> Result<()> {
        self.ledger.check(vault_balance)?;
        if self.phase != Phase::Open || now < self.closes_at || self.executed_lots != 0
            || self.ledger.pending_gross != 0 || self.ledger.active_net != 0 || self.ledger.held_fees != 0 {
            return Err(Error::WrongPhase);
        }
        self.phase = Phase::Settled;
        self.all_zero = true;
        Ok(())
    }

    pub fn void(&mut self, now: u64, vault_balance: u64) -> Result<()> {
        self.ledger.check(vault_balance)?;
        if self.closing_snapshot.is_some() { return Err(Error::ClosingDataExists); }
        if self.phase != Phase::Open || now <= self.closes_at + CLOSING_GRACE_SECONDS { return Err(Error::WrongPhase); }
        self.phase = Phase::Voided;
        Ok(())
    }

    pub fn refund(&mut self, lot: &mut EntryLot, now: u64, vault_balance: u64) -> Result<u64> {
        self.check_lot(lot)?;
        self.ledger.check(vault_balance)?;
        let pending = match lot.state {
            LotState::Pending if now >= self.closes_at => true,
            LotState::Executed if self.phase == Phase::Voided => false,
            _ => return Err(Error::WrongLotState),
        };
        let mut ledger = self.ledger;
        if pending { ledger.pending_gross = ledger.pending_gross.checked_sub(lot.gross_stake).ok_or(Error::Insolvent)?; }
        else {
            ledger.active_net = ledger.active_net.checked_sub(lot.gross_stake - lot.fee).ok_or(Error::Insolvent)?;
            ledger.held_fees = ledger.held_fees.checked_sub(lot.fee).ok_or(Error::Insolvent)?;
        }
        ledger.claimable = ledger.claimable.checked_add(lot.gross_stake).ok_or(Error::Overflow)?;
        self.ledger = ledger;
        lot.state = LotState::Claimable { amount: lot.gross_stake };
        Ok(lot.gross_stake)
    }

    pub fn withdraw(&mut self, owner: Key, lot: &mut EntryLot, vault_balance_before: u64) -> Result<u64> {
        self.withdraw_claim(owner, lot, None, vault_balance_before)
    }

    pub fn withdraw_partial(&mut self, owner: Key, lot: &mut EntryLot, amount: u64, vault_balance_before: u64) -> Result<u64> {
        if amount == 0 { return Err(Error::InvalidStake); }
        self.withdraw_claim(owner, lot, Some(amount), vault_balance_before)
    }

    fn withdraw_claim(&mut self, owner: Key, lot: &mut EntryLot, requested: Option<u64>, vault_balance_before: u64) -> Result<u64> {
        self.check_lot(lot)?;
        self.ledger.check(vault_balance_before)?;
        if owner != lot.owner { return Err(Error::Unauthorized); }
        let remaining = match lot.state { LotState::Claimable { amount } => amount, _ => return Err(Error::WrongLotState) };
        let amount = requested.unwrap_or(remaining);
        if amount > remaining { return Err(Error::InvalidStake); }
        self.ledger.claimable = self.ledger.claimable.checked_sub(amount).ok_or(Error::Insolvent)?;
        lot.state = if amount == remaining { LotState::Withdrawn } else { LotState::Claimable { amount: remaining - amount } };
        Ok(amount)
    }

    pub fn withdraw_fees(&mut self, admin: Key, amount: u64, vault_balance_before: u64) -> Result<()> {
        if admin != self.config.admin { return Err(Error::Unauthorized); }
        self.ledger.check(vault_balance_before)?;
        if amount == 0 || amount > self.ledger.committed_fees { return Err(Error::InvalidStake); }
        self.ledger.committed_fees -= amount;
        Ok(())
    }

    fn authorize(&self, operator: Key) -> Result<()> {
        if operator != self.config.operator { return Err(Error::Unauthorized); }
        Ok(())
    }

    fn check_lot(&self, lot: &EntryLot) -> Result<()> {
        if lot.pool != self.config.pool || lot.epoch != self.opens_at || lot.nonce >= self.next_nonce {
            return Err(Error::WrongEntry);
        }
        Ok(())
    }

    fn validate_snapshot(&self, snapshot: &OperatorSnapshot) -> Result<()> {
        if snapshot.id == [0; 32] || snapshot.methodology != self.config.methodology || snapshot.benchmark == 0 || snapshot.benchmark > MAX_REFERENCE
            || snapshot.prices.is_empty() || snapshot.prices.len() > MAX_UNIVERSE { return Err(Error::InvalidSnapshot); }
        let mut assets_by_id = vec![None; MAX_UNIVERSE];
        for asset in &self.universe { assets_by_id[asset.id as usize] = Some(asset); }
        let mut seen = vec![false; MAX_UNIVERSE];
        for price in &snapshot.prices {
            if price.value == 0 || price.value > MAX_REFERENCE
                || price.asset_id as usize >= MAX_UNIVERSE || seen[price.asset_id as usize]
                || !assets_by_id[price.asset_id as usize].is_some_and(|asset| asset.feed_id == price.feed_id) {
                return Err(Error::InvalidSnapshot);
            }
            seen[price.asset_id as usize] = true;
        }
        Ok(())
    }

    fn validate_origins(&self, origin_benchmarks: &[u128]) -> Result<()> {
        if !origin_benchmarks.is_empty() && (origin_benchmarks.len() != self.universe.len()
            || origin_benchmarks.iter().any(|value| *value == 0 || *value > MAX_REFERENCE)) {
            return Err(Error::InvalidReference);
        }
        Ok(())
    }

    fn reference(&self, snapshot: &OperatorSnapshot, asset: AssetId, origin_benchmarks: &[u128]) -> Result<u128> {
        let price = snapshot.prices.iter().find(|price| price.asset_id == asset).ok_or(Error::InvalidSnapshot)?;
        let (index, origin) = self.universe.iter().enumerate().find(|(_, member)| member.id == asset).ok_or(Error::InvalidUniverse)?;
        let origin_benchmark = origin_benchmarks.get(index).copied().unwrap_or(self.config.origin_benchmark);
        math::relative_reference(price.value, origin.origin_price, snapshot.benchmark, origin_benchmark)
    }
}
