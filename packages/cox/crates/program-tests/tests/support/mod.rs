use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_sdk::{
    clock::Clock,
    instruction::{AccountMeta, Instruction},
    message::Message,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction,
    transaction::Transaction,
};
use std::{collections::BTreeSet, str::FromStr};

pub const COLLATERAL: u64 = 10_000_000_000;
pub const ORIGIN: u64 = 120_000;

pub fn token_program() -> Pubkey {
    Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap()
}

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &cox::ID).0
}

#[derive(Clone, Debug)]
pub struct Measurement {
    pub instruction: String,
    pub transaction_bytes: usize,
    pub compute_units: u64,
}

pub struct Harness {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub upgrade: Keypair,
    pub program_data: Pubkey,
    pub runtime: Keypair,
    pub alice: Keypair,
    pub bob: Keypair,
    pub mint: Pubkey,
    pub alice_token: Pubkey,
    pub bob_token: Pubkey,
    pub measurements: Vec<Measurement>,
    tracked: BTreeSet<Pubkey>,
}

impl Harness {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let path = std::env::var("COX_PROGRAM_SO").unwrap_or_else(|_| {
            format!("{}/../../target/deploy/cox.so", env!("CARGO_MANIFEST_DIR"))
        });
        let program = std::fs::read(&path)
            .unwrap_or_else(|error| panic!("SBF artifact {path}: {error}; build it first"));
        svm.add_program(cox::ID, &program);
        let admin = Keypair::new();
        let upgrade = Keypair::new();
        let loader = solana_sdk::bpf_loader_upgradeable::ID;
        let program_data = Pubkey::find_program_address(&[cox::ID.as_ref()], &loader).0;
        let mut program_bytes = 2u32.to_le_bytes().to_vec();
        program_bytes.extend(program_data.to_bytes());
        let mut metadata = 3u32.to_le_bytes().to_vec();
        metadata.extend(0u64.to_le_bytes());
        metadata.push(1);
        metadata.extend(upgrade.pubkey().to_bytes());
        metadata.extend_from_slice(&program);
        svm.set_account(
            program_data,
            solana_sdk::account::Account {
                lamports: 10_000_000,
                data: metadata,
                owner: loader,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
        svm.set_account(
            cox::ID,
            solana_sdk::account::Account {
                lamports: 10_000_000,
                data: program_bytes,
                owner: loader,
                executable: true,
                rent_epoch: 0,
            },
        )
        .unwrap();

        let runtime = Keypair::new();
        let alice = Keypair::new();
        let bob = Keypair::new();
        for signer in [&admin, &upgrade, &runtime, &alice, &bob] {
            svm.airdrop(&signer.pubkey(), 100_000_000_000).unwrap();
        }
        let mut harness = Self {
            svm,
            admin,
            upgrade,
            program_data,
            runtime,
            alice,
            bob,
            mint: Pubkey::default(),
            alice_token: Pubkey::default(),
            bob_token: Pubkey::default(),
            measurements: vec![],
            tracked: BTreeSet::new(),
        };
        harness.time(ORIGIN);
        harness.create_collateral();
        harness
    }

    pub fn time(&mut self, timestamp: u64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = timestamp.try_into().unwrap();
        self.svm.set_sysvar(&clock);
    }

    pub fn read<T: AccountDeserialize>(&self, key: Pubkey) -> T {
        let account = self.svm.get_account(&key).expect("account exists");
        assert_eq!(account.owner, cox::ID);
        T::try_deserialize(&mut &account.data[..]).unwrap()
    }

    pub fn token_balance(&self, key: Pubkey) -> u64 {
        let account = self.svm.get_account(&key).expect("token account exists");
        assert_eq!(account.owner, token_program());
        u64::from_le_bytes(account.data[64..72].try_into().unwrap())
    }

    pub fn instruction<A: ToAccountMetas, D: InstructionData>(accounts: A, data: D) -> Instruction {
        Instruction {
            program_id: cox::ID,
            accounts: accounts.to_account_metas(None),
            data: data.data(),
        }
    }

    pub fn send(
        &mut self,
        name: &str,
        instructions: &[Instruction],
        signers: &[&Keypair],
        success: bool,
    ) {
        for instruction in instructions {
            self.tracked
                .extend(instruction.accounts.iter().map(|meta| meta.pubkey));
        }
        self.tracked
            .extend(signers.iter().map(|signer| signer.pubkey()));
        self.svm.expire_blockhash();
        let payer = signers[0].pubkey();
        let mut budgeted = vec![
            solana_sdk::compute_budget::ComputeBudgetInstruction::set_compute_unit_limit(1_400_000),
            solana_sdk::compute_budget::ComputeBudgetInstruction::set_compute_unit_price(1),
        ];
        if name == "seal_methodology" {
            budgeted.push(
                solana_sdk::compute_budget::ComputeBudgetInstruction::request_heap_frame(262_144),
            );
        }
        budgeted.extend_from_slice(instructions);
        let tx = Transaction::new(
            signers,
            Message::new(&budgeted, Some(&payer)),
            self.svm.latest_blockhash(),
        );
        let bytes = bincode::serialize(&tx).unwrap().len();
        assert!(bytes <= 1232, "{name} exceeds packet size: {bytes}");
        let result = self.svm.send_transaction(tx);
        if success {
            let metadata = result.unwrap_or_else(|error| panic!("{name}: {error:?}"));
            self.measurements.push(Measurement {
                instruction: name.to_owned(),
                transaction_bytes: bytes,
                compute_units: metadata.compute_units_consumed,
            });
        } else {
            assert!(result.is_err(), "{name} should have been rejected");
        }
    }

    pub fn create_secondary_collateral(&mut self) -> (Pubkey, Pubkey, Pubkey) {
        let saved = (self.mint, self.alice_token, self.bob_token);
        self.create_collateral();
        let created = (self.mint, self.alice_token, self.bob_token);
        (self.mint, self.alice_token, self.bob_token) = saved;
        created
    }
    fn create_collateral(&mut self) {
        let mint = Keypair::new();
        let alice_token = Keypair::new();
        let bob_token = Keypair::new();
        let rent = self.svm.minimum_balance_for_rent_exemption(82);
        let mut initialize = vec![20, 6];
        initialize.extend(self.admin.pubkey().to_bytes());
        initialize.push(0);
        let admin = self.admin.insecure_clone();
        self.send(
            "create_mint",
            &[
                system_instruction::create_account(
                    &admin.pubkey(),
                    &mint.pubkey(),
                    rent,
                    82,
                    &token_program(),
                ),
                Instruction {
                    program_id: token_program(),
                    accounts: vec![AccountMeta::new(mint.pubkey(), false)],
                    data: initialize,
                },
            ],
            &[&admin, &mint],
            true,
        );
        for (account, owner) in [
            (&alice_token, self.alice.pubkey()),
            (&bob_token, self.bob.pubkey()),
        ] {
            let mut initialize = vec![18];
            initialize.extend(owner.to_bytes());
            let mut mint_data = vec![7];
            mint_data.extend(COLLATERAL.to_le_bytes());
            self.send(
                "create_token_account",
                &[
                    system_instruction::create_account(
                        &admin.pubkey(),
                        &account.pubkey(),
                        self.svm.minimum_balance_for_rent_exemption(165),
                        165,
                        &token_program(),
                    ),
                    Instruction {
                        program_id: token_program(),
                        accounts: vec![
                            AccountMeta::new(account.pubkey(), false),
                            AccountMeta::new_readonly(mint.pubkey(), false),
                        ],
                        data: initialize,
                    },
                    Instruction {
                        program_id: token_program(),
                        accounts: vec![
                            AccountMeta::new(mint.pubkey(), false),
                            AccountMeta::new(account.pubkey(), false),
                            AccountMeta::new_readonly(admin.pubkey(), true),
                        ],
                        data: mint_data,
                    },
                ],
                &[&admin, account],
                true,
            );
        }
        self.mint = mint.pubkey();
        self.alice_token = alice_token.pubkey();
        self.bob_token = bob_token.pubkey();
        assert_eq!(self.token_balance(self.alice_token), COLLATERAL);
        assert_eq!(self.token_balance(self.bob_token), COLLATERAL);
    }

    pub fn transfer(&mut self, source: Pubkey, destination: Pubkey, amount: u64, signer: &Keypair) {
        let mut data = vec![3];
        data.extend(amount.to_le_bytes());
        self.send(
            "spl_transfer",
            &[Instruction {
                program_id: token_program(),
                accounts: vec![
                    AccountMeta::new(source, false),
                    AccountMeta::new(destination, false),
                    AccountMeta::new_readonly(signer.pubkey(), true),
                ],
                data,
            }],
            &[signer],
            true,
        );
    }

    pub fn restart(&mut self) {
        let clock = self.svm.get_sysvar::<Clock>();
        let path = std::env::var("COX_PROGRAM_SO").unwrap_or_else(|_| {
            format!("{}/../../target/deploy/cox.so", env!("CARGO_MANIFEST_DIR"))
        });
        let mut restarted = LiteSVM::new();
        restarted.add_program(cox::ID, &std::fs::read(path).unwrap());
        restarted
            .set_account(
                self.program_data,
                self.svm.get_account(&self.program_data).unwrap(),
            )
            .unwrap();
        restarted
            .set_account(cox::ID, self.svm.get_account(&cox::ID).unwrap())
            .unwrap();
        for key in &self.tracked {
            if let Some(account) = self.svm.get_account(key) {
                if !account.executable {
                    restarted.set_account(*key, account).unwrap();
                }
            }
        }
        restarted.set_sysvar(&clock);
        self.svm = restarted;
    }

    pub fn write_accounts(&self, path: &std::path::Path, keys: &[(&str, Pubkey)]) {
        let accounts: Vec<_> = keys.iter().map(|(name, key)| {
            let account = self.svm.get_account(key).expect("fixture account exists");
            serde_json::json!({
                "name": name,
                "address": key.to_string(),
                "owner": account.owner.to_string(),
                "dataHex": account.data.iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
            })
        }).collect();
        let fixture = serde_json::json!({"schema": "cox.compiled-account-fixtures/v1", "programAddress": cox::ID.to_string(), "accounts": accounts});
        std::fs::write(path, serde_json::to_vec_pretty(&fixture).unwrap()).unwrap();
    }

    pub fn write_measurements(
        &self,
        path: &std::path::Path,
        requests: usize,
        elapsed_micros: u128,
    ) {
        let rows: Vec<_> = self
            .measurements
            .iter()
            .map(|measurement| {
                serde_json::json!({
                    "instruction": measurement.instruction,
                    "transactionBytes": measurement.transaction_bytes,
                    "computeUnits": measurement.compute_units,
                })
            })
            .collect();
        let artifact_path = std::env::var("COX_PROGRAM_SO").unwrap_or_else(|_| {
            format!("{}/../../target/deploy/cox.so", env!("CARGO_MANIFEST_DIR"))
        });
        let digest = cox_math::artifact_digest(&std::fs::read(&artifact_path).unwrap());
        let digest_hex = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let report = serde_json::json!({
            "schema": "cox.compiled-runtime-measurements/v1",
            "environment": "LiteSVM 0.6.1; compiled SBF; classic SPL token",
            "programAddress": cox::ID.to_string(),
            "programSha256": digest_hex,
            "assets": 30,
            "requests": requests,
            "elapsedMicros": elapsed_micros.to_string(),
            "timingScope": "Local simulation including setup and token transactions; not network throughput or confirmation latency",
            "maxTransactionBytes": self.measurements.iter().map(|row|row.transaction_bytes).max(),
            "maxComputeUnits": self.measurements.iter().map(|row|row.compute_units).max(),
            "transactions": rows,
        });
        std::fs::write(path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    }
}

pub mod protocol;
