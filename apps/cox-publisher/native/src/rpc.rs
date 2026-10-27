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
#[cfg(test)]
thread_local! { static LOCAL_PROTOCOL_GENESIS: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) }; }
pub(crate) fn protocol_genesis() -> String {
    #[cfg(test)]
    if let Some(genesis) = LOCAL_PROTOCOL_GENESIS.with(|value| value.borrow().clone()) {
        return genesis;
    }
    DEVNET_GENESIS.into()
}
#[cfg(test)]
pub(crate) struct LocalProtocolGenesis(Option<String>);
#[cfg(test)]
impl LocalProtocolGenesis {
    pub(crate) fn at(genesis: String) -> Self {
        assert!(!genesis.is_empty());
        Self(LOCAL_PROTOCOL_GENESIS.with(|value| value.replace(Some(genesis))))
    }
}
#[cfg(test)]
impl Drop for LocalProtocolGenesis {
    fn drop(&mut self) {
        LOCAL_PROTOCOL_GENESIS.with(|value| value.replace(self.0.take()));
    }
}

const PUBLIC_DEVNET: &str = "https://api.devnet.solana.com";
#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Configuration,
    NetworkMismatch,
    Unavailable,
    InvalidResponse,
    Rejected(i64),
}
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RejectionDiagnostic {
    method: &'static str,
    request_id: u64,
    code: i64,
    transaction_error: Option<&'static str>,
    instruction_index: Option<u8>,
    instruction_error: Option<&'static str>,
    custom_code: Option<u32>,
    anchor_code: Option<u32>,
}
fn rejection_diagnostic(
    method: &str,
    request_id: u64,
    code: i64,
    error: &Value,
) -> RejectionDiagnostic {
    let method = match method {
        "getGenesisHash" => "getGenesisHash",
        "getMultipleAccounts" => "getMultipleAccounts",
        "getAccountInfo" => "getAccountInfo",
        "getLatestBlockhash" => "getLatestBlockhash",
        "getBlockHeight" => "getBlockHeight",
        "getSignatureStatuses" => "getSignatureStatuses",
        "simulateTransaction" => "simulateTransaction",
        "sendTransaction" => "sendTransaction",
        _ => "other",
    };
    let instruction = error
        .pointer("/data/err/InstructionError")
        .and_then(Value::as_array);
    let transaction_error = match error.pointer("/data/err").and_then(Value::as_str) {
        Some("BlockhashNotFound") => Some("BlockhashNotFound"),
        Some("AlreadyProcessed") => Some("AlreadyProcessed"),
        Some("AccountInUse") => Some("AccountInUse"),
        Some("InsufficientFundsForFee") => Some("InsufficientFundsForFee"),
        Some(_) => Some("Other"),
        None if instruction.is_some() => Some("InstructionError"),
        None => None,
    };
    let instruction_index = instruction
        .and_then(|row| row.first())
        .and_then(Value::as_u64)
        .and_then(|index| u8::try_from(index).ok());
    let detail = instruction.and_then(|row| row.get(1));
    let custom_code = detail
        .and_then(|value| value.get("Custom"))
        .and_then(Value::as_u64)
        .and_then(|code| u32::try_from(code).ok());
    let instruction_error = if custom_code.is_some() {
        Some("Custom")
    } else {
        match detail.and_then(Value::as_str) {
            Some("ComputationalBudgetExceeded") => Some("ComputationalBudgetExceeded"),
            Some("InvalidInstructionData") => Some("InvalidInstructionData"),
            Some("InvalidAccountData") => Some("InvalidAccountData"),
            Some("InsufficientFunds") => Some("InsufficientFunds"),
            Some("MissingRequiredSignature") => Some("MissingRequiredSignature"),
            Some("AccountBorrowFailed") => Some("AccountBorrowFailed"),
            Some("ProgramFailedToComplete") => Some("ProgramFailedToComplete"),
            Some(_) => Some("Other"),
            None => None,
        }
    };
    let anchor_code = error
        .pointer("/data/logs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(64)
        .filter_map(Value::as_str)
        .filter(|line| line.len() <= 512 && line.starts_with("Program log: AnchorError"))
        .find_map(|line| {
            let after = line.split_once("Error Number: ")?.1;
            let digits = after.split_once('.').map_or(after, |(digits, _)| digits);
            if digits.is_empty()
                || digits.len() > 10
                || !digits.bytes().all(|byte| byte.is_ascii_digit())
            {
                return None;
            }
            digits.parse::<u32>().ok()
        });
    RejectionDiagnostic {
        method,
        request_id,
        code,
        transaction_error,
        instruction_index,
        instruction_error,
        custom_code,
        anchor_code,
    }
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
    #[cfg(test)]
    pub(crate) fn local_rehearsal(endpoint: &str) -> Result<Self, Error> {
        let url = Url::parse(endpoint).map_err(|_| Error::Configuration)?;
        let loopback = url
            .host_str()
            .and_then(|host| {
                host.trim_start_matches('[')
                    .trim_end_matches(']')
                    .parse::<std::net::IpAddr>()
                    .ok()
            })
            .is_some_and(|address| address.is_loopback());
        if url.scheme() != "http"
            || !loopback
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !matches!(url.path(), "" | "/")
        {
            return Err(Error::Configuration);
        }
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(5))
                .connect_timeout(Duration::from_secs(2))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| Error::Configuration)?,
            urls: [url.clone(), url],
            state: Mutex::new(State {
                verified: [true; 2],
                retry_primary: None,
            }),
            serial: AtomicU64::new(1),
            usage: StdMutex::new(Usage::default()),
        })
    }
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
        let request_id = self.serial.fetch_add(1, Ordering::Relaxed);
        let mut response = self
            .client
            .post(self.urls[index].clone())
            .json(&json!({"jsonrpc":"2.0", "id":request_id, "method":method, "params":params}))
            .send()
            .await
            .map_err(|_| Error::Unavailable)?;
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
            let diagnostic = rejection_diagnostic(method, request_id, code, error);
            eprintln!(
                "Solana RPC rejection: {}",
                serde_json::to_string(&diagnostic).map_err(|_| Error::InvalidResponse)?
            );
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
#[path = "local_rehearsal.rs"]
mod local_rehearsal;

#[cfg(test)]
mod usage_tests {
    use super::*;
    #[test]
    fn identifies_instruction_failure_without_logging_source_text() {
        let error = json!({"message":"secret credential and transaction", "data":{"err":{"InstructionError":[3,{"Custom":6004}]},"logs":["Program log: AnchorError caused by account: pool. Error Code: Unsafe. Error Number: 6004. Error Message: https://secret.invalid/private."]}});
        let diagnostic = rejection_diagnostic("sendTransaction", 42, -32002, &error);
        assert_eq!(diagnostic.instruction_index, Some(3));
        assert_eq!(diagnostic.instruction_error, Some("Custom"));
        assert_eq!(diagnostic.transaction_error, Some("InstructionError"));
        assert_eq!(diagnostic.custom_code, Some(6004));
        assert_eq!(diagnostic.anchor_code, Some(6004));
        let output = serde_json::to_string(&diagnostic).unwrap();
        assert!(output.contains("\"requestId\":42"));
        assert!(
            !output.contains("secret")
                && !output.contains("https://")
                && !output.contains("Unsafe")
        );
        assert!(output.len() < 400);
    }
    #[test]
    fn bounds_untrusted_diagnostics_and_rejects_malformed_numeric_fields() {
        let mut logs = vec![json!("Program log: unrelated sensitive payload"); 64];
        logs.push(json!("Program log: AnchorError. Error Number: 6004."));
        let error =
            json!({"data":{"err":{"InstructionError":[999,{"Custom":4294967296u64}]},"logs":logs}});
        let diagnostic = rejection_diagnostic("https://credential.invalid/key", 9, -32002, &error);
        assert_eq!(diagnostic.method, "other");
        assert_eq!(diagnostic.instruction_index, None);
        assert_eq!(diagnostic.custom_code, None);
        assert_eq!(diagnostic.anchor_code, None);
        let long = format!(
            "Program log: AnchorError {} Error Number: 6004.",
            "x".repeat(512)
        );
        let diagnostic = rejection_diagnostic(
            "sendTransaction",
            10,
            -32002,
            &json!({"data":{"logs":[long,"Program log: AnchorError. Error Number: 6004 credential."]}}),
        );
        assert_eq!(diagnostic.anchor_code, None);
    }
    #[test]
    fn distinguishes_replay_blockhash_and_compute_failures() {
        for kind in ["AlreadyProcessed", "BlockhashNotFound"] {
            let diagnostic =
                rejection_diagnostic("sendTransaction", 1, -32002, &json!({"data":{"err":kind}}));
            assert_eq!(diagnostic.transaction_error, Some(kind));
            assert_eq!(diagnostic.instruction_index, None);
        }
        let diagnostic = rejection_diagnostic(
            "simulateTransaction",
            2,
            -32002,
            &json!({"data":{"err":{"InstructionError":[0,"ComputationalBudgetExceeded"]}}}),
        );
        assert_eq!(
            diagnostic.instruction_error,
            Some("ComputationalBudgetExceeded")
        );
        let missing = rejection_diagnostic("sendTransaction", 3, -32603, &Value::Null);
        assert_eq!(missing.transaction_error, None);
        assert_eq!(missing.anchor_code, None);
    }
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
