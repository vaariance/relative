use crate::benchmark::{Batch, Error, FeedPrice};
use ed25519_dalek::{Signature, VerifyingKey};
use std::collections::BTreeSet;

#[derive(Clone, Debug)]
pub struct TrustedSigner {
    pub public_key: [u8; 32],
    pub expires_at_seconds: i64,
}
struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}
impl<'a> Reader<'a> {
    fn take<const N: usize>(&mut self) -> Result<[u8; N], Error> {
        let end = self.offset.checked_add(N).ok_or(Error::Verification)?;
        let result = self
            .bytes
            .get(self.offset..end)
            .ok_or(Error::Verification)?
            .try_into()
            .map_err(|_| Error::Verification)?;
        self.offset = end;
        Ok(result)
    }
    fn u8(&mut self) -> Result<u8, Error> {
        Ok(self.take::<1>()?[0])
    }
    fn u16(&mut self) -> Result<u16, Error> {
        Ok(u16::from_le_bytes(self.take()?))
    }
    fn u32(&mut self) -> Result<u32, Error> {
        Ok(u32::from_le_bytes(self.take()?))
    }
    fn u64(&mut self) -> Result<u64, Error> {
        Ok(u64::from_le_bytes(self.take()?))
    }
    fn i64(&mut self) -> Result<i64, Error> {
        Ok(i64::from_le_bytes(self.take()?))
    }
}

pub fn verify_payload(
    bytes: &[u8],
    signers: &[TrustedSigner],
    now_seconds: u64,
    max_feed_age_us: u64,
) -> Result<Batch, Error> {
    let mut envelope = Reader { bytes, offset: 0 };
    if envelope.u32()? != 2_182_742_457 {
        return Err(Error::Verification);
    }
    let signature = Signature::from_bytes(&envelope.take()?);
    let public_key = envelope.take()?;
    if !signers.iter().any(|signer| {
        signer.public_key == public_key
            && i128::from(signer.expires_at_seconds) > i128::from(now_seconds)
    }) {
        return Err(Error::Verification);
    }
    let length = usize::from(envelope.u16()?);
    let payload = bytes
        .get(envelope.offset..)
        .filter(|value| value.len() == length)
        .ok_or(Error::Verification)?;
    VerifyingKey::from_bytes(&public_key)
        .map_err(|_| Error::Verification)?
        .verify_strict(payload, &signature)
        .map_err(|_| Error::Verification)?;
    let mut reader = Reader {
        bytes: payload,
        offset: 0,
    };
    if reader.u32()? != 2_479_346_549 {
        return Err(Error::Verification);
    }
    let timestamp_us = reader.u64()?;
    if reader.u8()? != 4 {
        return Err(Error::Verification);
    }
    let count = reader.u8()?;
    if count == 0 {
        return Err(Error::Verification);
    }
    let mut seen = BTreeSet::new();
    let mut prices = Vec::with_capacity(usize::from(count));
    for _ in 0..count {
        let feed_id = reader.u32()?;
        if !seen.insert(feed_id) || reader.u8()? != 4 {
            return Err(Error::Verification);
        }
        let mut fields = BTreeSet::new();
        let (mut price, mut exponent, mut confidence, mut timestamp) = (None, None, None, None);
        for _ in 0..4 {
            let kind = reader.u8()?;
            if !fields.insert(kind) {
                return Err(Error::Verification);
            }
            match kind {
                0 => price = Some(reader.i64()?),
                4 => exponent = Some(i16::from_le_bytes(reader.take()?)),
                5 => confidence = Some(reader.i64()?),
                12 => {
                    if reader.u8()? != 1 {
                        return Err(Error::Verification);
                    }
                    timestamp = Some(reader.u64()?);
                }
                _ => return Err(Error::Verification),
            }
        }
        let observed = timestamp.ok_or(Error::Verification)?;
        if observed > timestamp_us || timestamp_us - observed > max_feed_age_us {
            return Err(Error::Verification);
        }
        let value = FeedPrice {
            feed_id,
            price: price.ok_or(Error::Verification)?,
            exponent: exponent.ok_or(Error::Verification)?,
            confidence: confidence.ok_or(Error::Verification)?,
        };
        if value.price <= 0 || value.confidence <= 0 {
            return Err(Error::Verification);
        }
        prices.push(value);
    }
    if reader.offset != payload.len() {
        return Err(Error::Verification);
    }
    Ok(Batch {
        timestamp_us,
        prices,
        signed_payload: bytes.to_vec(),
    })
}

pub async fn read_trusted_signers(rpc: &crate::rpc::Rpc) -> Result<Vec<TrustedSigner>, Error> {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let result = rpc.call("getAccountInfo", serde_json::json!(["3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL", {"commitment":"confirmed", "encoding":"base64"}])).await.map_err(|_| Error::Verification)?;
    let account = result.get("value").ok_or(Error::Verification)?;
    if account.get("owner").and_then(serde_json::Value::as_str)
        != Some("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt")
        || account
            .get("executable")
            .and_then(serde_json::Value::as_bool)
            != Some(false)
    {
        return Err(Error::Verification);
    }
    let data = account
        .get("data")
        .and_then(serde_json::Value::as_array)
        .filter(|value| value.len() == 2)
        .ok_or(Error::Verification)?;
    if data[1].as_str() != Some("base64") {
        return Err(Error::Verification);
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data[0].as_str().ok_or(Error::Verification)?)
        .map_err(|_| Error::Verification)?;
    let discriminator = Sha256::digest(b"account:Storage");
    if bytes.len() < 381 || bytes[..8] != discriminator[..8] || !(1..=5).contains(&bytes[80]) {
        return Err(Error::Verification);
    }
    let mut signers = Vec::with_capacity(usize::from(bytes[80]));
    for index in 0..usize::from(bytes[80]) {
        let at = 81 + index * 40;
        let public_key: [u8; 32] = bytes[at..at + 32]
            .try_into()
            .map_err(|_| Error::Verification)?;
        if public_key == [0; 32]
            || signers
                .iter()
                .any(|signer: &TrustedSigner| signer.public_key == public_key)
        {
            return Err(Error::Verification);
        }
        signers.push(TrustedSigner {
            public_key,
            expires_at_seconds: i64::from_le_bytes(
                bytes[at + 32..at + 40]
                    .try_into()
                    .map_err(|_| Error::Verification)?,
            ),
        });
    }
    Ok(signers)
}
