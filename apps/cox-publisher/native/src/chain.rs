use crate::{
    rpc::Rpc,
    scheduler::{Pool as WorkPool, Work},
    transactions::{BasicAccounts, BasicProcess, EpochAccounts, EpochLotOperation},
};
#[cfg(test)]
use anchor_lang::Discriminator;
use anchor_lang::{AccountDeserialize, AnchorSerialize};
use base64::{engine::general_purpose::STANDARD, Engine};
use cox::{Batch, Methodology, Pool, Registry, Request};
use cox_epoch::{LotState, Phase};
use relative_epoch::{EpochAccount, LotAccount, PoolConfig};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_address::Address;
use solana_instruction::Instruction;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::Arc,
};

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Rpc,
    InvalidResponse,
    WrongOwner,
    InvalidAccount,
    WrongAddress,
    WrongAuthority,
    RetiredPool,
    UnstableRead,
    Limit,
    Overflow,
    Storage,
}
pub struct BasicState {
    pub accounts: BasicAccounts,
    pub pool: Pool,
    pub registry: Registry,
    pub methodology: Methodology,
    pub batch: Option<Batch>,
    pub requests: Vec<Request>,
}
pub struct EpochState {
    pub accounts: EpochAccounts,
    pub epoch: EpochAccount,
    pub lots: Vec<LotAccount>,
}
pub struct ChainState {
    pub slot: u64,
    pub confirmed_timestamp_ms: u64,
    pub digest: [u8; 32],
    pub discovery_incomplete: bool,
    pub basic: BasicState,
    pub epoch_config: PoolConfig,
    pub epochs: Vec<EpochState>,
}
pub struct ChainReader {
    pub rpc: Arc<Rpc>,
    pub operator: Address,
    pub basic_program: Address,
    pub basic_pool_id: u64,
    pub epoch_program: Address,
    pub epoch_config: Address,
}
const LOT_PAGE: u64 = 16;
const MAX_LOT_PAGES: usize = 4;
const MAX_EPOCH_SCAN: usize = 8;
const MAX_TRACKED_EPOCHS: usize = 64;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct LotCursor {
    phase: u8,
    next: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct DiscoveryState {
    schema: u8,
    program: String,
    config: String,
    first_epoch: u64,
    next_epoch: u64,
    #[serde(default)]
    scan_epoch: u64,
    #[serde(default)]
    tracked_epochs: BTreeSet<u64>,
    cursors: BTreeMap<u64, LotCursor>,
}
pub struct Discovery {
    state: DiscoveryState,
    path: Option<PathBuf>,
    pub incomplete: bool,
}
impl Discovery {
    pub fn first_epoch(&self) -> u64 {
        self.state.first_epoch
    }
    pub fn new(program: Address, config: Address, first_epoch: u64) -> Result<Self, Error> {
        if first_epoch % cox_epoch::EPOCH_SECONDS != 0 {
            return Err(Error::InvalidAccount);
        }
        Ok(Self {
            state: DiscoveryState {
                schema: 2,
                program: program.to_string(),
                config: config.to_string(),
                first_epoch,
                next_epoch: first_epoch,
                scan_epoch: first_epoch,
                tracked_epochs: BTreeSet::new(),
                cursors: BTreeMap::new(),
            },
            path: None,
            incomplete: false,
        })
    }
    pub fn load(
        path: impl Into<PathBuf>,
        program: Address,
        config: Address,
        first_epoch: u64,
    ) -> Result<Self, Error> {
        let mut value = Self::new(program, config, first_epoch)?;
        let path = path.into();
        if let Some(mut saved) =
            crate::journal::read::<DiscoveryState>(&path).map_err(|_| Error::Storage)?
        {
            if saved.schema == 1 {
                if saved.scan_epoch != 0
                    || !saved.tracked_epochs.is_empty()
                    || saved.cursors.len() > 2
                {
                    return Err(Error::Storage);
                }
                saved.schema = 2;
                saved.scan_epoch = saved.next_epoch;
                saved.tracked_epochs.extend(saved.cursors.keys().copied());
            }
            let valid_opening =
                |opens: u64| opens >= first_epoch && opens % cox_epoch::EPOCH_SECONDS == 0;
            if saved.schema != 2
                || saved.program != value.state.program
                || saved.config != value.state.config
                || saved.first_epoch != first_epoch
                || !valid_opening(saved.next_epoch)
                || !valid_opening(saved.scan_epoch)
                || saved.next_epoch > saved.scan_epoch
                || saved.tracked_epochs.len() > MAX_TRACKED_EPOCHS
                || saved
                    .tracked_epochs
                    .iter()
                    .any(|opens| !valid_opening(*opens) || *opens < saved.next_epoch)
                || saved.cursors.iter().any(|(opens, cursor)| {
                    !saved.tracked_epochs.contains(opens)
                        || cursor.phase > 4
                        || cursor.next > u64::from(cox_epoch::MAX_LOTS)
                })
                || saved.next_epoch
                    != saved
                        .tracked_epochs
                        .iter()
                        .next()
                        .copied()
                        .unwrap_or(saved.scan_epoch)
                        .min(saved.scan_epoch)
            {
                return Err(Error::Storage);
            }
            value.state = saved;
        }
        value.path = Some(path);
        Ok(value)
    }
    fn save(&self) -> Result<(), Error> {
        if let Some(path) = &self.path {
            crate::journal::atomic_write(path, &self.state).map_err(|_| Error::Storage)?;
        }
        Ok(())
    }
    fn openings(&self, current: u64) -> Result<(BTreeSet<u64>, u64), Error> {
        if current < self.state.scan_epoch && current >= self.state.first_epoch {
            return Err(Error::UnstableRead);
        }
        let mut openings = self.state.tracked_epochs.clone();
        let mut scan = self.state.scan_epoch;
        for _ in 0..MAX_EPOCH_SCAN {
            if scan >= current {
                break;
            }
            openings.insert(scan);
            scan = scan
                .checked_add(cox_epoch::EPOCH_SECONDS)
                .ok_or(Error::Overflow)?;
        }
        if current >= self.state.first_epoch {
            openings.insert(current);
        }
        Ok((openings, scan))
    }
    fn record_epoch(&mut self, opens: u64, finalized_done: bool) -> Result<(), Error> {
        if finalized_done {
            self.state.tracked_epochs.remove(&opens);
            self.state.cursors.remove(&opens);
        } else {
            if !self.state.tracked_epochs.contains(&opens)
                && self.state.tracked_epochs.len() >= MAX_TRACKED_EPOCHS
            {
                return Err(Error::Limit);
            }
            self.state.tracked_epochs.insert(opens);
        }
        self.refresh_next_epoch();
        Ok(())
    }
    fn refresh_next_epoch(&mut self) {
        self.state.next_epoch = self
            .state
            .tracked_epochs
            .iter()
            .next()
            .copied()
            .unwrap_or(self.state.scan_epoch)
            .min(self.state.scan_epoch);
    }
    fn finish_scan(&mut self, scan: u64, current: u64) {
        self.state.scan_epoch = scan;
        self.refresh_next_epoch();
        self.incomplete |= scan < current;
    }
    fn cursor(&mut self, opens: u64, phase: Phase, nonce: u64) -> Result<u64, Error> {
        self.record_epoch(opens, false)?;
        let cursor = self.state.cursors.entry(opens).or_insert(LotCursor {
            phase: phase as u8,
            next: 0,
        });
        if cursor.phase != phase as u8 {
            cursor.phase = phase as u8;
            cursor.next = 0;
        }
        if cursor.next > nonce {
            return Err(Error::UnstableRead);
        }
        Ok(cursor.next)
    }
}
fn actionable(phase: Phase, lot: &LotState) -> bool {
    matches!(lot, LotState::Pending)
        || matches!(
            (phase, lot),
            (Phase::Scoring, LotState::Executed)
                | (Phase::Allocating, LotState::Scored { .. })
                | (Phase::Voided, LotState::Executed)
        )
}
fn advance_prefix(start: u64, phase: Phase, states: &[LotState]) -> u64 {
    start
        + states
            .iter()
            .take_while(|state| !actionable(phase, state))
            .count() as u64
}
fn completed(epoch: &EpochAccount, now: u64) -> bool {
    epoch.empty_finalized
        || epoch.state.as_ref().map_or(false, |state| {
            now >= state.closes_at()
                && state.ledger().pending_gross == 0
                && state.ledger().active_net == 0
                && state.ledger().held_fees == 0
                && matches!(state.phase(), Phase::Settled | Phase::Voided)
        })
}
fn finalized_epoch_done(
    confirmed: Option<&EpochAccount>,
    finalized: Option<&EpochAccount>,
    now: u64,
) -> bool {
    match (confirmed, finalized) {
        (None, None) => true,
        (Some(confirmed), Some(finalized)) => {
            completed(confirmed, now) && completed(finalized, now)
        }
        _ => false,
    }
}
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Raw {
    pub(crate) address: Address,
    pub(crate) owner: Address,
    pub(crate) data: Vec<u8>,
}
fn address(key: anchor_lang::prelude::Pubkey) -> Address {
    Address::new_from_array(key.to_bytes())
}
fn pda(program: Address, seeds: &[&[u8]]) -> Address {
    Address::find_program_address(seeds, &program).0
}
fn decode<T: AccountDeserialize>(raw: &Raw, owner: Address) -> Result<T, Error> {
    if raw.owner != owner {
        return Err(Error::WrongOwner);
    }
    T::try_deserialize(&mut raw.data.as_slice()).map_err(|_| Error::InvalidAccount)
}
fn raw(value: &Value, key: Address) -> Result<Raw, Error> {
    if value.is_null() || value.get("executable").and_then(Value::as_bool) != Some(false) {
        return Err(Error::InvalidAccount);
    }
    let owner = value
        .get("owner")
        .and_then(Value::as_str)
        .ok_or(Error::InvalidResponse)?
        .parse()
        .map_err(|_| Error::InvalidResponse)?;
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or(Error::InvalidResponse)?;
    if data.get(1).and_then(Value::as_str) != Some("base64") {
        return Err(Error::InvalidResponse);
    }
    Ok(Raw {
        address: key,
        owner,
        data: STANDARD
            .decode(
                data.first()
                    .and_then(Value::as_str)
                    .ok_or(Error::InvalidResponse)?,
            )
            .map_err(|_| Error::InvalidResponse)?,
    })
}
fn clock_timestamp_ms(row: &Raw) -> Result<u64, Error> {
    let address: Address = "SysvarC1ock11111111111111111111111111111111"
        .parse()
        .map_err(|_| Error::InvalidAccount)?;
    let owner: Address = "Sysvar1111111111111111111111111111111111111"
        .parse()
        .map_err(|_| Error::InvalidAccount)?;
    if row.address != address || row.owner != owner || row.data.len() != 40 {
        return Err(Error::InvalidAccount);
    }
    let timestamp = i64::from_le_bytes(
        row.data[32..40]
            .try_into()
            .map_err(|_| Error::InvalidAccount)?,
    );
    u64::try_from(timestamp)
        .ok()
        .filter(|timestamp| *timestamp > 0)
        .and_then(|timestamp| timestamp.checked_mul(1000))
        .ok_or(Error::InvalidAccount)
}
impl ChainReader {
    async fn multiple(&self, keys: &[Address], minimum: u64) -> Result<(u64, Vec<Raw>), Error> {
        if keys.is_empty() || keys.len() > 100 {
            return Err(Error::Limit);
        }
        let value = self.rpc.call("getMultipleAccounts", json!([keys.iter().map(ToString::to_string).collect::<Vec<_>>(), {"commitment":"confirmed","encoding":"base64","minContextSlot":minimum}])).await.map_err(|_| Error::Rpc)?;
        let slot = value
            .pointer("/context/slot")
            .and_then(Value::as_u64)
            .ok_or(Error::InvalidResponse)?;
        let accounts = value
            .get("value")
            .and_then(Value::as_array)
            .ok_or(Error::InvalidResponse)?;
        if slot < minimum || accounts.len() != keys.len() {
            return Err(Error::InvalidResponse);
        }
        Ok((
            slot,
            accounts
                .iter()
                .zip(keys)
                .map(|(value, key)| raw(value, *key))
                .collect::<Result<_, _>>()?,
        ))
    }
    pub(crate) async fn optional_accounts(
        &self,
        keys: &[Address],
        minimum: u64,
        commitment: &str,
    ) -> Result<(u64, Vec<Option<Raw>>), Error> {
        if keys.is_empty() || keys.len() > 100 {
            return Err(Error::Limit);
        }
        let value=self.rpc.call("getMultipleAccounts",json!([keys.iter().map(ToString::to_string).collect::<Vec<_>>(),{"commitment":commitment,"encoding":"base64","minContextSlot":minimum}])).await.map_err(|_|Error::Rpc)?;
        let slot = value
            .pointer("/context/slot")
            .and_then(Value::as_u64)
            .ok_or(Error::InvalidResponse)?;
        let rows = value
            .get("value")
            .and_then(Value::as_array)
            .ok_or(Error::InvalidResponse)?;
        if slot < minimum || rows.len() != keys.len() {
            return Err(Error::InvalidResponse);
        }
        Ok((
            slot,
            rows.iter()
                .zip(keys)
                .map(|(row, key)| {
                    if row.is_null() {
                        Ok(None)
                    } else {
                        raw(row, *key).map(Some)
                    }
                })
                .collect::<Result<_, _>>()?,
        ))
    }
    pub async fn methodology(&self, digest: [u8; 32]) -> Result<Methodology, Error> {
        let key = pda(self.basic_program, &[b"methodology", &digest]);
        let (_, values) = self.multiple(&[key], 0).await?;
        let value: Methodology = decode(&values[0], self.basic_program)?;
        if value.digest != digest {
            return Err(Error::InvalidAccount);
        }
        Ok(value)
    }
    pub async fn read(&self) -> Result<ChainState, Error> {
        let pool_key = pda(
            self.basic_program,
            &[b"pool", &self.basic_pool_id.to_le_bytes()],
        );
        let (_, rows) = self.multiple(&[pool_key], 0).await?;
        let pool: Pool = decode(&rows[0], self.basic_program)?;
        let first = pool.origin / cox_epoch::EPOCH_SECONDS * cox_epoch::EPOCH_SECONDS;
        let mut discovery = Discovery::new(self.epoch_program, self.epoch_config, first)?;
        self.read_with_discovery(&mut discovery).await
    }
    pub async fn read_with_discovery(
        &self,
        discovery: &mut Discovery,
    ) -> Result<ChainState, Error> {
        let mut candidate = Discovery {
            state: discovery.state.clone(),
            path: None,
            incomplete: false,
        };
        let state = self.read_discovery_snapshot(&mut candidate).await?;
        candidate.path = discovery.path.clone();
        candidate.save()?;
        *discovery = candidate;
        Ok(state)
    }
    async fn read_discovery_snapshot(
        &self,
        discovery: &mut Discovery,
    ) -> Result<ChainState, Error> {
        if self.basic_pool_id == 1 {
            return Err(Error::RetiredPool);
        }
        let registry_key = pda(self.basic_program, &[b"registry"]);
        let pool_key = pda(
            self.basic_program,
            &[b"pool", &self.basic_pool_id.to_le_bytes()],
        );
        let clock_key = "SysvarC1ock11111111111111111111111111111111"
            .parse()
            .map_err(|_| Error::InvalidAccount)?;
        let (mut slot, mut roots) = self
            .multiple(&[registry_key, pool_key, self.epoch_config, clock_key], 0)
            .await?;
        let initial_timestamp_ms = clock_timestamp_ms(&roots[3])?;
        roots.pop();
        let registry: Registry = decode(&roots[0], self.basic_program)?;
        let pool: Pool = decode(&roots[1], self.basic_program)?;
        let epoch_config: PoolConfig = decode(&roots[2], self.epoch_program)?;
        validate_basic(&pool, &registry, self.basic_pool_id, self.operator)?;
        if address(pool.registry) != registry_key || address(epoch_config.operator) != self.operator
        {
            return Err(Error::WrongAuthority);
        }
        if self.epoch_config
            != pda(
                self.epoch_program,
                &[
                    b"config",
                    epoch_config.admin.as_ref(),
                    &epoch_config.config_id.to_le_bytes(),
                ],
            )
        {
            return Err(Error::WrongAddress);
        }
        let methodology_key = address(pool.methodology);
        let batch_key = pda(self.basic_program, &[b"batch", pool_key.as_ref()]);
        let mut keys = vec![methodology_key];
        if pool.stage.is_some() {
            keys.push(batch_key);
        }
        let (s, extra) = self.multiple(&keys, slot).await?;
        slot = s;
        let methodology: Methodology = decode(&extra[0], self.basic_program)?;
        if methodology_key != pda(self.basic_program, &[b"methodology", &methodology.digest])
            || (if pool.schema_version == 5 {
                cox::read_dynamic_manifest(&methodology)
                    .map(|universe| {
                        universe.pool
                            == anchor_lang::prelude::Pubkey::new_from_array(pool_key.to_bytes())
                            && universe.instruments.len() + 1 == pool.classes.len()
                    })
                    .unwrap_or(false)
            } else {
                cox::read_adaptive_manifest(&methodology).is_ok()
            }) == false
            || methodology.origin != pool.origin
        {
            return Err(Error::InvalidAccount);
        }
        let mut accounts =
            BasicAccounts::derive(self.basic_program, self.basic_pool_id, methodology.digest);
        accounts.test_vault = pool
            .test_collateral_mint
            .map(|_| pda(self.basic_program, &[b"test-vault", pool_key.as_ref()]));
        if accounts.vault != address(pool.vault) {
            return Err(Error::WrongAddress);
        }
        let batch = if pool.stage.is_some() {
            let batch: Batch = decode(&extra[1], self.basic_program)?;
            if pool.stage.map(address) != Some(batch_key)
                || address(batch.pool) != pool_key
                || batch.sequence
                    != if pool.initialized {
                        pool.sequence.checked_add(1).ok_or(Error::Overflow)?
                    } else {
                        0
                    }
                || batch.predecessor_digest != pool.state_digest
                || batch.predecessor_sequence != pool.sequence
                || !valid_batch_phase(&pool, &methodology, &batch)
            {
                return Err(Error::InvalidAccount);
            }
            Some(batch)
        } else {
            None
        };
        let mut vault_keys = vec![accounts.vault];
        if let Some(vault) = accounts.test_vault {
            vault_keys.push(vault);
        }
        let (s, vault_rows) = self.multiple(&vault_keys, slot).await?;
        slot = s;
        let primary = validate_vault(&vault_rows[0], pool_key, address(pool.collateral_mint), 0)?;
        let secondary = if let Some(mint) = pool.test_collateral_mint {
            validate_vault(&vault_rows[1], pool_key, address(mint), 0)?
        } else {
            0
        };
        if primary.checked_add(secondary).ok_or(Error::Overflow)?
            < pool
                .active
                .checked_add(pool.pending)
                .and_then(|v| v.checked_add(pool.payable))
                .and_then(|v| v.checked_add(pool.residual))
                .and_then(|v| v.checked_add(pool.fees))
                .ok_or(Error::Overflow)?
        {
            return Err(Error::InvalidAccount);
        }
        let mut observed = roots;
        observed.extend(extra);
        observed.extend(vault_rows);
        let start = batch.as_ref().map(|b| b.cursor).unwrap_or(pool.queue_start);
        let end = batch
            .as_ref()
            .map(|b| b.closed_queue_end)
            .unwrap_or(pool.next_request_nonce);
        let request_end = if batch
            .as_ref()
            .is_some_and(|batch| matches!(batch.phase, 4..=6))
        {
            start
        } else {
            end.min(start.saturating_add(16))
        };
        let request_keys: Vec<_> = (start..request_end)
            .map(|nonce| {
                pda(
                    self.basic_program,
                    &[b"request", pool_key.as_ref(), &nonce.to_le_bytes()],
                )
            })
            .collect();
        let mut requests = Vec::new();
        if !request_keys.is_empty() {
            let (s, rows) = self.multiple(&request_keys, slot).await?;
            slot = s;
            for (row, nonce) in rows.iter().zip(start..) {
                let request: Request = decode(row, self.basic_program)?;
                if address(request.pool) != pool_key || request.nonce != nonce {
                    return Err(Error::WrongAddress);
                }
                requests.push(request);
            }
            observed.extend(rows);
        }
        let now = initial_timestamp_ms / 1000;
        let current = now / cox_epoch::EPOCH_SECONDS * cox_epoch::EPOCH_SECONDS;
        discovery.incomplete = false;
        let mut epochs = Vec::new();
        let (openings, scan_end) = discovery.openings(current)?;
        for opens in openings {
            if opens > current {
                continue;
            }
            let accounts = EpochAccounts::derive(self.epoch_program, self.epoch_config, opens)
                .map_err(|_| Error::InvalidAccount)?;
            let (s, rows) = self
                .optional_accounts(&[accounts.epoch], slot, "confirmed")
                .await?;
            slot = s;
            let row = rows.into_iter().next().flatten();
            let epoch = row
                .as_ref()
                .map(|row| decode::<EpochAccount>(row, self.epoch_program))
                .transpose()?;
            if let Some(epoch) = &epoch {
                if epoch.opens_at != opens
                    || address(epoch.config) != self.epoch_config
                    || address(epoch.vault) != accounts.vault
                    || address(epoch.test_vault) != accounts.test_vault
                {
                    return Err(Error::WrongAddress);
                }
            }
            let done = epoch.as_ref().is_none_or(|epoch| completed(epoch, now));
            if done && opens < current {
                let (_, finalized) = self
                    .optional_accounts(&[accounts.epoch], 0, "finalized")
                    .await?;
                let final_epoch = finalized[0]
                    .as_ref()
                    .map(|row| decode::<EpochAccount>(row, self.epoch_program))
                    .transpose()?;
                if let Some(final_epoch) = &final_epoch {
                    if final_epoch.opens_at != opens
                        || address(final_epoch.config) != self.epoch_config
                        || address(final_epoch.vault) != accounts.vault
                        || address(final_epoch.test_vault) != accounts.test_vault
                    {
                        return Err(Error::WrongAddress);
                    }
                }
                let finalized_done =
                    finalized_epoch_done(epoch.as_ref(), final_epoch.as_ref(), now);
                discovery.record_epoch(opens, finalized_done)?;
            } else if epoch.is_some() {
                discovery.record_epoch(opens, false)?;
            }
            let (Some(row), Some(epoch)) = (row, epoch) else {
                continue;
            };
            if done {
                continue;
            }
            let (s, vault_rows) = self
                .multiple(&[accounts.vault, accounts.test_vault], slot)
                .await?;
            slot = s;
            let first = validate_vault(
                &vault_rows[0],
                accounts.epoch,
                address(epoch_config.mint),
                0,
            )?;
            let second = validate_vault(
                &vault_rows[1],
                accounts.epoch,
                address(epoch_config.test_mint.unwrap_or(epoch_config.mint)),
                0,
            )?;
            if first.checked_add(second).ok_or(Error::Overflow)?
                < epoch
                    .state
                    .as_ref()
                    .map(|engine| engine.ledger().liabilities())
                    .transpose()
                    .map_err(|_| Error::InvalidAccount)?
                    .unwrap_or(0)
            {
                return Err(Error::InvalidAccount);
            }
            let Some(engine) = epoch.state.as_ref() else {
                observed.push(row);
                observed.extend(vault_rows);
                epochs.push(EpochState {
                    accounts,
                    epoch,
                    lots: vec![],
                });
                continue;
            };
            let mut offset = discovery.cursor(opens, engine.phase(), engine.next_nonce())?;
            let mut lots = Vec::new();
            for _ in 0..MAX_LOT_PAGES {
                if offset >= engine.next_nonce() {
                    break;
                }
                let end = engine.next_nonce().min(offset.saturating_add(LOT_PAGE));
                let keys = (offset..end)
                    .map(|nonce| accounts.lot(nonce))
                    .collect::<Vec<_>>();
                let (s, rows) = self.multiple(&keys, slot).await?;
                slot = s;
                let page = rows
                    .iter()
                    .zip(offset..end)
                    .map(|(row, nonce)| checked_lot(row, self.epoch_program, &accounts, nonce))
                    .collect::<Result<Vec<_>, _>>()?;
                if discovery
                    .state
                    .cursors
                    .get(&opens)
                    .is_some_and(|cursor| cursor.next == offset)
                {
                    let (_, finalized) = self.optional_accounts(&keys, 0, "finalized").await?;
                    let mut statuses = Vec::new();
                    for (row, nonce) in finalized.iter().zip(offset..end) {
                        let Some(row) = row else { break };
                        let lot = checked_lot(row, self.epoch_program, &accounts, nonce)?;
                        statuses.push(
                            lot.state
                                .as_ref()
                                .ok_or(Error::InvalidAccount)?
                                .state()
                                .clone(),
                        );
                    }
                    let prefix = advance_prefix(offset, engine.phase(), &statuses);
                    discovery
                        .state
                        .cursors
                        .get_mut(&opens)
                        .ok_or(Error::InvalidAccount)?
                        .next = prefix;
                }
                let has_action = page
                    .iter()
                    .any(|lot| actionable(engine.phase(), lot.state.as_ref().unwrap().state()));
                observed.extend(rows);
                lots.extend(page);
                offset = end;
                if has_action {
                    break;
                }
            }
            if offset < engine.next_nonce()
                && !lots
                    .iter()
                    .any(|lot| actionable(engine.phase(), lot.state.as_ref().unwrap().state()))
            {
                discovery.incomplete = true;
            }
            observed.push(row);
            observed.extend(vault_rows);
            epochs.push(EpochState {
                accounts,
                epoch,
                lots,
            });
        }
        discovery.finish_scan(scan_end, current);
        let (s, verified) = self
            .multiple(
                &[registry_key, pool_key, self.epoch_config, clock_key],
                slot,
            )
            .await?;
        slot = s;
        let confirmed_timestamp_ms = clock_timestamp_ms(&verified[3])?;
        if confirmed_timestamp_ms < initial_timestamp_ms
            || confirmed_timestamp_ms / 1000 / cox_epoch::EPOCH_SECONDS
                != current / cox_epoch::EPOCH_SECONDS
        {
            return Err(Error::UnstableRead);
        }
        let fresh_registry: Registry = decode(&verified[0], self.basic_program)?;
        let fresh_pool: Pool = decode(&verified[1], self.basic_program)?;
        let fresh_config: PoolConfig = decode(&verified[2], self.epoch_program)?;
        if basic_guard(&pool, &registry) != basic_guard(&fresh_pool, &fresh_registry)
            || fresh_config
                .try_to_vec()
                .map_err(|_| Error::InvalidAccount)?
                != epoch_config
                    .try_to_vec()
                    .map_err(|_| Error::InvalidAccount)?
        {
            return Err(Error::UnstableRead);
        }
        observed.sort_by_key(|row| row.address.to_bytes());
        let mut hash = Sha256::new();
        for row in observed {
            hash.update(row.address.as_ref());
            hash.update(row.owner.as_ref());
            hash.update((row.data.len() as u64).to_le_bytes());
            hash.update(row.data);
        }
        Ok(ChainState {
            slot,
            confirmed_timestamp_ms,
            digest: hash.finalize().into(),
            discovery_incomplete: discovery.incomplete,
            basic: BasicState {
                accounts,
                pool,
                registry,
                methodology,
                batch,
                requests,
            },
            epoch_config,
            epochs,
        })
    }
}
fn checked_lot(
    raw: &Raw,
    program: Address,
    accounts: &EpochAccounts,
    nonce: u64,
) -> Result<LotAccount, Error> {
    let lot: LotAccount = decode(raw, program)?;
    if raw.address != accounts.lot(nonce)
        || address(lot.epoch) != accounts.epoch
        || lot.nonce != nonce
        || lot
            .state
            .as_ref()
            .is_none_or(|state| state.nonce() != nonce)
    {
        return Err(Error::WrongAddress);
    }
    Ok(lot)
}
fn basic_guard(pool: &Pool, registry: &Registry) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update([u8::from(registry.paused)]);
    hash.update(registry.runtime.as_ref());
    hash.update(pool.schema_version.to_le_bytes());
    hash.update(pool.pool_id.to_le_bytes());
    hash.update(pool.methodology.as_ref());
    hash.update(pool.origin.to_le_bytes());
    hash.update([u8::from(pool.initialized)]);
    hash.update(pool.sequence.to_le_bytes());
    hash.update(pool.state_digest);
    hash.update(pool.stage.map(|key| key.to_bytes()).unwrap_or([0; 32]));
    hash.update(pool.fee_version.to_le_bytes());
    hash.update(pool.fee_bps.to_le_bytes());
    hash.update(pool.fee_cap.to_le_bytes());
    hash.update([u8::from(pool.fee_pending)]);
    hash.update(pool.fee_pending_version.to_le_bytes());
    hash.update(pool.fee_pending_bps.to_le_bytes());
    hash.update(pool.fee_pending_cap.to_le_bytes());
    hash.update(pool.fee_pending_cutoff.to_le_bytes());
    hash.finalize().into()
}
fn validate_basic(
    pool: &Pool,
    registry: &Registry,
    id: u64,
    operator: Address,
) -> Result<(), Error> {
    if pool.schema_version == 3 || id == 1 {
        return Err(Error::RetiredPool);
    }
    if !matches!(pool.schema_version, 4 | 5)
        || pool.pool_id != id
        || address(registry.runtime) != operator
    {
        return Err(Error::WrongAuthority);
    }
    if pool.test_collateral_mint == Some(pool.collateral_mint) {
        return Err(Error::InvalidAccount);
    }
    Ok(())
}
impl ChainState {
    pub fn work(&self, now_ms: u64) -> Result<Vec<Work>, Error> {
        let mut work = Vec::new();
        if !self.basic.registry.paused
            && cox::pool_lifecycle(&self.basic.pool).map_err(|_| Error::InvalidAccount)?
                != cox::InstanceLifecycle::Archived
        {
            if self.basic.batch.is_some() {
                work.push(Work::Maintenance {
                    id: "basic:accepted-stage".into(),
                    pool: WorkPool::Basic,
                });
            } else if !self.basic.pool.initialized {
                work.push(Work::Entry {
                    id: "basic:bootstrap".into(),
                    pool: WorkPool::Basic,
                    eligible_after_ms: self
                        .basic
                        .pool
                        .origin
                        .checked_mul(1000)
                        .ok_or(Error::Overflow)?
                        .saturating_sub(1),
                });
            } else {
                let refresh_ms = self
                    .basic
                    .pool
                    .origin
                    .checked_add(self.basic.pool.last_batch)
                    .and_then(|timestamp| (timestamp / 3_600).checked_add(1))
                    .and_then(|hour| hour.checked_mul(3_600_000))
                    .ok_or(Error::Overflow)?;
                work.push(Work::Entry {
                    id: "basic:hourly-refresh".into(),
                    pool: WorkPool::Basic,
                    eligible_after_ms: refresh_ms - 1,
                });
                if self.basic.pool.fee_pending {
                    let cutoff_ms = self
                        .basic
                        .pool
                        .fee_pending_cutoff
                        .checked_mul(1000)
                        .ok_or(Error::Overflow)?;
                    {
                        work.push(Work::Entry {
                            id: "basic:fee-activation".into(),
                            pool: WorkPool::Basic,
                            eligible_after_ms: cutoff_ms.checked_sub(1).ok_or(Error::Overflow)?,
                        });
                    }
                }
                if self
                    .basic
                    .requests
                    .iter()
                    .all(|request| request.status != 0)
                    && self.basic.pool.queue_start < self.basic.pool.next_request_nonce
                {
                    work.push(Work::Entry {
                        id: "basic:queue-scan".into(),
                        pool: WorkPool::Basic,
                        eligible_after_ms: 0,
                    });
                }
                for request in &self.basic.requests {
                    if request.status == 0 {
                        let timestamp = self
                            .basic
                            .pool
                            .origin
                            .checked_add(request.target_batch)
                            .and_then(|v| v.checked_mul(1000))
                            .ok_or(Error::Overflow)?;
                        work.push(Work::Entry {
                            id: format!("basic:{}", request.nonce),
                            pool: WorkPool::Basic,
                            eligible_after_ms: timestamp.saturating_sub(1),
                        });
                    }
                }
            }
        }
        if self.basic.batch.is_none() && self.basic.pool.stage_batch > self.basic.pool.last_batch {
            let highwater = self
                .basic
                .pool
                .origin
                .checked_add(self.basic.pool.stage_batch)
                .and_then(|timestamp| timestamp.checked_mul(1000))
                .ok_or(Error::Overflow)?;
            for item in &mut work {
                if let Work::Entry {
                    pool: WorkPool::Basic,
                    eligible_after_ms,
                    ..
                } = item
                {
                    *eligible_after_ms = (*eligible_after_ms).max(highwater);
                }
            }
        }
        for epoch in &self.epochs {
            let Some(state) = epoch.epoch.state.as_ref() else {
                if !epoch.epoch.empty_finalized
                    && now_ms
                        >= epoch
                            .epoch
                            .opens_at
                            .saturating_add(cox_epoch::EPOCH_SECONDS)
                            .saturating_mul(1000)
                {
                    work.push(Work::Maintenance {
                        id: format!("epoch:{}:finalize-empty", epoch.epoch.opens_at),
                        pool: WorkPool::Epoch,
                    });
                }
                continue;
            };
            if state.phase() == Phase::Open {
                let closing_ms = state.closes_at().checked_mul(1000).ok_or(Error::Overflow)?;
                if now_ms >= closing_ms && state.ledger().pending_gross > 0 {
                    work.push(Work::Maintenance {
                        id: format!("epoch:{}:refund", epoch.epoch.opens_at),
                        pool: WorkPool::Epoch,
                    });
                }
                if state.executed_lots() == 0 {
                    if now_ms >= closing_ms && state.ledger().pending_gross == 0 {
                        work.push(Work::Maintenance {
                            id: format!("epoch:{}:finalize-empty", epoch.epoch.opens_at),
                            pool: WorkPool::Epoch,
                        });
                    }
                }
                let void_ms = closing_ms
                    .checked_add(
                        cox_epoch::CLOSING_GRACE_SECONDS
                            .checked_mul(1000)
                            .ok_or(Error::Overflow)?,
                    )
                    .ok_or(Error::Overflow)?;
                if now_ms > void_ms && state.executed_lots() > 0 {
                    work.push(Work::Maintenance {
                        id: format!("epoch:{}:void", epoch.epoch.opens_at),
                        pool: WorkPool::Epoch,
                    });
                } else if state.executed_lots() > 0
                    || (state.ledger().pending_gross > 0 && now_ms < closing_ms)
                {
                    work.push(Work::Close {
                        id: format!("epoch:{}:close", epoch.epoch.opens_at),
                        timestamp_ms: closing_ms,
                    });
                }
                if now_ms < closing_ms {
                    for lot in &epoch.lots {
                        if let Some(state) = lot
                            .state
                            .as_ref()
                            .filter(|state| matches!(state.state(), LotState::Pending))
                        {
                            work.push(Work::Entry {
                                id: format!("epoch:{}:{}", epoch.epoch.opens_at, lot.nonce),
                                pool: WorkPool::Epoch,
                                eligible_after_ms: state
                                    .admitted_at()
                                    .checked_mul(1000)
                                    .ok_or(Error::Overflow)?,
                            });
                        }
                    }
                }
            } else if state.phase() == Phase::Scoring
                && state.scored_lots() == state.executed_lots()
                || matches!(
                    state.phase(),
                    Phase::Scoring | Phase::Allocating | Phase::Voided | Phase::Settled
                ) && epoch.lots.iter().any(|lot| {
                    lot.state.as_ref().is_some_and(|state| {
                        matches!(
                            state.state(),
                            LotState::Executed | LotState::Scored { .. } | LotState::Pending
                        )
                    })
                })
            {
                work.push(Work::Maintenance {
                    id: format!("epoch:{}:maintenance", epoch.epoch.opens_at),
                    pool: WorkPool::Epoch,
                });
            }
        }
        Ok(work)
    }
}
fn valid_batch_phase(pool: &Pool, methodology: &Methodology, batch: &Batch) -> bool {
    if batch.closed_queue_end < batch.queue_start
        || batch.closed_queue_end > pool.next_request_nonce
    {
        return false;
    }
    if pool.schema_version == 5 && batch.schema_version != 4 {
        return false;
    }
    if matches!(batch.phase, 0 | 1 | 3) {
        return batch.cursor >= batch.queue_start && batch.cursor <= batch.closed_queue_end;
    }
    if pool.schema_version != 5 || batch.schema_version != 4 {
        return false;
    }
    let Ok(universe) = cox::read_dynamic_manifest(methodology) else {
        return false;
    };
    let n = universe.instruments.len();
    let classes = pool.classes.len();
    match batch.phase {
        4 => {
            batch.cursor == batch.queue_start
                && batch.prices.len() <= n
                && batch.references.is_empty()
                && batch.fixed.is_empty()
        }
        5 => {
            batch.cursor < (n as u64)
                && batch.prices.len() == n
                && batch.references.len() == classes
                && batch.fixed.is_empty()
                && batch.burns.len() == classes
                && batch.mints.len() == 1
        }
        6 => {
            batch.cursor < (classes as u64)
                && batch.fixed.len() == batch.cursor as usize
                && batch.prices.len() == n
                && batch.references.len() == classes
                && batch.burns.len() == classes
                && batch.mints.len() == 1
        }
        _ => false,
    }
}

pub fn plan_maintenance(
    state: &ChainState,
    operator: Address,
    now: u64,
    limit: usize,
) -> Result<Vec<Instruction>, Error> {
    plan_maintenance_inner(state, operator, now, limit, None)
}
pub fn plan_maintenance_for(
    state: &ChainState,
    operator: Address,
    now: u64,
    limit: usize,
    selected: &[Work],
) -> Result<Vec<Instruction>, Error> {
    plan_maintenance_inner(state, operator, now, limit, Some(selected))
}
fn plan_maintenance_inner(
    state: &ChainState,
    operator: Address,
    now: u64,
    limit: usize,
    selected: Option<&[Work]>,
) -> Result<Vec<Instruction>, Error> {
    if limit == 0 || limit > 32 {
        return Err(Error::Limit);
    }
    let mut instructions = Vec::new();
    if !state.basic.registry.paused
        && selected.is_none_or(|items| {
            items.iter().any(|item| {
                matches!(
                    item,
                    Work::Maintenance {
                        pool: WorkPool::Basic,
                        ..
                    }
                )
            })
        })
    {
        if let Some(batch) = &state.basic.batch {
            if matches!(batch.phase, 5 | 6) {
                instructions.push(
                    state
                        .basic
                        .accounts
                        .revalue_dynamic(
                            operator,
                            u16::try_from(batch.cursor).map_err(|_| Error::InvalidAccount)?,
                            16,
                            batch.phase == 6,
                        )
                        .map_err(|_| Error::InvalidAccount)?,
                );
            } else if batch.phase == 4 {
                return Err(Error::InvalidAccount);
            } else if batch.cursor == batch.closed_queue_end {
                instructions.push(match batch.phase {
                    0 | 3 => state.basic.accounts.seal_evaluation(),
                    1 => state.basic.accounts.finalize(operator),
                    _ => return Err(Error::InvalidAccount),
                });
            } else {
                let operation = match batch.phase {
                    0 => BasicProcess::Evaluate,
                    3 => BasicProcess::Safety,
                    1 => BasicProcess::Execute,
                    _ => return Err(Error::InvalidAccount),
                };
                for request in state.basic.requests.iter().take(limit) {
                    instructions.push(state.basic.accounts.process(
                        request.nonce,
                        address(request.owner),
                        operation,
                    ));
                }
            }
        }
    }
    for epoch in &state.epochs {
        if selected.is_some_and(|items|!items.iter().any(|item|matches!(item,Work::Maintenance{id,..} if id.starts_with(&format!("epoch:{}:",epoch.epoch.opens_at))))) {continue;}
        if instructions.len() >= limit {
            break;
        }
        let Some(current) = epoch.epoch.state.as_ref() else {
            if !epoch.epoch.empty_finalized
                && now
                    >= epoch
                        .epoch
                        .opens_at
                        .saturating_add(cox_epoch::EPOCH_SECONDS)
            {
                instructions.push(epoch.accounts.finalize_empty());
            }
            continue;
        };
        if current.phase() == Phase::Open
            && now >= current.closes_at()
            && current.executed_lots() == 0
            && current.ledger().pending_gross == 0
        {
            instructions.push(epoch.accounts.finalize_empty());
            continue;
        }
        if current.phase() == Phase::Open
            && now
                > current
                    .closes_at()
                    .checked_add(cox_epoch::CLOSING_GRACE_SECONDS)
                    .ok_or(Error::Overflow)?
        {
            instructions.push(epoch.accounts.void_epoch());
            continue;
        }
        if current.phase() == Phase::Scoring && current.scored_lots() == current.executed_lots() {
            instructions.push(epoch.accounts.finalize_scores());
            continue;
        }
        for lot in &epoch.lots {
            if instructions.len() >= limit {
                break;
            }
            let Some(entry) = lot.state.as_ref() else {
                continue;
            };
            let action = match entry.state() {
                LotState::Pending if now >= current.closes_at() => Some(EpochLotOperation::Refund),
                LotState::Executed if current.phase() == Phase::Voided => {
                    Some(EpochLotOperation::Refund)
                }
                LotState::Executed if current.phase() == Phase::Scoring => {
                    Some(EpochLotOperation::Score)
                }
                LotState::Scored { .. } if current.phase() == Phase::Allocating => {
                    Some(EpochLotOperation::Allocate)
                }
                _ => None,
            };
            if let Some(action) = action {
                instructions.push(epoch.accounts.process_lot(lot.nonce, action));
            }
        }
    }
    Ok(instructions)
}

fn validate_vault(raw: &Raw, owner: Address, mint: Address, minimum: u64) -> Result<u64, Error> {
    let token_program = Address::new_from_array(anchor_spl::token::ID.to_bytes());
    let account: anchor_spl::token::TokenAccount = decode(raw, token_program)?;
    if address(account.owner) != owner
        || address(account.mint) != mint
        || account.amount < minimum
        || account.delegate.is_some()
        || account.close_authority.is_some()
        || account.is_native.is_some()
        || account.state != anchor_spl::token::spl_token::state::AccountState::Initialized
    {
        return Err(Error::InvalidAccount);
    }
    Ok(account.amount)
}
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    fn key(byte: u8) -> Address {
        Address::new_from_array([byte; 32])
    }
    fn zero<T: AccountDeserialize + Discriminator>() -> T {
        let mut data = T::DISCRIMINATOR.to_vec();
        data.resize(20_000, 0);
        T::try_deserialize(&mut data.as_slice()).unwrap()
    }
    #[test]
    fn confirmed_clock_rejects_wrong_identity_owner_shape_and_timestamp() {
        let mut row = Raw {
            address: "SysvarC1ock11111111111111111111111111111111"
                .parse()
                .unwrap(),
            owner: "Sysvar1111111111111111111111111111111111111"
                .parse()
                .unwrap(),
            data: vec![0; 40],
        };
        row.data[32..40].copy_from_slice(&14_410i64.to_le_bytes());
        assert_eq!(clock_timestamp_ms(&row), Ok(14_410_000));
        row.data[32..40].copy_from_slice(&(-1i64).to_le_bytes());
        assert_eq!(clock_timestamp_ms(&row), Err(Error::InvalidAccount));
        row.data[32..40].copy_from_slice(&i64::MAX.to_le_bytes());
        assert_eq!(clock_timestamp_ms(&row), Err(Error::InvalidAccount));
        row.data[32..40].copy_from_slice(&14_410i64.to_le_bytes());
        row.owner = key(4);
        assert_eq!(clock_timestamp_ms(&row), Err(Error::InvalidAccount));
        row.owner = "Sysvar1111111111111111111111111111111111111"
            .parse()
            .unwrap();
        row.address = key(5);
        assert_eq!(clock_timestamp_ms(&row), Err(Error::InvalidAccount));
        row.address = "SysvarC1ock11111111111111111111111111111111"
            .parse()
            .unwrap();
        row.data.pop();
        assert_eq!(clock_timestamp_ms(&row), Err(Error::InvalidAccount));
    }
    pub(crate) fn state() -> ChainState {
        let mut pool: Pool = zero();
        pool.schema_version = 4;
        pool.pool_id = 2;
        pool.origin = 14_400;
        pool.initialized = true;
        let mut registry: Registry = zero();
        registry.runtime = anchor_lang::prelude::Pubkey::new_from_array(key(7).to_bytes());
        ChainState {
            slot: 1,
            confirmed_timestamp_ms: 14_410_000,
            digest: [0; 32],
            discovery_incomplete: false,
            basic: BasicState {
                accounts: BasicAccounts::derive(key(1), 2, [1; 32]),
                pool,
                registry,
                methodology: zero(),
                batch: None,
                requests: vec![],
            },
            epoch_config: zero(),
            epochs: vec![],
        }
    }
    pub(crate) fn dynamic_state(count: usize) -> ChainState {
        let mut state = state();
        let universe = crate::transactions::dynamic_test_universe(count);
        state.basic.pool.schema_version = 5;
        state.basic.pool.classes = (0..=count)
            .map(|_| cox::Class {
                backing: 0,
                units: 0,
            })
            .collect();
        state.basic.pool.sequence = 1;
        state.basic.pool.benchmark = 100 * cox_math::SCALE;
        state.basic.pool.origin_prices = vec![100; count];
        state.basic.pool.last_prices = vec![100; count];
        state.basic.methodology.schema_version = 3;
        state.basic.methodology.sealed = true;
        state.basic.methodology.bybit = false;
        state.basic.methodology.origin = 14_400;
        state.basic.methodology.roster = (0..count).map(|index| index as u8).collect();
        state.basic.methodology.canonical = universe.canonical_bytes().unwrap();
        state.basic.methodology.expected_length = state.basic.methodology.canonical.len() as u32;
        state.basic.methodology.digest = universe.digest;
        state.basic.accounts = BasicAccounts::derive(key(1), 2, universe.digest);
        state
    }
    pub(crate) fn dynamic_stage(count: usize, phase: u8, cursor: u64) -> ChainState {
        let mut state = dynamic_state(count);
        let mut batch: Batch = zero();
        batch.schema_version = 4;
        batch.phase = phase;
        batch.cursor = cursor;
        batch.cutoff = 14_410;
        batch.batch_id = 10;
        batch.sequence = 2;
        batch.benchmark = 101 * cox_math::SCALE;
        if phase >= 5 {
            batch.prices = (0..count)
                .map(|_| cox::PriceWire {
                    price_e8: 101,
                    venue: 3,
                    step: 0,
                    candle_start: 14_410,
                    trade_age_minutes: 0,
                })
                .collect();
            batch.references = vec![100 * cox_math::SCALE; count + 1];
            batch.burns = vec![0; count + 1];
            batch.mints = vec![0];
        }
        if phase == 6 {
            batch.fixed = (0..cursor)
                .map(|_| cox::Class {
                    backing: 0,
                    units: 0,
                })
                .collect();
        }
        state.basic.batch = Some(batch);
        state
    }
    #[test]
    fn dynamic_stage_cursor_uses_assets_and_classes_instead_of_closed_request_queue() {
        let mut state = dynamic_stage(255, 5, 240);
        assert!(valid_batch_phase(
            &state.basic.pool,
            &state.basic.methodology,
            state.basic.batch.as_ref().unwrap()
        ));
        assert_eq!(
            plan_maintenance(&state, key(7), 14_411, 4).unwrap(),
            vec![state
                .basic
                .accounts
                .revalue_dynamic(key(7), 240, 16, false)
                .unwrap()]
        );
        state = dynamic_stage(255, 6, 255);
        assert!(valid_batch_phase(
            &state.basic.pool,
            &state.basic.methodology,
            state.basic.batch.as_ref().unwrap()
        ));
        assert_eq!(
            plan_maintenance(&state, key(7), 14_411, 4).unwrap(),
            vec![state
                .basic
                .accounts
                .revalue_dynamic(key(7), 255, 16, true)
                .unwrap()]
        );
        state.basic.batch.as_mut().unwrap().cursor = 256;
        assert!(!valid_batch_phase(
            &state.basic.pool,
            &state.basic.methodology,
            state.basic.batch.as_ref().unwrap()
        ));
        state = dynamic_stage(255, 4, 0);
        assert!(valid_batch_phase(
            &state.basic.pool,
            &state.basic.methodology,
            state.basic.batch.as_ref().unwrap()
        ));
        state.basic.batch.as_mut().unwrap().prices = (0..256)
            .map(|_| cox::PriceWire {
                price_e8: 101,
                venue: 3,
                step: 0,
                candle_start: 14_410,
                trade_age_minutes: 0,
            })
            .collect();
        assert!(!valid_batch_phase(
            &state.basic.pool,
            &state.basic.methodology,
            state.basic.batch.as_ref().unwrap()
        ));
    }
    pub(crate) fn epoch(with_lot: bool) -> EpochState {
        let accounts = EpochAccounts::derive(key(2), key(3), 14_400).unwrap();
        let config = cox_epoch::Config {
            pool: key(3).to_bytes(),
            admin: [4; 32],
            operator: [7; 32],
            collateral_mint: [5; 32],
            collateral_decimals: 6,
            methodology: [1; 32],
            origin_benchmark: 1_000_000,
            max_entry_price_age: 60,
            max_lots: 64,
        };
        let assets = (0..30)
            .map(|id| cox_epoch::Asset {
                id,
                feed_id: [id as u8 + 1; 32],
                origin_price: 1_000_000,
            })
            .collect();
        let mut engine = cox_epoch::Epoch::create(config, [4; 32], 14_400, 14_400, assets).unwrap();
        let mut lots = vec![];
        if with_lot {
            let lot = engine
                .queue(
                    [9; 32],
                    0,
                    1_000_000,
                    core::array::from_fn(|i| i as u16),
                    0,
                    14_401,
                    1_000_000,
                )
                .unwrap();
            let mut account: LotAccount = zero();
            account.epoch = anchor_lang::prelude::Pubkey::new_from_array(accounts.epoch.to_bytes());
            account.nonce = 0;
            account.state = Some(lot);
            lots.push(account);
        }
        let mut epoch: EpochAccount = zero();
        epoch.opens_at = 14_400;
        epoch.state = Some(engine);
        EpochState {
            accounts,
            epoch,
            lots,
        }
    }
    #[test]
    fn rejects_retired_legacy_and_wrong_runtime() {
        let mut s = state();
        assert_eq!(
            validate_basic(&s.basic.pool, &s.basic.registry, 2, key(7)),
            Ok(())
        );
        assert_eq!(
            validate_basic(&s.basic.pool, &s.basic.registry, 1, key(7)),
            Err(Error::RetiredPool)
        );
        s.basic.pool.schema_version = 3;
        assert_eq!(
            validate_basic(&s.basic.pool, &s.basic.registry, 2, key(7)),
            Err(Error::RetiredPool)
        );
        s.basic.pool.schema_version = 4;
        assert_eq!(
            validate_basic(&s.basic.pool, &s.basic.registry, 2, key(8)),
            Err(Error::WrongAuthority)
        );
    }
    #[test]
    fn rejects_forged_account_owner_and_discriminator() {
        let row = Raw {
            address: key(1),
            owner: key(2),
            data: vec![0; 100],
        };
        assert!(matches!(
            decode::<Pool>(&row, key(3)),
            Err(Error::WrongOwner)
        ));
        assert!(matches!(
            decode::<Pool>(&row, key(2)),
            Err(Error::InvalidAccount)
        ));
    }
    #[test]
    fn custody_rejects_wrong_mints_authorities_and_unsafe_token_state() {
        let token_program = address(anchor_spl::token::ID);
        let owner = key(4);
        let mint = key(5);
        let mut data = vec![0_u8; 165];
        data[..32].copy_from_slice(mint.as_ref());
        data[32..64].copy_from_slice(owner.as_ref());
        data[64..72].copy_from_slice(&123_u64.to_le_bytes());
        data[108] = 1;
        let row = Raw {
            address: key(6),
            owner: token_program,
            data,
        };
        assert_eq!(validate_vault(&row, owner, mint, 123), Ok(123));
        assert_eq!(
            validate_vault(&row, owner, mint, 124),
            Err(Error::InvalidAccount)
        );
        assert_eq!(
            validate_vault(&row, owner, key(7), 0),
            Err(Error::InvalidAccount)
        );
        assert_eq!(
            validate_vault(&row, key(7), mint, 0),
            Err(Error::InvalidAccount)
        );
        let mut wrong = row.clone();
        wrong.owner = key(7);
        assert_eq!(
            validate_vault(&wrong, owner, mint, 0),
            Err(Error::WrongOwner)
        );
        for offset in [72, 109, 129] {
            let mut wrong = row.clone();
            wrong.data[offset..offset + 4].copy_from_slice(&1_u32.to_le_bytes());
            assert_eq!(
                validate_vault(&wrong, owner, mint, 0),
                Err(Error::InvalidAccount)
            );
        }
        let mut frozen = row.clone();
        frozen.data[108] = 2;
        assert_eq!(
            validate_vault(&frozen, owner, mint, 0),
            Err(Error::InvalidAccount)
        );
        let mut state = state();
        state.basic.pool.test_collateral_mint = Some(state.basic.pool.collateral_mint);
        assert_eq!(
            validate_basic(&state.basic.pool, &state.basic.registry, 2, key(7)),
            Err(Error::InvalidAccount)
        );
    }
    #[test]
    fn bootstrap_wakes_without_users_and_pause_suppresses_basic() {
        let mut s = state();
        s.basic.pool.initialized = false;
        assert!(matches!(
            &s.work(0).unwrap()[0],
            Work::Entry {
                eligible_after_ms: 14_399_999,
                ..
            }
        ));
        s.basic.registry.paused = true;
        assert!(s.work(0).unwrap().is_empty());
    }
    #[test]
    fn cancelled_preparation_highwater_requires_newer_price_without_replaying_canceled_timestamp() {
        let mut s = dynamic_state(31);
        s.basic.pool.stage_batch = 10;
        s.basic.pool.last_batch = 0;
        s.basic.pool.next_request_nonce = 1;
        let mut request: Request = zero();
        request.status = 0;
        request.nonce = 0;
        request.target_batch = 9;
        s.basic.requests.push(request);
        let work = s.work(14_410_000).unwrap();
        assert!(
            work.iter().any(|item| matches!(item,Work::Entry{id,eligible_after_ms,..} if id == "basic:0" && *eligible_after_ms==14_410_000))
        );
        assert_eq!(
            crate::scheduler::decide(
                14_410_000,
                &crate::scheduler::Checkpoint::default(),
                &work,
                2
            )
            .unwrap(),
            crate::scheduler::Decision::Idle {
                wake_ms: Some(14_410_001)
            }
        );
    }
    #[test]
    fn hourly_refresh_wakes_on_utc_boundary_without_orders_and_returns_to_idle() {
        let mut state = state();
        state.basic.pool.origin = 14_421;
        state.basic.pool.last_batch = 122;
        let boundary = 18_000_000;
        let checkpoint = crate::scheduler::Checkpoint::default();
        let work = state.work(boundary - 1).unwrap();
        assert_eq!(
            work,
            vec![Work::Entry {
                id: "basic:hourly-refresh".into(),
                pool: WorkPool::Basic,
                eligible_after_ms: boundary - 1,
            }]
        );
        assert_eq!(
            crate::scheduler::decide(boundary - 1, &checkpoint, &work, 4).unwrap(),
            crate::scheduler::Decision::Idle {
                wake_ms: Some(boundary)
            }
        );
        assert!(matches!(
            crate::scheduler::decide(boundary, &checkpoint, &work, 4).unwrap(),
            crate::scheduler::Decision::Publish {
                closing_ms: None,
                ..
            }
        ));
        state.basic.pool.last_batch = 18_002 - state.basic.pool.origin;
        let work = state.work(boundary + 3_000).unwrap();
        assert_eq!(
            crate::scheduler::decide(boundary + 3_000, &checkpoint, &work, 4).unwrap(),
            crate::scheduler::Decision::Idle {
                wake_ms: Some(21_600_000)
            }
        );
    }

    #[test]
    fn hourly_refresh_coalesces_missed_hours_and_preserves_pause_and_stage() {
        let mut state = state();
        let now = 36_000_000;
        assert!(matches!(
            crate::scheduler::decide(
                now,
                &crate::scheduler::Checkpoint::default(),
                &state.work(now).unwrap(),
                4
            )
            .unwrap(),
            crate::scheduler::Decision::Publish {
                closing_ms: None,
                ..
            }
        ));
        state.basic.pool.last_batch = 36_001 - state.basic.pool.origin;
        assert_eq!(
            crate::scheduler::decide(
                now + 2_000,
                &crate::scheduler::Checkpoint::default(),
                &state.work(now + 2_000).unwrap(),
                4
            )
            .unwrap(),
            crate::scheduler::Decision::Idle {
                wake_ms: Some(39_600_000)
            }
        );
        state.basic.registry.paused = true;
        assert!(state.work(now).unwrap().is_empty());
        state.basic.registry.paused = false;
        state.basic.batch = Some(zero());
        assert!(matches!(
            state.work(now).unwrap().as_slice(),
            [Work::Maintenance { .. }]
        ));
        state.basic.batch = None;
        state.basic.pool.origin = u64::MAX;
        assert_eq!(state.work(now), Err(Error::Overflow));
    }

    #[test]
    fn pending_fee_activation_wakes_after_bootstrap_and_stops_after_commit() {
        let mut s = state();
        s.basic.pool.initialized = false;
        s.basic.pool.fee_pending = true;
        s.basic.pool.fee_pending_cutoff = s.basic.pool.origin + 60;
        let cutoff_ms = s.basic.pool.fee_pending_cutoff * 1000;
        let bootstrap = s.work(cutoff_ms).unwrap();
        assert_eq!(bootstrap.len(), 1);
        assert!(matches!(&bootstrap[0], Work::Entry {id, ..} if id == "basic:bootstrap"));
        s.basic.pool.initialized = true;
        let future = s.work(cutoff_ms - 1).unwrap();
        assert!(future.iter().any(|item| matches!(item, Work::Entry { id, eligible_after_ms, .. } if id == "basic:fee-activation" && *eligible_after_ms == cutoff_ms - 1)));
        assert_eq!(
            crate::scheduler::decide(
                cutoff_ms - 1,
                &crate::scheduler::Checkpoint::default(),
                &future,
                4
            )
            .unwrap(),
            crate::scheduler::Decision::Idle {
                wake_ms: Some(cutoff_ms)
            }
        );
        let due = s.work(cutoff_ms).unwrap();
        assert!(due.iter().any(|item| matches!(item, Work::Entry {id, pool: WorkPool::Basic, eligible_after_ms} if id == "basic:fee-activation" && *eligible_after_ms == cutoff_ms - 1)));
        s.basic.pool.fee_pending = false;
        s.basic.pool.fee_version = 1;
        s.basic.pool.fee_bps = 2;
        s.basic.pool.fee_cap = 200_000;
        assert!(!s
            .work(cutoff_ms + 1_000)
            .unwrap()
            .iter()
            .any(|item| matches!(item, Work::Entry { id, .. } if id == "basic:fee-activation")));
    }
    #[test]
    fn pending_fee_activation_respects_pause_accepted_stage_and_checked_cutoff() {
        let mut s = state();
        s.basic.pool.fee_pending = true;
        s.basic.pool.fee_pending_cutoff = s.basic.pool.origin + 60;
        let cutoff_ms = s.basic.pool.fee_pending_cutoff * 1000;
        s.basic.registry.paused = true;
        assert!(s.work(cutoff_ms).unwrap().is_empty());
        s.basic.registry.paused = false;
        s.basic.batch = Some(zero());
        let stage = s.work(cutoff_ms).unwrap();
        assert_eq!(stage.len(), 1);
        assert!(
            matches!(&stage[0], Work::Maintenance {id, pool: WorkPool::Basic} if id == "basic:accepted-stage")
        );
        s.basic.batch = None;
        s.basic.pool.fee_pending_cutoff = u64::MAX;
        assert!(matches!(s.work(cutoff_ms), Err(Error::Overflow)));
        s.basic.pool.fee_pending_cutoff = 0;
        assert!(matches!(s.work(0), Err(Error::Overflow)));
    }
    #[test]
    fn accepted_basic_snapshot_only_drains_original_phase_and_cursor() {
        let mut s = state();
        let mut batch: Batch = zero();
        batch.phase = 3;
        batch.cursor = 4;
        batch.closed_queue_end = 6;
        batch.snapshot_digest = [19; 32];
        s.basic.batch = Some(batch);
        for nonce in 4..6 {
            let mut request: Request = zero();
            request.nonce = nonce;
            request.owner = anchor_lang::prelude::Pubkey::new_from_array([9; 32]);
            s.basic.requests.push(request);
        }
        let instructions = plan_maintenance(&s, key(7), 90_000, 1).unwrap();
        assert_eq!(instructions.len(), 1);
        assert_eq!(
            instructions[0],
            s.basic.accounts.process(4, key(9), BasicProcess::Safety)
        );
        assert_eq!(s.basic.batch.as_ref().unwrap().snapshot_digest, [19; 32]);
        s.basic.batch.as_mut().unwrap().cursor = 6;
        assert_eq!(
            plan_maintenance(&s, key(7), 90_000, 8).unwrap(),
            vec![s.basic.accounts.seal_evaluation()]
        );
    }
    #[test]
    fn epoch_pending_lot_refunds_at_close_and_void_waits_strict_grace() {
        let mut s = state();
        s.epochs.push(epoch(true));
        assert!(plan_maintenance(&s, key(7), 28_799, 8).unwrap().is_empty());
        assert_eq!(
            plan_maintenance(&s, key(7), 28_800, 8).unwrap(),
            vec![s.epochs[0]
                .accounts
                .process_lot(0, EpochLotOperation::Refund)]
        );
        assert_eq!(
            plan_maintenance(&s, key(7), 115_200, 8).unwrap(),
            vec![s.epochs[0]
                .accounts
                .process_lot(0, EpochLotOperation::Refund)]
        );
        assert_eq!(
            plan_maintenance(&s, key(7), 115_201, 8).unwrap(),
            vec![s.epochs[0].accounts.void_epoch()]
        );
    }
    #[test]
    fn epoch_work_keeps_exact_closing_timestamp_and_entry_admission() {
        let mut s = state();
        s.epochs.push(epoch(true));
        let work = s.work(14_402_000).unwrap();
        assert!(work.iter().any(|w| matches!(
            w,
            Work::Close {
                timestamp_ms: 28_800_000,
                ..
            }
        )));
        assert!(work.iter().any(|w| matches!(
            w,
            Work::Entry {
                pool: WorkPool::Epoch,
                eligible_after_ms: 14_401_000,
                ..
            }
        )));
        assert!(!s.work(28_800_000).unwrap().iter().any(|w| matches!(
            w,
            Work::Entry {
                pool: WorkPool::Epoch,
                ..
            }
        )));
        let entry = cox_epoch::OperatorSnapshot {
            id: [1; 32],
            methodology: [1; 32],
            sequence: 1,
            oracle_timestamp: 14_402,
            benchmark: 1_000_000,
            prices: (0..30)
                .map(|asset_id| cox_epoch::Price {
                    asset_id,
                    feed_id: [asset_id as u8 + 1; 32],
                    value: 1_000_000,
                })
                .collect(),
        };
        let epoch = &mut s.epochs[0];
        epoch
            .epoch
            .state
            .as_mut()
            .unwrap()
            .execute(
                [7; 32],
                epoch.lots[0].state.as_mut().unwrap(),
                &entry,
                14_402,
                1_000_000,
            )
            .unwrap();
        assert!(matches!(
            crate::scheduler::decide(
                28_800_000,
                &crate::scheduler::Checkpoint::default(),
                &s.work(28_800_000).unwrap(),
                4,
            )
            .unwrap(),
            crate::scheduler::Decision::Publish {
                closing_ms: Some(28_800_000),
                ..
            }
        ));
    }
    #[test]
    fn epoch_scoring_and_allocation_follow_persisted_phase() {
        let mut s = state();
        let mut e = epoch(true);
        let prices = (0..30)
            .map(|asset_id| cox_epoch::Price {
                asset_id,
                feed_id: [asset_id as u8 + 1; 32],
                value: 1_000_000,
            })
            .collect::<Vec<_>>();
        let entry = cox_epoch::OperatorSnapshot {
            id: [1; 32],
            methodology: [1; 32],
            sequence: 1,
            oracle_timestamp: 14_402,
            benchmark: 1_000_000,
            prices: prices.clone(),
        };
        let close = cox_epoch::OperatorSnapshot {
            id: [2; 32],
            methodology: [1; 32],
            sequence: 2,
            oracle_timestamp: 28_800,
            benchmark: 1_000_000,
            prices,
        };
        let engine = e.epoch.state.as_mut().unwrap();
        let lot = e.lots[0].state.as_mut().unwrap();
        engine
            .execute([7; 32], lot, &entry, 14_402, 1_000_000)
            .unwrap();
        engine
            .begin_close([7; 32], close, 28_800, 1_000_000)
            .unwrap();
        s.epochs.push(e);
        assert_eq!(
            plan_maintenance(&s, key(7), 28_800, 8).unwrap(),
            vec![s.epochs[0]
                .accounts
                .process_lot(0, EpochLotOperation::Score)]
        );
        let e = &mut s.epochs[0];
        let engine = e.epoch.state.as_mut().unwrap();
        engine
            .score_entry(e.lots[0].state.as_mut().unwrap(), 1_000_000)
            .unwrap();
        assert_eq!(
            plan_maintenance(&s, key(7), 28_800, 8).unwrap(),
            vec![s.epochs[0].accounts.finalize_scores()]
        );
        s.epochs[0]
            .epoch
            .state
            .as_mut()
            .unwrap()
            .finalize_scores(1_000_000)
            .unwrap();
        assert_eq!(
            plan_maintenance(&s, key(7), 28_800, 8).unwrap(),
            vec![s.epochs[0]
                .accounts
                .process_lot(0, EpochLotOperation::Allocate)]
        );
    }

    #[test]
    fn canceled_prefix_cannot_hide_later_basic_work() {
        let mut s = state();
        s.basic.pool.next_request_nonce = 20;
        for nonce in 0..16 {
            let mut request: Request = zero();
            request.nonce = nonce;
            request.status = 1;
            s.basic.requests.push(request);
        }
        assert!(s
            .work(20_000_000)
            .unwrap()
            .iter()
            .any(|work| matches!(work,Work::Entry{id,..} if id=="basic:queue-scan")));
    }

    #[test]
    fn accepted_bootstrap_stage_drains_before_any_second_publication() {
        let mut s = state();
        s.basic.pool.initialized = false;
        let mut batch: Batch = zero();
        batch.phase = 0;
        s.basic.batch = Some(batch);
        assert_eq!(
            s.work(14_401_000).unwrap(),
            vec![Work::Maintenance {
                id: "basic:accepted-stage".into(),
                pool: WorkPool::Basic
            }]
        );
        assert_eq!(
            plan_maintenance(&s, key(7), 14_401, 1).unwrap(),
            vec![s.basic.accounts.seal_evaluation()]
        );
    }

    #[test]
    fn selected_epoch_maintenance_cannot_be_starved_by_basic_backlog() {
        let mut s = state();
        let mut batch: Batch = zero();
        batch.phase = 0;
        batch.closed_queue_end = 16;
        s.basic.batch = Some(batch);
        for nonce in 0..16 {
            let mut request: Request = zero();
            request.nonce = nonce;
            s.basic.requests.push(request);
        }
        s.epochs.push(epoch(true));
        let selected = [Work::Maintenance {
            id: "epoch:14400:refund".into(),
            pool: WorkPool::Epoch,
        }];
        assert_eq!(
            plan_maintenance_for(&s, key(7), 28_800, 1, &selected).unwrap(),
            vec![s.epochs[0]
                .accounts
                .process_lot(0, EpochLotOperation::Refund)]
        );
    }
    #[test]
    fn discovery_tracks_every_unfinished_round_across_boundaries() {
        let step = cox_epoch::EPOCH_SECONDS;
        let mut discovery = Discovery::new(key(1), key(2), step).unwrap();
        for current in [step, 2 * step, 3 * step, 4 * step] {
            let (openings, scan) = discovery.openings(current).unwrap();
            for opens in openings {
                discovery.record_epoch(opens, false).unwrap();
            }
            discovery.finish_scan(scan, current);
        }
        assert_eq!(discovery.state.next_epoch, step);
        assert_eq!(discovery.state.scan_epoch, 4 * step);
        assert_eq!(
            discovery.state.tracked_epochs,
            BTreeSet::from([step, 2 * step, 3 * step, 4 * step])
        );
        discovery.record_epoch(2 * step, true).unwrap();
        discovery.finish_scan(4 * step, 4 * step);
        assert_eq!(discovery.state.next_epoch, step);
        discovery.record_epoch(step, true).unwrap();
        discovery.finish_scan(4 * step, 4 * step);
        assert_eq!(discovery.state.next_epoch, 3 * step);
    }

    #[test]
    fn discovery_inspects_missed_history_in_bounded_pages_without_losing_current() {
        let step = cox_epoch::EPOCH_SECONDS;
        let mut discovery = Discovery::new(key(1), key(2), step).unwrap();
        let current = 30 * step;
        let mut inspected = BTreeSet::new();
        while discovery.state.scan_epoch < current {
            let (openings, scan) = discovery.openings(current).unwrap();
            assert!(scan - discovery.state.scan_epoch <= MAX_EPOCH_SCAN as u64 * step);
            assert!(openings.contains(&current));
            for opens in openings {
                inspected.insert(opens);
                discovery
                    .record_epoch(opens, opens != 5 * step && opens != current)
                    .unwrap();
            }
            discovery.finish_scan(scan, current);
        }
        assert_eq!(inspected, (1..=30).map(|n| n * step).collect());
        assert_eq!(discovery.state.next_epoch, 5 * step);
        assert_eq!(
            discovery.state.tracked_epochs,
            BTreeSet::from([5 * step, current])
        );
        assert!(!discovery.incomplete || discovery.state.scan_epoch == current);
    }

    #[test]
    fn discovery_restart_migrates_legacy_and_rejects_corrupt_state() {
        let step = cox_epoch::EPOCH_SECONDS;
        let path = std::env::temp_dir().join(format!(
            "relative-discovery-migration-{}.json",
            std::process::id()
        ));
        let mut original = Discovery::new(key(1), key(2), step).unwrap();
        original.state.schema = 1;
        original.state.scan_epoch = 0;
        original
            .state
            .cursors
            .insert(3 * step, LotCursor { phase: 0, next: 4 });
        crate::journal::atomic_write(&path, &original.state).unwrap();
        let mut migrated = Discovery::load(&path, key(1), key(2), step).unwrap();
        assert_eq!(migrated.state.schema, 2);
        assert_eq!(migrated.state.scan_epoch, step);
        assert!(migrated.state.tracked_epochs.contains(&(3 * step)));
        migrated.path = Some(path.clone());
        migrated.save().unwrap();
        assert_eq!(
            Discovery::load(&path, key(1), key(2), step).unwrap().state,
            migrated.state
        );
        migrated.state.next_epoch = 2 * step;
        migrated.save().unwrap();
        assert!(matches!(
            Discovery::load(&path, key(1), key(2), step),
            Err(Error::Storage)
        ));
        std::fs::write(&path, b"{broken").unwrap();
        assert!(matches!(
            Discovery::load(&path, key(1), key(2), step),
            Err(Error::Storage)
        ));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn discovery_finalized_confirmation_is_required_before_forgetting_rounds() {
        let step = cox_epoch::EPOCH_SECONDS;
        let mut discovery = Discovery::new(key(1), key(2), step).unwrap();
        discovery.record_epoch(step, false).unwrap();
        discovery.finish_scan(3 * step, 3 * step);
        assert_eq!(discovery.state.next_epoch, step);
        discovery.record_epoch(step, false).unwrap();
        assert!(discovery.state.tracked_epochs.contains(&step));
        discovery.record_epoch(step, true).unwrap();
        discovery.finish_scan(3 * step, 3 * step);
        assert_eq!(discovery.state.next_epoch, 3 * step);
        assert!(discovery.state.tracked_epochs.is_empty());
    }

    #[test]
    fn discovery_can_restart_after_removing_oldest_before_finishing_scan() {
        let step = cox_epoch::EPOCH_SECONDS;
        let path = std::env::temp_dir().join(format!(
            "relative-discovery-prefix-{}.json",
            std::process::id()
        ));
        let mut discovery = Discovery::new(key(1), key(2), step).unwrap();
        discovery.path = Some(path.clone());
        discovery.record_epoch(step, false).unwrap();
        discovery.record_epoch(2 * step, false).unwrap();
        discovery.finish_scan(3 * step, 3 * step);
        discovery.record_epoch(step, true).unwrap();
        assert_eq!(discovery.state.next_epoch, 2 * step);
        discovery.save().unwrap();
        let restarted = Discovery::load(&path, key(1), key(2), step).unwrap();
        assert_eq!(restarted.state, discovery.state);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn discovery_terminal_proof_rejects_confirmation_lag_and_forked_presence() {
        let mut active = epoch(false).epoch;
        let mut terminal = active.clone();
        terminal.empty_finalized = true;
        assert!(finalized_epoch_done(None, None, 28_800));
        assert!(!finalized_epoch_done(Some(&terminal), None, 28_800));
        assert!(!finalized_epoch_done(None, Some(&terminal), 28_800));
        assert!(!finalized_epoch_done(
            Some(&terminal),
            Some(&active),
            28_800
        ));
        assert!(finalized_epoch_done(
            Some(&terminal),
            Some(&terminal),
            28_800
        ));
        active.empty_finalized = true;
        assert!(finalized_epoch_done(Some(&active), Some(&terminal), 28_800));
    }

    #[test]
    fn discovery_capacity_fails_closed_and_clock_regression_is_rejected() {
        let step = cox_epoch::EPOCH_SECONDS;
        let mut discovery = Discovery::new(key(1), key(2), step).unwrap();
        for n in 1..=MAX_TRACKED_EPOCHS as u64 {
            discovery.record_epoch(n * step, false).unwrap();
        }
        assert_eq!(
            discovery.record_epoch((MAX_TRACKED_EPOCHS as u64 + 1) * step, false),
            Err(Error::Limit)
        );
        assert_eq!(discovery.state.tracked_epochs.len(), MAX_TRACKED_EPOCHS);
        discovery.finish_scan(3 * step, 3 * step);
        assert_eq!(discovery.openings(2 * step), Err(Error::UnstableRead));
    }

    #[test]
    fn nonce_pages_cross_hundreds_of_accounts_and_resume_without_skipping_pending() {
        let path =
            std::env::temp_dir().join(format!("relative-discovery-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut discovery = Discovery::load(&path, key(1), key(2), 14_400).unwrap();
        let mut states = vec![LotState::Executed; 257];
        states[241] = LotState::Pending;
        let mut page_count = 0;
        loop {
            let start = discovery
                .cursor(14_400, Phase::Open, states.len() as u64)
                .unwrap();
            let end = (start + LOT_PAGE).min(states.len() as u64);
            let prefix = advance_prefix(start, Phase::Open, &states[start as usize..end as usize]);
            discovery.state.cursors.get_mut(&14_400).unwrap().next = prefix;
            discovery.save().unwrap();
            page_count += 1;
            if prefix < end {
                break;
            }
        }
        assert!(page_count > 100 / LOT_PAGE);
        let mut restarted = Discovery::load(&path, key(1), key(2), 14_400).unwrap();
        assert_eq!(restarted.cursor(14_400, Phase::Open, 257).unwrap(), 241);
        assert_eq!(advance_prefix(241, Phase::Open, &states[241..]), 241);
        assert_eq!(restarted.cursor(14_400, Phase::Scoring, 257).unwrap(), 0);
        assert_eq!(advance_prefix(0, Phase::Scoring, &states[..16]), 0);
        assert!(Discovery::load(&path, key(3), key(2), 14_400).is_err());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn finalized_cursor_cannot_skip_unexecuted_lots_or_unscored_lots() {
        assert_eq!(
            advance_prefix(
                100,
                Phase::Open,
                &[
                    LotState::Claimable { amount: 1 },
                    LotState::Pending,
                    LotState::Executed
                ]
            ),
            101
        );
        assert_eq!(
            advance_prefix(
                100,
                Phase::Scoring,
                &[
                    LotState::Scored {
                        score: 1,
                        weight: 1
                    },
                    LotState::Executed
                ]
            ),
            101
        );
        assert_eq!(
            advance_prefix(
                100,
                Phase::Allocating,
                &[
                    LotState::Claimable { amount: 1 },
                    LotState::Scored {
                        score: 1,
                        weight: 1
                    }
                ]
            ),
            101
        );
        assert_eq!(
            advance_prefix(
                100,
                Phase::Settled,
                &[LotState::Withdrawn, LotState::Pending]
            ),
            101
        );
        assert_eq!(
            advance_prefix(
                100,
                Phase::Voided,
                &[LotState::Claimable { amount: 1 }, LotState::Executed]
            ),
            101
        );
    }
    #[test]
    fn arrivals_do_not_invalidate_read_but_publication_and_fees_do() {
        let mut state = state();
        let before = basic_guard(&state.basic.pool, &state.basic.registry);
        state.basic.pool.next_request_nonce += 1000;
        state.basic.pool.pending += 1000;
        assert_eq!(
            before,
            basic_guard(&state.basic.pool, &state.basic.registry)
        );
        state.basic.pool.sequence += 1;
        assert_ne!(
            before,
            basic_guard(&state.basic.pool, &state.basic.registry)
        );
        state.basic.pool.sequence -= 1;
        state.basic.pool.fee_pending_cap += 1;
        assert_ne!(
            before,
            basic_guard(&state.basic.pool, &state.basic.registry)
        );
    }
    #[test]
    fn scoring_completion_needs_no_lot_page_to_finalize() {
        let mut state = state();
        let mut epoch = epoch(true);
        let entry = cox_epoch::OperatorSnapshot {
            id: [1; 32],
            methodology: [1; 32],
            sequence: 1,
            oracle_timestamp: 14_402,
            benchmark: 1_000_000,
            prices: (0..30)
                .map(|asset_id| cox_epoch::Price {
                    asset_id,
                    feed_id: [asset_id as u8 + 1; 32],
                    value: 1_000_000,
                })
                .collect(),
        };
        let mut close = entry.clone();
        close.oracle_timestamp = 28_800;
        close.sequence = 2;
        close.id = [2; 32];
        let engine = epoch.epoch.state.as_mut().unwrap();
        let lot = epoch.lots[0].state.as_mut().unwrap();
        engine
            .execute([7; 32], lot, &entry, 14_402, 1_000_000)
            .unwrap();
        engine
            .begin_close([7; 32], close, 28_800, 1_000_000)
            .unwrap();
        engine.score_entry(lot, 1_000_000).unwrap();
        epoch.lots.clear();
        state.epochs.push(epoch);
        assert!(state.work(28_800_000).unwrap().iter().any(|item| matches!(
            item,
            Work::Maintenance {
                pool: WorkPool::Epoch,
                ..
            }
        )));
        assert_eq!(
            plan_maintenance(&state, key(7), 28_800, 1).unwrap(),
            vec![state.epochs[0].accounts.finalize_scores()]
        );
    }

    #[test]
    fn settled_epoch_retains_unexecuted_refund_work() {
        let mut state = state();
        let mut epoch = epoch(true);
        let engine = epoch.epoch.state.as_mut().unwrap();
        let pending = engine
            .queue(
                [8; 32],
                1,
                1_000_000,
                core::array::from_fn(|i| i as u16),
                0,
                14_401,
                2_000_000,
            )
            .unwrap();
        let entry = cox_epoch::OperatorSnapshot {
            id: [1; 32],
            methodology: [1; 32],
            sequence: 1,
            oracle_timestamp: 14_402,
            benchmark: 1_000_000,
            prices: (0..30)
                .map(|asset_id| cox_epoch::Price {
                    asset_id,
                    feed_id: [asset_id as u8 + 1; 32],
                    value: 1_000_000,
                })
                .collect(),
        };
        let mut close = entry.clone();
        close.oracle_timestamp = 28_800;
        close.sequence = 2;
        close.id = [2; 32];
        let first = epoch.lots[0].state.as_mut().unwrap();
        engine
            .execute([7; 32], first, &entry, 14_402, 2_000_000)
            .unwrap();
        engine
            .begin_close([7; 32], close, 28_800, 2_000_000)
            .unwrap();
        engine.score_entry(first, 2_000_000).unwrap();
        engine.finalize_scores(2_000_000).unwrap();
        engine.allocate(first, 2_000_000).unwrap();
        assert_eq!(engine.phase(), Phase::Settled);
        let mut account: LotAccount = zero();
        account.nonce = 1;
        account.state = Some(pending);
        epoch.lots = vec![account];
        state.epochs.push(epoch);
        assert!(!completed(&state.epochs[0].epoch, 28_800));
        assert!(state.work(28_800_000).unwrap().iter().any(|item| matches!(
            item,
            Work::Maintenance {
                pool: WorkPool::Epoch,
                ..
            }
        )));
        assert_eq!(
            plan_maintenance(&state, key(7), 28_800, 1).unwrap(),
            vec![state.epochs[0]
                .accounts
                .process_lot(1, EpochLotOperation::Refund)]
        );
    }
    #[test]
    fn empty_round_remains_discoverable_until_actual_terminal_transition() {
        let mut state = state();
        state.basic.registry.paused = true;
        state.epochs.push(epoch(false));
        assert!(!completed(&state.epochs[0].epoch, 28_800));
        let work = state.work(28_800_000).unwrap();
        assert_eq!(
            work,
            vec![Work::Maintenance {
                id: "epoch:14400:finalize-empty".into(),
                pool: WorkPool::Epoch
            }]
        );
        assert_eq!(
            plan_maintenance_for(&state, key(7), 28_800, 1, &work).unwrap(),
            vec![state.epochs[0].accounts.finalize_empty()]
        );
        state.epochs[0]
            .epoch
            .state
            .as_mut()
            .unwrap()
            .finalize_empty(28_800, 0)
            .unwrap();
        state.epochs[0].epoch.empty_finalized = true;
        assert!(completed(&state.epochs[0].epoch, 28_800));
        assert!(state.work(28_800_000).unwrap().is_empty());
        let mut unfinished = epoch(false);
        unfinished.epoch.state = None;
        state.epochs = vec![unfinished];
        assert!(!completed(&state.epochs[0].epoch, 28_800));
        assert_eq!(state.work(28_800_000).unwrap(), work);
        assert_eq!(
            plan_maintenance_for(&state, key(7), 28_800, 1, &work).unwrap(),
            vec![state.epochs[0].accounts.finalize_empty()]
        );
    }
}
