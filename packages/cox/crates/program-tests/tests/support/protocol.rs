use super::*;
use cox::{
    accounts as a, instruction as i, Batch, ManifestConfig, Pool, Position, PriceWire, Request,
};
use solana_sdk::system_program;

pub struct PoolHarness {
    pub h: Harness,
    pub registry: Pubkey,
    pub methodology: Pubkey,
    pub pool: Pubkey,
    pub vault: Pubkey,
    pub roster: Vec<u8>,
    pub secondary: Option<(Pubkey, Pubkey, Pubkey)>,
}

impl PoolHarness {
    pub fn new(count: usize) -> Self {
        Self::new_mode(count, false)
    }
    pub fn new_adaptive(count: usize) -> Self {
        Self::new_mode(count, true)
    }
    fn new_mode(count: usize, adaptive: bool) -> Self {
        Self::new_prepared(count, adaptive, ORIGIN, ORIGIN)
    }
    pub fn new_adaptive_scheduled(count: usize, opens_at: u64, prepared_at: u64) -> Self {
        Self::new_prepared(count, true, opens_at, prepared_at)
    }
    pub fn new_adaptive_dual(count: usize) -> Self {
        Self::new_prepared_collateral(count, true, ORIGIN, ORIGIN, true)
    }
    fn new_prepared(count: usize, adaptive: bool, opens_at: u64, prepared_at: u64) -> Self {
        Self::new_prepared_collateral(count, adaptive, opens_at, prepared_at, false)
    }
    fn new_prepared_collateral(
        count: usize,
        adaptive: bool,
        opens_at: u64,
        prepared_at: u64,
        dual: bool,
    ) -> Self {
        let mut h = Harness::new();
        let registry = pda(&[b"registry"]);
        let admin = h.admin.insecure_clone();
        let runtime = h.runtime.pubkey();
        let upgrade = h.upgrade.insecure_clone();
        h.send(
            "initialize_registry",
            &[Harness::instruction(
                a::InitializeRegistry {
                    admin: admin.pubkey(),
                    registry,
                    system_program: system_program::ID,
                    upgrade_authority: upgrade.pubkey(),
                    program_account: cox::ID,
                    program_data: h.program_data,
                },
                i::InitializeRegistry { runtime },
            )],
            &[&admin, &upgrade],
            true,
        );
        let config = ManifestConfig {
            version: "test-v1".into(),
            roster: (0..count as u8).collect(),
            origin: ORIGIN,
            bybit: false,
            feed_check_digest: [42; 32],
        };
        let adaptive_config = cox::AdaptiveManifestConfig {
            version: "relative-adaptive-v1".into(),
            roster: config.roster.clone(),
            pyth_feed_ids: config.roster.iter().map(|id| u32::from(*id) + 1).collect(),
            origin: config.origin,
            origin_prices: vec![100_000_000; count],
            universe_digest: [43; 32],
            feed_check_digest: config.feed_check_digest,
            max_price_age_ms: 5_000,
            max_feed_age_ms: 60_000,
        };
        let canonical = if adaptive {
            cox::canonical_adaptive_manifest(&adaptive_config, runtime).unwrap()
        } else {
            cox::canonical_manifest(&config, runtime).unwrap()
        };
        let digest = cox_math::artifact_digest(&canonical);
        let methodology = pda(&[b"methodology", &digest]);
        h.send(
            "register_methodology",
            &[Harness::instruction(
                a::RegisterMethodology {
                    admin: admin.pubkey(),
                    registry,
                    methodology,
                    system_program: system_program::ID,
                },
                i::RegisterMethodology {
                    digest,
                    length: canonical.len() as u32,
                    activation_batch: 0,
                },
            )],
            &[&admin],
            true,
        );
        for (index, bytes) in canonical.chunks(600).enumerate() {
            h.send(
                "upload_methodology",
                &[Harness::instruction(
                    a::ManageMethodology {
                        admin: admin.pubkey(),
                        registry,
                        methodology,
                    },
                    i::UploadMethodology {
                        offset: (index * 600) as u32,
                        bytes: bytes.to_vec(),
                    },
                )],
                &[&admin],
                true,
            );
        }
        let seal_accounts = a::ManageMethodology {
            admin: admin.pubkey(),
            registry,
            methodology,
        };
        let seal = if adaptive {
            Harness::instruction(
                seal_accounts,
                i::SealAdaptiveMethodology {
                    config: adaptive_config,
                },
            )
        } else {
            Harness::instruction(
                seal_accounts,
                i::SealMethodology {
                    config: config.clone(),
                },
            )
        };
        h.send("seal_methodology", &[seal], &[&admin], true);
        let pool = pda(&[b"pool", &0u64.to_le_bytes()]);
        let vault = pda(&[b"vault", pool.as_ref()]);
        let initialize_accounts = a::InitializePool {
            test_vault: None,
            admin: admin.pubkey(),
            registry,
            methodology,
            pool,
            mint: h.mint,
            vault,
            token_program: token_program(),
            system_program: system_program::ID,
        };
        let initialize_instruction = if adaptive {
            Harness::instruction(
                initialize_accounts,
                i::InitializeAdaptivePool {
                    pool_id: 0,
                    trading_opens_at: opens_at,
                },
            )
        } else {
            Harness::instruction(initialize_accounts, i::InitializePool { pool_id: 0 })
        };
        h.send(
            "initialize_pool",
            &[initialize_instruction],
            &[&admin],
            true,
        );
        let mut result = Self {
            h,
            registry,
            methodology,
            pool,
            vault,
            roster: config.roster,
            secondary: None,
        };
        if dual {
            result.configure_secondary(true);
        }
        if adaptive {
            result.h.time(prepared_at);
            result.publish_adaptive(0, vec![100_000_000; count], 100 * cox_math::SCALE, true);
        } else {
            result.publish(0, vec![100_000_000; count]);
        }
        result.seal_evaluation();
        result.finalize();
        result.assert_vault();
        result
    }

    pub fn configure_secondary(&mut self, success: bool) {
        let secondary = self.h.create_secondary_collateral();
        let admin = self.h.admin.insecure_clone();
        let test_vault = pda(&[b"test-vault", self.pool.as_ref()]);
        self.h.send(
            "initialize_devnet_collateral",
            &[Harness::instruction(
                a::InitializeDevnetCollateral {
                    admin: admin.pubkey(),
                    registry: self.registry,
                    pool: self.pool,
                    test_mint: secondary.0,
                    vault: self.vault,
                    test_vault,
                    token_program: token_program(),
                    system_program: system_program::ID,
                },
                i::InitializeDevnetCollateral {},
            )],
            &[&admin],
            success,
        );
        if success {
            self.secondary = Some(secondary);
        }
    }
    pub fn test_vault(&self) -> Option<Pubkey> {
        self.pool_state()
            .test_collateral_mint
            .map(|_| pda(&[b"test-vault", self.pool.as_ref()]))
    }
    pub fn pool_state(&self) -> Pool {
        self.h.read(self.pool)
    }
    pub fn position(&self, owner: Pubkey) -> Pubkey {
        pda(&[b"position", self.pool.as_ref(), owner.as_ref()])
    }
    pub fn request(&self, nonce: u64) -> Pubkey {
        pda(&[b"request", self.pool.as_ref(), &nonce.to_le_bytes()])
    }
    pub fn batch(&self) -> Pubkey {
        self.pool_state().stage.expect("active batch")
    }
    pub fn batch_state(&self) -> Batch {
        self.h.read(self.batch())
    }
    pub fn assert_vault(&self) {
        let pool = self.pool_state();
        assert_eq!(
            self.h.token_balance(self.vault)
                + self
                    .test_vault()
                    .map(|key| self.h.token_balance(key))
                    .unwrap_or(0),
            pool.active + pool.pending + pool.payable + pool.residual + pool.fees
        );
        assert_eq!(
            pool.active,
            pool.classes.iter().map(|class| class.backing).sum::<u64>()
        );
    }
    pub fn materialize(&mut self, owner: Pubkey) -> Position {
        let admin = self.h.admin.insecure_clone();
        self.h.send(
            "materialize_position",
            &[Harness::instruction(
                a::MaterializePosition {
                    test_vault: self.test_vault(),
                    pool: self.pool,
                    position: self.position(owner),
                    vault: self.vault,
                },
                i::MaterializePosition {},
            )],
            &[&admin],
            true,
        );
        self.assert_vault();
        self.h.read(self.position(owner))
    }
    pub fn assert_owners(&mut self, owners: &[Pubkey]) {
        let pool = self.pool_state();
        assert!(pool.stage.is_none());
        let mut units = vec![0u128; pool.classes.len()];
        let mut payable = 0u64;
        let mut refundable = 0u64;
        for owner in owners {
            let position = self.materialize(*owner);
            for (sum, class) in units.iter_mut().zip(&position.classes) {
                assert!(class.locked <= class.units);
                *sum += class.units;
            }
            payable += position.payable;
            refundable += position.refundable;
        }
        assert_eq!(
            units,
            pool.classes
                .iter()
                .map(|class| class.units)
                .collect::<Vec<_>>()
        );
        assert_eq!(payable, pool.payable);
        assert!(refundable <= pool.pending);
        self.assert_vault();
    }

    pub fn submit_accounts(&self, owner: Pubkey, user_token: Pubkey) -> a::Submit {
        a::Submit {
            test_vault: self.test_vault(),
            owner,
            registry: self.registry,
            pool: self.pool,
            position: self.position(owner),
            request: self.request(self.pool_state().next_request_nonce),
            vault: self.vault,
            user_token,
            token_program: token_program(),
            system_program: system_program::ID,
        }
    }
    pub fn deposit(
        &mut self,
        bob: bool,
        to: u8,
        amount: u64,
        minimum_units: u128,
        expiry: u64,
        success: bool,
    ) -> Pubkey {
        let signer = if bob {
            self.h.bob.insecure_clone()
        } else {
            self.h.alice.insecure_clone()
        };
        let token = if bob {
            self.h.bob_token
        } else {
            self.h.alice_token
        };
        let accounts = self.submit_accounts(signer.pubkey(), token);
        let request = accounts.request;
        self.h.send(
            "deposit",
            &[Harness::instruction(
                accounts,
                i::Deposit {
                    to,
                    amount,
                    minimum_units,
                    expiry,
                },
            )],
            &[&signer],
            success,
        );
        self.assert_vault();
        request
    }
    pub fn redeem(
        &mut self,
        bob: bool,
        from: u8,
        units: u128,
        minimum_proceeds: u64,
        expiry: u64,
        success: bool,
    ) -> Pubkey {
        let signer = if bob {
            self.h.bob.insecure_clone()
        } else {
            self.h.alice.insecure_clone()
        };
        let token = if bob {
            self.h.bob_token
        } else {
            self.h.alice_token
        };
        let accounts = self.submit_accounts(signer.pubkey(), token);
        let request = accounts.request;
        self.h.send(
            "redeem",
            &[Harness::instruction(
                accounts,
                i::Redeem {
                    from,
                    units,
                    minimum_proceeds,
                    expiry,
                },
            )],
            &[&signer],
            success,
        );
        self.assert_vault();
        request
    }
    pub fn switch(
        &mut self,
        from: u8,
        to: u8,
        units: u128,
        minimum_units: u128,
        expiry: u64,
        success: bool,
    ) -> Pubkey {
        let signer = self.h.alice.insecure_clone();
        let accounts = self.submit_accounts(signer.pubkey(), self.h.alice_token);
        let request = accounts.request;
        self.h.send(
            "switch",
            &[Harness::instruction(
                accounts,
                i::Switch {
                    from,
                    to,
                    units,
                    minimum_units,
                    expiry,
                },
            )],
            &[&signer],
            success,
        );
        self.assert_vault();
        request
    }
    pub fn publish(&mut self, batch_id: u64, values: Vec<u64>) {
        self.try_publish(batch_id, values, true)
    }
    pub fn try_publish(&mut self, batch_id: u64, values: Vec<u64>, success: bool) {
        self.try_publish_sequence(batch_id, values, None, success);
    }
    pub fn try_publish_sequence(
        &mut self,
        batch_id: u64,
        values: Vec<u64>,
        sequence_override: Option<u64>,
        success: bool,
    ) {
        let cutoff = ORIGIN + batch_id * 60;
        let state = self.pool_state();
        let sequence = if state.initialized {
            state.sequence + 1
        } else {
            0
        };
        let sequence = sequence_override.unwrap_or(sequence);
        let prices = values
            .iter()
            .map(|value| PriceWire {
                price_e8: *value,
                venue: 0,
                step: 1,
                candle_start: cutoff - 60,
                trade_age_minutes: 0,
            })
            .collect::<Vec<_>>();
        let full = prices
            .iter()
            .zip(&self.roster)
            .map(|(wire, index)| cox_math::Price {
                asset_id: cox::IDS[*index as usize].into(),
                price_e8: wire.price_e8,
                venue: wire.venue,
                step: wire.step,
                candle_start: wire.candle_start,
                trade_age_minutes: wire.trade_age_minutes,
            })
            .collect::<Vec<_>>();
        let roster = self
            .roster
            .iter()
            .map(|index| cox::IDS[*index as usize].to_owned())
            .collect::<Vec<_>>();
        let snapshot =
            cox_math::artifact_digest(&cox_math::snapshot_bytes(cutoff, &full, &roster).unwrap());
        let runtime = self.h.runtime.insecure_clone();
        let batch = pda(&[b"batch", self.pool.as_ref()]);
        self.h.send(
            "publish",
            &[Harness::instruction(
                a::Publish {
                    test_vault: self.test_vault(),
                    payer: runtime.pubkey(),
                    runtime: runtime.pubkey(),
                    registry: self.registry,
                    pool: self.pool,
                    methodology: self.methodology,
                    batch,
                    vault: self.vault,
                    system_program: system_program::ID,
                },
                i::Publish {
                    batch_id,
                    sequence,
                    predecessor: state.state_digest,
                    prices,
                    snapshot,
                    archive_time: cutoff,
                },
            )],
            &[&runtime],
            success,
        );
        self.assert_vault();
    }
    pub fn publish_adaptive(
        &mut self,
        batch_id: u64,
        values: Vec<u64>,
        benchmark: i128,
        success: bool,
    ) {
        let timestamp = ORIGIN + batch_id;
        let prices = values
            .into_iter()
            .map(|price_e8| PriceWire {
                price_e8,
                venue: 3,
                step: 0,
                candle_start: timestamp,
                trade_age_minutes: 0,
            })
            .collect::<Vec<_>>();
        let snapshot = cox_math::artifact_digest(
            &cox::adaptive_snapshot_bytes(timestamp, benchmark, &self.roster, &prices).unwrap(),
        );
        self.try_adaptive_wire(batch_id, prices, benchmark, snapshot, None, success);
    }
    pub fn try_adaptive_wire(
        &mut self,
        batch_id: u64,
        prices: Vec<PriceWire>,
        benchmark: i128,
        snapshot: [u8; 32],
        runtime_override: Option<&Keypair>,
        success: bool,
    ) {
        let state = self.pool_state();
        let runtime = runtime_override
            .map(|key| key.insecure_clone())
            .unwrap_or_else(|| self.h.runtime.insecure_clone());
        let instruction = Harness::instruction(
            a::Publish {
                test_vault: self.test_vault(),
                payer: runtime.pubkey(),
                runtime: runtime.pubkey(),
                registry: self.registry,
                pool: self.pool,
                methodology: self.methodology,
                batch: pda(&[b"batch", self.pool.as_ref()]),
                vault: self.vault,
                system_program: system_program::ID,
            },
            i::PublishAdaptive {
                batch_id,
                sequence: if state.initialized {
                    state.sequence + 1
                } else {
                    0
                },
                predecessor: state.state_digest,
                prices,
                snapshot,
                archive_time: ORIGIN + batch_id,
                benchmark,
            },
        );
        self.h
            .send("publish_adaptive", &[instruction], &[&runtime], success);
        self.assert_vault();
    }
    pub fn process_accounts(&self, nonce: u64) -> a::Process {
        let request_key = self.request(nonce);
        let request: Request = self.h.read(request_key);
        a::Process {
            test_vault: self.test_vault(),
            registry: self.registry,
            pool: self.pool,
            batch: self.batch(),
            request: request_key,
            position: self.position(request.owner),
            vault: self.vault,
        }
    }
    pub fn evaluate(&mut self, nonce: u64, success: bool) {
        let admin = self.h.admin.insecure_clone();
        self.h.send(
            "evaluate",
            &[Harness::instruction(
                self.process_accounts(nonce),
                i::Evaluate {},
            )],
            &[&admin],
            success,
        );
        self.assert_vault();
    }
    pub fn seal_evaluation(&mut self) {
        let admin = self.h.admin.insecure_clone();
        loop {
            self.h.send(
                "seal_evaluation",
                &[Harness::instruction(
                    a::BatchOnly {
                        test_vault: self.test_vault(),
                        registry: self.registry,
                        pool: self.pool,
                        batch: self.batch(),
                        vault: self.vault,
                    },
                    i::SealEvaluation {},
                )],
                &[&admin],
                true,
            );
            let batch = self.batch_state();
            if batch.phase == 1 {
                break;
            }
            assert_eq!(batch.phase, 3);
            for nonce in batch.queue_start..batch.closed_queue_end {
                self.h.send(
                    "safety",
                    &[Harness::instruction(
                        self.process_accounts(nonce),
                        i::Safety {},
                    )],
                    &[&admin],
                    true,
                );
            }
        }
        self.assert_vault();
    }
    pub fn execute(&mut self, nonce: u64, success: bool) {
        let admin = self.h.admin.insecure_clone();
        self.h.send(
            "execute",
            &[Harness::instruction(
                self.process_accounts(nonce),
                i::Execute {},
            )],
            &[&admin],
            success,
        );
        self.assert_vault();
    }
    pub fn finalize(&mut self) {
        let admin = self.h.admin.insecure_clone();
        self.h.send(
            "finalize",
            &[Harness::instruction(
                a::Finalize {
                    test_vault: self.test_vault(),
                    payer: admin.pubkey(),
                    registry: self.registry,
                    pool: self.pool,
                    batch: self.batch(),
                    methodology: self.methodology,
                    publication: pda(&[b"publication", self.pool.as_ref()]),
                    vault: self.vault,
                    system_program: system_program::ID,
                },
                i::Finalize {},
            )],
            &[&admin],
            true,
        );
        self.assert_vault();
    }
    pub fn finish(&mut self) {
        let batch = self.batch_state();
        for nonce in batch.queue_start..batch.closed_queue_end {
            self.evaluate(nonce, true);
        }
        self.seal_evaluation();
        for nonce in batch.queue_start..batch.closed_queue_end {
            self.execute(nonce, true);
        }
        self.finalize();
    }
    pub fn withdraw(&mut self, bob: bool, amount: u64, success: bool) {
        let signer = if bob {
            self.h.bob.insecure_clone()
        } else {
            self.h.alice.insecure_clone()
        };
        let token = if bob {
            self.h.bob_token
        } else {
            self.h.alice_token
        };
        self.h.send(
            "withdraw",
            &[Harness::instruction(
                a::Withdraw {
                    test_vault: self.test_vault(),
                    owner: signer.pubkey(),
                    registry: self.registry,
                    pool: self.pool,
                    position: self.position(signer.pubkey()),
                    vault: self.vault,
                    user_token: token,
                    token_program: token_program(),
                },
                i::Withdraw { amount },
            )],
            &[&signer],
            success,
        );
        self.assert_vault();
    }
    pub fn cancel(&mut self, nonce: u64, bob: bool, success: bool) {
        let request: Request = self.h.read(self.request(nonce));
        let signer = if bob {
            self.h.bob.insecure_clone()
        } else {
            self.h.alice.insecure_clone()
        };
        self.h.send(
            "cancel",
            &[Harness::instruction(
                a::ManageRequest {
                    test_vault: self.test_vault(),
                    authority: signer.pubkey(),
                    registry: self.registry,
                    pool: self.pool,
                    request: self.request(nonce),
                    position: self.position(request.owner),
                    vault: self.vault,
                },
                i::Cancel {},
            )],
            &[&signer],
            success,
        );
        self.assert_vault();
    }
    pub fn refund(&mut self, nonce: u64, bob: bool, success: bool) {
        let signer = if bob {
            self.h.bob.insecure_clone()
        } else {
            self.h.alice.insecure_clone()
        };
        let token = if bob {
            self.h.bob_token
        } else {
            self.h.alice_token
        };
        self.h.send(
            "refund",
            &[Harness::instruction(
                a::Refund {
                    test_vault: self.test_vault(),
                    owner: signer.pubkey(),
                    registry: self.registry,
                    pool: self.pool,
                    request: self.request(nonce),
                    position: self.position(signer.pubkey()),
                    vault: self.vault,
                    user_token: token,
                    token_program: token_program(),
                },
                i::Refund {},
            )],
            &[&signer],
            success,
        );
        self.assert_vault();
    }
    pub fn pause(&mut self, paused: bool) {
        let admin = self.h.admin.insecure_clone();
        let accounts = a::Admin {
            admin: admin.pubkey(),
            registry: self.registry,
        };
        let instruction = if paused {
            Harness::instruction(accounts, i::Pause {})
        } else {
            Harness::instruction(accounts, i::Unpause {})
        };
        self.h.send("pause_change", &[instruction], &[&admin], true);
    }
}
