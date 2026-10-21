use reqwest::{Client, Url};
use serde_json::{json, Value};
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
        })
    }
    async fn send(&self, index: usize, method: &str, params: &Value) -> Result<Value, Error> {
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
