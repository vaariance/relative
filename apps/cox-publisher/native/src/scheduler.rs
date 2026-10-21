use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const CADENCE_MS: u64 = 1_000;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Pool {
    Basic,
    Epoch,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Work {
    Maintenance {
        id: String,
        pool: Pool,
    },
    Entry {
        id: String,
        pool: Pool,
        eligible_after_ms: u64,
    },
    Close {
        id: String,
        timestamp_ms: u64,
    },
}
impl Work {
    fn key(&self) -> (u8, &str) {
        match self {
            Self::Maintenance {
                id,
                pool: Pool::Basic,
            } => (3, id),
            Self::Maintenance { id, .. } => (4, id),
            Self::Entry {
                id,
                pool: Pool::Basic,
                ..
            } => (0, id),
            Self::Entry { id, .. } => (1, id),
            Self::Close { id, .. } => (2, id),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingTransaction {
    pub signature: String,
    pub signed_bytes: Vec<u8>,
    pub last_valid_block_height: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DraftTransaction {
    pub request_id: String,
    pub unsigned_bytes: Vec<u8>,
    pub blockhash: String,
    pub last_valid_block_height: u64,
    pub expires_at_seconds: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkpoint {
    pub next_attempt_ms: u64,
    pub next_pool: Pool,
    pub closing_next: bool,
    #[serde(default = "prefer_maintenance")]
    pub maintenance_next: bool,
    pub pending: Option<PendingTransaction>,
    #[serde(default)]
    pub unsigned: Option<DraftTransaction>,
}
fn prefer_maintenance() -> bool {
    true
}
impl Default for Checkpoint {
    fn default() -> Self {
        Self {
            next_attempt_ms: 0,
            next_pool: Pool::Basic,
            closing_next: true,
            maintenance_next: true,
            pending: None,
            unsigned: None,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    Reconcile,
    Maintenance {
        work: Vec<Work>,
        next_pool: Pool,
    },
    Idle {
        wake_ms: Option<u64>,
    },
    Wait {
        wake_ms: u64,
    },
    Publish {
        work: Vec<Work>,
        closing_ms: Option<u64>,
        next_pool: Pool,
        closing_next: bool,
    },
}
#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    InvalidLimit,
    DuplicateWork,
    ClockOverflow,
}

pub fn decide(
    now_ms: u64,
    checkpoint: &Checkpoint,
    authoritative: &[Work],
    limit: usize,
) -> Result<Decision, Error> {
    if limit == 0 {
        return Err(Error::InvalidLimit);
    }
    if checkpoint.pending.is_some() || checkpoint.unsigned.is_some() {
        return Ok(Decision::Reconcile);
    }
    let mut seen = BTreeSet::new();
    if authoritative.iter().any(|item| !seen.insert(item.key())) {
        return Err(Error::DuplicateWork);
    }
    let maintenance: Vec<_> = authoritative
        .iter()
        .filter(|work| matches!(work, Work::Maintenance { .. }))
        .cloned()
        .collect();
    let eligible_price_work = authoritative.iter().any(|item| match item {
        Work::Entry {
            eligible_after_ms, ..
        } => *eligible_after_ms < now_ms,
        Work::Close { timestamp_ms, .. } => *timestamp_ms <= now_ms,
        _ => false,
    });
    if !maintenance.is_empty() && (checkpoint.maintenance_next || !eligible_price_work) {
        if now_ms < checkpoint.next_attempt_ms {
            return Ok(Decision::Wait {
                wake_ms: checkpoint.next_attempt_ms,
            });
        }
        let mut preferred: Vec<_> = maintenance.iter().filter(|work| matches!(work, Work::Maintenance { pool, .. } if *pool == checkpoint.next_pool)).cloned().collect();
        preferred.extend(maintenance.iter().filter(|work| matches!(work, Work::Maintenance { pool, .. } if *pool != checkpoint.next_pool)).cloned());
        return Ok(Decision::Maintenance {
            work: preferred.into_iter().take(limit).collect(),
            next_pool: if checkpoint.next_pool == Pool::Basic {
                Pool::Epoch
            } else {
                Pool::Basic
            },
        });
    }
    let mut future = Vec::new();
    let mut entries = [Vec::new(), Vec::new()];
    let mut closes = Vec::new();
    for item in authoritative {
        match item {
            Work::Maintenance { .. } => {}
            Work::Entry {
                pool,
                eligible_after_ms,
                ..
            } if *eligible_after_ms < now_ms => {
                entries[if *pool == Pool::Basic { 0 } else { 1 }].push(item.clone())
            }
            Work::Entry {
                eligible_after_ms, ..
            } => future.push(
                eligible_after_ms
                    .checked_add(1)
                    .ok_or(Error::ClockOverflow)?,
            ),
            Work::Close { timestamp_ms, .. } if *timestamp_ms <= now_ms => {
                closes.push(item.clone())
            }
            Work::Close { timestamp_ms, .. } => future.push(*timestamp_ms),
        }
    }
    if entries.iter().all(Vec::is_empty) && closes.is_empty() {
        return Ok(Decision::Idle {
            wake_ms: future.into_iter().min(),
        });
    }
    if now_ms < checkpoint.next_attempt_ms {
        return Ok(Decision::Wait {
            wake_ms: checkpoint.next_attempt_ms,
        });
    }
    if let Some(bootstrap) = entries[0]
        .iter()
        .find(|item| matches!(item,Work::Entry{id,..} if id=="basic:bootstrap"))
    {
        let timestamp = match bootstrap {
            Work::Entry {
                eligible_after_ms, ..
            } => eligible_after_ms
                .checked_add(1)
                .ok_or(Error::ClockOverflow)?,
            _ => unreachable!(),
        };
        return Ok(Decision::Publish {
            work: vec![bootstrap.clone()],
            closing_ms: Some(timestamp),
            next_pool: Pool::Epoch,
            closing_next: checkpoint.closing_next,
        });
    }
    closes.sort_by_key(|item| match item {
        Work::Close { timestamp_ms, id } => (*timestamp_ms, id.clone()),
        _ => unreachable!(),
    });
    if !closes.is_empty() && (checkpoint.closing_next || entries.iter().all(Vec::is_empty)) {
        let timestamp = match closes[0] {
            Work::Close { timestamp_ms, .. } => timestamp_ms,
            _ => unreachable!(),
        };
        return Ok(Decision::Publish { work: closes.into_iter().filter(|item| matches!(item, Work::Close { timestamp_ms, .. } if *timestamp_ms == timestamp)).take(limit).collect(), closing_ms: Some(timestamp), next_pool: checkpoint.next_pool, closing_next: false });
    }
    for queue in &mut entries {
        queue.sort_by_key(|item| match item {
            Work::Entry {
                eligible_after_ms,
                id,
                ..
            } => (*eligible_after_ms, id.clone()),
            _ => unreachable!(),
        });
    }
    let mut queues = entries.map(|queue| queue.into_iter());
    let mut next = checkpoint.next_pool;
    let mut work = Vec::new();
    while work.len() < limit && (queues[0].len() > 0 || queues[1].len() > 0) {
        let index = if next == Pool::Basic { 0 } else { 1 };
        if let Some(item) = queues[index].next() {
            work.push(item);
        }
        next = if next == Pool::Basic {
            Pool::Epoch
        } else {
            Pool::Basic
        };
    }
    Ok(Decision::Publish {
        work,
        closing_ms: None,
        next_pool: next,
        closing_next: true,
    })
}
