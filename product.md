# COX product direction and work plan

Version 15 · 15 October 2026 · Direct performance-position and full-output entry

Version 15 records Peter's approved SDK entry flow: collateral can enter a selected
asset performance class directly, with one successful deposit fee. For supported
input tokens, one user transaction swaps through a DEX into collateral and queues
the full actual output for that class; the position fills at the next applicable
valid publication. Pre-existing wallet collateral is preserved. This uses a
separate routing component and retains the current pool accounting. It does not
mean minting CRYPTO and then switching, or charging two pool fees. Route/network
compatibility, compiled verification, router deployment and API/UI integration
remain delivery requirements. No production or deployment is claimed here.

Version 14 records Peter's app flow: the swap SDK handles collateral → CRYPTO
benchmark units and CRYPTO benchmark units → collateral. Moving between CRYPTO
and individual asset positions happens afterward inside the trading app using
the existing switch instruction. Swaps retain future-publication execution and
separate withdrawal of finalized proceeds. The current collateral is the devnet
test mint; this does not enable genuine USDC or change the deployed program.

Version 13 records Peter's approved storage decision: retain one latest
publication and one reusable execution batch per pool on chain. Preserve full
publication history in a verified durable archive before the next publication.
This changes storage, not trading calculations or next-publication eligibility.
The rolling-storage upgrade and its integrations require verification before
activation; this brief does not claim deployment or change SYSTEM.md sign-off.

Version 12 records Peter's rule: trades become eligible from the next valid
publication and never execute when created. Fill time is not guaranteed;
processing the eligible workload within a minute is an operating capacity
target, not a cancellation deadline. SYSTEM.md v2.4 records this change.

Version 11 adds Coinbase and Bybit as fallbacks when Kraken's cutoff minute is
empty, and gives Joel a separate rate-limited `packages/price-feeds` package
(task J0), following `SYSTEM.md` version 2.3. Version 10 replaced Pyth with Kraken's public one-minute candles and replaces 13
older assets with newer tokens, following `SYSTEM.md` version 2.2. Version 9
recorded the pivot from EOX to COX.

This brief replaces the EOX product direction (version 8, in git history). It
records the decision to stop building EOX and build COX, the Crypto Outlook
Index, described in `docs/cox/cox-paper-3.md` (COX Paper 3). It assigns every
existing piece of work to one developer as **preserve**, **carry over** or
**delete**, and lists the new work needed to reach the COX MVP.

`SYSTEM.md` version 2.4 is the engineering contract for COX. Where this brief and
`SYSTEM.md` disagree, `SYSTEM.md` wins after sign-off; until then, raise the
conflict rather than choosing. These are requirements, not claims of deployed
behaviour.

## 1. Why the pivot

EOX hit walls that COX removes by design (COX Paper 3 §16):

| EOX wall | COX answer |
|---|---|
| Economic statistics have no machine-readable release times; all 180 slots were blocked or needed a first-observed policy | Every price is an exchange one-minute candle fixed by the cutoff and a fixed venue order (Kraken, then Coinbase, then Bybit), re-fetchable by anyone |
| Methodology needed calibrated anchors, weights and eight-factor confidence ratings that do not exist | Price return needs no normalisation; quality only admits or rejects |
| Every evidence record needed a bonded UMA assertion, relayed over Wormhole, with one-hour windows | No challenge path and no third-party oracle; our publisher key attests the snapshot, deterministic on-chain checks, and an independent monitor that re-fetches the venues |
| Two chains, two adapters, a relay, a receiver and six signing roles before one reference could publish | One Solana program, one runtime signing role |
| Quarterly data cannot support continuous trading signals | One-minute publications |
| The exchange payoff and reserve equations were never written | The closed pool and unit accounting are the core of the design, specified first |

What COX keeps from EOX: a shared benchmark, reproducible references,
immutable evidence, separation of evidence, reference and claims, and the
closed-collateral ambition.

## 2. What COX is

A user believes an asset will outperform the crypto market from now on. They
allocate test collateral to that asset's claim class. Every minute, COX takes
exchange prices (Kraken first, Coinbase and Bybit only when Kraken had no trade), computes CRYPTO (the shared benchmark) and each asset's COX
reference, revalues the existing claims inside a closed pool, then executes the
requests queued for that minute at the new values. Winners are paid only by
other claims; nothing is created.

Three things stay visible and separate (Paper 3 §13):

- **Underlying price** of the asset.
- **COX reference**: price performance against CRYPTO, starting at 100.
- **Claim value**: what the user's units can redeem for in collateral.

A rising reference is not a promise of the same percentage gain on a position.

## 3. MVP definition

The MVP is complete when a user on Solana devnet can, through the web app and
their own wallet: deposit test collateral into any of the 30 pilot asset
classes (BTC, ETH, SOL, XRP and the others in `SYSTEM.md` §4.1) or the CRYPTO
class; see the request queued for a named batch; see it
execute at the next valid publication; switch classes; redeem; withdraw; and
see every step reconciled by the independent monitor and traceable to archived
price evidence.

| In the MVP | Not in the MVP |
|---|---|
| Solana devnet, test SPL collateral token | Real USDC or any real-value collateral |
| Kraken USD prices with Coinbase and Bybit fallback for 30 non-stablecoin assets, weighted to newer tokens (`SYSTEM.md` §4.1), attested by our publisher key | Stablecoins and pegged tokens, wrapped or liquid-staking duplicates, the 13 removed older tokens, any asset failing the feed check, independently authenticated prices |
| Equal-weight pilot CRYPTO, one-minute publications | Production weight schedule |
| Transfer rule `COX/TRANSFER/MVP-0`, zero fees | A final transfer rule, fees, reserves |
| Deposit, switch, redeem, withdraw, cancel before cutoff | Secondary market, expectation price, leverage |
| Independent monitor, evidence archive, incidents | UMA, EVM, Wormhole relay of our own, annual settlement |

Every rule behind these choices is in `SYSTEM.md` §3–9. MVP-0 is labelled as a
test mechanism in the app, the API and every document (`SYSTEM.md` §7.2).

## 4. How one minute works

```text
:00   batch k closes (requests after this go to k+1)
:00–:30  Joel's archiver closes each asset's cutoff candle from the Kraken
      WebSocket; for assets with no Kraken trade it asks Coinbase, then Bybit,
      through the rate-limited price-feeds package; stores raw bytes, checks
      admissibility, records incidents
after :00, by :55  Peter's publisher submits that snapshot, signed by oracle-operator;
      the cox program checks it → computes CRYPTO and references → revalues
      classes → fixes batch k unit values
then  process batch k requests at those fixed values → commit completed accounting
      (no hard fill deadline; next publication waits for this execution to finish)
after  Godwin's monitor re-fetches the venues and recomputes publication k;
      Joel's app API indexes it; the web app shows fills and new values
```

If no admissible snapshot is accepted by :55, batch k is missed and its requests
roll forward until expiry. Once a snapshot is accepted, its trades continue at
those fixed values even if execution takes longer than a minute. They are not
cancelled or repriced because processing is slow. Expiry is evaluated against
the accepted batch, not the eventual fill time. New requests wait for a later
publication and cannot execute when submitted.

Joel and Peter must provision and load-test the servers, workers and chain
submission path to process the supported workload within a minute, and monitor
queue age and throughput. This is an operating target, not a promised fill time;
server capacity alone cannot guarantee network or chain confirmation timing.

## 5. Ownership

| Person | Owns in COX |
|---|---|
| **Joel** | Price evidence (`price-feeds` venue package, archiver, store, evidence API), dev operations, signing service, app API and typed client, unsigned transaction builders, indexer |
| **Peter** | Methodology manifest, mechanism specification, COX math crate, `cox` Solana program, publisher service, end-to-end verification |
| **Godwin** | Removal of the EVM/UMA stack, independent monitor, web app |

Each task below has exactly one owner. No task is assigned to a pair.

## 6. Preserve, carry over, delete

Definitions used in this section:

- **Preserve** — keep running and unchanged. Do not refactor it for COX.
- **Carry over** — reuse the code or pattern in a COX component, changing what
  the right-hand column says.
- **Delete** — remove from `main` and stop any running service. Before any
  deletion, Peter tags the current `main` as `eox-archive` and pushes the tag
  (step 0), so nothing is lost. Deletions are separate commits
  (`chore(cox): remove ...`).

### 6.1 Joel

| Existing work | Action | What to do |
|---|---|---|
| Dev VM `eox-dev`, Postgres, private RPC, firewall | **Preserve** | Unchanged host for every COX service. |
| Daily backups to `gs://colosseum-eox-db-backups`, `eox-dev-vm` service account | **Preserve** | Unchanged; the backup now also covers COX tables. |
| `packages/evidence-store`: `source_payloads`, SHA-256 check, append-only triggers, `recorded_at`, xid change feed (`007`), migration runner | **Carry over** | Keep the machinery. Add migrations for `assets`, `candle_responses`, `price_observations`, `snapshots`, `incidents` (`SYSTEM.md` §5.1). Add store functions for them and a change feed over `price_observations`. |
| `packages/evidence-store`: `observations`, `indicators`, `source_releases`, revision links (`001`–`006`, `008`, `009`) and their TS functions | **Delete** (code) / **Preserve** (data) | Applied migrations and their rows stay in the database as a read-only EOX archive. Remove the TS write and query paths for them (`recordObservation`, `recordCorrection`, `getAsOf`, release functions) once nothing imports them. |
| `packages/ingestion`: `sources/payload.ts`, `record-payloads.ts`, `decimal.ts` | **Carry over** | Fetch-with-raw-bytes and exact decimals move into the new `packages/price-feeds` (J0); `record-payloads.ts` stays in ingestion for the archiver (J1). |
| `packages/ingestion`: OECD, BIS, PortWatch, SDMX sources, all six `indicators/` and `ingest/` modules, `pilot-countries.ts`, `ingest-oecd-snapshot.ts`, `record-revisions.ts`, `port-publication.ts` | **Delete** | Economic indicators are not part of COX. |
| `postman/eox-source-apis.postman_collection.json` | **Delete** | Replace with a venue collection: Kraken `AssetPairs` and `OHLC`, Coinbase `products` and `candles`, Bybit `instruments-info` and `kline`. |
| `deploy/dev/run-ingests.sh` and its hourly cron line in `setup.sh` | **Delete** | Stop the hourly EOX ingests first, then remove them. |
| `apps/evidence-api`: server, auth-free read-only design, `/v1/artifacts/:sha256`, cursor handling | **Carry over** | Keep the artifact route unchanged. Replace `facts.ts` with price routes (§7.1, task J2). |
| `apps/evidence-api`: `/v1/changes`, `/v1/records/:id`, `/v1/records/:id/constituents`, EOX fact shape, publication policy | **Delete** | Remove after the COX routes ship; nothing in COX consumes them. |
| `apps/signer`: Cloud Run service, KMS adapters, caller auth, decode-and-allowlist policy, Firestore idempotency, key directory | **Preserve** | Unchanged service. |
| `apps/signer` roles and config | **Carry over** | Keep `oracle-operator` (Ed25519, existing KMS key) as the single COX runtime role. Bind it to the `cox` program's runtime instructions (`publish`, `execute`) and compute budget only. Add Peter's publisher service account as the only caller. |
| `apps/signer` EVM path (`evm.ts`, EVM policy, `signEvmTransaction`) and roles `uma-asserter`, `uma-challenger`, `oracle-checker`, `evm-relayer`, `solana-relayer` | **Delete** | Disable (do not destroy) those KMS key versions; mark them `retired` in `deploy/signing/dev-keys.json` so old public keys stay verifiable. Remove the EVM code and the roles from `packages/signing`. |
| `packages/app-api` and `apps/app-api`: response envelope, typed client, fixture/live origin split, SSE stream with `Last-Event-ID` resume, state file, explicit error codes, separate status envelope | **Carry over** | New schema `cox.app-api/v1` (§7.1, task J3). |
| `packages/app-api` / `apps/app-api`: country, WORLD, pair, proposal, assertion and readiness types and routes; `fixture-source.ts`; `readiness.ts`; `live-source.ts`; `indexer.ts` EOX event decoding; `fixture-generator` (Rust on `eox-oracle-math`) | **Delete** | Replaced by COX equivalents. Keep the indexer's finalized-walk and durable-progress logic when rewriting it. |
| `deploy/dev` services `eox-app-api`, `eox-app-api-live` | **Carry over** | Same units serving the COX schema; rename to `cox-app-api(-live)` when replaced. |
| `deploy/dev` `eox-evidence-api.service` | **Preserve** | Same unit, new routes. |

### 6.2 Peter

| Existing work | Action | What to do |
|---|---|---|
| `packages/oracle/crates/math`: `SCALE`, `MathError`, `rounded_div`, `multiply`, checked bounds, domain-separated `digest`, `artifact_digest` | **Carry over** | Into `packages/cox/crates/math`, with the scales in `SYSTEM.md` §5.3. |
| `packages/oracle/crates/math`: `Rule`, `Slot`, `transform`, `normalize`, `confidence`, `calculate_indicator`, `country`, `world`, `reference`, `preview`, `parse_decimal`, `Evidence`/`Metadata` digests; `protocol.rs`, `relay.rs`, `streaming.rs` | **Delete** | Economic normalisation, confidence and UMA/Wormhole claim encoding have no COX use. |
| `packages/oracle/crates/cli`: preview binary and vector-test pattern | **Carry over** | `packages/cox/crates/cli` computes publications from a JSON input and checks the published vectors. |
| `packages/oracle/programs/eox-oracle`: registry, pause, admin-versus-runtime authority split, sequence plus predecessor, atomic latest pointer, published event, read-only simulated reader (`read_pair` pattern) | **Carry over** | Patterns for `programs/cox`. |
| `eox-oracle`: epochs, rule pages, evidence pages and history, challenges, `precommit`/`postcommit`, `close_window`, `cancel`/`expire`, `authenticated.rs` receiver; devnet program `D1HhP4kV…CYe85` | **Delete** | Stop using the devnet program; do not upgrade it. |
| `packages/oracle/PROTOCOL.md`, `RECEIVER.md`, `fixtures/*` (`protocol-v1.json`, baseline, contested, us-improves, confidence-decay), `idl/` | **Delete** | Shared EOX vectors; Godwin's Foundry tests depending on them are deleted in the same step. |
| `packages/methodology`: canonical manifest and digest approach | **Carry over** | Into `packages/cox-methodology` as `COX/METHODOLOGY/V1`. |
| `packages/methodology`: country catalogue, ISO mappings, period ordinals, confidence compiler, research bindings, calibration research, synthetic policy | **Delete** | |
| `apps/oracle-worker`: `journal.ts` (atomic state, PID lock), `retry.ts`, `solana.ts` transport (finalized reads, Anchor transactions, no fake chain), operation-ID and reconcile-before-rebuild logic | **Carry over** | Into `apps/cox-publisher`. Replace the wallet-file signer with `@eox/signing` (`oracle-operator`). |
| `apps/oracle-worker`: `provider.ts`, `worker.ts` proposal flow, `protocol.ts`, `authenticated.ts`, `publication.ts`, `references.ts`, `preview.ts`, `codec.ts`, `demo.ts`, `examples/`, `REFERENCE-READERS.md`, `AUTHENTICATED-RECEIVER.md` | **Delete** | |
| Product step 8 (exchange payoff, quote and reserve equations) and step 10 (exchange contracts) — not started | **Delete** (as tasks) | Superseded by the COX mechanism specification and the pool inside the `cox` program. |
| `docs/papers`, `docs/cox` | **Preserve** | Paper 3 is the product source. |
| Root `README.md` | **Carry over** | Rewrite for COX once the deletions land. |

### 6.3 Godwin

| Existing work | Action | What to do |
|---|---|---|
| `packages/optimistic-oracle/evm`: `EoxAssertionAdapter`, `EoxContinuousAdapter`, `ContinuousProtocol`, deploy script, interfaces, 65 Foundry tests | **Delete** | COX has no EVM chain. The annual adapter already on Sepolia is abandoned in place; record its address in the deletion commit message. |
| `packages/optimistic-oracle/solana`: `eox_settlement_oracle` | **Delete** | No annual settlement in COX. |
| `apps/uma-relay`: asserter, relay, settle/close/publish loop, `abi.ts`, `claims.ts`, `digest.ts`, `remote-sender.ts`, `server.ts`, `auth.ts`, UMA bond handling | **Delete** | |
| `apps/uma-relay`: `env.ts`, `state-file.ts`, the challenger's tick-and-cursor loop with per-item verdicts, `evidence-source.ts` artifact hash checks | **Carry over** | Into `apps/cox-monitor` (task G2). The monitor holds no key and signs nothing. |
| Trading UI from product step 3, if any exists outside this repo | **Carry over** | Keep wallet connection, layout and use of the typed client. Replace country, WORLD and pair screens with the COX screens in task G3. If nothing exists, start fresh in `apps/web`. |

## 7. New work

### 7.1 Joel

**J0 — `packages/price-feeds` (new package).** The only code in the repository
that talks to an exchange. Joel owns it; the archiver (J1) and Godwin's monitor
(G2) both import it. It contains:

- **Venue adapters**, one module per venue, each returning the raw response
  bytes together with the parsed candle, and nothing else:
  - `kraken-ws`: one WebSocket v2 connection subscribed to `ohlc`, interval 1,
    for all roster symbols plus `USDT/USD`. Keeps the frames per symbol per
    minute; a minute with no update is empty only if the connection had no gap
    across it. Reconnects with backoff 1 s doubling to 60 s plus jitter.
  - `kraken-rest`: `GET /0/public/OHLC?interval=1&since=…`, used only to repair
    minutes covered by a WebSocket gap and for bulk verification.
  - `coinbase`: `GET /products/{id}/candles?granularity=60&start&end`; an
    omitted candle is an empty minute.
  - `bybit`: `GET /v5/market/kline?category=spot&interval=1&start&end`; volume
    0 is an empty minute.
- **One rate limiter per venue per process**, shared by every caller: token
  bucket at the budgets in `SYSTEM.md` §10.1 (half the published limit or
  less), concurrency 1 per venue, exponential backoff with jitter on `429`,
  Kraken `EAPI:Rate limit exceeded` and Bybit rate-limit codes, `Retry-After`
  honoured, a 60-second circuit breaker after five consecutive failures, and a
  one-minute cache so an identical request is never sent twice. Budgets are
  configuration with the §10.1 values as maximums; the package refuses a
  configured budget above them.
- **`resolveCutoffPrice(asset, cutoff)`** implementing `COX/PRICE-FALLBACK/V1`
  exactly (`SYSTEM.md` §3.2): Kraken, then Coinbase, then Bybit with USDT/USD
  conversion, then Kraken's carried close. It queries a fallback venue only
  for an asset that needs it and returns every attempt with its outcome and
  raw bytes.
- **`verifyRange(venue, asset, from, to)`** for bulk re-fetching (Kraken 720,
  Coinbase 300, Bybit up to 1,000 candles per call), used by the monitor.
- **Metrics:** requests, `429`s, backoff time and breaker state per venue,
  exported for the dev VM's logs.
- **Tests** with recorded venue responses: empty-minute handling per venue,
  every fallback step, USDT conversion, rate-limit backoff, breaker, cache and
  budget refusal. No test calls a live venue.

Before J1 runs live, Joel checks from the dev VM that `api.bybit.com`
responds and that Bybit's terms permit our use. If either fails, the Bybit
adapter stays disabled by configuration (no proxy or VPN) and TRX and JUP run
on Kraken alone.

**J1 — Archiver.** A loop in `packages/ingestion` (systemd `cox-archiver` on
the dev VM) that calls `resolveCutoffPrice` for the 30 assets after each
cutoff; stores every attempt's raw bytes in `source_payloads`; records
`venue_responses`, `venue_attempts` and `price_observations` with venue, step,
close text, `price_e8`, trade evidence, trade age, admissibility and reason
(`SYSTEM.md` §3.2, §5.1, §9); writes the `snapshots` row with its digest by
cutoff + 30 s; records incidents. After a restart, catch up missed cutoffs only
within the venues' history windows, in order, without inventing data. Watch the
three venues' listings daily and raise an incident if a symbol is renamed,
delisted or changes its decimals. **Feed check:** run for 7 days before P1
seals the manifest and report, per asset, the share of inadmissible cutoffs,
the share resolved by each venue and step, the longest trade age, and each
venue's request count and rate-limit responses. An asset above 0.1%
inadmissible fails; RENDER and TAO are the ones to watch.

**J2 — Evidence API price routes.** On `apps/evidence-api`:
`GET /v1/prices/cutoffs/:cutoff` (the archived snapshot for a cutoff: per
asset every venue attempt and its response SHA-256, the chosen venue and step,
candle, close text, `price_e8`, trade evidence and age, admissibility, snapshot
digest, incidents),
`GET /v1/prices/changes?after=` (commit-safe feed of new cutoffs),
`GET /v1/artifacts/:sha256` (unchanged). Read-only; never computes references.

**J3 — App API `cox.app-api/v1` and fixture.** Same envelope, client and
fixture/live split as today. Routes: deployment; assets with their venue symbols, last price venue and
current trade age;
CRYPTO composition and history; latest and historical publications with
prices, CRYPTO level and references; per-class backing, units and unit value;
current batch (cutoff, open/closed) and system status (fresh, delayed,
halted, incident); a wallet's positions, pending requests, receipts,
withdrawal payable; publication stream (SSE, resumable). Fixed-point values as
integer strings with their scale. Fixture values come from Peter's vectors
(P1), never computed in the API. Error codes: `NO_PUBLICATION`,
`PUBLICATION_NOT_FOUND`, `UNKNOWN_ASSET`, `UNKNOWN_CLASS`, plus the existing
generic codes.

**J4 — Signer bindings.** After P3 deploys: bind `oracle-operator` as in §6.1,
retire the EVM and unused roles, publish the updated key directory.

**J5 — Live app API.** Indexer over finalized `cox` program events with durable
progress; positions and receipts from chain state; unsigned transaction
builders for deposit, switch, redeem, cancel and withdraw showing batch,
cutoff, amounts, conditions and expiry; submission tracking that preserves the
user's signed bytes; monitor verdicts from G2 in the status envelope.
Reconcile indexed totals with the on-chain vault and ledger every publication.
Reference history and executed-flow history are separate series.

### 7.2 Peter

**P0 — Archive tag.** Tag `main` as `eox-archive` and push it before anyone
deletes code. First task; unblocks every deletion.

**P1 — Mechanism and methodology specification.** `packages/cox/SPEC.md` plus
`packages/cox-methodology`: the `COX/METHODOLOGY/V1` manifest (assets in
canonical order, venue symbols, price scale (USD × 10⁸), weights, origin rule,
candle and fallback rule (`COX/PRICE-FALLBACK/V1`), USDT/USD conversion, maximum trade age, cadence, archive and snapshot-acceptance deadlines, asynchronous execution, runtime
authority, transfer rule id, arithmetic scales and rounding); exact formulas for CRYPTO, references, MVP-0 and unit
accounting; request and publication state machine; account, instruction,
event and error definitions; and `packages/cox/fixtures/vectors.json` with
exact inputs and outputs, including a missed minute, an empty class, a
condition failure, an expiry and the Paper 3 §12 worked example. This is the
contract Joel and Godwin build against.

**P2 — COX math crate and simulations.** `packages/cox/crates/math` and `cli`,
passing the vectors. Run the Paper 3 §17 checks that MVP-0 must pass on
synthetic paths: equal returns leave references unchanged, deposit after a gain
cannot buy it, redeem after a loss cannot escape it, batch permutations give
identical results, split orders gain nothing from rounding, mass exit and full
drain stay backed, vault equality holds after every step. Commit the results.

**P3 — `cox` program on devnet.** Registry, pause, admin and runtime
authorities, test collateral mint and vault, classes, request accounts,
`publish` (operator-signed snapshot of 30 prices and trade ages → checks in
`SYSTEM.md` §5.2 → reference → revalue 31 classes → fix unit values → commit), `execute` (crank batch requests at the fixed values; the next
publication cannot start until the batch is fully executed; no hard fill deadline), `cancel`,
`withdraw`, halted-mode refunds, read-only simulated readers. Vault equality
asserted in every value-moving instruction. Publish program ID, IDL and the
permitted runtime instruction list to Joel. Reuse a fixed batch account and
latest-publication account per pool; never overwrite an unfinished batch.
Keep batch IDs, sequences and predecessor checks in their payloads. Batch and
publication accounts use schema 2 and fixed per-pool addresses; all other
account schemas remain unchanged. On-chain history exposes the latest
publication; earlier publications come from the verified archive.

**Swap SDK — Peter.** `@cox/client/swap` supplies direct collateral entry into a
selected asset class or CRYPTO, class redemption, on-chain quote estimates,
unsigned wallet transactions, committed balances and request status,
cancellation/refund and withdrawal. Retain the existing benchmark methods.
`@cox/client/routed` composes supported token swaps with full-output queued entry
through a separate router: measure collateral received, preserve prior wallet
collateral and submit one fee-aware deposit into the selected class. The DEX
swap and deposit submission are atomic; future position execution remains
asynchronous. Joel integrates the composed build/submission API; Godwin consumes
those unsigned transactions in the app. Existing holders can still switch
between classes. Quotes do not guarantee the next publication's output or fill
time. Future epoch pools are separate pools alongside the current pool, outside
this SDK change; faster publication is deferred.

**P4 — Publisher.** `apps/cox-publisher`: for each cutoff, read the archived
snapshot from J2, submit exactly those values and their digest in `publish`,
crank `execute` to completion, reconcile on restart, never publish a cutoff
twice. Signs only through the signer. Before another publication, durably store
the previous finalized publication's complete bytes and verified hashes,
identity and finalized chain context. Archive failure stops new publications.
Keep this publication archive separate from J2's price-input archive. Verify
archive backup and restore before live activation. Joel updates signer account
validation for the fixed addresses; Godwin updates latest/history consumers.

The two 8 KB rolling accounts cost approximately 0.085 devnet SOL once per pool
at the current rent quote, rather than each minute. Initialization of other
accounts, user accounts and transaction fees require separate funding. Requote
rent before deployment; do not treat 0.085 SOL as the entire operating budget.

**P5 — End-to-end verification.** Run the devnet MVP for 24 hours with live
exchange prices and scripted users; record publications, misses, incidents,
monitor verdicts and vault reconciliation; publish the results. This is the
MVP acceptance record.

### 7.3 Godwin

**G1 — Remove the EVM/UMA stack.** The deletions in §6.3, after P0, in one or
more `chore(cox):` commits. Confirm `pnpm -r build` and `pnpm -r test` still
pass.

**G2 — Independent monitor.** `apps/cox-monitor`: an independent TypeScript
implementation of `SYSTEM.md` §4 and §7 that matches every vector in P1. For
each finalized publication: fetch the archived snapshot from J2, check every
response SHA-256, re-fetch the same candles in bulk from each venue through
its own `@eox/price-feeds` client (J0) at no more than a quarter of each
venue's published limit, confirm every fallback step's outcome and the chosen
close, and check the digest against the archive and the on-chain prices; recompute CRYPTO, references, revaluation and every executed
request; check vault equality. Emit one verdict per publication through a small
read-only HTTP endpoint that Joel's API consumes. Report mismatches; never
sign or pause.

**G3 — Web app.** `apps/web` against Joel's typed client, fixture origin first:
wallet connection; asset pages (price with its venue and trade age, COX reference,
CRYPTO, next cutoff);
CRYPTO page (pilot label, members, weights, history); deposit, switch and
redeem forms showing the target batch, conditions and the estimate labelled as
an estimate, not a quote; queued, executed and rejected request states;
portfolio (units, redeemable value, deposited basis, withdrawals, pending);
withdraw; publication history; status banner (fresh, delayed, halted,
incident, monitor mismatch). MVP-0, test collateral and "prices attested by
the operator from exchange data" are labelled on every trading screen. User keys stay in the user's wallet.

**G4 — Live user journey.** Connect G3 to the live API and demonstrate on
devnet: deposit → queued → executed; switch; redeem while another user
deposits in the same batch; withdraw; cancel before cutoff; a missed minute
seen by the user.

## 8. Execution order

| Step | Owner | Task | Depends on |
|---|---|---|---|
| 0 | Peter | P0 archive tag | — |
| 1 | Peter | P1 specification and vectors | — |
| 2 | Joel | J0 `price-feeds` package and Bybit access check, then J1 archiver and the 7-day feed check | — |
| 3 | Godwin | G1 remove EVM/UMA stack | 0 |
| 4 | Joel | EOX deletions in §6.1 that nothing COX depends on (ingests, cron, Postman) | 0 |
| 5 | Joel | J2 evidence API price routes | 2 |
| 6 | Joel | J3 app API schema and fixture | 1 (fields and fixture values); skeleton can start at once |
| 7 | Godwin | G3 web app on fixture | 6 |
| 8 | Peter | P2 math crate and simulations | 1 |
| 9 | Godwin | G2 monitor against vectors | 1; venue re-fetch needs J0 (step 2); live checks need 5 |
| 10 | Peter | P3 `cox` program on devnet; then Peter's §6.2 deletions | 8 |
| 11 | Joel | J4 signer bindings and role retirement | 10 |
| 12 | Peter | P4 publisher running on the dev VM | 5, 10, 11 |
| 13 | Joel | J5 live app API; then Joel's remaining §6.1 deletions | 9, 12 |
| 14 | Godwin | G4 live user journey | 7, 13 |
| 15 | Peter | P5 24-hour end-to-end verification — **MVP done** | 9, 14 |

Parallel tracks: Joel (2 → 4 → 5 → 6), Peter (1 → 8 → 10), Godwin (3 → 7, 9)
run independently until step 10. Fixture work never waits for live services.

## 9. Blockers that must stay visible

- **Peter — trust boundary:** exchange data is unsigned, so the program trusts
  the `oracle-operator` key for prices (`SYSTEM.md` §2). Acceptable on devnet
  with test collateral only; an authenticated source is a real-collateral gate.
- **Joel — thin pairs:** with the Coinbase and Bybit fallback, 0.6% of
  asset-minutes still had no trade on any venue (RENDER 31 of 300, TAO 9). A
  trade age above 30 minutes on any asset stops the whole minute. If the feed
  check shows this happening often, Peter drops the asset before sealing
  rather than loosening the bound.
- **Joel — Bybit access:** Bybit excludes US users and is reported to block US
  and cloud IPs; the dev VM is in a US region. Without Bybit, TRX and JUP have
  no fallback.
- **Joel — venue load:** the feed-check report must show no sustained `429`s
  from any venue. If one appears, lower the budget; never raise it.
- **Joel — roster admission:** each of the 30 assets enters the manifest only
  if it passes the J1 feed check before P1 seals it. Failing assets are
  dropped, not substituted; the sealed `N` is what the product labels.
- **Peter — transfer rule:** MVP-0 is a test mechanism. Real collateral stays
  blocked until the items in `SYSTEM.md` §12 are decided and simulated. No API
  or UI developer invents payout rules to unblock themselves.
- **Peter — Solana limits:** if archiving by cutoff + 30 s and `publish` by
  cutoff + 55 s cannot be met, or `publish` exceeds the compute limit for 31
  classes, P3 reports the
  measured limit before changing the cadence; the cadence is a product
  commitment.
- **Joel — signer funding:** `oracle-operator` must hold devnet SOL for publication
  and execution fees.

## 10. Rules for agents during the pivot

- Do not delete anything before the `eox-archive` tag exists on `origin`.
- Do not port EOX concepts by renaming: countries, WORLD, indicators,
  confidence factors, vintages, challenge windows and epochs have no COX
  meaning (Paper 3 §14).
- Do not call an exchange from any package other than `packages/price-feeds`.
- Do not reintroduce UMA, EVM or a challenge window into the publication path
  without a new version of this brief and `SYSTEM.md`.
- Record each finished task in `AGENTS.md`.
