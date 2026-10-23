use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};
use solana_address::Address;
use solana_hash::Hash;
use solana_instruction::{AccountMeta, Instruction};
use solana_message::v1::{Message, TransactionConfig};
use std::collections::BTreeSet;

pub const MAX_TRANSACTION_BYTES: usize = 4096;
pub const MAX_COMPUTE_UNITS: u32 = 1_400_000;
pub const SYSTEM_PROGRAM: Address = Address::new_from_array([0; 32]);
const MAX_REFERENCE: u128 = 1_000_000_000_000_000_000_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidSnapshot,
    InvalidBoundary,
    InvalidBudget,
    ProgramNotAllowed,
    ComputeBudgetOverride,
    UnexpectedSigner,
    AccountLimit,
    Compile,
    TooLarge,
    InvalidSignature,
}

fn discriminator(name: &str) -> [u8; 8] {
    Sha256::digest(format!("global:{name}").as_bytes())[..8]
        .try_into()
        .expect("eight bytes")
}
fn pda(program: &Address, seeds: &[&[u8]]) -> Address {
    Address::find_program_address(seeds, program).0
}
fn readonly(address: Address) -> AccountMeta {
    AccountMeta::new_readonly(address, false)
}
fn writable(address: Address) -> AccountMeta {
    AccountMeta::new(address, false)
}
fn instruction(
    program_id: Address,
    name: &str,
    accounts: Vec<AccountMeta>,
    args: &[u8],
) -> Instruction {
    let mut data = discriminator(name).to_vec();
    data.extend_from_slice(args);
    Instruction {
        program_id,
        accounts,
        data,
    }
}

#[derive(Clone, Debug)]
pub struct BasicAccounts {
    pub program: Address,
    pub registry: Address,
    pub pool: Address,
    pub methodology: Address,
    pub batch: Address,
    pub publication: Address,
    pub vault: Address,
    pub test_vault: Option<Address>,
}
impl BasicAccounts {
    fn instruction(&self, name: &str, mut accounts: Vec<AccountMeta>, args: &[u8]) -> Instruction {
        if let Some(vault) = self.test_vault {
            accounts.push(readonly(vault));
        }
        instruction(self.program, name, accounts, args)
    }

    pub fn derive(program: Address, pool_id: u64, methodology_digest: [u8; 32]) -> Self {
        let pool = pda(&program, &[b"pool", &pool_id.to_le_bytes()]);
        Self {
            program,
            registry: pda(&program, &[b"registry"]),
            pool,
            methodology: pda(&program, &[b"methodology", &methodology_digest]),
            batch: pda(&program, &[b"batch", pool.as_ref()]),
            publication: pda(&program, &[b"publication", pool.as_ref()]),
            vault: pda(&program, &[b"vault", pool.as_ref()]),
            test_vault: None,
        }
    }
    pub fn publish(
        &self,
        operator: Address,
        value: &BasicPublication,
    ) -> Result<Instruction, Error> {
        let snapshot = value.snapshot_digest()?;
        let mut args = value.batch_id.to_le_bytes().to_vec();
        args.extend_from_slice(&value.sequence.to_le_bytes());
        args.extend_from_slice(&value.predecessor);
        args.extend_from_slice(&(value.prices_e8.len() as u32).to_le_bytes());
        for price in &value.prices_e8 {
            args.extend_from_slice(&price.to_le_bytes());
            args.extend_from_slice(&[3, 0]);
            args.extend_from_slice(&value.timestamp.to_le_bytes());
            args.extend_from_slice(&0u16.to_le_bytes());
        }
        args.extend_from_slice(&snapshot);
        args.extend_from_slice(&value.timestamp.to_le_bytes());
        args.extend_from_slice(&value.benchmark.to_le_bytes());
        Ok(self.instruction(
            "publish_adaptive",
            vec![
                AccountMeta::new(operator, true),
                AccountMeta::new_readonly(operator, true),
                writable(self.registry),
                writable(self.pool),
                readonly(self.methodology),
                writable(self.batch),
                readonly(self.vault),
                readonly(SYSTEM_PROGRAM),
            ],
            &args,
        ))
    }
    pub fn begin_dynamic(
        &self,
        operator: Address,
        value: &DynamicBasicPublication,
    ) -> Result<Instruction, Error> {
        let snapshot = value.snapshot_digest()?;
        let mut args = value.publication.batch_id.to_le_bytes().to_vec();
        args.extend_from_slice(&value.publication.sequence.to_le_bytes());
        args.extend_from_slice(&value.publication.predecessor);
        args.extend_from_slice(&snapshot);
        args.extend_from_slice(&value.publication.benchmark.to_le_bytes());
        let mut accounts = vec![
            AccountMeta::new(operator, true),
            AccountMeta::new_readonly(operator, true),
            writable(self.registry),
            writable(self.pool),
            readonly(self.methodology),
            writable(self.batch),
            readonly(self.vault),
            readonly(SYSTEM_PROGRAM),
        ];
        accounts.push(readonly(self.test_vault.unwrap_or(self.program)));
        Ok(instruction(
            self.program,
            "begin_dynamic_publication",
            accounts,
            &args,
        ))
    }
    fn dynamic_stage(&self, operator: Address, name: &str, args: &[u8]) -> Instruction {
        instruction(
            self.program,
            name,
            vec![
                AccountMeta::new_readonly(operator, true),
                readonly(self.registry),
                readonly(self.pool),
                readonly(self.methodology),
                writable(self.batch),
            ],
            args,
        )
    }
    pub fn append_dynamic_prices(
        &self,
        operator: Address,
        offset: u16,
        timestamp: u64,
        prices: &[u64],
    ) -> Result<Instruction, Error> {
        if prices.is_empty()
            || prices.len() > 16
            || prices.contains(&0)
            || usize::from(offset) + prices.len() > 255
        {
            return Err(Error::InvalidSnapshot);
        }
        let mut args = offset.to_le_bytes().to_vec();
        args.extend_from_slice(&(prices.len() as u32).to_le_bytes());
        for price in prices {
            args.extend_from_slice(&price.to_le_bytes());
            args.extend_from_slice(&[3, 0]);
            args.extend_from_slice(&timestamp.to_le_bytes());
            args.extend_from_slice(&0u16.to_le_bytes());
        }
        Ok(self.dynamic_stage(operator, "append_dynamic_prices", &args))
    }
    pub fn seal_dynamic(&self, operator: Address) -> Instruction {
        self.dynamic_stage(operator, "seal_dynamic_publication", &[])
    }
    pub fn revalue_dynamic(
        &self,
        operator: Address,
        offset: u16,
        limit: u16,
        backings: bool,
    ) -> Result<Instruction, Error> {
        if limit == 0 || limit > 16 || offset >= if backings { 256 } else { 255 } {
            return Err(Error::InvalidSnapshot);
        }
        let mut args = offset.to_le_bytes().to_vec();
        args.extend_from_slice(&limit.to_le_bytes());
        Ok(self.dynamic_stage(
            operator,
            if backings {
                "finish_dynamic_revaluation"
            } else {
                "prepare_dynamic_revaluation"
            },
            &args,
        ))
    }
    pub fn process(&self, nonce: u64, owner: Address, operation: BasicProcess) -> Instruction {
        self.instruction(
            operation.name(),
            vec![
                readonly(self.registry),
                writable(self.pool),
                writable(self.batch),
                writable(pda(
                    &self.program,
                    &[b"request", self.pool.as_ref(), &nonce.to_le_bytes()],
                )),
                writable(pda(
                    &self.program,
                    &[b"position", self.pool.as_ref(), owner.as_ref()],
                )),
                readonly(self.vault),
            ],
            &[],
        )
    }
    pub fn seal_evaluation(&self) -> Instruction {
        self.instruction(
            "seal_evaluation",
            vec![
                readonly(self.registry),
                writable(self.pool),
                writable(self.batch),
                readonly(self.vault),
            ],
            &[],
        )
    }
    pub fn finalize(&self, operator: Address) -> Instruction {
        self.instruction(
            "finalize",
            vec![
                AccountMeta::new(operator, true),
                writable(self.registry),
                writable(self.pool),
                writable(self.batch),
                readonly(self.methodology),
                writable(self.publication),
                readonly(self.vault),
                readonly(SYSTEM_PROGRAM),
            ],
            &[],
        )
    }
}
#[derive(Clone, Copy, Debug)]
pub enum BasicProcess {
    Evaluate,
    Safety,
    Execute,
}
impl BasicProcess {
    fn name(self) -> &'static str {
        match self {
            Self::Evaluate => "evaluate",
            Self::Safety => "safety",
            Self::Execute => "execute",
        }
    }
}
#[derive(Clone, Debug)]
pub struct BasicPublication {
    pub origin: u64,
    pub batch_id: u64,
    pub sequence: u64,
    pub predecessor: [u8; 32],
    pub timestamp: u64,
    pub benchmark: i128,
    pub roster: Vec<u8>,
    pub prices_e8: Vec<u64>,
}
impl BasicPublication {
    pub fn snapshot_digest(&self) -> Result<[u8; 32], Error> {
        if self.origin.checked_add(self.batch_id) != Some(self.timestamp)
            || self.benchmark <= 0
            || !(2..=30).contains(&self.roster.len())
            || self.roster.len() != self.prices_e8.len()
            || self.roster.iter().any(|id| *id >= 30)
            || self.roster.windows(2).any(|pair| pair[0] >= pair[1])
            || self.prices_e8.contains(&0)
        {
            return Err(Error::InvalidSnapshot);
        }
        let domain = b"COX/ADAPTIVE-SNAPSHOT/V1";
        let mut bytes = (domain.len() as u32).to_le_bytes().to_vec();
        bytes.extend_from_slice(domain);
        bytes.extend_from_slice(&self.timestamp.to_le_bytes());
        bytes.extend_from_slice(&self.benchmark.to_le_bytes());
        bytes.extend_from_slice(&(self.roster.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&self.roster);
        for price in &self.prices_e8 {
            bytes.extend_from_slice(&price.to_le_bytes());
        }
        Ok(Sha256::digest(bytes).into())
    }
}

pub struct DynamicBasicPublication {
    pub publication: BasicPublication,
    pub universe: cox::UniverseVersion,
}
impl DynamicBasicPublication {
    pub fn snapshot_digest(&self) -> Result<[u8; 32], Error> {
        let value = &self.publication;
        if value.origin.checked_add(value.batch_id) != Some(value.timestamp)
            || value.benchmark <= 0
            || self.universe.instruments.is_empty()
            || self.universe.instruments.len() > 255
            || self.universe.instruments.len() != value.prices_e8.len()
            || value.prices_e8.contains(&0)
            || value.roster.iter().map(|id| u16::from(*id)).ne(self
                .universe
                .instruments
                .iter()
                .map(|instrument| instrument.class_id))
        {
            return Err(Error::InvalidSnapshot);
        }
        let domain = b"COX/SNAPSHOT/DYNAMIC/V1";
        let mut bytes = (domain.len() as u32).to_le_bytes().to_vec();
        bytes.extend_from_slice(domain);
        bytes.extend_from_slice(&value.timestamp.to_le_bytes());
        bytes.extend_from_slice(&value.benchmark.to_le_bytes());
        bytes.extend_from_slice(&self.universe.digest);
        bytes.extend_from_slice(&(value.prices_e8.len() as u32).to_le_bytes());
        for (instrument, price) in self.universe.instruments.iter().zip(&value.prices_e8) {
            bytes.extend_from_slice(&instrument.class_id.to_le_bytes());
            bytes.extend_from_slice(&instrument.epoch_id.to_le_bytes());
            bytes.extend_from_slice(&instrument.pyth_pro_feed_id.to_le_bytes());
            bytes.extend_from_slice(&price.to_le_bytes());
        }
        Ok(Sha256::digest(bytes).into())
    }
}

#[derive(Clone, Debug)]
pub struct EpochAccounts {
    pub program: Address,
    pub config: Address,
    pub epoch: Address,
    pub vault: Address,
    pub test_vault: Address,
}
#[derive(Clone, Debug)]
pub struct EpochPrice {
    pub asset_id: u16,
    pub feed_id: [u8; 32],
    pub value: u128,
}
#[derive(Clone, Copy, Debug)]
pub enum EpochLotOperation {
    Score,
    Allocate,
    Refund,
}
impl EpochLotOperation {
    fn name(self) -> &'static str {
        match self {
            Self::Score => "score",
            Self::Allocate => "allocate",
            Self::Refund => "refund",
        }
    }
}
impl EpochAccounts {
    pub fn derive(program: Address, config: Address, opens_at: u64) -> Result<Self, Error> {
        if opens_at % 14_400 != 0 {
            return Err(Error::InvalidBoundary);
        }
        let epoch = pda(
            &program,
            &[b"epoch", config.as_ref(), &opens_at.to_le_bytes()],
        );
        Ok(Self {
            program,
            config,
            epoch,
            vault: pda(&program, &[b"vault", epoch.as_ref()]),
            test_vault: pda(&program, &[b"test-vault", epoch.as_ref()]),
        })
    }
    pub fn snapshot(&self, sequence: u64) -> Address {
        pda(
            &self.program,
            &[b"snapshot", self.config.as_ref(), &sequence.to_le_bytes()],
        )
    }
    pub fn lot(&self, nonce: u64) -> Address {
        pda(
            &self.program,
            &[b"lot", self.epoch.as_ref(), &nonce.to_le_bytes()],
        )
    }
    pub fn publish_snapshot(
        &self,
        operator: Address,
        sequence: u64,
        timestamp: u64,
        benchmark: u128,
        prices: &[EpochPrice],
    ) -> Result<Instruction, Error> {
        if benchmark == 0
            || benchmark > MAX_REFERENCE
            || prices.is_empty()
            || prices.len() > 30
            || prices.iter().any(|price| {
                price.asset_id >= 256
                    || price.feed_id == [0; 32]
                    || price.value == 0
                    || price.value > MAX_REFERENCE
            })
            || prices
                .windows(2)
                .any(|pair| pair[0].asset_id >= pair[1].asset_id)
            || prices
                .iter()
                .map(|price| price.feed_id)
                .collect::<BTreeSet<_>>()
                .len()
                != prices.len()
        {
            return Err(Error::InvalidSnapshot);
        }
        let mut args = sequence.to_le_bytes().to_vec();
        args.extend_from_slice(&timestamp.to_le_bytes());
        args.extend_from_slice(&benchmark.to_le_bytes());
        args.extend_from_slice(&(prices.len() as u32).to_le_bytes());
        for price in prices {
            args.extend_from_slice(&price.asset_id.to_le_bytes());
            args.extend_from_slice(&price.feed_id);
            args.extend_from_slice(&price.value.to_le_bytes());
        }
        Ok(instruction(
            self.program,
            "publish_snapshot",
            vec![
                AccountMeta::new(operator, true),
                readonly(self.config),
                writable(self.snapshot(sequence)),
                readonly(SYSTEM_PROGRAM),
            ],
            &args,
        ))
    }
    fn manage_snapshot(
        &self,
        operator: Address,
        sequence: u64,
        name: &str,
        args: &[u8],
    ) -> Instruction {
        instruction(
            self.program,
            name,
            vec![
                AccountMeta::new(operator, true),
                readonly(self.config),
                writable(self.snapshot(sequence)),
                readonly(SYSTEM_PROGRAM),
            ],
            args,
        )
    }
    pub fn initialize_snapshot(
        &self,
        operator: Address,
        sequence: u64,
        timestamp: u64,
        benchmark: u128,
        count: u16,
    ) -> Result<Instruction, Error> {
        if count == 0 || count > 255 || benchmark == 0 || benchmark > MAX_REFERENCE {
            return Err(Error::InvalidSnapshot);
        }
        let mut args = sequence.to_le_bytes().to_vec();
        args.extend_from_slice(&timestamp.to_le_bytes());
        args.extend_from_slice(&benchmark.to_le_bytes());
        args.extend_from_slice(&count.to_le_bytes());
        Ok(self.manage_snapshot(operator, sequence, "initialize_snapshot", &args))
    }
    pub fn grow_snapshot(
        &self,
        operator: Address,
        sequence: u64,
        additional_bytes: u32,
    ) -> Result<Instruction, Error> {
        if additional_bytes == 0 || additional_bytes > 8_192 {
            return Err(Error::InvalidSnapshot);
        }
        Ok(self.manage_snapshot(
            operator,
            sequence,
            "grow_snapshot",
            &additional_bytes.to_le_bytes(),
        ))
    }
    pub fn append_snapshot_prices(
        &self,
        operator: Address,
        sequence: u64,
        prices: &[EpochPrice],
    ) -> Result<Instruction, Error> {
        if prices.is_empty()
            || prices.len() > 8
            || prices.iter().any(|price| {
                price.asset_id >= 256
                    || price.feed_id == [0; 32]
                    || price.value == 0
                    || price.value > MAX_REFERENCE
            })
            || prices
                .windows(2)
                .any(|pair| pair[0].asset_id >= pair[1].asset_id)
        {
            return Err(Error::InvalidSnapshot);
        }
        let mut args = (prices.len() as u32).to_le_bytes().to_vec();
        for price in prices {
            args.extend_from_slice(&price.asset_id.to_le_bytes());
            args.extend_from_slice(&price.feed_id);
            args.extend_from_slice(&price.value.to_le_bytes());
        }
        Ok(self.manage_snapshot(operator, sequence, "append_prices", &args))
    }
    pub fn seal_snapshot(&self, operator: Address, sequence: u64) -> Instruction {
        self.manage_snapshot(operator, sequence, "seal_snapshot", &[])
    }
    fn custody(&self) -> Vec<AccountMeta> {
        vec![
            readonly(self.config),
            writable(self.epoch),
            readonly(self.vault),
            readonly(self.test_vault),
        ]
    }
    pub fn close_snapshot(&self, operator: Address, sequence: u64) -> Instruction {
        instruction(
            self.program,
            "close_snapshot",
            vec![
                AccountMeta::new(operator, true),
                readonly(self.config),
                writable(self.snapshot(sequence)),
            ],
            &[],
        )
    }
    pub fn execute(&self, operator: Address, nonce: u64, snapshot_sequence: u64) -> Instruction {
        let mut accounts = vec![
            AccountMeta::new_readonly(operator, true),
            readonly(self.config),
            writable(self.epoch),
            writable(self.lot(nonce)),
            readonly(self.vault),
            readonly(self.test_vault),
        ];
        accounts.push(readonly(self.snapshot(snapshot_sequence)));
        instruction(self.program, "execute", accounts, &[])
    }
    pub fn begin_close(&self, operator: Address, snapshot_sequence: u64) -> Instruction {
        let mut accounts = vec![AccountMeta::new_readonly(operator, true)];
        accounts.extend(self.custody());
        accounts.push(readonly(self.snapshot(snapshot_sequence)));
        instruction(self.program, "begin_close", accounts, &[])
    }
    pub fn process_lot(&self, nonce: u64, operation: EpochLotOperation) -> Instruction {
        let mut accounts = self.custody();
        accounts.insert(2, writable(self.lot(nonce)));
        instruction(self.program, operation.name(), accounts, &[])
    }
    pub fn finalize_scores(&self) -> Instruction {
        instruction(self.program, "finalize_scores", self.custody(), &[])
    }
    pub fn void_epoch(&self) -> Instruction {
        instruction(self.program, "void_epoch", self.custody(), &[])
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Budget {
    pub compute_units: u32,
    pub priority_fee_lamports: u64,
    pub heap_bytes: Option<u32>,
}
#[derive(Clone, Debug)]
pub struct PublicationTransaction {
    operator: Address,
    pub message: Vec<u8>,
    pub unsigned_transaction: Vec<u8>,
    pub message_sha256: [u8; 32],
    pub account_count: usize,
}
impl PublicationTransaction {
    pub fn with_signature(&self, operator: Address, signature: [u8; 64]) -> Result<Vec<u8>, Error> {
        if operator != self.operator
            || self.unsigned_transaction.len() != self.message.len() + 64
            || self.unsigned_transaction.len() > MAX_TRANSACTION_BYTES
            || self.unsigned_transaction[..self.message.len()] != self.message
            || <[u8; 32]>::from(Sha256::digest(&self.message)) != self.message_sha256
        {
            return Err(Error::InvalidSignature);
        }
        VerifyingKey::from_bytes(&operator.to_bytes())
            .map_err(|_| Error::InvalidSignature)?
            .verify_strict(&self.message, &Signature::from_bytes(&signature))
            .map_err(|_| Error::InvalidSignature)?;
        let mut transaction = self.unsigned_transaction.clone();
        transaction[self.message.len()..].copy_from_slice(&signature);
        Ok(transaction)
    }
}
pub fn compile(
    operator: Address,
    blockhash: Hash,
    instructions: &[Instruction],
    allowed_programs: &[Address],
    budget: Budget,
) -> Result<PublicationTransaction, Error> {
    if budget.compute_units == 0
        || budget.compute_units > MAX_COMPUTE_UNITS
        || instructions.is_empty()
        || instructions.len() > 64
        || budget
            .heap_bytes
            .is_some_and(|size| !(32_768..=262_144).contains(&size) || size % 1024 != 0)
    {
        return Err(Error::InvalidBudget);
    }
    let compute_program: Address = "ComputeBudget111111111111111111111111111111"
        .parse()
        .map_err(|_| Error::Compile)?;
    for instruction in instructions {
        if instruction.program_id == compute_program {
            return Err(Error::ComputeBudgetOverride);
        }
        if !allowed_programs.contains(&instruction.program_id) {
            return Err(Error::ProgramNotAllowed);
        }
        if instruction
            .accounts
            .iter()
            .any(|account| account.is_signer && account.pubkey != operator)
        {
            return Err(Error::UnexpectedSigner);
        }
    }
    let mut config = TransactionConfig::empty()
        .with_loaded_accounts_data_size_limit(64 * 1024 * 1024)
        .with_compute_unit_limit(budget.compute_units)
        .with_priority_fee(budget.priority_fee_lamports);
    if let Some(heap) = budget.heap_bytes {
        config = config.with_heap_size(heap);
    }
    let message = Message::try_compile_with_config(&operator, instructions, blockhash, config)
        .map_err(|_| Error::Compile)?;
    if message.header.num_required_signatures != 1
        || message.account_keys.first() != Some(&operator)
    {
        return Err(Error::UnexpectedSigner);
    }
    if message.account_keys.len() > 64 {
        return Err(Error::AccountLimit);
    }
    message.validate().map_err(|_| Error::Compile)?;
    let bytes = message.serialize();
    let mut transaction = bytes.clone();
    transaction.extend_from_slice(&[0; 64]);
    if transaction.len() > MAX_TRANSACTION_BYTES {
        return Err(Error::TooLarge);
    }
    Ok(PublicationTransaction {
        operator,
        message_sha256: Sha256::digest(&bytes).into(),
        message: bytes,
        unsigned_transaction: transaction,
        account_count: message.account_keys.len(),
    })
}

#[cfg(test)]
pub(crate) fn dynamic_test_universe(count: usize) -> cox::UniverseVersion {
    use anchor_lang::prelude::Pubkey;
    let mut universe = cox::UniverseVersion::draft(
        0,
        Pubkey::new_from_array([1; 32]),
        Pubkey::new_from_array([7; 32]),
        [3; 32],
        1,
        [0; 32],
        count as u16,
        cox::UniverseCapture {
            price_universe_digest: [5; 32],
            timestamp: 14_400,
            benchmark: 100 * cox_math::SCALE,
            prices_e8: vec![100; count],
            signed_payload_digest: [6; 32],
            trusted_storage_digest: [7; 32],
            predecessor_sequence: 1,
            predecessor_state_digest: [8; 32],
        },
    )
    .unwrap();
    universe.instruments = (0..count)
        .map(|index| cox::Instrument {
            stable_id: format!("asset{index}"),
            symbol: cox::IDS
                .get(index)
                .map(|value| value.to_string())
                .unwrap_or(format!("ASSET{index}")),
            class_id: cox::class_for_asset_index(index).unwrap(),
            epoch_id: index as u16,
            pyth_pro_feed_id: index as u32 + 1,
            pyth_core_feed_id: [index as u8 + 1; 32],
            token_mint: None,
            original_price_e8: 100,
            original_benchmark: 100 * cox_math::SCALE,
            original_timestamp: 14_400,
        })
        .collect();
    cox::UniverseVersion::from_canonical(&universe.canonical_bytes().unwrap()).unwrap()
}
#[cfg(test)]
mod dynamic_tests {
    use super::*;
    use anchor_lang::{InstructionData, ToAccountMetas};
    fn key(value: u8) -> Address {
        Address::new_from_array([value; 32])
    }
    fn publication(count: usize) -> DynamicBasicPublication {
        let universe = dynamic_test_universe(count);
        DynamicBasicPublication {
            publication: BasicPublication {
                origin: 14_400,
                batch_id: 10,
                sequence: 2,
                predecessor: [8; 32],
                timestamp: 14_410,
                benchmark: 101 * cox_math::SCALE,
                roster: universe
                    .instruments
                    .iter()
                    .map(|value| value.class_id as u8)
                    .collect(),
                prices_e8: (0..count).map(|index| 100 + index as u64).collect(),
            },
            universe,
        }
    }
    #[test]
    fn dynamic_encoding_and_snapshot_match_generated_anchor_abi_at_31_and_255_assets() {
        for count in [31, 255] {
            let value = publication(count);
            let wire = value
                .publication
                .prices_e8
                .iter()
                .map(|price| cox::PriceWire {
                    price_e8: *price,
                    venue: 3,
                    step: 0,
                    candle_start: value.publication.timestamp,
                    trade_age_minutes: 0,
                })
                .collect::<Vec<_>>();
            let snapshot = cox::dynamic_snapshot_digest(
                value.publication.timestamp,
                value.publication.benchmark,
                &value.universe,
                &wire,
            )
            .unwrap();
            assert_eq!(value.snapshot_digest().unwrap(), snapshot);
            let mut basic = BasicAccounts::derive(key(1), 2, value.universe.digest);
            basic.test_vault = Some(key(9));
            let begin = basic.begin_dynamic(key(7), &value).unwrap();
            assert_eq!(
                begin.data,
                cox::instruction::BeginDynamicPublication {
                    batch_id: 10,
                    sequence: 2,
                    predecessor: [8; 32],
                    snapshot,
                    benchmark: value.publication.benchmark
                }
                .data()
            );
            let pk = |key: Address| anchor_lang::prelude::Pubkey::new_from_array(key.to_bytes());
            let accounts = cox::accounts::BeginDynamicPublication {
                payer: pk(key(7)),
                runtime: pk(key(7)),
                registry: pk(basic.registry),
                pool: pk(basic.pool),
                methodology: pk(basic.methodology),
                batch: pk(basic.batch),
                vault: pk(basic.vault),
                system_program: pk(SYSTEM_PROGRAM),
                test_vault: Some(pk(key(9))),
            }
            .to_account_metas(None);
            assert_eq!(begin.accounts.len(), accounts.len());
            for (actual, expected) in begin.accounts.iter().zip(accounts) {
                assert_eq!(actual.pubkey.to_bytes(), expected.pubkey.to_bytes());
                assert_eq!(actual.is_signer, expected.is_signer);
                assert_eq!(actual.is_writable, expected.is_writable);
            }
            let append = basic
                .append_dynamic_prices(
                    key(7),
                    16,
                    value.publication.timestamp,
                    &value.publication.prices_e8[16..count.min(32)],
                )
                .unwrap();
            assert_eq!(
                append.data,
                cox::instruction::AppendDynamicPrices {
                    offset: 16,
                    prices: wire[16..count.min(32)].to_vec()
                }
                .data()
            );
            assert_eq!(
                basic.seal_dynamic(key(7)).data,
                cox::instruction::SealDynamicPublication {}.data()
            );
            assert_eq!(
                basic.revalue_dynamic(key(7), 16, 16, false).unwrap().data,
                cox::instruction::PrepareDynamicRevaluation {
                    offset: 16,
                    limit: 16
                }
                .data()
            );
            assert_eq!(
                basic.revalue_dynamic(key(7), 240, 16, true).unwrap().data,
                cox::instruction::FinishDynamicRevaluation {
                    offset: 240,
                    limit: 16
                }
                .data()
            );
        }
    }
    #[test]
    fn epoch_staging_instructions_match_generated_anchor_abi() {
        let accounts = EpochAccounts::derive(key(2), key(3), 14_400).unwrap();
        assert_eq!(
            accounts
                .initialize_snapshot(key(7), 28_800, 28_800, 100, 255)
                .unwrap()
                .data,
            relative_epoch::instruction::InitializeSnapshot {
                sequence: 28_800,
                oracle_timestamp: 28_800,
                benchmark: 100,
                expected_prices: 255
            }
            .data()
        );
        assert_eq!(
            accounts.grow_snapshot(key(7), 28_800, 8192).unwrap().data,
            relative_epoch::instruction::GrowSnapshot {
                additional_bytes: 8192
            }
            .data()
        );
        let prices = (0..8)
            .map(|index| EpochPrice {
                asset_id: index,
                feed_id: [index as u8 + 1; 32],
                value: 100,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            accounts
                .append_snapshot_prices(key(7), 28_800, &prices)
                .unwrap()
                .data,
            relative_epoch::instruction::AppendPrices {
                prices: prices
                    .iter()
                    .map(|price| cox_epoch::Price {
                        asset_id: price.asset_id,
                        feed_id: price.feed_id,
                        value: price.value
                    })
                    .collect()
            }
            .data()
        );
        assert_eq!(
            accounts.seal_snapshot(key(7), 28_800).data,
            relative_epoch::instruction::SealSnapshot {}.data()
        );
    }
    #[test]
    fn dynamic_pages_reject_wrong_bounds_and_full_31_asset_start_fits_v1_transaction() {
        let value = publication(31);
        let basic = BasicAccounts::derive(key(1), 2, value.universe.digest);
        let mut instructions = vec![basic.begin_dynamic(key(7), &value).unwrap()];
        for (index, page) in value.publication.prices_e8.chunks(16).enumerate() {
            instructions.push(
                basic
                    .append_dynamic_prices(
                        key(7),
                        (index * 16) as u16,
                        value.publication.timestamp,
                        page,
                    )
                    .unwrap(),
            );
        }
        instructions.push(basic.seal_dynamic(key(7)));
        let tx = compile(
            key(7),
            Hash::new_from_array([1; 32]),
            &instructions,
            &[key(1)],
            Budget {
                compute_units: 1_400_000,
                priority_fee_lamports: 0,
                heap_bytes: Some(262_144),
            },
        )
        .unwrap();
        assert!(tx.unsigned_transaction.len() < 4096);
        assert!(basic
            .append_dynamic_prices(key(7), 250, 14_410, &[100; 16])
            .is_err());
        assert!(basic
            .append_dynamic_prices(key(7), 0, 14_410, &[100; 17])
            .is_err());
        assert!(basic.revalue_dynamic(key(7), 256, 1, true).is_err());
    }
}
