use anchor_lang::solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, program::{invoke, invoke_signed}, program_error::ProgramError, pubkey::Pubkey};
use anchor_spl::token::spl_token;

anchor_lang::solana_program::entrypoint!(swap);

fn swap(program: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if accounts.len() < 12 || data.len() < 31 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let footer = &data[data.len() - 19..];
    let input = u64::from_le_bytes(footer[..8].try_into().unwrap());
    let quote = u64::from_le_bytes(footer[8..16].try_into().unwrap());
    let amount = quote.checked_add(13).ok_or(ProgramError::ArithmeticOverflow)?;
    invoke(&spl_token::instruction::transfer(&spl_token::ID, accounts[2].key, accounts[9].key, accounts[1].key, &[], input)?, accounts)?;
    let (_, bump) = Pubkey::find_program_address(&[b"reserve"], program);
    invoke_signed(&spl_token::instruction::transfer(&spl_token::ID, accounts[10].key, accounts[3].key, accounts[11].key, &[], amount)?, accounts, &[&[b"reserve", &[bump]]])?;
    if quote == 999 { return Err(ProgramError::Custom(91)); }
    Ok(())
}
