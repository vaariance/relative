use relative_publisher::transactions::*;
use sha2::{Digest, Sha256};
use solana_address::Address;
use solana_hash::Hash;
use solana_instruction::{AccountMeta, Instruction};

fn address(byte: u8) -> Address {
    Address::new_from_array([byte; 32])
}
fn publication() -> BasicPublication {
    BasicPublication {
        origin: 1_800_000_000,
        timestamp: 1_800_000_017,
        batch_id: 17,
        sequence: 8,
        predecessor: [7; 32],
        benchmark: 110_000_000_000_000,
        roster: (0..30).collect(),
        prices_e8: (0..30).map(|index| 100_000_000 + index).collect(),
    }
}
fn pair() -> (BasicAccounts, EpochAccounts, Vec<Instruction>) {
    let basic = BasicAccounts::derive(address(2), 2, [6; 32]);
    let epoch = EpochAccounts::derive(address(3), address(4), 1_800_000_000).unwrap();
    let value = publication();
    let prices = value
        .prices_e8
        .iter()
        .enumerate()
        .map(|(index, value)| EpochPrice {
            asset_id: index as u16,
            feed_id: [index as u8 + 1; 32],
            value: u128::from(*value),
        })
        .collect::<Vec<_>>();
    let instructions = vec![
        basic.publish(address(9), &value).unwrap(),
        epoch
            .publish_snapshot(
                address(9),
                11,
                value.timestamp,
                value.benchmark as u128,
                &prices,
            )
            .unwrap(),
    ];
    (basic, epoch, instructions)
}
fn budget() -> Budget {
    Budget {
        compute_units: 1_400_000,
        priority_fee_lamports: 17,
        heap_bytes: Some(262_144),
    }
}
fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[test]
fn full_thirty_price_basic_epoch_publication_matches_independent_typescript_sdk() {
    let (_, _, instructions) = pair();
    assert_eq!(
        hex::encode(publication().snapshot_digest().unwrap()),
        "da1985b0aa8be1c68f1bafa82a76a25da4ff5b3c21b6f7f6ac843fb13302d558"
    );
    assert_eq!(
        hash(&instructions[0].data),
        "df350ee2e211f70e0ce7fa783e81ec483c7326c689e5223d6ca9863f28fe14bf"
    );
    assert_eq!(
        hash(&instructions[1].data),
        "fea9753872fe53183a70d5fdf86300adc4692eb743d7e71352b38d8f80aff917"
    );
    let mut commitment = Sha256::new();
    for ix in &instructions {
        commitment.update(ix.program_id.as_ref());
        commitment.update((ix.accounts.len() as u32).to_le_bytes());
        for account in &ix.accounts {
            commitment.update(account.pubkey.as_ref());
            commitment.update([u8::from(account.is_signer), u8::from(account.is_writable)]);
        }
        commitment.update((ix.data.len() as u32).to_le_bytes());
        commitment.update(&ix.data);
    }
    assert_eq!(
        hex::encode(commitment.finalize()),
        "bd54427f0136436b23584f52dfedaacf3b7a783dfa32b96a01a396131cc82016"
    );
    let tx = compile(
        address(9),
        Hash::new_from_array([8; 32]),
        &instructions,
        &[address(2), address(3)],
        budget(),
    )
    .unwrap();
    assert_eq!(
        hex::encode(tx.message_sha256),
        "66aa09419d3a4aa40c74d0d352c0bb0d6422c5b40f8a8bd782fbea0432aa0902"
    );
    assert_eq!(tx.unsigned_transaction.len(), 2758);
    assert_eq!(tx.account_count, 11);
    assert!(tx.unsigned_transaction.len() > 1232);
    assert_eq!(tx.message[0], 0x81);
    assert_eq!(
        solana_message::v1::deserialize(&tx.message[1..])
            .unwrap()
            .config
            .loaded_accounts_data_size_limit,
        Some(64 * 1024 * 1024)
    );
}

#[test]
fn canonical_instruction_account_roles_match_generated_anchor_abis() {
    let (basic, epoch, publications) = pair();
    let basic_idl: serde_json::Value =
        serde_json::from_str(include_str!("../../../../packages/cox/idl/cox.json")).unwrap();
    let epoch_idl: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../packages/cox-epoch/idl/epoch.json"
    ))
    .unwrap();
    let check = |idl: &serde_json::Value, name: &str, ix: Instruction| {
        let definition = idl["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["name"].as_str() == Some(name))
            .unwrap();
        assert_eq!(
            &ix.data[..8],
            definition["discriminator"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_u64().unwrap() as u8)
                .collect::<Vec<_>>()
        );
        let accounts = definition["accounts"].as_array().unwrap();
        assert!(ix.accounts.len() <= accounts.len(), "{name} account count");
        for omitted in &accounts[ix.accounts.len()..] {
            assert_eq!(
                omitted["optional"].as_bool(),
                Some(true),
                "{name} omitted mandatory account"
            );
        }
        for (actual, expected) in ix.accounts.iter().zip(accounts) {
            assert_eq!(
                actual.is_signer,
                expected["signer"].as_bool().unwrap_or(false),
                "{name} signer"
            );
            assert_eq!(
                actual.is_writable,
                expected["writable"].as_bool().unwrap_or(false),
                "{name} writable"
            );
        }
    };
    check(&basic_idl, "publish_adaptive", publications[0].clone());
    check(&basic_idl, "seal_evaluation", basic.seal_evaluation());
    check(&basic_idl, "finalize", basic.finalize(address(9)));
    for (name, operation) in [
        ("evaluate", BasicProcess::Evaluate),
        ("safety", BasicProcess::Safety),
        ("execute", BasicProcess::Execute),
    ] {
        check(&basic_idl, name, basic.process(1, address(10), operation));
    }
    let mut dual = basic.clone();
    dual.test_vault = Some(address(15));
    for (name, instruction) in [
        (
            "publish_adaptive",
            dual.publish(address(9), &publication()).unwrap(),
        ),
        ("seal_evaluation", dual.seal_evaluation()),
        ("finalize", dual.finalize(address(9))),
        (
            "evaluate",
            dual.process(1, address(10), BasicProcess::Evaluate),
        ),
        ("safety", dual.process(1, address(10), BasicProcess::Safety)),
        (
            "execute",
            dual.process(1, address(10), BasicProcess::Execute),
        ),
    ] {
        assert_eq!(
            instruction.accounts.last(),
            Some(&AccountMeta::new_readonly(address(15), false))
        );
        check(&basic_idl, name, instruction);
    }
    check(&epoch_idl, "publish_snapshot", publications[1].clone());
    check(&epoch_idl, "execute", epoch.execute(address(9), 1, 11));
    check(&epoch_idl, "begin_close", epoch.begin_close(address(9), 11));
    check(&epoch_idl, "finalize_scores", epoch.finalize_scores());
    check(&epoch_idl, "void_epoch", epoch.void_epoch());
    check(
        &epoch_idl,
        "close_snapshot",
        epoch.close_snapshot(address(9), 11),
    );
    for (name, operation) in [
        ("score", EpochLotOperation::Score),
        ("allocate", EpochLotOperation::Allocate),
        ("refund", EpochLotOperation::Refund),
    ] {
        check(&epoch_idl, name, epoch.process_lot(1, operation));
    }
}

#[test]
fn rejects_unknown_program_extra_signer_and_compute_override() {
    let (_, _, instructions) = pair();
    assert_eq!(
        compile(
            address(9),
            Hash::new_from_array([8; 32]),
            &instructions,
            &[address(2)],
            budget()
        )
        .unwrap_err(),
        Error::ProgramNotAllowed
    );
    let mut wrong = instructions.clone();
    wrong[0]
        .accounts
        .push(AccountMeta::new_readonly(address(10), true));
    assert_eq!(
        compile(
            address(9),
            Hash::new_from_array([8; 32]),
            &wrong,
            &[address(2), address(3)],
            budget()
        )
        .unwrap_err(),
        Error::UnexpectedSigner
    );
    let compute = "ComputeBudget111111111111111111111111111111"
        .parse()
        .unwrap();
    let override_ix = Instruction {
        program_id: compute,
        accounts: vec![],
        data: vec![],
    };
    assert_eq!(
        compile(
            address(9),
            Hash::new_from_array([8; 32]),
            &[override_ix],
            &[compute],
            budget()
        )
        .unwrap_err(),
        Error::ComputeBudgetOverride
    );
}

#[test]
fn rejects_invalid_snapshots_budgets_account_and_transaction_sizes() {
    let mut value = publication();
    value.timestamp += 1;
    assert_eq!(value.snapshot_digest(), Err(Error::InvalidSnapshot));
    value = publication();
    value.roster.swap(0, 1);
    assert_eq!(value.snapshot_digest(), Err(Error::InvalidSnapshot));
    value = publication();
    value.prices_e8[0] = 0;
    assert_eq!(value.snapshot_digest(), Err(Error::InvalidSnapshot));
    let (_, _, mut instructions) = pair();
    for invalid in [
        Budget {
            compute_units: 0,
            ..budget()
        },
        Budget {
            compute_units: 1_400_001,
            ..budget()
        },
        Budget {
            heap_bytes: Some(32_769),
            ..budget()
        },
    ] {
        assert_eq!(
            compile(
                address(9),
                Hash::new_from_array([8; 32]),
                &instructions,
                &[address(2), address(3)],
                invalid
            )
            .unwrap_err(),
            Error::InvalidBudget
        );
    }
    instructions[0].data = vec![1; 4096];
    assert_eq!(
        compile(
            address(9),
            Hash::new_from_array([8; 32]),
            &instructions,
            &[address(2), address(3)],
            budget()
        )
        .unwrap_err(),
        Error::TooLarge
    );
    instructions[0].data.clear();
    instructions[0]
        .accounts
        .extend((20..90).map(|id| AccountMeta::new_readonly(address(id), false)));
    assert_eq!(
        compile(
            address(9),
            Hash::new_from_array([8; 32]),
            &instructions,
            &[address(2), address(3)],
            budget()
        )
        .unwrap_err(),
        Error::AccountLimit
    );
}

#[test]
fn only_valid_signature_over_exact_compiled_message_is_attached() {
    use ed25519_dalek::{Signer, SigningKey};
    let key = SigningKey::from_bytes(&[11; 32]);
    let operator = Address::new_from_array(key.verifying_key().to_bytes());
    let basic = BasicAccounts::derive(address(2), 2, [6; 32]);
    let ix = basic.publish(operator, &publication()).unwrap();
    let tx = compile(
        operator,
        Hash::new_from_array([8; 32]),
        &[ix],
        &[address(2)],
        budget(),
    )
    .unwrap();
    let signature = key.sign(&tx.message).to_bytes();
    let signed = tx.with_signature(operator, signature).unwrap();
    assert_eq!(&signed[tx.message.len()..], &signature);
    assert_eq!(&signed[..tx.message.len()], &tx.message);
    assert_eq!(
        tx.with_signature(operator, [0; 64]),
        Err(Error::InvalidSignature)
    );
    let outsider = SigningKey::from_bytes(&[12; 32]);
    assert_eq!(
        tx.with_signature(
            Address::new_from_array(outsider.verifying_key().to_bytes()),
            outsider.sign(&tx.message).to_bytes()
        ),
        Err(Error::InvalidSignature)
    );
    let mut altered = tx.clone();
    altered.unsigned_transaction[50] ^= 1;
    assert_eq!(
        altered.with_signature(operator, signature),
        Err(Error::InvalidSignature)
    );
}

#[test]
fn permissionless_round_preparation_and_empty_finalization_match_program_abi() {
    use anchor_lang::{prelude::Pubkey, InstructionData, ToAccountMetas};
    let epoch = EpochAccounts::derive(address(3), address(4), 1_800_000_000).unwrap();
    let pk = |value: Address| Pubkey::new_from_array(value.to_bytes());
    let registry = address(5);
    let version = address(6);
    let methodology = address(7);
    let payer = address(9);
    let initialize = epoch.initialize_current(
        payer,
        registry,
        version,
        methodology,
        address(10),
        address(11),
        1_800_000_000,
    );
    assert_eq!(
        initialize.data,
        relative_epoch::instruction::InitializeCurrentEpoch {
            opens_at: 1_800_000_000
        }
        .data()
    );
    let expected = relative_epoch::accounts::InitializeCurrentEpoch {
        payer: pk(payer),
        config: pk(epoch.config),
        asset_registry: pk(registry),
        registry_version: pk(version),
        methodology: pk(methodology),
        mint: pk(address(10)),
        test_mint: pk(address(11)),
        epoch: pk(epoch.epoch),
        vault: pk(epoch.vault),
        test_vault: pk(epoch.test_vault),
        token_program: anchor_spl::token::ID,
        system_program: anchor_lang::system_program::ID,
    }
    .to_account_metas(None);
    assert_eq!(
        initialize
            .accounts
            .iter()
            .map(|a| (a.pubkey.to_bytes(), a.is_signer, a.is_writable))
            .collect::<Vec<_>>(),
        expected
            .iter()
            .map(|a| (a.pubkey.to_bytes(), a.is_signer, a.is_writable))
            .collect::<Vec<_>>()
    );
    let steps = [
        (
            "grow_current_epoch",
            (relative_epoch::MAX_GROWTH as u32).to_le_bytes().to_vec(),
            relative_epoch::instruction::GrowCurrentEpoch {
                additional_bytes: relative_epoch::MAX_GROWTH as u32,
            }
            .data(),
        ),
        (
            "copy_registry_assets",
            [16u16.to_le_bytes(), 15u16.to_le_bytes()].concat(),
            relative_epoch::instruction::CopyRegistryAssets {
                start: 16,
                count: 15,
            }
            .data(),
        ),
        (
            "seal_current_epoch",
            vec![],
            relative_epoch::instruction::SealCurrentEpoch {}.data(),
        ),
    ];
    let expected = relative_epoch::accounts::ManageCurrentEpochDraft {
        payer: pk(payer),
        config: pk(epoch.config),
        asset_registry: pk(registry),
        registry_version: pk(version),
        methodology: pk(methodology),
        epoch: pk(epoch.epoch),
        system_program: anchor_lang::system_program::ID,
    }
    .to_account_metas(None);
    for (name, args, data) in steps {
        let instruction = epoch.manage_current(payer, registry, version, methodology, name, &args);
        assert_eq!(instruction.data, data);
        assert_eq!(
            instruction
                .accounts
                .iter()
                .map(|a| (a.pubkey.to_bytes(), a.is_signer, a.is_writable))
                .collect::<Vec<_>>(),
            expected
                .iter()
                .map(|a| (a.pubkey.to_bytes(), a.is_signer, a.is_writable))
                .collect::<Vec<_>>()
        );
        compile(
            payer,
            Hash::new_from_array([8; 32]),
            &[instruction],
            &[epoch.program],
            budget(),
        )
        .unwrap();
    }
    assert_eq!(
        epoch.finalize_empty().data,
        relative_epoch::instruction::FinalizeEmpty {}.data()
    );
    assert!(epoch
        .finalize_empty()
        .accounts
        .iter()
        .all(|account| !account.is_signer));
}
