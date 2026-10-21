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
    subscribe_update::UpdateOneof, CommitmentLevel, SubscribeRequest, SubscribeRequestFilterSlots,
    SubscribeRequestFilterTransactions, SubscribeRequestPing,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WakeHint {
    pub generation: u64,
    pub latest_slot: u64,
    pub reconcile: bool,
    pub connected: bool,
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
}
pub struct PythConfig {
    pub token: String,
    pub feed_ids: Vec<u32>,
    pub subscription_id: u64,
}

pub fn grpc_subscription(program_ids: &[String]) -> Result<SubscribeRequest, FeedError> {
    let ids: BTreeSet<_> = program_ids.iter().cloned().collect();
    if ids.is_empty() || ids.iter().any(|id| id.is_empty()) {
        return Err(FeedError::Configuration);
    }
    Ok(SubscribeRequest {
        slots: HashMap::from([(
            "progress".to_owned(),
            SubscribeRequestFilterSlots {
                filter_by_commitment: Some(false),
                ..Default::default()
            },
        )]),
        transactions: HashMap::from([(
            "predictions".to_owned(),
            SubscribeRequestFilterTransactions {
                vote: Some(false),
                failed: Some(false),
                account_include: ids.into_iter().collect(),
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
        state.latest_slot = state.latest_slot.max(slot.unwrap_or(0));
        state.reconcile |= reconcile;
    });
}

pub async fn run_grpc(
    config: GrpcConfig,
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
    let request = grpc_subscription(&config.program_ids)?;
    let mut delay = Duration::from_millis(250);
    loop {
        if *stop.borrow() {
            return Ok(());
        }
        wakes.send_modify(|state| state.connected = false);
        hint(&wakes, None, true);
        let session = grpc_session(&config, request.clone(), &wakes);
        tokio::select! { _ = wait_stop(&mut stop) => return Ok(()), _ = session => {} }
        wakes.send_modify(|state| state.connected = false);
        hint(&wakes, None, true);
        tokio::select! { _ = wait_stop(&mut stop) => return Ok(()), _ = tokio::time::sleep(delay) => {} }
        delay = (delay * 2).min(Duration::from_secs(10));
    }
}

async fn grpc_session(
    config: &GrpcConfig,
    request: SubscribeRequest,
    wakes: &watch::Sender<WakeHint>,
) -> Result<(), FeedError> {
    let mut client = GeyserGrpcClient::build_from_shared(config.endpoint.clone())
        .map_err(|_| FeedError::Configuration)?
        .x_token(Some(config.token.clone()))
        .map_err(|_| FeedError::Configuration)?
        .tls_config(tonic::transport::ClientTlsConfig::new().with_native_roots())
        .map_err(|_| FeedError::Configuration)?
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .connect()
        .await
        .map_err(|_| FeedError::Connect)?;
    let (mut sink, mut stream) = client
        .subscribe_with_request(Some(request))
        .await
        .map_err(|_| FeedError::Subscribe)?;
    wakes.send_modify(|state| state.connected = true);
    hint(wakes, None, true);
    while let Some(update) = stream.next().await {
        let update = update.map_err(|_| FeedError::Disconnected)?;
        match update.update_oneof {
            Some(UpdateOneof::Ping(_)) => sink
                .send(SubscribeRequest {
                    ping: Some(SubscribeRequestPing { id: 1 }),
                    ..Default::default()
                })
                .await
                .map_err(|_| FeedError::Disconnected)?,
            Some(UpdateOneof::Slot(slot)) if slot.status == 6 => hint(wakes, Some(slot.slot), true),
            Some(UpdateOneof::Transaction(transaction)) => {
                hint(wakes, Some(transaction.slot), false)
            }
            _ => {}
        }
    }
    Err(FeedError::Disconnected)
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
    mut stop: watch::Receiver<bool>,
) -> Result<(), FeedError> {
    let request = pyth_subscription(&config)?;
    let mut client = PythLazerStreamClientBuilder::new(config.token)
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
        let response = tokio::select! { _ = wait_stop(&mut stop) => return Ok(()), item = receiver.recv() => item.ok_or(FeedError::Disconnected)? };
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
        assert!(request.accounts.is_empty());
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
                connected: false
            }
        );
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
