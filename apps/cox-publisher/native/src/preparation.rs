use relative_methodology::transition::{self, Preparation, Request};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Component, Path},
    sync::atomic::{AtomicU64, Ordering},
};

pub const MAX_REQUEST_BYTES: u64 = 4 * 1024 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(0);
#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    InvalidRequest,
    InvalidTransition,
    UnsafePath,
    Storage,
}
fn checked_path(path: &Path) -> Result<(), Error> {
    if !path.is_absolute() {
        return Err(Error::UnsafePath);
    }
    let mut current = std::path::PathBuf::new();
    for component in path.components() {
        if matches!(component, Component::ParentDir | Component::CurDir) {
            return Err(Error::UnsafePath);
        }
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => return Err(Error::UnsafePath),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(Error::Storage),
        }
    }
    Ok(())
}
pub(crate) fn read_request<T: serde::de::DeserializeOwned>(input: &Path) -> Result<T, Error> {
    checked_path(input)?;
    let metadata = fs::metadata(input).map_err(|_| Error::Storage)?;
    if !metadata.is_file() || metadata.len() > MAX_REQUEST_BYTES {
        return Err(Error::InvalidRequest);
    }
    let bytes = fs::read(input).map_err(|_| Error::Storage)?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        return Err(Error::InvalidRequest);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::InvalidRequest)
}
pub fn prepare(input: &Path, output: &Path) -> Result<Preparation, Error> {
    let request: Request = read_request(input)?;
    let artifact = transition::prepare(request).map_err(|_| Error::InvalidTransition)?;
    transition::validate(&artifact).map_err(|_| Error::InvalidTransition)?;
    persist(output, &artifact)?;
    Ok(artifact)
}
pub(crate) fn persist<T: serde::Serialize>(output: &Path, artifact: &T) -> Result<(), Error> {
    checked_path(output)?;
    let parent = output.parent().ok_or(Error::UnsafePath)?;
    if !parent.is_dir() || output.exists() {
        return Err(Error::UnsafePath);
    }
    let temporary = parent.join(format!(
        ".preparation-{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|_| Error::Storage)?;
        let bytes = serde_json::to_vec(artifact).map_err(|_| Error::InvalidTransition)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| Error::Storage)?;
        fs::hard_link(&temporary, output).map_err(|_| Error::Storage)?;
        fs::remove_file(&temporary).map_err(|_| Error::Storage)?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| Error::Storage)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
