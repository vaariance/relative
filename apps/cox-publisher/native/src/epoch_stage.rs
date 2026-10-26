use crate::{
    benchmark::{Anchor, Observation},
    executor::AssetMapping,
    scheduler::Work,
    transactions::{EpochAccounts, EpochPrice},
    worker,
};
use anchor_lang::AnchorSerialize;
use serde::{Deserialize, Serialize};
use solana_address::Address;
use solana_instruction::Instruction;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Stage {
    pub schema: String,
    pub program: String,
    pub config: String,
    pub operator: String,
    pub anchor: Anchor,
    pub observation: Observation,
    pub work: Vec<Work>,
}
impl Stage {
    pub fn validate(
        &self,
        program: Address,
        config: Address,
        operator: Address,
        anchor: &Anchor,
    ) -> Result<(), worker::Error> {
        if self.schema!="relative.epoch-snapshot-stage/v1" || self.program!=program.to_string() || self.config!=config.to_string() || self.operator!=operator.to_string()
            || self.anchor!=*anchor || self.observation.universe_digest!=anchor.universe_digest || self.observation.timestamp_us%1_000_000!=0
            || self.observation.prices_e8.len()!=anchor.assets.len() || self.work.is_empty() || self.work.len()>16 || self.work.iter().any(|work|!matches!(work,Work::Entry{pool:crate::scheduler::Pool::Epoch,..}|Work::Close{..}))
            || self.work.iter().any(|work|matches!(work,Work::Close{timestamp_ms,..} if timestamp_ms.checked_mul(1000)!=Some(self.observation.timestamp_us))) { return Err(worker::Error::Snapshot); }
        Ok(())
    }
    pub fn timestamp(&self) -> u64 {
        self.observation.timestamp_us / 1_000_000
    }
    pub fn closing(&self) -> bool {
        self.work
            .iter()
            .any(|work| matches!(work, Work::Close { .. }))
    }
    pub fn prices(&self, mapping: &[AssetMapping]) -> Result<Vec<EpochPrice>, worker::Error> {
        if mapping.len() != self.observation.prices_e8.len() {
            return Err(worker::Error::Snapshot);
        }
        let mut prices = mapping
            .iter()
            .zip(&self.observation.prices_e8)
            .map(|(mapping, price)| EpochPrice {
                asset_id: mapping.epoch_id,
                feed_id: mapping.epoch_feed_id,
                value: u128::from(*price),
            })
            .collect::<Vec<_>>();
        prices.sort_by_key(|price| price.asset_id);
        Ok(prices)
    }
    pub fn verify_snapshot(
        &self,
        saved: &relative_epoch::SnapshotAccount,
        prices: &[EpochPrice],
        methodology: [u8; 32],
    ) -> Result<(), worker::Error> {
        if saved.config.to_bytes()
            != self
                .config
                .parse::<Address>()
                .map_err(|_| worker::Error::Snapshot)?
                .to_bytes()
            || saved.sequence != self.timestamp()
            || saved.oracle_timestamp != self.timestamp()
            || saved.benchmark != self.observation.benchmark as u128
            || saved.methodology != methodology
            || usize::from(saved.expected_prices) != prices.len()
            || saved.prices.len() > prices.len()
            || saved.prices.iter().zip(prices).any(|(saved, price)| {
                saved.asset_id != price.asset_id
                    || saved.feed_id != price.feed_id
                    || saved.value != price.value
            })
            || (saved.sealed && saved.prices.len() != prices.len())
        {
            return Err(worker::Error::Snapshot);
        }
        Ok(())
    }
    pub fn plan(
        &self,
        accounts: &EpochAccounts,
        operator: Address,
        saved: Option<(&relative_epoch::SnapshotAccount, usize)>,
        prices: &[EpochPrice],
    ) -> Result<Vec<Instruction>, worker::Error> {
        let mut instructions = Vec::new();
        let (present, space, header) = if let Some((snapshot, space)) = saved {
            if snapshot.sealed {
                return Ok(instructions);
            }
            (
                snapshot.prices.len(),
                space,
                snapshot
                    .try_to_vec()
                    .map_err(|_| worker::Error::Snapshot)?
                    .len()
                    + 8
                    - snapshot.prices.len() * 50,
            )
        } else {
            instructions.push(
                accounts
                    .initialize_snapshot(
                        operator,
                        self.timestamp(),
                        self.timestamp(),
                        self.observation.benchmark as u128,
                        u16::try_from(prices.len()).map_err(|_| worker::Error::Snapshot)?,
                    )
                    .map_err(|_| worker::Error::Snapshot)?,
            );
            if prices.len() > 61 {
                return Ok(instructions);
            }
            (0, relative_epoch::INITIAL_SPACE, 144)
        };
        let target = header + prices.len() * 50;
        if space < target {
            instructions.push(
                accounts
                    .grow_snapshot(
                        operator,
                        self.timestamp(),
                        (target - space).min(8_192) as u32,
                    )
                    .map_err(|_| worker::Error::Snapshot)?,
            );
            if prices.len() > 61 {
                return Ok(instructions);
            }
        }
        for page in prices[present..].chunks(8) {
            instructions.push(
                accounts
                    .append_snapshot_prices(operator, self.timestamp(), page)
                    .map_err(|_| worker::Error::Snapshot)?,
            );
        }
        instructions.push(accounts.seal_snapshot(operator, self.timestamp()));
        Ok(instructions)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::{AccountDeserialize, Discriminator};
    use sha2::Digest;
    fn key(byte: u8) -> Address {
        Address::new_from_array([byte; 32])
    }
    fn fixture(
        count: usize,
    ) -> (
        Stage,
        EpochAccounts,
        Vec<EpochPrice>,
        relative_epoch::SnapshotAccount,
    ) {
        let universe = crate::transactions::dynamic_test_universe(count);
        let view = crate::universe_runtime::view(&universe.canonical_bytes().unwrap()).unwrap();
        let stage = Stage {
            schema: "relative.epoch-snapshot-stage/v1".into(),
            program: key(2).to_string(),
            config: key(3).to_string(),
            operator: key(7).to_string(),
            anchor: view.anchor.clone(),
            observation: Observation {
                universe_digest: view.anchor.universe_digest,
                timestamp_us: 28_800_000_000,
                benchmark: 100 * cox_math::SCALE,
                prices_e8: vec![100; count],
                signed_payload: vec![1],
            },
            work: vec![Work::Close {
                id: "epoch:14400:close".into(),
                timestamp_ms: 28_800_000,
            }],
        };
        let accounts = EpochAccounts::derive(key(2), key(3), 14_400).unwrap();
        let prices = stage.prices(&view.mapping).unwrap();
        let mut bytes = relative_epoch::SnapshotAccount::DISCRIMINATOR.to_vec();
        bytes.resize(20_000, 0);
        let mut saved =
            relative_epoch::SnapshotAccount::try_deserialize(&mut bytes.as_slice()).unwrap();
        saved.config = anchor_lang::prelude::Pubkey::new_from_array(key(3).to_bytes());
        saved.sequence = 28_800;
        saved.oracle_timestamp = 28_800;
        saved.benchmark = 100 * cox_math::SCALE as u128;
        saved.expected_prices = count as u16;
        saved.methodology = [9; 32];
        (stage, accounts, prices, saved)
    }
    #[test]
    fn staged_snapshot_restores_exact_closing_and_pages_from_verified_prefix() {
        for count in [31, 255] {
            let (stage, accounts, prices, mut saved) = fixture(count);
            stage
                .validate(key(2), key(3), key(7), &stage.anchor)
                .unwrap();
            stage.verify_snapshot(&saved, &prices, [9; 32]).unwrap();
            let initial = stage.plan(&accounts, key(7), None, &prices).unwrap();
            assert_eq!(
                initial[0],
                accounts
                    .initialize_snapshot(
                        key(7),
                        28_800,
                        28_800,
                        100 * cox_math::SCALE as u128,
                        count as u16
                    )
                    .unwrap()
            );
            assert_eq!(initial.len(), if count == 31 { 6 } else { 1 });
            saved.prices = prices[..8]
                .iter()
                .map(|price| cox_epoch::Price {
                    asset_id: price.asset_id,
                    feed_id: price.feed_id,
                    value: price.value,
                })
                .collect();
            let restored: Stage =
                serde_json::from_slice(&serde_json::to_vec(&stage).unwrap()).unwrap();
            restored.verify_snapshot(&saved, &prices, [9; 32]).unwrap();
            let instructions = restored
                .plan(&accounts, key(7), Some((&saved, 16_000)), &prices)
                .unwrap();
            assert_eq!(
                instructions[0],
                accounts
                    .append_snapshot_prices(key(7), 28_800, &prices[8..16])
                    .unwrap()
            );
            assert_eq!(
                instructions.last().unwrap(),
                &accounts.seal_snapshot(key(7), 28_800)
            );
            saved.prices[0].value += 1;
            assert!(restored.verify_snapshot(&saved, &prices, [9; 32]).is_err());
            saved.prices[0].value -= 1;
            saved.oracle_timestamp += 1;
            assert!(restored.verify_snapshot(&saved, &prices, [9; 32]).is_err());
            let mut wrong = stage.clone();
            wrong.observation.timestamp_us += 1_000_000;
            assert!(wrong
                .validate(key(2), key(3), key(7), &stage.anchor)
                .is_err());
        }
    }
    #[test]
    fn complete_31_and_61_price_snapshots_execute_within_one_v1_packet() {
        for count in [31, 61] {
            let (stage, accounts, prices, saved) = fixture(count);
            assert_eq!(saved.try_to_vec().unwrap().len() + 8, 144);
            let mut instructions = stage.plan(&accounts, key(7), None, &prices).unwrap();
            assert_eq!(
                instructions.last().unwrap(),
                &accounts.seal_snapshot(key(7), stage.timestamp())
            );
            assert_eq!(
                instructions
                    .iter()
                    .filter(|instruction| instruction.data.get(..8)
                        == Some(&sha2::Sha256::digest(b"global:grow_snapshot")[..8]))
                    .count(),
                usize::from(count == 61)
            );
            instructions.push(accounts.execute(key(7), 0, stage.timestamp()));
            instructions.push(accounts.execute(key(7), 1, stage.timestamp()));
            instructions.push(accounts.close_snapshot(key(7), stage.timestamp()));
            let transaction = crate::transactions::compile(
                key(7),
                solana_hash::Hash::new_from_array([5; 32]),
                &instructions,
                &[accounts.program],
                crate::transactions::Budget {
                    compute_units: 1_400_000,
                    priority_fee_lamports: 100,
                    heap_bytes: Some(262_144),
                },
            )
            .unwrap();
            assert!(transaction.unsigned_transaction.len() <= 4096);
            assert!(instructions.len() + 4 <= 64);
            eprintln!("{count}-feed atomic snapshot + 2 executions + close: {} bytes, {} protocol instructions", transaction.unsigned_transaction.len(), instructions.len());
        }
    }
    #[test]
    fn snapshot_growth_is_bounded_to_one_reallocation_per_transaction_and_sealing_is_resumable() {
        let (stage, accounts, prices, mut saved) = fixture(255);
        let first = stage
            .plan(&accounts, key(7), Some((&saved, 2_048)), &prices)
            .unwrap();
        assert_eq!(
            first,
            vec![accounts.grow_snapshot(key(7), 28_800, 8_192).unwrap()]
        );
        let second = stage
            .plan(&accounts, key(7), Some((&saved, 10_240)), &prices)
            .unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(
            &second[0].data[..8],
            &sha2::Sha256::digest(b"global:grow_snapshot")[..8]
        );
        saved.prices = prices
            .iter()
            .map(|price| cox_epoch::Price {
                asset_id: price.asset_id,
                feed_id: price.feed_id,
                value: price.value,
            })
            .collect();
        assert_eq!(
            stage
                .plan(&accounts, key(7), Some((&saved, 16_000)), &prices)
                .unwrap(),
            vec![accounts.seal_snapshot(key(7), 28_800)]
        );
        saved.sealed = true;
        assert!(stage
            .plan(&accounts, key(7), Some((&saved, 16_000)), &prices)
            .unwrap()
            .is_empty());
    }
}
