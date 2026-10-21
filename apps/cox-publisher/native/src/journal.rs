use crate::benchmark::{Anchor, Error, History, Observation};
use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
static SERIAL: AtomicU64 = AtomicU64::new(0);

pub fn atomic_write<T: Serialize>(path: &Path, value: &T) -> Result<(), Error> {
    let parent = path.parent().ok_or(Error::Persistence)?;
    fs::create_dir_all(parent).map_err(|_| Error::Persistence)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temporary).map_err(|_| Error::Persistence)?;
        let bytes = serde_json::to_vec(value).map_err(|_| Error::Persistence)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| Error::Persistence)?;
        fs::rename(&temporary, path).map_err(|_| Error::Persistence)?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| Error::Persistence)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
pub fn read<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, Error> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| Error::Persistence),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(Error::Persistence),
    }
}
#[derive(Clone)]
pub struct FileHistory {
    pub directory: PathBuf,
}
impl FileHistory {
    fn path(&self, universe: &[u8; 32], timestamp_us: u64) -> PathBuf {
        self.directory
            .join(hex::encode(universe))
            .join((timestamp_us / 3_600_000_000).to_string())
            .join(format!("{timestamp_us}.json"))
    }
    pub fn active_anchor(&self) -> Result<Option<Anchor>, Error> {
        read(&self.directory.join("active-anchor.json"))
    }
    pub fn latest_for_anchor(&self, anchor: &Anchor) -> Result<Option<Observation>, Error> {
        if self
            .active_anchor()?
            .as_ref()
            .is_some_and(|active| active != anchor)
        {
            return Err(Error::Conflict);
        }
        let latest = self.latest()?;
        match latest {
            Some(value)
                if value.universe_digest == anchor.universe_digest
                    && value.timestamp_us >= anchor.timestamp_us =>
            {
                Ok(Some(value))
            }
            Some(value)
                if value.universe_digest != anchor.universe_digest
                    && value.timestamp_us <= anchor.timestamp_us =>
            {
                Ok(None)
            }
            Some(_) => Err(Error::Conflict),
            None => Ok(None),
        }
    }
    pub fn latest(&self) -> Result<Option<Observation>, Error> {
        read(&self.directory.join("latest.json"))
    }
    pub fn exact(
        &self,
        universe: &[u8; 32],
        timestamp_us: u64,
    ) -> Result<Option<Observation>, Error> {
        let value: Option<Observation> = read(&self.path(universe, timestamp_us))?;
        if value.as_ref().is_some_and(|value| {
            value.universe_digest != *universe || value.timestamp_us != timestamp_us
        }) {
            return Err(Error::Conflict);
        }
        Ok(value)
    }
}
impl History for FileHistory {
    fn activate(&mut self, anchor: &Anchor) -> Result<(), Error> {
        let path = self
            .directory
            .join("anchors")
            .join(format!("{}.json", hex::encode(anchor.universe_digest)));
        if let Some(prior) = read::<Anchor>(&path)? {
            if prior != *anchor {
                return Err(Error::Conflict);
            }
        } else {
            atomic_write(&path, anchor)?;
        }
        if self
            .active_anchor()?
            .is_some_and(|prior| prior != *anchor && prior.timestamp_us >= anchor.timestamp_us)
        {
            return Err(Error::Conflict);
        }
        atomic_write(&self.directory.join("active-anchor.json"), anchor)
    }
    fn append(&mut self, value: &Observation) -> Result<(), Error> {
        if self.active_anchor()?.is_some_and(|anchor| {
            value.universe_digest != anchor.universe_digest
                || value.timestamp_us < anchor.timestamp_us
        }) {
            return Err(Error::Conflict);
        }
        let path = self.path(&value.universe_digest, value.timestamp_us);
        if let Some(prior) = read::<Observation>(&path)? {
            if prior != *value {
                return Err(Error::Conflict);
            }
        } else {
            atomic_write(&path, value)?;
        }
        atomic_write(&self.directory.join("latest.json"), value)
    }
}
