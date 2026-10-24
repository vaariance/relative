use cox_math::{geometric::geometric_level, SCALE};
use relative_publisher::rpc::Rpc;
use serde_json::json;
use std::{hint::black_box, time::Instant};

#[tokio::main]
async fn main() {
    let result = match std::env::args().nth(1).as_deref() {
        Some("run") => match (
            std::env::args().nth(2).as_deref(),
            std::env::args().nth(3),
            std::env::args().nth(4),
        ) {
            (Some("--config"), Some(path), None) => {
                match relative_publisher::runtime::run(std::path::Path::new(&path)).await {
                    Ok(()) => Ok(()),
                    Err(relative_publisher::runtime::Error::Disabled) => {
                        println!("Publisher is disabled");
                        Ok(())
                    }
                    Err(error) => {
                        eprintln!("Native runtime exit: {error:?}");
                        Err("Native publisher stopped; configuration, custody, feed or recovery validation failed")
                    }
                }
            }
            _ => Err("Usage: relative-publisher run --config PATH"),
        },
        Some("capture-origin") => capture_origin().await,
        Some("capture-activation") => capture_activation().await,
        Some("prepare-methodology") => prepare_methodology(),
        Some("prepare-inclusion") => prepare_inclusion(),
        Some("prepare-universe") => prepare_universe(),
        Some("prepare-genesis-universe") => prepare_genesis_universe(),
        Some("prepare-fresh-genesis") => prepare_fresh_genesis(),
        Some("preview") => preview().await,
        Some("backup") => backup().await,
        Some("restore") => restore().await,
        Some("benchmark") => benchmark(),
        Some("probe-rpc") => probe().await,
        Some("probe-feeds") => probe_feeds().await,
        Some("probe-transaction") => probe_transaction().await,
        _ => {
            Err("Usage: relative-publisher run --config PATH | benchmark | probe-rpc | probe-feeds")
        }
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
async fn probe_transaction() -> Result<(), &'static str> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use relative_publisher::transactions::{compile, Budget};
    use solana_address::Address;
    use solana_instruction::Instruction;
    let key = std::env::var("ALCHEMY_API_KEY").map_err(|_| "Missing ALCHEMY_API_KEY")?;
    let rpc = Rpc::direct_devnet(&key).map_err(|_| "Invalid direct RPC configuration")?;
    let operator: Address = "GNmM11ZMFqEu3FYewGNDunpSSJBw8KnkDxzCGpSbpGj6"
        .parse()
        .map_err(|_| "Invalid operator")?;
    let memo: Address = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
        .parse()
        .map_err(|_| "Invalid memo")?;
    let blockhash = rpc
        .call("getLatestBlockhash", json!([{"commitment":"confirmed"}]))
        .await
        .map_err(|_| "Blockhash read failed")?;
    let hash = blockhash
        .pointer("/value/blockhash")
        .and_then(serde_json::Value::as_str)
        .ok_or("Missing blockhash")?
        .parse()
        .map_err(|_| "Invalid blockhash")?;
    let transaction = compile(
        operator,
        hash,
        &[Instruction {
            program_id: memo,
            accounts: vec![],
            data: vec![b'x'; 1600],
        }],
        &[memo],
        Budget {
            compute_units: 1_400_000,
            priority_fee_lamports: 0,
            heap_bytes: None,
        },
    )
    .map_err(|_| "Transaction compile failed")?;
    let response=rpc.call("simulateTransaction",json!([STANDARD.encode(&transaction.unsigned_transaction),{"encoding":"base64","commitment":"confirmed","sigVerify":false,"replaceRecentBlockhash":false}])).await;
    match response {
        Ok(value) => {
            println!(
                "{}",
                json!({"network":"solana-devnet","version":1,"transactionBytes":transaction.unsigned_transaction.len(),"simulationError":value.pointer("/value/err"),"unitsConsumed":value.pointer("/value/unitsConsumed"),"submittedTransactions":0,"proxy":false})
            );
            Ok(())
        }
        Err(_) => Err("Devnet RPC rejected the native V1 simulation; no transaction submitted"),
    }
}
fn benchmark() -> Result<(), &'static str> {
    let anchor = (0..30)
        .map(|index| 100_000_000 + index * 10_000_000)
        .collect::<Vec<u64>>();
    let current = anchor
        .iter()
        .enumerate()
        .map(|(index, price)| price * (91 + index as u64) / 100)
        .collect::<Vec<_>>();
    for _ in 0..100 {
        black_box(
            geometric_level(black_box(&anchor), black_box(&current), 100 * SCALE)
                .map_err(|_| "Benchmark arithmetic failed")?,
        );
    }
    let mut samples = Vec::with_capacity(1000);
    for _ in 0..1000 {
        let started = Instant::now();
        black_box(
            geometric_level(black_box(&anchor), black_box(&current), 100 * SCALE)
                .map_err(|_| "Benchmark arithmetic failed")?,
        );
        samples.push(started.elapsed().as_nanos());
    }
    samples.sort_unstable();
    println!(
        "{}",
        json!({"scope":"30-asset geometric calculation only", "language":"Rust", "build":if cfg!(debug_assertions) {"debug"} else {"release"}, "samples":samples.len(), "medianUs":samples[500] as f64 / 1000.0, "p99Us":samples[990] as f64 / 1000.0, "maxUs":samples[999] as f64 / 1000.0, "includesNetwork":false})
    );
    Ok(())
}
async fn probe() -> Result<(), &'static str> {
    let key = std::env::var("ALCHEMY_API_KEY").map_err(|_| "Missing ALCHEMY_API_KEY")?;
    let rpc = Rpc::direct_devnet(&key).map_err(|_| "Invalid direct RPC configuration")?;
    let started = Instant::now();
    let slot = rpc
        .call("getSlot", json!([{"commitment":"confirmed"}]))
        .await
        .map_err(|_| "Direct RPC read failed")?;
    println!(
        "{}",
        json!({"network":"solana-devnet", "proxy":false, "confirmedSlot":slot, "elapsedMs":started.elapsed().as_millis(), "submittedTransactions":0})
    );
    Ok(())
}

async fn probe_feeds() -> Result<(), &'static str> {
    use relative_publisher::{
        feeds::{run_grpc, run_pyth, GrpcConfig, PythConfig, WakeHint},
        pyth::{read_trusted_signers, verify_payload},
    };
    use tokio::sync::{mpsc, watch};
    let key = std::env::var("ALCHEMY_API_KEY").map_err(|_| "Missing ALCHEMY_API_KEY")?;
    let pyth = std::env::var("PYTH_API_KEY").map_err(|_| "Missing PYTH_API_KEY")?;
    let feed_ids = std::env::var("PYTH_FEED_IDS")
        .map_err(|_| "Missing PYTH_FEED_IDS")?
        .split(',')
        .map(|id| id.parse::<u32>().map_err(|_| "Invalid PYTH_FEED_IDS"))
        .collect::<Result<Vec<_>, _>>()?;
    let rpc = Rpc::direct_devnet(&key).map_err(|_| "Invalid direct RPC configuration")?;
    let signers = read_trusted_signers(&rpc)
        .await
        .map_err(|_| "Pyth signer storage verification failed")?;
    let (stops, stop) = watch::channel(false);
    let (wakes, mut wake) = watch::channel(WakeHint::default());
    let (prices, mut price) = mpsc::channel(4);
    let (_account_updates, account_ids) = watch::channel(Vec::new());
    let grpc_task = tokio::spawn(run_grpc(
        GrpcConfig {
            endpoint: "https://solana-devnet.streaming.alchemy.com".into(),
            token: key,
            program_ids: vec!["G6iQGoupNSfduw1QJxQ9vcVi9FnCC6cbippXsi4QQzJF".into()],
            account_ids,
        },
        wakes,
        stop.clone(),
    ));
    let expected = feed_ids.clone();
    let pyth_task = tokio::spawn(run_pyth(
        PythConfig {
            token: pyth,
            feed_ids,
            subscription_id: 7,
        },
        prices,
        stop,
    ));
    let checked = tokio::time::timeout(std::time::Duration::from_secs(25), async {
        let bytes = price.recv().await.ok_or("No Pyth update")?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| "Invalid system clock")?.as_secs();
        let data = verify_payload(&bytes, &signers, now, 60_000_000).map_err(|_| "Signed Pyth verification failed")?;
        if data.prices.len() != expected.len() || !expected.iter().all(|id| data.prices.iter().any(|price| price.feed_id == *id)) { return Err("Incomplete Pyth roster"); }
        if data.timestamp_us % 1_000_000 != 0 { return Err("Pyth snapshot is not aligned to the required one-second publication grid"); }
        for value in &data.prices {
            relative_publisher::benchmark::price_e8(value.price, value.exponent).map_err(|_| "Pyth price conversion failed")?;
        }
        while !wake.borrow().connected { wake.changed().await.map_err(|_| "gRPC stream stopped")?; }
        Ok(json!({"network":"solana-devnet", "nativePythSignatureVerified":true, "verifiedFeedCount":data.prices.len(), "signedBytes":bytes.len(), "nativeGrpcConnected":true, "wholeSecondSnapshot":true, "priceConversionVerified":true, "proxy":false, "submittedTransactions":0}))
    }).await;
    let _ = stops.send(true);
    let _ = grpc_task.await;
    let _ = pyth_task.await;
    let report = checked.map_err(|_| "Native feed probe timed out")??;
    println!("{report}");
    Ok(())
}

async fn backup() -> Result<(), &'static str> {
    let arguments = std::env::args().skip(2).collect::<Vec<_>>();
    if arguments.len() != 2 || arguments[0] != "--config" {
        return Err("Usage: relative-publisher backup --config PATH");
    }
    let config = relative_publisher::backup::Config::read(std::path::Path::new(&arguments[1]))
        .map_err(|_| "Invalid native backup configuration")?;
    let transport = relative_publisher::backup::Gcs::new(&config)
        .map_err(|_| "Native backup transport configuration failed")?;
    let report = relative_publisher::backup::backup(&config, &transport)
        .await
        .map_err(|_| "Native backup failed; no complete manifest was acknowledged")?;
    println!(
        "{}",
        serde_json::to_string(&report).map_err(|_| "Native backup report failed")?
    );
    Ok(())
}
async fn restore() -> Result<(), &'static str> {
    let arguments = std::env::args().skip(2).collect::<Vec<_>>();
    if arguments.len() != 6
        || arguments[0] != "--config"
        || arguments[2] != "--manifest"
        || arguments[4] != "--destination"
    {
        return Err("Usage: relative-publisher restore --config PATH --manifest SHA256 --destination NEW_ABSOLUTE_DIRECTORY");
    }
    let config = relative_publisher::backup::Config::read(std::path::Path::new(&arguments[1]))
        .map_err(|_| "Invalid native restore configuration")?;
    let transport = relative_publisher::backup::Gcs::new(&config)
        .map_err(|_| "Native restore transport configuration failed")?;
    let manifest = relative_publisher::backup::restore(
        &config,
        &transport,
        &arguments[3],
        std::path::Path::new(&arguments[5]),
    )
    .await
    .map_err(|_| "Native restore verification failed; partial destination must not be activated")?;
    println!(
        "{}",
        serde_json::json!({"verified":true,"files":manifest.entries.len(),"manifestSha256":arguments[3]})
    );
    Ok(())
}

fn prepare_inclusion() -> Result<(), &'static str> {
    let arguments = std::env::args().skip(2).collect::<Vec<_>>();
    if arguments.len() != 4 || arguments[0] != "--request" || arguments[2] != "--output" {
        return Err("Usage: relative-publisher prepare-inclusion --request ABSOLUTE_PATH --output NEW_ABSOLUTE_PATH");
    }
    let artifact = relative_publisher::preparation::prepare(
        std::path::Path::new(&arguments[1]),
        std::path::Path::new(&arguments[3]),
    )
    .map_err(|_| {
        "Inclusion preparation failed; no runtime configuration or active universe was changed"
    })?;
    println!(
        "{}",
        serde_json::json!({"prepared":true,"activated":false,"digest":artifact.digest,"blockers":artifact.blockers})
    );
    Ok(())
}

fn prepare_universe() -> Result<(), &'static str> {
    let arguments = std::env::args().skip(2).collect::<Vec<_>>();
    if arguments.len() != 4 || arguments[0] != "--request" || arguments[2] != "--output" {
        return Err("Usage: relative-publisher prepare-universe --request ABSOLUTE_PATH --output NEW_ABSOLUTE_PATH");
    }
    let artifact = relative_publisher::inclusion_pipeline::prepare_file(
        std::path::Path::new(&arguments[1]),
        std::path::Path::new(&arguments[3]),
    ).map_err(|_| "Universe preparation failed; admission, approval schedule, signed capture or lineage validation failed")?;
    println!(
        "{}",
        serde_json::json!({
            "prepared": true, "activated": false,
            "digest": artifact.digest,
            "submittedTransactions": 0,
        })
    );
    Ok(())
}

fn prepare_fresh_genesis() -> Result<(), &'static str> {
    let arguments = std::env::args().skip(2).collect::<Vec<_>>();
    if arguments.len() != 4 || arguments[0] != "--request" || arguments[2] != "--output" {
        return Err("Usage: relative-publisher prepare-fresh-genesis --request ABSOLUTE_PATH --output NEW_ABSOLUTE_PATH");
    }
    let receipt = relative_publisher::universe_runtime::prepare_fresh_genesis_file(
        std::path::Path::new(&arguments[1]),
        std::path::Path::new(&arguments[3]),
    )
    .map_err(|_| {
        "Fresh genesis preparation failed; signed capture or identity validation failed"
    })?;
    let view = receipt
        .validate()
        .map_err(|_| "Genesis receipt validation failed")?;
    println!(
        "{}",
        serde_json::json!({"prepared": true, "activated": false,
        "digest": hex::encode(view.digest), "assetCount": view.mapping.len(), "submittedTransactions": 0})
    );
    Ok(())
}

fn prepare_genesis_universe() -> Result<(), &'static str> {
    let arguments = std::env::args().skip(2).collect::<Vec<_>>();
    if arguments.len() != 4 || arguments[0] != "--request" || arguments[2] != "--output" {
        return Err("Usage: relative-publisher prepare-genesis-universe --request ABSOLUTE_PATH --output NEW_ABSOLUTE_PATH");
    }
    let receipt = relative_publisher::universe_runtime::prepare_genesis_file(
        std::path::Path::new(&arguments[1]), std::path::Path::new(&arguments[3]),
    ).map_err(|_| "Genesis universe preparation failed; original methodology, capture or identity validation failed")?;
    let view = receipt
        .validate()
        .map_err(|_| "Genesis receipt validation failed")?;
    println!(
        "{}",
        serde_json::json!({"prepared": true, "activated": false,
        "digest": hex::encode(view.digest), "assetCount": view.mapping.len(), "submittedTransactions": 0})
    );
    Ok(())
}

fn prepare_methodology() -> Result<(), &'static str> {
    let arguments = std::env::args().skip(2).collect::<Vec<_>>();
    if arguments.len() != 4 || arguments[0] != "--request" || arguments[2] != "--output" {
        return Err("Usage: relative-publisher prepare-methodology --request ABSOLUTE_PATH --output NEW_ABSOLUTE_PATH");
    }
    let artifact = relative_publisher::methodology::prepare_file(
        std::path::Path::new(&arguments[1]),
        std::path::Path::new(&arguments[3]),
    )
    .map_err(|_| {
        "Methodology preparation failed; no signing, submission or runtime changes performed"
    })?;
    println!(
        "{}",
        serde_json::json!({"prepared":true,"activated":false,"digest":artifact.digest,"methodology":artifact.methodology_address,"pool":artifact.pool_admission.pool_address,"tradingOpensAt":artifact.pool_admission.trading_opens_at})
    );
    Ok(())
}

async fn capture_origin() -> Result<(), &'static str> {
    let arguments = std::env::args().skip(2).collect::<Vec<_>>();
    if arguments.len() != 4 || arguments[0] != "--request" || arguments[2] != "--output" {
        return Err("Usage: relative-publisher capture-origin --request ABSOLUTE_PATH --output NEW_ABSOLUTE_PATH");
    }
    let artifact = relative_publisher::origin::capture_file(std::path::Path::new(&arguments[1]), std::path::Path::new(&arguments[3])).await
        .map_err(|_| "Origin capture failed; request, credentials, devnet, signed feed or output validation failed")?;
    println!(
        "{}",
        serde_json::json!({"captured":true,"signatureVerified":true,"feedCount":artifact.assets.len(),"timestampUs":artifact.timestamp_us,"digest":artifact.digest,"submittedTransactions":0})
    );
    Ok(())
}

async fn preview() -> Result<(), &'static str> {
    let args = std::env::args().skip(2).collect::<Vec<_>>();
    if args.len() != 4 || args[0] != "--config" || args[2] != "--backup-config" {
        return Err("Usage: relative-publisher preview --config PATH --backup-config PATH");
    }
    relative_publisher::preview::run(
        std::path::Path::new(&args[1]),
        std::path::Path::new(&args[3]),
    )
    .await
    .map_err(|_| {
        "Preview export stopped; configuration, source, storage or upload integrity failed"
    })
}

async fn capture_activation() -> Result<(), &'static str> {
    let arguments = std::env::args().skip(2).collect::<Vec<_>>();
    if arguments.len() != 4 || arguments[0] != "--request" || arguments[2] != "--output" {
        return Err("Usage: relative-publisher capture-activation --request ABSOLUTE_PATH --output NEW_ABSOLUTE_PATH");
    }
    let artifact = relative_publisher::activation::capture_file(std::path::Path::new(&arguments[1]), std::path::Path::new(&arguments[3])).await
        .map_err(|_| "Activation capture failed; exact boundary, signed feed, continuity or output validation failed; no transaction submitted")?;
    println!(
        "{}",
        serde_json::json!({"captured":true,"activated":false,"signatureVerified":true,"feedCount":artifact.captured.assets.len(),"timestampUs":artifact.captured.timestamp_us,"benchmark":artifact.old_benchmark.to_string(),"digest":artifact.digest,"submittedTransactions":0})
    );
    Ok(())
}
