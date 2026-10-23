# COX application API

HTTP service for COX deployment information, publications, portfolios and wallet-signed transactions. It serves the `cox.app-api/v1` contract from either a deterministic fixture or a Solana devnet pool. It holds no wallet private key and does not calculate market references.

## Run locally

Install workspace dependencies from the repository root, then start the fixture:

```sh
pnpm --filter @eox/app-api-server start
```

The default address is `http://127.0.0.1:8790`. For a devnet source:

```sh
APP_API_SOURCE=cox-live \
COX_RPC_URLS=https://api.devnet.solana.com \
APP_API_STATE_DIR=./state \
APP_API_PORT=8791 \
pnpm --filter @eox/app-api-server start
```

The public demonstration endpoint is <https://fixture-api.getrelative.trade>. It serves synthetic fixture data, not market data. The public live endpoint is <https://api.getrelative.trade>: Solana devnet pool 0 with test collateral only, one always-on Cloud Run instance, history rebuilt from the publisher's archive bucket on start, and transaction requests limited per client. Check `deployment.origin` on every integration rather than inferring the source from an endpoint's name.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `APP_API_SOURCE` | `cox-fixture` or `cox-live` | `cox-fixture` |
| `APP_API_HOST`, `APP_API_PORT` | Listening interface and port | `127.0.0.1`, `8790` |
| `APP_API_CORS_ORIGIN` | Browser origin, or `*`; unset disables CORS headers | Unset |
| `COX_RPC_URLS` | Ordered, whitespace-separated HTTPS RPC URLs | Required for live mode |
| `APP_API_STATE_DIR` | Persistent publication and submission storage | Required for live mode |
| `COX_NETWORK` | Supported network | `solana-devnet` |
| `COX_POOL_ID` | Pool identifier | `0` |
| `COX_IDL_PATH` | Program IDL | `packages/cox/idl/cox.json` |
| `COX_EPOCH_CONFIG` | Epoch configuration account; unset disables the Epoch routes | Unset |
| `COX_EPOCH_IDL_PATH` | Epoch program IDL | `packages/cox-epoch/idl/epoch.json` |
| `COX_POLL_MS` | Indexer interval, at least 1,000 ms; used only without `COX_CHAIN_CHANGES_GCS` | `5000` |
| `COX_CHAIN_CHANGES_GCS` | `gs://bucket/prefix/` of the publisher's chain change notifications; with it the API reads the chain only after a change | Unset |
| `COX_PUBLICATION_ARCHIVE` | Directory of the publisher's `<sequence>.json` archive records | Unset |
| `COX_PUBLICATION_ARCHIVE_GCS` | `gs://bucket/prefix/` of content-addressed `<sequence>/<sha256>.json` records; use instead of the directory | Unset |
| `COX_PREVIEW_GCS` | `gs://bucket/prefix/` of the publisher's per-second `<unix seconds>.json` preview records; unset disables the preview routes | Unset |
| `APP_API_POST_LIMIT_PER_MINUTE` | Transaction requests per client per minute; 429 `RATE_LIMITED` with `Retry-After` beyond it | `30` |
| `APP_API_TRUST_FORWARDED_FOR` | `true` behind Cloud Run: the client is the last `X-Forwarded-For` entry | Unset |
| `APP_API_HISTORY_GCS` | `gs://bucket/prefix/` for sealed history segments shared by every instance | `<state dir>/history-<pool>/` |
| `APP_API_SUBMISSIONS_FIRESTORE_PROJECT` | Google Cloud project whose Firestore holds submission tracking, shared by every instance | Unset: `<state dir>/submissions-<pool>.json` |
| `APP_API_SUBMISSIONS_FIRESTORE_DATABASE` | Firestore database for submissions; use one of its own so the service account cannot reach other data | `(default)` |

Every RPC endpoint must pass the devnet genesis check at startup. Network failures, 15-second timeouts, HTTP 429 and HTTP 5xx trigger failover. Store authenticated URLs privately. A missing pool or unsealed methodology delays startup and is checked again every 30 seconds.

## HTTP contract

Successful JSON responses contain `{ schemaVersion, deployment, status, data }`. Errors contain `{ schemaVersion, error: { code, message } }`. `/health` returns `{ "status": "ok" }`; this is process health, not a publication-readiness verdict.

All fixed-point quantities are decimal integer strings. Prices use USD × 10⁸; benchmark levels and references use 10¹²; a reference of 100 is `"100000000000000"`. Position units contain 10¹² quanta per unit. Collateral amounts use the mint's base units. Use `BigInt` for arithmetic.

| Route | Result |
|---|---|
| `GET /v1/deployment` | Network, program, pool, test collateral and methodology identity |
| `GET /v1/status` | Publication age, missed cutoffs, execution state, vault reconciliation and fee terms |
| `GET /v1/assets`, `GET /v1/assets/:id` | Asset roster, venue symbols and latest published prices |
| `GET /v1/crypto` | Benchmark composition and exact weights |
| `GET /v1/publications/latest` | Latest indexed publication |
| `GET /v1/publications/:sequence` | Publication by sequence |
| `GET /v1/publications?after=&limit=` | Publications strictly after the cursor; default limit 100, maximum 500 |
| `GET /v1/publications/stream` | Server-sent events; resume with `Last-Event-ID` |
| `GET /v1/stream?wallet=` | Real-time server-sent events: publications, status changes and, with `wallet`, that wallet's portfolio |
| `GET /v1/wallets/:owner/portfolio` | Committed positions, locked units, payables, refunds and requests |
| `POST /v1/quotes/deposit` | Estimate with `{ owner, toClass, amount }` |
| `POST /v1/quotes/switch` | Estimate with `{ owner, fromClass, toClass, units }` |
| `POST /v1/quotes/redeem` | Estimate with `{ owner, fromClass, units }` |
| `POST /v1/transactions/deposit` | Build with `{ owner, toClass, amount, minimumUnits, expiryBatch, expectedFeeVersion }` |
| `POST /v1/transactions/switch` | Build with `{ owner, fromClass, toClass, units, minimumUnits, expiryBatch, expectedFeeVersion }` |
| `POST /v1/transactions/redeem` | Build with `{ owner, fromClass, units, minimumProceeds, expiryBatch, expectedFeeVersion }` |
| `POST /v1/transactions/cancel`, `POST /v1/transactions/refund` | Build with `{ owner, requestId }` |
| `POST /v1/transactions/withdraw` | Build with `{ owner, amount }` |
| `POST /v1/transactions/submit` | Relay `{ transaction }`, containing signed base64 transaction bytes |
| `GET /v1/transactions/:signature` | Track a transaction submitted through this API |
| `GET /v1/epochs` | Epoch configuration, the two most recent finished Epochs and up to six current or future ones |
| `GET /v1/epochs/:opensAt` | One Epoch by its opening time: phase, universe, lot counts, ledger and vault coverage |
| `GET /v1/epochs/:opensAt/lots?owner=` | A wallet's lots in that Epoch: stake, fee, basket, backed asset, execution, score and claimable amount |
| `POST /v1/transactions/epoch-entry` | Build with `{ owner, opensAt, grossStake, basket, backedAsset, collateralMint? }`; `basket` lists all 30 universe tickers once |
| `POST /v1/transactions/epoch-withdraw` | Build with `{ owner, opensAt, nonce, amount?, collateralMint? }`; omit `amount` to withdraw the whole claim |

Omitting the publication cursor starts from sequence 0. An empty page preserves the cursor. SSE events contain the publication and its sequence; the server sends a heartbeat every 15 seconds. Transaction request bodies are limited to 8 KiB.

Errors include `NO_PUBLICATION`, `PUBLICATION_NOT_FOUND`, `UNKNOWN_ASSET`, `UNKNOWN_CLASS`, `UNKNOWN_WALLET`, `INVALID_REQUEST`, `NOT_FOUND`, `METHOD_NOT_ALLOWED`, `INTERNAL_ERROR`, `NOT_LIVE`, `TRANSACTION_REJECTED`, `TRANSACTION_NOT_FOUND`, `RATE_LIMITED`, `FEE_CHANGED`, `TRADING_CLOSED`, `UNKNOWN_EPOCH` and `NOT_CONFIGURED`. A trade, quote or Epoch entry while trading is closed returns HTTP 409 `TRADING_CLOSED` with the reason. Builders and quotes on the fixture return HTTP 409 `NOT_LIVE`; a rejected simulation returns HTTP 422 `TRANSACTION_REJECTED`; a fee version that no longer matches the pool returns HTTP 409 `FEE_CHANGED`.

## Real-time stream

`GET /v1/stream` keeps one connection open and pushes these event types:

| Event | Sent | Data |
|---|---|---|
| `publication` | each new publication, after any missed since the cursor | `{ sequence, publication }`; the event id is the sequence |
| `status` | on connect, then whenever anything except the clock changes: new publication, missed cutoffs, paused or halted, execution, reconciliation or fee terms | the same object as `status` in every response |
| `portfolio` | with `?wallet=`, on connect and whenever that wallet's positions, requests or receipts change | `{ owner, portfolio }`; `portfolio` is `null` for a wallet with nothing on chain |
| `preview` | with `COX_PREVIEW_GCS`, on connect, for each newer per-second record and when the latest becomes stale | `{ record, ageSeconds, stale }`, as `GET /v1/preview` |

Without a cursor the stream starts at the latest publication. Browsers reconnect by themselves, three seconds after a drop, sending the last publication id. The server then resumes publications from there, at most the last 1,440, and repeats the current status and portfolio. Fetch older history with `GET /v1/publications`. Status is checked every 5 seconds from memory and right after each publication. A wallet's portfolio is read once per wallet, however many connections watch it: with `COX_CHAIN_CHANGES_GCS`, only after the chain changed; without it, after each publication and every 15 seconds. Each client may hold 8 streams, an instance 500 and 200 distinct wallets. Over those limits the response is HTTP 429 `RATE_LIMITED` with `Retry-After`.

```ts
const stream = new EventSource(`${baseUrl}/v1/stream?wallet=${owner}`);
stream.addEventListener("publication", (e) => onPublication(JSON.parse(e.data)));
stream.addEventListener("status", (e) => onStatus(JSON.parse(e.data)));
stream.addEventListener("portfolio", (e) => onPortfolio(JSON.parse(e.data)));
```

Server-side code can use `createCoxApiClient(...).subscribe({ after, wallet }, onEvent)`, which delivers typed `CoxStreamEvent`s and does not reconnect. `GET /v1/publications/stream` remains for publication-only consumers and replays at most the last 1,440 publications.

## Wallet transaction flow

1. Request an unsigned transaction from a live source.
2. Inspect the decoded instructions, network, mint, amounts and expiry. The wallet must be the sole signer and fee payer.
3. Sign with the user's wallet, then submit the exact signed bytes.
4. Track the signature and the request receipt separately. Transaction confirmation acknowledges submission; a later committed publication determines the fill.

Builders simulate before returning a version 0 transaction. The program assigns eligibility from its clock when submission lands; the returned target batch is an estimate. The request nonce is pool-global, so simultaneous builds can conflict and a failed nonce must be rebuilt. After an ambiguous submission result, check the original signature and request before creating another deposit.

Submission verifies signatures, restricts instructions to the supported COX request operations, the Epoch entry and withdrawal instructions when `COX_EPOCH_CONFIG` is set, plus associated-token and compute-budget programs, and relays the signed bytes unchanged. Redemption creates a payable; withdrawal is a separate wallet action. The devnet collateral is a test token, not real USDC.

## Trading fees

Pools migrated to `COX/FEES/V1` charge `min(floor(gross × bps / 10000), cap)` in collateral base units on each successful deposit, switch or redemption. Withdrawals, refunds, cancellations and failed or expired requests pay nothing. The API reports values read from the program; it never calculates a fee itself.

- `status.fees` gives the policy, whether the pool is migrated, the active terms `{ version, bps, cap }`, any scheduled terms with their `activationCutoff`, and committed fees. A scheduled change takes effect only when a publication at or after that cutoff finalizes.
- A quote simulates the program's own fee quote at finalized commitment and returns `gross`, `fee`, `net`, the estimated `mintedUnits` or `proceeds`, `feeTerms` and `observedSequence`. Nothing is signed or charged, but the simulation needs the wallet to exist on chain. A quote is an estimate; the accepted publication fixes the result.
- On a migrated pool, builders require `expectedFeeVersion`, which is the quote's `feeTerms.version`. They build `deposit_with_fee`, `switch_with_fee` or `redeem_with_fee`, carrying that version, and return the locked `feeTerms`. Minimum units and minimum proceeds apply after the fee.
- If the version changed, the builder returns `FEE_CHANGED`, and so does submission, which compares the signed version with the pool before relaying. The program also refuses a mismatch before reserving anything. Ask for a fresh quote and rebuild.
- Each request reports the `feeTerms` locked when it was submitted. Requests submitted before migration show version 0 and stay fee-free. A committed receipt reports `gross` and the `fee` charged; `gross` is `null` for requests submitted before migration.
- Publications whose state is `COX/STATE/V2` report `ledger.fees` (committed fees), `flows.fees` (fees from that batch) and `fees` (terms after the publication). Earlier publications report `"0"` and `fees: null`.

`fixtures/cox-fee-examples.json` holds example responses for a migrated pool, produced by this code over the compiled fee-upgrade accounts in `packages/cox/fixtures/fee-accounts.json`. A test fails if the code's output drifts from it; regenerate with `pnpm exec vitest run -u`.

## Adaptive pools and Epoch

`deployment.mode` is `minute` for the original pools and `adaptive` for schema-4 pools such as Basic pool 2. Adaptive pools publish Pyth prices (`venue: "pyth"`, `step: 0`, no exchange symbols) on a one-second grid from an origin on any whole second, and stay silent while idle. Their batches are seconds since origin, so `expiryBatch` is counted in seconds; builders accept at most a week ahead. `missedCutoffs` stays 0 and `missedBatches` stays empty for them because silence is normal. `deployment.publicationIntervalSeconds` and `status.currentBatch` give the clock to use.

`status.trading` says whether new requests are accepted: `{ open, gate, opensAt }`, where `gate` is `retired`, `paused` (registry paused), `not-initialized` (no first publication yet), `before-opening` (before `tradingOpensAt`) or `open`. Builders and quotes check the pool before simulating and return `TRADING_CLOSED` with the reason; the program enforces the same rules.

A pool with a second collateral mint reports it as `deployment.secondaryCollateralMint`. Deposits, refunds and withdrawals take an optional `collateralMint` choosing either mint (default: the primary one); every request includes both vaults, and vault reconciliation adds both balances. Withdrawals and refunds need liquidity in the chosen mint's vault. `status.fees.migrated` is true for adaptive pools, and a fee schedule shows as `scheduled` until a qualifying publication activates it.

The publisher's `cox.publication-archive/v2` records carry `commitment: "confirmed"` and an `observedSlot`. Publications filled from them report `finalization.finalized: false`; v1 records and publications read from chain at finalized commitment report `true`. A record that mixes the two forms is refused.

### Live previews

The publisher evaluates the methodology every second but writes to the chain only when there is work to settle. With `COX_PREVIEW_GCS`, the API follows its per-second `relative.preview/v1` records so the app can show live figures between publications. Each tick it lists the bucket from the next second and reads the newest record, so missing seconds stay gaps and are never filled. A record is relayed unchanged only after its timestamp, network, program, pool, methodology digest, scales, asset order, CRYPTO class and reference, and projection rows are checked. A record that fails is logged and skipped, and the previous one stays current.

| Route | Data |
|---|---|
| `GET /v1/preview` | `{ record, ageSeconds, stale }`; `stale` after 10 seconds without a newer record. 404 `NO_PREVIEW` before the first record, 409 `NOT_CONFIGURED` without `COX_PREVIEW_GCS` |
| `GET /v1/preview/history?from=&to=&step=` | Points from the per-second previews; see below |
| `GET /v1/preview/portfolio?owner=` | Each position's `estimatedValue` in collateral base units: its units times the projected class backing divided by the projected class units, rounded down |

`GET /v1/preview/history` returns `{ assets, step, from, to, points }`, where each point is `{ end, timestamp, benchmark, prices, references }` with values in roster order at the record's scales. A point is the last record at or before the end of its step, and a step without a record is left out, never filled. `step` is 1, 60, 300 or 3600 seconds, with at most 1,440 steps per response; one-second steps cover the last hour and longer steps the last seven days.

- **Where the history comes from:** each process keeps its own history in memory, every second for an hour and the last record of each minute for seven days, from the records it already reads.
- **After a restart:** it fills the past seven days from the bucket once, in the background.
- **Caching:** a range that ended more than five seconds ago, once that fill is done, is sent with `Cache-Control: public, max-age=86400, immutable` and without the live `status` block. Other ranges are `no-store`.
- **Solana:** history makes no Solana calls.

Every preview is an estimate. The API computes no reference or redistribution: benchmark, references and `basicProjection` come from the publisher. A wallet estimate is given only when `basicProjection` starts from the pool's latest publication; otherwise `unavailable` is `no-projection` or `basis-mismatch` and every value is `null`. A later publication does not confirm a preview; read the publication itself for committed values.

With `COX_EPOCH_CONFIG`, the API reads the Epoch configuration, its Epoch accounts and lots. An Epoch is a `draft` until the admin seals it, then `open`, `scoring`, `allocating`, `settled` or `voided`. `entriesOpen` is true only for an open Epoch between `opensAt` and `closesAt` with lot capacity left. Its ledger lists pending gross stakes, active net stakes, held fees, claimable amounts, committed fees and residual, compared with both vault balances. Entry fees are 2 bps capped at 200,000 base units and are charged by the program. An entry uses the Epoch's next lot nonce, so simultaneous entries can conflict and must be rebuilt.

## Live state and history

The source reads finalized program accounts through [the COX client](../../packages/cox-client/README.md). Staged position and request changes remain hidden until commitment. Vault reconciliation compares token balance with active + pending + payable + residual + committed fees; a surplus remains covered until a financial instruction records it as residual. Fees staged by an unfinished batch are not counted.

Indexed publications are sealed in blocks of 360 into immutable history segments, named `seg-<first>-<last>-<predecessor batch>-<last batch>.json`. Each segment is created only if absent, so instances that index the same block agree on one copy. At start an instance lists the segments, checks from their names that they form one chain, and loads only the latest block. It reads older blocks when asked for them, checking each against its name and the batch chain, and keeps the 8 most recently used. Memory therefore stays flat as history grows. Publications not yet sealed are kept in `publications-<pool>.jsonl` and, on an empty disk, are filled from the publisher archive 16 at a time. A full log written by an earlier release is moved into segments on first start.

Submission tracking is in Firestore when `APP_API_SUBMISSIONS_FIRESTORE_PROJECT` is set: one document per signature in `coxSubmissionsPool<pool>`, with an `expireAt` field 30 days after submission for a TTL policy. Otherwise it is kept in `submissions-<pool>.json`. With segments in Cloud Storage and submissions in Firestore, any instance answers any request, so the service can run several instances.

The program keeps only the latest publication on chain. Earlier sequences come from the publisher's archive (`COX_PUBLICATION_ARCHIVE` or `COX_PUBLICATION_ARCHIVE_GCS`). Each record is checked against its content hash, account hash, decoded state and predecessor chain before it is logged, for both legacy and fee-aware publications. Without an archive, the indexer refuses to skip a gap.

### Reading the chain only after a change

With `COX_CHAIN_CHANGES_GCS`, the API makes no Solana calls while nothing happens on chain. The publisher writes a `relative.chain-notification/v1` file to that prefix whenever relevant confirmed activity changes its revision, and a heartbeat every 20 seconds. Each API process lists the prefix from the last file it read, about once a second; this is Cloud Storage, not Solana.

- A higher revision triggers one shared re-read of the pool, registry, vaults, publication and batch. A skipped revision, a new generation, the first start and a return to health do the same. Overlapping triggers share one read.
- The API reads at finalized commitment while notifications are confirmed. After a change it reads again after 4, 8, 16 and 32 seconds until the finalized slot reaches the notified slot.
- After each re-read, cached wallet portfolios, Epoch accounts and Epoch lots are dropped, and streams refresh their watched wallets once.
- Status, publications and streams are served from memory. Building, quoting and submitting transactions still read the chain fresh.
- One safety re-read runs every 20 minutes per process.
- `status.chain` reports `readAt`, the finalized `slot` of the last read and `feed`: `healthy`, `unhealthy` (no heartbeat for 60 seconds, the publisher reports an unhealthy stream, or the prefix cannot be listed) or `polling` without the feed. An unhealthy feed never starts fast chain polling.

Live `gross`, `benchmarkGross` and `transferFactor` fields are `null` because they are not stored on chain. `ledger.refundable` is also `null`: the pool combines refundable deposits with pending funds, while individual portfolios expose the split. `status.monitor` is `null`; an archive consistency check is not a publication verification.

## Fixture and verification

The fixture uses two synthetic assets, `SYNA` and `SYNB`, plus CRYPTO. Its connected timeline covers deposits, revaluation, switching, redemption, conditions, missed batches, expiry and a queued request. Its timestamps advance to the current minute; the amounts remain synthetic.

Example portfolio owner: `HgC4Jn7XMLzNsDjVdsr1x7BDuGBb2SBvx5TFLSUYaEyU`.

```sh
pnpm --filter @eox/app-api-server build
pnpm --filter @eox/app-api-server test
```

The fixture's arithmetic comes from the Rust `cox` CLI in `packages/cox/crates/cli` (`reference`, `revalue`, `batch`), so building the fixture and running its provenance test need either `cargo` on the path or `COX_CLI` set to a built `cox` binary. To regenerate fixture output after a change to that CLI, run `npx tsx scripts/cox-fixture.ts` from this directory. See the [typed API client](../../packages/app-api/README.md) and [deployment guide](../../deploy/dev/README.md).
