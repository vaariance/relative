# Relative native publisher

The default publisher entry point is now the Rust executable in `native/`. It connects signed one-second Pyth Pro feeds, the geometric benchmark, processed Yellowstone wake notifications, confirmed Solana reads, remote signing and durable recovery. Direct Alchemy RPC is primary; public devnet RPC is the fallback. No RPC proxy is used.

The native service is deployed for Basic pool 2 and Epoch config 2. Real devnet bootstrap, initial fee activation and archive recovery are verified; public trading remains paused pending readiness. Legacy pool 1 is retired and explicitly rejected. Runtime signing uses the bound adaptive canary; existing default signer traffic is unchanged.

## Build and run

Use Rust 1.90 or later for this standalone native workspace. Keep the Solana program build toolchain separate.

```sh
pnpm --filter @eox/cox-publisher build
pnpm --filter @eox/cox-publisher test
pnpm --filter @eox/cox-publisher start --config /path/to/private/native.json
```

The service template runs the built binary directly; Node is not required by the publisher runtime. The Rust process acquires its own operating-system lock. A disabled configuration exits successfully before reading secrets or contacting the network. The retired TypeScript configuration and implementation have been removed; use the native configuration schema below.

Private native configuration uses schema `relative.publisher/v1` and strict JSON fields matching `native/src/runtime.rs::Config`: `enabled`, `network`, `state_directory`, `operator`, `basic_program`, `basic_pool_id`, `first_epoch_opens_at`, `epoch_program`, `epoch_config`, `key_version`, `anchor`, `mapping`, `compute_units`, `priority_fee_lamports`, `heap_bytes`, `batch_limit`, `max_operations`, `max_price_age_ms`, and `max_feed_age_ms`. Network must be `solana-devnet`. State directory must be absolute. Anchor binds the universe digest, origin timestamp in microseconds, benchmark and ordered Pyth Pro assets; mappings bind those assets to both contracts. `first_epoch_opens_at` is a four-hour UTC boundary at or after the benchmark origin, at or after Basic's on-chain admission lower bound. A paused registry may postpone actual Basic admission without moving that immutable lower bound. Do not reuse a state directory with another configuration.

Provide `ALCHEMY_API_KEY`, `PYTH_API_KEY`, `SIGNER_URL` and `SIGNER_AUDIENCE` privately through the service environment. Never commit those values. Signing uses the existing publisher Google workload identity and remote KMS service; no local operator private key is accepted.

Read-only diagnostic commands are `benchmark`, `probe-rpc`, `probe-feeds` and `probe-transaction`; `probe-feeds` also requires comma-separated `PYTH_FEED_IDS`. They do not submit transactions.

## Prepare the adaptive methodology

`relative-publisher capture-origin --request ABSOLUTE_PATH --output NEW_ABSOLUTE_PATH` captures the actual origin from signed Pyth Pro data. The strict `relative.origin-request/v1` input supplies ordered asset names/numeric feed IDs and `max_feed_age_ms`; credentials stay in the environment. It verifies direct devnet genesis, trusted signer storage, exact full-roster binding, whole-second time, freshness and price conversion. The create-only output retains raw signed evidence and provenance without inventing a universe or token identities. It submits no transactions.

`relative-publisher prepare-methodology --request ABSOLUTE_PATH --output NEW_ABSOLUTE_PATH` validates a strict `relative.methodology-request/v1` request and creates an immutable preparation artifact. Supply explicit program/pool/operator identities, the original benchmark anchor and asset mappings, feed-check digest, both freshness limits and `trading_opens_at`. Admission must be a four-hour UTC boundary at or after the whole-second origin; it does not reset that origin. The output contains canonical Borsh bytes, SHA-256 digest, methodology PDA, seal configuration/arguments and scheduled pool initializer arguments. It neither signs nor submits transactions.

Adaptive methodology schema 2 binds the Pyth numeric feeds, initial prices, universe commitment, geometric calculation and publication policy. Native account reads validate the canonical policy and digest; the executor compares those commitments with its configured anchor, mapping and freshness limits before signing. Basic and Epoch must use the same methodology digest. Legacy schema 1 remains distinct. On-chain publication is operator-attested, without an on-chain Pyth or computation proof.

## Scheduling and recovery

Pyth verification, benchmark calculation and durable price archival continue independently of on-chain publication. The publisher wakes for meaningful processed transaction/reconnect notifications, checks authoritative confirmed accounts, and stays on a one-second attempt cadence while work remains. A short notification retry period covers the gap between processed notification and confirmed visibility. Idle safety reconciliation occurs at most every 30 seconds; ordinary slot notifications do not cause publication. A due pending fee schedule creates one publication task so fees can activate before admission without waiting for a user order. Future fee schedules retain idle cadence; pause and accepted-batch rules still apply.

One transaction may combine Basic publication and bounded processing with Epoch snapshot publication and entry execution. Account, byte and compute limits can require additional transactions. A publication cannot guarantee clearing an unbounded backlog. Accepted Basic batches retain their original prices until drained. Epoch closing selects the exact predefined timestamp; missing history never substitutes a later price. Refund and void maintenance does not require a fresh feed.

Persisted unsigned requests are reused after uncertain signing. Signed bytes are saved before broadcast and reconciled before preparing new work. A provably stale unsigned draft may be discarded; uncertain signed submissions are retained until accepted or expired. Preserve the complete state directory, including identity, checkpoint, prices and publications.

Before overwriting the reusable Basic publication account, the native executor archives its exact bytes and validates the state digest and predecessor chain. Native archive schema `cox.publication-archive/v2` records `commitment: confirmed` and `observedSlot`; these records are not finalized evidence. Legacy v1 finalized records retain their original provenance. An archive gap, conflicting record or storage failure blocks processing.

Discovery persists per-phase nonce cursors instead of scanning all program accounts. Each read considers the oldest unfinished epoch and the current epoch, with at most four pages of 16 lots per epoch. It advances past at most eight missing or finished epochs per read. Incomplete discovery keeps one-second reconciliation active; only finalized non-actionable prefixes can advance durable skip cursors. These are per-read bounds, not lifetime limits on participation. Basic and Epoch custody checks include both configured collateral vaults; the publisher supplies Basic's optional second-vault account when dual collateral is configured.

Epoch snapshot creation, consumption and rent recovery stay in one transaction. An accepted entry copies its references into the epoch state before the temporary snapshot account closes to the configured operator. Trimming an oversized transaction preserves that group or removes it entirely.

### Native backup and restore

The backup service template runs `relative-publisher backup --config /etc/cox-publisher/native-backup.json`. Its strict private configuration contains `schema: "relative.backup/v1"`, `bucket`, `prefix`, absolute `state_directory` and `markers_directory`, plus `max_file_bytes`, `max_files` and `max_total_bytes`. Keep markers outside price/publication trees. The workload identity needs create and read access to its private object prefix: a create-only conflict is verified by downloading the existing generation. No JSON key file or publisher secret is backed up.

For API backfill, optionally configure `publication_history_prefix: "pool-2/history"` together with `publication_identity: {"program": "<program address>", "pool": "<pool address>", "genesisHash": "<devnet genesis hash>"}`. The backup validates each publication account, configured identity, sequence and commitment provenance before exporting its unchanged archive bytes to `gs://<bucket>/pool-2/history/<decimal sequence>/<sha256 of archive bytes>.json`. This matches the API’s existing GCS archive reader; use `gs://colosseum-cox-publication-archives-dev/pool-2/history/` for pool 2. The recovery objects and manifests under `basic-2/native` remain separate. Export uses create-only uploads and verifies existing objects on retries.

Cloud history becomes available after the backup timer successfully runs, so API reads must retry a temporarily missing publication. The executor preserves a publication before the next overwrite; the latest publication may therefore exist only on chain until another publication begins. Confirmed v2 records retain their observed slot and never become finalized evidence through backup. The bucket stays private; API workloads need object read/list access. Configuring this path alone does not install or enable the backup timer.

The allowlist includes identity, checkpoint, discovery cursors, benchmark pointers, immutable price/anchor records and publication history. It excludes configuration, credentials, locks and temporary files. Mutable pointers are captured before uploading; SHA-256 identities and Cloud Storage CRC32C acknowledgements are checked, and the manifest is committed last. Configured size limits fail closed; choose limits for the retained history and monitor failures. The minute timer is asynchronous and can lag local state.

With the publisher stopped, an authorized reader can restore a specific successful manifest into a new absolute directory:

```sh
relative-publisher restore --config /etc/cox-publisher/native-backup.json --manifest SHA256 --destination /var/lib/cox-publisher-restored
```

Restore rejects existing destinations, unsafe paths and checksum mismatches. Verify the restored publication chain and runtime identity, then reconcile chain state before switching directories and starting one publisher. Local simulated-storage tests cover integrity and concurrent checkpoint capture. Pool 2 rollout from committed `027fd7420021742cf86b3174caea69177f3ad771` verified a real cloud archive record and an isolated restore of a 69-file native recovery manifest. The Rust runtime and minute backup timer run on the European dev VM; Basic remains registry-paused and Epoch drafts unsealed. See the [deployment record](../../packages/cox/deploy/adaptive-pool-2-devnet.json) for hashes and verification boundaries. Backups currently walk retained history each run; incremental uploads and explicit retention remain operational follow-up work.

## Migration boundary

| Component | Retirement scope |
| --- | --- |
| `apps/cox-publisher` | Rust runtime is live; legacy TypeScript implementation, tests and dependencies removed. |
| `packages/cox-methodology` | Rust methodology retained; legacy TypeScript exports and fixture generator removed after the API migrated to the Rust CLI. |
| `apps/rpc-proxy` | Retire the protocol's dependency; shared source/deployment removal requires remaining consumers to migrate. |

These are two TypeScript implementation replacements and one proxy dependency retirement. The publisher and methodology package directories remain required for their Rust crates. `price-feeds`, `cox-monitor`, signer/signing, APIs, ingestion, web, contracts and the client SDK remain required.

Native inclusion lifecycle and exact-rational Epoch simulation are library implementations with parity tests. Dynamic universe activation and expanded Basic class support are separate integration work; the executable currently binds the sealed Basic roster, at most 30 assets, and Pyth Pro IDs. Paged discovery covers larger participant counts but does not expand the asset roster or transaction capacity. Missing historical Pyth closing data has no backfill implementation. Archived payloads are reverified against known trusted signer keys; unavailable historical keys fail closed.

`relative-publisher prepare-inclusion --request ABSOLUTE_PATH --output NEW_ABSOLUTE_PATH` prepares an immutable inclusion artifact without changing the active universe, publisher configuration or chain state. The strict `relative.inclusion-request/v1` input contains `previous` and `next` universe snapshots and their explicit `previous_bindings`/`next_bindings` (`relative-methodology::transition::Request`). Bindings join stable asset identities to runtime names, Pro feed IDs, Basic class IDs and Epoch feed IDs. Retained bindings must preserve their original price/benchmark references exactly; new bindings must leave those references absent until verified activation-time capture. Input references are operator-supplied facts, not authenticated chain reads. The deterministic artifact digest binds the request and its unresolved blockers: Basic dynamic roster support, Epoch snapshot staging, verified activation prices and runtime transition integration. It is preparation evidence, not an executable activation approval. Native benchmark calculation supports the methodology's full 256-asset capacity; current Basic runtime binding remains limited to 30.


The retired minute publisher implementation and TypeScript backup script were removed after native publication, fee activation and real archive recovery were verified. Shared protocol fixtures remain unchanged. Historical verification results are preserved in Git and the append-only agent log.
