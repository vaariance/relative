use crate::{
    chain::{ChainReader, ChainState},
    transactions::EpochAccounts,
    worker,
};
use anchor_lang::AccountDeserialize;
use solana_address::Address;
use solana_instruction::Instruction;
use std::path::Path;

pub const PREPARE_ID: &str = "epoch:current:prepare";
fn address(key: anchor_lang::prelude::Pubkey) -> Address {
    Address::new_from_array(key.to_bytes())
}
async fn accounts(
    reader: &ChainReader,
    keys: &[Address],
    owners: &[Address],
    slot: u64,
) -> Result<Vec<Option<(Vec<u8>, usize)>>, worker::Error> {
    let (_, rows) = reader
        .optional_accounts(keys, slot, "confirmed")
        .await
        .map_err(|_| worker::Error::Chain)?;
    rows.into_iter()
        .zip(owners)
        .map(|(row, owner)| {
            row.map(|row| {
                if row.owner != *owner {
                    return Err(worker::Error::Chain);
                }
                let size = row.data.len();
                Ok((row.data, size))
            })
            .transpose()
        })
        .collect()
}

fn decode<T: AccountDeserialize>(row: &(Vec<u8>, usize)) -> Result<T, worker::Error> {
    T::try_deserialize(&mut row.0.as_slice()).map_err(|_| worker::Error::Chain)
}
fn opening_manifest(
    directory: &Path,
    canonical: &[u8],
    opening: u64,
) -> Result<cox::UniverseVersion, worker::Error> {
    let mut current =
        cox::UniverseVersion::from_canonical(canonical).map_err(|_| worker::Error::Snapshot)?;
    for _ in 0..255 {
        if current.capture.timestamp <= opening {
            return Ok(current);
        }
        let receipt: crate::universe_runtime::Receipt = crate::journal::read(
            &directory
                .join("universes")
                .join(format!("{}.json", hex::encode(current.digest))),
        )
        .map_err(|_| worker::Error::Storage)?
        .ok_or(worker::Error::Storage)?;
        receipt.validate().map_err(|_| worker::Error::Storage)?;
        let previous = receipt.previous_canonical.ok_or(worker::Error::Snapshot)?;
        current =
            cox::UniverseVersion::from_canonical(&previous).map_err(|_| worker::Error::Snapshot)?;
    }
    Err(worker::Error::Snapshot)
}
pub async fn plan(
    reader: &ChainReader,
    state: &ChainState,
    directory: &Path,
    now_ms: u64,
) -> Result<Vec<Instruction>, worker::Error> {
    let config = &state.epoch_config;
    if config.lifecycle_version != 1
        || config.lifecycle != relative_epoch::ConfigLifecycle::Active
        || config.asset_registry == anchor_lang::prelude::Pubkey::default()
    {
        return Ok(vec![]);
    }
    let opens = now_ms / 1000 / cox_epoch::EPOCH_SECONDS * cox_epoch::EPOCH_SECONDS;
    if opens < state.basic.pool.trading_opens_at {
        return Ok(vec![]);
    }
    let epoch_accounts = EpochAccounts::derive(reader.epoch_program, reader.epoch_config, opens)
        .map_err(|_| worker::Error::Chain)?;
    if state.epochs.iter().any(|epoch| {
        epoch.epoch.opens_at == opens
            && (epoch.epoch.state.is_some() || epoch.epoch.empty_finalized)
    }) {
        return Ok(vec![]);
    }
    let registry_key = address(config.asset_registry);
    let rows = accounts(
        reader,
        &[registry_key, epoch_accounts.epoch],
        &[reader.basic_program, reader.epoch_program],
        state.slot,
    )
    .await?;
    let registry: cox::AssetRegistry = decode(rows[0].as_ref().ok_or(worker::Error::Chain)?)?;
    if registry.schema_version != 1
        || registry.source_pool.to_bytes() != state.basic.accounts.pool.to_bytes()
        || Address::find_program_address(
            &[b"asset-registry", &registry.generation],
            &reader.basic_program,
        )
        .0 != registry_key
    {
        return Err(worker::Error::Snapshot);
    }
    if registry.pending_activation != 0 && opens >= registry.pending_activation {
        return Ok(vec![]);
    }
    let universe = opening_manifest(directory, &state.basic.methodology.canonical, opens)?;
    let version_key = Address::find_program_address(
        &[b"asset-version", registry_key.as_ref(), &universe.digest],
        &reader.basic_program,
    )
    .0;
    let methodology =
        Address::find_program_address(&[b"methodology", &universe.digest], &reader.basic_program).0;
    let versions = accounts(reader, &[version_key], &[reader.basic_program], state.slot).await?;
    let version: cox::AssetRegistryVersion =
        decode(versions[0].as_ref().ok_or(worker::Error::Chain)?)?;
    if version.schema_version != 1
        || !version.sealed
        || version.registry != config.asset_registry
        || version.generation != registry.generation
        || version.digest != universe.digest
        || address(version.methodology) != methodology
        || version.effective_from > opens
        || (version.effective_until != 0 && opens >= version.effective_until)
        || (version.effective_until == 0 && address(registry.active_version) != version_key)
    {
        return Err(worker::Error::Snapshot);
    }
    let Some(row) = &rows[1] else {
        return Ok(vec![epoch_accounts.initialize_current(
            reader.operator,
            registry_key,
            version_key,
            methodology,
            address(config.mint),
            address(config.test_mint.unwrap_or(config.mint)),
            opens,
        )]);
    };
    let epoch: relative_epoch::EpochAccount = decode(row)?;
    if epoch.opens_at != opens
        || address(epoch.config) != reader.epoch_config
        || address(epoch.registry_version) != version_key
        || epoch.universe_digest != universe.digest
    {
        return Err(worker::Error::Snapshot);
    }
    if epoch.state.is_some() || epoch.empty_finalized {
        return Ok(vec![]);
    }
    let (name, args) = draft_operation(row.1, epoch.universe.len(), universe.instruments.len());
    Ok(vec![epoch_accounts.manage_current(
        reader.operator,
        registry_key,
        version_key,
        methodology,
        name,
        &args,
    )])
}

fn draft_operation(allocated: usize, copied: usize, total: usize) -> (&'static str, Vec<u8>) {
    if allocated < relative_epoch::EPOCH_SPACE {
        (
            "grow_current_epoch",
            ((relative_epoch::EPOCH_SPACE - allocated).min(relative_epoch::MAX_GROWTH) as u32)
                .to_le_bytes()
                .to_vec(),
        )
    } else if copied < total {
        let start = copied as u16;
        let count = (total - copied).min(relative_epoch::PAGE_SIZE) as u16;
        (
            "copy_registry_assets",
            [start.to_le_bytes(), count.to_le_bytes()].concat(),
        )
    } else {
        ("seal_current_epoch", vec![])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preparation_resumes_with_contract_bounded_growth_and_roster_pages() {
        let (name, bytes) = draft_operation(relative_epoch::INITIAL_SPACE, 0, 255);
        assert_eq!(name, "grow_current_epoch");
        assert_eq!(u32::from_le_bytes(bytes.try_into().unwrap()) as usize, relative_epoch::MAX_GROWTH);
        for total in [31, 255] {
            let mut copied = 0;
            while copied < total {
                let (name, bytes) = draft_operation(relative_epoch::EPOCH_SPACE, copied, total);
                assert_eq!(name, "copy_registry_assets");
                assert_eq!(u16::from_le_bytes(bytes[..2].try_into().unwrap()) as usize, copied);
                let count = u16::from_le_bytes(bytes[2..].try_into().unwrap()) as usize;
                assert!((1..=relative_epoch::PAGE_SIZE).contains(&count));
                copied += count;
            }
            assert_eq!(copied, total);
            assert_eq!(draft_operation(relative_epoch::EPOCH_SPACE, copied, total), ("seal_current_epoch", vec![]));
        }
    }
}
