use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke,
    program_error::ProgramError,
    program_pack::Pack,
    pubkey,
};
use anchor_spl::token::spl_token::{self, state::Account as TokenAccount};

pub const JUPITER: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
pub const COX: Pubkey = pubkey!("G6iQGoupNSfduw1QJxQ9vcVi9FnCC6cbippXsi4QQzJF");
const TOKEN_2022: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const SWAP_AND_DEPOSIT: [u8; 8] = [50, 21, 140, 74, 249, 6, 205, 24];
pub const ROUTE: [u8; 8] = [229, 23, 203, 151, 122, 227, 173, 42];
pub const ROUTE_V2: [u8; 8] = [187, 100, 250, 204, 49, 196, 175, 20];
pub const SHARED_ROUTE_V2: [u8; 8] = [209, 152, 83, 147, 124, 254, 216, 233];
pub const SHARED_ROUTE: [u8; 8] = [193, 32, 155, 51, 65, 214, 156, 129];

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct SwapAndDeposit {
    pub target_class: u8,
    pub input_amount: u64,
    pub minimum_collateral: u64,
    pub minimum_units: u128,
    pub expiry: u64,
    pub expected_fee_version: u64,
    pub route_data: Vec<u8>,
}

#[derive(AnchorSerialize)]
struct DepositWithFee {
    to: u8,
    amount: u64,
    minimum_units: u128,
    expiry: u64,
    expected_fee_version: u64,
}

impl DepositWithFee {
    fn data(&self) -> core::result::Result<Vec<u8>, ProgramError> {
        let mut bytes = vec![117, 231, 72, 140, 0, 185, 162, 113];
        self.serialize(&mut bytes).map_err(|_| ProgramError::InvalidInstructionData)?;
        Ok(bytes)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum RouterError {
    InvalidAccounts = 7000,
    UnsupportedRoute,
    InvalidAmount,
    UnexpectedInputSpend,
    InsufficientOutput,
    CollateralChanged,
}

impl From<RouterError> for ProgramError {
    fn from(error: RouterError) -> Self {
        Self::Custom(error as u32)
    }
}

#[cfg(not(feature = "no-entrypoint"))]
anchor_lang::solana_program::entrypoint!(process_instruction);

fn token(account: &AccountInfo, owner: &Pubkey) -> core::result::Result<TokenAccount, ProgramError> {
    if account.owner != &spl_token::ID || !account.is_writable {
        return Err(RouterError::InvalidAccounts.into());
    }
    let state = TokenAccount::unpack(&account.try_borrow_data()?)?;
    if state.owner != *owner || state.state != spl_token::state::AccountState::Initialized {
        return Err(RouterError::InvalidAccounts.into());
    }
    Ok(state)
}

fn unchanged_authority(before: &TokenAccount, after: &TokenAccount) -> bool {
    before.mint == after.mint && before.owner == after.owner
        && before.delegate == after.delegate && before.delegated_amount == after.delegated_amount
        && before.close_authority == after.close_authority && before.is_native == after.is_native
}

pub fn output_delta(before: u64, after: u64, minimum: u64) -> core::result::Result<u64, ProgramError> {
    let output = after.checked_sub(before).ok_or(RouterError::InsufficientOutput)?;
    if output == 0 || output < minimum {
        return Err(RouterError::InsufficientOutput.into());
    }
    Ok(output)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RouteKind { Direct, Shared, DirectV2, SharedV2 }

fn route_layout(data: &[u8], input_amount: u64) -> core::result::Result<RouteKind, ProgramError> {
    if data.len() < 31 { return Err(RouterError::UnsupportedRoute.into()); }
    let discriminator: [u8; 8] = data[..8].try_into().unwrap();
    let kind = match discriminator {
        ROUTE => RouteKind::Direct,
        SHARED_ROUTE => RouteKind::Shared,
        ROUTE_V2 => RouteKind::DirectV2,
        SHARED_ROUTE_V2 => RouteKind::SharedV2,
        _ => return Err(RouterError::UnsupportedRoute.into()),
    };
    let v2 = matches!(kind, RouteKind::DirectV2 | RouteKind::SharedV2);
    let fields = if v2 {
        let start = if kind == RouteKind::SharedV2 { 9 } else { 8 };
        data.get(start..start + 26).ok_or(RouterError::UnsupportedRoute)?
    } else {
        &data[data.len() - 19..]
    };
    let amount = u64::from_le_bytes(fields[..8].try_into().unwrap());
    let quoted = u64::from_le_bytes(fields[8..16].try_into().unwrap());
    let slippage = u16::from_le_bytes(fields[16..18].try_into().unwrap());
    let fees = if v2 { fields[18..22].iter().any(|byte| *byte != 0) } else { fields[18] != 0 };
    if amount != input_amount || quoted == 0 || slippage > 10_000 || fees {
        return Err(RouterError::InvalidAmount.into());
    }
    Ok(kind)
}

pub fn process_instruction(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 8 || data[..8] != SWAP_AND_DEPOSIT {
        return Err(ProgramError::InvalidInstructionData);
    }
    let args = SwapAndDeposit::try_from_slice(&data[8..])
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    if args.input_amount == 0 || args.minimum_collateral == 0 || accounts.len() < 21 {
        return Err(RouterError::InvalidAmount.into());
    }
    let owner = &accounts[0];
    let collateral_account = &accounts[6];
    let input_account = &accounts[9];
    if !owner.is_signer || !owner.is_writable
        || accounts[7].key != &spl_token::ID
        || accounts[8].key != &anchor_lang::system_program::ID
        || accounts[10].key != &JUPITER || !accounts[10].executable
        || accounts[11].key != &COX || !accounts[11].executable
        || input_account.key == collateral_account.key
    {
        return Err(RouterError::InvalidAccounts.into());
    }
    let input_before = token(input_account, owner.key)?;
    let collateral_before = token(collateral_account, owner.key)?;
    if input_before.mint == collateral_before.mint || input_before.amount < args.input_amount {
        return Err(RouterError::InvalidAmount.into());
    }
    let kind = route_layout(&args.route_data, args.input_amount)?;
    let route = &accounts[12..];
    let expected = match kind { RouteKind::Direct => 9, RouteKind::Shared => 13, RouteKind::DirectV2 => 10, RouteKind::SharedV2 => 12 };
    if route.len() < expected {
        return Err(RouterError::InvalidAccounts.into());
    }
    let event_authority = Pubkey::find_program_address(&[b"__event_authority"], &JUPITER).0;
    let bindings: Vec<(usize, Pubkey)> = match kind { RouteKind::Shared => {
        vec![(0, spl_token::ID), (2, *owner.key), (3, *input_account.key),
             (6, *collateral_account.key), (7, input_before.mint), (8, collateral_before.mint),
             (9, JUPITER), (10, JUPITER), (11, event_authority), (12, JUPITER)]
    }, RouteKind::Direct => {
        vec![(0, spl_token::ID), (1, *owner.key), (2, *input_account.key),
             (3, *collateral_account.key), (5, collateral_before.mint), (6, JUPITER), (7, event_authority), (8, JUPITER)]
    }, RouteKind::DirectV2 => {
        vec![(0, *owner.key), (1, *input_account.key), (2, *collateral_account.key),
            (3, input_before.mint), (4, collateral_before.mint), (5, spl_token::ID), (6, spl_token::ID), (8, event_authority), (9, JUPITER)]
    }, RouteKind::SharedV2 => {
        vec![(1, *owner.key), (2, *input_account.key), (5, *collateral_account.key),
            (6, input_before.mint), (7, collateral_before.mint), (8, spl_token::ID), (9, spl_token::ID), (10, event_authority), (11, JUPITER)]
    }};
    if bindings.iter().any(|(index, key)| route[*index].key != key)
        || (kind == RouteKind::Direct && route[4].key != &JUPITER && route[4].key != collateral_account.key)
        || (kind == RouteKind::DirectV2 && route[7].key != &JUPITER && route[7].key != collateral_account.key)
    {
        return Err(RouterError::InvalidAccounts.into());
    }
    let mut metas = Vec::with_capacity(route.len());
    for account in route {
        if accounts[1..6].iter().any(|protected| protected.key == account.key)
            || account.key == &COX
            || account.owner == &TOKEN_2022
            || (account.is_signer && account.key != owner.key)
        {
            return Err(RouterError::InvalidAccounts.into());
        }
        if account.owner == &spl_token::ID && account.key != input_account.key && account.key != collateral_account.key {
            if let Ok(state) = TokenAccount::unpack(&account.try_borrow_data()?) {
                if state.owner == *owner.key || state.delegate == anchor_lang::solana_program::program_option::COption::Some(*owner.key) {
                    return Err(RouterError::InvalidAccounts.into());
                }
            }
        }
        metas.push(AccountMeta {
            pubkey: *account.key,
            is_signer: account.key == owner.key,
            is_writable: account.is_writable && account.key != owner.key,
        });
    }
    invoke(&Instruction { program_id: JUPITER, accounts: metas, data: args.route_data }, route)?;
    let input_after = token(input_account, owner.key)?;
    let collateral_after = token(collateral_account, owner.key)?;
    if !unchanged_authority(&input_before, &input_after) || !unchanged_authority(&collateral_before, &collateral_after) {
        return Err(RouterError::InvalidAccounts.into());
    }
    if input_before.amount.checked_sub(input_after.amount) != Some(args.input_amount) {
        return Err(RouterError::UnexpectedInputSpend.into());
    }
    let amount = output_delta(collateral_before.amount, collateral_after.amount, args.minimum_collateral)?;
    let deposit = DepositWithFee {
        to: args.target_class,
        amount,
        minimum_units: args.minimum_units,
        expiry: args.expiry,
        expected_fee_version: args.expected_fee_version,
    };
    let metas = accounts[..9].iter().enumerate().map(|(index, account)| AccountMeta {
        pubkey: *account.key,
        is_signer: index == 0,
        is_writable: matches!(index, 0 | 2 | 3 | 4 | 5 | 6),
    }).collect();
    let mut deposit_accounts = accounts[..9].to_vec();
    deposit_accounts.push(accounts[11].clone());
    invoke(&Instruction { program_id: COX, accounts: metas, data: deposit.data()? }, &deposit_accounts)?;
    if token(collateral_account, owner.key)?.amount != collateral_before.amount {
        return Err(RouterError::CollateralChanged.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::InstructionData;
    use anchor_lang::solana_program::{program_option::COption, program_stubs::{set_syscall_stubs, SyscallStubs}};
    use std::sync::{Arc, Mutex};

    static SYSCALL_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn deposit_encoding_matches_generated_cox_abi() {
        assert_eq!(COX, cox::ID);
        for amount in [1, 113, u64::MAX] {
            let encoded = DepositWithFee { to: 2, amount, minimum_units: u128::MAX,
                expiry: u64::MAX, expected_fee_version: 3 }.data().unwrap();
            let generated = cox::instruction::DepositWithFee { to: 2, amount, minimum_units: u128::MAX,
                expiry: u64::MAX, expected_fee_version: 3 }.data();
            assert_eq!(encoded, generated);
        }
    }

    #[derive(Clone, Copy)]
    enum TokenMutation { None, Delegate, CloseAuthority, Native, Owner, Mint }

    struct CpiStub {
        deposited: Arc<Mutex<Vec<u64>>>,
        output: u64,
        fail_swap: bool,
        fail_deposit: bool,
        input_spend: u64,
        mutation: TokenMutation,
    }

    impl SyscallStubs for CpiStub {
        fn sol_invoke_signed(&self, ix: &Instruction, infos: &[AccountInfo], _seeds: &[&[&[u8]]]) -> ProgramResult {
            if ix.program_id == JUPITER {
                if self.fail_swap { return Err(ProgramError::Custom(91)); }
                let (source_index, destination_index) = match ix.data[..8].try_into().unwrap() {
                    ROUTE => (2, 3), SHARED_ROUTE => (3, 6), ROUTE_V2 => (1, 2), SHARED_ROUTE_V2 => (2, 5),
                    _ => panic!("unsupported test CPI"),
                };
                let mut source = TokenAccount::unpack(&infos[source_index].try_borrow_data()?)?;
                let mut destination = TokenAccount::unpack(&infos[destination_index].try_borrow_data()?)?;
                source.amount -= self.input_spend;
                destination.amount += self.output;
                match self.mutation {
                    TokenMutation::None => {},
                    TokenMutation::Delegate => {
                        source.delegate = COption::Some(Pubkey::new_unique());
                        source.delegated_amount = 1;
                    },
                    TokenMutation::CloseAuthority => destination.close_authority = COption::Some(Pubkey::new_unique()),
                    TokenMutation::Native => source.is_native = COption::Some(1),
                    TokenMutation::Owner => destination.owner = Pubkey::new_unique(),
                    TokenMutation::Mint => source.mint = Pubkey::new_unique(),
                }
                TokenAccount::pack(source, &mut infos[source_index].try_borrow_mut_data()?)?;
                TokenAccount::pack(destination, &mut infos[destination_index].try_borrow_mut_data()?)?;
                return Ok(());
            }
            assert_eq!(ix.program_id, cox::ID);
            if self.fail_deposit { return Err(ProgramError::Custom(92)); }
            assert_eq!(&ix.data[..8], &cox::instruction::DepositWithFee::DISCRIMINATOR[..]);
            assert_eq!(ix.data[8], 2);
            let amount = u64::from_le_bytes(ix.data[9..17].try_into().unwrap());
            assert_eq!(u128::from_le_bytes(ix.data[17..33].try_into().unwrap()), 44);
            assert_eq!(u64::from_le_bytes(ix.data[33..41].try_into().unwrap()), 7);
            assert_eq!(u64::from_le_bytes(ix.data[41..49].try_into().unwrap()), 3);
            let mut collateral = TokenAccount::unpack(&infos[6].try_borrow_data()?)?;
            collateral.amount -= amount;
            TokenAccount::pack(collateral, &mut infos[6].try_borrow_mut_data()?)?;
            self.deposited.lock().unwrap().push(amount);
            Ok(())
        }
    }

    fn account(key: Pubkey, owner: Pubkey, signer: bool, writable: bool, executable: bool, data: Vec<u8>) -> AccountInfo<'static> {
        AccountInfo::new(Box::leak(Box::new(key)), signer, writable, Box::leak(Box::new(1_000_000)), Box::leak(data.into_boxed_slice()), Box::leak(Box::new(owner)), executable, 0)
    }

    fn token_account(owner: Pubkey, mint: Pubkey, amount: u64) -> AccountInfo<'static> {
        let mut data = vec![0; TokenAccount::LEN];
        TokenAccount::pack(TokenAccount { mint, owner, amount, delegate: COption::None,
            state: spl_token::state::AccountState::Initialized, is_native: COption::None,
            delegated_amount: 0, close_authority: COption::None }, &mut data).unwrap();
        account(Pubkey::new_unique(), spl_token::ID, false, true, false, data)
    }

    fn fixture(old_collateral: u64) -> (Vec<AccountInfo<'static>>, Vec<u8>) {
        let owner = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let mut accounts: Vec<_> = (0..12).map(|_| account(Pubkey::new_unique(), anchor_lang::system_program::ID, false, true, false, vec![])).collect();
        accounts[0] = account(owner, anchor_lang::system_program::ID, true, true, false, vec![]);
        accounts[6] = token_account(owner, mint, old_collateral);
        accounts[7] = account(spl_token::ID, Pubkey::new_unique(), false, false, true, vec![]);
        accounts[8] = account(anchor_lang::system_program::ID, Pubkey::new_unique(), false, false, true, vec![]);
        accounts[9] = token_account(owner, Pubkey::new_unique(), 25);
        accounts[10] = account(JUPITER, Pubkey::new_unique(), false, false, true, vec![]);
        accounts[11] = account(cox::ID, Pubkey::new_unique(), false, false, true, vec![]);
        let output_mint = account(mint, spl_token::ID, false, false, false, vec![]);
        let event = account(Pubkey::find_program_address(&[b"__event_authority"], &JUPITER).0, JUPITER, false, false, false, vec![]);
        accounts.extend([accounts[7].clone(), accounts[0].clone(), accounts[9].clone(), accounts[6].clone(), accounts[10].clone(), output_mint, accounts[10].clone(), event, accounts[10].clone()]);
        let mut route_data = ROUTE.to_vec();
        route_data.extend(0_u32.to_le_bytes());
        route_data.extend(12_u64.to_le_bytes());
        route_data.extend(100_u64.to_le_bytes());
        route_data.extend(50_u16.to_le_bytes());
        route_data.push(0);
        let args = SwapAndDeposit { target_class: 2, input_amount: 12, minimum_collateral: 100,
            minimum_units: 44, expiry: 7, expected_fee_version: 3, route_data };
        let mut data = SWAP_AND_DEPOSIT.to_vec();
        args.serialize(&mut data).unwrap();
        (accounts, data)
    }

    #[test]
    fn cpi_pipeline_queues_actual_output_and_forwards_user_protections() {
        let _guard = SYSCALL_LOCK.lock().unwrap();
        for old in [0, 2_000] {
            let deposited = Arc::new(Mutex::new(vec![]));
            let previous = set_syscall_stubs(Box::new(CpiStub { deposited: deposited.clone(), output: 113, fail_swap: false, fail_deposit: false, input_spend: 12, mutation: TokenMutation::None }));
            let (accounts, data) = fixture(old);
            let result = process_instruction(&Pubkey::new_unique(), &accounts, &data);
            set_syscall_stubs(previous);
            result.unwrap();
            assert_eq!(*deposited.lock().unwrap(), vec![113]);
            assert_eq!(token(&accounts[6], accounts[0].key).unwrap().amount, old);
            assert_eq!(token(&accounts[9], accounts[0].key).unwrap().amount, 13);
        }
    }

    #[test]
    fn cpi_failure_and_output_floor_fail_the_whole_instruction() {
        let _guard = SYSCALL_LOCK.lock().unwrap();
        for (output, fail_swap, fail_deposit, expected) in [
            (113, true, false, ProgramError::Custom(91)),
            (99, false, false, RouterError::InsufficientOutput.into()),
            (113, false, true, ProgramError::Custom(92)),
        ] {
            let deposited = Arc::new(Mutex::new(vec![]));
            let previous = set_syscall_stubs(Box::new(CpiStub { deposited: deposited.clone(), output, fail_swap, fail_deposit, input_spend: 12, mutation: TokenMutation::None }));
            let (accounts, data) = fixture(2_000);
            let result = process_instruction(&Pubkey::new_unique(), &accounts, &data);
            set_syscall_stubs(previous);
            assert_eq!(result, Err(expected));
            assert!(deposited.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn substituted_authority_and_protected_pool_accounts_are_rejected_before_cpi() {
        let (mut accounts, data) = fixture(2_000);
        accounts[13] = accounts[2].clone();
        assert_eq!(process_instruction(&Pubkey::new_unique(), &accounts, &data), Err(RouterError::InvalidAccounts.into()));
        let (mut accounts, data) = fixture(2_000);
        accounts.push(accounts[5].clone());
        assert_eq!(process_instruction(&Pubkey::new_unique(), &accounts, &data), Err(RouterError::InvalidAccounts.into()));
        let (mut accounts, data) = fixture(2_000);
        accounts.push(account(Pubkey::new_unique(), TOKEN_2022, false, true, false, vec![0; 200]));
        assert_eq!(process_instruction(&Pubkey::new_unique(), &accounts, &data), Err(RouterError::InvalidAccounts.into()));
    }

    #[test]
    fn swap_cannot_leave_a_new_token_delegate_behind() {
        let _guard = SYSCALL_LOCK.lock().unwrap();
        let deposited = Arc::new(Mutex::new(vec![]));
        let previous = set_syscall_stubs(Box::new(CpiStub { deposited: deposited.clone(), output: 113,
            fail_swap: false, fail_deposit: false, input_spend: 12, mutation: TokenMutation::Delegate }));
        let (accounts, data) = fixture(2_000);
        let result = process_instruction(&Pubkey::new_unique(), &accounts, &data);
        set_syscall_stubs(previous);
        assert_eq!(result, Err(RouterError::InvalidAccounts.into()));
        assert!(deposited.lock().unwrap().is_empty());
    }

    #[test]
    fn shared_legacy_route_queues_full_output() {
        let _guard = SYSCALL_LOCK.lock().unwrap();
        let (mut accounts, data) = fixture(2_000);
        let mut args = SwapAndDeposit::try_from_slice(&data[8..]).unwrap();
        let output_mint = accounts[17].clone();
        let event = accounts[19].clone();
        let input_mint = account(token(&accounts[9], accounts[0].key).unwrap().mint, spl_token::ID, false, false, false, vec![]);
        let authority = account(Pubkey::new_unique(), JUPITER, false, false, false, vec![]);
        let intermediate_source = token_account(*authority.key, *input_mint.key, 0);
        let intermediate_destination = token_account(*authority.key, *output_mint.key, 0);
        accounts.truncate(12);
        accounts.extend([accounts[7].clone(), authority, accounts[0].clone(), accounts[9].clone(),
            intermediate_source, intermediate_destination, accounts[6].clone(), input_mint, output_mint,
            accounts[10].clone(), accounts[10].clone(), event, accounts[10].clone()]);
        args.route_data[..8].copy_from_slice(&SHARED_ROUTE);
        args.route_data.insert(8, 0);
        let mut data = SWAP_AND_DEPOSIT.to_vec();
        args.serialize(&mut data).unwrap();
        let deposited = Arc::new(Mutex::new(vec![]));
        let previous = set_syscall_stubs(Box::new(CpiStub { deposited: deposited.clone(), output: 113,
            fail_swap: false, fail_deposit: false, input_spend: 12, mutation: TokenMutation::None }));
        let result = process_instruction(&Pubkey::new_unique(), &accounts, &data);
        set_syscall_stubs(previous);
        result.unwrap();
        assert_eq!(*deposited.lock().unwrap(), vec![113]);
        assert_eq!(token(&accounts[6], accounts[0].key).unwrap().amount, 2_000);
    }

    #[test]
    fn extra_signers_and_other_wallet_token_authorities_are_rejected() {
        let _guard = SYSCALL_LOCK.lock().unwrap();
        for case in 0..3 {
            let (mut accounts, data) = fixture(2_000);
            let extra = if case == 0 {
                account(Pubkey::new_unique(), anchor_lang::system_program::ID, true, false, false, vec![])
            } else {
                let extra = token_account(if case == 1 { *accounts[0].key } else { Pubkey::new_unique() }, Pubkey::new_unique(), 10);
                if case == 2 {
                    let mut state = TokenAccount::unpack(&extra.try_borrow_data().unwrap()).unwrap();
                    state.delegate = COption::Some(*accounts[0].key);
                    state.delegated_amount = 10;
                    TokenAccount::pack(state, &mut extra.try_borrow_mut_data().unwrap()).unwrap();
                }
                extra
            };
            accounts.push(extra);
            let deposited = Arc::new(Mutex::new(vec![]));
            let previous = set_syscall_stubs(Box::new(CpiStub { deposited: deposited.clone(), output: 113,
                fail_swap: true, fail_deposit: false, input_spend: 12, mutation: TokenMutation::None }));
            let result = process_instruction(&Pubkey::new_unique(), &accounts, &data);
            set_syscall_stubs(previous);
            assert_eq!(result, Err(RouterError::InvalidAccounts.into()));
            assert!(deposited.lock().unwrap().is_empty());
            assert_eq!(token(&accounts[9], accounts[0].key).unwrap().amount, 25);
        }
    }

    #[test]
    fn swap_must_spend_exact_signed_input() {
        let _guard = SYSCALL_LOCK.lock().unwrap();
        for input_spend in [0, 11, 13, 25] {
            let (accounts, data) = fixture(2_000);
            let deposited = Arc::new(Mutex::new(vec![]));
            let previous = set_syscall_stubs(Box::new(CpiStub { deposited: deposited.clone(), output: 113,
                fail_swap: false, fail_deposit: false, input_spend, mutation: TokenMutation::None }));
            let result = process_instruction(&Pubkey::new_unique(), &accounts, &data);
            set_syscall_stubs(previous);
            assert_eq!(result, Err(RouterError::UnexpectedInputSpend.into()));
            assert!(deposited.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn swap_cannot_mutate_owner_mint_close_authority_or_native_state() {
        let _guard = SYSCALL_LOCK.lock().unwrap();
        for mutation in [TokenMutation::CloseAuthority, TokenMutation::Native, TokenMutation::Owner, TokenMutation::Mint] {
            let (accounts, data) = fixture(2_000);
            let deposited = Arc::new(Mutex::new(vec![]));
            let previous = set_syscall_stubs(Box::new(CpiStub { deposited: deposited.clone(), output: 113,
                fail_swap: false, fail_deposit: false, input_spend: 12, mutation }));
            let result = process_instruction(&Pubkey::new_unique(), &accounts, &data);
            set_syscall_stubs(previous);
            assert_eq!(result, Err(RouterError::InvalidAccounts.into()));
            assert!(deposited.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn v2_direct_and_shared_cpi_bindings_queue_full_output() {
        let _guard = SYSCALL_LOCK.lock().unwrap();
        for shared in [false, true] {
            let (mut accounts, data) = fixture(2_000);
            let mut args = SwapAndDeposit::try_from_slice(&data[8..]).unwrap();
            let event = accounts[19].clone();
            let output_mint = accounts[17].clone();
            let input_mint = account(token(&accounts[9], accounts[0].key).unwrap().mint, spl_token::ID, false, false, false, vec![]);
            let authority = account(Pubkey::new_unique(), JUPITER, false, false, false, vec![]);
            let intermediate_source = token_account(*authority.key, *input_mint.key, 0);
            let intermediate_destination = token_account(*authority.key, *output_mint.key, 0);
            accounts.truncate(12);
            let route_accounts = if shared {
                vec![authority, accounts[0].clone(), accounts[9].clone(), intermediate_source,
                    intermediate_destination, accounts[6].clone(), input_mint, output_mint,
                    accounts[7].clone(), accounts[7].clone(), event, accounts[10].clone()]
            } else {
                vec![accounts[0].clone(), accounts[9].clone(), accounts[6].clone(), input_mint,
                    output_mint, accounts[7].clone(), accounts[7].clone(), accounts[10].clone(), event, accounts[10].clone()]
            };
            accounts.extend(route_accounts);
            args.route_data = if shared { SHARED_ROUTE_V2.to_vec() } else { ROUTE_V2.to_vec() };
            if shared { args.route_data.push(0); }
            args.route_data.extend(12_u64.to_le_bytes());
            args.route_data.extend(100_u64.to_le_bytes());
            args.route_data.extend(50_u16.to_le_bytes());
            args.route_data.extend(0_u16.to_le_bytes());
            args.route_data.extend(0_u16.to_le_bytes());
            args.route_data.extend(0_u32.to_le_bytes());
            let mut data = SWAP_AND_DEPOSIT.to_vec();
            args.serialize(&mut data).unwrap();
            let deposited = Arc::new(Mutex::new(vec![]));
            let previous = set_syscall_stubs(Box::new(CpiStub { deposited: deposited.clone(), output: 113, fail_swap: false, fail_deposit: false, input_spend: 12, mutation: TokenMutation::None }));
            let result = process_instruction(&Pubkey::new_unique(), &accounts, &data);
            set_syscall_stubs(previous);
            result.unwrap();
            assert_eq!(*deposited.lock().unwrap(), vec![113]);
            assert_eq!(token(&accounts[6], accounts[0].key).unwrap().amount, 2_000);
        }
    }

    #[test]
    fn deposits_all_improvement_without_old_collateral() {
        assert_eq!(output_delta(2_000, 2_113, 100).unwrap(), 113);
        assert_eq!(output_delta(0, 113, 100).unwrap(), 113);
        assert!(output_delta(2_000, 2_099, 100).is_err());
        assert!(output_delta(2_000, 2_000, 0).is_err());
        assert!(output_delta(2_000, 1_999, 1).is_err());
        assert_eq!(output_delta(0, u64::MAX, 1).unwrap(), u64::MAX);
    }

    #[test]
    fn rejects_unsupported_routes_and_unbound_input_or_fees() {
        let mut route = ROUTE.to_vec();
        route.extend_from_slice(&0_u32.to_le_bytes());
        route.extend_from_slice(&12_u64.to_le_bytes());
        route.extend_from_slice(&100_u64.to_le_bytes());
        route.extend_from_slice(&50_u16.to_le_bytes());
        route.push(0);
        assert_eq!(route_layout(&route, 12).unwrap(), RouteKind::Direct);
        assert!(route_layout(&route, 11).is_err());
        *route.last_mut().unwrap() = 1;
        assert!(route_layout(&route, 12).is_err());
        *route.last_mut().unwrap() = 0;
        route[0] ^= 1;
        assert!(route_layout(&route, 12).is_err());
        assert!(route_layout(&[], 12).is_err());
    }
}
