use cox_math::geometric::geometric_level;
const MAX_GEOMETRIC_ASSETS: usize = 255;
use relative_methodology::inclusion::{assert_snapshot, FeedIdentity, UniverseSnapshot};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Asset {
    pub id: String,
    pub feed_id: u32,
    pub origin_price_e8: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Anchor {
    pub universe_digest: [u8; 32],
    pub timestamp_us: u64,
    pub benchmark: i128,
    pub assets: Vec<Asset>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeedPrice {
    pub feed_id: u32,
    pub price: i64,
    pub exponent: i16,
    pub confidence: i64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Batch {
    pub timestamp_us: u64,
    pub prices: Vec<FeedPrice>,
    pub signed_payload: Vec<u8>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Observation {
    pub universe_digest: [u8; 32],
    pub timestamp_us: u64,
    pub benchmark: i128,
    pub prices_e8: Vec<u64>,
    pub signed_payload: Vec<u8>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    InvalidAnchor,
    InvalidUniverseTransition,
    InvalidPrice,
    Incomplete,
    TimeRegression,
    Conflict,
    Arithmetic,
    Verification,
    Persistence,
}

pub fn price_e8(price: i64, exponent: i16) -> Result<u64, Error> {
    if price <= 0 || !(-18..=18).contains(&exponent) {
        return Err(Error::InvalidPrice);
    }
    let shift = i32::from(exponent) + 8;
    let scale = 10_u128
        .checked_pow(shift.unsigned_abs())
        .ok_or(Error::Arithmetic)?;
    let result = if shift >= 0 {
        (price as u128)
            .checked_mul(scale)
            .ok_or(Error::Arithmetic)?
    } else {
        ((price as u128) + scale / 2) / scale
    };
    u64::try_from(result)
        .ok()
        .filter(|value| *value > 0)
        .ok_or(Error::InvalidPrice)
}

pub trait History {
    fn append(&mut self, observation: &Observation) -> Result<(), Error>;
    fn activate(&mut self, _anchor: &Anchor) -> Result<(), Error> {
        Err(Error::Persistence)
    }
}

pub struct Benchmark<H> {
    anchor: Anchor,
    latest: Option<Observation>,
    history: H,
    latest_feeds: Option<BTreeMap<u32, u64>>,
}
impl<H: History> Benchmark<H> {
    pub fn new(anchor: Anchor, history: H, resumed: Option<Observation>) -> Result<Self, Error> {
        if !(2..=MAX_GEOMETRIC_ASSETS).contains(&anchor.assets.len())
            || anchor.benchmark <= 0
            || anchor.assets.iter().any(|asset| {
                asset.id.is_empty() || asset.feed_id == 0 || asset.origin_price_e8 == 0
            })
            || anchor
                .assets
                .iter()
                .map(|asset| &asset.id)
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != anchor.assets.len()
            || anchor
                .assets
                .iter()
                .map(|asset| asset.feed_id)
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != anchor.assets.len()
        {
            return Err(Error::InvalidAnchor);
        }
        if let Some(value) = &resumed {
            if value.timestamp_us < anchor.timestamp_us
                || value.universe_digest != anchor.universe_digest
                || value.signed_payload.is_empty()
                || value.prices_e8.len() != anchor.assets.len()
                || geometric_level(
                    &anchor
                        .assets
                        .iter()
                        .map(|asset| asset.origin_price_e8)
                        .collect::<Vec<_>>(),
                    &value.prices_e8,
                    anchor.benchmark,
                )
                .map_err(|_| Error::Arithmetic)?
                    != value.benchmark
            {
                return Err(Error::InvalidAnchor);
            }
        }
        let latest_feeds = resumed.as_ref().map(|value| {
            anchor
                .assets
                .iter()
                .zip(&value.prices_e8)
                .map(|(asset, price)| (asset.feed_id, *price))
                .collect()
        });
        Ok(Self {
            anchor,
            latest: resumed,
            history,
            latest_feeds,
        })
    }
    pub fn observe(
        &mut self,
        batch: &Batch,
        verify: impl FnOnce(&Batch) -> Result<(), Error>,
    ) -> Result<Observation, Error> {
        verify(batch)?;
        if batch.signed_payload.is_empty() {
            return Err(Error::Verification);
        }
        if batch.timestamp_us < self.anchor.timestamp_us
            || self
                .latest
                .as_ref()
                .is_some_and(|value| batch.timestamp_us < value.timestamp_us)
        {
            return Err(Error::TimeRegression);
        }
        let mut feeds = BTreeMap::new();
        for price in &batch.prices {
            if price.confidence < 0
                || feeds
                    .insert(price.feed_id, price_e8(price.price, price.exponent)?)
                    .is_some()
            {
                return Err(Error::InvalidPrice);
            }
        }
        let current = self
            .anchor
            .assets
            .iter()
            .map(|asset| feeds.get(&asset.feed_id).copied().ok_or(Error::Incomplete))
            .collect::<Result<Vec<_>, _>>()?;
        let original = self
            .anchor
            .assets
            .iter()
            .map(|asset| asset.origin_price_e8)
            .collect::<Vec<_>>();
        let benchmark = geometric_level(&original, &current, self.anchor.benchmark)
            .map_err(|_| Error::Arithmetic)?;
        let observation = Observation {
            universe_digest: self.anchor.universe_digest,
            timestamp_us: batch.timestamp_us,
            benchmark,
            prices_e8: current,
            signed_payload: batch.signed_payload.clone(),
        };
        if let Some(prior) = &self.latest {
            if prior.timestamp_us == observation.timestamp_us {
                if prior.benchmark != observation.benchmark
                    || prior.prices_e8 != observation.prices_e8
                {
                    return Err(Error::Conflict);
                }
                return Ok(prior.clone());
            }
        }
        self.history.append(&observation)?;
        self.latest = Some(observation.clone());
        self.latest_feeds = Some(feeds);
        Ok(observation)
    }
    pub fn anchor(&self) -> &Anchor {
        &self.anchor
    }
    pub fn activate(
        &mut self,
        previous: &UniverseSnapshot,
        next: &UniverseSnapshot,
    ) -> Result<Anchor, Error> {
        let invalid = Error::InvalidUniverseTransition;
        assert_snapshot(previous).map_err(|_| invalid)?;
        assert_snapshot(next).map_err(|_| invalid)?;
        let latest = self.latest.as_ref().ok_or(invalid)?;
        let feeds = self.latest_feeds.as_ref().ok_or(invalid)?;
        let previous_digest: [u8; 32] = hex::decode(&previous.digest)
            .map_err(|_| invalid)?
            .try_into()
            .map_err(|_| invalid)?;
        let next_digest: [u8; 32] = hex::decode(&next.digest)
            .map_err(|_| invalid)?
            .try_into()
            .map_err(|_| invalid)?;
        if previous_digest != self.anchor.universe_digest
            || next_digest == previous_digest
            || next.version != previous.version + 1
            || next.predecessor_digest.as_ref() != Some(&previous.digest)
            || next.effective_at <= previous.effective_at
            || next.effective_at.checked_mul(1_000_000) != Some(latest.timestamp_us)
            || latest.timestamp_us <= self.anchor.timestamp_us
            || next.assets.len() > MAX_GEOMETRIC_ASSETS
            || previous.assets.len() != self.anchor.assets.len()
        {
            return Err(invalid);
        }
        for prior in &previous.assets {
            let feed_id = match &prior.definition.feed {
                FeedIdentity::Pro { price_feed_id } => {
                    u32::try_from(*price_feed_id).map_err(|_| invalid)?
                }
                FeedIdentity::Core { .. } => return Err(invalid),
            };
            if !self.anchor.assets.iter().any(|asset| {
                asset.id == prior.definition.stable_asset_id && asset.feed_id == feed_id
            }) || !next
                .assets
                .iter()
                .any(|asset| asset.definition == prior.definition)
            {
                return Err(invalid);
            }
        }
        let mut assets = Vec::with_capacity(next.assets.len());
        for asset in &next.assets {
            let feed_id = match &asset.definition.feed {
                FeedIdentity::Pro { price_feed_id } => {
                    u32::try_from(*price_feed_id).map_err(|_| invalid)?
                }
                FeedIdentity::Core { .. } => return Err(invalid),
            };
            let price = *feeds.get(&feed_id).ok_or(invalid)?;
            if let Some((index, _)) = self
                .anchor
                .assets
                .iter()
                .enumerate()
                .find(|(_, prior)| prior.id == asset.definition.stable_asset_id)
            {
                if latest.prices_e8[index] != price {
                    return Err(invalid);
                }
            }
            assets.push(Asset {
                id: asset.definition.stable_asset_id.clone(),
                feed_id,
                origin_price_e8: price,
            });
        }
        let anchor = Anchor {
            universe_digest: next_digest,
            timestamp_us: latest.timestamp_us,
            benchmark: latest.benchmark,
            assets,
        };
        self.history.activate(&anchor)?;
        self.anchor = anchor.clone();
        self.latest = None;
        self.latest_feeds = None;
        Ok(anchor)
    }
    pub fn preview(&self) -> Option<&Observation> {
        self.latest.as_ref()
    }
}
