use crate::{
    backup::{self, Transport},
    changes::{self, Notification},
    journal,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub schema: String,
    pub timestamp_ms: u64,
    pub network: String,
    pub program: String,
    pub pool: String,
    pub chain_change: Notification,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Storage,
    Invalid,
    Conflict,
}
impl Record {
    pub fn new(
        program: &str,
        pool: &str,
        timestamp_ms: u64,
        chain_change: Notification,
    ) -> Result<Self, Error> {
        if program.parse::<solana_address::Address>().is_err()
            || pool.parse::<solana_address::Address>().is_err()
            || timestamp_ms == 0
            || chain_change.schema != "relative.chain-change/v1"
            || chain_change.commitment != "confirmed"
        {
            return Err(Error::Invalid);
        }
        Ok(Self {
            schema: "relative.chain-notification/v1".into(),
            timestamp_ms,
            network: "solana-devnet".into(),
            program: program.into(),
            pool: pool.into(),
            chain_change,
        })
    }
    pub fn name(&self) -> Result<String, Error> {
        let bytes = serde_json::to_vec(self).map_err(|_| Error::Invalid)?;
        Ok(format!(
            "{:020}-{}.json",
            self.timestamp_ms,
            hex::encode(Sha256::digest(bytes))
        ))
    }
}
pub async fn run<T: Transport>(
    transport: &T,
    prefix: &str,
    state: &Path,
    spool: &Path,
    program: &str,
    pool: &str,
    config: &crate::runtime::Config,
) -> Result<(), Error> {
    config.verify_state_identity().map_err(|_| Error::Invalid)?;
    let expected = config.publication_identity().map_err(|_| Error::Invalid)?;
    if expected.program != program
        || expected.pool != pool
        || prefix != format!("pool-{}/chain-changes", config.basic_pool_id)
    {
        return Err(Error::Invalid);
    }
    crate::runtime::bind_spool(config, spool, "chain-changes").map_err(|_| Error::Invalid)?;
    fs::create_dir_all(spool).map_err(|_| Error::Storage)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(spool, fs::Permissions::from_mode(0o700))
            .map_err(|_| Error::Storage)?;
    }
    let producer = produce(state, spool, program, pool);
    let consumer = consume(transport, prefix, spool, program, pool);
    tokio::try_join!(producer, consumer)?;
    Ok(())
}
async fn produce(state: &Path, spool: &Path, program: &str, pool: &str) -> Result<(), Error> {
    let mut last = None;
    let mut emitted = Instant::now();
    let mut interval = tokio::time::interval(Duration::from_millis(250));
    loop {
        interval.tick().await;
        let Some(notification) =
            changes::read(&state.join("chain-change.json")).map_err(|_| Error::Storage)?
        else {
            continue;
        };
        if last.as_ref() == Some(&notification) && emitted.elapsed() < Duration::from_secs(20) {
            continue;
        }
        if fs::read_dir(spool).map_err(|_| Error::Storage)?.count() >= 100_000 {
            return Err(Error::Storage);
        }
        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Error::Invalid)?
            .as_millis()
            .try_into()
            .map_err(|_| Error::Invalid)?;
        let record = Record::new(program, pool, timestamp_ms, notification.clone())?;
        let name = record.name()?;
        let path = spool.join(name);
        if !path.exists() {
            journal::atomic_write(&path, &record).map_err(|_| Error::Storage)?;
        }
        last = Some(notification);
        emitted = Instant::now();
    }
}
async fn consume<T: Transport>(
    transport: &T,
    prefix: &str,
    spool: &Path,
    program: &str,
    pool: &str,
) -> Result<(), Error> {
    loop {
        let mut files = Vec::<PathBuf>::new();
        for entry in fs::read_dir(spool).map_err(|_| Error::Storage)? {
            let path = entry.map_err(|_| Error::Storage)?.path();
            if path.extension().is_some_and(|ext| ext == "json") {
                files.push(path);
            }
        }
        files.sort();
        if files.is_empty() {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        }
        for path in files.into_iter().take(8) {
            let info = fs::symlink_metadata(&path).map_err(|_| Error::Storage)?;
            if !info.is_file() || info.file_type().is_symlink() || info.len() > 16384 {
                return Err(Error::Invalid);
            }
            let bytes = fs::read(&path).map_err(|_| Error::Storage)?;
            let record: Record = serde_json::from_slice(&bytes).map_err(|_| Error::Invalid)?;
            if record.program != program
                || record.pool != pool
                || record.network != "solana-devnet"
                || record.schema != "relative.chain-notification/v1"
            {
                return Err(Error::Invalid);
            }
            if path.file_name().and_then(|x| x.to_str()) != Some(record.name()?.as_str()) {
                return Err(Error::Invalid);
            }
            match backup::ensure(transport, &format!("{prefix}/{}", record.name()?), &bytes).await {
                Ok(()) => fs::remove_file(path).map_err(|_| Error::Storage)?,
                Err(backup::Error::Conflict | backup::Error::Checksum) => {
                    return Err(Error::Conflict)
                }
                Err(_) => {
                    eprintln!("Chain notification upload deferred");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    break;
                }
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    struct NoUploads;
    impl Transport for NoUploads {
        async fn create(
            &self,
            _: &str,
            _: &[u8],
            _: &str,
        ) -> Result<backup::Created, backup::Error> {
            panic!("old-generation notifications must not reach transport")
        }
        async fn get(&self, _: &str, _: u64) -> Result<backup::RemoteObject, backup::Error> {
            panic!("notification consumer does not fetch objects")
        }
    }
    #[tokio::test]
    async fn notification_consumer_rejects_another_pool_before_upload() {
        let root = std::env::temp_dir().join(format!(
            "old-notification-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let changes = changes::ChainChanges::open(&root.join("chain.state")).unwrap();
        changes.confirm(100, [1; 32]).unwrap();
        let notification = changes::read(&root.join("chain.state")).unwrap().unwrap();
        let program = solana_address::Address::new_from_array([1; 32]).to_string();
        let old_pool = solana_address::Address::new_from_array([2; 32]).to_string();
        let new_pool = solana_address::Address::new_from_array([3; 32]).to_string();
        let record = Record::new(&program, &old_pool, 1, notification).unwrap();
        journal::atomic_write(&root.join(record.name().unwrap()), &record).unwrap();
        assert_eq!(
            consume(
                &NoUploads,
                "pool-7/chain-changes",
                &root,
                &program,
                &new_pool
            )
            .await,
            Err(Error::Invalid)
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn chain_notifications_are_produced_without_price_observations() {
        let root = std::env::temp_dir().join(format!(
            "notify-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let state = root.join("state");
        let spool = root.join("spool");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&spool).unwrap();
        let changes = changes::ChainChanges::open(&state.join("chain-change.json")).unwrap();
        changes.confirm(100, [1; 32]).unwrap();
        changes.set_health(true).unwrap();
        let program = "G6iQGoupNSfduw1QJxQ9vcVi9FnCC6cbippXsi4QQzJF";
        let pool = "HPnHZGLeQ8oisu3V8ZEBfPRT2Sai8XWnpfQmcZ8sTZE4";
        assert!(tokio::time::timeout(
            Duration::from_millis(300),
            produce(&state, &spool, program, pool)
        )
        .await
        .is_err());
        let first = fs::read_dir(&spool)
            .unwrap()
            .map(|x| x.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(first.len(), 1);
        let record: Record = serde_json::from_slice(&fs::read(&first[0]).unwrap()).unwrap();
        assert_eq!(record.chain_change.revision, "1");
        assert!(record.chain_change.stream_healthy);
        assert!(!state.join("prices").exists());
        changes.confirm_activity(101, [1; 32], 1, 101).unwrap();
        assert!(tokio::time::timeout(
            Duration::from_millis(300),
            produce(&state, &spool, program, pool)
        )
        .await
        .is_err());
        let files = fs::read_dir(&spool)
            .unwrap()
            .map(|x| x.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(files.len(), 2);
        assert!(files
            .iter()
            .map(|x| serde_json::from_slice::<Record>(&fs::read(x).unwrap()).unwrap())
            .any(|x| x.chain_change.revision == "2"));
        fs::remove_dir_all(root).unwrap();
    }
}
