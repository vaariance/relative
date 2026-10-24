use crate::{AdaptiveManifestConfig, CoxError, IDS};
use anchor_lang::prelude::*;

pub fn dynamic_digest(bytes: &[u8]) -> [u8; 32] { anchor_lang::solana_program::hash::hash(bytes).to_bytes() }

pub const DYNAMIC_UNIVERSE_DOMAIN: &str = "COX/UNIVERSE/OPERATOR-ATTESTED/V1";
pub const DYNAMIC_CAPTURE_DOMAIN: &str = "COX/UNIVERSE/CAPTURE/OPERATOR-ATTESTED/V1";
pub const DYNAMIC_CRYPTO_CLASS: u16 = 30;
pub const DYNAMIC_MAX_ASSETS: usize = 255;
pub const DYNAMIC_MAX_GROWTH: usize = 8_192;
pub const DYNAMIC_MAX_ACCOUNT_BYTES: usize = 131_072;
pub const DYNAMIC_MAX_PAGE: usize = 8;
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DynamicPhase { Prices = 4, References = 5, Backings = 6, Cancelled = 7 }


#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Instrument {
    pub stable_id: String,
    pub symbol: String,
    pub class_id: u16,
    pub epoch_id: u16,
    pub pyth_pro_feed_id: u32,
    pub pyth_core_feed_id: [u8; 32],
    pub token_mint: Option<Pubkey>,
    pub original_price_e8: u64,
    pub original_benchmark: i128,
    pub original_timestamp: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct UniverseCapture {
    pub price_universe_digest: [u8; 32],
    pub timestamp: u64,
    pub benchmark: i128,
    pub prices_e8: Vec<u64>,
    pub signed_payload_digest: [u8; 32],
    pub trusted_storage_digest: [u8; 32],
    pub predecessor_sequence: u64,
    pub predecessor_state_digest: [u8; 32],
}

#[account]
#[derive(Debug)]
pub struct UniverseVersion {
    pub schema_version: u16,
    pub bump: u8,
    pub pool: Pubkey,
    pub operator: Pubkey,
    pub source_methodology: [u8; 32],
    pub version: u64,
    pub predecessor_digest: [u8; 32],
    pub expected_instruments: u16,
    pub capture: UniverseCapture,
    pub instruments: Vec<Instrument>,
    pub sealed: bool,
    pub digest: [u8; 32],
}

fn nonzero(value: &[u8; 32]) -> bool {
    *value != [0; 32]
}

pub fn class_for_asset_index(index: usize) -> Result<u16> {
    require!(index < DYNAMIC_MAX_ASSETS, CoxError::CapacityExceeded);
    u16::try_from(if index < 30 { index } else { index + 1 })
        .map_err(|_| error!(CoxError::ArithmeticOverflow))
}

pub fn validate_instruments(instruments: &[Instrument]) -> Result<()> { validate_instruments_for_schema(1, instruments) }

pub fn validate_instruments_for_schema(schema_version: u16, instruments: &[Instrument]) -> Result<()> {
    require!(matches!(schema_version,1|2), CoxError::InvalidManifest);
    require!(
        (30..=DYNAMIC_MAX_ASSETS).contains(&instruments.len()),
        CoxError::InvalidRoster
    );
    let mut ids = std::collections::BTreeSet::new();
    let mut symbols = std::collections::BTreeSet::new();
    let mut epoch_ids = std::collections::BTreeSet::new();
    let mut pro_feeds = std::collections::BTreeSet::new();
    let mut core_feeds = std::collections::BTreeSet::new();
    let mut mints = std::collections::BTreeSet::new();
    for (index, instrument) in instruments.iter().enumerate() {
        require!(
            !instrument.stable_id.is_empty()
                && instrument.stable_id.len() <= 64
                && instrument
                    .stable_id
                    .bytes()
                    .all(|value| value.is_ascii_lowercase()
                        || value.is_ascii_digit()
                        || b"._:-".contains(&value))
                && !instrument.symbol.is_empty()
                && instrument.symbol.len() <= 16
                && instrument
                    .symbol
                    .bytes()
                    .all(|value| value.is_ascii_uppercase()
                        || value.is_ascii_digit()
                        || b"._-".contains(&value)),
            CoxError::InvalidRoster
        );
        require!(
            instrument.class_id == if schema_version == 2 { (index+1) as u16 } else { class_for_asset_index(index)? }
                && instrument.class_id != if schema_version == 2 { 0 } else { DYNAMIC_CRYPTO_CLASS }
                && instrument.epoch_id < 256
                && instrument.pyth_pro_feed_id > 0
                && nonzero(&instrument.pyth_core_feed_id)
                && instrument.token_mint != Some(Pubkey::default())
                && instrument.original_price_e8 > 0
                && instrument.original_benchmark > 0
                && instrument.original_timestamp > 0,
            CoxError::InvalidManifest
        );
        require!(
            ids.insert(instrument.stable_id.as_str())
                && symbols.insert(instrument.symbol.as_str())
                && epoch_ids.insert(instrument.epoch_id)
                && pro_feeds.insert(instrument.pyth_pro_feed_id)
                && core_feeds.insert(instrument.pyth_core_feed_id)
                && instrument.token_mint.is_none_or(|mint| mints.insert(mint)),
            CoxError::InvalidRoster
        );
    }
    Ok(())
}

fn validate_capture(capture: &UniverseCapture, count: usize) -> Result<()> {
    require!(
        (30..=DYNAMIC_MAX_ASSETS).contains(&count)
            && capture.timestamp > 0
            && capture.benchmark > 0
            && capture.prices_e8.len() == count
            && capture.prices_e8.iter().all(|price| *price > 0)
            && nonzero(&capture.price_universe_digest)
            && nonzero(&capture.signed_payload_digest)
            && nonzero(&capture.trusted_storage_digest)
            && (capture.predecessor_sequence == 0 || nonzero(&capture.predecessor_state_digest)),
        CoxError::InvalidPrice
    );
    Ok(())
}

pub fn capture_digest(capture: &UniverseCapture) -> Result<[u8; 32]> {
    validate_capture(capture, capture.prices_e8.len())?;
    let bytes = (DYNAMIC_CAPTURE_DOMAIN.to_string(), capture).try_to_vec()?;
    Ok(dynamic_digest(&bytes))
}

impl UniverseVersion {
    pub fn crypto_class(&self) -> u16 { if self.schema_version == 2 { 0 } else { DYNAMIC_CRYPTO_CLASS } }
    pub fn class_for_asset_index(&self, index: usize) -> Result<u16> {
        require!(index < DYNAMIC_MAX_ASSETS && matches!(self.schema_version,1|2), CoxError::CapacityExceeded);
        if self.schema_version == 2 { Ok((index+1) as u16) } else { class_for_asset_index(index) }
    }
    pub fn draft(
        bump: u8,
        pool: Pubkey,
        operator: Pubkey,
        source_methodology: [u8; 32],
        version: u64,
        predecessor_digest: [u8; 32],
        expected_instruments: u16,
        capture: UniverseCapture,
    ) -> Result<Self> {
        require!(
            pool != Pubkey::default()
                && operator != Pubkey::default()
                && nonzero(&source_methodology)
                && version > 0
                && (30..=255).contains(&expected_instruments)
                && (version == 1) == !nonzero(&predecessor_digest),
            CoxError::InvalidManifest
        );
        validate_capture(&capture, usize::from(expected_instruments))?;
        Ok(Self {
            schema_version: 1,
            bump,
            pool,
            operator,
            source_methodology,
            version,
            predecessor_digest,
            expected_instruments,
            capture,
            instruments: Vec::new(),
            sealed: false,
            digest: [0; 32],
        })
    }

    pub fn append_page(&mut self, page: Vec<Instrument>, allocated_bytes: usize) -> Result<()> {
        require!(!self.sealed, CoxError::AlreadyProcessed);
        require!(
            !page.is_empty()
                && page.len() <= DYNAMIC_MAX_PAGE
                && self.instruments.len() + page.len() <= usize::from(self.expected_instruments),
            CoxError::CapacityExceeded
        );
        let previous_len = self.instruments.len();
        self.instruments.extend(page);
        let required = self.serialized_size();
        if !matches!(required, Ok(bytes) if bytes <= allocated_bytes) {
            self.instruments.truncate(previous_len);
            return err!(CoxError::CapacityExceeded);
        }
        Ok(())
    }

    pub fn serialized_size(&self) -> Result<usize> {
        let instrument_bytes = self.instruments.iter().try_fold(0usize, |sum, value| {
            sum.checked_add(
                4 + value.stable_id.len()
                    + 4
                    + value.symbol.len()
                    + 2
                    + 2
                    + 4
                    + 32
                    + 1
                    + if value.token_mint.is_some() { 32 } else { 0 }
                    + 8
                    + 16
                    + 8,
            )
            .ok_or(CoxError::ArithmeticOverflow)
        })?;
        let size = 8
            + 2
            + 1
            + 32
            + 32
            + 32
            + 8
            + 32
            + 2
            + 32
            + 8
            + 16
            + 4
            + self.capture.prices_e8.len() * 8
            + 32
            + 32
            + 8
            + 32
            + 4
            + instrument_bytes
            + 1
            + 32;
        require!(
            size <= DYNAMIC_MAX_ACCOUNT_BYTES,
            CoxError::CapacityExceeded
        );
        Ok(size)
    }

    fn validate_complete(&self) -> Result<()> {
        require!(
            matches!(self.schema_version,1|2)
                && self.pool != Pubkey::default()
                && self.operator != Pubkey::default()
                && nonzero(&self.source_methodology)
                && self.version > 0
                && (self.version == 1) == !nonzero(&self.predecessor_digest)
                && self.instruments.len() == usize::from(self.expected_instruments),
            CoxError::InvalidManifest
        );
        validate_capture(&self.capture, self.instruments.len())?;
        validate_instruments_for_schema(self.schema_version,&self.instruments)?;
        self.serialized_size()?;
        Ok(())
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>> {
        self.validate_complete()?;
        self.canonical_bytes_validated()
    }

    fn canonical_bytes_validated(&self) -> Result<Vec<u8>> {
        let mut bytes = Vec::with_capacity(self.serialized_size()? + 128);
        (
            DYNAMIC_UNIVERSE_DOMAIN.to_string(),
            self.schema_version,
            self.pool,
            self.operator,
            self.source_methodology,
            self.version,
            self.predecessor_digest,
            self.expected_instruments,
            &self.capture,
            &self.instruments,
        ).serialize(&mut bytes)?;
        Ok(bytes)
    }

    pub fn from_canonical(bytes: &[u8]) -> Result<Self> {
        Self::decode_canonical(bytes, true)
    }

    fn from_sealed_canonical(bytes: &[u8]) -> Result<Self> {
        Self::decode_canonical(bytes, false)
    }

    fn decode_canonical(bytes: &[u8], admission: bool) -> Result<Self> {
        type Wire = (
            String,
            u16,
            Pubkey,
            Pubkey,
            [u8; 32],
            u64,
            [u8; 32],
            u16,
            UniverseCapture,
            Vec<Instrument>,
        );
        let (
            domain,
            schema_version,
            pool,
            operator,
            source_methodology,
            version,
            predecessor_digest,
            expected_instruments,
            capture,
            instruments,
        ) = Wire::try_from_slice(bytes).map_err(|_| error!(CoxError::InvalidManifest))?;
        require!(domain == DYNAMIC_UNIVERSE_DOMAIN, CoxError::InvalidManifest);
        let value = Self {
            schema_version,
            bump: 0,
            pool,
            operator,
            source_methodology,
            version,
            predecessor_digest,
            expected_instruments,
            capture,
            instruments,
            sealed: true,
            digest: dynamic_digest(bytes),
        };
        if admission { value.validate_complete()?; } else {
            require!(matches!(value.schema_version,1|2) && value.expected_instruments as usize == value.instruments.len()
                && (30..=DYNAMIC_MAX_ASSETS).contains(&value.instruments.len()), CoxError::InvalidManifest);
        }
        Ok(value)
    }

    pub fn canonical_digest(&self) -> Result<[u8; 32]> {
        let bytes = self.canonical_bytes()?;
        Ok(dynamic_digest(&bytes))
    }

    pub fn verify_sealed(&self) -> Result<()> {
        require!(
            self.sealed && self.digest == self.canonical_digest()?,
            CoxError::InvalidManifest
        );
        Ok(())
    }

    pub fn seal_genesis(&mut self) -> Result<()> {
        require!(!self.sealed && self.schema_version == 2 && self.version == 1 && self.predecessor_digest == [0;32]
            && self.capture.predecessor_sequence == 0 && self.capture.predecessor_state_digest == [0;32] && self.capture.benchmark == 100 * cox_math::SCALE, CoxError::InvalidManifest);
        self.validate_complete()?;
        require!(self.instruments.iter().zip(&self.capture.prices_e8).all(|(instrument,price)|
            instrument.original_price_e8 == *price && instrument.original_benchmark == self.capture.benchmark
            && instrument.original_timestamp == self.capture.timestamp), CoxError::InvalidOrigin);
        self.digest = dynamic_digest(&self.canonical_bytes_validated()?); self.sealed = true;
        Ok(())
    }

    pub fn seal_initial(&mut self, policy: &AdaptiveManifestConfig) -> Result<()> {
        require!(!self.sealed && self.schema_version == 1 && self.version == 1, CoxError::InvalidManifest);
        require!(
            policy.roster.len() == 30
                && policy.pyth_feed_ids.len() == 30
                && policy.origin_prices.len() == 30
                && self.capture.timestamp == policy.origin
                && self.capture.benchmark == 100 * cox_math::SCALE
                && self.capture.prices_e8 == policy.origin_prices,
            CoxError::IncompatibleMethodology
        );
        self.validate_complete()?;
        for (index, instrument) in self.instruments.iter().enumerate() {
            require!(
                usize::from(policy.roster[index]) == index
                    && instrument.symbol == IDS[index]
                    && instrument.epoch_id == u16::from(policy.roster[index])
                    && instrument.pyth_pro_feed_id == policy.pyth_feed_ids[index]
                    && instrument.original_price_e8 == policy.origin_prices[index]
                    && instrument.original_timestamp == policy.origin
                    && instrument.original_benchmark == 100 * cox_math::SCALE,
                CoxError::IncompatibleMethodology
            );
        }
        self.digest = dynamic_digest(&self.canonical_bytes_validated()?);
        self.sealed = true;
        Ok(())
    }

    pub fn seal_successor(
        &mut self,
        previous: &Self,
        old_universe_benchmark_at_activation: i128,
    ) -> Result<()> {
        previous.verify_sealed()?;
        self.validate_complete()?;
        let digest = dynamic_digest(&self.canonical_bytes_validated()?);
        self.seal_validated_successor(previous, old_universe_benchmark_at_activation, digest)
    }

    pub(crate) fn seal_validated_successor(&mut self, previous: &Self, old_universe_benchmark_at_activation: i128, canonical_digest: [u8; 32]) -> Result<()> {
        require!(!self.sealed && previous.sealed, CoxError::AlreadyProcessed);
        require!(
            self.schema_version == previous.schema_version
                && self.pool == previous.pool
                && self.source_methodology == previous.source_methodology
                && previous.version.checked_add(1) == Some(self.version)
                && self.predecessor_digest == previous.digest
                && self.capture.timestamp > previous.capture.timestamp
                && self.capture.predecessor_sequence >= previous.capture.predecessor_sequence
                && self.capture.benchmark == old_universe_benchmark_at_activation
                && self.instruments.len() > previous.instruments.len()
                && self.instruments.starts_with(&previous.instruments),
            CoxError::WrongPredecessor
        );
        for (index, instrument) in self
            .instruments
            .iter()
            .enumerate()
            .skip(previous.instruments.len())
        {
            require!(
                instrument.original_price_e8 == self.capture.prices_e8[index]
                    && instrument.original_benchmark == self.capture.benchmark
                    && instrument.original_timestamp == self.capture.timestamp,
                CoxError::InvalidOrigin
            );
        }
        require!(canonical_digest != [0; 32], CoxError::InvalidManifest);
        self.digest = canonical_digest;
        self.sealed = true;
        Ok(())
    }
}

pub fn validate_growth(current_bytes: usize, additional_bytes: usize) -> Result<usize> {
    require!(
        additional_bytes > 0 && additional_bytes <= DYNAMIC_MAX_GROWTH,
        CoxError::CapacityExceeded
    );
    let next = current_bytes
        .checked_add(additional_bytes)
        .ok_or(CoxError::ArithmeticOverflow)?;
    require!(
        next <= DYNAMIC_MAX_ACCOUNT_BYTES,
        CoxError::CapacityExceeded
    );
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instrument(index: usize) -> Instrument {
        Instrument {
            stable_id: format!("asset{index}"),
            symbol: if index < 30 {
                IDS[index].into()
            } else {
                format!("ASSET{index}")
            },
            class_id: class_for_asset_index(index).unwrap(),
            epoch_id: index as u16,
            pyth_pro_feed_id: index as u32 + 1,
            pyth_core_feed_id: dynamic_digest(&index.to_le_bytes()),
            token_mint: None,
            original_price_e8: 100,
            original_benchmark: 100 * cox_math::SCALE,
            original_timestamp: 1000,
        }
    }

    fn initial() -> UniverseVersion {
        let policy = AdaptiveManifestConfig {
            version: "fixture".into(),
            roster: (0..30).collect(),
            pyth_feed_ids: (1..=30).collect(),
            origin: 1000,
            origin_prices: vec![100; 30],
            universe_digest: [1; 32],
            feed_check_digest: [2; 32],
            max_price_age_ms: 5000,
            max_feed_age_ms: 60000,
        };
        let capture = UniverseCapture {
            price_universe_digest: [7; 32],
            timestamp: 1000,
            benchmark: 100 * cox_math::SCALE,
            prices_e8: vec![100; 30],
            signed_payload_digest: [3; 32],
            trusted_storage_digest: [4; 32],
            predecessor_sequence: 1,
            predecessor_state_digest: [5; 32],
        };
        let mut value = UniverseVersion::draft(
            1,
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            [6; 32],
            1,
            [0; 32],
            30,
            capture,
        )
        .unwrap();
        value.instruments = (0..30).map(instrument).collect();
        value.seal_initial(&policy).unwrap();
        value
    }

    fn successor(previous: &UniverseVersion) -> UniverseVersion {
        let mut capture = previous.capture.clone();
        capture.timestamp += 1;
        capture.benchmark += 10;
        capture.prices_e8.push(200);
        let mut value = UniverseVersion::draft(
            2,
            previous.pool,
            previous.operator,
            previous.source_methodology,
            2,
            previous.digest,
            31,
            capture,
        )
        .unwrap();
        value.instruments = previous.instruments.clone();
        let mut addition = instrument(30);
        addition.original_timestamp = value.capture.timestamp;
        addition.original_benchmark = value.capture.benchmark;
        addition.original_price_e8 = 200;
        value.instruments.push(addition);
        value
    }

    #[test]
    fn reserved_crypto_class_survives_full_capacity() {
        let instruments = (0..255).map(instrument).collect::<Vec<_>>();
        validate_instruments(&instruments).unwrap();
        assert_eq!(instruments[29].class_id, 29);
        assert_eq!(instruments[30].class_id, 31);
        assert_eq!(instruments[254].class_id, 255);
        assert!(class_for_asset_index(255).is_err());
    }

    #[test]
    fn rejects_colliding_mapping_and_changed_original_reference() {
        let previous = initial();
        let mut value = successor(&previous);
        value.instruments[30].epoch_id = 0;
        assert!(value
            .seal_successor(&previous, value.capture.benchmark)
            .is_err());
        let mut value = successor(&previous);
        value.instruments[0].original_price_e8 += 1;
        assert!(value
            .seal_successor(&previous, value.capture.benchmark)
            .is_err());
    }

    #[test]
    fn attestation_binds_benchmark_capture_and_predecessor_state() {
        let previous = initial();
        let mut value = successor(&previous);
        assert!(value
            .seal_successor(&previous, previous.capture.benchmark)
            .is_err());
        value
            .seal_successor(&previous, value.capture.benchmark)
            .unwrap();
        value.verify_sealed().unwrap();
        value.capture.predecessor_state_digest[0] ^= 1;
        assert!(value.verify_sealed().is_err());
        let mut capture = previous.capture.clone();
        let digest = capture_digest(&capture).unwrap();
        capture.benchmark += 1;
        assert_ne!(capture_digest(&capture).unwrap(), digest);
    }

    #[test]
    fn draft_pages_are_bounded_and_frozen_after_seal() {
        let mut value = initial();
        assert!(value
            .append_page(vec![instrument(30)], DYNAMIC_MAX_ACCOUNT_BYTES)
            .is_err());
        value.sealed = false;
        value.expected_instruments = 31;
        let length = value.instruments.len();
        assert!(value.append_page(vec![instrument(30)], 1).is_err());
        assert_eq!(value.instruments.len(), length);
        assert!(validate_growth(4096, DYNAMIC_MAX_GROWTH + 1).is_err());
        assert!(validate_growth(DYNAMIC_MAX_ACCOUNT_BYTES, 1).is_err());
    }
}

pub fn read_dynamic_manifest(methodology: &crate::Methodology) -> Result<UniverseVersion> {
    require!(
        methodology.schema_version == 3
            && methodology.sealed
            && !methodology.bybit
            && methodology.expected_length as usize == methodology.canonical.len(),
        CoxError::InvalidManifest
    );
    let value = UniverseVersion::from_sealed_canonical(&methodology.canonical)?;
    require!(
        value.digest == methodology.digest
            && methodology.origin == value.instruments[0].original_timestamp
            && methodology
                .roster
                .iter()
                .copied()
                .eq((0..value.instruments.len()).map(|i| i as u8)),
        CoxError::InvalidManifest
    );
    Ok(value)
}
#[cfg(test)]
mod wire_fixture_test {
    use super::*;
    #[test]
    fn dynamic_manifest_shared_wire_fixture() {
        let capture = UniverseCapture {
            price_universe_digest: [4; 32],
            timestamp: 1000,
            benchmark: 100 * cox_math::SCALE,
            prices_e8: vec![100; 30],
            signed_payload_digest: [5; 32],
            trusted_storage_digest: [6; 32],
            predecessor_sequence: 0,
            predecessor_state_digest: [7; 32],
        };
        let mut value = UniverseVersion::draft(
            0,
            Pubkey::new_from_array([1; 32]),
            Pubkey::new_from_array([2; 32]),
            [3; 32],
            1,
            [0; 32],
            30,
            capture,
        )
        .unwrap();
        value.instruments = (0..30)
            .map(|index| Instrument {
                stable_id: format!("asset{index}"),
                symbol: format!("ASSET{index}"),
                class_id: index as u16,
                epoch_id: index as u16,
                pyth_pro_feed_id: index as u32 + 1,
                pyth_core_feed_id: [index as u8 + 1; 32],
                token_mint: None,
                original_price_e8: 100,
                original_benchmark: 100 * cox_math::SCALE,
                original_timestamp: 1000,
            })
            .collect();
        let bytes = value.canonical_bytes().unwrap();
        let digest = value.canonical_digest().unwrap();
        assert_eq!(bytes.len(), 3415);
        assert_eq!(
            digest
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
            "37a30d54c5868a4f35be9bfa1bc9781f00a5b4d09808b51091d3050186d57e41"
        );
        assert_eq!(
            UniverseVersion::from_canonical(&bytes)
                .unwrap()
                .canonical_bytes()
                .unwrap(),
            bytes
        );
    }
}

pub const DYNAMIC_IDENTITIES_DOMAIN: &str = "COX/UNIVERSE/IDENTITIES/V1";

pub fn instrument_identities_digest(instruments: &[Instrument]) -> Result<[u8; 32]> { instrument_identities_digest_for_schema(1,instruments) }
pub fn instrument_identities_digest_for_schema(schema_version:u16,instruments: &[Instrument]) -> Result<[u8;32]> {
    validate_instruments_for_schema(schema_version,instruments)?;
    validated_instrument_identities_digest(instruments)
}
fn validated_instrument_identities_digest(instruments: &[Instrument]) -> Result<[u8; 32]> {
    let capacity = instruments.iter().map(|value| 4 + value.stable_id.len() + 4 + value.symbol.len() + 2 + 2 + 4 + 32 + 1 + if value.token_mint.is_some() { 32 } else { 0 }).sum::<usize>() + DYNAMIC_IDENTITIES_DOMAIN.len() + 8;
    let mut bytes = Vec::with_capacity(capacity);
    DYNAMIC_IDENTITIES_DOMAIN.to_string().serialize(&mut bytes)?;
    (instruments.len() as u32).serialize(&mut bytes)?;
    for value in instruments {
        value.stable_id.serialize(&mut bytes)?; value.symbol.serialize(&mut bytes)?;
        value.class_id.serialize(&mut bytes)?; value.epoch_id.serialize(&mut bytes)?;
        value.pyth_pro_feed_id.serialize(&mut bytes)?; value.pyth_core_feed_id.serialize(&mut bytes)?; value.token_mint.serialize(&mut bytes)?;
    }
    Ok(dynamic_digest(&bytes))
}

#[account]
#[derive(Debug)]
pub struct UniverseSchedule {
    pub schema_version: u16,
    pub bump: u8,
    pub pool: Pubkey,
    pub predecessor_digest: [u8; 32],
    pub source_methodology: [u8; 32],
    pub version: u64,
    pub identities_digest: [u8; 32],
    pub expected_instruments: u16,
    pub activation_timestamp: u64,
    pub expires_at: u64,
    pub cancelled: bool,
    pub consumed: bool,
}

impl UniverseSchedule {
    pub fn eligible(&self, pool: Pubkey, timestamp: u64) -> Result<()> {
        require!(self.schema_version == 1 && self.pool == pool && !self.cancelled && !self.consumed
            && timestamp >= self.activation_timestamp && timestamp <= self.expires_at,
            CoxError::InvalidManifest);
        Ok(())
    }
    pub fn validate_successor(&self, previous: &UniverseVersion, next: &UniverseVersion) -> Result<()> {
        require!(self.pool == previous.pool && next.pool == self.pool
            && self.predecessor_digest == previous.digest && next.predecessor_digest == previous.digest
            && previous.version.checked_add(1) == Some(self.version) && next.version == self.version
            && self.source_methodology == previous.source_methodology && next.source_methodology == self.source_methodology
            && next.expected_instruments == self.expected_instruments
            && next.capture.timestamp == self.activation_timestamp
            && validated_instrument_identities_digest(&next.instruments)? == self.identities_digest,
            CoxError::InvalidManifest);
        Ok(())
    }
}

#[cfg(test)]
mod schedule_tests {
    use super::*;
    fn previous() -> UniverseVersion {
        let mut value = UniverseVersion::draft(0, Pubkey::new_unique(), Pubkey::new_unique(), [1; 32], 1, [0; 32], 30,
            UniverseCapture { price_universe_digest: [2; 32], timestamp: 1000, benchmark: 100 * cox_math::SCALE,
                prices_e8: vec![100; 30], signed_payload_digest: [3; 32], trusted_storage_digest: [4; 32], predecessor_sequence: 1, predecessor_state_digest: [5; 32] }).unwrap();
        value.instruments = (0..30).map(|index| Instrument { stable_id: format!("asset{index}"), symbol: format!("ASSET{index}"),
            class_id: index as u16, epoch_id: index as u16, pyth_pro_feed_id: index as u32 + 1, pyth_core_feed_id: [index as u8 + 1; 32], token_mint: None,
            original_price_e8: 100, original_benchmark: 100 * cox_math::SCALE, original_timestamp: 1000 }).collect();
        value.digest = value.canonical_digest().unwrap(); value.sealed = true; value
    }
    #[test]
    fn schedule_binds_identity_boundary_lineage_and_lifecycle() {
        let previous = previous(); let mut next = UniverseVersion::draft(0, previous.pool, previous.operator, previous.source_methodology, 2, previous.digest, 31,
            UniverseCapture { timestamp: 2000, prices_e8: vec![100; 31], ..previous.capture.clone() }).unwrap();
        next.instruments = previous.instruments.clone();
        next.instruments.push(Instrument { stable_id: "new".into(), symbol: "NEW".into(), class_id: 31, epoch_id: 30,
            pyth_pro_feed_id: 31, pyth_core_feed_id: [31; 32], token_mint: None, original_price_e8: 100,
            original_benchmark: next.capture.benchmark, original_timestamp: 2000 });
        let mut schedule = UniverseSchedule { schema_version: 1, bump: 0, pool: previous.pool, predecessor_digest: previous.digest,
            source_methodology: previous.source_methodology, version: 2, identities_digest: instrument_identities_digest(&next.instruments).unwrap(),
            expected_instruments: 31, activation_timestamp: 2000, expires_at: 2100, cancelled: false, consumed: false };
        schedule.validate_successor(&previous, &next).unwrap();
        schedule.eligible(previous.pool, 2000).unwrap();
        assert!(schedule.eligible(previous.pool, 1999).is_err());
        assert!(schedule.eligible(previous.pool, 2101).is_err());
        let digest = instrument_identities_digest(&next.instruments).unwrap();
        next.instruments[30].original_price_e8 += 1;
        assert_eq!(instrument_identities_digest(&next.instruments).unwrap(), digest);
        assert!(next.seal_successor(&previous, next.capture.benchmark).is_err());
        next.instruments[30].original_price_e8 -= 1;
        next.instruments[30].pyth_pro_feed_id += 1;
        assert!(schedule.validate_successor(&previous, &next).is_err());
        next.instruments[30].pyth_pro_feed_id -= 1;
        next.capture.timestamp += 1;
        assert!(schedule.validate_successor(&previous, &next).is_err());
        next.capture.timestamp -= 1;
        schedule.cancelled = true; assert!(schedule.eligible(previous.pool, 2000).is_err());
        schedule.cancelled = false; schedule.consumed = true; assert!(schedule.eligible(previous.pool, 2000).is_err());
    }
}
