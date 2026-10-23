use anchor_lang::{AccountDeserialize, AnchorSerialize, Discriminator, InstructionData, ToAccountMetas};
use anchor_lang::__private::base64::{engine::general_purpose::STANDARD, Engine};
use cox::{accounts as a, instruction as i, Methodology, Pool, Registry, UniverseVersion};
use litesvm::LiteSVM;
use serde_json::{json, Value};
use solana_sdk::{account::Account, clock::Clock, compute_budget::ComputeBudgetInstruction, instruction::Instruction, message::Message, pubkey::Pubkey, system_program, transaction::Transaction};
use std::{collections::BTreeMap, str::FromStr};

fn text<'a>(value: &'a Value, key: &str) -> &'a str { value[key].as_str().unwrap_or_else(|| panic!("missing string {key}")) }
fn number(value: &Value, key: &str) -> u64 { value[key].as_u64().unwrap_or_else(|| panic!("missing u64 {key}")) }
fn decimal(value: &Value, key: &str) -> u64 {
    let raw = text(value, key);
    let parsed = raw.parse::<u64>().unwrap_or_else(|_| panic!("invalid decimal {key}"));
    assert_eq!(parsed.to_string(), raw, "noncanonical decimal {key}"); parsed
}
fn read<T: AccountDeserialize>(svm: &LiteSVM, address: Pubkey) -> T {
    let account = svm.get_account(&address).expect("captured account missing");
    assert_eq!(account.owner, cox::ID);
    T::try_deserialize(&mut &account.data[..]).expect("captured account layout")
}
fn instruction<A: ToAccountMetas, D: InstructionData>(accounts: A, data: D) -> Instruction {
    Instruction { program_id: cox::ID, accounts: accounts.to_account_metas(None), data: data.data() }
}
fn send(svm: &mut LiteSVM, payer: Pubkey, name: &str, instruction: Instruction, measurements: &mut Vec<Value>) {
    svm.expire_blockhash();
    let message = Message::new(&[ComputeBudgetInstruction::set_compute_unit_limit(1_400_000), ComputeBudgetInstruction::request_heap_frame(262_144), instruction], Some(&payer));
    let mut transaction = Transaction::new_unsigned(message);
    transaction.message.recent_blockhash = svm.latest_blockhash();
    let identity = cox_math::artifact_digest(&transaction.message.serialize());
    for (index, signature) in transaction.signatures.iter_mut().enumerate() {
        let mut synthetic = [0u8; 64]; synthetic[..32].copy_from_slice(&identity);
        synthetic[32..40].copy_from_slice(&(index as u64).to_le_bytes());
        *signature = solana_sdk::signature::Signature::from(synthetic);
    }
    let bytes = bincode::serialize(&transaction).unwrap().len();
    assert!(bytes <= 1232, "{name}: {bytes} bytes");
    let metadata = svm.send_transaction(transaction).unwrap_or_else(|error| panic!("{name}: {error:?}"));
    measurements.push(json!({"instruction":name,"computeUnits":metadata.compute_units_consumed,"transactionBytes":bytes}));
}

#[test]
fn captured_devnet_pool_migrates_without_changing_financial_state() {
    let Ok(path) = std::env::var("COX_CAPTURED_STATE_JSON") else {
        eprintln!("Captured-state rehearsal not requested; set COX_CAPTURED_STATE_JSON and COX_CAPTURED_GENESIS_RECEIPT. This test does not establish live migration.");
        return;
    };
    assert!(cfg!(feature = "devnet-collateral"), "captured devnet rehearsal requires devnet-collateral");
    let captured_bytes = std::fs::read(path).unwrap();
    let captured: Value = serde_json::from_slice(&captured_bytes).unwrap();
    assert_eq!(text(&captured, "schema"), "relative.dynamic-captured-state/v1");
    assert_eq!(text(&captured, "genesisHash"), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    let slot = number(&captured, "contextSlot");
    let timestamp = number(&captured, "clockTimestamp");
    assert!(slot > 0 && timestamp > 0);
    let pool_key = Pubkey::from_str(text(&captured, "pool")).unwrap();
    let program_path = std::env::var("COX_PROGRAM_SO").expect("explicit candidate SBF required");
    let program = std::fs::read(program_path).unwrap();
    let mut svm = LiteSVM::new().with_sigverify(false);
    let mut originals = BTreeMap::new();
    for row in captured["accounts"].as_array().expect("captured accounts") {
        let address = Pubkey::from_str(text(row, "address")).unwrap();
        assert_ne!(address, cox::ID, "do not restore the old executable over the candidate program");
        let account = Account { lamports: number(row, "lamports"), owner: Pubkey::from_str(text(row, "owner")).unwrap(),
            executable: row["executable"].as_bool().expect("executable"), rent_epoch: decimal(row, "rentEpoch"),
            data: STANDARD.decode(text(row, "rawBase64")).unwrap() };
        assert!(!account.executable, "capture data accounts only");
        assert!(originals.insert(address, account.clone()).is_none(), "duplicate captured account");
        svm.set_account(address, account).unwrap();
    }
    svm.add_program(cox::ID, &program);
    assert!(originals.contains_key(&solana_sdk::sysvar::clock::ID), "capture the actual Clock sysvar");
    let clock = svm.get_sysvar::<Clock>();
    assert_eq!(clock.slot, slot); assert_eq!(clock.unix_timestamp, i64::try_from(timestamp).unwrap());
    let before: Pool = read(&svm, pool_key);
    assert_eq!(before.schema_version, 4); assert_eq!(before.pool_id, 2); assert!(before.stage.is_none());
    let registry: Registry = read(&svm, before.registry);
    assert_eq!(registry.active_batches, 0);
    let source: Methodology = read(&svm, before.methodology);
    assert!(source.sealed); assert_eq!(source.schema_version, 2);
    assert!(originals.contains_key(&before.vault)); assert!(originals.contains_key(&before.collateral_mint));
    if let Some(mint) = before.test_collateral_mint { assert!(originals.contains_key(&mint)); }
    let positions = originals.values().filter(|account| account.owner == cox::ID && account.data.starts_with(cox::Position::DISCRIMINATOR)).count();
    let requests = originals.values().filter(|account| account.owner == cox::ID && account.data.starts_with(cox::Request::DISCRIMINATOR)).count();
    assert!(positions > 0, "capture existing owner positions");
    let canonical = if let Ok(path) = std::env::var("COX_CAPTURED_GENESIS_RECEIPT") {
        let receipt: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(text(&receipt, "schema"), "relative.runtime-universe-receipt/v1");
        assert_eq!(text(&receipt, "genesis_hash"), text(&captured, "genesisHash"));
        receipt["canonical"].as_array().unwrap().iter().map(|value| u8::try_from(value.as_u64().unwrap()).unwrap()).collect::<Vec<_>>()
    } else if let Ok(path) = std::env::var("COX_CAPTURED_GENESIS_CANONICAL") { std::fs::read(path).unwrap() }
    else { STANDARD.decode(text(&captured, "genesisCanonicalBase64")).unwrap() };
    let universe = UniverseVersion::from_canonical(&canonical).unwrap();
    assert_eq!(universe.pool, pool_key); assert_eq!(universe.operator, registry.runtime); assert_eq!(universe.version, 1);
    assert_eq!(universe.source_methodology, source.digest); assert_eq!(universe.capture.predecessor_sequence, before.sequence);
    assert_eq!(universe.capture.predecessor_state_digest, before.state_digest); assert_eq!(universe.instruments.len(), 30);
    assert_eq!(universe.capture.timestamp, before.origin);
    assert_eq!(universe.instruments.iter().map(|asset| asset.original_price_e8).collect::<Vec<_>>(), before.origin_prices);
    let digest = cox_math::artifact_digest(&canonical);
    assert_eq!(universe.digest, digest);
    let next = Pubkey::find_program_address(&[b"methodology", &digest], &cox::ID).0;
    assert!(!originals.contains_key(&next), "genesis target already exists");
    for payer in [registry.admin, registry.runtime] { svm.airdrop(&payer, 100_000_000_000).unwrap(); }
    let mut measurements = vec![];
    send(&mut svm, registry.admin, "register_dynamic_methodology", instruction(a::RegisterDynamicMethodology { admin: registry.admin, registry: before.registry, methodology: next, system_program: system_program::ID }, i::RegisterDynamicMethodology { digest, length: canonical.len() as u32, activation_batch: before.last_batch }), &mut measurements);
    let required = canonical.len() + 512;
    while svm.get_account(&next).unwrap().data.len() < required {
        let additional_bytes = (required - svm.get_account(&next).unwrap().data.len()).min(8192) as u32;
        send(&mut svm, registry.admin, "grow_dynamic_account", instruction(a::GrowDynamicAccount { payer: registry.admin, registry: before.registry, pool: pool_key, target: next, system_program: system_program::ID }, i::GrowDynamicAccount { additional_bytes }), &mut measurements);
    }
    for (index, page) in canonical.chunks(600).enumerate() {
        send(&mut svm, registry.admin, "upload_methodology", instruction(a::ManageMethodology { admin: registry.admin, registry: before.registry, methodology: next }, i::UploadMethodology { offset: (index * 600) as u32, bytes: page.to_vec() }), &mut measurements);
    }
    send(&mut svm, registry.runtime, "seal_dynamic_methodology", instruction(a::SealDynamicMethodology { runtime: registry.runtime, registry: before.registry, pool: pool_key, methodology: before.methodology, next_methodology: next }, i::SealDynamicMethodology {}), &mut measurements);
    assert!(read::<Methodology>(&svm, next).sealed);
    if !registry.paused { send(&mut svm, registry.admin, "pause", instruction(a::Admin { admin: registry.admin, registry: before.registry }, i::Pause {}), &mut measurements); }
    let test_vault = if before.test_collateral_mint.is_none() { None } else {
        let key = Pubkey::find_program_address(&[b"test-vault", pool_key.as_ref()], &cox::ID).0;
        assert!(originals.contains_key(&key), "capture secondary custody"); Some(key)
    };
    send(&mut svm, registry.admin, "migrate_dynamic_pool", instruction(a::MigrateDynamicPool { admin: registry.admin, registry: before.registry, pool: pool_key, methodology: before.methodology, next_methodology: next, vault: before.vault, test_vault }, i::MigrateDynamicPool {}), &mut measurements);
    let after: Pool = read(&svm, pool_key);
    let before_sequence = before.sequence;
    let mut expected = before; expected.schema_version = 5; expected.methodology = next;
    assert_eq!(after.try_to_vec().unwrap(), expected.try_to_vec().unwrap(), "all pool fields except schema/methodology must be identical");
    let mut expected_registry = registry; expected_registry.paused = true;
    assert_eq!(read::<Registry>(&svm, expected.registry).try_to_vec().unwrap(), expected_registry.try_to_vec().unwrap());
    for (address, original) in &originals {
        if *address == pool_key || *address == expected.registry { continue; }
        let current = svm.get_account(address).unwrap();
        assert_eq!(current.data, original.data, "captured account changed: {address}");
        assert_eq!((current.owner, current.executable, current.rent_epoch), (original.owner, original.executable, original.rent_epoch));
        if *address != expected_registry.admin && *address != expected_registry.runtime { assert_eq!(current.lamports, original.lamports, "captured lamports changed: {address}"); }
    }
    let hex = |bytes: &[u8]| cox_math::artifact_digest(bytes).iter().map(|value| format!("{value:02x}")).collect::<String>();
    let result = json!({"schema":"relative.dynamic-captured-rehearsal/v1","result":"passed","signatureVerification":false,"liveSignatureProof":false,"liveMigration":false,
        "genesisHash":text(&captured,"genesisHash"),"contextSlot":slot,"clockTimestamp":timestamp,"pool":pool_key.to_string(),"capturedStateSha256":hex(&captured_bytes),"programSha256":hex(&program),"genesisCanonicalSha256":hex(&canonical),"preservedPositions":positions,"preservedRequests":requests,"preservedSequence":before_sequence,"transactions":measurements});
    if let Ok(path) = std::env::var("COX_CAPTURED_REHEARSAL_RESULT") { std::fs::write(path, serde_json::to_vec_pretty(&result).unwrap()).unwrap(); }
    println!("{}", serde_json::to_string(&result).unwrap());
}
