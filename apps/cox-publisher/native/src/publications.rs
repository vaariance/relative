use anchor_lang::prelude::borsh;
use anchor_lang::{AccountDeserialize, AnchorDeserialize};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use solana_address::Address;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static SERIAL: AtomicU64 = AtomicU64::new(0);
#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Storage,
    InvalidAccount,
    Identity,
    State,
    Gap,
    Conflict,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub program: String,
    pub pool: String,
    pub genesis_hash: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub schema: String,
    pub identity: Identity,
    pub address: String,
    pub sequence: String,
    pub batch: String,
    pub state_digest: String,
    pub account_sha256: String,
    pub account_base64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_slot: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commitment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finalized_slot: Option<u64>,
}
#[derive(AnchorDeserialize)]
struct ClassState {
    _pre_backing: u64,
    _pre_units: u128,
    _post_backing: u64,
    _post_units: u128,
}
#[derive(AnchorDeserialize)]
struct State {
    domain: String,
    program: [u8; 32],
    pool: [u8; 32],
    sequence: u64,
    batch: u64,
    _cutoff: u64,
    previous: [u8; 32],
    manifest: [u8; 32],
    snapshot: [u8; 32],
    _benchmark: i128,
    prices: Vec<u64>,
    references: Vec<i128>,
    classes: Vec<ClassState>,
    _executed: u32,
    _rejected: u32,
    _active: u64,
    _pending: u64,
    _payable: u64,
    _residual: u64,
    _receipt_root: [u8; 32],
}
#[derive(AnchorDeserialize)]
struct Fees {
    _fees: u64,
    _batch_fees: u64,
    _version: u64,
    _bps: u16,
    _cap: u64,
    _next_version: u64,
    _pending: bool,
    _pending_version: u64,
    _pending_bps: u16,
    _pending_cap: u64,
    _pending_cutoff: u64,
    _initial_scheduled: bool,
    policy: [u8; 32],
}
pub struct Archive {
    directory: PathBuf,
    identity: Identity,
    program: Address,
    pool: Address,
    address: Address,
}
fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
impl Archive {
    pub fn new(directory: impl Into<PathBuf>, program: Address, pool: Address) -> Self {
        Self {
            directory: directory.into(),
            identity: Identity {
                program: program.to_string(),
                pool: pool.to_string(),
                genesis_hash: crate::rpc::DEVNET_GENESIS.into(),
            },
            program,
            pool,
            address: Address::find_program_address(&[b"publication", pool.as_ref()], &program).0,
        }
    }
    pub fn address(&self) -> Address {
        self.address
    }
    fn path(&self, sequence: u64) -> PathBuf {
        self.directory.join(format!("{sequence}.json"))
    }
    fn checked(
        &self,
        owner: Address,
        address: Address,
        bytes: &[u8],
    ) -> Result<(cox::Publication, [u8; 32]), Error> {
        if owner != self.program
            || address != self.address
            || !(8192..=cox::dynamic_batch_space(256)).contains(&bytes.len())
            || bytes.len() % 8192 != 0
        {
            return Err(Error::Identity);
        }
        let publication = cox::Publication::try_deserialize(&mut bytes.as_ref())
            .map_err(|_| Error::InvalidAccount)?;
        let (_, bump) =
            Address::find_program_address(&[b"publication", self.pool.as_ref()], &self.program);
        if !matches!(publication.schema_version, 2 | 3 | 4)
            || publication.bump != bump
            || publication.pool.to_bytes() != self.pool.to_bytes()
            || Sha256::digest(&publication.state_preimage).as_slice() != publication.state_digest
        {
            return Err(Error::State);
        }
        let mut rest = publication.state_preimage.as_slice();
        let state = State::deserialize(&mut rest).map_err(|_| Error::State)?;
        let fees = match state.domain.as_str() {
            "COX/STATE/V1" if publication.schema_version == 2 => false,
            "COX/STATE/V2" | "COX/STATE/ADAPTIVE/V1" if publication.schema_version == 3 => true,
            "COX/STATE/DYNAMIC/V1" if publication.schema_version == 4 => true,
            _ => return Err(Error::State),
        };
        if fees {
            let fees = Fees::deserialize(&mut rest).map_err(|_| Error::State)?;
            let domain = b"COX/FEES/V1";
            let mut policy = (domain.len() as u32).to_le_bytes().to_vec();
            policy.extend_from_slice(domain);
            policy.extend_from_slice(&state.manifest);
            policy.extend_from_slice(&100u16.to_le_bytes());
            policy.extend_from_slice(&2_000_000u64.to_le_bytes());
            policy.extend_from_slice(&86_400u64.to_le_bytes());
            if Sha256::digest(&policy).as_slice() != fees.policy {
                return Err(Error::State);
            }
        }
        if matches!(
            state.domain.as_str(),
            "COX/STATE/ADAPTIVE/V1" | "COX/STATE/DYNAMIC/V1"
        ) {
            let _ = <u64 as AnchorDeserialize>::deserialize(&mut rest).map_err(|_| Error::State)?;
            let mint = <Option<[u8; 32]> as AnchorDeserialize>::deserialize(&mut rest)
                .map_err(|_| Error::State)?;
            if mint == Some([0; 32]) {
                return Err(Error::State);
            }
        }
        let dynamic = publication.schema_version == 4;
        let valid_prices = if dynamic { 30..=255 } else { 2..=30 };
        let expected_bytes = if dynamic {
            cox::dynamic_batch_space(state.classes.len())
        } else {
            8192
        };
        if !rest.is_empty()
            || state.program != self.program.to_bytes()
            || state.pool != self.pool.to_bytes()
            || state.sequence != publication.sequence
            || state.batch != publication.batch
            || state.manifest != publication.manifest_digest
            || state.snapshot != publication.snapshot_digest
            || !valid_prices.contains(&state.prices.len())
            || bytes.len() != expected_bytes
            || state.references.len() != state.prices.len() + 1
            || state.classes.len() != state.prices.len() + 1
            || state.prices.len() != publication.prices.len()
            || state
                .prices
                .iter()
                .zip(&publication.prices)
                .any(|(price, wire)| *price != wire.price_e8)
            || publication.sequence == 0 && state.previous != [0; 32]
        {
            return Err(Error::State);
        }
        Ok((publication, state.previous))
    }
    pub fn read(&self, sequence: u64) -> Result<Option<Record>, Error> {
        let bytes = match fs::read(self.path(sequence)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(Error::Storage),
        };
        self.validate_record(sequence, &bytes).map(Some)
    }
    pub fn validate_record(&self, sequence: u64, bytes: &[u8]) -> Result<Record, Error> {
        let record: Record = serde_json::from_slice(bytes).map_err(|_| Error::State)?;
        let provenance = match record.schema.as_str() {
            "cox.publication-archive/v1" => {
                record.finalized_slot.is_some()
                    && record.observed_slot.is_none()
                    && record.commitment.is_none()
            }
            "cox.publication-archive/v2" => {
                record.observed_slot.is_some()
                    && record.commitment.as_deref() == Some("confirmed")
                    && record.finalized_slot.is_none()
            }
            _ => false,
        };
        if !provenance
            || record.identity != self.identity
            || record.address != self.address.to_string()
            || record.sequence != sequence.to_string()
        {
            return Err(Error::Identity);
        }
        let data = STANDARD
            .decode(&record.account_base64)
            .map_err(|_| Error::State)?;
        if STANDARD.encode(&data) != record.account_base64 || hash(&data) != record.account_sha256 {
            return Err(Error::State);
        }
        let (value, _) = self.checked(self.program, self.address, &data)?;
        if value.sequence != sequence
            || value.batch.to_string() != record.batch
            || hex::encode(value.state_digest) != record.state_digest
        {
            return Err(Error::State);
        }
        Ok(record)
    }
    pub fn preserve(
        &self,
        owner: Address,
        address: Address,
        bytes: &[u8],
        observed_slot: u64,
        expected_sequence: u64,
        expected_digest: [u8; 32],
    ) -> Result<(), Error> {
        let (publication, previous) = self.checked(owner, address, bytes)?;
        if publication.sequence != expected_sequence || publication.state_digest != expected_digest
        {
            return Err(Error::State);
        }
        if publication.sequence > 0 {
            let prior = self.read(publication.sequence - 1)?.ok_or(Error::Gap)?;
            if prior.state_digest != hex::encode(previous) {
                return Err(Error::Conflict);
            }
        }
        if let Some(prior) = self.read(publication.sequence)? {
            return if prior.account_base64 == STANDARD.encode(bytes) {
                Ok(())
            } else {
                Err(Error::Conflict)
            };
        }
        let record = Record {
            schema: "cox.publication-archive/v2".into(),
            identity: self.identity.clone(),
            address: address.to_string(),
            sequence: publication.sequence.to_string(),
            batch: publication.batch.to_string(),
            state_digest: hex::encode(publication.state_digest),
            account_sha256: hash(bytes),
            account_base64: STANDARD.encode(bytes),
            observed_slot: Some(observed_slot),
            commitment: Some("confirmed".into()),
            finalized_slot: None,
        };
        fs::create_dir_all(&self.directory).map_err(|_| Error::Storage)?;
        let temporary = self.directory.join(format!(
            ".publication.{}.{}.tmp",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary).map_err(|_| Error::Storage)?;
            file.write_all(&serde_json::to_vec(&record).map_err(|_| Error::Storage)?)
                .and_then(|_| file.sync_all())
                .map_err(|_| Error::Storage)?;
            match fs::hard_link(&temporary, self.path(publication.sequence)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if self
                        .read(publication.sequence)?
                        .ok_or(Error::Conflict)?
                        .account_base64
                        != record.account_base64
                    {
                        return Err(Error::Conflict);
                    }
                }
                Err(_) => return Err(Error::Storage),
            }
            sync_directory(&self.directory)?;
            if let Some(parent) = self.directory.parent() {
                sync_directory(parent)?;
            }
            Ok(())
        })();
        let cleanup = fs::remove_file(&temporary).map_err(|_| Error::Storage);
        result.and(cleanup)
    }
}
fn sync_directory(path: &Path) -> Result<(), Error> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| Error::Storage)
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::{prelude::Pubkey, AccountSerialize};
    fn directory() -> PathBuf {
        std::env::temp_dir().join(format!(
            "relative-publication-test-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ))
    }
    fn fixture(archive: &Archive, sequence: u64, previous: [u8; 32]) -> (Vec<u8>, [u8; 32]) {
        let mut state = (12u32).to_le_bytes().to_vec();
        state.extend_from_slice(b"COX/STATE/V1");
        state.extend_from_slice(archive.program.as_ref());
        state.extend_from_slice(archive.pool.as_ref());
        state.extend_from_slice(&sequence.to_le_bytes());
        state.extend_from_slice(&(sequence + 20).to_le_bytes());
        state.extend_from_slice(&(sequence + 100).to_le_bytes());
        state.extend_from_slice(&previous);
        state.extend_from_slice(&[4; 32]);
        state.extend_from_slice(&[5; 32]);
        state.extend_from_slice(&100i128.to_le_bytes());
        state.extend_from_slice(&2u32.to_le_bytes());
        state.extend_from_slice(&10u64.to_le_bytes());
        state.extend_from_slice(&20u64.to_le_bytes());
        state.extend_from_slice(&3u32.to_le_bytes());
        for _ in 0..3 {
            state.extend_from_slice(&100i128.to_le_bytes());
        }
        state.extend_from_slice(&3u32.to_le_bytes());
        state.extend_from_slice(&[0; 144]);
        state.extend_from_slice(&[0; 72]);
        let digest: [u8; 32] = Sha256::digest(&state).into();
        let publication = cox::Publication {
            schema_version: 2,
            bump: Address::find_program_address(
                &[b"publication", archive.pool.as_ref()],
                &archive.program,
            )
            .1,
            pool: Pubkey::new_from_array(archive.pool.to_bytes()),
            sequence,
            batch: sequence + 20,
            state_digest: digest,
            snapshot_digest: [5; 32],
            manifest_digest: [4; 32],
            state_preimage: state,
            prices: vec![
                cox::PriceWire {
                    price_e8: 10,
                    venue: 0,
                    step: 0,
                    candle_start: 100,
                    trade_age_minutes: 0,
                },
                cox::PriceWire {
                    price_e8: 20,
                    venue: 0,
                    step: 0,
                    candle_start: 100,
                    trade_age_minutes: 0,
                },
            ],
            committed_at: 100,
        };
        let mut bytes = Vec::new();
        publication.try_serialize(&mut bytes).unwrap();
        bytes.resize(8192, 0);
        (bytes, digest)
    }
    fn archive(path: &Path) -> Archive {
        Archive::new(
            path,
            Address::new_from_array([1; 32]),
            Address::new_from_array([2; 32]),
        )
    }
    fn dynamic_fixture(archive: &Archive, assets: usize) -> Vec<u8> {
        use anchor_lang::Discriminator;
        let mut raw = vec![0; 8192];
        raw[..8].copy_from_slice(cox::Pool::DISCRIMINATOR);
        let mut pool = cox::Pool::try_deserialize(&mut raw.as_slice()).unwrap();
        raw[..8].copy_from_slice(cox::Batch::DISCRIMINATOR);
        let mut batch = cox::Batch::try_deserialize(&mut raw.as_slice()).unwrap();
        pool.schema_version = 5;
        pool.trading_opens_at = 14_400;
        pool.test_collateral_mint = Some(Pubkey::new_from_array([7; 32]));
        pool.last_prices = (1..=assets).map(|price| price as u64).collect();
        pool.references = vec![100; assets + 1];
        pool.classes = vec![cox::Class::default(); assets + 1];
        batch.cutoff = 100;
        batch.snapshot_digest = [5; 32];
        let preimage = cox::state_bytes(
            &Pubkey::new_from_array(archive.program.to_bytes()),
            &Pubkey::new_from_array(archive.pool.to_bytes()),
            &pool,
            &pool.classes,
            &batch,
            &[4; 32],
        )
        .unwrap();
        let publication = cox::Publication {
            schema_version: 4,
            bump: Address::find_program_address(
                &[b"publication", archive.pool.as_ref()],
                &archive.program,
            )
            .1,
            pool: Pubkey::new_from_array(archive.pool.to_bytes()),
            sequence: 0,
            batch: 0,
            state_digest: Sha256::digest(&preimage).into(),
            snapshot_digest: [5; 32],
            manifest_digest: [4; 32],
            state_preimage: preimage,
            prices: pool
                .last_prices
                .iter()
                .map(|price| cox::PriceWire {
                    price_e8: *price,
                    venue: 3,
                    step: 0,
                    candle_start: 100,
                    trade_age_minutes: 0,
                })
                .collect(),
            committed_at: 120,
        };
        encode_publication(&publication, cox::dynamic_batch_space(assets + 1))
    }
    fn encode_publication(publication: &cox::Publication, allocated: usize) -> Vec<u8> {
        let mut bytes = Vec::new();
        publication.try_serialize(&mut bytes).unwrap();
        assert!(bytes.len() <= allocated);
        bytes.resize(allocated, 0);
        bytes
    }
    #[test]
    fn dynamic_protocol_publications_archive_migration_inclusion_and_maximum_capacity() {
        for assets in [30, 31, 32, 255] {
            let path = directory();
            let archive = archive(&path);
            let bytes = dynamic_fixture(&archive, assets);
            let (publication, previous) = archive
                .checked(archive.program, archive.address, &bytes)
                .unwrap();
            assert_eq!(publication.schema_version, 4);
            assert_eq!(publication.prices.len(), assets);
            assert_eq!(previous, [0; 32]);
            assert_eq!(bytes.len(), cox::dynamic_batch_space(assets + 1));
            archive
                .preserve(
                    archive.program,
                    archive.address,
                    &bytes,
                    42,
                    0,
                    publication.state_digest,
                )
                .unwrap();
            assert_eq!(
                STANDARD
                    .decode(archive.read(0).unwrap().unwrap().account_base64)
                    .unwrap(),
                bytes
            );
            fs::remove_dir_all(path).unwrap();
        }
    }
    #[test]
    fn dynamic_archives_reject_wrong_domain_capacity_fees_tail_prices_and_identity() {
        let path = directory();
        let archive = archive(&path);
        let bytes = dynamic_fixture(&archive, 31);
        let original = cox::Publication::try_deserialize(&mut bytes.as_slice()).unwrap();
        let check = |publication: &cox::Publication, size| {
            archive
                .checked(
                    archive.program,
                    archive.address,
                    &encode_publication(publication, size),
                )
                .map(|_| ())
        };
        let mut wrong = original.clone();
        wrong.schema_version = 3;
        assert_eq!(check(&wrong, bytes.len()), Err(Error::State));
        let mut wrong = original.clone();
        wrong.prices.pop();
        assert_eq!(check(&wrong, bytes.len()), Err(Error::State));
        let mut wrong = original.clone();
        wrong.state_preimage.pop();
        wrong.state_digest = Sha256::digest(&wrong.state_preimage).into();
        assert_eq!(check(&wrong, bytes.len()), Err(Error::State));
        let mut wrong = original.clone();
        wrong.state_preimage.push(0);
        wrong.state_digest = Sha256::digest(&wrong.state_preimage).into();
        assert_eq!(check(&wrong, bytes.len()), Err(Error::State));
        let mut wrong = original.clone();
        let policy_end = wrong.state_preimage.len() - 41;
        wrong.state_preimage[policy_end - 1] ^= 1;
        wrong.state_digest = Sha256::digest(&wrong.state_preimage).into();
        assert_eq!(check(&wrong, bytes.len()), Err(Error::State));
        let mut wrong = original.clone();
        let end = wrong.state_preimage.len();
        wrong.state_preimage[end - 32..].fill(0);
        wrong.state_digest = Sha256::digest(&wrong.state_preimage).into();
        assert_eq!(check(&wrong, bytes.len()), Err(Error::State));
        assert_eq!(check(&original, bytes.len() + 8192), Err(Error::State));
        let oversized = dynamic_fixture(&archive, 256);
        assert_eq!(
            archive
                .checked(archive.program, archive.address, &oversized)
                .map(|_| ()),
            Err(Error::State)
        );
        assert_eq!(
            archive
                .checked(archive.pool, archive.address, &bytes)
                .map(|_| ()),
            Err(Error::Identity)
        );
        assert_eq!(
            archive
                .checked(archive.program, archive.pool, &bytes)
                .map(|_| ()),
            Err(Error::Identity)
        );
    }
    #[test]
    fn captured_live_dynamic_publication_is_verified_when_explicitly_supplied() {
        let Ok(path) = std::env::var("COX_LIVE_PUBLICATION_FIXTURE") else {
            return;
        };
        let value: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        let program: Address = value["program"].as_str().unwrap().parse().unwrap();
        let pool: Address = value["pool"].as_str().unwrap().parse().unwrap();
        let archive = Archive::new(directory(), program, pool);
        let owner = value["owner"].as_str().unwrap().parse().unwrap();
        let address = value["address"].as_str().unwrap().parse().unwrap();
        let bytes = STANDARD
            .decode(value["accountBase64"].as_str().unwrap())
            .unwrap();
        let (publication, _) = archive.checked(owner, address, &bytes).unwrap();
        assert_eq!(publication.schema_version, 4);
        assert_eq!(publication.sequence, value["sequence"].as_u64().unwrap());
        assert!(value["slot"].as_u64().unwrap() > 0);
    }
    #[test]
    fn immutable_chain_survives_restart_and_records_confirmed_provenance() {
        let path = directory();
        let archive = archive(&path);
        let (first, digest) = fixture(&archive, 0, [0; 32]);
        archive
            .preserve(archive.program, archive.address, &first, 100, 0, digest)
            .unwrap();
        archive
            .preserve(archive.program, archive.address, &first, 101, 0, digest)
            .unwrap();
        let (second, next) = fixture(&archive, 1, digest);
        archive
            .preserve(archive.program, archive.address, &second, 102, 1, next)
            .unwrap();
        let restarted = super::Archive::new(&path, archive.program, archive.pool);
        let record = restarted.read(1).unwrap().unwrap();
        assert_eq!(record.commitment.as_deref(), Some("confirmed"));
        assert_eq!(record.observed_slot, Some(102));
        assert_eq!(record.finalized_slot, None);
        assert_eq!(STANDARD.decode(record.account_base64).unwrap(), second);
        fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn rejects_gaps_conflicting_bytes_and_predecessors() {
        let path = directory();
        let archive = archive(&path);
        let (second, digest) = fixture(&archive, 1, [8; 32]);
        assert_eq!(
            archive.preserve(archive.program, archive.address, &second, 1, 1, digest),
            Err(Error::Gap)
        );
        let (mut first, origin) = fixture(&archive, 0, [0; 32]);
        archive
            .preserve(archive.program, archive.address, &first, 1, 0, origin)
            .unwrap();
        assert_eq!(
            archive.preserve(archive.program, archive.address, &second, 2, 1, digest),
            Err(Error::Conflict)
        );
        first[8191] = 1;
        assert_eq!(
            archive.preserve(archive.program, archive.address, &first, 2, 0, origin),
            Err(Error::Conflict)
        );
        fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn corruption_wrong_owner_and_wrong_checkpoint_fail_closed() {
        let path = directory();
        let archive = archive(&path);
        let (bytes, digest) = fixture(&archive, 0, [0; 32]);
        assert_eq!(
            archive.preserve(archive.pool, archive.address, &bytes, 1, 0, digest),
            Err(Error::Identity)
        );
        assert_eq!(
            archive.preserve(archive.program, archive.address, &bytes, 1, 1, digest),
            Err(Error::State)
        );
        assert_eq!(
            archive.preserve(archive.program, archive.address, &bytes, 1, 0, [9; 32]),
            Err(Error::State)
        );
        archive
            .preserve(archive.program, archive.address, &bytes, 1, 0, digest)
            .unwrap();
        let mut record = archive.read(0).unwrap().unwrap();
        record.account_sha256 = "0".repeat(64);
        fs::write(archive.path(0), serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(matches!(archive.read(0), Err(Error::State)));
        fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn legacy_finalized_records_are_read_without_changing_provenance() {
        let path = directory();
        let archive = archive(&path);
        let (bytes, digest) = fixture(&archive, 0, [0; 32]);
        archive
            .preserve(archive.program, archive.address, &bytes, 10, 0, digest)
            .unwrap();
        let mut record = archive.read(0).unwrap().unwrap();
        record.schema = "cox.publication-archive/v1".into();
        record.observed_slot = None;
        record.commitment = None;
        record.finalized_slot = Some(10);
        fs::write(archive.path(0), serde_json::to_vec(&record).unwrap()).unwrap();
        archive
            .preserve(archive.program, archive.address, &bytes, 20, 0, digest)
            .unwrap();
        assert_eq!(archive.read(0).unwrap().unwrap().finalized_slot, Some(10));
        fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn storage_failure_cannot_create_an_archive_record() {
        let path = directory();
        fs::write(&path, b"blocked").unwrap();
        let archive = archive(&path);
        let (bytes, digest) = fixture(&archive, 0, [0; 32]);
        assert_eq!(
            archive.preserve(archive.program, archive.address, &bytes, 1, 0, digest),
            Err(Error::Storage)
        );
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn adaptive_commitment_from_protocol_encoder_preserves_scheduled_admission() {
        use anchor_lang::Discriminator;
        let path = directory();
        let archive = archive(&path);
        let mut raw = vec![0; 8192];
        raw[..8].copy_from_slice(cox::Pool::DISCRIMINATOR);
        let mut pool = cox::Pool::try_deserialize(&mut raw.as_slice()).unwrap();
        raw[..8].copy_from_slice(cox::Batch::DISCRIMINATOR);
        let mut batch = cox::Batch::try_deserialize(&mut raw.as_slice()).unwrap();
        pool.schema_version = 4;
        pool.trading_opens_at = 14_400;
        pool.last_prices = vec![10, 20];
        pool.references = vec![100; 3];
        pool.classes = vec![cox::Class::default(); 3];
        batch.cutoff = 100;
        batch.snapshot_digest = [5; 32];
        let program = Pubkey::new_from_array(archive.program.to_bytes());
        let key = Pubkey::new_from_array(archive.pool.to_bytes());
        let preimage =
            cox::state_bytes(&program, &key, &pool, &pool.classes, &batch, &[4; 32]).unwrap();
        let digest: [u8; 32] = Sha256::digest(&preimage).into();
        let publication = cox::Publication {
            schema_version: 3,
            bump: Address::find_program_address(
                &[b"publication", archive.pool.as_ref()],
                &archive.program,
            )
            .1,
            pool: key,
            sequence: 0,
            batch: 0,
            state_digest: digest,
            snapshot_digest: [5; 32],
            manifest_digest: [4; 32],
            state_preimage: preimage,
            prices: vec![
                cox::PriceWire {
                    price_e8: 10,
                    venue: 3,
                    step: 0,
                    candle_start: 100,
                    trade_age_minutes: 0,
                },
                cox::PriceWire {
                    price_e8: 20,
                    venue: 3,
                    step: 0,
                    candle_start: 100,
                    trade_age_minutes: 0,
                },
            ],
            committed_at: 120,
        };
        let mut bytes = Vec::new();
        publication.try_serialize(&mut bytes).unwrap();
        bytes.resize(8192, 0);
        archive
            .preserve(archive.program, archive.address, &bytes, 1, 0, digest)
            .unwrap();
        assert_eq!(
            archive.read(0).unwrap().unwrap().state_digest,
            hex::encode(digest)
        );
        fs::remove_dir_all(path).unwrap();
    }
}
