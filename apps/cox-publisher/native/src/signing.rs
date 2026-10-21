use crate::{
    scheduler::{DraftTransaction, PendingTransaction},
    worker::Error,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use reqwest::{Client, Url};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_address::Address;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const NETWORK: &str = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const SCHEMA: &str = "eox.signing/v1";
const IDENTITY: &str = "cox-publisher@colosseum-eox.iam.gserviceaccount.com";
struct CachedIdentity {
    token: String,
    until: Instant,
}
pub struct RemoteSigner {
    client: Client,
    base: Url,
    audience: String,
    key_version: String,
    operator: Address,
    identity: Mutex<Option<CachedIdentity>>,
}
impl RemoteSigner {
    pub fn new(
        base: &str,
        audience: String,
        key_version: String,
        operator: Address,
    ) -> Result<Self, Error> {
        let base = Url::parse(base).map_err(|_| Error::Signer)?;
        if base.scheme() != "https"
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
            || !matches!(base.path(), "" | "/")
            || audience.is_empty()
            || key_version.is_empty()
        {
            return Err(Error::Signer);
        }
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(3))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| Error::Signer)?;
        Ok(Self {
            client,
            base,
            audience,
            key_version,
            operator,
            identity: Mutex::new(None),
        })
    }
    async fn token(&self) -> Result<String, Error> {
        let mut cached = self.identity.lock().await;
        if let Some(value) = cached.as_ref().filter(|value| value.until > Instant::now()) {
            return Ok(value.token.clone());
        }
        let response = self.client.get("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token")
            .header("Metadata-Flavor", "Google").send().await.map_err(|_| Error::Signer)?;
        let credentials = bounded_json(response).await?;
        let token = credentials
            .get("access_token")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 16_384)
            .ok_or(Error::Signer)?;
        if credentials.get("token_type").and_then(Value::as_str) != Some("Bearer") {
            return Err(Error::Signer);
        }
        let response = self.client.post(format!("https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{IDENTITY}:generateIdToken"))
            .bearer_auth(token).json(&json!({"audience":self.audience,"includeEmail":true})).send().await.map_err(|_| Error::Signer)?;
        let value = bounded_json(response).await?;
        let token = value
            .get("token")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 16_384)
            .ok_or(Error::Signer)?
            .to_owned();
        *cached = Some(CachedIdentity {
            token: token.clone(),
            until: Instant::now() + Duration::from_secs(600),
        });
        Ok(token)
    }
    pub async fn verify_identity(&self, now_seconds: u64) -> Result<(), Error> {
        let value = bounded_json(
            self.client
                .get(self.base.join("v1/keys").map_err(|_| Error::Signer)?)
                .bearer_auth(self.token().await?)
                .send()
                .await
                .map_err(|_| Error::Signer)?,
        )
        .await?;
        if value.get("schemaVersion").and_then(Value::as_str) != Some(SCHEMA) {
            return Err(Error::Signer);
        }
        let entries = value
            .get("entries")
            .and_then(Value::as_array)
            .ok_or(Error::Signer)?;
        let active: Vec<_> = entries
            .iter()
            .filter(|entry| {
                entry.get("role").and_then(Value::as_str) == Some("oracle-operator")
                    && entry.get("state").and_then(Value::as_str) == Some("active")
            })
            .collect();
        if active.len() != 1 {
            return Err(Error::Signer);
        }
        let entry = active[0];
        if entry.get("address").and_then(Value::as_str) != Some(self.operator.to_string().as_str())
            || entry.get("keyVersion").and_then(Value::as_str) != Some(self.key_version.as_str())
            || entry.get("chain").and_then(Value::as_str) != Some("solana")
            || entry.get("network").and_then(Value::as_str) != Some(NETWORK)
            || entry.get("algorithm").and_then(Value::as_str) != Some("ed25519")
            || entry
                .get("validFrom")
                .and_then(Value::as_u64)
                .is_none_or(|at| at > now_seconds)
            || !entry.get("validUntil").is_some_and(|value| {
                value.is_null() || value.as_u64().is_some_and(|at| at > now_seconds)
            })
        {
            return Err(Error::Signer);
        }
        Ok(())
    }
    pub async fn sign(&self, draft: &DraftTransaction) -> Result<PendingTransaction, Error> {
        validate_unsigned(self.operator, draft)?;
        let request = json!({"schemaVersion":SCHEMA,"requestId":draft.request_id,"role":"oracle-operator","keyVersion":self.key_version,
            "network":NETWORK,"operation":{"operationId":draft.request_id,"kind":"adaptive-publication"},"expiresAt":draft.expires_at_seconds,
            "chain":"solana","transactionBase64":STANDARD.encode(&draft.unsigned_bytes)});
        let response = self
            .client
            .post(
                self.base
                    .join("v1/sign/solana")
                    .map_err(|_| Error::Signer)?,
            )
            .bearer_auth(self.token().await?)
            .json(&request)
            .send()
            .await
            .map_err(|_| Error::Signer)?;
        validate_response(
            self.operator,
            &self.key_version,
            draft,
            &bounded_json(response).await?,
        )
    }
}
fn validate_unsigned(operator: Address, draft: &DraftTransaction) -> Result<(), Error> {
    if draft.request_id.len() < 8
        || draft.request_id.len() > 128
        || !draft
            .request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        || draft.unsigned_bytes.len() < 65
        || draft.unsigned_bytes.len() > 4096
    {
        return Err(Error::Signer);
    }
    let at = draft.unsigned_bytes.len() - 64;
    if draft.unsigned_bytes[at..].iter().any(|byte| *byte != 0) {
        return Err(Error::Signer);
    }
    if draft.unsigned_bytes[0] != solana_message::v1::V1_PREFIX {
        return Err(Error::Signer);
    }
    let message =
        solana_message::v1::deserialize(&draft.unsigned_bytes[1..at]).map_err(|_| Error::Signer)?;
    message.validate().map_err(|_| Error::Signer)?;
    if message.header.num_required_signatures != 1
        || message.account_keys.first() != Some(&operator)
        || message.serialize() != draft.unsigned_bytes[..at]
        || message.lifetime_specifier.to_string() != draft.blockhash
    {
        return Err(Error::Signer);
    }
    Ok(())
}
fn validate_response(
    operator: Address,
    key_version: &str,
    draft: &DraftTransaction,
    value: &Value,
) -> Result<PendingTransaction, Error> {
    validate_unsigned(operator, draft)?;
    if value.get("schemaVersion").and_then(Value::as_str) != Some(SCHEMA)
        || value.get("decision").and_then(Value::as_str) != Some("signed")
        || value.get("requestId").and_then(Value::as_str) != Some(draft.request_id.as_str())
        || value.pointer("/signer/role").and_then(Value::as_str) != Some("oracle-operator")
        || value.pointer("/signer/address").and_then(Value::as_str)
            != Some(operator.to_string().as_str())
        || value.pointer("/signer/keyVersion").and_then(Value::as_str) != Some(key_version)
        || value.get("payloadSha256").and_then(Value::as_str)
            != Some(hex::encode(Sha256::digest(&draft.unsigned_bytes)).as_str())
    {
        return Err(Error::Signer);
    }
    let signature = STANDARD
        .decode(
            value
                .get("signature")
                .and_then(Value::as_str)
                .ok_or(Error::Signer)?,
        )
        .map_err(|_| Error::Signer)?;
    let signature: [u8; 64] = signature.try_into().map_err(|_| Error::Signer)?;
    let signed = STANDARD
        .decode(
            value
                .get("signedTransaction")
                .and_then(Value::as_str)
                .ok_or(Error::Signer)?,
        )
        .map_err(|_| Error::Signer)?;
    let at = draft.unsigned_bytes.len() - 64;
    if signed.len() != draft.unsigned_bytes.len()
        || signed[..at] != draft.unsigned_bytes[..at]
        || signed[at..] != signature
    {
        return Err(Error::Signer);
    }
    VerifyingKey::from_bytes(&operator.to_bytes())
        .map_err(|_| Error::Signer)?
        .verify_strict(&signed[..at], &Signature::from_bytes(&signature))
        .map_err(|_| Error::Signer)?;
    Ok(PendingTransaction {
        signature: bs58::encode(signature).into_string(),
        signed_bytes: signed,
        last_valid_block_height: draft.last_valid_block_height,
    })
}
async fn bounded_json(mut response: reqwest::Response) -> Result<Value, Error> {
    if !response.status().is_success() {
        return Err(Error::Signer);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Error::Signer)? {
        if bytes.len() + chunk.len() > 65_536 {
            return Err(Error::Signer);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::Signer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transactions::{compile, Budget};
    use ed25519_dalek::{Signer, SigningKey};
    use solana_hash::Hash;
    use solana_instruction::Instruction;
    fn fixture() -> (SigningKey, Address, DraftTransaction, Value) {
        let key = SigningKey::from_bytes(&[13; 32]);
        let operator = Address::new_from_array(key.verifying_key().to_bytes());
        let program = Address::new_from_array([14; 32]);
        let hash = Hash::new_from_array([15; 32]);
        let transaction = compile(
            operator,
            hash.clone(),
            &[Instruction {
                program_id: program,
                accounts: vec![],
                data: vec![1],
            }],
            &[program],
            Budget {
                compute_units: 100_000,
                priority_fee_lamports: 0,
                heap_bytes: None,
            },
        )
        .unwrap();
        let draft = DraftTransaction {
            request_id: "native:stable-request".into(),
            unsigned_bytes: transaction.unsigned_transaction.clone(),
            blockhash: hash.to_string(),
            last_valid_block_height: 100,
            expires_at_seconds: 100,
        };
        let signature = key.sign(&transaction.message).to_bytes();
        let signed = transaction.with_signature(operator, signature).unwrap();
        let value = json!({"schemaVersion":SCHEMA,"requestId":draft.request_id,"decision":"signed","signer":{"role":"oracle-operator","address":operator.to_string(),"keyVersion":"key1"},"signature":STANDARD.encode(signature),"signedTransaction":STANDARD.encode(signed),"payloadSha256":hex::encode(Sha256::digest(&draft.unsigned_bytes))});
        (key, operator, draft, value)
    }
    #[test]
    fn remote_result_binds_request_role_key_unsigned_message_and_signature() {
        let (_, operator, draft, value) = fixture();
        let checked = validate_response(operator, "key1", &draft, &value).unwrap();
        assert_eq!(checked.last_valid_block_height, 100);
        assert_eq!(checked.signed_bytes.len(), draft.unsigned_bytes.len());
        for key in ["schemaVersion", "requestId", "payloadSha256", "decision"] {
            let mut bad = value.clone();
            bad[key] = json!("wrong");
            assert_eq!(
                validate_response(operator, "key1", &draft, &bad),
                Err(Error::Signer)
            );
        }
        let mut bad = value.clone();
        bad["signer"]["keyVersion"] = json!("another-key");
        assert_eq!(
            validate_response(operator, "key1", &draft, &bad),
            Err(Error::Signer)
        );
    }
    #[test]
    fn tampered_signed_bytes_and_noncanonical_unsigned_message_never_escape() {
        let (_, operator, draft, mut value) = fixture();
        let mut bytes = STANDARD
            .decode(value["signedTransaction"].as_str().unwrap())
            .unwrap();
        bytes[50] ^= 1;
        value["signedTransaction"] = json!(STANDARD.encode(bytes));
        assert_eq!(
            validate_response(operator, "key1", &draft, &value),
            Err(Error::Signer)
        );
        let mut malformed = draft;
        malformed.unsigned_bytes.push(0);
        assert_eq!(validate_unsigned(operator, &malformed), Err(Error::Signer));
    }
    #[test]
    fn remote_configuration_requires_https_without_url_credentials_or_redirect_data() {
        let (_, operator, _, _) = fixture();
        for url in [
            "http://example.test",
            "https://user:pass@example.test",
            "https://example.test?token=secret",
            "https://example.test/unexpected",
        ] {
            assert!(RemoteSigner::new(url, "audience".into(), "key1".into(), operator).is_err());
        }
    }
}
