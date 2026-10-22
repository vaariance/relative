# Relative native publisher

The default publisher entry point is now the Rust executable in `native/`. It connects signed one-second Pyth Pro feeds, the geometric benchmark, processed Yellowstone wake notifications, confirmed Solana reads, remote signing and durable recovery. Direct Alchemy RPC is primary; public devnet RPC is the fallback. No RPC proxy is used.

This is an uncommitted replacement implementation, not a deployed service. Legacy devnet pool 1 is retired and is explicitly rejected. Starting the replacement requires separately deployed compatible Basic and Epoch pools and explicit signer bindings for their instructions. Existing live signing permissions are not broadened by this code.

## Build and run

Use Rust 1.90 or later for this standalone native workspace. Keep the Solana program build toolchain separate.

```sh
pnpm --filter @eox/cox-publisher build
pnpm --filter @eox/cox-publisher test
pnpm --filter @eox/cox-publisher start --config /path/to/private/native.json
```

The service template runs the built binary directly; Node is not required by the publisher runtime. The Rust process acquires its own operating-system lock. A disabled configuration exits successfully before reading secrets or contacting the network. The old `config/dev.json` belongs to the legacy TypeScript publisher and is not a native configuration.

Private native configuration uses schema `relative.publisher/v1` and strict JSON fields matching `native/src/runtime.rs::Config`: `enabled`, `network`, `state_directory`, `operator`, `basic_program`, `basic_pool_id`, `first_epoch_opens_at`, `epoch_program`, `epoch_config`, `key_version`, `anchor`, `mapping`, `compute_units`, `priority_fee_lamports`, `heap_bytes`, `batch_limit`, `max_operations`, `max_price_age_ms`, and `max_feed_age_ms`. Network must be `solana-devnet`. State directory must be absolute. Anchor binds the universe digest, origin timestamp in microseconds, benchmark and ordered Pyth Pro assets; mappings bind those assets to both contracts. `first_epoch_opens_at` is a four-hour UTC boundary at or after the benchmark origin, and must match Basic's scheduled trading opening. Do not reuse a state directory with another configuration.

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

The allowlist includes identity, checkpoint, discovery cursors, benchmark pointers, immutable price/anchor records and publication history. It excludes configuration, credentials, locks and temporary files. Mutable pointers are captured before uploading; SHA-256 identities and Cloud Storage CRC32C acknowledgements are checked, and the manifest is committed last. Configured size limits fail closed; choose limits for the retained history and monitor failures. The minute timer is asynchronous and can lag local state.

With the publisher stopped, an authorized reader can restore a specific successful manifest into a new absolute directory:

```sh
relative-publisher restore --config /etc/cox-publisher/native-backup.json --manifest SHA256 --destination /var/lib/cox-publisher-restored
```

Restore rejects existing destinations, unsafe paths and checksum mismatches. Verify the restored publication chain and runtime identity, then reconcile chain state before switching directories and starting one publisher. Local simulated-storage backup/restore tests cover integrity and concurrent checkpoint capture; live Cloud Storage permissions, installed backup service and an operational restore remain unverified.

## Migration boundary

| Component | Retirement scope |
| --- | --- |
| `apps/cox-publisher` | Replace its TypeScript runtime with Rust; retain the application. |
| `packages/cox-methodology` | Port protocol calculations, inclusion and research simulation to Rust. Retain legacy TS fixture support until Joel migrates API consumers. |
| `apps/rpc-proxy` | Retire the protocol's dependency; shared source/deployment removal requires remaining consumers to migrate. |

These are two TypeScript implementation replacements and one proxy dependency retirement. No whole package directory is currently safe to delete. `price-feeds`, `cox-monitor`, signer/signing, APIs, ingestion, web, contracts and the client SDK remain required.

Native inclusion lifecycle and exact-rational Epoch simulation are library implementations with parity tests. Dynamic universe activation and expanded Basic class support are separate integration work; the executable currently binds the sealed Basic roster, at most 30 assets, and Pyth Pro IDs. Paged discovery covers larger participant counts but does not expand the asset roster or transaction capacity. Missing historical Pyth closing data has no backfill implementation. Archived payloads are reverified against known trusted signer keys; unavailable historical keys fail closed.

`relative-publisher prepare-inclusion --request ABSOLUTE_PATH --output NEW_ABSOLUTE_PATH` prepares an immutable inclusion artifact without changing the active universe, publisher configuration or chain state. The strict `relative.inclusion-request/v1` input contains `previous` and `next` universe snapshots and their explicit `previous_bindings`/`next_bindings` (`relative-methodology::transition::Request`). Bindings join stable asset identities to runtime names, Pro feed IDs, Basic class IDs and Epoch feed IDs. Retained bindings must preserve their original price/benchmark references exactly; new bindings must leave those references absent until verified activation-time capture. Input references are operator-supplied facts, not authenticated chain reads. The deterministic artifact digest binds the request and its unresolved blockers: Basic dynamic roster support, Epoch snapshot staging, verified activation prices and runtime transition integration. It is preparation evidence, not an executable activation approval. Native benchmark calculation supports the methodology's full 256-asset capacity; current Basic runtime binding remains limited to 30.

The TypeScript publisher is retained only for behavioural comparison during migration:

```sh
pnpm --filter @eox/cox-publisher test:legacy
pnpm --filter @eox/cox-publisher check:legacy
```

## Legacy minute publisher reference

The following describes the retired TypeScript implementation, not the native startup or publication policy.


The publisher advances the COX Solana program from archived minute prices through publication, evaluation, aggregate safety checks, execution and finalization. It uses a remote KMS signing service and keeps a durable transaction journal for recovery.

This runtime targets Solana devnet and classic SPL test collateral. It consumes the price archive rather than querying exchanges directly. Pool creation, methodology sealing, administration and wallet trades are separate operations.

## Requirements and startup

Use Linux with Node.js 24 or later, `flock`, installed workspace dependencies and synchronized system time. Enabled operation requires a configured archive API, devnet RPC, authorized Google workload identity and funded runtime authority.

From the repository root:

```sh
pnpm --filter @eox/cox-publisher build
pnpm --filter @eox/cox-publisher test
pnpm --filter @eox/cox-publisher start --config /etc/cox-publisher/dev.json
```

The default [`config/dev.json`](config/dev.json) is a disabled template. Disabled startup exits before acquiring a lock or contacting the network. `--once` runs one processing tick for controlled verification.

Templates use the branded signer address. If the deployed signer uses a
different identity-token audience, store that audience in the private runtime
JSON and set `COX_SIGNER_AUDIENCE` to the same value. Set `COX_SIGNER_URL` when
retaining a different trusted signer endpoint. These environment values pin the
accepted configuration and must remain outside Git.

## Configuration

Configuration is strict JSON: every declared field is required and unknown fields are rejected.

| Fields | Purpose |
| --- | --- |
| `enabled` | Enables network activity and processing. |
| `rpcUrl`, `archiveUrl` | Solana RPC and archived-price API endpoints. |
| `signerUrl`, `signerAudience` | Remote signer endpoint and Google identity-token audience. |
| `statePath` | Absolute path to the durable journal. |
| `poolId`, `methodologyDigest`, `origin` | Pool number, sealed methodology digest and minute-aligned Unix-second origin; required when enabled. Integer identities are decimal strings. |
| `assets`, `bybit` | Canonical asset ordering and venue policy matching the sealed methodology. |
| `runtimeAuthority`, `genesisHash`, `signerNetwork`, `keyVersion` | Pinned devnet authority, network and KMS identity. |
| `computeUnitLimit`, `computeUnitPriceMicroLamports` | Transaction compute budget. |
| `pollMs`, `retryMaxMs` | Polling interval and bounded retry delay. |

The program ID is `G6iQGoupNSfduw1QJxQ9vcVi9FnCC6cbippXsi4QQzJF`. The full devnet genesis hash is checked independently of the signer's shortened network identifier. Startup requires the deployment record's executable hash to match [`publisher-build.json`](../../packages/cox/deploy/publisher-build.json), then verifies the actual deployed program bytes, pool, methodology, signer identity and custody state. A mismatched build blocks processing rather than assuming the required storage layout is deployed.

Signer authentication obtains an access token from Google Compute Engine metadata, then calls IAM `generateIdToken` for `cox-publisher@colosseum-eox.iam.gserviceaccount.com`, with the configured audience and `includeEmail: true`. The VM service account needs permission to generate that identity token; the dedicated publisher identity needs signer invocation permission and the configured `oracle-operator` role. No service-account key file is required. Private wallet keys are never configuration inputs. Store authenticated RPC URLs in protected runtime files, outside version control.

## Publication and execution rules

A snapshot must be archived by cutoff +30 seconds and accepted by cutoff +55 seconds. Acceptance fixes the prices and execution values. Accepted requests have no fill deadline: an unfinished batch blocks the next publication until finalization. A restart, pause or missed minute does not reprice accepted work. Request expiry is evaluated against the accepted batch.

An uninitialized pool needs batch 0 during its origin window. Missing that window requires a new methodology and pool. An initialized pool skips missed minutes instead of replaying late snapshots. The archive snapshot must match the sealed asset roster exactly; the publisher cannot filter or reorder it locally.

Compute budgets are limited to 1,400,000 units and 1,000 micro-lamports per unit. Network confirmation and batch completion time depend on actual chain conditions and request volume; the one-minute publication interval is not a fill guarantee.

## Recovery and operations

The journal records exact unsigned and signed bytes. Recovery reconciles finalized chain state before rebuilding transactions. Preserve the journal and its directory across restarts and deployments. Deleting the journal to clear a retry can destroy the information needed to avoid duplicate submissions.

The program reuses one batch and one publication account per pool. Before processing can overwrite the latest publication, the publisher preserves its finalized 8 KB account bytes in `${statePath}.history/<sequence>.json`. Each record binds the program, pool, network, sequence, batch, account hash, state digest and finalized slot. The history writer checks the previous state-digest link and rejects gaps or conflicting records. Preserve this directory together with the journal; the on-chain latest account cannot reconstruct overwritten history.

The [backup service](../../deploy/dev/cox-publisher-backup.service) and [timer](../../deploy/dev/cox-publisher-backup.timer) upload publication history and journal versions to a private Cloud Storage bucket every minute. Uploads use content-addressed object names, create-only writes and checksum verification. This asynchronous backup can lag local state; it is not a substitute for the local archive-before-overwrite check. Restore using an authorized reader identity, verify the history chain and journal identity, and reconcile finalized state before resuming. Never run two publishers during recovery.

Enabled CLI invocation automatically acquires `${statePath}.flock`. Only one publisher may operate a pool. `--locked` is an internal flag for a process already protected by the outer lock. Do not invoke it directly or remove a lock path while a publisher runs. A leftover lock file is harmless after the process exits.

[`deploy/dev/cox-publisher.service`](../../deploy/dev/cox-publisher.service) provides a systemd template with a dedicated user, restricted writable directories and automatic restart. Installed release paths may differ from the template. Use the [deployment guide](../../deploy/dev/README.md) for installation, journal backup and recovery procedures.

```sh
sudo systemctl status cox-publisher
sudo journalctl -u cox-publisher -f
```

Logs report processing outcomes, timings and failures. The service has no public HTTP API. See [verification notes](VERIFICATION.md) for test scope and the [COX specification](../../packages/cox/SPEC.md) for protocol rules.
