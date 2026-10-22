use crate::journal;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Notification {
    pub schema: String,
    pub generation: String,
    pub revision: String,
    pub observed_slot: u64,
    pub commitment: String,
    pub stream_healthy: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    notification: Notification,
    digest: Option<[u8; 32]>,
    activity_generation: u64,
    heartbeat_ms: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Storage,
    Clock,
    Overflow,
}
pub struct ChainChanges {
    path: PathBuf,
    state: Mutex<Stored>,
}
impl ChainChanges {
    pub fn open(path: &Path) -> Result<Self, Error> {
        let previous: Option<Stored> = journal::read(path).map_err(|_| Error::Storage)?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Error::Clock)?;
        let mut hash = Sha256::new();
        hash.update(b"RELATIVE/CHAIN-CHANGE/GENERATION/V1");
        hash.update(now.as_nanos().to_le_bytes());
        hash.update(std::process::id().to_le_bytes());
        if let Some(value) = previous {
            hash.update(value.notification.generation.as_bytes());
        }
        let state = Stored {
            notification: Notification {
                schema: "relative.chain-change/v1".into(),
                generation: hex::encode(hash.finalize()),
                revision: "0".into(),
                observed_slot: 0,
                commitment: "confirmed".into(),
                stream_healthy: false,
            },
            digest: None,
            activity_generation: 0,
            heartbeat_ms: now.as_millis().try_into().map_err(|_| Error::Clock)?,
        };
        journal::atomic_write(path, &state).map_err(|_| Error::Storage)?;
        Ok(Self {
            path: path.into(),
            state: Mutex::new(state),
        })
    }
    pub fn confirm(&self, slot: u64, digest: [u8; 32]) -> Result<(), Error> {
        self.confirm_activity(slot, digest, 0, 0)
    }
    pub fn confirm_activity(
        &self,
        slot: u64,
        digest: [u8; 32],
        generation: u64,
        activity_slot: u64,
    ) -> Result<(), Error> {
        let mut state = self.state.lock().map_err(|_| Error::Storage)?;
        let mut changed = state.notification.observed_slot < slot;
        let activity = generation > state.activity_generation && slot >= activity_slot;
        if state.digest != Some(digest) || activity {
            let revision = state
                .notification
                .revision
                .parse::<u64>()
                .map_err(|_| Error::Storage)?;
            state.notification.revision =
                revision.checked_add(1).ok_or(Error::Overflow)?.to_string();
            state.digest = Some(digest);
            if activity {
                state.activity_generation = generation;
            }
            changed = true;
        }
        if changed {
            state.notification.observed_slot = state.notification.observed_slot.max(slot);
            journal::atomic_write(&self.path, &*state).map_err(|_| Error::Storage)?;
        }
        Ok(())
    }
    pub fn heartbeat(&self) -> Result<(), Error> {
        let mut state = self.state.lock().map_err(|_| Error::Storage)?;
        state.heartbeat_ms = now_ms()?;
        journal::atomic_write(&self.path, &*state).map_err(|_| Error::Storage)
    }
    pub fn set_health(&self, healthy: bool) -> Result<(), Error> {
        let mut state = self.state.lock().map_err(|_| Error::Storage)?;
        if state.notification.stream_healthy != healthy {
            state.notification.stream_healthy = healthy;
            journal::atomic_write(&self.path, &*state).map_err(|_| Error::Storage)?;
        }
        Ok(())
    }
}
pub fn read(path: &Path) -> Result<Option<Notification>, Error> {
    let state: Option<Stored> = journal::read(path).map_err(|_| Error::Storage)?;
    let now = now_ms()?;
    Ok(state.map(|mut state| {
        if now.saturating_sub(state.heartbeat_ms) > 15_000
            || state.heartbeat_ms > now.saturating_add(5_000)
        {
            state.notification.stream_healthy = false;
        }
        state.notification
    }))
}

fn now_ms() -> Result<u64, Error> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Error::Clock)?
        .as_millis()
        .try_into()
        .map_err(|_| Error::Clock)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_changed_confirmed_state_changes_revision_and_restart_changes_generation() {
        let path = std::env::temp_dir().join(format!(
            "chain-change-{}-{}.json",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let changes = ChainChanges::open(&path).unwrap();
        let generation = read(&path).unwrap().unwrap().generation;
        changes.confirm(100, [1; 32]).unwrap();
        changes.set_health(true).unwrap();
        changes.confirm(101, [1; 32]).unwrap();
        let value = read(&path).unwrap().unwrap();
        assert_eq!(value.revision, "1");
        assert_eq!(value.observed_slot, 101);
        assert!(value.stream_healthy);
        changes.set_health(false).unwrap();
        assert_eq!(read(&path).unwrap().unwrap().revision, "1");
        changes.confirm(102, [2; 32]).unwrap();
        assert_eq!(read(&path).unwrap().unwrap().revision, "2");
        drop(changes);
        let _restarted = ChainChanges::open(&path).unwrap();
        let value = read(&path).unwrap().unwrap();
        assert_ne!(value.generation, generation);
        assert_eq!(value.revision, "0");
        assert!(!value.stream_healthy);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn confirmed_activity_outside_working_set_invalidates_once_and_expired_lease_is_unhealthy() {
        let path = std::env::temp_dir().join(format!(
            "chain-activity-{}-{}.json",
            std::process::id(),
            now_ms().unwrap()
        ));
        let changes = ChainChanges::open(&path).unwrap();
        changes.confirm(100, [1; 32]).unwrap();
        changes.confirm_activity(101, [1; 32], 5, 102).unwrap();
        assert_eq!(read(&path).unwrap().unwrap().revision, "1");
        changes.confirm_activity(102, [1; 32], 5, 102).unwrap();
        assert_eq!(read(&path).unwrap().unwrap().revision, "2");
        changes.confirm_activity(103, [1; 32], 5, 102).unwrap();
        assert_eq!(read(&path).unwrap().unwrap().revision, "2");
        changes.set_health(true).unwrap();
        {
            let mut state = changes.state.lock().unwrap();
            state.heartbeat_ms = 0;
            journal::atomic_write(&path, &*state).unwrap();
        }
        assert!(!read(&path).unwrap().unwrap().stream_healthy);
        changes.heartbeat().unwrap();
        assert!(read(&path).unwrap().unwrap().stream_healthy);
        std::fs::remove_file(path).unwrap();
    }
}
