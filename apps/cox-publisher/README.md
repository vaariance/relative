# Relative native publisher

The default publisher entry point is now the Rust executable in `native/`. It connects signed one-second Pyth Pro feeds, the geometric benchmark, processed Yellowstone wake notifications, confirmed Solana reads, remote signing and durable recovery. Direct Alchemy RPC is primary; public devnet RPC is the fallback. No RPC proxy is used.

The native service is deployed for Basic pool 2 and Epoch config 2. Real devnet bootstrap, initial fee activation and archive recovery are verified; Basic trading is open after verified deposit/redemption, archive recovery and preview delivery. Epoch remains separate and awaits its live lifecycle verification. Legacy pool 1 is retired and explicitly rejected. Runtime signing uses the bound adaptive canary; existing default signer traffic is unchanged.

## Event-driven chain access

The event-driven release deployed on 2026-10-22 at 22:48 UTC uses gRPC notifications for protocol accounts, custody and Pyth signer storage. Confirmed HTTP reads run at startup, after relevant events or stream recovery, at scheduled protocol deadlines, and once per 20 minutes of idle safety reconciliation. Pending execution and transaction confirmation retain the one-second cadence; an executed Epoch entry awaiting its closing timestamp does not keep chain polling active. Repeated errors back off rather than silently creating a continuous HTTP loop. Pyth observations, gRPC heartbeats and unrelated slot updates do not trigger pool reads.

Preview records may include `chainChange`, schema `relative.chain-change/v1`: `generation` (64 lowercase hexadecimal characters), `revision` (decimal string), `observedSlot`, `commitment: "confirmed"`, and `streamHealthy`. It is cache-invalidation metadata, not confirmation of the accompanying estimate. Revisions advance for changed reconciled state, confirmed relevant activity or successful stream catch-up; price-only records retain the same revision. A generation change or skipped revision requires one coalesced consumer refresh. Consumers mark disconnected or stale feeds explicitly and retain transaction-preparation validation. Joel owns API adoption; source changes alone do not remove API polling.

Independent chain notifications use `pool-2/chain-changes/<20-digit Unix milliseconds>-<sha256>.json`, schema `relative.chain-notification/v1`, with `timestampMs`, network/program/pool identity and the same `chainChange` metadata. The exporter emits changes and a 20-second heartbeat even without Pyth observations. Consumers treat 60 seconds without a notification as unhealthy, use one coalesced catch-up after recovery, and never infer financial finality from notification provenance. A local five-second liveness lease makes stale publisher state unhealthy after 15 seconds. The prefix shares seven-day preview retention; durable publication history remains separate.

Private `rpc-usage.json` counts physical HTTP attempts, including failed primary/fallback attempts, grouped by method, trigger and upstream name. It contains no endpoint URLs or credentials and resets when the publisher process starts. GCS preview/backup calls and Pyth API traffic are outside these Solana counters. Use process lifetime and provider dashboard windows when comparing usage.

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

## Dynamic universe preparation

The schema-5 Basic upgrade is prepared source and is not deployed. It supports at most 255 underlying assets plus CRYPTO. Existing classes and permanent reference origins stay fixed; CRYPTO remains class 30 and additions use classes 31 onward. Each Epoch keeps its opening universe and each executed basket keeps 30 distinct assets. Price-only instruments have no token mint.

`relative-publisher prepare-genesis-universe --request ABSOLUTE_PATH --output NEW_ABSOLUTE_PATH` prepares the initial 30-asset migration receipt from the original validated methodology and signed origin capture, bound to the supplied predecessor sequence/state. It submits no transaction. The deployed pool must independently match those bindings before migration.

`relative-publisher capture-activation --request ABSOLUTE_PATH --output NEW_ABSOLUTE_PATH` captures signed full-roster prices at the exact future activation second. It fails on a missed boundary rather than selecting another timestamp. `relative-publisher prepare-universe` uses the same request/output flags to validate admission, operator approval, schedule-account evidence, immutable predecessors and the capture before creating a successor receipt. Its status is prepared: an artifact containing account evidence does not independently establish live chain existence.

Universe receipts are immutable recovery files under `universes/<digest>.json`. The publisher checks them against the confirmed sealed on-chain canonical manifest. After activation, it resumes any staged candidate observations without moving the active history pointer early. Preview references continue to use permanent asset origins, and preview rows retain stable class IDs. An approved boundary caps old-universe preview export so it cannot occupy the same second's object names needed by the new roster.

Large Basic and Epoch snapshots use bounded transaction batches. Accepted preparation resumes its original signed timestamp and price prefix; later observations cannot replace it. Historical signer keys unavailable after restart fail closed and require explicit recovery, without changing an Epoch closing reference. The benchmark remains operator-attested; these validation checks are not a decentralized calculation proof.

Activation requires the real Epoch lifecycle check, the in-place upgrade rehearsal, current signer bindings and Joel's versioned roster/cache consumers. The live inclusion is a separate rollout from the deployed billing fix.

## Scheduling and recovery

Pyth verification, benchmark calculation and durable price archival continue independently of on-chain publication. The publisher wakes for meaningful processed transaction/reconnect notifications, checks authoritative confirmed accounts, and stays on a one-second attempt cadence while work remains. A short notification retry period covers the gap between processed notification and confirmed visibility. Idle safety reconciliation occurs at most every 30 seconds; ordinary slot notifications do not cause publication. A due pending fee schedule creates one publication task so fees can activate before admission without waiting for a user order. Future fee schedules retain idle cadence; pause and accepted-batch rules still apply.

One transaction may combine Basic publication and bounded processing with Epoch snapshot publication and entry execution. Account, byte and compute limits can require additional transactions. A publication cannot guarantee clearing an unbounded backlog. Accepted Basic batches retain their original prices until drained. Epoch closing selects the exact predefined timestamp; missing history never substitutes a later price. Refund and void maintenance does not require a fresh feed.

Persisted unsigned requests are reused after uncertain signing. Signed bytes are saved before broadcast and reconciled before preparing new work. A provably stale unsigned draft may be discarded; uncertain signed submissions are retained until accepted or expired. Preserve the complete state directory, including identity, checkpoint, prices and publications.

Before overwriting the reusable Basic publication account, the native executor archives its exact bytes and validates the state digest and predecessor chain. Native archive schema `cox.publication-archive/v2` records `commitment: confirmed` and `observedSlot`; these records are not finalized evidence. Legacy v1 finalized records retain their original provenance. An archive gap, conflicting record or storage failure blocks processing.

Discovery persists per-phase nonce cursors instead of scanning all program accounts. Each read considers the oldest unfinished epoch and the current epoch, with at most four pages of 16 lots per epoch. It advances past at most eight missing or finished epochs per read. Incomplete discovery keeps one-second reconciliation active; only finalized non-actionable prefixes can advance durable skip cursors. These are per-read bounds, not lifetime limits on participation. Basic and Epoch custody checks include both configured collateral vaults; the publisher supplies Basic's optional second-vault account when dual collateral is configured.

Epoch snapshot creation, consumption and rent recovery stay in one transaction. An accepted entry copies its references into the epoch state before the temporary snapshot account closes to the configured operator. Trimming an oversized transaction preserves that group or removes it entirely.

### Per-second live estimates

`relative-publisher preview --config /etc/cox-publisher/native.json --backup-config /etc/cox-publisher/native-backup.json` exports the existing pool 2, 30-asset methodology results independently of settlement. The service template is `deploy/dev/cox-publisher-preview.service`. Installation and a real cloud sample must be verified before consumers depend on this exporter.

Objects are create-only at `gs://colosseum-cox-publication-archives-dev/pool-2/preview/<unix seconds>.json`, separate from publication `history/`. Schema `relative.preview/v1` contains `status: "estimate"`, the actual Pyth observation `timestamp`, network/program/pool identities, methodology/universe digests, `scales`, `benchmark`, and 30 `assets` with `classId`, `assetId`, `priceE8` and `reference`. `cryptoClass` identifies the benchmark class; `cryptoReference` is its constant relative reference. Financial integers are decimal strings; price scale is 100000000, reference/benchmark scale is 1000000000000 and collateral scale is 1000000. No credentials or signed feed payloads are exported.

References are not position NAV. Optional `basicProjection` supplies the existing Rust redistribution calculation's class `backing` and `units`, plus `addedResidual`, based on confirmed ledger `sequence`, `stateDigest` and `publicationTimestamp`. It is null when that ledger cannot project the observation. The API relays methodology outputs and applies its existing owner/locked/pending unit rules. It must label estimates, retain source timestamps, handle missing seconds/staleness, and reconcile actual publications by timestamp and state; a later publication does not confirm every intervening estimate.

The publisher exports its ledger during existing authoritative reads without extra RPC requests. A separate producer reads verified local price history and durably spools each available new second; it starts at the latest fresh observation and does not invent missing seconds. Upload retries run independently, verify create-only conflicts and delete a spool file only after acknowledgement. The private sibling directory `<state_directory>.preview-spool` remains outside financial recovery backups. Cloud latency is additional to feed latency; this is not a subsecond delivery guarantee. The rollout policy expires preview objects after seven days. Pending local uploads remain durable; a 100,000-record spool limit fails closed rather than silently dropping estimates.

### Native backup and restore

The backup service template runs `relative-publisher backup --config /etc/cox-publisher/native-backup.json`. Its strict private configuration contains `schema: "relative.backup/v1"`, `bucket`, `prefix`, absolute `state_directory` and `markers_directory`, plus `max_file_bytes`, `max_files` and `max_total_bytes`. Keep markers outside price/publication trees. The workload identity needs create and read access to its private object prefix: a create-only conflict is verified by downloading the existing generation. No JSON key file or publisher secret is backed up.

For API backfill, optionally configure `publication_history_prefix: "pool-2/history"` together with `publication_identity: {"program": "<program address>", "pool": "<pool address>", "genesisHash": "<devnet genesis hash>"}`. The backup validates each publication account, configured identity, sequence and commitment provenance before exporting its unchanged archive bytes to `gs://<bucket>/pool-2/history/<decimal sequence>/<sha256 of archive bytes>.json`. This matches the API’s existing GCS archive reader; use `gs://colosseum-cox-publication-archives-dev/pool-2/history/` for pool 2. The recovery objects and manifests under `basic-2/native` remain separate. Export uses create-only uploads and verifies existing objects on retries.

Publication history is uploaded before recovery price objects, so it can become available even while the larger recovery upload is still catching up. API reads must retry a temporarily missing publication. The executor preserves a publication before the next overwrite; the latest publication may therefore exist only on chain until another publication begins. Confirmed v2 records retain their observed slot and never become finalized evidence through backup. The bucket stays private; API workloads need object read/list access. Configuring this path alone does not install or enable the backup timer.

Set `incremental: true` to persist verified upload receipts, bound to bucket, prefixes and runtime identity. Retries and restarts reuse acknowledged create-only objects; an interrupted job preserves progress before a manifest exists. The exclusive backup lock prevents competing writers. Publications upload first, followed by at most 32 concurrent recovery uploads. Existing-object conflicts still require byte and checksum verification before the first receipt is written. Receipts assume the acknowledged cloud objects remain immutable: do not manually delete/overwrite recovery CAS objects or apply expiry to `basic-2/native/objects/`. If that assumption changes, remove the local receipt cache and run a complete revalidation before relying on new manifests.

Optional `retain_price_seconds` requires incremental mode and accepts 36–48 hours. The rollout uses 129600 seconds (36 hours), beyond a four-hour Epoch plus its 24-hour missing-data recovery window. Old immutable local prices are removed only after every snapshot object and its complete manifest are acknowledged, and their bytes are rechecked before deletion. The latest observation, anchors, checkpoint and pending transaction state remain. Optional `retain_publications` (minimum two; rollout 128) removes older local publication records only after their validated API-history and recovery objects are acknowledged. Cloud publication history remains permanent, and local predecessors required for the next publication remain available. Only three local completed-manifest markers are retained; unused local receipts are removed. Configure `max_files: 200000` for this window. Cloud lifecycle rules may expire `pool-2/preview/` and `basic-2/native/manifests/` after seven days; publication history and recovery CAS objects are preserved. Restore still verifies every object and uses bounded concurrency in an isolated new directory.

The allowlist includes identity, checkpoint, discovery cursors, benchmark pointers, immutable price/anchor records and publication history. It excludes configuration, credentials, locks and temporary files. Mutable pointers are captured before uploading; SHA-256 identities and Cloud Storage CRC32C acknowledgements are checked, and the manifest is committed last. Configured size limits fail closed; choose limits for the retained history and monitor failures. The minute timer is asynchronous and can lag local state.

With the publisher stopped, an authorized reader can restore a specific successful manifest into a new absolute directory:

```sh
relative-publisher restore --config /etc/cox-publisher/native-backup.json --manifest SHA256 --destination /var/lib/cox-publisher-restored
```

Restore rejects existing destinations, unsafe paths and checksum mismatches. Verify the restored publication chain and runtime identity, then reconcile chain state before switching directories and starting one publisher. Local simulated-storage tests cover integrity and concurrent checkpoint capture. Pool 2 rollout from committed `027fd7420021742cf86b3174caea69177f3ad771` verified a real cloud archive record and an isolated restore of a 69-file native recovery manifest. The Rust runtime and minute backup timer run on the European dev VM; Basic remains registry-paused and Epoch drafts unsealed. See the [deployment record](../../packages/cox/deploy/adaptive-pool-2-devnet.json) for hashes and verification boundaries. Backups still enumerate and hash retained local files; incremental mode removes redundant cloud requests, and retention bounds the retained file count.

## Migration boundary

| Component | Retirement scope |
| --- | --- |
| `apps/cox-publisher` | Rust runtime is live; legacy TypeScript implementation, tests and dependencies removed. |
| `packages/cox-methodology` | Rust methodology retained; legacy TypeScript exports and fixture generator removed after the API migrated to the Rust CLI. |
| `apps/rpc-proxy` | Removed; servers use direct Alchemy and public devnet fallback. |

These are two TypeScript implementation replacements and one proxy retirement. The publisher and methodology package directories remain required for their Rust crates. Signer/signing, APIs, web, contracts and the client SDK remain required. The obsolete exchange archiver, monitor, `price-feeds` and exchange-only `ingestion` have been retired; native Pyth validation and historical evidence access remain.

The deployed billing release retains the original 30-asset roster. The prepared dynamic release adds the bounded 255-asset runtime described above; these are separate deployment states. Missing historical Pyth closing data has no backfill implementation. Archived payloads are reverified against known trusted signer keys; unavailable historical keys fail closed.

`relative-publisher prepare-inclusion --request ABSOLUTE_PATH --output NEW_ABSOLUTE_PATH` validates an immutable admission request without changing chain state. Stable identities, explicit feed/class bindings, exposure uniqueness and permanent origins are validated before operator approval. The approved artifact is loaded from `inclusion-approved.json`; the runtime independently checks the confirmed schedule account and exact boundary capture. A missing qualifying boundary requires explicit rescheduling. Global benchmark continuity does not change any existing Epoch's frozen selection universe.

Dynamic approval and execution journals accept regular non-symlink files up to 16 MiB. The worst-case 255-asset test uses approximately 2.74 MB for a preparation request and 5.90 MB for the persisted execution journal. Set the backup configuration's `max_file_bytes` to at least 16777216 before activating this release; the older 1 MiB setting is insufficient. Immutable universe receipts, staged snapshots and transition journals are included in recovery. Do not advertise expanded live capacity until the contract, signer, publisher, backup and API consumer gates have all passed.


The retired minute publisher implementation and TypeScript backup script were removed after native publication, fee activation and real archive recovery were verified. Shared protocol fixtures remain unchanged. Historical verification results are preserved in Git and the append-only agent log.
