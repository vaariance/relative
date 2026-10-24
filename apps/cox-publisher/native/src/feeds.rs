use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use pyth_lazer_client::{stream_client::PythLazerStreamClientBuilder, ws_connection::AnyResponse};
use pyth_lazer_protocol::{
    api::{
        Channel, DeliveryFormat, Format, JsonBinaryEncoding, SubscribeRequest as PythSubscribe,
        SubscriptionId, SubscriptionParams, SubscriptionParamsRepr, WsResponse,
    },
    time::FixedRate,
    PriceFeedId, PriceFeedProperty,
};
use std::{
    collections::{BTreeSet, HashMap},
    time::Duration,
};
use tokio::sync::{mpsc, watch};
use yellowstone_grpc_client::GeyserGrpcClient;
use yellowstone_grpc_proto::prelude::{
    subscribe_update::UpdateOneof, CommitmentLevel, SubscribeRequest,
    SubscribeRequestFilterAccounts, SubscribeRequestFilterSlots,
    SubscribeRequestFilterTransactions, SubscribeRequestPing,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WakeHint {
    pub generation: u64,
    pub latest_slot: u64,
    pub reconcile: bool,
    pub connected: bool,
    pub signer_generation: u64,
    pub protocol_generation: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeedError {
    Configuration,
    Connect,
    Subscribe,
    Disconnected,
    InvalidPayload,
    ConsumerStopped,
}

pub struct GrpcConfig {
    pub endpoint: String,
    pub token: String,
    pub program_ids: Vec<String>,
    pub account_ids: watch::Receiver<Vec<String>>,
}
pub struct PythConfig {
    pub token: String,
    pub feed_ids: Vec<u32>,
    pub subscription_id: u64,
}

pub fn grpc_subscription(program_ids: &[String]) -> Result<SubscribeRequest, FeedError> {
    grpc_account_subscription(program_ids, &[])
}

fn grpc_account_subscription(
    program_ids: &[String],
    account_ids: &[String],
) -> Result<SubscribeRequest, FeedError> {
    let ids: BTreeSet<_> = program_ids.iter().cloned().collect();
    if ids.is_empty()
        || ids.iter().any(|id| id.is_empty())
        || account_ids.iter().any(String::is_empty)
    {
        return Err(FeedError::Configuration);
    }
    let mut watched: BTreeSet<_> = account_ids.iter().cloned().collect();
    watched.extend(ids.iter().cloned());
    Ok(SubscribeRequest {
        slots: HashMap::from([(
            "confirmation".into(),
            SubscribeRequestFilterSlots {
                filter_by_commitment: Some(false),
                ..Default::default()
            },
        )]),
        accounts: HashMap::from([
            (
                "protocol".into(),
                SubscribeRequestFilterAccounts {
                    owner: ids.iter().cloned().collect(),
                    ..Default::default()
                },
            ),
            (
                "custody".into(),
                SubscribeRequestFilterAccounts {
                    account: account_ids.to_vec(),
                    ..Default::default()
                },
            ),
            (
                "signers".into(),
                SubscribeRequestFilterAccounts {
                    account: vec![crate::pyth::STORAGE_ADDRESS.into()],
                    ..Default::default()
                },
            ),
        ])
        .into_iter()
        .filter(|(name, value)| name != "custody" || !value.account.is_empty())
        .collect(),
        transactions: HashMap::from([(
            "predictions".to_owned(),
            SubscribeRequestFilterTransactions {
                vote: Some(false),
                failed: Some(false),
                account_include: watched.into_iter().collect(),
                ..Default::default()
            },
        )]),
        commitment: Some(CommitmentLevel::Processed as i32),
        ..Default::default()
    })
}

fn hint(sender: &watch::Sender<WakeHint>, slot: Option<u64>, reconcile: bool) {
    sender.send_modify(|state| {
        state.generation = state.generation.saturating_add(1);
        if !reconcile {
            state.protocol_generation = state.protocol_generation.saturating_add(1);
        }
        state.latest_slot = state.latest_slot.max(slot.unwrap_or(0));
        state.reconcile = reconcile;
    });
}

fn connection(sender: &watch::Sender<WakeHint>, connected: bool) {
    sender.send_if_modified(|state| {
        if state.connected == connected {
            return false;
        }
        state.connected = connected;
        true
    });
}

pub async fn run_grpc(
    mut config: GrpcConfig,
    wakes: watch::Sender<WakeHint>,
    mut stop: watch::Receiver<bool>,
) -> Result<(), FeedError> {
    let uri = reqwest::Url::parse(&config.endpoint).map_err(|_| FeedError::Configuration)?;
    if uri.scheme() != "https"
        || !uri.username().is_empty()
        || uri.password().is_some()
        || uri.fragment().is_some()
        || config.token.is_empty()
    {
        return Err(FeedError::Configuration);
    }
    let mut delay = Duration::from_millis(250);
    loop {
        if *stop.borrow() {
            return Ok(());
        }
        let accounts = config.account_ids.borrow_and_update().clone();
        let request = grpc_account_subscription(&config.program_ids, &accounts)?;
        let session = grpc_session(
            &config.endpoint,
            &config.token,
            request,
            &wakes,
            &mut config.account_ids,
        );
        tokio::select! { _ = wait_stop(&mut stop) => return Ok(()), result = session => {
            if result.is_ok() { continue; }
        } }
        connection(&wakes, false);
        tokio::select! { _ = wait_stop(&mut stop) => return Ok(()), _ = tokio::time::sleep(delay) => {} }
        delay = (delay * 2).min(Duration::from_secs(10));
    }
}

#[derive(Default)]
struct PendingActivity {
    slots: BTreeSet<u64>,
}
impl PendingActivity {
    fn observe(&mut self, slot: u64) {
        self.slots.insert(slot);
    }
    fn progress(&mut self, slot: u64, status: i32) -> bool {
        match status {
            1 | 2 => {
                let previous = self.slots.len();
                self.slots.retain(|pending| *pending > slot);
                previous != self.slots.len()
            }
            6 => self.slots.remove(&slot),
            _ => false,
        }
    }
}

async fn grpc_session(
    endpoint: &str,
    token: &str,
    mut request: SubscribeRequest,
    wakes: &watch::Sender<WakeHint>,
    accounts: &mut watch::Receiver<Vec<String>>,
) -> Result<(), FeedError> {
    let mut client = GeyserGrpcClient::build_from_shared(endpoint.to_owned())
        .map_err(|_| FeedError::Configuration)?
        .x_token(Some(token.to_owned()))
        .map_err(|_| FeedError::Configuration)?
        .tls_config(tonic::transport::ClientTlsConfig::new().with_native_roots())
        .map_err(|_| FeedError::Configuration)?
        .http2_keep_alive_interval(Duration::from_secs(20))
        .keep_alive_timeout(Duration::from_secs(10))
        .keep_alive_while_idle(true)
        .connect_timeout(Duration::from_secs(10))
        .connect()
        .await
        .map_err(|_| FeedError::Connect)?;
    let (mut sink, mut stream) = client
        .subscribe_with_request(Some(request.clone()))
        .await
        .map_err(|_| FeedError::Subscribe)?;
    connection(wakes, true);
    hint(wakes, None, true);
    let mut pending_activity = PendingActivity::default();
    loop {
        let update = tokio::select! {
            changed = accounts.changed() => {
                changed.map_err(|_|FeedError::ConsumerStopped)?;
                let watched = accounts.borrow_and_update().clone();
                let programs = request.accounts.get("protocol").ok_or(FeedError::Configuration)?.owner.clone();
                request = grpc_account_subscription(&programs, &watched)?;
                sink.send(request.clone()).await.map_err(|_|FeedError::Disconnected)?;
                continue;
            },
            item = stream.next() => item.ok_or(FeedError::Disconnected)?.map_err(|_|FeedError::Disconnected)?,
        };
        match update.update_oneof {
            Some(UpdateOneof::Ping(_)) => sink
                .send(SubscribeRequest {
                    ping: Some(SubscribeRequestPing { id: 1 }),
                    ..Default::default()
                })
                .await
                .map_err(|_| FeedError::Disconnected)?,
            Some(UpdateOneof::Account(account)) => {
                if update.filters.iter().any(|filter| filter == "signers") {
                    wakes.send_modify(|state| {
                        state.signer_generation = state.signer_generation.saturating_add(1)
                    });
                }
                if update
                    .filters
                    .iter()
                    .any(|filter| filter == "protocol" || filter == "custody")
                {
                    pending_activity.observe(account.slot);
                    hint(wakes, Some(account.slot), false);
                }
            }
            Some(UpdateOneof::Transaction(transaction)) => {
                pending_activity.observe(transaction.slot);
                hint(wakes, Some(transaction.slot), false)
            }
            Some(UpdateOneof::Slot(slot)) if pending_activity.progress(slot.slot, slot.status) => {
                hint(wakes, None, true)
            }
            _ => {}
        }
    }
}

pub fn pyth_subscription(config: &PythConfig) -> Result<PythSubscribe, FeedError> {
    let ids: BTreeSet<_> = config.feed_ids.iter().copied().collect();
    if config.token.is_empty()
        || ids.is_empty()
        || ids.contains(&0)
        || ids.len() != config.feed_ids.len()
    {
        return Err(FeedError::Configuration);
    }
    Ok(PythSubscribe {
        subscription_id: SubscriptionId(config.subscription_id),
        params: SubscriptionParams::new(SubscriptionParamsRepr {
            price_feed_ids: Some(config.feed_ids.iter().map(|id| PriceFeedId(*id)).collect()),
            symbols: None,
            properties: vec![
                PriceFeedProperty::Price,
                PriceFeedProperty::Exponent,
                PriceFeedProperty::Confidence,
                PriceFeedProperty::FeedUpdateTimestamp,
            ],
            formats: vec![Format::Solana],
            delivery_format: DeliveryFormat::Json,
            json_binary_encoding: JsonBinaryEncoding::Base64,
            parsed: false,
            channel: Channel::FixedRate(FixedRate::RATE_1000_MS),
            ignore_invalid_feeds: false,
        })
        .map_err(|_| FeedError::Configuration)?,
    })
}

pub fn signed_pyth_payload(
    response: AnyResponse,
    subscription_id: u64,
) -> Result<Option<Vec<u8>>, FeedError> {
    match response {
        AnyResponse::Json(WsResponse::StreamUpdated(update))
            if update.subscription_id.0 == subscription_id =>
        {
            let signed = update.payload.solana.ok_or(FeedError::InvalidPayload)?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&signed.data)
                .map_err(|_| FeedError::InvalidPayload)?;
            if bytes.is_empty() || bytes.len() > 65_638 {
                return Err(FeedError::InvalidPayload);
            }
            Ok(Some(bytes))
        }
        AnyResponse::Json(WsResponse::StreamUpdated(_)) => Ok(None),
        AnyResponse::Json(WsResponse::Subscribed(_))
        | AnyResponse::Json(WsResponse::Unsubscribed(_)) => Ok(None),
        AnyResponse::Json(WsResponse::Error(_))
        | AnyResponse::Json(WsResponse::SubscriptionError(_))
        | AnyResponse::Json(WsResponse::SubscribedWithInvalidFeedIdsIgnored(_)) => {
            Err(FeedError::Subscribe)
        }
        _ => Err(FeedError::InvalidPayload),
    }
}

pub async fn run_pyth(
    config: PythConfig,
    output: mpsc::Sender<Vec<u8>>,
    stop: watch::Receiver<bool>,
) -> Result<(), FeedError> {
    let (_sender, updates) = watch::channel(config.feed_ids.clone());
    run_pyth_dynamic(config, updates, output, stop).await
}
pub async fn run_pyth_dynamic(
    mut config: PythConfig,
    mut updates: watch::Receiver<Vec<u32>>,
    output: mpsc::Sender<Vec<u8>>,
    mut stop: watch::Receiver<bool>,
) -> Result<(), FeedError> {
    config.feed_ids = updates.borrow_and_update().clone();
    let request = pyth_subscription(&config)?;
    let mut client = PythLazerStreamClientBuilder::new(config.token.clone())
        .with_num_connections(3)
        .with_channel_capacity(16)
        .with_timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| FeedError::Configuration)?;
    let mut receiver = tokio::select! { _ = wait_stop(&mut stop) => return Ok(()), result = client.start() => result.map_err(|_| FeedError::Connect)? };
    client
        .subscribe(request)
        .await
        .map_err(|_| FeedError::Subscribe)?;
    loop {
        let response = tokio::select! {
            _ = wait_stop(&mut stop) => return Ok(()),
            changed = updates.changed() => {
                changed.map_err(|_|FeedError::ConsumerStopped)?;
                config.feed_ids = updates.borrow_and_update().clone();
                let request = pyth_subscription(&config)?;
                client.unsubscribe(SubscriptionId(config.subscription_id)).await.map_err(|_|FeedError::Subscribe)?;
                client.subscribe(request).await.map_err(|_|FeedError::Subscribe)?;
                continue;
            },
            item = receiver.recv() => item.ok_or(FeedError::Disconnected)?,
        };
        match signed_pyth_payload(response, config.subscription_id) {
            Ok(Some(bytes)) => {
                tokio::select! { _ = wait_stop(&mut stop) => return Ok(()), sent = output.send(bytes) => sent.map_err(|_| FeedError::ConsumerStopped)? }
            }
            Err(FeedError::Subscribe) => return Err(FeedError::Subscribe),
            _ => {}
        }
    }
}

async fn wait_stop(stop: &mut watch::Receiver<bool>) {
    while !*stop.borrow() {
        if stop.changed().await.is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn processed_subscription_is_only_a_filtered_wakeup() {
        let request =
            grpc_subscription(&["basic".to_owned(), "epoch".to_owned(), "basic".to_owned()])
                .unwrap();
        assert_eq!(request.commitment, Some(CommitmentLevel::Processed as i32));
        assert_eq!(
            request.transactions["predictions"].account_include,
            ["basic", "epoch"]
        );
        assert_eq!(request.transactions["predictions"].failed, Some(false));
        assert_eq!(request.accounts["protocol"].owner, ["basic", "epoch"]);
        assert_eq!(
            request.accounts["signers"].account,
            [crate::pyth::STORAGE_ADDRESS]
        );
        assert_eq!(
            request.slots["confirmation"].filter_by_commitment,
            Some(false)
        );
    }
    #[test]
    fn pyth_requests_signed_one_second_feed_without_trusting_parsed_json() {
        let request = pyth_subscription(&PythConfig {
            token: "redacted".into(),
            feed_ids: vec![1, 2],
            subscription_id: 7,
        })
        .unwrap();
        let value = serde_json::to_value(request).unwrap();
        assert_eq!(value["channel"], "fixed_rate@1000ms");
        assert_eq!(value["parsed"], false);
        assert_eq!(value["formats"], serde_json::json!(["solana"]));
    }
    #[test]
    fn wake_channel_coalesces_bursts_without_a_queue() {
        let (sender, receiver) = watch::channel(WakeHint::default());
        hint(&sender, Some(10), false);
        hint(&sender, Some(9), false);
        hint(&sender, None, true);
        assert_eq!(
            *receiver.borrow(),
            WakeHint {
                generation: 3,
                latest_slot: 10,
                reconcile: true,
                connected: false,
                signer_generation: 0,
                protocol_generation: 2
            }
        );
    }
    #[test]
    fn reconnect_health_without_successful_subscription_does_not_trigger_http() {
        let (sender, receiver) = watch::channel(WakeHint::default());
        for _ in 0..20 {
            connection(&sender, false);
        }
        assert_eq!(receiver.borrow().generation, 0);
        connection(&sender, true);
        hint(&sender, None, true);
        assert_eq!(receiver.borrow().generation, 1);
        assert!(receiver.borrow().reconcile);
        connection(&sender, false);
        assert_eq!(receiver.borrow().generation, 1);
    }
    #[test]
    fn custody_and_owner_filters_cover_direct_transfers_without_subscribing_to_all_slots() {
        let request =
            grpc_account_subscription(&["basic".into(), "epoch".into()], &["vault".into()])
                .unwrap();
        assert_eq!(request.accounts["custody"].account, ["vault"]);
        assert_eq!(
            request.transactions["predictions"].account_include,
            ["basic", "epoch", "vault"]
        );
        assert_eq!(
            request.slots["confirmation"].filter_by_commitment,
            Some(false)
        );
    }
    #[test]
    fn unrelated_slots_never_wake_but_delayed_confirmation_and_dead_pending_slots_wake_once() {
        let mut pending = PendingActivity::default();
        for slot in 1..100 {
            for status in 0..7 {
                assert!(!pending.progress(slot, status));
            }
        }
        pending.observe(100);
        pending.observe(100);
        assert!(!pending.progress(99, 1));
        assert!(!pending.progress(100, 0));
        assert!(!pending.progress(100, 3));
        assert!(pending.progress(101, 1));
        assert!(!pending.progress(102, 1));
        pending.observe(200);
        assert!(!pending.progress(199, 6));
        assert!(pending.progress(200, 6));
        assert!(!pending.progress(200, 6));
        pending.observe(300);
        assert!(pending.progress(301, 2));
    }
    #[test]
    fn invalid_catalogues_fail_before_connecting() {
        for ids in [vec![], vec![0], vec![1, 1]] {
            assert!(pyth_subscription(&PythConfig {
                token: "redacted".into(),
                feed_ids: ids,
                subscription_id: 1
            })
            .is_err());
        }
        assert!(grpc_subscription(&[]).is_err());
    }
    #[tokio::test]
    async fn bounded_output_backpressures_instead_of_dropping_price_history() {
        let (sender, mut receiver) = mpsc::channel::<Vec<u8>>(1);
        sender.send(vec![1]).await.unwrap();
        assert!(sender.try_send(vec![2]).is_err());
        assert_eq!(receiver.recv().await, Some(vec![1]));
    }
    #[tokio::test]
    async fn cancelled_wait_exits_immediately() {
        let (_sender, mut receiver) = watch::channel(true);
        wait_stop(&mut receiver).await;
    }
}
