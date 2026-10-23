use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, future::Future, path::Path, sync::Mutex as StdMutex};
tokio::task_local! { static TRIGGER: &'static str; }
pub async fn with_trigger<T>(name: &'static str, future: impl Future<Output = T>) -> T {
    TRIGGER.scope(name, future).await
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub physical_http_requests: u64,
    pub by_method: BTreeMap<String, u64>,
    pub by_trigger: BTreeMap<String, u64>,
    pub by_upstream: BTreeMap<String, u64>,
}
impl Usage {
    fn record(&mut self, method: &str, upstream: usize, trigger: &str) {
        self.physical_http_requests = self.physical_http_requests.saturating_add(1);
        for (map, key) in [
            (&mut self.by_method, method),
            (&mut self.by_trigger, trigger),
            (
                &mut self.by_upstream,
                if upstream == 0 {
                    "alchemy"
                } else {
                    "public-devnet"
                },
            ),
        ] {
            let count = map.entry(key.to_owned()).or_default();
            *count = count.saturating_add(1);
        }
    }
}

use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
pub const DEVNET_GENESIS: &str = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const PUBLIC_DEVNET: &str = "https://api.devnet.solana.com";
#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Configuration,
    NetworkMismatch,
    Unavailable,
    InvalidResponse,
    Rejected(i64),
}
struct State {
    verified: [bool; 2],
    retry_primary: Option<Instant>,
}
pub struct Rpc {
    client: Client,
    urls: [Url; 2],
    state: Mutex<State>,
    serial: AtomicU64,
    usage: StdMutex<Usage>,
}
impl Rpc {
    pub fn direct_devnet(key: &str) -> Result<Self, Error> {
        if key.is_empty()
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return Err(Error::Configuration);
        }
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(5))
                .connect_timeout(Duration::from_secs(2))
                .build()
                .map_err(|_| Error::Configuration)?,
            urls: [
                Url::parse(&format!("https://solana-devnet.g.alchemy.com/v2/{key}"))
                    .map_err(|_| Error::Configuration)?,
                Url::parse(PUBLIC_DEVNET).map_err(|_| Error::Configuration)?,
            ],
            state: Mutex::new(State {
                verified: [false; 2],
                retry_primary: None,
            }),
            serial: AtomicU64::new(1),
            usage: StdMutex::new(Usage::default()),
        })
    }
    pub fn usage(&self) -> Result<Usage, Error> {
        self.usage
            .lock()
            .map(|usage| usage.clone())
            .map_err(|_| Error::InvalidResponse)
    }
    pub fn persist_usage(&self, path: &Path) -> Result<(), Error> {
        crate::journal::atomic_write(path, &self.usage()?).map_err(|_| Error::InvalidResponse)
    }
    async fn send(&self, index: usize, method: &str, params: &Value) -> Result<Value, Error> {
        let trigger = TRIGGER
            .try_with(|name| *name)
            .unwrap_or("startup-or-unspecified");
        self.usage
            .lock()
            .map_err(|_| Error::InvalidResponse)?
            .record(method, index, trigger);
        let mut response = self.client.post(self.urls[index].clone()).json(&json!({"jsonrpc":"2.0", "id":self.serial.fetch_add(1, Ordering::Relaxed), "method":method, "params":params})).send().await.map_err(|_| Error::Unavailable)?;
        if !response.status().is_success() {
            return Err(Error::Unavailable);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| Error::Unavailable)? {
            if bytes.len() + chunk.len() > 16 * 1024 * 1024 {
                return Err(Error::InvalidResponse);
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| Error::InvalidResponse)?;
        if let Some(error) = value.get("error") {
            let code = error
                .get("code")
                .and_then(Value::as_i64)
                .ok_or(Error::InvalidResponse)?;
            eprintln!("Solana RPC rejected {method}: code {code}");
            return Err(if [-32005, -32603].contains(&code) {
                Error::Unavailable
            } else {
                Error::Rejected(code)
            });
        }
        value.get("result").cloned().ok_or(Error::InvalidResponse)
    }
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, Error> {
        let first = {
            let state = self.state.lock().await;
            usize::from(
                state
                    .retry_primary
                    .is_some_and(|deadline| deadline > Instant::now()),
            )
        };
        for index in [first, 1 - first] {
            let verified = self.state.lock().await.verified[index];
            if !verified {
                match self.send(index, "getGenesisHash", &json!([])).await {
                    Ok(value) if value.as_str() == Some(DEVNET_GENESIS) => {
                        self.state.lock().await.verified[index] = true
                    }
                    Ok(_) => return Err(Error::NetworkMismatch),
                    Err(_) => {
                        if index == 0 {
                            self.state.lock().await.retry_primary =
                                Some(Instant::now() + Duration::from_secs(30));
                        }
                        continue;
                    }
                }
            }
            match self.send(index, method, &params).await {
                Ok(value) => {
                    if index == 0 {
                        self.state.lock().await.retry_primary = None;
                    }
                    return Ok(value);
                }
                Err(Error::Rejected(code)) => return Err(Error::Rejected(code)),
                Err(_) => {
                    if index == 0 {
                        self.state.lock().await.retry_primary =
                            Some(Instant::now() + Duration::from_secs(30));
                    }
                }
            }
        }
        Err(Error::Unavailable)
    }
}

#[cfg(test)]
mod usage_tests {
    use super::*;
    #[test]
    fn counts_physical_fallback_attempts_separately_from_trigger_and_method() {
        let mut usage = Usage::default();
        usage.record("getMultipleAccounts", 0, "safety");
        usage.record("getMultipleAccounts", 1, "safety");
        usage.record("getAccountInfo", 0, "signer-refresh");
        assert_eq!(usage.physical_http_requests, 3);
        assert_eq!(usage.by_method["getMultipleAccounts"], 2);
        assert_eq!(usage.by_upstream["alchemy"], 2);
        assert_eq!(usage.by_upstream["public-devnet"], 1);
        assert_eq!(usage.by_trigger["safety"], 2);
        let json = serde_json::to_string(&usage).unwrap();
        assert!(!json.contains("https://"));
    }
}
