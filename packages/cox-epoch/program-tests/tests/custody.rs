use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token::{self, state::{Account as SplAccount, AccountState, Mint}};
use cox_epoch::{Asset, LotState, Phase, Price, EPOCH_SECONDS, CLOSING_GRACE_SECONDS};
use litesvm::LiteSVM;
use relative_epoch::{accounts as a, instruction as i, EpochAccount, LotAccount};
use solana_sdk::{account::Account, clock::Clock, compute_budget::ComputeBudgetInstruction,
    instruction::Instruction, program_option::COption, program_pack::Pack, pubkey::Pubkey,
    signature::{Keypair, Signer}, system_program, transaction::Transaction};

const OPEN: u64 = 144_000;
const STAKE: u64 = 10_000_000;
fn pda(seeds: &[&[u8]]) -> Pubkey { Pubkey::find_program_address(seeds, &relative_epoch::ID).0 }
fn ix<A: ToAccountMetas, I: InstructionData>(accounts: A, data: I) -> Instruction {
    Instruction { program_id: relative_epoch::ID, accounts: accounts.to_account_metas(None), data: data.data() }
}
fn asset(id: u16) -> Asset { let mut feed_id=[0;32];feed_id[..2].copy_from_slice(&(id+1).to_le_bytes());Asset { id, feed_id, origin_price: 1_000 } }
fn prices(winner: u128) -> Vec<Price> { prices_count(winner,30) }
fn prices_count(winner: u128,count:u16) -> Vec<Price> { (0..count).map(|id| Price { asset_id: id, feed_id: asset(id).feed_id, value: if id == 0 { winner } else { 1_000 } }).collect() }

struct Harness {
    svm: LiteSVM, admin: Keypair, operator: Keypair, alice: Keypair, bob: Keypair,
    config: Pubkey, epoch: Pubkey, vault: Pubkey, test_vault: Pubkey, alice_token: Pubkey, bob_token: Pubkey, admin_token: Pubkey,
    alice_test_token: Pubkey, bob_test_token: Pubkey,
}
impl Harness {
    fn new() -> Self {
        Self::with_assets(30)
    }
    fn with_assets(asset_count:u16) -> Self {
        Self::with_collateral(asset_count,false)
    }
    fn with_collateral(asset_count:u16,dual:bool) -> Self {
        let mut svm = LiteSVM::new();
        let path = if dual { std::env::var("EPOCH_DEVNET_PROGRAM_SO").expect("build and select devnet-collateral artifact") }
            else { std::env::var("EPOCH_PROGRAM_SO").unwrap_or_else(|_| format!("{}/../target/sbpf-solana-solana/release/relative_epoch.so", env!("CARGO_MANIFEST_DIR"))) };
        svm.add_program(relative_epoch::ID, &std::fs::read(path).expect("build Epoch SBF artifact first"));
        let admin=Keypair::new(); let operator=Keypair::new(); let alice=Keypair::new(); let bob=Keypair::new();
        for key in [&admin,&operator,&alice,&bob] { svm.airdrop(&key.pubkey(), 5_000_000_000).unwrap(); }
        let config=pda(&[b"config",admin.pubkey().as_ref(),&0u64.to_le_bytes()]);
        let epoch=pda(&[b"epoch",config.as_ref(),&OPEN.to_le_bytes()]);
        let vault=pda(&[b"vault",epoch.as_ref()]); let test_vault=pda(&[b"test-vault",epoch.as_ref()]); let mint=Pubkey::new_unique();
        let alice_token=Pubkey::new_unique(); let bob_token=Pubkey::new_unique(); let admin_token=Pubkey::new_unique();
        let test_mint=if dual {Pubkey::new_unique()}else{mint};
        let alice_test_token=if dual {Pubkey::new_unique()}else{alice_token};
        let bob_test_token=if dual {Pubkey::new_unique()}else{bob_token};
        let mut data=vec![0;Mint::LEN]; Mint::pack(Mint { mint_authority:COption::Some(admin.pubkey()), supply:4*STAKE,
            decimals:6,is_initialized:true,freeze_authority:COption::None },&mut data).unwrap();
        svm.set_account(mint,Account {lamports:10_000_000,data,owner:spl_token::ID,executable:false,rent_epoch:0}).unwrap();
        if dual {let data=svm.get_account(&mint).unwrap();svm.set_account(test_mint,data).unwrap();}
        let mut wallets=vec![(alice_token,alice.pubkey(),2*STAKE,mint),(bob_token,bob.pubkey(),2*STAKE,mint),(admin_token,admin.pubkey(),0,mint)];
        if dual {wallets.extend([(alice_test_token,alice.pubkey(),2*STAKE,test_mint),(bob_test_token,bob.pubkey(),2*STAKE,test_mint)]);}
        for (address,owner,amount,token_mint) in wallets {
            let mut data=vec![0;SplAccount::LEN]; SplAccount::pack(SplAccount {mint:token_mint,owner,amount,delegate:COption::None,
                state:AccountState::Initialized,is_native:COption::None,delegated_amount:0,close_authority:COption::None},&mut data).unwrap();
            svm.set_account(address,Account {lamports:10_000_000,data,owner:spl_token::ID,executable:false,rent_epoch:0}).unwrap();
        }
        let mut h=Self {svm,admin,operator,alice,bob,config,epoch,vault,test_vault,alice_token,bob_token,admin_token,alice_test_token,bob_test_token};
        h.time(OPEN-10);
        let admin=h.admin.insecure_clone();
        if dual {
            h.send(ix(a::InitializeDevnetConfig {admin:admin.pubkey(),mint,test_mint,config,system_program:system_program::ID},i::InitializeDevnetConfig {
                config_id:0,operator:h.operator.pubkey(),methodology:[9;32],origin_benchmark:1_000,max_entry_price_age:3,max_lots:1000}),&admin,true);
        } else {
            h.send(ix(a::InitializeConfig {admin:admin.pubkey(),mint,config,system_program:system_program::ID},i::InitializeConfig {
                config_id:0,operator:h.operator.pubkey(),methodology:[9;32],origin_benchmark:1_000,max_entry_price_age:3,max_lots:1000}),&admin,true);
        }
        h.send(ix(a::InitializeEpoch {admin:admin.pubkey(),config,mint,test_mint,epoch,vault,test_vault,token_program:spl_token::ID,system_program:system_program::ID},i::InitializeEpoch {opens_at:OPEN}),&admin,true);
        while h.svm.get_account(&epoch).unwrap().data.len()<relative_epoch::EPOCH_SPACE {
            let growth=(relative_epoch::EPOCH_SPACE-h.svm.get_account(&epoch).unwrap().data.len()).min(relative_epoch::MAX_GROWTH);
            h.send(ix(h.draft(),i::GrowEpoch {additional_bytes:growth as u32}),&admin,true);
        }
        for chunk in (0..asset_count).map(asset).collect::<Vec<_>>().chunks(8) {h.send(ix(h.draft(),i::AppendUniverse {assets:chunk.to_vec()}),&admin,true);}
        h.send(ix(h.draft(),i::SealEpoch {}),&admin,true);h.time(OPEN);h
    }
    fn time(&mut self, timestamp:u64) {let mut clock=self.svm.get_sysvar::<Clock>();clock.unix_timestamp=timestamp as i64;self.svm.set_sysvar(&clock);}
    fn send(&mut self, instruction:Instruction, signer:&Keypair, success:bool) {
        self.send_many(vec![instruction],signer,success);
    }
    fn send_many(&mut self, instructions:Vec<Instruction>, signer:&Keypair, success:bool) {
        let mut all=vec![
            ComputeBudgetInstruction::set_compute_unit_limit(1_400_000),
            ComputeBudgetInstruction::request_heap_frame(relative_epoch::REQUIRED_HEAP_BYTES)];all.extend(instructions);
        let transaction=Transaction::new_signed_with_payer(&all,Some(&signer.pubkey()),&[signer],self.svm.latest_blockhash());
        let result=self.svm.send_transaction(transaction);
        assert_eq!(result.is_ok(),success,"{result:?}");
        if let Ok(meta)=result {
            assert!(meta.compute_units_consumed<=1_400_000);
            if all.len()>3 { eprintln!("combined Epoch transaction: {} instructions, {} compute units",all.len()-2,meta.compute_units_consumed); }
        }
        self.svm.expire_blockhash();
    }
    fn draft(&self)->a::ManageEpochDraft {a::ManageEpochDraft {admin:self.admin.pubkey(),config:self.config,epoch:self.epoch,system_program:system_program::ID}}
    fn lot(&self,nonce:u64)->Pubkey {pda(&[b"lot",self.epoch.as_ref(),&nonce.to_le_bytes()])}
    fn manage(&self,nonce:u64)->a::ManageLot {a::ManageLot {config:self.config,epoch:self.epoch,lot:self.lot(nonce),vault:self.vault,test_vault:self.test_vault}}
    fn settlement(&self)->a::ManageSettlement {a::ManageSettlement {config:self.config,epoch:self.epoch,vault:self.vault,test_vault:self.test_vault}}
    fn read<T:AccountDeserialize>(&self,address:Pubkey)->T {T::try_deserialize(&mut self.svm.get_account(&address).unwrap().data.as_slice()).unwrap()}
    fn closed(&self,address:Pubkey)->bool { self.svm.get_account(&address).is_none_or(|account|account.lamports==0&&account.data.is_empty()&&account.owner==system_program::ID) }
    fn balance(&self,address:Pubkey)->u64 {SplAccount::unpack(&self.svm.get_account(&address).unwrap().data).unwrap().amount}
    fn assert_vault(&self) {let epoch:EpochAccount=self.read(self.epoch);epoch.state.as_ref().unwrap().ledger().check(self.balance(self.vault)+self.balance(self.test_vault)).unwrap();}
    fn queue(&mut self,nonce:u64,backed:u16,bob:bool,success:bool) {
        self.queue_collateral(nonce,backed,bob,false,success)
    }
    fn queue_collateral(&mut self,nonce:u64,backed:u16,bob:bool,test_mint:bool,success:bool) {
        let owner=if bob {self.bob.insecure_clone()}else{self.alice.insecure_clone()};
        let source=match (bob,test_mint) {(false,false)=>self.alice_token,(true,false)=>self.bob_token,(false,true)=>self.alice_test_token,(true,true)=>self.bob_test_token};
        self.send(ix(a::Queue {owner:owner.pubkey(),config:self.config,epoch:self.epoch,lot:self.lot(nonce),source,vault:self.vault,test_vault:self.test_vault,
            token_program:spl_token::ID,system_program:system_program::ID},i::Queue {nonce,gross_stake:STAKE,basket:std::array::from_fn(|index|index as u16),backed_asset:backed}),&owner,success);
        self.assert_vault();
    }
    fn snapshot(&mut self,sequence:u64,timestamp:u64,winner:u128)->Pubkey {
        let count=self.read::<EpochAccount>(self.epoch).state.unwrap().universe().len() as u16;
        self.snapshot_with_count(sequence,timestamp,winner,count)
    }
    fn snapshot_with_count(&mut self,sequence:u64,timestamp:u64,winner:u128,count:u16)->Pubkey {
        let operator=self.operator.insecure_clone();let snapshot=pda(&[b"snapshot",self.config.as_ref(),&sequence.to_le_bytes()]);
        let config=self.config;
        let accounts=||a::ManageSnapshot {operator:operator.pubkey(),config,snapshot,system_program:system_program::ID};
        self.send(ix(a::InitializeSnapshot {operator:operator.pubkey(),config:self.config,snapshot,system_program:system_program::ID},i::InitializeSnapshot {sequence,oracle_timestamp:timestamp,benchmark:1_000,expected_prices:count}),&operator,true);
        let required=200+count as usize*50;
        while self.svm.get_account(&snapshot).unwrap().data.len()<required {
            let growth=(relative_epoch::SNAPSHOT_SPACE-self.svm.get_account(&snapshot).unwrap().data.len()).min(relative_epoch::MAX_GROWTH);
            self.send(ix(accounts(),i::GrowSnapshot {additional_bytes:growth as u32}),&operator,true);
        }
        for chunk in prices_count(winner,count).chunks(8) {self.send(ix(accounts(),i::AppendPrices {prices:chunk.to_vec()}),&operator,true);}
        self.send(ix(accounts(),i::SealSnapshot {}),&operator,true);snapshot
    }
    fn execute(&mut self,nonce:u64,snapshot:Pubkey,success:bool) {
        let operator=self.operator.insecure_clone();self.send(ix(a::Execute {operator:operator.pubkey(),config:self.config,epoch:self.epoch,lot:self.lot(nonce),vault:self.vault,test_vault:self.test_vault,snapshot},i::Execute {}),&operator,success);self.assert_vault();
    }
    fn close(&mut self,snapshot:Pubkey,success:bool) {let operator=self.operator.insecure_clone();self.send(ix(a::BeginClose {operator:operator.pubkey(),config:self.config,epoch:self.epoch,vault:self.vault,test_vault:self.test_vault,snapshot},i::BeginClose {}),&operator,success);self.assert_vault();}
    fn withdraw(&mut self,nonce:u64,bob:bool,success:bool) {
        self.withdraw_collateral(nonce,bob,false,success)
    }
    fn withdraw_collateral(&mut self,nonce:u64,bob:bool,test_mint:bool,success:bool) {
        let owner=if bob{self.bob.insecure_clone()}else{self.alice.insecure_clone()};
        let destination=match (bob,test_mint) {(false,false)=>self.alice_token,(true,false)=>self.bob_token,(false,true)=>self.alice_test_token,(true,true)=>self.bob_test_token};
        self.send(ix(a::Withdraw {owner:owner.pubkey(),config:self.config,epoch:self.epoch,lot:self.lot(nonce),vault:self.vault,test_vault:self.test_vault,destination,token_program:spl_token::ID},i::Withdraw {}),&owner,success);self.assert_vault();
    }
    fn fees(&mut self,amount:u64,success:bool) {
        let admin=self.admin.insecure_clone();
        self.send(ix(a::WithdrawFees {admin:admin.pubkey(),config:self.config,epoch:self.epoch,vault:self.vault,test_vault:self.test_vault,destination:self.admin_token,token_program:spl_token::ID},i::WithdrawFees {amount}),&admin,success);
        self.assert_vault();
    }
}

#[test]
fn compiled_custody_settles_candidate_formula_and_preserves_held_fees_and_owner_claims() {
    let mut h=Harness::new();h.queue(0,0,false,true);h.queue(1,1,true,true);
    let operator=h.operator.insecure_clone();h.withdraw(0,false,false);
    h.time(OPEN+1);let entry=h.snapshot(1,OPEN+1,1_000);h.execute(0,entry,true);h.execute(1,entry,true);
    h.execute(0,entry,false);h.withdraw(0,false,false);
    let epoch:EpochAccount=h.read(h.epoch);assert_eq!(epoch.state.unwrap().ledger().held_fees,4_000);h.fees(1,false);
    h.time(OPEN+EPOCH_SECONDS);let closing=h.snapshot(2,OPEN+EPOCH_SECONDS,1_100);h.close(closing,true);
    h.send(ix(h.settlement(),i::FinalizeScores {}),&operator,false);
    for nonce in 0..2 {h.send(ix(h.manage(nonce),i::Score {}),&operator,true);}
    h.send(ix(h.manage(0),i::Score {}),&operator,false);
    h.send(ix(h.settlement(),i::FinalizeScores {}),&operator,true);
    h.fees(1,false);
    h.send(ix(h.manage(1),i::Allocate {}),&operator,true);h.fees(1,false);
    h.send(ix(h.manage(0),i::Allocate {}),&operator,true);h.assert_vault();
    let winner:LotAccount=h.read(h.lot(0));assert_eq!(winner.state.unwrap().state(),&LotState::Claimable {amount:2*STAKE-4_000});
    let epoch:EpochAccount=h.read(h.epoch);assert_eq!(epoch.state.as_ref().unwrap().phase(),Phase::Settled);assert_eq!(epoch.state.unwrap().ledger().committed_fees,4_000);
    h.fees(4_001,false);h.fees(4_000,true);assert_eq!(h.balance(h.admin_token),4_000);
    h.withdraw(0,true,false);h.withdraw(0,false,true);h.withdraw(0,false,false);h.withdraw(1,true,true);
    assert_eq!(h.balance(h.vault),0);
}

#[test]
fn compiled_zero_scores_refund_gross_and_unexecuted_lots_refund_at_close() {
    let mut h=Harness::new();h.queue(0,0,false,true);h.queue(1,1,true,true);
    let operator=h.operator.insecure_clone();h.time(OPEN+1);let entry=h.snapshot(1,OPEN+1,1_000);h.execute(0,entry,true);
    h.time(OPEN+EPOCH_SECONDS);h.send(ix(h.manage(1),i::Refund {}),&operator,true);h.withdraw(1,true,true);
    let closing=h.snapshot(2,OPEN+EPOCH_SECONDS,1_000);h.close(closing,true);h.send(ix(h.manage(0),i::Score {}),&operator,true);
    h.send(ix(h.settlement(),i::FinalizeScores {}),&operator,true);h.send(ix(h.manage(0),i::Allocate {}),&operator,true);
    h.withdraw(0,false,true);assert_eq!(h.balance(h.vault),0);assert_eq!(h.balance(h.alice_token),2*STAKE);assert_eq!(h.balance(h.bob_token),2*STAKE);
}

#[test]
fn compiled_missing_close_voids_only_after_deadline_and_donations_remain_segregated() {
    let mut h=Harness::new();h.queue(0,0,false,true);let operator=h.operator.insecure_clone();
    h.time(OPEN+1);let entry=h.snapshot(1,OPEN+1,1_000);h.execute(0,entry,true);
    let alice=h.alice.insecure_clone();h.send(spl_token::instruction::transfer(&spl_token::ID,&h.alice_token,&h.vault,&alice.pubkey(),&[],17).unwrap(),&alice,true);
    h.time(OPEN+EPOCH_SECONDS+CLOSING_GRACE_SECONDS);h.send(ix(h.settlement(),i::VoidEpoch {}),&operator,false);
    h.time(OPEN+EPOCH_SECONDS+CLOSING_GRACE_SECONDS+1);h.send(ix(h.settlement(),i::VoidEpoch {}),&operator,true);
    h.send(ix(h.manage(0),i::Refund {}),&operator,true);h.withdraw(0,false,true);assert_eq!(h.balance(h.vault),17);
    let epoch:EpochAccount=h.read(h.epoch);assert_eq!(epoch.state.unwrap().ledger().residual,17);
}

#[test]
fn compiled_executed_round_requires_exact_closing_price_even_when_submitted_later() {
    let mut h=Harness::new();h.queue(0,0,false,true);
    h.time(OPEN+1);let entry=h.snapshot(1,OPEN+1,1_000);h.execute(0,entry,true);
    h.time(OPEN+EPOCH_SECONDS+10);let payer=h.bob.insecure_clone();
    h.send(ix(h.settlement(),i::FinalizeEmpty {}),&payer,false);
    let early=h.snapshot(2,OPEN+EPOCH_SECONDS-1,1_100);h.close(early,false);
    let late=h.snapshot(3,OPEN+EPOCH_SECONDS+1,1_100);h.close(late,false);
    assert_eq!(h.read::<EpochAccount>(h.epoch).state.unwrap().phase(),Phase::Open);
    let exact=h.snapshot(4,OPEN+EPOCH_SECONDS,1_100);h.close(exact,true);
    assert_eq!(h.read::<EpochAccount>(h.epoch).state.unwrap().phase(),Phase::Scoring);
}

#[test]
fn compiled_rejections_roll_back_deposits_and_enforce_operator_and_account_bindings() {
    let mut h=Harness::new();let before=h.balance(h.alice_token);
    h.queue(0,31,false,false);assert_eq!(h.balance(h.alice_token),before);assert!(h.svm.get_account(&h.lot(0)).is_none());
    h.queue(0,0,false,true);h.queue(0,0,false,false);assert_eq!(h.balance(h.alice_token),before-STAKE);
    h.time(OPEN+1);let snapshot=h.snapshot(1,OPEN+1,1_000);let alice=h.alice.insecure_clone();
    h.send(ix(a::Execute {operator:alice.pubkey(),config:h.config,epoch:h.epoch,lot:h.lot(0),vault:h.vault,test_vault:h.test_vault,snapshot},i::Execute {}),&alice,false);
    let operator=h.operator.insecure_clone();
    h.send(ix(a::ManageSnapshot {operator:operator.pubkey(),config:h.config,snapshot,system_program:system_program::ID},i::AppendPrices {prices:vec![prices(1_000)[0].clone()]}),&operator,false);
    let forged=Pubkey::new_unique();let original=h.svm.get_account(&h.lot(0)).unwrap();h.svm.set_account(forged,original).unwrap();
    h.send(ix(a::Execute {operator:operator.pubkey(),config:h.config,epoch:h.epoch,lot:forged,vault:h.vault,test_vault:h.test_vault,snapshot},i::Execute {}),&operator,false);
    h.execute(0,snapshot,true);h.withdraw(0,false,false);h.assert_vault();
}

#[test]
fn compiled_atomic_publication_executes_multiple_lots_and_rolls_back_the_whole_batch_on_failure() {
    let mut h=Harness::new();h.queue(0,0,false,true);h.queue(1,1,true,true);h.time(OPEN+1);
    let operator=h.operator.insecure_clone();let snapshot=pda(&[b"snapshot",h.config.as_ref(),&1u64.to_le_bytes()]);
    let publish=ix(a::InitializeSnapshot {operator:operator.pubkey(),config:h.config,snapshot,system_program:system_program::ID},i::PublishSnapshot {sequence:1,oracle_timestamp:OPEN+1,benchmark:1_000,prices:prices(1_000)});
    let execution=|nonce|ix(a::Execute {operator:operator.pubkey(),config:h.config,epoch:h.epoch,lot:h.lot(nonce),vault:h.vault,test_vault:h.test_vault,snapshot},i::Execute {});
    let first=execution(0);let second=execution(1);
    h.send_many(vec![publish.clone(),first.clone(),first.clone()],&operator,false);
    assert!(h.svm.get_account(&snapshot).is_none());
    let lot:LotAccount=h.read(h.lot(0));assert_eq!(lot.state.unwrap().state(),&LotState::Pending);
    h.send_many(vec![publish,first,second],&operator,true);h.assert_vault();
    for nonce in 0..2 {let lot:LotAccount=h.read(h.lot(nonce));assert_eq!(lot.state.unwrap().state(),&LotState::Executed);}
}

#[test]
fn compiled_maximum_universe_can_execute_close_and_claim_within_compute_and_storage_limits() {
    let mut h=Harness::with_assets(256);h.queue(0,0,false,true);h.time(OPEN+1);
    let entry=h.snapshot(1,OPEN+1,1_000);h.execute(0,entry,true);h.time(OPEN+EPOCH_SECONDS);
    let closing=h.snapshot(2,OPEN+EPOCH_SECONDS,1_100);h.close(closing,true);
    let operator=h.operator.insecure_clone();h.send(ix(h.manage(0),i::Score {}),&operator,true);
    h.send(ix(h.settlement(),i::FinalizeScores {}),&operator,true);h.send(ix(h.manage(0),i::Allocate {}),&operator,true);
    h.withdraw(0,false,true);assert_eq!(h.balance(h.vault),2_000);
}

#[test]
fn compiled_devnet_collateral_is_interchangeable_at_one_to_one_and_selected_vault_liquidity_is_enforced() {
    let mut h=Harness::with_collateral(30,true);
    h.queue_collateral(0,0,false,true,true);h.queue_collateral(1,1,true,false,true);
    assert_eq!(h.balance(h.vault),STAKE);assert_eq!(h.balance(h.test_vault),STAKE);
    h.time(OPEN+EPOCH_SECONDS);let operator=h.operator.insecure_clone();
    h.send(ix(h.manage(0),i::Refund {}),&operator,true);h.send(ix(h.manage(1),i::Refund {}),&operator,true);
    h.withdraw_collateral(0,false,false,true);h.withdraw_collateral(1,true,true,true);
    assert_eq!(h.balance(h.alice_token),3*STAKE);assert_eq!(h.balance(h.bob_test_token),3*STAKE);
    assert_eq!(h.balance(h.vault)+h.balance(h.test_vault),0);

    let mut h=Harness::with_collateral(30,true);h.queue_collateral(0,0,false,true,true);
    h.time(OPEN+EPOCH_SECONDS);let operator=h.operator.insecure_clone();h.send(ix(h.manage(0),i::Refund {}),&operator,true);
    h.withdraw_collateral(0,false,false,false);
    let lot:LotAccount=h.read(h.lot(0));assert_eq!(lot.state.unwrap().state(),&LotState::Claimable {amount:STAKE});
    h.withdraw_collateral(0,false,true,true);assert_eq!(h.balance(h.alice_test_token),2*STAKE);
}

#[test]
fn compiled_large_claim_can_be_split_across_both_mints_without_stranding_or_double_spending() {
    let mut h=Harness::with_collateral(30,true);h.queue_collateral(0,0,false,true,true);h.queue_collateral(1,1,true,false,true);
    h.time(OPEN+1);let entry=h.snapshot(1,OPEN+1,1_000);h.execute(0,entry,true);h.execute(1,entry,true);
    h.time(OPEN+EPOCH_SECONDS);let close=h.snapshot(2,OPEN+EPOCH_SECONDS,1_100);h.close(close,true);let operator=h.operator.insecure_clone();
    for nonce in 0..2 {h.send(ix(h.manage(nonce),i::Score {}),&operator,true);}
    h.send(ix(h.settlement(),i::FinalizeScores {}),&operator,true);
    for nonce in 0..2 {h.send(ix(h.manage(nonce),i::Allocate {}),&operator,true);}
    h.withdraw_collateral(0,false,false,false);
    let owner=h.alice.insecure_clone();
    let accounts=|destination|a::Withdraw {owner:owner.pubkey(),config:h.config,epoch:h.epoch,lot:h.lot(0),vault:h.vault,test_vault:h.test_vault,destination,token_program:spl_token::ID};
    let first=ix(accounts(h.alice_token),i::WithdrawPartial {amount:STAKE});
    let second=ix(accounts(h.alice_test_token),i::WithdrawPartial {amount:STAKE-4_000});
    h.send(first,&owner,true);h.assert_vault();
    let lot:LotAccount=h.read(h.lot(0));assert_eq!(lot.state.unwrap().state(),&LotState::Claimable {amount:STAKE-4_000});
    h.send(second.clone(),&owner,true);h.assert_vault();h.send(second,&owner,false);
    let lot:LotAccount=h.read(h.lot(0));assert_eq!(lot.state.unwrap().state(),&LotState::Withdrawn);
    assert_eq!(h.balance(h.vault)+h.balance(h.test_vault),4_000);
}

#[test]
fn compiled_production_build_cannot_initialize_dual_collateral_even_with_admin_signature() {
    let mut h=Harness::new();let admin=h.admin.insecure_clone();let config=pda(&[b"config",admin.pubkey().as_ref(),&1u64.to_le_bytes()]);
    let mint=SplAccount::unpack(&h.svm.get_account(&h.alice_token).unwrap().data).unwrap().mint;
    let alternate=Pubkey::new_unique();h.svm.set_account(alternate,h.svm.get_account(&mint).unwrap()).unwrap();
    h.send(ix(a::InitializeDevnetConfig {admin:admin.pubkey(),mint,test_mint:alternate,config,system_program:system_program::ID},i::InitializeDevnetConfig {
        config_id:1,operator:h.operator.pubkey(),methodology:[9;32],origin_benchmark:1_000,max_entry_price_age:3,max_lots:1000}),&admin,false);
    assert!(h.svm.get_account(&config).is_none());
    assert_eq!(h.read::<relative_epoch::PoolConfig>(h.config).test_mint,None);
}

#[test]
fn compiled_ephemeral_snapshot_recovers_rent_and_copied_references_survive_close_and_recreation() {
    let mut h=Harness::new();h.queue(0,0,false,true);h.queue(1,1,true,true);h.time(OPEN+1);
    let operator=h.operator.insecure_clone();let config=h.config;
    let snapshot=pda(&[b"snapshot",config.as_ref(),&1u64.to_le_bytes()]);
    let publish=ix(a::InitializeSnapshot {operator:operator.pubkey(),config,snapshot,system_program:system_program::ID},i::PublishSnapshot {sequence:1,oracle_timestamp:OPEN+1,benchmark:1_000,prices:prices(1_000)});
    let close=ix(a::CloseSnapshot {operator:operator.pubkey(),config,snapshot},i::CloseSnapshot {});
    let execution=|nonce|ix(a::Execute {operator:operator.pubkey(),config,epoch:h.epoch,lot:h.lot(nonce),vault:h.vault,test_vault:h.test_vault,snapshot},i::Execute {});
    let first=execution(0);let second=execution(1);
    let before=h.svm.get_account(&operator.pubkey()).unwrap().lamports;
    h.send_many(vec![publish.clone(),first,close.clone()],&operator,true);
    assert!(h.closed(snapshot));
    assert_eq!(before-h.svm.get_account(&operator.pubkey()).unwrap().lamports,5_000);
    let first:LotAccount=h.read(h.lot(0));let references=first.state.unwrap().execution().unwrap().references;
    h.send_many(vec![publish,second,close],&operator,true);
    assert!(h.closed(snapshot));
    let first:LotAccount=h.read(h.lot(0));assert_eq!(first.state.unwrap().execution().unwrap().references,references);
    h.time(OPEN+EPOCH_SECONDS);
    let closing=pda(&[b"snapshot",config.as_ref(),&2u64.to_le_bytes()]);
    h.send_many(vec![ix(a::InitializeSnapshot {operator:operator.pubkey(),config,snapshot:closing,system_program:system_program::ID},i::PublishSnapshot {sequence:2,oracle_timestamp:OPEN+EPOCH_SECONDS,benchmark:1_000,prices:prices(1_100)}),
        ix(a::BeginClose {operator:operator.pubkey(),config,epoch:h.epoch,vault:h.vault,test_vault:h.test_vault,snapshot:closing},i::BeginClose {}),
        ix(a::CloseSnapshot {operator:operator.pubkey(),config,snapshot:closing},i::CloseSnapshot {})],&operator,true);
    assert!(h.closed(closing));
    for nonce in 0..2 {h.send(ix(h.manage(nonce),i::Score {}),&operator,true);}
    h.send(ix(h.settlement(),i::FinalizeScores {}),&operator,true);
    for nonce in 0..2 {h.send(ix(h.manage(nonce),i::Allocate {}),&operator,true);}
    assert_eq!(h.read::<EpochAccount>(h.epoch).state.unwrap().phase(),Phase::Settled);h.assert_vault();
}

#[test]
fn compiled_snapshot_close_is_operator_bound_and_failure_rolls_back_publication_and_execution() {
    let mut h=Harness::new();h.queue(0,0,false,true);h.time(OPEN+1);
    let operator=h.operator.insecure_clone();let config=h.config;
    let snapshot=pda(&[b"snapshot",config.as_ref(),&1u64.to_le_bytes()]);
    let publish=ix(a::InitializeSnapshot {operator:operator.pubkey(),config,snapshot,system_program:system_program::ID},i::PublishSnapshot {sequence:1,oracle_timestamp:OPEN+1,benchmark:1_000,prices:prices(1_000)});
    let execute=ix(a::Execute {operator:operator.pubkey(),config,epoch:h.epoch,lot:h.lot(0),vault:h.vault,test_vault:h.test_vault,snapshot},i::Execute {});
    let invalid_close=ix(a::CloseSnapshot {operator:operator.pubkey(),config,snapshot:pda(&[b"snapshot",config.as_ref(),&2u64.to_le_bytes()])},i::CloseSnapshot {});
    h.send_many(vec![publish.clone(),execute,invalid_close],&operator,false);
    assert!(h.closed(snapshot));assert_eq!(h.read::<LotAccount>(h.lot(0)).state.unwrap().state(),&LotState::Pending);
    h.send(publish,&operator,true);
    let rent=h.svm.get_account(&snapshot).unwrap().lamports;let alice=h.alice.insecure_clone();
    h.send(ix(a::CloseSnapshot {operator:alice.pubkey(),config,snapshot},i::CloseSnapshot {}),&alice,false);
    assert_eq!(h.svm.get_account(&snapshot).unwrap().lamports,rent);
    let before=h.svm.get_account(&operator.pubkey()).unwrap().lamports;
    h.send(ix(a::CloseSnapshot {operator:operator.pubkey(),config,snapshot},i::CloseSnapshot {}),&operator,true);
    assert!(h.closed(snapshot));assert_eq!(h.svm.get_account(&operator.pubkey()).unwrap().lamports,before+rent-5_000);
}

#[test]
fn compiled_global_snapshot_filters_added_assets_for_existing_frozen_epoch() {
    let mut h=Harness::new();h.queue(0,0,false,true);h.time(OPEN+1);
    let entry=h.snapshot_with_count(1,OPEN+1,1_000,31);h.execute(0,entry,true);
    let round:EpochAccount=h.read(h.epoch);assert_eq!(round.state.unwrap().universe().len(),30);
    let lot:LotAccount=h.read(h.lot(0));assert_eq!(lot.state.unwrap().execution().unwrap().references.len(),30);
    h.time(OPEN+EPOCH_SECONDS);let closing=h.snapshot_with_count(2,OPEN+EPOCH_SECONDS,1_100,31);
    h.close(closing,true);
    let round:EpochAccount=h.read(h.epoch);assert_eq!(round.state.unwrap().phase(),Phase::Scoring);
}

#[test]
fn compiled_empty_round_finalizes_without_operator_or_snapshot_and_archival_is_terminal() {
    let mut h=Harness::new();let alice=h.alice.insecure_clone();let admin=h.admin.insecure_clone();
    h.send(ix(h.settlement(),i::FinalizeEmpty {}),&alice,false);
    h.send(ix(a::ManageConfig {admin:admin.pubkey(),config:h.config},i::SetConfigLifecycle {
        lifecycle:relative_epoch::ConfigLifecycle::Archived}),&admin,true);
    h.send(ix(a::ManageConfig {admin:admin.pubkey(),config:h.config},i::SetConfigLifecycle {
        lifecycle:relative_epoch::ConfigLifecycle::Active}),&admin,false);
    h.queue(0,0,false,false);
    h.time(OPEN+EPOCH_SECONDS);h.send(ix(h.settlement(),i::FinalizeEmpty {}),&alice,true);
    let round:EpochAccount=h.read(h.epoch);assert!(round.empty_finalized);assert_eq!(round.state.unwrap().phase(),Phase::Settled);
}

#[test]
fn compiled_archival_preserves_pending_refund_and_owner_withdrawal() {
    let mut h=Harness::new();h.queue(0,0,false,true);let admin=h.admin.insecure_clone();let bob=h.bob.insecure_clone();
    h.time(OPEN+1);let snapshot=h.snapshot(1,OPEN+1,1_000);
    h.send(ix(a::ManageConfig {admin:admin.pubkey(),config:h.config},i::SetConfigLifecycle {
        lifecycle:relative_epoch::ConfigLifecycle::Archived}),&admin,true);
    let config_before=h.svm.get_account(&h.config).unwrap().data;
    let operator=h.operator.insecure_clone();
    h.execute(0,snapshot,false);
    let rejected=pda(&[b"snapshot",h.config.as_ref(),&2u64.to_le_bytes()]);
    h.send(ix(a::InitializeSnapshot {operator:operator.pubkey(),config:h.config,snapshot:rejected,system_program:system_program::ID},
        i::InitializeSnapshot {sequence:2,oracle_timestamp:OPEN+1,benchmark:1_000,expected_prices:30}),&operator,false);
    h.send(ix(a::InitializeSnapshot {operator:operator.pubkey(),config:h.config,snapshot:rejected,system_program:system_program::ID},
        i::PublishSnapshot {sequence:2,oracle_timestamp:OPEN+1,benchmark:1_000,prices:prices(1_000)}),&operator,false);
    assert!(h.svm.get_account(&rejected).is_none());
    assert_eq!(h.svm.get_account(&h.config).unwrap().data,config_before);
    h.time(OPEN+EPOCH_SECONDS);h.send(ix(h.manage(0),i::Refund {}),&bob,true);
    h.send(ix(h.settlement(),i::FinalizeEmpty {}),&bob,true);h.withdraw(0,false,true);
    assert_eq!(h.balance(h.alice_token),2*STAKE);
}

fn install_anchor_account<T: AccountSerialize>(h: &mut Harness, address: Pubkey, value: &T, owner: Pubkey, space: usize) {
    let mut data=Vec::new();value.try_serialize(&mut data).unwrap();assert!(data.len()<=space);data.resize(space,0);
    h.svm.set_account(address,Account {lamports:100_000_000,data,owner,executable:false,rent_epoch:0}).unwrap();
}

fn export_generation(h:&Harness,name:&str,accounts:&[(&str,Pubkey)],expected:serde_json::Value) {
    let Ok(directory)=std::env::var("EPOCH_GENERATION_FIXTURES_DIR") else {return;};
    let directory=std::path::Path::new(&directory);std::fs::create_dir_all(directory).unwrap();
    let dirty_padding=name=="legacy-dirty-padding";
    let records=accounts.iter().map(|(name,address)| {
        let account=h.svm.get_account(address).unwrap();
        serde_json::json!({"name":name,"address":address.to_string(),"owner":account.owner.to_string(),
            "dataHex":account.data.iter().map(|byte|format!("{byte:02x}")).collect::<String>(),
            "provenance":if dirty_padding {"compiled-output-with-injected-legacy-padding"}else if account.owner==cox::ID {"canonical-test-prestate"}else{"compiled-instruction-output"}})
    }).collect::<Vec<_>>();
    let clock=h.svm.get_sysvar::<Clock>();
    std::fs::write(directory.join(format!("{name}.json")),serde_json::to_vec_pretty(&serde_json::json!({
        "schema":"cox.compiled-account-fixtures/v1","programAddress":relative_epoch::ID.to_string(),
        "basicProgramAddress":cox::ID.to_string(),"unixTimestamp":clock.unix_timestamp,
        "evidence":"controlled-compiled-LiteSVM-test-not-live-Pyth-or-devnet",
        "expected":expected,"accounts":records})).unwrap()).unwrap();
}

fn permissionless_registry_round(asset_count:usize) { permissionless_registry_round_with_pending(asset_count,false); }

#[test]
fn compiled_pending_proposal_does_not_block_current_or_successor_epoch() { permissionless_registry_round_with_pending(31,true); }

fn permissionless_registry_round_with_pending(asset_count:usize,pending_proposal:bool) {
    let mut h=Harness::new();
    let old_config:relative_epoch::PoolConfig=h.read(h.config);
    let generation=[81;32];let (registry,registry_bump)=Pubkey::find_program_address(&[b"asset-registry",&generation],&cox::ID);
    let mut universe=cox::UniverseVersion::draft(0,Pubkey::new_unique(),h.operator.pubkey(),[82;32],1,[0;32],asset_count as u16,
        cox::UniverseCapture {price_universe_digest:[83;32],timestamp:OPEN,benchmark:100*cox_math::SCALE,
            prices_e8:vec![1_000;asset_count],signed_payload_digest:[84;32],trusted_storage_digest:[85;32],
            predecessor_sequence:0,predecessor_state_digest:[0;32]}).unwrap();
    universe.schema_version=2;
    universe.instruments=(0..asset_count).map(|id|cox::Instrument {stable_id:format!("asset-{id}"),
        symbol:if id<30 {cox::IDS[id].into()}else{format!("EXTRA{id}")},class_id:(id+1) as u16,epoch_id:id as u16,
        pyth_pro_feed_id:id as u32+1,pyth_core_feed_id:asset(id as u16).feed_id,token_mint:None,
        original_price_e8:1_000,original_benchmark:100*cox_math::SCALE,original_timestamp:OPEN}).collect();
    universe.seal_genesis().unwrap();let digest=universe.digest;
    let (methodology,methodology_bump)=Pubkey::find_program_address(&[b"methodology",&digest],&cox::ID);
    let (version,version_bump)=Pubkey::find_program_address(&[b"asset-version",registry.as_ref(),&digest],&cox::ID);
    let canonical=universe.canonical_bytes().unwrap();
    let methodology_account=cox::Methodology {schema_version:3,bump:methodology_bump,digest,canonical:canonical.clone(),sealed:true,
        activation_batch:0,expected_length:canonical.len() as u32,roster:(0..asset_count as u8).collect(),origin:OPEN,bybit:false};
    install_anchor_account(&mut h,methodology,&methodology_account,cox::ID,canonical.len()+512);
    let mut registry_account=cox::AssetRegistry {schema_version:1,bump:registry_bump,generation,authority_registry:Pubkey::new_unique(),
        source_pool:universe.pool,active_version:version,active_digest:digest,active_from:OPEN,pending_activation:if pending_proposal {OPEN+50}else{0}};
    install_anchor_account(&mut h,registry,&registry_account,cox::ID,256);
    let mut version_account=cox::AssetRegistryVersion {schema_version:1,bump:version_bump,registry,generation,methodology,digest,
        predecessor:[0;32],effective_from:OPEN,effective_until:0,sealed:true};
    install_anchor_account(&mut h,version,&version_account,cox::ID,256);
    h.config=pda(&[b"config",h.admin.pubkey().as_ref(),&1u64.to_le_bytes()]);
    h.epoch=pda(&[b"epoch",h.config.as_ref(),&OPEN.to_le_bytes()]);
    h.vault=pda(&[b"vault",h.epoch.as_ref()]);h.test_vault=pda(&[b"test-vault",h.epoch.as_ref()]);
    let admin=h.admin.insecure_clone();let alice=h.alice.insecure_clone();let bob=h.bob.insecure_clone();
    h.time(OPEN+100);
    h.send(ix(a::InitializeConfig {admin:admin.pubkey(),mint:old_config.mint,config:h.config,system_program:system_program::ID},
        i::InitializeRegistryConfig {config_id:1,operator:h.operator.pubkey(),methodology:old_config.methodology,
            origin_benchmark:100*cox_epoch::math::SCALE,max_entry_price_age:5,max_lots:100,asset_registry:registry}),&admin,true);
    if asset_count==31 {export_generation(&h,"preparing",&[("config",h.config),("assetRegistry",registry),("assetRegistryVersion",version),("methodology",methodology)],
        serde_json::json!({"lifecycle":"Preparing","registryAssets":31,"registryVersion":1,"cryptoClass":0}));}
    for invalid_open in [OPEN-EPOCH_SECONDS,OPEN+EPOCH_SECONDS,OPEN+1] {
        let epoch=pda(&[b"epoch",h.config.as_ref(),&invalid_open.to_le_bytes()]);
        let vault=pda(&[b"vault",epoch.as_ref()]);let test_vault=pda(&[b"test-vault",epoch.as_ref()]);
        h.send(ix(a::InitializeCurrentEpoch {payer:alice.pubkey(),config:h.config,asset_registry:registry,
            registry_version:version,methodology,mint:old_config.mint,test_mint:old_config.mint,epoch,vault,test_vault,
            token_program:spl_token::ID,system_program:system_program::ID},
            i::InitializeCurrentEpoch {opens_at:invalid_open}),&alice,false);
        assert!(h.svm.get_account(&epoch).is_none());assert!(h.svm.get_account(&vault).is_none());
        assert!(h.svm.get_account(&test_vault).is_none());
    }
    let init=|h:&Harness|ix(a::InitializeCurrentEpoch {payer:alice.pubkey(),config:h.config,asset_registry:registry,
        registry_version:version,methodology,mint:old_config.mint,test_mint:old_config.mint,epoch:h.epoch,vault:h.vault,
        test_vault:h.test_vault,token_program:spl_token::ID,system_program:system_program::ID},i::InitializeCurrentEpoch {opens_at:OPEN});
    registry_account.pending_activation=OPEN;install_anchor_account(&mut h,registry,&registry_account,cox::ID,256);
    version_account.effective_until=OPEN;install_anchor_account(&mut h,version,&version_account,cox::ID,256);
    h.send(init(&h),&alice,false);
    version_account.effective_until=0;install_anchor_account(&mut h,version,&version_account,cox::ID,256);
    h.send(init(&h),&alice,true);
    let draft=|h:&Harness,payer:Pubkey| {
        let epoch:EpochAccount=h.read(h.epoch);let version:cox::AssetRegistryVersion=h.read(epoch.registry_version);
        a::ManageCurrentEpochDraft {payer,config:h.config,asset_registry:registry,
            registry_version:epoch.registry_version,methodology:version.methodology,epoch:h.epoch,system_program:system_program::ID}
    };
    h.send(ix(draft(&h,bob.pubkey()),i::GrowCurrentEpoch {additional_bytes:relative_epoch::MAX_GROWTH as u32+1}),&bob,false);
    while h.svm.get_account(&h.epoch).unwrap().data.len()<relative_epoch::EPOCH_SPACE {
        let current=h.svm.get_account(&h.epoch).unwrap().data.len();let additional=(relative_epoch::EPOCH_SPACE-current).min(relative_epoch::MAX_GROWTH);
        h.send(ix(draft(&h,alice.pubkey()),i::GrowCurrentEpoch {additional_bytes:additional as u32}),&alice,true);
    }
    h.send(ix(draft(&h,bob.pubkey()),i::CopyRegistryAssets {start:1,count:8}),&bob,false);
    h.send(ix(draft(&h,bob.pubkey()),i::CopyRegistryAssets {start:0,count:9}),&bob,false);
    let mut latest_version=version;let mut latest_methodology=methodology;let mut latest_count=asset_count;
    for start in (0..asset_count).step_by(8) {
        if start==8 && asset_count==31 {
            let before:EpochAccount=h.read(h.epoch);assert_eq!(before.universe.len(),8);
            h.time(OPEN+150);
            let mut next=universe.clone();next.version=2;next.predecessor_digest=universe.digest;
            next.expected_instruments=32;next.capture.timestamp=OPEN+150;
            next.capture.benchmark=103*cox_math::SCALE;
            next.capture.prices_e8.push(1_000);next.capture.predecessor_sequence=1;next.capture.predecessor_state_digest=[86;32];
            next.instruments.push(cox::Instrument {stable_id:"new-asset".into(),symbol:"NEW".into(),class_id:32,epoch_id:31,
                pyth_pro_feed_id:32,pyth_core_feed_id:asset(31).feed_id,token_mint:None,
                original_price_e8:1_000,original_benchmark:103*cox_math::SCALE,original_timestamp:OPEN+150});
            next.sealed=false;next.seal_successor(&universe,103*cox_math::SCALE).unwrap();
            let (next_methodology,next_methodology_bump)=Pubkey::find_program_address(&[b"methodology",&next.digest],&cox::ID);
            let canonical=next.canonical_bytes().unwrap();
            install_anchor_account(&mut h,next_methodology,&cox::Methodology {schema_version:3,bump:next_methodology_bump,
                digest:next.digest,canonical:canonical.clone(),sealed:true,activation_batch:150,expected_length:canonical.len() as u32,
                roster:(0..32).collect(),origin:OPEN,bybit:false},cox::ID,canonical.len()+512);
            let (next_version,next_bump)=Pubkey::find_program_address(&[b"asset-version",registry.as_ref(),&next.digest],&cox::ID);
            version_account.effective_until=OPEN+151;install_anchor_account(&mut h,version,&version_account,cox::ID,256);
            install_anchor_account(&mut h,next_version,&cox::AssetRegistryVersion {schema_version:2,bump:next_bump,registry,generation,
                methodology:next_methodology,digest:next.digest,predecessor:universe.digest,effective_from:OPEN+151,effective_until:0,sealed:true},cox::ID,256);
            registry_account.active_version=next_version;registry_account.active_digest=next.digest;registry_account.active_from=OPEN+151;
            install_anchor_account(&mut h,registry,&registry_account,cox::ID,256);
            latest_version=next_version;latest_methodology=next_methodology;latest_count=32;
            let late_config=pda(&[b"config",admin.pubkey().as_ref(),&2u64.to_le_bytes()]);
            h.send(ix(a::InitializeConfig {admin:admin.pubkey(),mint:old_config.mint,config:late_config,system_program:system_program::ID},
                i::InitializeRegistryConfig {config_id:2,operator:h.operator.pubkey(),methodology:old_config.methodology,
                    origin_benchmark:100*cox_epoch::math::SCALE,max_entry_price_age:5,max_lots:100,asset_registry:registry}),&admin,true);
            let late_epoch=pda(&[b"epoch",late_config.as_ref(),&OPEN.to_le_bytes()]);
            let late_vault=pda(&[b"vault",late_epoch.as_ref()]);let late_test_vault=pda(&[b"test-vault",late_epoch.as_ref()]);
            for (selected_version,selected_methodology,success) in [(next_version,next_methodology,false),(version,methodology,true)] {
                h.send(ix(a::InitializeCurrentEpoch {payer:bob.pubkey(),config:late_config,asset_registry:registry,
                    registry_version:selected_version,methodology:selected_methodology,mint:old_config.mint,test_mint:old_config.mint,
                    epoch:late_epoch,vault:late_vault,test_vault:late_test_vault,token_program:spl_token::ID,system_program:system_program::ID},
                    i::InitializeCurrentEpoch {opens_at:OPEN}),&bob,success);
                if !success {assert!(h.svm.get_account(&late_epoch).is_none());}
            }
            assert_eq!(h.read::<EpochAccount>(late_epoch).registry_version,version);
            let unchanged:EpochAccount=h.read(h.epoch);assert_eq!(unchanged.universe,before.universe);
            assert_eq!(unchanged.registry_origin_benchmarks,before.registry_origin_benchmarks);
        }
        let payer=if start==0 {&alice}else{&bob};
        h.send(ix(draft(&h,payer.pubkey()),i::CopyRegistryAssets {start:start as u16,count:(asset_count-start).min(8) as u16}),payer,true);
    }
    h.send(ix(draft(&h,bob.pubkey()),i::SealCurrentEpoch {}),&bob,true);
    let round:EpochAccount=h.read(h.epoch);assert_eq!(round.registry_version,version);assert_eq!(round.universe_digest,digest);
    assert_eq!(round.registry_origin_benchmarks,vec![100*cox_epoch::math::SCALE;asset_count]);
    let expected:Vec<Asset>=universe.instruments.iter().map(|instrument|Asset {id:instrument.epoch_id,
        feed_id:instrument.pyth_core_feed_id,origin_price:instrument.original_price_e8 as u128}).collect();
    assert_eq!(round.state.unwrap().universe(),expected.as_slice());
    if asset_count==31 {export_generation(&h,"sealed-frozen-31",&[("config",h.config),("epoch",h.epoch),("assetRegistry",registry),
        ("assetRegistryVersion",version),("methodology",methodology),("activeAssetRegistryVersion",latest_version),("activeMethodology",latest_methodology)],
        serde_json::json!({"lifecycle":"Preparing","sealed":true,"frozenAssets":31,"frozenVersion":1,"activeRegistryAssets":32,"activeRegistryVersion":2,"emptyFinalized":false}));}
    h.queue(0,0,false,false);
    h.send(ix(a::ManageConfig {admin:admin.pubkey(),config:h.config},i::SetConfigLifecycle {lifecycle:relative_epoch::ConfigLifecycle::Active}),&admin,true);
    if asset_count==31 {export_generation(&h,"active",&[("config",h.config),("epoch",h.epoch),("assetRegistry",registry),
        ("assetRegistryVersion",version),("methodology",methodology)],serde_json::json!({"lifecycle":"Active","sealed":true,"frozenAssets":31,"frozenVersion":1}));}
    h.queue(0,0,false,true);
    let predecessor=h.epoch;
    let next_open=OPEN+EPOCH_SECONDS;
    h.time(next_open+1);
    h.epoch=pda(&[b"epoch",h.config.as_ref(),&next_open.to_le_bytes()]);
    h.vault=pda(&[b"vault",h.epoch.as_ref()]);h.test_vault=pda(&[b"test-vault",h.epoch.as_ref()]);
    h.send(ix(a::InitializeCurrentEpoch {payer:bob.pubkey(),config:h.config,asset_registry:registry,
        registry_version:latest_version,methodology:latest_methodology,mint:old_config.mint,test_mint:old_config.mint,epoch:h.epoch,vault:h.vault,
        test_vault:h.test_vault,token_program:spl_token::ID,system_program:system_program::ID},
        i::InitializeCurrentEpoch {opens_at:next_open}),&bob,true);
    let previous:EpochAccount=h.read(predecessor);let previous=previous.state.unwrap();
    assert_eq!(previous.phase(),Phase::Open);assert_eq!(previous.ledger().pending_gross,STAKE);
    while h.svm.get_account(&h.epoch).unwrap().data.len()<relative_epoch::EPOCH_SPACE {
        let current=h.svm.get_account(&h.epoch).unwrap().data.len();
        h.send(ix(draft(&h,bob.pubkey()),i::GrowCurrentEpoch {additional_bytes:(relative_epoch::EPOCH_SPACE-current).min(relative_epoch::MAX_GROWTH) as u32}),&bob,true);
    }
    for start in (0..latest_count).step_by(8) {
        h.send(ix(draft(&h,bob.pubkey()),i::CopyRegistryAssets {start:start as u16,count:(latest_count-start).min(8) as u16}),&bob,true);
    }
    h.send(ix(draft(&h,bob.pubkey()),i::SealCurrentEpoch {}),&bob,true);
    h.queue(0,0,false,true);
    let successor:EpochAccount=h.read(h.epoch);
    assert_eq!(successor.registry_version,latest_version);
    assert_eq!(successor.state.as_ref().unwrap().universe().len(),latest_count);
    assert_eq!(&successor.registry_origin_benchmarks[..asset_count],vec![100*cox_epoch::math::SCALE;asset_count].as_slice());
    if asset_count==31 {assert_eq!(successor.registry_origin_benchmarks[31],103*cox_epoch::math::SCALE);}
    assert_eq!(successor.state.unwrap().ledger().pending_gross,STAKE);
    if asset_count==31 {export_generation(&h,"successor-32",&[("config",h.config),("epoch",h.epoch),("predecessorEpoch",predecessor),
        ("assetRegistry",registry),("assetRegistryVersion",latest_version),("methodology",latest_methodology)],
        serde_json::json!({"lifecycle":"Active","sealed":true,"frozenAssets":32,"frozenVersion":2,"predecessorPhase":"Open","pendingGross":STAKE,"newAssetOriginBenchmark":(103*cox_epoch::math::SCALE).to_string()}));}
    let previous:EpochAccount=h.read(predecessor);
    assert_eq!(previous.state.unwrap().phase(),Phase::Open);
    h.time(next_open+EPOCH_SECONDS);
    h.send(ix(h.settlement(),i::FinalizeEmpty {}),&alice,false);
    h.send(ix(h.manage(0),i::Refund {}),&alice,true);
    h.send(ix(h.settlement(),i::FinalizeEmpty {}),&alice,true);
    h.withdraw(0,false,true);
    if asset_count==31 {export_generation(&h,"empty-terminal-sealed",&[("config",h.config),("epoch",h.epoch)],
        serde_json::json!({"lifecycle":"Active","phase":"Settled","statePresent":true,"emptyFinalized":true,"frozenAssets":32}));}
    let final_open=next_open+EPOCH_SECONDS;
    h.time(final_open+1);
    h.epoch=pda(&[b"epoch",h.config.as_ref(),&final_open.to_le_bytes()]);
    h.vault=pda(&[b"vault",h.epoch.as_ref()]);h.test_vault=pda(&[b"test-vault",h.epoch.as_ref()]);
    h.send(ix(a::InitializeCurrentEpoch {payer:bob.pubkey(),config:h.config,asset_registry:registry,
        registry_version:latest_version,methodology:latest_methodology,mint:old_config.mint,test_mint:old_config.mint,epoch:h.epoch,vault:h.vault,
        test_vault:h.test_vault,token_program:spl_token::ID,system_program:system_program::ID},
        i::InitializeCurrentEpoch {opens_at:final_open}),&bob,true);
    h.time(final_open+EPOCH_SECONDS);h.send(ix(h.settlement(),i::FinalizeEmpty {}),&alice,true);
    let empty:EpochAccount=h.read(h.epoch);assert!(empty.empty_finalized);assert!(empty.state.is_none());
    if asset_count==31 {
        export_generation(&h,"empty-terminal-draft",&[("config",h.config),("epoch",h.epoch)],
            serde_json::json!({"lifecycle":"Active","statePresent":false,"emptyFinalized":true,"draftAssets":0}));
        h.send(ix(a::ManageConfig {admin:admin.pubkey(),config:h.config},i::SetConfigLifecycle {lifecycle:relative_epoch::ConfigLifecycle::Archived}),&admin,true);
        export_generation(&h,"archived",&[("config",h.config),("epoch",h.epoch)],
            serde_json::json!({"lifecycle":"Archived","statePresent":false,"emptyFinalized":true}));
    }
}

#[test]
fn compiled_permissionless_current_round_copies_canonical_registry_and_resumes_with_another_payer() {
    permissionless_registry_round(31);
}

#[test]
fn compiled_permissionless_registry_round_supports_255_assets_with_bounded_transactions() {
    permissionless_registry_round(255);
}

#[test]
fn compiled_legacy_zero_padding_remains_active_and_unknown_lifecycle_versions_fail_closed() {
    let mut h=Harness::new();let config:relative_epoch::PoolConfig=h.read(h.config);
    let mut encoded=Vec::new();config.try_serialize(&mut encoded).unwrap();let offset=encoded.len()-42;
    let mut account=h.svm.get_account(&h.config).unwrap();account.data[offset..].fill(0);
    h.svm.set_account(h.config,account.clone()).unwrap();h.queue(0,0,false,true);
    account.data[offset..offset+8].copy_from_slice(&relative_epoch::CONFIG_LIFECYCLE_MAGIC);
    account.data[offset+8]=2;h.svm.set_account(h.config,account).unwrap();h.queue(1,1,false,false);
}

#[test]
fn compiled_dirty_legacy_epoch_and_config_padding_preserves_refund_rights_after_archive() {
    let mut h=Harness::new();
    let config:relative_epoch::PoolConfig=h.read(h.config);let epoch:EpochAccount=h.read(h.epoch);
    let mut encoded=Vec::new();config.try_serialize(&mut encoded).unwrap();let config_offset=encoded.len()-42;
    let mut config_account=h.svm.get_account(&h.config).unwrap();config_account.data[config_offset..].fill(49);
    h.svm.set_account(h.config,config_account).unwrap();
    encoded.clear();epoch.try_serialize(&mut encoded).unwrap();let epoch_offset=encoded.len()-78;
    let mut epoch_account=h.svm.get_account(&h.epoch).unwrap();epoch_account.data[epoch_offset..].fill(72);
    h.svm.set_account(h.epoch,epoch_account).unwrap();
    assert_eq!(h.read::<relative_epoch::PoolConfig>(h.config).lifecycle_version,0);
    assert_eq!(h.read::<EpochAccount>(h.epoch).binding_version,0);
    export_generation(&h,"legacy-dirty-padding",&[("config",h.config),("epoch",h.epoch)],
        serde_json::json!({"lifecycle":"Active","lifecycleVersion":0,"bindingVersion":0,"sealed":true,"frozenAssets":30,"configPaddingByte":49,"epochPaddingByte":72}));
    h.queue(0,0,false,true);
    let admin=h.admin.insecure_clone();let bob=h.bob.insecure_clone();
    h.send(ix(a::ManageConfig {admin:admin.pubkey(),config:h.config},i::SetConfigLifecycle {
        lifecycle:relative_epoch::ConfigLifecycle::Archived}),&admin,true);
    h.queue(1,1,true,false);
    h.time(OPEN+EPOCH_SECONDS);h.send(ix(h.manage(0),i::Refund {}),&bob,true);
    h.send(ix(h.settlement(),i::FinalizeEmpty {}),&bob,true);h.withdraw(0,false,true);
    assert_eq!(h.balance(h.alice_token),2*STAKE);
    assert_eq!(h.read::<relative_epoch::PoolConfig>(h.config).lifecycle,relative_epoch::ConfigLifecycle::Archived);
}
