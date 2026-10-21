mod support;
use anchor_lang::AccountSerialize;
use cox::{accounts as a,instruction as i,Pool,Request};
use solana_sdk::{instruction::AccountMeta,pubkey::Pubkey,signature::Signer};
use support::{pda,protocol::PoolHarness,Harness,ORIGIN};

fn deposit_token(p:&mut PoolHarness,bob:bool,token:Pubkey,amount:u64,success:bool)->u64{
    let signer=if bob{p.h.bob.insecure_clone()}else{p.h.alice.insecure_clone()};let nonce=p.pool_state().next_request_nonce;
    let instruction=Harness::instruction(p.submit_accounts(signer.pubkey(),token),i::Deposit{to:0,amount,minimum_units:0,expiry:100});
    p.h.send("deposit_selected_collateral",&[instruction],&[&signer],success);nonce
}
fn withdraw_token(p:&mut PoolHarness,bob:bool,token:Pubkey,amount:u64,success:bool){
    let signer=if bob{p.h.bob.insecure_clone()}else{p.h.alice.insecure_clone()};
    let instruction=Harness::instruction(a::Withdraw{owner:signer.pubkey(),registry:p.registry,pool:p.pool,position:p.position(signer.pubkey()),vault:p.vault,user_token:token,token_program:support::token_program(),test_vault:p.test_vault()},i::Withdraw{amount});
    p.h.send("withdraw_selected_collateral",&[instruction],&[&signer],success);p.assert_vault();
}
fn refund_token(p:&mut PoolHarness,nonce:u64,token:Pubkey,amount:Option<u64>,success:bool){
    let signer=p.h.alice.insecure_clone();let keys=a::Refund{owner:signer.pubkey(),registry:p.registry,pool:p.pool,request:p.request(nonce),position:p.position(signer.pubkey()),vault:p.vault,user_token:token,token_program:support::token_program(),test_vault:p.test_vault()};
    let instruction=if let Some(amount)=amount{Harness::instruction(keys,i::RefundPartial{amount})}else{Harness::instruction(keys,i::Refund{})};
    p.h.send("refund_selected_collateral",&[instruction],&[&signer],success);p.assert_vault();
}
fn stored_pool(p:&mut PoolHarness,value:&Pool){let mut account=p.h.svm.get_account(&p.pool).unwrap();account.data.fill(0);value.try_serialize(&mut account.data.as_mut_slice()).unwrap();p.h.svm.set_account(p.pool,account).unwrap();}

#[cfg(not(feature="devnet-collateral"))]
#[test]
fn production_build_refuses_secondary_collateral_configuration_and_rolls_back_vault_creation(){
    let mut p=PoolHarness::new_adaptive(2);let mut pool=p.pool_state();pool.initialized=false;stored_pool(&mut p,&pool);
    p.configure_secondary(false);assert!(p.pool_state().test_collateral_mint.is_none());assert!(p.h.svm.get_account(&pda(&[b"test-vault",p.pool.as_ref()])).is_none());
}

#[test]
fn old_instruction_account_lists_can_omit_the_new_trailing_optional_account(){
    let mut p=PoolHarness::new_adaptive(2);p.h.time(ORIGIN+1);let signer=p.h.alice.insecure_clone();
    let mut instruction=Harness::instruction(p.submit_accounts(signer.pubkey(),p.h.alice_token),i::Deposit{to:0,amount:10,minimum_units:0,expiry:100});
    assert_eq!(instruction.accounts.last().unwrap().pubkey,cox::ID);instruction.accounts.pop();
    p.h.send("legacy_account_list",&[instruction],&[&signer],true);assert_eq!(p.pool_state().pending,10);
}

#[cfg(feature="devnet-collateral")]
#[test]
fn both_mints_back_one_ledger_and_either_mint_can_pay_a_position(){
    let mut p=PoolHarness::new_adaptive_dual(2);let (_,alice_test,bob_test)=p.secondary.unwrap();p.h.time(ORIGIN+1);
    let alice=deposit_token(&mut p,false,alice_test,40_000_000,true);p.deposit(true,0,60_000_000,0,100,true);
    p.h.time(ORIGIN+2);p.publish_adaptive(2,vec![100_000_000;2],100*cox_math::SCALE,true);p.finish();
    assert_eq!(p.pool_state().active,100_000_000);assert_eq!(p.h.token_balance(p.vault),60_000_000);assert_eq!(p.h.token_balance(p.test_vault().unwrap()),40_000_000);
    let request:Request=p.h.read(p.request(alice));p.h.time(ORIGIN+3);p.redeem(false,0,request.minted,0,100,true);
    p.h.time(ORIGIN+4);p.publish_adaptive(4,vec![100_000_000;2],100*cox_math::SCALE,true);p.finish();let destination=p.h.alice_token;withdraw_token(&mut p,false,destination,40_000_000,true);
    let request:Request=p.h.read(p.request(1));p.h.time(ORIGIN+5);p.redeem(true,0,request.minted,0,100,true);
    p.h.time(ORIGIN+6);p.publish_adaptive(6,vec![100_000_000;2],100*cox_math::SCALE,true);p.finish();
    withdraw_token(&mut p,true,bob_test,40_000_000,true);let destination=p.h.bob_token;withdraw_token(&mut p,true,destination,20_000_000,true);assert_eq!(p.pool_state().active+p.pool_state().pending+p.pool_state().payable,0);p.assert_vault();
}

#[cfg(feature="devnet-collateral")]
#[test]
fn partial_refunds_recover_the_full_principal_when_liquidity_is_split_between_mints(){
    let mut p=PoolHarness::new_adaptive_dual(2);let (_,alice_test,bob_test)=p.secondary.unwrap();p.h.time(ORIGIN+1);p.deposit(true,0,80_000_000,0,100,true);
    p.h.time(ORIGIN+2);p.publish_adaptive(2,vec![100_000_000;2],100*cox_math::SCALE,true);p.finish();
    p.h.time(ORIGIN+3);let nonce=deposit_token(&mut p,false,alice_test,100_000_000,true);p.cancel(nonce,false,true);
    let bob:Request=p.h.read(p.request(0));p.redeem(true,0,bob.minted,0,100,true);p.h.time(ORIGIN+4);p.publish_adaptive(4,vec![100_000_000;2],100*cox_math::SCALE,true);p.finish();withdraw_token(&mut p,true,bob_test,80_000_000,true);
    assert_eq!(p.h.token_balance(p.vault),80_000_000);assert_eq!(p.h.token_balance(p.test_vault().unwrap()),20_000_000);
    let primary=p.h.alice_token;let pool_before=p.h.svm.get_account(&p.pool).unwrap().data;refund_token(&mut p,nonce,primary,None,false);assert_eq!(p.h.svm.get_account(&p.pool).unwrap().data,pool_before);
    refund_token(&mut p,nonce,primary,Some(0),false);refund_token(&mut p,nonce,primary,Some(100_000_001),false);refund_token(&mut p,nonce,primary,Some(80_000_000),true);
    let request:Request=p.h.read(p.request(nonce));assert_eq!(request.amount,100_000_000);assert_eq!(request.refunded_amount,80_000_000);assert_ne!(request.status,6);assert_eq!(p.pool_state().pending,20_000_000);
    refund_token(&mut p,nonce,alice_test,None,true);let request:Request=p.h.read(p.request(nonce));assert_eq!(request.refunded_amount,request.amount);assert_eq!(request.status,6);assert_eq!(p.pool_state().pending,0);refund_token(&mut p,nonce,alice_test,Some(1),false);
}

#[cfg(feature="devnet-collateral")]
#[test]
fn missing_substituted_delegated_or_short_secondary_vault_fails_closed(){
    let mut p=PoolHarness::new_adaptive_dual(2);let (_,alice_test,_)=p.secondary.unwrap();p.h.time(ORIGIN+1);let signer=p.h.alice.insecure_clone();
    let keys=p.submit_accounts(signer.pubkey(),alice_test);let mut instruction=Harness::instruction(keys,i::Deposit{to:0,amount:10,minimum_units:0,expiry:100});
    let real=instruction.accounts.pop().unwrap();p.h.send("missing_test_vault",&[instruction.clone()],&[&signer],false);instruction.accounts.push(AccountMeta::new(p.vault,false));p.h.send("aliased_test_vault",&[instruction.clone()],&[&signer],false);instruction.accounts.pop();instruction.accounts.push(real);
    let test=p.test_vault().unwrap();let original=p.h.svm.get_account(&test).unwrap();let mut delegated=original.clone();delegated.data[72..76].copy_from_slice(&1u32.to_le_bytes());delegated.data[76..108].copy_from_slice(signer.pubkey().as_ref());p.h.svm.set_account(test,delegated).unwrap();p.h.send("delegated_test_vault",&[instruction.clone()],&[&signer],false);p.h.svm.set_account(test,original).unwrap();
    p.h.send("valid_test_deposit",&[instruction],&[&signer],true);let mut short=p.h.svm.get_account(&test).unwrap();short.data[64..72].copy_from_slice(&9u64.to_le_bytes());p.h.svm.set_account(test,short).unwrap();
    let pool_before=p.h.svm.get_account(&p.pool).unwrap().data;p.h.time(ORIGIN+2);
    let state=p.pool_state();let runtime=p.h.runtime.insecure_clone();let timestamp=ORIGIN+2;let benchmark=100*cox_math::SCALE;
    let prices=vec![cox::PriceWire{price_e8:100_000_000,venue:3,step:0,candle_start:timestamp,trade_age_minutes:0};2];
    let snapshot=cox_math::artifact_digest(&cox::adaptive_snapshot_bytes(timestamp,benchmark,&p.roster,&prices).unwrap());
    let instruction=Harness::instruction(a::Publish{payer:runtime.pubkey(),runtime:runtime.pubkey(),registry:p.registry,pool:p.pool,methodology:p.methodology,batch:pda(&[b"batch",p.pool.as_ref()]),vault:p.vault,system_program:solana_sdk::system_program::ID,test_vault:p.test_vault()},i::PublishAdaptive{batch_id:2,sequence:state.sequence+1,predecessor:state.state_digest,prices,snapshot,archive_time:timestamp,benchmark});
    p.h.send("reject_short_secondary_vault",&[instruction],&[&runtime],false);assert_eq!(p.h.svm.get_account(&p.pool).unwrap().data,pool_before);assert_eq!(p.h.token_balance(test),9);
}

#[cfg(feature="devnet-collateral")]
#[test]
fn secondary_surplus_is_residual_and_dual_retirement_is_explicitly_rejected(){
    let mut p=PoolHarness::new_adaptive_dual(2);let (_,alice_test,_)=p.secondary.unwrap();let alice=p.h.alice.insecure_clone();p.h.transfer(alice_test,p.test_vault().unwrap(),7,&alice);
    p.h.time(ORIGIN+1);p.publish_adaptive(1,vec![100_000_000;2],100*cox_math::SCALE,true);p.finish();assert_eq!(p.pool_state().residual,7);p.assert_vault();
    let admin=p.h.admin.insecure_clone();p.h.send("pause",&[Harness::instruction(a::Admin{admin:admin.pubkey(),registry:p.registry},i::Pause{})],&[&admin],true);
    let instruction=Harness::instruction(a::BeginRetirement{admin:admin.pubkey(),registry:p.registry,pool:p.pool,retirement:pda(&[b"retirement",p.pool.as_ref()]),vault:p.vault,system_program:solana_sdk::system_program::ID,test_vault:p.test_vault()},i::BeginRetirement{});
    p.h.send("reject_dual_retirement",&[instruction],&[&admin],false);assert_eq!(p.pool_state().schema_version,4);assert_eq!(p.pool_state().test_collateral_mint,p.secondary.map(|value|value.0));
}
