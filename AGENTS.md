# AGENTS.md

Shared log that keeps every person's coding agent in sync on this repo.
Read it in full before starting work. Add to it when you finish something
another agent needs to know.

## Rules

1. **Append-only.** Never edit or delete an existing entry. To correct or
   supersede one, append a new entry that names the earlier entry's date and
   title and says what changed.
2. **New entries go at the bottom**, in the format below.
3. **Facts, decisions and conventions only.** Record what changed, what was
   decided and by whom, and what other agents must or must not do. Link to
   READMEs and commits instead of repeating them.
4. **One entry per topic.** Keep each entry short enough to read in a minute.
5. **Commit an entry on its own** (`docs(agents): ...`), and fetch and rebase
   before pushing so entries from different people do not collide.

## Entry format

```markdown
### YYYY-MM-DD · <owner> (<agent>) · <short title>

- **Area:** <packages or folders touched>
- **What:** <what changed or was decided>
- **Rules for agents:** <must / must not, if any>
- **Open:** <unresolved questions, if any>
- **Refs:** <commits, READMEs, docs>
```

## Log

### 2026-10-06 · Joel (Claude Code) · Data layer state and repo conventions

- **Area:** `packages/evidence-store`, `packages/ingestion`, `deploy/dev`, `postman`
- **What:**
  - Ingestion covers the six indicators proven for all 30 pilot countries:
    #6 container throughput (IMF PortWatch), #17 real residential property
    prices (BIS), #21 real GDP vintages, #22 core CPI, #23 unemployment (OECD),
    #24 policy rates (BIS). Each runs live at 30/30.
  - Evidence semantics for oracle inputs: every HTTP response is stored
    byte-for-byte in `source_payloads` (SHA-256 checked by the database), each
    observation links to it via `raw_sha256`, `raw_value` keeps the source
    string, `published_at` stays empty unless the source states one, missing
    values are never zero-filled (`coverage_reported` / `coverage_total`), and
    `recorded_at` is stamped by the database and cannot be set by callers.
  - Revision detection compares value and coverage; vintaged series (GDP
    editions) are compared with the preceding edition, so missing historical
    editions are backfilled.
  - Dev server: VM `eox-dev` in GCP project `colosseum-eox`, Postgres on
    localhost only, ingests daily at 06:00 UTC.
- **Rules for agents:**
  - `observations` and `source_payloads` are append-only (database triggers).
    Never disable the triggers; fix data with `recordCorrection`.
  - `known_at` is a source claim and can be backdated. Do not use a `getAsOf`
    query as an immutable snapshot for settlement; bind exact records.
  - OECD requests must send `Accept-Language: en` (the server returns HTTP 500
    for `*`, Node's default) and should query many countries in one request
    (`AUS+BEL+...`); the API rate-limits per IP.
  - `main` is shared. Fetch and rebase before pushing or deploying, and never
    deploy a commit that is not on `origin/main`.
  - Commits: small and atomic, conventional prefixes, no AI attribution in
    messages. Source files carry no comments and no emoji.
- **Open:** whether the dispute layer uses UMA's optimistic oracle or the
  in-repo settlement and arbiter programs is being settled between Peter and
  Godwin (2026-10-06); data-layer work does not depend on the answer yet.
- **Refs:** `packages/ingestion/README.md`, `deploy/dev/README.md`,
  `postman/eox-source-apis.postman_collection.json`

### 2026-10-07 · Peter (Codex) · Upstream integration readiness review

- **Area:** Oracle, ingestion, evidence and deployment integration boundaries.
- **What:** Reviewed checkout `2b2bc66` after Peter resolved the dependency conflict. The annual optimistic settlement flow and continuous evidence oracle are separate implementations with different event and commitment contracts. The worker still uses fixture evidence.
- **Rules for agents:** Do not treat the annual final-result relay as a per-record challenge adapter. Preserve the publication-time readiness rule until a versioned replacement policy is agreed. Do not equate stored rounded values with exact raw source strings.
- **Open:** Shared methodology output contract, live evidence provider, publication-time policy, dispute event integration and operated worker/relay services.
- **Refs:** `docs/oracle/upstream-readiness.md`, `docs/oracle/results/README.md`.

### 2026-10-07 · Peter (Codex) · Explicit methodology policy compiler

- **Area:** `packages/methodology`, oracle-worker integration tests, `docs/oracle`.
- **What:** Added an explicit six-indicator policy compiler, 30-country catalogue, ISO mappings, native calendar ordinals, exact GDP scaling, portable manifest and synthetic example. Ten package tests and 28 worker tests pass, including Rust preview integration.
- **Rules for agents:** Synthetic anchors are not calibrated economic claims. Preserve stable source series identities across policy versions. The portable manifest digest is not a Solana deployment commitment or executable image ID. Do not invent publication times or silently round source values.
- **Open:** Live calibration, GDP edition selection, reproducible port aggregation and the live evidence/dispute adapters. No methodology deployment in this step.
- **Refs:** `packages/methodology/README.md`, `docs/oracle/methodology-integration.md`.

### 2026-10-07 · Peter (Codex) · Calibration sensitivity review

- **Area:** `packages/methodology/research`, `docs/oracle/calibration-proposal.md`.
- **What:** Added reproducible synthetic Rust sensitivity scenarios and a proposed indicator interpretation. Year-old comparison observations drive four comparison-dependent slots to zero confidence under the current freshness rule; economic outputs remain unchanged. Equal-weight stress parameters produce large EOX-20 moves.
- **Rules for agents:** Research targets and bounds are not calibrated live parameters. Do not restamp historical observations or widen freshness merely to hide historical-comparison decay. The proposed smaller scored profile and alternative historical-confidence treatment are not implemented or approved.
- **Open:** Peter's review of score interpretation, immutable historical calibration data, and any separately versioned confidence/profile changes.
- **Refs:** `docs/oracle/calibration-proposal.md`, `docs/oracle/results/calibration/sensitivity.json`.

### 2026-10-07 · Peter (Codex) · Geffy research baseline clarification

- **Area:** Methodology research and calibration proposal.
- **What:** Peter supplied Geffy's 25-indicator data availability and ingestion audit. Qualifies the earlier 2026-10-07 Calibration sensitivity review: its smaller scored profile is only a hypothesis and must be reconciled with this existing research.
- **Rules for agents:** Read supplied team research before proposing a replacement shortlist. The audit's data-infrastructure scores are not economic weights or per-observation confidence. Match findings to the actual selected source and country; preserve provisional coverage qualifications.
- **Open:** Economic calibration and explicit mapping from source research to confidence policy.
- **Refs:** `docs/oracle/calibration-proposal.md`; <https://docs.google.com/document/d/1jR1YtxBS1-l67OBeQe0LPM9N5irLiwUDIokuqyS3epg/edit>.

### 2026-10-07 · Peter (Codex) · Research bindings and confidence assertions

- **Area:** `packages/methodology`, worker integration tests, `docs/oracle`.
- **What:** Added six pilot audit bindings and a named eight-factor assertion compiler. It binds record/payload, assessor, rating rubric, source policy and supporting digests into a canonical manifest and emits the existing worker tuple. Sixteen methodology tests and 29 worker tests cover this integration.
- **Rules for agents:** The compiler checks structure, not assertion truth or assessor authentication. Live adapters must verify referenced artifacts and use the source authority pinned by the configured rule. Audit ratings never become economic weights or confidence by automatic scaling. All six indicators remain under review; no roster or arithmetic changed.
- **Open:** Historical calibration data, numerical rating rubrics, economic parameters and live provider integration. Do not claim the helper is already wired to live evidence.
- **Refs:** `packages/methodology/README.md`, `docs/oracle/geffy-methodology-contract.md`.

### 2026-10-08 · Joel (Claude Code) · System contract v1 proposed

- **Area:** every package; new root file `SYSTEM.md`.
- **What:** Consolidated the time frames, data types, storage, commitment identities and the meaning of pre-commitment, challenge and post-commitment into `SYSTEM.md`, at Peter's request. It separates the three clocks that were being mixed: the data clock (native source periods, polled daily), the reference clock (continuous proposals; 60 s devnet challenge window) and the settlement clock (annual epoch, cutoff 31 July of the following year, 72 h UMA liveness). It proposes the six indicators as the v1 live set, the evidence adapter mapping, a commit-safe change cursor, a precision rule and a publication-time policy.
- **Rules for agents:** Read `SYSTEM.md` before working. Its PROPOSED and OPEN items are not decisions until the sign-off table in §9 is filled in. `SYSTEM.md` is versioned, not append-only: change it only with a version bump, the named owners' sign-off and a new entry here.
- **Open:** All §9 sign-offs, especially continuous challenge authentication (§6.3) and the mapping from continuous references to the annual claim (§6.4), both for Peter and Godwin.
- **Refs:** `SYSTEM.md`; earlier entry 2026-10-07 · Peter (Codex) · Upstream integration readiness review. The `docs/oracle/...` files cited in earlier entries are gitignored and exist only locally.

### 2026-10-08 · Joel (Claude Code) · Live evidence API deployed

- **Area:** `packages/evidence-store`, new `apps/evidence-api`, `deploy/dev`.
- **What:** Implemented `SYSTEM.md` §5.5–5.6. Migration `007` stamps each observation with its inserting transaction ID; `readChanges` only returns rows older than every running transaction, so a late commit is never skipped. `apps/evidence-api` serves `GET /v1/changes`, `/v1/records/:recordId` and `/v1/artifacts/:sha256`, read-only, on `127.0.0.1:8787` of the dev VM (systemd `eox-evidence-api`). Verified on the VM at `afd7c58`: 15,291 of 15,291 observations served once each, all six indicators for all 30 countries, 38 of 38 artifacts hash-verified.
- **Rules for agents:** The worker must read evidence through this API, never the database. Record IDs are `eox:observation:<id>`, change IDs `eox:change:<id>`; cursors are opaque. Facts omit `confidenceBps`, `manifest` and `comparisonRecordId` (methodology side) and carry `publishedAt: null` until the §5.4 policy exists, so the worker's readiness check rejects them by design. When selecting text-cast columns in SQL, always qualify `ORDER BY observations.id`: an unqualified `id` sorts the text alias and silently skips rows.
- **Open:** Peter: an HTTP `EvidenceProvider` in the worker pointed at this API, plus the §5.3 precision and §5.4 publication-time decisions. The worker's journal tests fail on Windows (`EPERM` on directory fsync) but pass on Linux (23 pass, 6 skipped).
- **Refs:** `apps/evidence-api/README.md`, `SYSTEM.md` §5, commits `d8c99d7`..`afd7c58`.

### 2026-10-08 · Joel (Claude Code) · Dev database backups

- **Area:** `deploy/dev`, GCP project `colosseum-eox`.
- **What:** Closes the backup gap in `SYSTEM.md` §5.7. The dev VM dumps Postgres daily at 05:30 UTC (`pg_dump --format=custom`, validated with `pg_restore --list`) to `gs://colosseum-eox-db-backups`, which blocks public access and deletes objects after 30 days. The VM now runs as service account `eox-dev-vm`, which can only create objects in that bucket, so it cannot read, overwrite or delete backups. A restore of the first backup was verified: 15,291 observations, 38 payloads with valid hashes, 7 migrations and working append-only triggers.
- **Rules for agents:** Never restore over the live `eox` database; restore into a new database and point `DATABASE_URL` at it. Do not widen the VM service account's bucket role. The VM's external IP changed to `35.193.103.79`; address the VM by instance name, not IP.
- **Open:** Backups cover the dev database only; testnet and production need their own policy.
- **Refs:** `deploy/dev/README.md` (Backups and restore), commits `44a0d9c`, `a9908d3`.

### 2026-10-08 · Peter (Codex) · Historical calibration pilot captured

- **Area:** `packages/methodology/research`, `docs/oracle/results/history-pilot`.
- **What:** Captured 2019–2025 OECD/BIS history for US/JP/NZ plus two seven-day PortWatch samples. Twelve successful responses and 29 data files have a sealed hash manifest; inventories rebuild offline. GDP retains source editions; no publication timestamps were invented.
- **Rules for agents:** This is exploratory calibration evidence, not release-time replay or oracle-ready input. Keep Japanese CPI excess precision rejected and US October 2025 CPI/unemployment missing. Preserve alternative CPI routes and GDP editions separately. Do not change sealed source files to fit policy; use a new dataset version.
- **Open:** Full PortWatch history/aggregation, complete roster, source publication evidence, explicit precision decisions and live economic calibration.
- **Refs:** `docs/oracle/historical-data-report.md`, `docs/oracle/results/history-pilot/manifest.json`.

### 2026-10-09 · Peter (Codex) · Separate product direction for review

- **Area:** New root `product.md`; `SYSTEM.md` unchanged.
- **What:** At Peter's request, documented the product in plain English: continuous trading on the previous accepted reference, hourly evidence preparation, a further one-hour challenge window, authenticated outcomes and publication on Solana. Annual settlement is not a required step in this product direction. The document awaits product review and does not claim team sign-off.
- **Rules for agents:** Keep the product brief separate from the engineering contract, as Peter explicitly requested. Do not rewrite `SYSTEM.md` as part of this task. Do not treat existing annual code as an approved trading lock or the new timing direction as already deployed. Read the unresolved integration and exchange decisions in `product.md` before implementation.
- **Open:** Product review, continuous UMA contract, overlapping/disputed proposal scheduling, live methodology/data policies and exchange ownership/accounting.
- **Refs:** `product.md`; qualifies the product assumptions in the 2026-10-08 System contract v1 proposed entry without editing that contract.

### 2026-10-09 · Peter (Codex) · Product v1 rules pinned in separate brief

- **Area:** `product.md` version 2; `SYSTEM.md` unchanged.
- **What:** Peter requested concrete rules inside the product brief, without a question round. Replaced its open-decision table with evidence plus snapshot assertions, one-hour windows, authenticated relay, one active proposal, strict publication-time/exact-precision admission, explicit GDP/port selection, retained v0.1 confidence arithmetic, calibration activation requirements, test-asset launch boundary and incident/staleness behavior.
- **Rules for agents:** These are target requirements, not deployed behavior or other developers' sign-off. Preserve evidence-level dispute attribution; a rejected snapshot does not identify a guilty record. Keep real-money deposits disabled until the complete exchange payoff/reserve specification and verification exist. Do not invent calibration results to fill the methodology artifact. Read section 8 before aligning implementation; do not silently update `SYSTEM.md`.
- **Open:** Implementation, measured calibration artifact and exchange payoff/reserve equations remain deliverables under the pinned activation rules.
- **Refs:** `product.md` sections 8–9; supersedes the open-decision list described in the earlier 2026-10-09 Separate product direction for review entry.

### 2026-10-09 · Peter (Codex) · Explicit assertion relay and admission contract

- **Area:** `product.md` version 3; engineering code and `SYSTEM.md` unchanged.
- **What:** At Peter's request, replaced coordination wording with explicit claim contents, evidence/snapshot assertion registration, authenticated relay event and closure requirements, timestamp provenance, revision selection and exact six-decimal admission examples.
- **Rules for agents:** Snapshot claims commit the evidence-assertion list; their own returned UMA ID is registered afterward, avoiding a self-referential commitment. Closure verifies that list plus the registered snapshot assertion. No timestamp guesses, silent decimal rounding, cross-proposal replay or relay-invented evidence verdicts. These are implementation requirements, not a claim of completed integration.
- **Open:** Implement the shared encoding vectors, UMA/relay integration and admission checks under the documented contract.
- **Refs:** `product.md` sections 6, 8.1, 8.2 and 8.4.

### 2026-10-09 · Peter (Codex) · Individual ownership and app handoff

- **Area:** `product.md` version 4; `SYSTEM.md` unchanged.
- **What:** Peter requested single-owner obligations instead of joint attribution. Split assertion, relay, evidence admission and incident duties into each developer's producer/consumer responsibilities. Added Peter-owned app client/API requirements, fixture handoff and individual pass/fail delivery checklists.
- **Rules for agents:** Joel owns source facts and evidence service; Godwin owns UMA assertions, authenticated EVM outcomes and relay delivery; Peter owns schemas/test vectors, input admission, Solana verification/publication and app-facing integration. No handoff is assigned merely to a pair of developers. App work can start on the fixed client/fixture contract; live-data integration and real-money launch have separate acceptance gates. Do not report integration complete merely because the document is updated.
- **Open:** Execute the individually assigned deliverables and record test evidence; no new joint policy meeting is required by this brief.
- **Refs:** `product.md` sections 8–9; supersedes joint owner wording in earlier product brief entries.

### 2026-10-09 · Peter (Codex) · Direct developer assignments

- **Area:** `product.md` version 5.
- **What:** Peter clarified that responsibility must be written as direct implementation assignments, not coordination or acceptance checklists. Section 6 now has exactly three developer assignments: Peter builds methodology/reference calculation and Solana publication, Godwin builds repeated UMA assertion/dispute/relay processing, Joel builds immutable source evidence supply. Each ends with its concrete handoff. Removed duplicated ownership blocks and the long closing checklist while retaining detailed contract rules.
- **Rules for agents:** When asked to clarify task boundaries, state what each person builds, why it exists and what the next component consumes. Do not substitute questions, sign-off language or process checklists for the implementation assignment.
- **Refs:** `product.md` sections 6 and 9.

### 2026-10-09 · Peter (Codex) · Correct scope of CODE contract rules

- **Area:** `product.md` version 6, section 8; `SYSTEM.md` unchanged.
- **What:** Peter clarified that generic developer assignments do not answer this task. Rebuilt section 8 around specific SYSTEM.md mismatches, each with source-section references and individual implementation changes. Covers annual versus continuous flow, incompatible clocks, assertion/relay authentication, input mapping, timestamps, precision, revisions, confidence, methodology, deployment and app handoff. Reduced section 6 to a short ownership note.
- **Rules for agents:** Resolve the identified infrastructure mismatch in section 8 itself. Name the existing conflict, then the exact change each affected owner must make; do not replace it with role summaries, coordination questions or generic checklists. Solana must bind authenticated UMA assertion deadlines rather than infer them from pre-commit time.
- **Refs:** `product.md` section 8; corrects the scope of the earlier 2026-10-09 Direct developer assignments entry.

### 2026-10-09 · Peter (Codex) · Signing service and ordered trading-app work

- **Area:** `product.md` version 7, sections 8.12–8.15 and 9.
- **What:** Peter requested Joel-owned shared infrastructure signing and explicitly assigned trading UI to Godwin, contracts to Peter, and APIs/service integrations to Joel. Added a remote signer/client, role-separated keys, public-key directory, exact connection points, user-wallet boundary, and 16 ordered tasks with parallel tracks and blockers. Reassigned app API/client ownership from Peter to Joel; Peter retains chain schemas and deterministic reference readers.
- **Rules for agents:** One signing interface does not mean one shared key. Keep role/chain/environment keys separate, reject arbitrary signing, exclude admin upgrades and user trades, and retain real UMA/Wormhole verification. Create public key identities before deploying and binding contract addresses. UI starts against Joel's fixture API; live-data and real-money completion require their separate gates. This is a documented implementation plan, not a signer or app deployment.
- **Open:** Execute section 9; missing publication evidence, calibration, operating funds and exchange equations are named implementation blockers, not silently waived requirements.
- **Refs:** `product.md` sections 8.14, 8.15 and 9; supersedes prior entries assigning app APIs to Peter.

### 2026-10-09 · Joel (Claude Code) · Step 2: app API, signing types and fixture API

- **Area:** new `packages/app-api`, `packages/signing`, `apps/app-api`.
- **What:** Delivered `product.md` §9 step 2. `@eox/app-api` is the versioned schema (`eox.app-api/v1`) and typed client; `apps/app-api` serves it from a `ReferenceSource` port, with a fixture source today. Routes: latest and historical snapshots, country/WORLD, country/country pairs, current proposal with UMA assertions, evidence readiness, paged and streamed (resumable) finalized publications, explicit `NO_ACCEPTED_REFERENCE`, `SNAPSHOT_NOT_FOUND`, `INVALID_PAIR`. Fixture values are computed by `eox-oracle-math` (`preview` and `reference`) over `packages/oracle/fixtures` baseline and us-improves, via `apps/app-api/fixture-generator` in Docker. `@eox/signing` defines the §8.14 request/result/key-directory types and a validating client.
- **Rules for agents:** UI work (Godwin, step 3) uses `createAppApiClient` against `pnpm --filter @eox/app-api-server start`. Never compute references in the API or UI; values come from the oracle. Fixed-point values are integer strings at scale 1,000,000; parse with `BigInt`. Regenerate `fixtures/oracle-preview.json` whenever `packages/oracle/fixtures` changes; a test enforces this.
- **Open:** Snapshot identity fields are provisional until Peter publishes step 1 (claim/relay schemas, account layouts, readers). Trading endpoints wait for Peter's step 8 equations and instruction definitions. The signing service itself is step 4.
- **Refs:** `apps/app-api/README.md`, `packages/signing/README.md`, commits `b74af20`..`5e73253`.

### 2026-10-09 · Joel (Claude Code) · Dev signing key identities published

- **Area:** GCP `colosseum-eox` Cloud KMS, `apps/signer`, `deploy/signing/dev-keys.json`.
- **What:** First part of `product.md` step 4. Key ring `eox-signing-dev` (us-central1) holds one non-exportable key per role: `oracle-operator` and `solana-relayer` are Ed25519 (software protection; Cloud KMS does not offer Ed25519 at HSM level), `uma-asserter`, `uma-challenger`, `oracle-checker` and `evm-relayer` are secp256k1 (HSM). Only service account `eox-signer` may sign with them. Public keys and addresses are in `deploy/signing/dev-keys.json` (Solana devnet and Sepolia), generated from KMS by `apps/signer/scripts/key-directory.ts`.
- **Rules for agents:** Deploy dev contracts with the authorities in `deploy/signing/dev-keys.json` and pin those addresses on chain. Never create or use another copy of these roles' private keys. Admin and upgrade authorities are not in this directory and must stay outside the signing service. Signing stays disabled for every target until its deployed address is bound in `apps/signer/config/dev.json`; send Joel the deployed program IDs, contract addresses and permitted instructions/selectors.
- **Open:** The signing service itself (KMS adapters, policy, idempotency, Cloud Run deployment) is still in progress. The operational accounts are unfunded.
- **Refs:** `deploy/signing/dev-keys.json`, `apps/signer/config/dev.json`, commits `21ba045`..`376731d`.

### 2026-10-09 · Joel (Claude Code) · Signing service deployed (step 4)

- **Area:** `apps/signer`, `packages/signing`, GCP `colosseum-eox` (Cloud KMS, Cloud Run, Firestore, Artifact Registry).
- **What:** The `product.md` §8.14 signing service runs privately on Cloud Run at `[Cloud Run origin omitted]` as service account `eox-signer`, the only identity allowed to sign with the `eox-signing-dev` KMS keys. It authenticates callers by Google identity token, decodes each Solana/EVM transaction, enforces per-role bindings (contracts/selectors/limits; programs/discriminators/compute price; no lookup tables, contract creation or EIP-7702), records every decision in Firestore for request-ID idempotency (`REQUEST_ID_CONFLICT` on changed bytes) and verifies each KMS signature before returning it. KMS signatures were verified on Solana devnet and by local EVM recovery; 25 signer tests pass.
- **Rules for agents:** Call the signer only through `createSigningClient` from `@eox/signing`, with an identity token for audience `[Cloud Run origin omitted]`. Each caller needs its own service account, listed in `apps/signer/config/dev.json` `callers` and granted `roles/run.invoker`; ask Joel. Signing stays disabled until your deployed program IDs or contract addresses and permitted instructions/selectors are bound in that config. Never hold a local copy of a role key.
- **Open:** Caller service accounts (Peter: oracle worker and checker; Godwin: asserter, challenger, EVM and Solana relayers), target bindings after deployment, and funding the six dev accounts for broadcast proofs.
- **Refs:** `apps/signer/README.md`, `deploy/signing/dev-keys.json`, image `signer:24bb26d`.

### 2026-10-09 · Joel (Claude Code) · Step 5: hourly ingestion, exact ports, revisions, release evidence

- **Area:** `deploy/dev`, `packages/ingestion`, `packages/evidence-store` (migrations `008`, `009`), `apps/evidence-api`.
- **What:** `product.md` §8.2 and §8.6–8.9. Ingests run hourly at :05 with a lock per job (overlaps are skipped) and a 50-minute limit. Port values are read as exact source text and summed exactly; `GET /v1/records/:id/constituents` serves every port/day import/export value from the stored artifact. Each revision links the version it revises (`revision.revises`) with its order basis (`source-edition` for GDP editions, `retrieval` otherwise). A publication time now requires a linked source release (enforced by the database). For PortWatch, a day is dated by the layer's `dataLastEditDate` at which it first appears, proven by the archived current and previous release responses (`publication` block on the fact).
- **Rules for agents:** Never set `published_at` without a `source_releases` link; the database rejects it. `publishedAt` on a fact is exact whole seconds or `null`; the exact time is `publication.release.releasedAtMs`. Port aggregation must use the constituents, not the normalised `value`.
- **Open:** Source-readiness blocker report for v1 admission (§8.7): all 180 slots are blocked. 150 (OECD `gdp_real_volume`, `cpi_core_yoy`, `unemployment_rate`; BIS `policy_rate`, `residential_property_price_real`; 30 countries each) have no machine-readable actual-release evidence from the source, so `publishedAt` stays null (`MISSING_PUBLICATION_TIME`). 30 (`container_throughput`) get release evidence from the next PortWatch data edit onward, but PortWatch edit times carry milliseconds, which v1's whole-second rule rejects (`INVALID_PUBLICATION_TIME`). Peter to decide the admission rule; Joel will not round or invent times.
- **Refs:** `packages/ingestion/README.md` (Publication time), `apps/evidence-api/README.md`, commits `e6417cf`..`b057b03`.

### 2026-10-09 · Peter (Codex) · Task 1 oracle integration interfaces

- **Area:** `apps/oracle-worker`, `packages/oracle`.
- **What:** Published continuous claim/relay Borsh schemas, matching TypeScript/Rust encoders and 12 shared byte/hash vectors. Added finalized account readers, historical epoch/baseline validation, current account/event layouts and a minimal Joel-facing example. Existing pair reads still simulate the on-chain instruction. Verification: 50 worker, 16 methodology and 27 Rust tests pass; worker type-check passes.
- **Rules for agents:** Godwin uses `packages/oracle/PROTOCOL.md`; Joel uses `apps/oracle-worker/REFERENCE-READERS.md`. Relay subjects are full claim digests. Snapshot claims exclude their own returned assertion ID; closure adds it separately. Configuration and portable manifest identities remain distinct. These formats do not implement authenticated relay acceptance; that remains task 2. Network-specific adapter/emitter pinning is required because the wire destination contains program/registry, not a genesis hash. No economics, signer, HTTP API or deployment changed.
- **Refs:** `packages/oracle/fixtures/protocol-v1.json`, `apps/oracle-worker/examples/read-reference.ts`, `product.md` section 9 task 1.

### 2026-10-10 · Joel (Claude Code) · Publication-time policy decided by Peter

- **Area:** `apps/evidence-api`; supersedes the publication blocker in the 2026-10-09 "Step 5: hourly ingestion, exact ports, revisions, release evidence" entry and overrides `product.md` §8.7's ban on first-retrieval time.
- **What:** Peter decided (2026-10-10): when the source gives no publication time, use the time EOX first observed the record; for PortWatch release times, drop the milliseconds by rounding down. The evidence API now serves every fact with `publishedAt` in whole seconds under policy `PUBLICATION/RELEASE-OR-FIRST-OBSERVED/V1`: verified source release time when one exists (`basis: "source-data-edit"`), otherwise the database-stamped `recordedAt` (`basis: "first-observed"`). Stored data is unchanged. Verified on the dev VM at `f01e5f4`: 15,622 of 15,622 facts carry a whole-second `publishedAt`.
- **Rules for agents:** Read `publication.basis` and `publication.policy`; never treat a `first-observed` time as the source's release time. For backfilled history, first observation is the load date, so freshness looks better than it is; use `knownAt` and `revision.sourceEdition` for the source's own dating. Do not round or substitute times anywhere else.
- **Open:** Whether methodology freshness should treat `first-observed` records differently (Peter).
- **Refs:** `apps/evidence-api/README.md`, `packages/ingestion/README.md`, commits `6ff76a2`..`f01e5f4`.

### 2026-10-10 · Joel (Claude Code) · Step 9: live app API on devnet

- **Area:** `apps/app-api`, `packages/app-api`, `deploy/dev`.
- **What:** The app API has a live source behind the same `ReferenceSource` interface as the fixture. An indexer walks the `eox-oracle` registry's finalized transactions, skips failed ones, and keeps a `ReferencePublished` event only when Peter's `ReferenceReader` reads that snapshot as published with the same sequence, epoch and postcommitment. Pairs come from simulating `read_pair` at `finalized`; nothing is signed. Readiness follows the evidence change feed for all 180 pilot slots with the worker's `assertReady` rules. Runs on the dev VM as `eox-app-api-live` at `127.0.0.1:8791`; the fixture stays on 8790. Verified at `39cf5f0`: devnet publications 0, 1, 3 and 4 indexed; the US/JP pair is served from the program; all 180 slots are `missing-assessment`.
- **Rules for agents:** `GET /v1/publications` without `after` now starts at sequence 0, the on-chain baseline; `nextAfter` is `null` until a publication is returned, and `subscribePublications(null, ...)` streams from the start. Readiness never reports `ready` until confidence assessments exist. `configurationDigest` is the on-chain configuration, not the methodology manifest digest. `assertions` stays empty until challenges go through UMA (`SYSTEM.md` §6.3).
- **Open:** The public devnet RPC rate-limits (HTTP 429), so indexing is slow; a dedicated RPC endpoint would fix it. Trading endpoints wait on Peter's step 8.
- **Refs:** `apps/app-api/README.md` (The live source), `deploy/dev/README.md`, commits `2de4e6d`..`39cf5f0`.

### 2026-10-10 · Godwin (Claude Code) · Continuous UMA adapter on main, not yet deployed

- **Area:** `packages/optimistic-oracle/evm`; first part of `product.md` §9 step 7.
- **What:** `EoxContinuousAdapter` implements the EVM side of `product.md` §8.1–8.5 against `packages/oracle/PROTOCOL.md`. Allowlisted asserters post evidence and snapshot claims as full Borsh bytes; the adapter rejects a claim whose context is not this chain, this adapter, the pinned Solana program and registry, and an epoch its owner opened with the same manifest, configuration digest and evidence policy. Every assertion uses 3,600 s liveness and UMA's current minimum bond. A snapshot registers only if each listed evidence assertion was registered here with the same record, evidence, assessment and context; a proposal takes one snapshot and then accepts no more evidence. An identical claim returns its existing assertion ID. Registered, Disputed, Settled and Closed are recorded as relay messages with the per-proposal event number and history; the message bytes are emitted in `RelayMessageRecorded` and only their digest is stored. `publish` sends a recorded message to Wormhole (consistency level 1) and may be repeated. `ContinuousProtocol.sol` is tested byte for byte against `packages/oracle/fixtures/protocol-v1.json`; 65 Foundry tests pass. The deploy script was simulated against Ethereum Sepolia (UMA minimum bond 0.002 WETH, Wormhole chain 10002). Comments were removed from the whole package except SPDX lines, Anchor's `CHECK` and the generated ABI header.
- **Rules for agents:** The yearly `EoxAssertionAdapter` and `eox_settlement_oracle` are unchanged and are not part of the continuous path. Evidence must be asserted with the proposal address and precommitment before its snapshot, so the Solana pre-commitment comes first. Evidence messages carry the header of the proposal they were first registered under; reused evidence emits nothing new. `close` succeeds only when every assertion registered under the proposal and every required assertion has resolved, including for a rejection, so no message follows closure. The dispute ID is `keccak256(abi.encode(chainId, UMA address, assertionId, disputer))`. The adapter's Solana program and registry are immutable: a new program or registry needs a new adapter. Changing `protocol-v1.json` fails `forge test` in this package.
- **Open:** Deployment waits on Peter: he said on 2026-10-10 that the devnet program ID `D1HhP4kVA73bj6c4MfX5yzMZDvQRx5DTRP3xpC2YCe85` will change with the Wormhole receiver, and the adapter needs the new program ID, registry, epoch number, methodology manifest digest, configuration digest and evidence policy hash. Peter then pins the adapter address and Wormhole emitter chain. Joel: signer bindings for `uma-asserter` (`assertEvidence`, `assertSnapshot`, bond-token `approve`) and `evm-relayer` (`close`, `publish`, UMA `settleAssertion`) follow the deployment. Testnet choice (Ethereum Sepolia as in `SYSTEM.md` §7, or Base Sepolia where UMA's minimum bond is 0 and only its TestnetERC20 is whitelisted) is unconfirmed. Each new evidence record is its own bonded UMA assertion, so a first 30-country proposal can need several hundred. The assertion, settlement, challenger and relay services and the Solana delivery are not built yet.
- **Refs:** `packages/optimistic-oracle/README.md` (Deploy the continuous adapter), `packages/optimistic-oracle/evm/src/EoxContinuousAdapter.sol`, commits `1e7891b`..`58b5fc6`.

### 2026-10-10 · Godwin (Claude Code) · UMA assertion and relay service; SDK removed

- **Area:** new `apps/uma-relay`; `packages/optimistic-oracle` (SDK removed); second part of `product.md` §9 step 7.
- **What:** `apps/uma-relay` is the service that operates `EoxContinuousAdapter`. It posts claims on request: `POST /v1/assertions/evidence` (`proposal`, `precommitment`, `claim`) and `POST /v1/assertions/snapshot` (`claim`), each returning `assertionId`, `claimDigest` and `created` under schema `eox.uma-relay/v1`. Callers present a Google identity token for a service account listed in `ASSERTION_CALLERS`. A repeated claim returns its existing assertion and pays no second bond; a claim the adapter would refuse is not sent and returns 422 `CLAIM_REJECTED` with the adapter's error name; a wallet that cannot cover one bond returns 503 `UNDERFUNDED`. Each tick it also settles expired assertions on UMA, closes proposals whose assertions have all resolved and publishes recorded messages to Wormhole, simulating every transaction first and reconciling in-flight transactions from a durable state file after a restart. It signs only through `@eox/signing`: `uma-asserter` for claims and bond-token approvals (16 bonds at a time), `evm-relayer` for the rest. `packages/optimistic-oracle/sdk` is deleted: it only covered the yearly adapter and nothing imported it. Supersedes the statement in the 2026-10-10 "Continuous UMA adapter on main, not yet deployed" entry that the assertion, settlement and relay services are not built. 29 service tests and 65 Foundry tests pass; the service tests post claims built with `@eox/oracle-worker/protocol`.
- **Rules for agents:** The worker requests assertions from this service and does not hold `uma-asserter`: evidence first, then the snapshot carrying the returned IDs. There is no shared client for the adapter; write calls from its interface and events. The remote-signer wiring that `product.md` §8.14 points to at `packages/optimistic-oracle/sdk/src/evm.ts` is now `apps/uma-relay/src/remote-sender.ts`. The service never holds a private key; tests use local Anvil keys behind the same `Sender` interface.
- **Open:** Nothing here has run against the real signer or a testnet: it needs the deployed adapter, which still waits on Peter's new program ID. Joel: one service account for this service as a caller with `uma-asserter` (adapter `assertEvidence`, `assertSnapshot`; bond-token `approve`) and `evm-relayer` (adapter `close`, `publish`; UMA `settleAssertion`), and a place to run it on Google Cloud. Peter: the worker's service account email for `ASSERTION_CALLERS`. Not built: fetching the signed Wormhole message and delivering it to the Solana receiver, and the challenger.
- **Refs:** `apps/uma-relay/README.md`, commits `28323a6`..`4cd4c08`.

### 2026-10-10 · Godwin (Claude Code) · UMA challenger added, watch-only by default

- **Area:** `apps/uma-relay`; third part of `product.md` §9 step 7.
- **What:** The challenger is a second process in `apps/uma-relay` (`pnpm --filter @eox/uma-relay challenger`) that signs with the `uma-challenger` key through `@eox/signing`. Each tick it reads new evidence claims from the adapter's events, decodes them with the shared protocol encoding and checks that the claim's source record and every source artifact exist in Joel's evidence API with matching hashes. It reports a verdict per claim and disputes on UMA only when `CHALLENGER_DISPUTE=true`. It keeps its cursor and verdicts in its own state file. Supersedes the statement in the 2026-10-10 "UMA assertion and relay service; SDK removed" entry that the challenger is not built. 48 service tests pass, including a run against the adapter on Anvil.
- **Rules for agents:** A claim the challenger reports as supported has only had its record and artifacts checked; that is not a check of the claim's evidence digest, metadata digest or assessment. Snapshot claims are not checked at all. Do not describe either as verified by the challenger. Give the relay and the challenger different state files. Peter's independent checker uses the separate `oracle-checker` key, not `uma-challenger`.
- **Open:** Peter: where a challenger can fetch the confidence assessment manifest behind a claim's `assessment_digest`, and whether that digest is `compileConfidence`'s `manifestDigest`; the digest check needs the eight ratings and no assessments exist yet. Joel: a caller entry for the challenger's service account with `uma-challenger` (UMA `disputeAssertion`, bond-token `approve`). Still not built: delivering the signed Wormhole message to the Solana receiver.
- **Refs:** `apps/uma-relay/README.md` (Challenging), commits `b2396e9`..`137c868`.

### 2026-10-09 · Peter (Codex) · Authenticated receiver foundations in progress

- **Area:** `packages/oracle/crates/math`, CLI verification tests.
- **What:** Added bounded streaming commitment hashing and strict continuous posted-VAA decoding/identity checks. Rust tests cover shared vectors, malformed proofs, restart/padding boundaries and maximum-roster claim streaming. These are unwired library helpers; the Solana acceptance path is unchanged.
- **Rules for agents:** This work belongs to product step 6, correcting the informal "task 2" receiver label in the earlier Task 1 entry. Do not describe it as a completed authenticated receiver. The instruction must derive proof ownership from AccountInfo and settings from pinned program-owned accounts, never caller-supplied claims. Injected proof tests are not guardian-verification evidence. No live publication-time policy was changed.
- **Open:** Companion accounts, staged binding validation, assertion/receipt lifecycle, closure gate, worker recovery, IDL and compiled-program verification remain. Parallel implementation agents hit the service usage limit before making changes.
- **Refs:** `packages/oracle/RECEIVER.md`.

### 2026-10-10 · Peter (Codex) · Publication-time admission approved

- **Area:** `product.md` version 8, oracle-worker admission and evidence encoding.
- **What:** Peter explicitly approved OECD/BIS first-observed time when source publication time is missing, and dropping PortWatch milliseconds with floor-to-seconds conversion. `EOX/PUBLICATION/V2` now applies in worker readiness and Rust input adaptation; time basis is committed in metadata. Source-value precision remains unchanged.
- **Rules for agents:** Joel supplies immutable database `recordedAt` for OECD/BIS; later polls must not reset it. PortWatch uses `floor(releasedAtMs / 1000)`; retaining the milliseconds is not an additional admission requirement. Godwin validates the same policy. These decisions supersede the strict timestamp-admission requirements in the 2026-10-09 Explicit assertion relay and admission contract entry and resolve the time-specific blockers in Joel's 2026-10-09 Step 5 entry. Do not keep asking Peter to reconfirm these decisions.
- **Open:** Live adapter, confidence assessments and economic calibration remain separate deliverables; this change does not claim all source slots are live.
- **Refs:** `product.md` §8.7, `apps/oracle-worker/src/publication.ts`, `apps/oracle-worker/test/publication.test.ts`.

### 2026-10-10 · Peter (Codex) · COX Paper 3 draft

- **Area:** `docs/cox`, `output/pdf/cox_paper_3.pdf`.
- **What:** Produced a standalone 22-page Crypto Outlook Index product/system draft from Peter's price-only direction: shared CRYPTO reference, one-minute publications, next-publication execution and continuous closed-collateral participation. Includes equations, diagrams, worked accounting and source references. Arithmetic, links and rendered layout checked; two independent reviews completed.
- **Rules for agents:** This is a review draft, not a deployed mechanism or an amendment to EOX `SYSTEM.md`. Do not introduce fundamentals, market-cap growth, volume scoring, mandatory terminal epochs or a signal multiplier. Preserve the distinction between COX reference and redeemable value; the illustrative normalized transfer formula is not selected and its common benchmark cancels.
- **Open:** Benchmark policy, final transfer rule, holdable CRYPTO rights, source/cutoff rules, exceptional states and production proofs.
- **Refs:** `docs/cox/cox-paper-3.md`, `docs/cox/build_pdf.py`, `docs/cox/verification.json`; EOX Paper 3 and RPM Paper 1 in `docs/papers`.

### 2026-10-10 · Peter (Claude Code) · Pivot from EOX to COX: SYSTEM.md v2 and product.md v9

- **Area:** `SYSTEM.md` (version 2), `product.md` (version 9); no code changed.
- **What:** At Peter's request, rewrote both documents for COX (`docs/cox/cox-paper-3.md`). `SYSTEM.md` v2 is the COX engineering contract: Pyth prices via an archived Hermes update per one-minute cutoff, one `cox` Solana program (CRYPTO, references, closed-pool revaluation, batch execution), test collateral, no UMA/EVM/Wormhole relay of our own, independent monitor. `product.md` v9 assigns every existing EOX component to one owner as preserve, carry over or delete, lists new tasks J1–J5, P0–P5, G1–G4, and gives the execution order to the devnet MVP.
- **Rules for agents:** Supersedes every earlier entry's rules about UMA assertions, Wormhole relay, the continuous and annual adapters, economic indicators, publication-time policies, confidence assessments and the exchange equations; those components are being deleted. Do not delete code until Peter has pushed the `eox-archive` tag. `COX/TRANSFER/MVP-0` is a test mechanism, not the production transfer rule. SYSTEM.md v2 items are PROPOSED until its §13 sign-off.
- **Open:** All §13 sign-offs. Hermes update endpoints returned `unauthorized` without an API key on 2026-10-10 (Joel). ZEC admission depends on Joel's feed check.
- **Refs:** `SYSTEM.md`, `product.md`, `docs/cox/cox-paper-3.md`; EOX versions in git history.

### 2026-10-10 · Peter (Claude Code) · COX pilot roster expanded to 30 assets

- **Area:** `SYSTEM.md` version 2.1 (§4.1, §5.2, §7.1, §13), `product.md` version 9 (§3, J1, P3, §8, §9).
- **What:** At Peter's request, the pilot roster grows from BTC/ETH/SOL (+ZEC) to 30 non-stablecoin assets with Pyth `Crypto.<ASSET>/USD` feeds, listed with full feed ids and a canonical order in `SYSTEM.md` §4.1 (read from the Hermes feed catalogue on 2026-10-10). Stablecoins, other pegged tokens, wrapped/bridged/liquid-staking duplicates and STARK are excluded. Publications are now staged in three pages of 10 price accounts before `publish`; the pool has 31 classes. Supersedes the roster and ZEC-only feed check in the earlier 2026-10-10 "Pivot from EOX to COX" entry.
- **Rules for agents:** Use the asset order in §4.1 everywhere. An asset failing Joel's 30-day feed check is dropped, not substituted; label CRYPTO with the sealed N. Adding or replacing an asset after sealing needs a new methodology version.
- **Open:** Joel's feed check for all 30 assets (needs the Hermes API key); Peter's measurement of whether staging and publishing for 30 assets fits the 45-second deadline and the compute limit.
- **Refs:** `SYSTEM.md` §4.1 and §5.2, `product.md` J1, P3 and §9.

### 2026-10-10 · Peter (Claude Code) · COX prices from Kraken; modern-token roster

- **Area:** `SYSTEM.md` version 2.2, `product.md` version 10; no code changed.
- **What:** At Peter's request, Pyth is dropped (Hermes needs a paid key) and Kraken's public REST one-minute OHLC candles are the only price source for the devnet MVP. The price for batch `k` is the close of the final candle with `time = cutoff − 60`; Kraken empty minutes carry the last trade price with `count = 0`, so each price carries a trade age, and above 30 minutes the minute is inadmissible. The publisher's `oracle-operator` key attests each snapshot; the program checks it deterministically and the monitor re-fetches Kraken to verify. Peter removed DOGE, ADA, LINK, LTC, TON, BCH, XLM, ATOM, HBAR, ETC, FIL, XMR and ICP; they are replaced by STRK, HYPE, TAO, WLD, ONDO, ENA, ZRO, FET, JUP, AERO, RENDER, TIA and W (most-traded newer tokens on Kraken USD). Supersedes the Pyth feed ids, staging pages and Hermes blocker in the earlier 2026-10-10 "COX pilot roster expanded to 30 assets" entry.
- **Rules for agents:** Do not describe Kraken prices as independently verified; they are operator-attested and devnet-only. Use the asset order and Kraken pair names in `SYSTEM.md` §4.1. Never fill a missing candle or loosen the trade-age bound to keep a thin asset; drop it before sealing instead.
- **Open:** Joel's 7-day feed check (APT is the main risk: 58% empty minutes on 2026-10-10). Peter confirms STRK is the Paper 3 "STARK". Kraken data terms before any public launch.
- **Refs:** `SYSTEM.md` §2, §3.1–3.2, §4.1, §5.2, §6.3, §9; `product.md` J1, J2, P3, P4, G2, §9.

### 2026-10-10 · Peter (Claude Code) · Exchange fallback and the price-feeds package

- **Area:** `SYSTEM.md` version 2.3 (§3.1, §3.2, §4.1, §5, §6, §9, §10.1), `product.md` version 11 (new task J0, J1, G2, §9); no code changed.
- **What:** At Peter's request, Coinbase and Bybit are fallbacks used only when Kraken's cutoff minute has no trade, in the fixed order Kraken → Coinbase → Bybit (`COX/PRICE-FALLBACK/V1`); no venue prices are averaged. Bybit quotes USDT and is converted with the same cutoff's USDT/USD price (`COX/USDT-USD/V1`). All on-chain prices are USD × 10⁸. Measured over 300 minutes on 2026-10-10, the fallback cut asset-minutes without a trade from about 5 per minute to 0.6% (RENDER and TAO weakest). Joel owns a new `packages/price-feeds` (J0): venue adapters, the Kraken WebSocket as the primary feed, one rate limiter per venue at no more than half the published limit, backoff, circuit breaker and cache. It is the only code allowed to call an exchange. Supersedes the Kraken-only price rule in the earlier 2026-10-10 "COX prices from Kraken; modern-token roster" entry.
- **Rules for agents:** Call exchanges only through `packages/price-feeds`. Never raise a venue budget above `SYSTEM.md` §10.1. Do not use a proxy or VPN to reach Bybit.
- **Open:** Joel confirms Bybit is reachable from the US-region dev VM and permitted by its terms; without it TRX and JUP have no fallback. Venue data terms before any public launch.
- **Refs:** `SYSTEM.md` §3.2 and §10.1; `product.md` J0, J1, G2.

### 2026-10-10 · Peter (Codex) · P0 EOX archive tag pushed

- **Area:** Git archive boundary for the COX pivot.
- **What:** At Peter's request, created and pushed annotated tag `eox-archive` at verified `origin/main` commit `2c0a3aaca7ee4dece134a9fb1c06634a8aa21fcf`. Verified the remote tag resolves to that commit.
- **Rules for agents:** P0 is complete; the archive prerequisite for the individually assigned COX deletions is satisfied. Preserve this tag.
- **Refs:** `eox-archive`, `product.md` P0 and section 8 step 0.

### 2026-10-10 · Peter (Codex) · P1 COX specification and provisional vectors

- **Area:** `packages/cox/SPEC.md`, `packages/cox/fixtures`, `packages/cox-methodology`.
- **What:** Added the P1 draft: canonical methodology/price/snapshot encodings, provisional roster, integer reference/MVP-0/accounting rules, lifecycle and draft ABI. Twelve Node tests and twelve independent byte/math/ledger checks pass. Exact Paper 3 accounting assigns rounding dust to pool residual rather than hiding it in backing.
- **Rules for agents:** The manifest is unsealed; do not fabricate Joel's feed-check result or a common origin. Bybit is disabled pending its access decision. P1 TypeScript is specification tooling, not the P2 Rust crate or independent monitor. Keep reference and claim value distinct. No EOX deletion or deployment occurred.
- **Open:** SYSTEM §3.3 requires full commit by +55 seconds, while product P3 allows later execution cranks. SPEC §1 proposes reversible staging plus finalize/abort; Peter must review this resolution before P3. P2 arithmetic parity/simulations and P3 runtime/ABI verification remain required.
- **Refs:** `packages/cox/SPEC.md`, `packages/cox/fixtures/verification.json`, `packages/cox-methodology/README.md`; SYSTEM.md and product.md unchanged.

### 2026-10-10 · Peter (Codex) · Next-publication eligibility without a fill deadline

- **Area:** `SYSTEM.md` v2.4, `product.md` v12, COX P1 specification, manifest and vectors.
- **What:** Peter replaced the proposed all-trades-by-deadline rule: requests become eligible from the next valid publication, never when created; filling has no hard deadline. Snapshot acceptance retains +55 seconds. Accepted work continues at fixed values until complete and blocks the next publication. Servers/workers must be provisioned and load-tested for the supported workload within a minute; this is an operating capacity target.
- **Rules for agents:** Do not cancel, roll or reprice an accepted batch because execution is slow. Evaluate expiry against its accepted batch, not eventual fill time. The 30-asset list is the P1 roster; Joel owns feed validation, not Peter. This supersedes the pending staging/deadline review described in the earlier P1 entry. Other SYSTEM sign-offs remain pending; none are invented.
- **Open:** P2 parity and P3 runtime/capacity verification; Joel's separately assigned feed check. No deployment or commit performed.
- **Refs:** `packages/cox/SPEC.md` sections 1 and 7, `SYSTEM.md` section 3.3, `product.md` section 4.

### 2026-10-10 · Peter (Codex) · P2 COX math, CLI and simulations

- **Area:** `packages/cox` Rust workspace, fixtures, research and results.
- **What:** Implemented independent checked Rust reference/MVP-0/fixed-value flow arithmetic, pure custody ledger transitions, strict JSON CLI and price/snapshot encoders. All nine P1 arithmetic and three wire vectors match. Nineteen Rust tests, thirteen methodology tests, strict Clippy and formatting pass; simulations cover 2,880 thirty-asset publications, 6,200 round trips, 1,410 split comparisons and a 3,100-request full exit.
- **Rules for agents:** Use `cox-math` for P3 calculations. Preserve bound publication values across slow execution; no fill deadline. Enforce supported-state products before accepting resulting balances: storage widths alone do not guarantee arithmetic safety. Residual remains outside active backing; tiny operations can erode backing into residual despite no tested user extraction. These are finite synthetic devnet-mechanism checks, not production approval.
- **Open:** P3 ownership/lifecycle, atomic execution, conservative admission and runtime capacity. Product step 10 schedules Peter's EOX deletions after P3; current Joel/Godwin callers still import them, so no premature deletions were made. P1's referenced SPEC.md is absent from commit 7810e09; P2 documents exact implemented rules in its README. An unrelated root `spec.md` appeared during work and was left untouched.
- **Refs:** `packages/cox/README.md`, `packages/cox/results/verification.json`, `packages/cox/research/deletion-audit.md`, `packages/cox/research/simulation-methods.md`.

### 2026-10-10 · Godwin (Claude Code) · G1 done: EVM/UMA stack removed

- **Area:** `packages/optimistic-oracle` (deleted), `apps/uma-relay` (deleted), new `apps/cox-monitor`.
- **What:** `product.md` task G1, done on branch `dev` after Peter pushed the `eox-archive` tag. Deleted the yearly and continuous EVM adapters, `ContinuousProtocol`, the deploy script, the 65 Foundry tests, the two Foundry submodules and `.gitmodules`, the yearly `eox_settlement_oracle` program, and the UMA assertion, relay and challenger service with its tests. The yearly `EoxAssertionAdapter` on Ethereum Sepolia at `0x06a14d49f977898db03fffff699ad15b2aceece4` is abandoned in place; the continuous adapter was never deployed. Carried into `apps/cox-monitor/src`: `env.ts` (without the identity-token helper), `state-file.ts` and `evidence-source.ts` reduced to the `/v1/artifacts/:sha256` hash check. `pnpm -r build` passes for all 11 packages.
- **Rules for agents:** The deleted code is at the `eox-archive` tag only. The challenger's tick-and-cursor loop was not moved because it imports the deleted UMA code; G2 rewrites it for COX from the archive. `apps/cox-monitor` is only these three helper files so far and is not a monitor yet.
- **Open:** `pnpm -r test` does not pass on Godwin's machine for reasons outside this change: `evidence-store`, `ingestion` and `evidence-api` need the local Postgres on port 5433, and `apps/app-api` "fixture provenance" fails because `fixtures/oracle-preview.json` no longer matches `packages/oracle/fixtures` (Joel). Signing, methodology, oracle-worker and signer tests pass. Peter still deletes `packages/oracle/fixtures/protocol-v1.json`; Joel still retires the `uma-asserter`, `uma-challenger` and `evm-relayer` signer roles.
- **Refs:** commits `65f0a50`..`0427ac2`; `product.md` §6.3 and §7.3.

### 2026-10-10 · Joel (Claude Code) · Dev VM moved to the EU

- **Area:** `deploy/dev`, GCP project `colosseum-eox`.
- **What:** Bybit's API refused the US-region dev VM (HTTP 403, CloudFront country block); the team is in Nigeria, which is not a Bybit-restricted jurisdiction. The VM `eox-dev` was stopped, snapshotted (`eox-dev-move-20261010`) and recreated from that snapshot in `europe-west1-b`, same machine type and service account. Verified after the move: 15,622 observations, 76 payloads with valid hashes, 9 migrations and commit `5c8b5a1`, as before; evidence API and both app APIs healthy; cron restored; a backup uploaded to `gs://colosseum-eox-db-backups`; Bybit, Kraken and Coinbase all return 200. External IP is now `104.155.21.77`.
- **Rules for agents:** Address the VM as `eox-dev` in zone `europe-west1-b` (the `deploy.sh` default). The stopped `eox-dev` in `us-central1-a` and the snapshot are kept until the EU VM has run cleanly; never start the old one alongside the new one. Bybit is reached directly, with no proxy or VPN, as `SYSTEM.md` §10.1 requires.
- **Open:** Delete the old US VM and the snapshot after a few days of clean running (Joel). Bybit's terms of use before any public launch.
- **Refs:** `deploy/dev/README.md`, `deploy/dev/deploy.sh`.

### 2026-10-10 · Joel (Claude Code) · COX price evidence: price-feeds, archiver and tables live on dev VM

- **Area:** new `packages/price-feeds`; `packages/evidence-store` (migration `010`), `packages/ingestion/src/cox`, `packages/app-api` (COX schema), `deploy/dev`. `dev` and `feat/cox-price-evidence` merged into `main` at `dbf625c` on Joel's instruction.
- **What:** J0 and J1 of `product.md` v11. `@eox/price-feeds` is the only code that calls an exchange: Kraken WebSocket `ohlc` with gap tracking and REST repair, Coinbase and Bybit REST, budgets at or below `SYSTEM.md` §10.1, backoff, breaker, cache, `COX/PRICE-FALLBACK/V1` with every attempt's evidence, exact USD × 10⁸ (`COX/USDT-USD/V1` for Bybit), `verifyRange` for the monitor and a daily listing watch. Migration `010` adds `assets`, `venue_responses`, `venue_attempts`, `price_observations`, `snapshots` (commit-safe change feed) and `incidents`, all append-only. systemd `cox-archiver` on `eox-dev` archives every cutoff for the 30 assets 6 s after the minute; verified at `dba88d8`: all 30 priced in 2–4 s per minute, 0 rate limits. The 7-day feed check started 2026-10-10 20:33 UTC; `pnpm --filter @eox/ingestion cox:feed-check 7` prints it.
- **Rules for agents:** Call exchanges only through `@eox/price-feeds` and give each process its own `VenueClient` per venue. Never edit migration `010`; schema changes are new migrations. Read prices from `price_observations.price_e8` with `venue`, `step` and `trade_age_minutes`; a snapshot is usable only when `snapshots.admissible`. The first two to four cutoffs after an archiver restart are late (the WebSocket must cover a whole minute first) and are recorded inadmissible, not filled.
- **Open:** Peter: the byte encoding of the `COX/PRICE/V1` and `COX/SNAPSHOT/V1` digests; `packages/ingestion/src/cox/digest.ts` uses a provisional little-endian layout (asset id length-prefixed, venue code kraken 0 / coinbase 1 / bybit 2, step, i64 candle start, presence byte plus i64 `price_e8`, u32 trade age; snapshot = cutoff i64, count u32, ordered price digests) until P1 pins it. Peter: whether `dev` should now follow `main`. Joel: J2 price routes on the evidence API; the 7-day report on 2026-10-17. Bybit's terms of use before any public launch.
- **Refs:** `packages/price-feeds/README.md`, `packages/ingestion/README.md` (COX price archiver), commits `d2d4e7b`..`dba88d8`.

### 2026-10-10 · Joel (Claude Code) · COX price routes on the evidence API (J2)

- **Area:** `apps/evidence-api`, `packages/ingestion/src/cox/feed-check.ts`.
- **What:** `product.md` J2, deployed at `daf4cb4` on `127.0.0.1:8787`. `GET /v1/prices/cutoffs/:cutoff` serves one archived cutoff: the snapshot digest and admissibility, then per asset in canonical order every fallback attempt and the chosen price (venue, step, candle, close text, `priceE8`, trade evidence and age, USDT/USD for Bybit) with artifact digests, plus the USDT attempts and incidents. `GET /v1/prices/changes?after=&limit=` lists archived cutoffs in commit order with an opaque resumable cursor. Verified on the VM: the latest cutoff served 30 assets and all 30 linked artifacts matched their SHA-256. The feed check now excludes cutoffs the archiver itself finished late (restarts, deploys) and reports them separately.
- **Rules for agents:** The publisher and the monitor read prices through these routes, never the database. A cutoff returns 404 until its snapshot is written; do not poll the tables to get it earlier. Use only snapshots with `admissible: true` for publication. Each archiver restart makes two to four cutoffs late and inadmissible.
- **Open:** EOX routes (`/v1/changes`, `/v1/records/...`) stay until the `eox-archive` tag exists. Snapshot digest encoding still waits on Peter's P1.
- **Refs:** `apps/evidence-api/README.md` (COX prices), commits `bb63d8c`, `daf4cb4`.

### 2026-10-10 · Godwin (Claude Code) · Monitor maths matches the P1 vectors; SPEC.md committed

- **Area:** `apps/cox-monitor`, `packages/cox/SPEC.md`.
- **What:** First part of `product.md` G2. `apps/cox-monitor/src` now has an independent TypeScript implementation of SPEC §4 (references), §5 (MVP-0 revaluation), §6 (fixed-value batch flows and residual) and the §3 price and snapshot encodings and digests. It does not import `@cox/methodology`. 25 tests pass: all 9 cases and the wire bytes in `packages/cox/fixtures/vectors.json`, plus order independence, conservation, vault equality and rejected inputs. `packages/cox/SPEC.md` is Peter's version 0.2 draft, committed unchanged by Godwin because earlier entries and the methodology README referenced a file that was not in the repo.
- **Rules for agents:** This is the maths only. The monitor does not yet read publications, fetch archived snapshots, re-fetch venues or serve verdicts, so do not describe a monitor as running. The rounding order was learned from Peter's `vectors.ts` before SPEC.md was available, so agreement with the vectors is not a fully blind second derivation. A change to `vectors.json` fails `pnpm --filter @eox/cox-monitor test`.
- **Open:** Peter: vectors for the SPEC §3 receipt root and state digest; the monitor will not implement either without bytes to check against. Joel: the archiver's provisional price and snapshot digest layout differs from SPEC §3 (`COX/WIRE/V1`), so the monitor would report his current digests as mismatches. The live half of G2 waits on P3.
- **Refs:** commits `1699666`..`fca926b`, `463f29a`; `packages/cox/SPEC.md` §3–6.

### 2026-10-10 · Joel (Claude Code) · Archiver digests now COX/WIRE/V1

- **Area:** `packages/ingestion/src/cox`, `packages/price-feeds`, `packages/evidence-store` (migration `011`), `apps/evidence-api`. Answers the digest mismatch raised in Godwin's 2026-10-10 "Monitor maths matches the P1 vectors" entry and supersedes the provisional layout in Joel's 2026-10-10 "COX price evidence" entry.
- **What:** Price and snapshot digests follow `packages/cox/SPEC.md` §3 and reproduce the P1 wire vectors byte for byte. Kraken and Coinbase closes must match SPEC §2's pattern and fit u64 (a ninth decimal is refused even when zero). A digest is written only for a complete admissible snapshot; inadmissible snapshots have none. Migration `011` adds `snapshots.digest_encoding`. Deployed at `3559f2e`; the first `COX/WIRE/V1` snapshot is cutoff `1791668220`. Recomputing that live snapshot with Peter's `@cox/methodology` encoder gave the same digest, and `exactUsd`/`bybitUsd` agreed on all 30 prices.
- **Rules for agents:** Compare only snapshots with `digestEncoding: "COX/WIRE/V1"`. Snapshots up to cutoff `1791668100` carry an unlabelled provisional digest; the monitor must skip or flag them, never report them as mismatches of the wire format.
- **Open:** Peter: the draft manifest disables Bybit, but the archiver uses it (the dev VM now runs in `europe-west1-b`, where Bybit returns 200; the team is not in a restricted jurisdiction). Under that manifest a Bybit step-3 price would be invalid, so decide Bybit on or off before sealing. `dev` is not merged into `main` yet.
- **Refs:** `packages/ingestion/test/cox-digest.test.ts`, commits `6c710e7`..`3559f2e`.

### 2026-10-10 · Joel (Claude Code) · dev merged into main

- **Area:** whole repository; `apps/web/package.json`, `pnpm-lock.yaml`.
- **What:** On the team's go-ahead, merged `origin/dev` (P1 spec and vectors, `@cox/methodology`, `apps/cox-monitor` maths, `apps/web`, the EVM/UMA removal) into `main` at `3012698` and deployed `b42e455` to the dev VM; all services and the archiver run normally. `lucide-react@1.55.0` (published 2026-10-10) failed pnpm's minimum release age, so `apps/web` now uses `^1.54.0`, locked at 1.54.0 with its registry integrity (`b42e455`). On `main` every evidence, ingestion, price-feeds, app-api, methodology, monitor, signer and signing test passes and every package builds; the EOX `oracle-worker` journal tests still fail only on Windows (`EPERM` on directory fsync), as recorded on 2026-10-08.
- **Rules for agents:** Work from `main`; `dev` is now behind it. Never bypass the release-age policy: pin to the previous release instead.
- **Open:** Peter: Bybit on or off in the manifest; whether `dev` is kept or retired.
- **Refs:** commits `3012698`, `b42e455`.

### 2026-10-10 · Joel (Claude Code) · J3: cox.app-api/v1 with a P1-oracle fixture; Bybit stays on

- **Area:** `packages/app-api` (COX schema and client), `apps/app-api` (`src/cox`, `scripts`, `fixtures/cox-fixture.json`), `deploy/dev`.
- **What:** `product.md` J3. `cox.app-api/v1` follows `packages/cox/SPEC.md`: publication sequence and scheduled batch are separate (missed batches listed), classes report pre-revaluation, fixed and final state with their transfer factor, the ledger separates active, pending, refundable, payable and residual, and receipts and request states follow SPEC §8. `APP_API_SOURCE=cox-fixture` serves deployment, status, assets, CRYPTO, publications (latest, by sequence, paged, SSE) and wallet portfolios. The fixture is generated by Peter's oracle (`reference`, `revalue`, `batch` in `packages/cox-methodology/src/vectors.ts`) over one connected timeline of two synthetic assets and CRYPTO, and its vault reconciles at every publication; a test fails if it differs from the oracle's output. Deployed at `d99a85e` as systemd `cox-app-api` on `127.0.0.1:8790`, replacing the EOX fixture service `eox-app-api`. **Decision (Joel, 2026-10-10): Bybit stays on** for the archiver and the manifest.
- **Rules for agents:** Godwin: point the web app at `createCoxApiClient` and `APP_API_SOURCE=cox-fixture` instead of `apps/web/src/lib/sample.ts`. Fixture assets are `SYNA`/`SYNB` with synthetic prices and wallets; never present them as market data. The API computes no reference or claim value. Transaction builders and quotes wait for the P3 IDL.
- **Open:** Peter: switch Bybit on in `manifest.draft.json` before sealing (the draft disables it). The live COX source (J5) waits on P3. `eox-app-api-live` (port 8791) still indexes the retired EOX devnet program and goes with the other EOX deletions.
- **Refs:** `apps/app-api/README.md` (COX), commits `1379114`..`d99a85e`.

### 2026-10-10 · Joel (Claude Code) · EOX code removed from Joel's area

- **Area:** `packages/ingestion`, `packages/evidence-store`, `apps/evidence-api`, `apps/app-api`, `packages/app-api`, `deploy/dev`, `postman`.
- **What:** `product.md` §6.1 deletions after the `eox-archive` tag. Removed:
  - the hourly EOX ingests and their cron;
  - the OECD/BIS/PortWatch/SDMX pipelines;
  - the EOX observation write/query paths in `evidence-store`;
  - the evidence API's `/v1/changes` and `/v1/records/...` routes;
  - the EOX reference API, devnet indexer, Rust fixture generator and `eox.app-api/v1` schema;
  - the `eox-app-api-live` service;
  - the EOX Postman collection.

  Deployed at `dd93bf7`. The VM runs only `cox-archiver`, `eox-evidence-api` and `cox-app-api`, with the backup job as the only cron. EOX tables and their 15,622 observations stay read-only in the database, still guarded by the append-only triggers (tested). Every remaining package builds, and all of Joel's suites pass.
- **Rules for agents:** EOX code is only at the `eox-archive` tag. `apps/app-api/fixtures/oracle-preview.json` is kept only because `apps/oracle-worker/test/reference-readers.test.ts` reads it; delete it together with the oracle worker. The `apps/oracle-worker` journal tests still fail only on Windows (`EPERM` on directory fsync), unrelated to these deletions.
- **Open:** Retiring the EVM signer path and the unused roles (`uma-asserter`, `uma-challenger`, `oracle-checker`, `evm-relayer`, `solana-relayer`) is part of J4, after P3. No exchange Postman collection replaces the EOX one; `@eox/price-feeds` tests use recorded responses instead.
- **Refs:** commits `0fdf728`..`dd93bf7`.

### 2026-10-10 · Peter (Codex) · P3 compiled COX program and integration artifacts

- **Area:** `packages/cox`, `packages/cox-client`.
- **What:** Implemented the Anchor 0.31.1 program with P2 math, real SPL custody, future-publication reservations, persistent evaluation/safety/preparation cursors and atomic lazy finalization. Final compiled SBF passes 15 lifecycle/custody tests; the generated-IDL client passes nine tests. Thirty-price publication measures 1,122 bytes (1,218 with separate payer) and 520,154 compute units. Integration files include actual account fixtures, receipt/state vectors and prepared signer allowlist.
- **Rules for agents:** Use SPEC v0.3's actual ABI appendix and generated IDL. P1 price hashes remain authoritative; Joel's provisional archive layout differs as documented in INTEGRATION.md. Only publish needs runtime authority on chain; the prepared service allowlist includes permissionless batch cranks for fee sponsorship. No local KMS role key exists. The reserved program identity is not proof of deployment; keep the live pool inactive.
- **Open:** Peter's commit approval, integration onto `origin/main`, devnet deployment funding and verified deployed build. P4 worker and live activation remain separate. Local timing is not blockchain throughput.
- **Refs:** `packages/cox/results/p3-verification.md`, `packages/cox/INTEGRATION.md`, `packages/cox/deploy/README.md`, `packages/cox/P3-PLAN.md`.

### 2026-10-10 · Peter (Codex) · Verified Peter-owned EOX cleanup prepared

- **Area:** `packages/oracle`, `apps/oracle-worker`, root package scripts.
- **What:** After compiled COX replacement verification, removed the retired EOX program, receiver/protocol modules and fixtures, proposal worker and obsolete tests/entry points. Narrowed the old Rust workspace. Retained economic Rust tests pass (24), worker tests pass (14) and worker type checking passes. Cleanup remains uncommitted and must be a separate change from COX implementation.
- **Rules for agents:** Preserve Joel's legacy reference reader/IDL and economic fixture generator dependencies, methodology facts/readiness and the complete worker journal/retry/transport closure until P4 replaces it. Preserve papers, ignored sealed research and `eox-archive`. Do not modify another owner's callers to force deletion. The old deployed program is abandoned in place.
- **Open:** Recheck legacy callers after integration with `origin/main`; retire remaining carry-over only when replacements land.
- **Refs:** `packages/cox/research/deletion-audit.md`, `packages/cox/INTEGRATION.md`; supersedes the P2 deletion inventory's retired caller descriptions.

### 2026-10-11 · Peter (Codex) · COX deployment tooling and branch policy

- **Area:** `packages/cox/scripts`, deployment instructions.
- **What:** Peter explicitly allowed deployment from any branch and requested TypeScript/shell/Rust tooling. `deployment.ts` runs directly with Node.js 24 built-ins; there is no Python deployment helper or remote-main ancestry gate. The helper verifies the exact approved commit/build, network and authority identities.
- **Rules for agents:** Do not impose a main-branch deployment restriction or introduce Python for this COX workflow. This supersedes the deployment restriction in the 2026-10-06 Data layer state and repo conventions entry and the main-integration prerequisite in the 2026-10-10 P3 entry. Shared-push fetch/rebase rules remain separate.
- **Refs:** `packages/cox/scripts/deployment.ts`, `packages/cox/deploy/README.md`.

### 2026-10-11 · Peter (Codex) · COX program deployed and verified on devnet

- **Area:** COX program, deployment record and integration handoff.
- **What:** Following Peter's commit approval and 10 devnet SOL funding, rebuilt commit `70700b74c81c373591e3150ff1573ad61cce1dbf`; all 15 compiled lifecycle/custody and nine client tests passed again. Deployed program `G6iQGoupNSfduw1QJxQ9vcVi9FnCC6cbippXsi4QQzJF` at finalized slot 509739184. Downloaded executable exactly matches SHA-256 `16a778aa7dd2f3cae0d16577626a1393f02323ea8fb622963b29d63ea851be07`; separate upgrade authority verified. CLI verification now uses the dedicated wallet explicitly instead of requiring a default wallet.
- **Rules for agents:** Use the verified record and actual IDL/readers/builders/vectors for integration. No registry, methodology, collateral mint or live pool was initialized. Live activation, signer binding and P4 publisher remain separate. Never create a local KMS runtime key. This supersedes the pending-deployment status in the 2026-10-10 P3 entry. Peter's commit `34662df` included implementation and EOX cleanup together, superseding the uncommitted cleanup status in that day's cleanup entry.
- **Open:** P4 publisher; Joel's authoritative archive-byte correction, feed check and signer binding; Godwin's monitor/UI integration. Legacy readers/math and P4 transport closure remain retained.
- **Refs:** `packages/cox/deploy/deployed-devnet.json`, `packages/cox/INTEGRATION.md`, `packages/cox/results/p3-verification.md`.

### 2026-10-11 · Peter (Codex) · P4 publisher locally verified, runtime disabled

- **Area:** `apps/cox-publisher`, `deploy/dev/cox-publisher.service`, workspace lockfile, COX integration handoff.
- **What:** Implemented exact P1 archive admission, all persistent batch phases, finalized account reads, KMS-only signing, verified signature/message bytes and reconcile-before-rebuild recovery. Publisher tests pass (64), client (9), methodology (13), Rust workspace (20) and compiled SBF custody/lifecycle (15); strict TypeScript and frozen-lock dependency policy pass. Added disabled config and Linux service template. Joel's `3559f2e` archive hash correction is incorporated; the historical mismatch is resolved.
- **Rules for agents:** Do not enable or describe this publisher as running until registry, sealed methodology, test pool, authorized VM caller and funded signer are ready. Preserve its journal across restarts. Finish accepted batches without a deadline; never reprice or filter a snapshot to change its roster. Service and CLI must use the same OS lock with `--no-fork`. No local runtime private key exists. Bybit in the disabled template follows Joel's J3 decision; sealed policy must match.
- **Open:** Dev-VM installation, authorized metadata caller identity, on-chain setup and live publication/recovery/capacity proof. P4's running-service milestone and P5 remain incomplete. No commit or push performed.
- **Refs:** `apps/cox-publisher/README.md`, `apps/cox-publisher/VERIFICATION.md`, `packages/cox/INTEGRATION.md`.

### 2026-10-11 · Peter (Codex) · Remaining Peter-owned EOX dependencies retired

- **Area:** `apps/oracle-worker`, `packages/oracle`, tracked `packages/methodology`, obsolete root commands and lock importers.
- **What:** After verifying P4 carry-over and Joel's caller replacements, removed the remaining 43 tracked legacy files and five root commands. Verified remote `eox-archive` points to `e60ad4035c9431a9eee493a57dd2cdbeb4f4afa9` before deletion. No executable legacy imports remain; ignored inventory is unchanged (21,371 entries).
- **Rules for agents:** Papers and ignored sealed research remain preserved; do not recursively delete the old directories. Joel's archived `apps/app-api/fixtures/oracle-preview.json` remains provenance only. No Joel/Godwin component was modified to force deletion. Keep cleanup separate from the P4 implementation commit and this append-only log in its own commit. This supersedes retained-caller descriptions in the 2026-10-10 cleanup entry and 2026-10-11 deployment entry.
- **Open:** Commit approval; running P4 remains separate.
- **Refs:** `packages/cox/research/deletion-audit.md`, `packages/cox/INTEGRATION.md`.

### 2026-10-11 · Peter (Codex) · Root commands follow the COX replacement

- **Area:** root `package.json` and `README.md`.
- **What:** Peter corrected the omission of replacement root shortcuts during EOX cleanup. Added COX aggregate checks/tests and commands for methodology, Rust CLI, client, publisher, compiled program, deployment, archiver and feed check. Removed the remaining root demo/economic-ingestion shortcuts whose package targets were already retired. Documented the compiled artifact and runtime prerequisites.
- **Rules for agents:** When retiring a workflow, update its root commands and documentation to the working replacement in the same change; do not only remove the old shortcuts. Keep runtime starts and deployment outside aggregate checks/tests. Deployment still requires its approved commit/build, and publisher activation remains separate.
- **Refs:** `README.md`, `package.json`, `apps/cox-publisher/README.md`, `packages/cox/deploy/README.md`.
- **Verification:** Root `cox:check` passes; root `cox:test` passes all 121 tests; `cox:publisher --once` exits disabled. Local verification used the existing test dependencies without pnpm's automatic install. Root execution also exposed mismatched Anchor snapshot references in the client/publisher lock importers; corrected them to the existing pinned snapshot without changing versions. No runtime activation, deployment or commit occurred.

### 2026-10-11 · Peter (Codex) · Dedicated publisher identity and smoke-test funding

- **Area:** `apps/cox-publisher/src/identity.ts`, publisher entry point/tests/docs, `packages/cox/deploy/runtime-funding-devnet.json`.
- **What:** Peter supplied Joel's J4 handoff: only `cox-publisher@colosseum-eox.iam.gserviceaccount.com` may call the signer as oracle-operator; binding stays disabled until actual pool/vault/mint/sealed-methodology addresses are supplied. Updated authentication to use VM metadata access credentials followed by IAM `generateIdToken` for that dedicated identity, signer audience and `includeEmail: true`. Publisher tests pass (67), strict types pass. Transferred 1 devnet SOL from the deployment wallet to the verified runtime; observed finalized balance is 1 SOL.
- **Rules for agents:** No caller key file and no direct VM identity token for signer requests. Do not enable the signer or publisher from this funding alone. Local identity tests do not claim a live VM invocation. This supersedes the direct-metadata identity adapter described in the earlier 2026-10-11 P4 verification entry.
- **Open:** Registry/methodology/test-pool setup and account retention before sustained publishing; commit approval remains pending.
- **Refs:** `apps/cox-publisher/README.md`, `apps/cox-publisher/VERIFICATION.md`, `packages/cox/deploy/runtime-funding-devnet.json`; Joel's signer README on `origin/main`.

### 2026-10-11 · Peter (Codex) · Runtime rent reviewed before continuous activation

- **Area:** Existing COX Batch/Publication allocations and runtime operating budget.
- **What:** Verified Joel's estimate against devnet RPC: each 8,192-byte account requires 42,265,600 lamports; the current pair locks 0.0845312 SOL per accepted publication, 121.724928 SOL for 1,440 publications, excluding fees. No closure exists. This is separate from pool collateral. Completed-batch reclamation appears compatible with lazy balances, but must refund the original payer and update historical batch readers. Publication pruning changes the promised history contract and requires a full verifiable archive.
- **Rules for agents:** No retention policy has been approved, implemented or deployed by this review. Do not close publication accounts merely because a batch finalized; current history readers require them. Do not describe 1 SOL smoke-test funding as a P5 24-hour budget.
- **Open:** Choose and review retention/archive design before unrestricted continuous activation. Closing batches alone halves future allocation growth but does not bound publication storage.
- **Refs:** `packages/cox/programs/cox/src/lib.rs` Batch/Finalize accounts and materialization; `packages/cox-client/src/readers.ts`; `apps/cox-publisher/VERIFICATION.md`.

### 2026-10-11 · Peter (Codex) · Bounded publication storage approved and locally verified

- **Area:** COX program, client, publisher, IDL/fixtures/measurements, SPEC v0.4 and product v13.
- **What:** Peter approved one latest publication and one reusable batch per pool. Implemented fixed seeds `[batch, pool]` and `[publication, pool]`, schema 2 for those two accounts, full batch reset and guarded reuse. The publisher archives complete publication bytes immutably before subsequent signing/rebroadcast, checks predecessor linkage and halts on history gaps, conflicts or disk failure. Root checks pass; 137 COX tests pass (16 compiled custody/lifecycle, 77 publisher, 11 client, 13 methodology, 20 Rust workspace). Current devnet pair rent is 0.0845312 SOL once at the quoted rate; other accounts/fees are additional.
- **Rules for agents:** The upgrade is prepared, not deployed. Preserve latest sequence/batch IDs in account data; do not derive their addresses with those IDs anymore. Live historical reads throw `CoxHistoryNotRetained`; use verified full publication archives for past sequences. Local syncing is not backup; verify backup/restore before activation. Publisher startup pins the required new build and refuses the old deployment. Keep six runtime instructions and existing key/identity; Joel must update signer PDA/schema validation before enabling it. No active legacy-pool migration is supported.
- **Open:** Commit/upgrade approval, verified deployment, Joel/Godwin integration handoff, archive backup/restore and on-chain setup. No commit, deployment, external message or activation performed. This implements and supersedes the pending retention design in the earlier 2026-10-11 runtime rent review entry.
- **Refs:** `packages/cox/ROLLING-STORAGE-HANDOFF.md`, `packages/cox/ROLLING-STORAGE-PLAN.md`, `packages/cox/deploy/publisher-build.json`, `apps/cox-publisher/VERIFICATION.md`.

### 2026-10-11 · Godwin (Claude Code) · Web app reads cox.app-api/v1; 30 assets, swap page, network switcher

- **Area:** `apps/web`.
- **What:** Part of `product.md` G3. Every page reads through `apps/web/src/lib/data.ts`, which returns the `@eox/app-api` COX types. With `COX_API_URL` set it reads a `cox.app-api/v1` server; unset, it uses a built-in 30-asset sample that is labelled on every page. Checked against the fixture server (`SYNA`/`SYNB`, four publications, a missed batch, a fixture wallet). Added: each price's venue and trade age, publication and batch numbers shown separately, every request state from SPEC §8, a Swap page that is a front end over deposit, switch and redeem, a network switcher with mainnet listed as not live, and an error page for an unreachable API. Collateral is labelled `tUSDC` (test USDC) with a notice that it has no real value. The production build passes.
- **Rules for agents:** The web app imports only types from `@eox/app-api`. Importing `createCoxApiClient` at runtime fails under Next.js 16 Turbopack because the package's `.js` specifiers do not resolve to its `.ts` sources, so `data.ts` makes the same calls itself. The app computes no reference; "redeemable, about" is a holder's units times the latest published final class state and is labelled approximate. With `collateralDecimals: null` the app treats base units as whole units. The swap charge is unset (`SWAP_CHARGE_BPS = null` in `src/lib/config.ts`) and shows "Not set yet"; do not present a fee or a mainnet deployment as existing.
- **Open:** Joel: the portfolio has no deposited basis, so the app cannot show profit and loss; the portfolio of the connected wallet and the request builders wait for J5. Peter: Godwin would like a swap charge and a mainnet option, neither of which is in `product.md` or the deployed program. Peter: `pnpm install --frozen-lockfile` fails on `origin/dev` with no lockfile entry for `@coral-xyz/anchor@0.31.1` (from `packages/cox-client`); a plain install repairs it but rewrites about 140 unrelated lines, so it was left for its owner.
- **Refs:** `apps/web/README.md`, commits `a174517`..`e6115a6`.

### 2026-10-11 · Godwin (Claude Code) · Monitor receipt root and state digest match the vectors

- **Area:** `apps/cox-monitor`.
- **What:** Added an independent implementation of the SPEC §3 receipt bytes, folded receipt root and `COX/STATE/V1` state digest. It reproduces every value in `packages/cox/fixtures/state-vectors.json`: the empty root, three receipt encodings, three prefix roots, the state bytes and the state digest. The monitor now has 36 passing tests. It does not import `packages/cox-client`.
- **Rules for agents:** Receipt status 4 (`SafetyRejected`, SPEC §11) is accepted in the encoding only. The monitor's batch calculation does not model the safety pass or the capacity caps, so it cannot yet reproduce a batch in which a request is safety-rejected or a destination is blocked; do not describe the monitor as covering those. The monitor still does not read publications, fetch archives, re-fetch venues or serve verdicts.
- **Open:** Peter: arithmetic vectors for the safety pass (an individually unsafe request, a blocked destination, and the repeat after a switch burn disappears), with the exact cap comparisons, so the monitor can reproduce `SafetyRejected` receipts. Joel: `cox.app-api/v1` `ReceiptStatus` has no value for safety-rejected receipts.
- **Refs:** commits `0d89e7e`, `d104630`; `packages/cox/SPEC.md` §3 and §11.

### 2026-10-11 · Godwin (Claude Code) · Monitor follows the archive and the venues; web app uses the fixture API only

- **Area:** `apps/cox-monitor`, `apps/web`.
- **What:** More of `product.md` G2. `pnpm --filter @eox/cox-monitor start` follows `/v1/prices/changes` and gives every archived cutoff one verdict (`match`, `mismatch` with findings, `skipped` for digests before `COX/WIRE/V1`, `inadmissible`). It checks each close against its `priceE8`, the `COX/PRICE-FALLBACK/V1` order from the archived attempts, the snapshot digest, every artifact's hash, and that the feed and the cutoff agree. Progress is saved per page and resumes after a restart. Verdicts are served read-only as `cox.monitor/v1` on `127.0.0.1:8792` (`/v1/verdicts/latest`, `/v1/verdicts/:cutoff`, `/v1/verdicts?limit=`, `/healthz`). With `MONITOR_VENUE_CHECK=true` it later re-fetches the candles through `@eox/price-feeds` (Kraken one request per 4 s, Coinbase and Bybit one per second, one bulk request per venue and asset) and sets each verdict's `venues` field. 75 tests pass. For G3, at Joel's request the web app's sample data is deleted: it reads `cox.app-api/v1` through `createCoxApiClient` (default `http://127.0.0.1:8790`) and was checked page by page against `APP_API_SOURCE=cox-fixture`.
- **Rules for agents:** Every monitor verdict has `scope: "archive"` and is keyed by cutoff, not by publication sequence; it says the archive is consistent with itself and, when `venues` is `confirmed`, with the venues. It is not yet a verdict on a publication, so do not map it to `status.monitor` as if the on-chain values had been recomputed. The venue check has been tested only with constructed candle data, never against a live venue, and the service has not been run on the dev VM. `apps/web` is built with webpack (`next dev --webpack`, `next build --webpack`) because Turbopack cannot resolve the `.js` specifiers in `@eox/app-api`; this supersedes the statement in Godwin's 2026-10-11 "Web app reads cox.app-api/v1" entry that the app imports only types and has a built-in sample.
- **Open:** Joel: a systemd unit and a `MONITOR_USER_AGENT` contact for `cox-monitor` on the dev VM, and whether `status.monitor` should carry archive verdicts before publications exist. Peter: publications to compare against need a live pool; safety-pass vectors are still needed.
- **Refs:** `apps/cox-monitor/README.md`, `apps/web/README.md`, commits `5b9f5e9`..`102e54f`, `266fb4c`.

### 2026-10-11 · Godwin (Claude Code) · Web forms build deposit, switch and redeem with @cox/client

- **Area:** `apps/web`.
- **What:** At Godwin's request the Buy, Switch and Redeem forms now build a real transaction in the browser with `@cox/client` and the released IDL: `CoxReader.pool` for the next request nonce, the position, request and vault PDAs, the owner's associated token account, then `deposit`, `switch` or `redeem`, signed and sent by the connected wallet. Amounts are parsed to exact integers (collateral base units, unit quanta at 10^12) and the expiry is the inclusive batch `target + n − 1`. Nine tests cover planning and instruction encoding, and the browser bundle was checked to produce the same instruction bytes as Node.
- **Rules for agents:** The submit button is enabled only when `cox.app-api/v1` reports `origin: "live"` with a pool address and collateral decimals, so it is disabled on the fixture. No pool exists on devnet: this path has never sent a transaction, read a real pool or been used with a wallet, so do not describe trading as working. `product.md` J5 assigns unsigned transaction builders to Joel's app API; this does not change that and should be replaced by the API's builders when they exist. Cancel and Withdraw are not wired.
- **Open:** Joel: whether J5 should take this over or the web app keeps building user transactions itself. Peter: `@cox/client` needs two shims to load in a browser (it imports `node:crypto` in `wire.ts`, and `builders.ts` uses a default import of `@coral-xyz/anchor`, which the browser build does not export); both are worked around in `apps/web/next.config.ts`. A test collateral faucet is needed before any user can buy.
- **Refs:** `apps/web/README.md` (Sending requests), commits `9bd7616`..`40b307f`.

### 2026-10-11 · Godwin (Claude Code) · In-browser request building removed from the web app

- **Area:** `apps/web`.
- **What:** Godwin decided the web app should wait for Joel's app API to build user transactions, as `product.md` J5 assigns. Commit `396f93e` reverts the five commits that built `deposit`, `switch` and `redeem` in the browser with `@cox/client`. `apps/web` is back to its state at `d3bb126`: no dependency on `@cox/client` or `@coral-xyz/anchor`, no browser shims, and the Buy, Switch, Redeem, Cancel and Withdraw buttons stay disabled. Supersedes Godwin's 2026-10-11 "Web forms build deposit, switch and redeem with @cox/client" entry, including its question to Joel about who builds transactions: Joel does.
- **Rules for agents:** Do not add transaction building to `apps/web`. The web app will sign and send whatever unsigned transaction the app API returns. The two notes for Peter in the superseded entry still describe `@cox/client` as it is (a `node:crypto` import and a default import of `@coral-xyz/anchor`), in case another browser consumer appears.
- **Open:** Joel: J5 builders for deposit, switch, redeem, cancel and withdraw, and the portfolio of the connected wallet. The removed code remains in history at `9bd7616`..`40b307f` if any of it is useful.
- **Refs:** commit `396f93e`; `product.md` §7.1 J5.

### 2026-10-11 · Joel (Claude Code) · J4: signer prepared for the COX publisher (disabled until activation)

- **Area:** `apps/signer`, GCP `colosseum-eox` (IAM, Cloud Run `eox-signer`).
- **What:** At Peter's request (2026-10-11 email), `oracle-operator` is bound to the deployed devnet COX program `G6iQGoupNSfduw1QJxQ9vcVi9FnCC6cbippXsi4QQzJF`. Allowed instructions: `publish`, `evaluate`, `safety`, `seal_evaluation`, `execute`, `finalize`, with discriminators recomputed and matching Peter's allowlist. The binding pins the registry, pool 0 and vault PDAs at their IDL positions. It verifies on chain, over a genesis-checked devnet RPC, the batch, request, position and publication PDAs and the bound sealed methodology. It caps compute at 1,400,000 units and 1,000 micro-lamports. It ships **disabled** (`enabled: false`, methodology null). New service account `cox-publisher@colosseum-eox.iam.gserviceaccount.com` is the only caller: it has `roles/run.invoker`, and `eox-dev-vm` may mint its ID tokens (`roles/iam.serviceAccountOpenIdTokenCreator`). No key file exists. Deployed as revision `eox-signer-00002-ppp` (image `signer:822040d`). Same endpoint and audience: `[Cloud Run origin omitted]`. Key directory unchanged at version 1. Verified from the VM: a `cox-publisher` token reaches the signer, and a publish request is refused as "prepared … but not enabled". The VM's own account gets 403.
- **Rules for agents:** Get the publisher's token through `generateIdToken` for `cox-publisher` (see `apps/signer/README.md`). Never create a local runtime key. To activate: Peter supplies the initialized pool, vault, mint and methodology; Joel sets `linkage.methodology`, checks pool 0's derived addresses against Peter's, sets `enabled: true` and redeploys.
- **Open:**
  - **Funding:** the runtime key `GNmM11ZM…` has 0 devnet SOL, and the faucet refused (429). Every publication creates a batch and a publication account of 8 KiB each, about 0.085 SOL of rent. That is about 5 SOL an hour or 122 SOL a day unless those accounts are closed. Peter: fund the key, and decide on reclaiming rent before the 24-hour run.
  - **Remaining J4:** retire the EVM roles and publish key directory v2.
- **Refs:** commits `498ad38`..`822040d`, `apps/signer/README.md` (COX publisher binding).

### 2026-10-11 · Joel (Claude Code) · J4: EOX signing roles retired, key directory v2

- **Area:** `apps/signer`, `packages/signing`, `deploy/signing/dev-keys.json`, GCP KMS `eox-signing-dev`.
- **What:** Completes J4 (`product.md` §6.1). `oracle-operator` (Solana) is the only signing role. `uma-asserter`, `uma-challenger`, `oracle-checker`, `evm-relayer` and `solana-relayer` are retired: their KMS key versions are disabled (not destroyed), and the EVM signing path, `/v1/sign/evm` and `viem` are removed. Key directory **version 2** lists them as `retired` with `validUntil` 1791688452 and unchanged public keys. It is served at `/v1/keys` and published in `deploy/signing/dev-keys.json`. Deployed as revision `eox-signer-00003-rsf` (image `signer:b80c831`). Verified from the VM: directory v2 served, `/v1/sign/evm` returns 404, and a retired role is refused as `unknown role`. The COX binding stays disabled, as in the previous entry.
- **Rules for agents:** Never re-enable a retired KMS version to sign; a new role needs a new key, a config entry and a new directory version. Verify historical EVM or relayer signatures against the retired entries in directory v2.
- **Open:** Still waiting on Peter for the activated pool, vault, mint and methodology addresses and for funding of `GNmM11ZM…`, before switching the COX binding on.
- **Refs:** commits `6a6415a`..`fce70fe`, `apps/signer/README.md` (Keys).

### 2026-10-11 · Joel (Claude Code) · Public COX fixture API for the web app

- **Area:** `apps/app-api` (CORS, `Dockerfile`), GCP Cloud Run `cox-app-api`.
- **What:** At Joel's request, `cox.app-api/v1` with the P1-oracle fixture is public at `[Cloud Run origin omitted]` (revision `cox-app-api-00001-z7w`, image `cox-app-api:adbda5f`, us-central1, at most 2 instances). It is open to anyone, read-only and fixture data only. It sends CORS `*` (`APP_API_CORS_ORIGIN`) and answers the stream's `Last-Event-ID` preflight. It runs as service account `cox-app-api`, which holds no permissions. Verified from outside: all routes, CORS and the SSE stream work. Fixture wallet addresses are in `apps/app-api/README.md`.
- **Rules for agents:** Godwin: use this URL as `baseUrl` for `createCoxApiClient` in `apps/web`. It serves synthetic data (`SYNA`, `SYNB`), never market data. The VM's `cox-app-api` on `127.0.0.1:8790` is the same fixture for local tunnels. The live COX source (J5) will get its own deployment once the pool is active.
- **Refs:** commits `91a22ba`..`adbda5f`, `apps/app-api/README.md`.

### 2026-10-11 · Godwin (Claude Code) · Web app defaults to the public fixture API

- **Area:** `apps/web`.
- **What:** Following Joel's 2026-10-11 "Public COX fixture API for the web app" entry, `createCoxApiClient` in `apps/web` now defaults to `[Cloud Run origin omitted]`; `COX_API_URL` overrides it. On fixture data the portfolio page shows the first fixture wallet unless `COX_DEMO_WALLET` is set. Checked with no local API running: every page loads from the public service and shows the fixture label. `dev` and `main` were at the same commit (`e63328a`) before this change, and `pnpm install --frozen-lockfile` passes again after Joel's lockfile repair.
- **Rules for agents:** The public service is fixture data; the web app still cannot send requests or show the connected wallet's portfolio until the live app API (J5) exists. Requests to the API are made on the server side of the Next.js app, so the browser does not depend on the service's CORS setting.
- **Open:** Joel: J5. On macOS `apps/app-api` "COX fixture provenance" fails because `packages/cox-methodology/src/vectors.ts` hashes to `9dfa71b4…`, not the fixture's recorded `ea87c088…`; line endings are a likely cause, not confirmed.
- **Refs:** commit `34213fb`, `apps/web/README.md`.

### 2026-10-11 · Peter (Codex) · Reusable-storage upgrade finalized on devnet

- **Area:** COX devnet program and `packages/cox/deploy/deployed-devnet.json`.
- **What:** With Peter's deployment approval, rebuilt commit `d591412073d24ce5bd1886bd936bd9705cc2bb39` and passed all 16 compiled lifecycle/custody tests. Upgraded the existing program at finalized slot 509800571 using Peter's supplied Helius endpoint. Downloaded executable matches SHA-256 `fd557e30dc1476d33076a83d7a2497753f03f6fedac0b4f9e11283e61e1e6172`; separate upgrade authority verified. Failed upload buffers were recovered or consumed by successful deployment; the saved retry buffer is absent. No RPC credential is stored in tracked artifacts.
- **Rules for agents:** This supersedes the prepared/not-deployed status in the earlier bounded-publication-storage entry. Batch and Publication now use fixed pool-derived addresses and schema 2. Keep the signer and publisher disabled until initialization and Joel's updated validation are complete. Registry remains absent; no methodology, mint or pool was initialized by deployment. Existing uncommitted specification/handoff documents were left untouched.
- **Open:** On-chain setup, Joel's signer integration, archive backup/restore and live publisher verification. Deployment record and this entry await their own commit approval.
- **Refs:** `packages/cox/deploy/deployed-devnet.json`; devnet transaction `5xZ231zy95kuCivGjyTG4Tf2mRXaudF8hR2o6TwdfLUXjhBUdoJQ5PT4Az91YiVZnqTLzofW4Mp9jurb2HGbbteq`.

### 2026-10-11 · Peter (Codex) · Registry and test collateral initialized

- **Area:** COX devnet setup and `packages/cox/deploy/initialized-devnet.json`.
- **What:** At Peter's request, initialized registry `9E52kNuxk7bHHuuvvrG13hvRBinvSnPFNFYM9kcPcKEC` using the separate admin and upgrade signatures and existing KMS runtime public key. Created classic SPL test mint `5rpGrekfBLHdF8PD8eKLzXQPPmhyF7FCKeE1VA5CwV3X`: six decimals, admin mint authority, no freeze authority, zero supply. Both transactions and account contents verified at finalized commitment.
- **Rules for agents:** Reuse these verified identities; do not initialize another registry or create a replacement mint merely to retry setup. Peter identified `hello@wades.io` as the Google account for VM access; use it explicitly rather than assuming the CLI's default account. Methodology, pool and vault remain absent and publisher remains disabled. Do not fabricate a feed-check digest or seal the draft manifest.
- **Open:** Local Google authentication, retrieval and verification of Joel's actual feed report, timed methodology/pool setup and signer integration. No additional commit or external message performed.
- **Refs:** `packages/cox/deploy/initialized-devnet.json`, `packages/cox-client/src/builders.ts`.

### 2026-10-11 · Peter (Codex) · Live feed report retrieved; methodology sealing deferred

- **Area:** Read-only dev-VM/evidence API review and `packages/cox/deploy/initialized-devnet.json`.
- **What:** Peter refreshed authentication for `hello@wades.io`; VM access works and `cox-archiver` is active. Ran Joel's existing seven-day report at 2026-10-11 05:53 UTC: only 549 on-time snapshots exist, with 548 admissible and 11 late snapshots excluded. Fourteen assets each have one failure (1/549, above 0.1%). Evidence API confirms all fourteen failures share cutoff 1791670860: request-budget exhaustion and unavailable USDT/USD conversion prevented resolution; it was not labelled archive_late. Report SHA-256 is recorded in the setup artifact; source observations were not modified.
- **Rules for agents:** A seven-day query interval is not proof of seven days of collected history. Do not seal the draft, silently waive product.md J1, drop fourteen assets from this short sample, or locally filter the 30-asset archive. Registry and test mint remain available; methodology, pool and vault remain pending. Do not assign Peter Joel's feed/archiver implementation work.
- **Open:** Complete the actual seven-day feed evaluation and resolve any resulting failures before selecting the sealed roster and scheduling its origin. No signer activation or external message occurred.
- **Refs:** `product.md` J1, `packages/ingestion/src/cox/feed-check.ts`, `packages/cox/deploy/initialized-devnet.json`; local `.cox/feed-check-seven-days.md` and `.cox/feed-failed-cutoffs.jsonl`.

### 2026-10-11 · Peter (Codex) · Provisional devnet methodology sealed and pool 0 created

- **Area:** COX devnet accounts, `packages/cox/deploy` methodology, setup, disabled publisher config and signer handoff artifacts.
- **What:** Peter explicitly requested proceeding because data is arriving, superseding the sealing deferral in the earlier live-feed-report entry for this devnet test. Retained all 30 assets and Bybit; committed the exact short-sample report SHA-256 without claiming it passed. Uploaded canonical bytes in bounded chunks, sealed methodology `Hk37dxaRjEzcngRoXRCc9N4bkqKRMCDofqTFEQ7CWyMw` (digest `78dfc58ef66c40c92faf09d2fc46226947760d95f29416fbd357e5dc31a944cb`), and created pool 0 `Fn3Xuh7CVxjcRpqJEnGR1isPy2GVBBsdiAbuhfpoVbHb` and vault `6Z7NdtAx71cmySoSYMDm697UCQcuuVYj39yPFsh2nWQ8`. All setup transactions finalized; methodology bytes/roster/origin, registry links, classic SPL mint/vault ownership and zero collateral/units verified. Disabled publisher configuration passes the actual configuration/ready validators.
- **Rules for agents:** Origin is 2026-10-11 08:00 UTC / 09:00 Lagos (1791705600). Pool account exists but its first publication has not initialized reference prices. Batch 0 must meet the existing origin acceptance window; missing it requires new methodology/pool, not late batch 1. Do not describe the provisional feed report as a seven-day pass or drop assets under the deferred gate for this test. Runtime remains KMS-only; admin and upgrade roles remain separate. Signer must use fixed Batch/Publication PDAs and schema 2; those accounts are absent until first creation. Do not activate from this handoff alone.
- **Open:** Joel's signer rebinding/enabling, publisher VM installation and archive operations, and live publication verification. No external handoff message or service activation performed; new setup artifacts remain uncommitted.
- **Refs:** `packages/cox/deploy/initialized-devnet.json`, `methodology-devnet.json`, `feed-check-devnet.md`, `publisher-devnet.json`, `signer-allowlist.json`, `joel-pool-handoff.md`.

### 2026-10-11 · Godwin (Claude Code) · Web app deployed on Vercel

- **Area:** `apps/web`; Vercel project `cox-web` in Godwin's team `gef`.
- **What:** At Godwin's request the web app is deployed at <https://cox-web.vercel.app> from `dev` at `f75d046`, with root directory `apps/web`, Next.js built with webpack and Node 24. It reads the public fixture API and shows the fixture label on every page; all six pages were checked on the deployed site. It was the project's first deployment, which Vercel makes the production deployment.
- **Rules for agents:** The site is public and shows synthetic fixture data only. It is deployed by hand from Godwin's machine with the Vercel CLI; pushing to GitHub does not redeploy it, because the project is not connected to the repository. Do not point it at a live API or add secrets to it without Godwin.
- **Open:** Whether to connect the Vercel project to the GitHub repository so each push gets a preview.
- **Refs:** `apps/web/README.md`.

### 2026-10-11 · Joel (Claude Code) · J5 live app API and signer bound to pool 0

- **Area:** `apps/app-api`, `packages/app-api`, `apps/signer`, `deploy/dev`.
- **What:** `APP_API_SOURCE=cox-live` serves `cox.app-api/v1` from the devnet `cox` program through `@cox/client` (systemd `cox-app-api-live`, `127.0.0.1:8791` on the dev VM). It reads the pool, registry and vault in one call per tick and reports `status.reconciliation` (vault versus active + pending + payable + residual; a shortfall is an `incident`), indexes finalized publications into an append-only log, serves portfolios from position and request accounts, and adds `POST /v1/transactions/{deposit,switch,redeem,cancel,refund,withdraw}` (simulated unsigned v0 transactions, the wallet is the only signer and fee payer), `POST /v1/transactions/submit` (exact signed bytes relayed after signature and program checks) and `GET /v1/transactions/:signature`. Schema additions: `safety-rejected` receipts, nullable `ledger.refundable`, `status.reconciliation`, error codes `NOT_LIVE`, `TRANSACTION_REJECTED`, `TRANSACTION_NOT_FOUND`. On Peter's 2026-10-11 activation email the signer binding uses linkage `cox-v2`: pool 0 `Fn3X…bHb`, sealed methodology `Hk37…yMw`, and the reusable batch `CckM…zHtb` and publication `J5Jy…nZC` pinned in every instruction's account rules; request and position checks are unchanged. The binding is enabled, at Joel's explicit approval.
- **Rules for agents:** The web app builds no transactions: it signs what the API returns and submits through `submitTransaction`. Two wallets building against the same nonce race; the loser rebuilds. `status.monitor` stays `null` until the monitor gives publication-scope verdicts. Never set `enabled` on another binding without the pool and methodology checked on chain.
- **Open:** Peter: push the upgraded IDL and `@cox/client` (schema 2 batch and publication at fixed seeds). The indexer still derives one publication account per sequence and must move to the reusable account plus a history source before the first publication. Instruction account order is assumed unchanged from the released IDL.
- **Refs:** `apps/app-api/README.md` (The live source), `deploy/dev/README.md`, commits `d635d69`..`f3ac916`.

### 2026-10-11 · Joel (Claude Code) · Solana RPC through a Cloudflare Worker proxy

- **Area:** new `apps/rpc-proxy`; `apps/signer`, `apps/app-api` (RPC failover), GCP Secret Manager, `deploy/dev`.
- **What:** At Peter's request each developer runs their own RPC proxy. Joel's is Cloudflare Worker `cox-rpc-proxy` at `https://cox-rpc-proxy.anyaogupeter601.workers.dev`. It forwards JSON-RPC unchanged to Helius devnet, then public devnet, moving on after a network error, 15 s timeout, 429 or 5xx. Callers need a per-client token in the path, and only the read, simulate and send methods the services use are forwarded. The signer (`SIGNER_SOLANA_RPC_URLS`, Secret Manager `solana-devnet-rpc-urls`, revision `eox-signer-00006-7qh`) and the live app API (`COX_RPC_URLS` in `/opt/eox/cox-app-api-live.env`, root 600) list the proxy first and public devnet directly second. They fail over in process and check every URL's genesis at start-up. The Helius key lives only in the Worker's secrets; the secret version that held it was disabled. Verified: genesis and pool 0 read through the proxy, 401 without a token, 403 for other methods, and the signer still enforces the pool 0 binding.
- **Rules for agents:** Never commit or log an RPC URL with a key or token; log hosts only. Each service gets its own proxy token. Do not point another developer's service at this proxy; they run their own.
- **Open:** Peter: rotate the Helius key that was shared in chat, then update the Worker's `UPSTREAM_URLS` secret.
- **Refs:** `apps/rpc-proxy/README.md`, `apps/signer/README.md`, `apps/app-api/README.md`.

### 2026-10-11 · Joel (Claude Code) · RPC proxy: no key rotation, Peter has a token

- **Area:** `apps/rpc-proxy` (Worker secret `ACCESS_TOKENS`).
- **What:** Joel decided the Helius key is not rotated; this closes the open item in the 2026-10-11 "Solana RPC through a Cloudflare Worker proxy" entry. At Joel's request Peter got his own proxy token (a third entry in `ACCESS_TOKENS`, alongside the signer's and the live app API's), handed to him privately.
- **Rules for agents:** This replaces that entry's rule against pointing another developer's service at the proxy: Peter may use it with his own token. Revoke a client by re-putting `ACCESS_TOKENS` without its token; never share one token between clients.
- **Refs:** `apps/rpc-proxy/README.md`.

### 2026-10-11 · Godwin (Claude Code) · Monitor running on the dev VM as its own service

- **Area:** `apps/cox-monitor` (new `deploy/`), dev VM `eox-dev`. Nothing in `deploy/dev` changed.
- **What:** At Godwin's request the monitor runs on `eox-dev` as systemd `cox-monitor`, installed on its own in the way the publisher is: user `cox-monitor`, one bundled file at `/opt/cox-monitor/releases/<commit>` behind `/opt/cox-monitor/current`, state in `/var/lib/cox-monitor/state.json`, verdicts on `127.0.0.1:8792`, memory capped at 256 MB. `apps/cox-monitor/deploy/deploy.sh` installs only the monitor; no other service was restarted (start times of the archiver, evidence API, both app APIs and the publisher were checked before and after). It reads `http://127.0.0.1:8787` at no more than 5 cutoffs every 20 seconds. This is its first run against the live evidence API: of the first 90 archived cutoffs, 24 `COX/WIRE/V1` snapshots matched (prices, fallback order, snapshot digest and every artifact hash), 63 with the provisional digest were skipped, 3 were inadmissible, 0 mismatched. The monitor now also answers on `/health`. Supersedes the statements in Godwin's 2026-10-11 "Monitor follows the archive and the venues" entry that the service has not been run on the dev VM and needs a unit from Joel.
- **Rules for agents:** `deploy/dev/setup.sh` does not know about `cox-monitor` and must not install or remove it; redeploy it only with `apps/cox-monitor/deploy/deploy.sh`. Verdicts are still `scope: "archive"`, keyed by cutoff, and say nothing about on-chain publications. The venue check is off on the VM (`MONITOR_VENUE_CHECK` unset), so every verdict's `venues` stays `pending`; it has still never run against a live venue.
- **Open:** Joel: a `MONITOR_USER_AGENT` contact address so the venue check can be switched on within the `SYSTEM.md` §10.1 monitor budget, and whether the live app API should read `127.0.0.1:8792`. Peter: comparing publications needs the monitor to read the pool; safety-pass vectors are still needed.
- **Refs:** `apps/cox-monitor/README.md` (Running on the dev VM), commits `bc4ac99`..`7289771`.

### 2026-10-11 · Godwin (Claude Code) · Web app sends requests through the live app API

- **Area:** `apps/web`.
- **What:** Part of `product.md` G4, using Joel's J5 routes. On a live API the Buy, Switch, Redeem, Cancel, Refund and Withdraw buttons ask the app API for the unsigned transaction (`buildDeposit`, `buildSwitch`, `buildRedeem`, `buildCancel`, `buildRefund`, `buildWithdraw`), the connected wallet signs it, and the signed bytes go back through `submitTransaction` and are tracked with `submission`. The browser refuses to sign unless the connected wallet is the fee payer and the only signer. Form input becomes exact integers and an inclusive expiry batch in `src/lib/requests.ts` (8 tests). The portfolio, positions and requests shown are the connected wallet's. Before the first publication every page keeps its layout and shows a dash for missing values. Checked against a local `APP_API_SOURCE=cox-live` server on devnet pool 0 with no publication yet: all six pages load.
- **Rules for agents:** The web app still builds no transaction and imports no `@cox/client`, as in Godwin's 2026-10-11 "In-browser request building removed from the web app" entry. No request has been signed by a real wallet or filled by a publication yet, so do not describe trading as working. <https://cox-web.vercel.app> still serves fixture data and was not redeployed.
- **Open:** Joel: a public address for the live app API, so the Vercel site can use it; the portfolio still has no deposited basis. Peter: how a tester gets test tUSDC (mint `5rpGrekfBLHdF8PD8eKLzXQPPmhyF7FCKeE1VA5CwV3X`).
- **Refs:** `apps/web/README.md` (Sending requests), commits `ee0ad47`..`9712073`.

### 2026-10-11 · Peter (Codex) · Public-facing README rewrite

- **Area:** All 18 existing repository `README.md` files.
- **What:** At Peter's request, rewrote the root guide around COX and organized component guides around purpose, setup, configuration, interfaces, testing and limitations. Removed personal assignments, handoffs, phase checklists and stale development communication. Matched commands and capabilities to current source; preserved explicit devnet/test-collateral, fixture/live, delayed execution, custody, signer and history boundaries.
- **Rules for agents:** Keep READMEs useful to external readers. Record team coordination and implementation history here rather than in public usage guides. Do not equate service installation with live wallet acceptance or archive-only monitor verdicts with verified publications. Current app API history gap recovery remains a documented limitation.
- **Open:** Review and commit approval. This documentation pass made no source or runtime changes; concurrent staged changes remain untouched.
- **Refs:** Root `README.md`, package/app READMEs, `deploy/dev/README.md`.

### 2026-10-11 · Joel (Claude Code) · Live app API reads the reusable publication account

- **Area:** `apps/app-api`, `packages/app-api`, `deploy/dev`; `dev` merged into `main`.
- **What:** Peter's rolling-storage build keeps one reusable publication and one batch account per pool, so the live source now reads registry, pool, vault, publication and batch in one finalized call per tick. It appends the publication when it is the next sequence and fills earlier gaps from the publisher's archive, verifying each record's identity, account hash, state and predecessor chain. A root timer copies the archive read-only to `/opt/eox/state/cox-publication-archive`. Publications whose batch was already reused report `fixed: null` and null money flows; `finalization.transaction` is `null` and `slot` is the observed finalized slot. Both app APIs run on a checksum-pinned Node 24 (`@cox/client` needs it; Node 22 failed on its `BN` import). `dev` was merged at `245523d`. Its lockfile carried rollup 4.64.5, which the release-age policy refuses, so the lockfile keeps rollup 4.64.1. Verified on the VM at `6111d6a`: publications 0 to 33 served without gaps, status fresh, vault reconciled. The signer has signed the publisher's traffic since origin (115 in the first hour, none refused), and the new IDL's account order matches its pins.
- **Rules for agents:** Never serve the reused publication as an older sequence. A `null` fixed valuation means the batch was not observed before reuse, not zero.
- **Open:** Peter: `packages/cox-client/test/swap.test.ts` bundle test and the publisher's `fsync` tests fail on Windows only (`/C:/` path and `EPERM`).
- **Refs:** `apps/app-api/src/cox/live-source.ts`, `apps/app-api/src/cox/publication-archive.ts`, `deploy/dev/README.md`, commits `ade5bb5`..`6111d6a`.

### 2026-10-11 · Joel (Claude Code) · Public live app API

- **Area:** `apps/app-api`, GCP Cloud Run `cox-app-api-live` (europe-west1), `apps/rpc-proxy` tokens.
- **What:** At Joel's request the live `cox.app-api/v1` is public at `[Cloud Run origin omitted]`. It runs as service account `cox-app-api-live`, which can only read the RPC secret `cox-app-api-live-rpc-urls` and objects in `gs://colosseum-cox-publication-archives-dev`. One always-on instance (`min=max=1`, CPU always allocated); state is in `/tmp`, so each start rebuilds history from the archive bucket (records are verified by content hash, account hash, state and predecessor chain). RPC goes through Joel's Cloudflare proxy with its own fourth token, then public devnet. CORS `*`; POST transaction routes are limited to 30 per client per minute (429 `RATE_LIMITED`, client = last `X-Forwarded-For` entry). The container now runs on Node 24 (`node:24.21.0-slim`). Verified from outside: publications 0 to 54 without gaps, 30 assets priced, status fresh, vault reconciled, CORS, builder validation and the rate limit.
- **Rules for agents:** Godwin: use this URL for the live web app; check `deployment.origin` is `live`. It is devnet and test collateral only. Never raise the instance count without moving submission tracking to shared storage: submission lookups are per instance.
- **Refs:** `apps/app-api/README.md`, commits `9a133d2`..`9a65246`.

### 2026-10-11 · Joel (Claude Code) · Signer and live APIs moved to pool 1 (devnet USDC)

- **Area:** `apps/signer/config/dev.json`, `deploy/dev`, Cloud Run `cox-app-api-live`.
- **What:** At Peter's request (2026-10-11), the signer binding and both live app APIs moved from pool 0 to pool 1. Checked on chain before the change: pool `F44g6A58N3cu9TGaDE1LiDB3r1BCxCrfFkMQV1DcEv37` (pool 1's PDA, 31 classes, origin 1791714000 = 10:20 UTC, not yet initialized), vault `6fMcr5FTx3ZmrZp5XpxjD3fpUqfdza27XccVHaaoRGEp` (owned by the pool, holds the pool's mint), mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (Circle's devnet USDC, 6 decimals), sealed methodology `5h3fnfD9BFbJ1iRmRTy7fd6DPy1xEWNg4h2KGheRxFT6` (digest `8dff8843…c819`, 30 assets), reusable batch `585NzfdUEPMQCBcxWNzzDiap5rTB5jUNyJZMqEGYWbAv` and publication `CeWq5nVR9wzcJGqeegEQhXXfJqBRtdp8bVVSm4PtF6e`. The signer now pins those accounts and refuses pool 0. Both live APIs read history from `gs://colosseum-cox-publication-archives-dev/pool-1/history/`; `eox-dev-vm` got read-only access to that bucket and the VM's archive copy timer was removed, since one folder cannot hold two pools' sequences.
- **Rules for agents:** Devnet USDC is still devnet: no real value. Pool 0's history stays in its own bucket prefix.
- **Refs:** commits `ae7bc2b`, `ef3f6cd`.

### 2026-10-11 · Joel (Claude Code) · RPC failover on refused access

- **Area:** `apps/rpc-proxy`, `apps/signer/src/rpc.ts`, `apps/app-api/src/cox/rpc.ts`.
- **What:** Before pool 1's origin, the live API saw upstream `403 "Your IP or provider is blocked from this endpoint"` responses until 10:08 UTC, which neither the Worker nor the services failed over on. The Worker and both services' in-process failover now also move to the next RPC on HTTP 401, 403 and 408, as well as 429 and 5xx; other 4xx still pass through. `wrangler.toml` now declares Peter's custom domain `cox-rpc-proxy.variance.space`, so redeploys keep it; Peter's current upstreams (Ankr, then public devnet) were not changed. Deployed: Worker version `12d8410b`, signer `eox-signer-00008-wcq` (signing the publisher's traffic, none refused), public live API `cox-app-api-live-00003-rb2` (pool 1 publications 0 to 29 without gaps), VM live API at `e848856`.
- **Rules for agents:** A 401 or 403 from an RPC means the provider refused us, not that the request was wrong; fail over rather than surface it.
- **Refs:** commits up to `e848856`.

### 2026-10-11 · Godwin (Claude Code) · Swap page uses @cox/client/swap

- **Area:** `apps/web`.
- **What:** Following `product.md` version 14, the Swap page now moves only between the pool's test collateral and the CRYPTO class, through Peter's `CoxSwapSdk`. The SDK runs on the server of the Next.js app against Solana devnet pool 0: market state, balances, on-chain quote, `prepareBuy`, `prepareSell`, `prepareWithdraw` and `transaction`. The wallet signs in the browser after a check that it is the fee payer and only signer, and the server sends the bytes to devnet. Checked against devnet at publication sequence 6: the market read and a 250 test USDC quote (250,000,000 CRYPTO units) work, and the production build passes. This narrows the rule in Godwin's 2026-10-11 "In-browser request building removed from the web app" entry: the Swap page prepares transactions with Peter's SDK as `product.md` assigns; asset-page Buy, Switch, Redeem, Cancel, Refund and Withdraw still go through Joel's app API.
- **Rules for agents:** The collateral is still the devnet test mint `5rpGrekf…wV3X` (supply 0 when checked), not Circle's devnet USDC, so the app keeps the `tUSDC` label. No swap has been signed by a real wallet yet. `apps/web` now needs `experimental.externalDir` to import `packages/cox/idl/cox.json`.
- **Open:** Peter: how a tester gets test collateral, since the mint's supply is 0. Joel: a local `APP_API_SOURCE=cox-live` server at `d07a773` still reports no publication while the pool is at sequence 6, so Markets stays empty; this looks like the indexer change noted in Joel's 2026-10-11 J5 entry.
- **Refs:** `apps/web/README.md` (Swap page), commits `b8597f5`..`4cb55a8`; `product.md` version 14.

### 2026-10-11 · Godwin (Claude Code) · Web app reads the public live app API; Faucet page; Vercel redeployed

- **Area:** `apps/web`; Vercel project `cox-web`.
- **What:** Joel's live app API is public at `[Cloud Run origin omitted]` and is now the web app's default (`COX_API_URL` still overrides; the fixture API stays at the `us-central1` address). Checked at publication sequence 59: all pages load with the 30 assets, prices, references and charts. The navigation is Markets, CRYPTO, Portfolio, Swap, Faucet; the Publications page stays at `/publications` without a link. The new Faucet page links to Solana's devnet SOL faucet and Circle's devnet USDC faucet and shows the connected wallet's balances. At Godwin's request the status banner no longer carries the "test collateral, MVP-0, operator-attested prices" line. <https://cox-web.vercel.app> was redeployed from `dev` with these changes. Supersedes the statement in Godwin's 2026-10-11 "Web app deployed on Vercel" entry that the site shows fixture data only.
- **Rules for agents:** `product.md` G3 asks for the test-collateral, MVP-0 and operator-attested labels on every trading screen; they were removed from the banner by Godwin's decision for the demo, so do not assume the app still shows them. The pool's collateral is still the test mint `5rpGrekf…wV3X`, not Circle's devnet USDC `4zMMC9sr…ncDU`, so USDC from the Faucet page cannot be deposited into pool 0.
- **Open:** Peter: whether a pool on Circle's devnet USDC will be created, or the test mint handed to testers. No request has been signed by a real wallet yet.
- **Refs:** `apps/web/README.md`, commits `d6c57a2`..`a76dcbf` and the three that follow.

### 2026-10-11 · Godwin (Claude Code) · Web app on pool 1 and devnet USDC; Swap page back on the app API

- **Area:** `apps/web`.
- **What:** Following Joel's 2026-10-11 "Signer and live APIs moved to pool 1 (devnet USDC)" entry, the web app labels the collateral `USDC` (Circle's devnet USDC), and the Faucet page reads the wallet's devnet SOL and USDC. The Swap page (collateral ↔ CRYPTO only) now uses the app API's `buildDeposit` and `buildRedeem` with class `CRYPTO`, and `apps/web` no longer depends on `@cox/client`. A dry run against the public live API prepared a 1 USDC deposit into CRYPTO for pool 1 and was refused only because the test owner had no USDC account. Supersedes Godwin's 2026-10-11 "Swap page uses @cox/client/swap" entry.
- **Rules for agents:** Do not use `@cox/client/swap` for the benchmark until it is fixed: its `CRYPTO_CLASS` is 0, which is the first asset's class (BTC), while `packages/cox/SPEC.md` §3, the program (`h.push(SCALE)` last) and the app API put CRYPTO at index N (30). Its `DEVNET_TEST_COLLATERAL` is also pool 0's mint. An empty class mints one unit per collateral base unit, so the app estimates an empty class at 10^-6 USDC per unit.
- **Open:** Peter: fix `CRYPTO_CLASS` and its tests in `packages/cox-client/src/swap.ts` (he confirmed to Godwin that CRYPTO is the last index). No request has been signed by a real wallet yet.
- **Refs:** `apps/web/README.md` (Swap page), commits `d1e605f`..`0d6bf73`.

### 2026-10-11 · Peter (Codex) · Configurable fee upgrade prepared

- **Area:** `packages/cox`, `packages/cox-client`, `apps/cox-publisher`.
- **What:** Implemented the approved fee extension: initial 2 bps/$2 cap, admin limits 100 bps/$2, 24-hour notice after initial scheduling, request-locked terms, net minimums, finalization-only treasury credits and admin-owned collateral withdrawals. Pool 1 migrates in place; legacy requests/history remain supported. Added stale-padding migration protection, V2 commitments, compiled fixtures, integration handoff and rollout instructions. Verification: 29 compiled lifecycle/custody tests, 29 client tests, 78 publisher tests and 26 Rust workspace tests pass; type checks, formatting and clippy pass.
- **Rules for agents:** This is prepared, uncommitted and not deployed. Do not enable fees before matching signer/API/UI integration and coordinated upgrade approval. Runtime signer allowlist stays the same six instructions; admin and user fee instructions are excluded. Use fee-aware builders with expected configuration versions and include `pool.fees` in vault accounting. Preserve V1 history and sealed methodology bytes; read the explicit `COX/FEES/V1` extension in SPEC.md.
- **Open:** Commit/deployment approval; Joel's signer/API integration; Godwin's UI/monitor integration; devnet fee journey and activation. No live service was changed by this implementation.
- **Refs:** `packages/cox/deploy/fee-upgrade-devnet.json`, `packages/cox/deploy/README.md`, `packages/cox/fixtures/fee-accounts.json`, `packages/cox/fixtures/fee-state-vectors.json`, `packages/cox/results/revenue-runtime.json`.

### 2026-10-11 · Peter (Codex) · Fee implementation commit approved

- **Area:** COX configurable fee release and publisher history compatibility.
- **What:** Peter approved committing the prepared fee implementation. Committed as `2c16095`; publisher verification now includes 79 passing tests with mixed V1/V2 archive continuity. This supersedes the uncommitted status in the earlier 2026-10-11 Configurable fee upgrade prepared entry.
- **Rules for agents:** Commit approval does not authorize deployment or fee activation. Keep the live pool and publisher unchanged until the coordinated upgrade is separately approved.
- **Open:** Joel/Godwin integration, deployment approval, in-place migration and live fee journey.
- **Refs:** `2c16095`, `packages/cox/deploy/fee-upgrade-devnet.json`.

### 2026-10-11 · Godwin (Claude Code) · Web app: swap for CRYPTO, then buy and sell assets with CRYPTO

- **Area:** `apps/web`.
- **What:** At Godwin's direction, and matching `product.md` version 14, USDC enters and leaves only on the Swap page (deposit into CRYPTO, redeem from CRYPTO). Asset pages now offer Buy (switch CRYPTO → asset) and Sell (switch asset → CRYPTO) and no longer take USDC directly; the CRYPTO page links to Swap. The first real request went through the deployed app on pool 1: Godwin's wallet deposited 10 USDC into CRYPTO (class 30), filled, vault and ledger both 10 USDC. Units are displayed at 10^(12 + collateral decimals) quanta per unit, so 10 USDC reads as 10 CRYPTO and a fresh class has unit value 1; requests are still sent in exact quanta.
- **Rules for agents:** The displayed unit is a web-app convention only; the API, the program and `packages/cox` still count units at 10^12. The app presents CRYPTO as what the user pays with, but it is the CRYPTO claim class: its value in USDC can change once other classes hold backing.
- **Open:** A switch (Buy or Sell) has not been signed by a real wallet yet.
- **Refs:** `apps/web/README.md` (Swap, buy and sell), the three commits before this entry.

### 2026-10-11 · Godwin (Claude Code) · Web app: full exit path, position trading view, candles

- **Area:** `apps/web`.
- **What:** Since the previous entry a real wallet has completed the whole journey on pool 1 through the deployed app: swap in, buy (switch from CRYPTO), cash out and withdraw. Added: Cash out (redeem straight from any class to USDC) on asset pages and Portfolio rows; cost, worth and gain or loss per position from the wallet's filled requests (`src/lib/basis.ts`, average cost); a snackbar when an order is placed; a position page at `/portfolio/<class>` laid out as a trading screen with bought-at and sold-at prices (`src/lib/trades.ts`); charts with a crosshair, entry line, trade markers, candlesticks, bar intervals and ranges up to 1M. The server now keeps the last 1,440 publications in memory and fetches only newer ones, starting from `latestSequence − 1440`.
- **Rules for agents:** Cost and gain or loss are a web-app calculation, not a figure from the program or the app API. Candles are built from one value per publication, so they are not exchange OHLC. The 1W and 1M ranges show at most 24 hours.
- **Open:** Joel: a compact history route (for example one value per class and asset per publication, or pre-grouped bars) so the app can show a week or a month without downloading every publication; and a deposited basis in the portfolio.
- **Refs:** `apps/web/README.md`.

### 2026-10-11 · Joel (Claude Code) · Signer and live API prepared for the fee upgrade (not deployed)

- **Area:** `apps/signer`, `packages/app-api`, `apps/app-api`; branch `feat/cox-fees` (`main` plus `dev` at `09d7332`).
- **What:** At Peter's request (fee-upgrade email, 2026-10-11), Joel's side is ready for `COX/FEES/V1`.
  - **Signer:** accepts request schema 1 and 2 and refuses any other request layout. The runtime allowlist is still only publish, evaluate, safety, seal_evaluation, execute and finalize. Tests confirm that the fee IDL keeps their discriminators and account order, and that fee administration, treasury withdrawal and user trades are refused.
  - **API reads:** status and publications report active and scheduled fee terms and committed fees. Batch fees come from `COX/STATE/V2`. The flow identity subtracts batch fees, and vault reconciliation adds committed fees.
  - **Requests:** each request reports its locked fee terms, and its receipt reports `gross` and the `fee` charged.
  - **Trades:** new `POST /v1/quotes/{deposit,switch,redeem}`. Builders require `expectedFeeVersion` on a migrated pool and build the `*_with_fee` instructions. A mismatch returns 409 `FEE_CHANGED` from both the builder and submission, before anything is relayed.
  - **Godwin's fixture:** `apps/app-api/fixtures/cox-fee-examples.json` holds real responses over Peter's compiled fee accounts.
  - **Verification:** 31 signer tests and 43 app API tests pass. A read-only run against live pool 1 (still legacy, sequence 232) decoded every account and quoted a zero fee through the legacy path.
- **Rules for agents:** Do not deploy these to the signer or either live API before Peter's approval and the program upgrade sequence. Never compute a fee in the API or UI; show the quote's and receipt's values. Pass a quote's `feeTerms.version` as `expectedFeeVersion` and requote on `FEE_CHANGED`.
- **Open:** Godwin: fee display from `quote`, `UnsignedTransaction.feeTerms` and `receipt.fee`, and the monitor's `COX/STATE/V2` and `COX/RECEIPTS/V2` support. Peter: merge approval for `feat/cox-fees` and the deployment window.
- **Refs:** `apps/app-api/README.md` (Trading fees), commits `7e68c67`..`0716a0a`.

### 2026-10-11 · Joel (Claude Code) · Fee-ready signer and live APIs deployed (fees not active)

- **Area:** `main` at `a1ba138`; Cloud Run `eox-signer`, `cox-app-api-live`, `cox-app-api`; dev VM.
- **What:** With Peter's approval, `feat/cox-fees` was fast-forwarded into `main` and deployed. This supersedes the "not deployed" status in Joel's earlier 2026-10-11 entry "Signer and live API prepared for the fee upgrade".
  - **Deployed:** signer `eox-signer-00010-z8g` (image `signer:a1ba138`; `00009-lmr` is the same image), public live API `cox-app-api-live-00004-9sf`, public fixture API `cox-app-api-00002-nkj` (image `cox-app-api:a1ba138`), and both VM app APIs at `a1ba138`.
  - **Verified:** the publisher's traffic is signed with HTTP 200 and nothing refused. Pool 1 publications 0 to 272 are served with no gaps, status is fresh and the vault is covered. A live deposit quote returns fee 0 at version 0. Pool 1 is still unmigrated (`status.fees.migrated: false`).
- **Rules for agents:** The program upgrade, pool 1 migration and fee scheduling are Peter's steps and have not happened. After the migration, check that `status.fees.migrated` turns `true`, the reconciliation covers the vault, and publishing continues.
- **Refs:** commits `7e68c67`..`a1ba138`.

### 2026-10-11 · Joel (Claude Code) · Pool 1 fee migration verified on the live APIs

- **Area:** Cloud Run `cox-app-api-live`, dev VM `cox-app-api-live`, `eox-signer`.
- **What:** After Peter migrated pool 1, both live APIs report `status.fees.migrated: true` under policy `COX/FEES/V1`. The active terms are version 0 (no fee). Version 1 (2 bps, cap 2,000,000) is scheduled for cutoff 1791738000 (17:00 UTC). Publication 304 is the first `COX/STATE/V2` state, and it chains to the last V1 publication. Batches 306 to 308 were missed during the pause. Publications 0 to 310 are served without gaps, status is fresh and the vault is covered (13,998,590, committed fees 0). Every signing request in the last hour returned 200 on `eox-signer-00010-z8g`, with nothing refused.
- **Open:** After 17:00 UTC, check that version 1 becomes active once a qualifying publication finalizes. Then a devnet wallet trade must show matching quoted, charged and receipted fees, and the committed fees must appear in the vault reconciliation.

### 2026-10-11 · Peter (Codex) · Relative service domains

- **Area:** Cloudflare Workers/DNS, GCP service aliases, `deploy/domains`, RPC configuration.
- **What:** At Peter's request connected `rpc.getrelative.trade` to the existing RPC Worker; `api`, `fixture-api` and `signer` aliases proxy their existing Cloud Run origins through `relative-service-gateway`. `vm.getrelative.trade` resolves to the running europe-west1-b instance. Verified live/fixture status, authenticated RPC devnet genesis and signer directory access using the publisher identity; unauthenticated access remains refused.
- **Rules for agents:** Existing service URLs and runtime configuration remain valid. RPC requires the existing token path. Signer identity-token audience stays the original Google URL. VM ports remain private; use SSH tunnels. Publisher/archiver have no HTTP endpoint. Gateway routes and source are in `deploy/domains`; preserve both RPC custom domains on deployment.
- **Open:** Consumers can adopt the aliases separately. Infrastructure source changes await commit approval.
- **Refs:** `deploy/dev/README.md`, `deploy/domains/wrangler.toml`, `apps/rpc-proxy/wrangler.toml`.

### 2026-10-11 · Peter (Codex) · Private Cloud Run origins

- **Area:** Gateway, signer/publisher configuration, web API defaults and documentation.
- **What:** Peter explicitly requested no Cloud Run URLs in Git. Removed concrete origin URLs from tracked working files, including redacting historical log URLs under that instruction; existing Git history was not rewritten. Gateway origins now use Cloudflare secrets and the updated gateway is deployed and verified. Signer startup requires private `SIGNER_AUDIENCE`; publisher endpoint/audience pins can be supplied by private `COX_SIGNER_URL` and `COX_SIGNER_AUDIENCE`. Source changes remain uncommitted.
- **Rules for agents:** Never commit concrete Cloud Run origins or audience URLs; use branded domains or private runtime settings. Before deploying the updated signer/publisher, supply the existing audience privately; branded DNS alone does not change Google token audiences. Do not treat a deployment report as verification: check the live fee fields and quote routes.
- **Open:** At verification the live API had no fee status and its fee quote route returned 405; both Cloud Run image tags remained the pre-fee tag. Joel's reported fee deployment was not confirmed. Publisher and on-chain pool were unchanged.
- **Refs:** `deploy/dev/README.md`, `deploy/domains/gateway.mjs`, `apps/signer/README.md`, `apps/cox-publisher/README.md`.

### 2026-10-11 · Peter (Codex) · Pool 1 fee migration deployed with fees disabled

- **Area:** COX devnet program, existing pool 1, publisher deployment records.
- **What:** Peter authorized migration while Godwin finishes fee display asynchronously. Deployed approved implementation `658afd5` with executable SHA-256 `865dcb315e2b9359294df8640c9d6aa04b3f9c308e2f1b74ff5a8db0e36a9b3c`, then migrated pool 1 in place. All legacy pool values, positions, requests, vault, methodology and publication bytes were preserved. Resumed the matching publisher release; publication 304 uses V2 and links legacy 303. Verified all 306 history records through sequence 305, successful archive backups and vault/ledger equality of 13,998,590 base units. All 29 compiled-program tests passed again. Joel's live API reports migrated, fresh and reconciled.
- **Rules for agents:** Fees remain disabled: version 0, zero rate/cap, no pending configuration. Do not schedule activation until separately approved and fee display is ready. Migrated trade builders require the quoted `expectedFeeVersion`, including version 0 while fees are disabled. Keep the existing pool identity and archive path; never roll back to a binary unaware of migrated accounting. This supersedes the undeployed status in earlier fee entries.
- **Open:** Godwin's fee/version UI integration, separate activation and charged devnet wallet journey. Deployment-record/log changes await commit approval; unrelated domain/privacy changes remain uncommitted.
- **Refs:** `packages/cox/deploy/fee-upgrade-devnet.json`, `packages/cox/deploy/deployed-devnet.json`, `packages/cox/deploy/publisher-build.json`.

### 2026-10-11 · Peter (Codex) · Initial fees scheduled for 18:00 Lagos

- **Area:** Existing devnet pool 1 fee administration and deployment record.
- **What:** Peter explicitly authorized initial fee scheduling for 18:00 Africa/Lagos today (17:00 UTC, cutoff `1791738000`). Admin transaction `CrmNS3Ch1ZJGRnbLbLXCgqkrTK1BRzBZSNc1SrCwV7sKSiSrwQfS8isjS6K6LsTDRYjo9zfCpqorbWyD44A1FuW` finalized at slot 509948487. Verified pending version 1 at 2 bps with a 2,000,000-base-unit cap; active version 0 remains fee-free until eligible publication finalization.
- **Rules for agents:** Activation happens when the first publication with cutoff at or after 18:00 finalizes. Requests retain their submission-time terms; requests submitted before activation remain free. Cancellation/replacement consumes the initial notice exception and subsequent scheduling requires 24 hours. This supersedes the unscheduled status in the preceding Pool 1 fee migration entry. Godwin's asynchronously completed display/version integration must show these terms before signing.
- **Open:** Activation and charged devnet wallet journey remain unverified; do not describe scheduled fees as already active. Record/log changes remain uncommitted.
- **Refs:** `packages/cox/deploy/fee-upgrade-devnet.json`.

### 2026-10-11 · Godwin (Claude Code) · Landing page, Markets at /markets, public name Relative

- **Area:** `apps/web`, `pnpm-lock.yaml`.
- **What:** Godwin decided the public name of the product is **Relative** (domain `getrelative.trade`). The web app now has a landing page at `/` (`src/landing`, route group `src/app/(site)`), and the existing app pages moved into route group `src/app/(app)` with Markets at `/markets`. The landing page is styled with StyleX 0.19.1, limited to `src/landing/**` through a `babel-loader` pre-rule in `next.config.ts` and `@stylexjs/postcss-plugin` (`stylex.babel.mjs`); the app pages still use Tailwind. Token logos in `apps/web/public/tokens` are copied from the MIT-licensed `@web3icons/core`. Visible text says Relative, and "COX reference" is labelled "Relative reference".
- **Rules for agents:** Only user-facing text was renamed. Environment variables (`COX_API_URL`, `COX_DEMO_WALLET`), packages, services, the `cox` program, the Vercel project `cox-web`, `SYSTEM.md`, `product.md` and the READMEs keep the COX name until Peter and Joel agree to a wider rename. Keep StyleX out of the app pages and Tailwind out of `src/landing`. StyleX needs `@babel/core` 7, not 8.
- **Open:** The landing page's stroke lettering is ported from the Stencil Labs 21st.dev template; reuse rights should be checked before a public launch. No production build has been run on these commits and <https://cox-web.vercel.app> was not redeployed. The domain is not connected. Joel: the lockfile gained the StyleX and Babel packages.
- **Refs:** commits `c466516`..`c1b216a`, `apps/web/README.md`.

### 2026-10-11 · Godwin (Claude Code) · App restyled to match the landing page; sidebar; $CRYPTO

- **Area:** `apps/web`.
- **What:** The app pages now use the landing page's look: dark tokens in `src/app/globals.css`, orange accent `#F2622E`, Geist Mono everywhere, and the stroke-lettered RELATIVE wordmark. Navigation is a collapsible left sidebar with a tree menu (`src/components/tree-nav.tsx`) on wide screens and a scrolling row on narrow ones; Publications has a menu link again. New shared pieces: `stat-card.tsx` (icon title, figure, change badge, mini chart) and `coin-icon.tsx` (logos from `public/tokens`). The main line chart is orange with an orange-to-purple fill; candles keep green and red. Godwin had the explanatory sentences removed from every page, including the grey info boxes in the trade and swap forms and the devnet note in the wallet menu. Wording decided by Godwin: the benchmark is shown as **$CRYPTO** everywhere, the Markets cards read **Index** and **Pool TVL**, and the benchmark row is no longer in the Markets table. A production build (`next build --webpack`) passes; this closes the "no production build" item in Godwin's 2026-10-11 "Landing page, Markets at /markets, public name Relative" entry.
- **Rules for agents:** `$CRYPTO` is display text only. The class id sent to the app API is still `CRYPTO` (`CRYPTO_CLASS` in `src/lib/view.ts`); show class names through `nameOf`. "Pool TVL" is active backing only: it excludes pending deposits, payables and the residual line. The app no longer shows the queued-fill and estimate explanations that `product.md` G3 asks for on trading screens; that was Godwin's decision, so do not assume they are present. A stale `.next/dev` folder from old dev sessions can fail the build's type check; delete it and rebuild.
- **Open:** <https://cox-web.vercel.app> is not redeployed. Nothing was checked with a connected wallet after the restyle.
- **Refs:** commits `2e6848b`..`00cd8c3`.

### 2026-10-11 · Joel (Claude Code) · Real-time SSE stream for the web app

- **Area:** `apps/app-api` (`src/cox/live-stream.ts`), `packages/app-api`; Cloud Run `cox-app-api-live`, `cox-app-api`; dev VM.
- **What:** At Joel's request, `GET /v1/stream?wallet=` pushes three kinds of server-sent events: `publication` (its id is the sequence, so `Last-Event-ID` resumes), `status` (on connect, then whenever anything other than the clock changes) and, with a wallet, `portfolio` (on connect, then when that wallet's positions, requests or receipts change). Joel chose SSE over a WebSocket because the updates only go one way.
  - **Polling:** status is checked every 5 s and after each publication. A portfolio is read after each publication and every 15 s, once per wallet.
  - **Limits:** 8 streams per client, 500 per instance and 200 distinct wallets. Over a limit the response is 429 `RATE_LIMITED`.
  - **Deployed:** public live API `cox-app-api-live-00005-g99` (request timeout raised to 3,600 s), public fixture API `cox-app-api-00003-mjt` (now trusts `X-Forwarded-For`), and both VM APIs, all at `253208f`. Verified from outside.
- **Rules for agents:** Godwin: use `new EventSource(`${baseUrl}/v1/stream?wallet=${owner}`)` in the browser instead of polling. See `apps/app-api/README.md` (Real-time stream).
- **Refs:** commits `acae5a5`..`253208f`.

### 2026-10-11 · Godwin (Claude Code) · Web app on the real-time stream; fee version sent with trades

- **Area:** `apps/web`.
- **What:** Following Joel's 2026-10-11 real-time stream entry, each tab opens one `EventSource` on `/v1/stream` (`src/components/account.tsx`), starting at `?after=<latest sequence>` and adding `?wallet=` when a wallet is connected on a live API. A `publication` event or a changed `status` re-renders the server pages; a `portfolio` event replaces the wallet's portfolio. The 15 and 20 second polling is removed and only runs as a fallback while the stream is down. The 2 bps fee went live at 17:00 UTC and the API then refused the app's deposit, switch and redeem builds (`expectedFeeVersion is required`); the app now sends `status.fees.active.version` with them, and the trade and swap forms show the active fee and take it off the estimate. At Godwin's request, coins offer only Buy and Sell; redeeming to USDC is offered only for the $CRYPTO class, and the Publications page and the Markets price-source column are removed.
- **Rules for agents:** One stream per tab; do not add a second `EventSource`. The stream URL is the server's `COX_API_URL` (default `https://api.getrelative.trade`) passed to the browser, so it must be reachable from browsers. The estimate ignores the fee cap. The app does not call the quote routes or show the fee charged on receipts yet.
- **Open:** No trade has been signed through the app since the fee went live, and the wallet `portfolio` events were not exercised with a real wallet.
- **Refs:** commits `c6d4193`..`596585b`, `apps/app-api/README.md` (Real-time stream, Trading fees).

### 2026-10-11 · Godwin (Claude Code) · Web app: quotes, snackbar errors, batch wording removed

- **Area:** `apps/web`.
- **What:** With a wallet connected on a live API, the swap card and the Buy/Sell box call `POST /v1/quotes/{deposit,switch,redeem}` from the browser (`src/components/use-quote.ts`) about half a second after the amount changes and after each publication, show the quoted fee and amount, and keep the action button disabled until the quote for the typed amount has returned. Without a wallet, or if a quote fails, they show the fee terms and a local estimate. Errors from builds, submissions, wallets and the faucet are mapped to plain sentences in `src/lib/errors.ts` and shown in one snackbar (`src/components/snackbar.tsx`); unknown errors get a generic sentence, never the raw text. `API_URL` now comes only from `COX_API_URL` (set on Vercel; `apps/web/.env.example` for local work). At Godwin's request the app no longer shows batch numbers, publication numbers, closing times or the price venue; the expiry dropdown is gone and every request uses 3 batches; the $CRYPTO page shows the swap card and the wallet's position in place of the members table; the Markets table drops the unit value column.
- **Rules for agents:** Quotes are called from the browser on purpose: the API limits POST routes to 30 a minute per client, and server-side calls from Vercel would share one bucket across all users. Builds and submissions still go through server actions and do share that bucket. Add new error wording to `src/lib/errors.ts`; do not surface raw program or API messages. Supersedes the statement in Godwin's 2026-10-11 "Web app on the real-time stream" entry that the app does not call the quote routes.
- **Open:** Joel: whether the POST limit should key on the end user when requests arrive through the web app's server. The quoted figures and the snackbar were not seen with a real wallet before deploying. The fee charged on receipts is still not shown.
- **Refs:** commits `d0ae5dd`..`37fbe7d`, `443f24a`.

### 2026-10-12 · Godwin (Claude Code) · Web app: performance since launch, fee slot, favicon

- **Area:** `apps/web`.
- **What:** Following review feedback passed on by Godwin, the app's headline comparison is the reference against its starting value of 100, not its hourly change: `standingOf` in `src/lib/view.ts` returns `reference / 100 − 1`. The coin page's Relative reference card, the Markets "Performance" column, the Leading and Trailing cards and the landing page's ranking all use it and say "since launch". Period comparisons stay in the chart controls. The Price card, the Index card and the $CRYPTO level card still show their own one-hour change. The trade and swap cards no longer have a fee row: a fixed slot shows a dot loader while the quote is fetched, then the quoted fee ("0.04 USDC fee included"); amount fields start empty and the button reads "Enter an amount". With no quote the cards show no figures and say that the balance is not enough or that a quote is not available; there is no local estimate. The landing page FAQ now states the 0.02% fee with its 2 USDC cap, a favicon is added, and the hero shows "+N more" after the coin chips.
- **Rules for agents:** Do not reintroduce a windowed change of the reference as a headline figure. Without a connected wallet the cards show no fee at all, because quotes need a wallet that exists on chain.
- **Open:** The loading sequence and the balance message were only seen by Godwin with a wallet, not by the agent.
- **Refs:** commits after `d026eaa` on `dev`; pull request `vaariance/relative#3`.

### 2026-10-12 · Godwin (Claude Code) · Web app: coin logos from CoinGecko and DefiLlama

- **Area:** `apps/web`.
- **What:** At Godwin's request the app's coin icons no longer come from files in `public/tokens`. Once a day the server asks CoinGecko's `/coins/markets` for the 30 coins' image addresses (`getLogos` in `src/lib/data.ts`, ids in `src/lib/logos.ts`) and passes them to the browser; if an image fails to load, the icon switches to DefiLlama's icon service (`icons.llamao.fi`), then to a letter. CoinGecko returned all 30; DefiLlama has no icon for FET or RENDER. The landing page still uses the eight files in `public/tokens`.
- **Rules for agents:** `COINGECKO_API_KEY` is a secret, not configuration: a CoinGecko Demo key sent as `x-cg-demo-api-key`. It is optional, belongs in the host's sensitive variables and the untracked `.env.local`, and must never be committed, logged or given a `NEXT_PUBLIC_` name. `src/lib/data.ts` is marked `server-only`; do not import it from client components. A new roster coin needs its CoinGecko id, and a DefiLlama path if one exists, in `src/lib/logos.ts`.
- **Open:** No key is set on Vercel yet, so the lookup uses CoinGecko's keyless access. CoinGecko asks for attribution on its free plan; none is shown. Joel: a logo address and full name on `/v1/assets` would replace this.
- **Refs:** `apps/web/README.md` (Secrets).

### 2026-10-12 · Godwin (Claude Code) · Web app: cookie notice, Terms of Use and Privacy Policy

- **Area:** `apps/web`.
- **What:** Godwin supplied Variance Labs Ltd's devnet Terms of Use and Privacy Policy. They are stored as Markdown in `apps/web/content/legal` and rendered as static pages at `/terms` and `/privacy` by a small parser in `src/lib/legal.ts` (headings, paragraphs, bold, links and one table). At Godwin's instruction the "Draft for review · Version 0.1" lines and the sentences calling the documents proposed were replaced with "Last updated: 12 October 2026"; the rest is the supplied text. A cookie notice (`src/components/cookie-consent.tsx`, `src/lib/consent.ts`) offers Accept, Manage and Reject and stores the choice in the `relative_consent` cookie for 180 days. The only optional item is remembering the sidebar layout in browser storage, which the sidebar now honours. Links to both pages and to the cookie settings are in the landing page footer, the app sidebar and the foot of each legal page.
- **Rules for agents:** Do not reword `content/legal/*.md`; changes to legal text come from Godwin. The site sets no analytics or advertising cookies, and the notice says so: update the notice and the policy before adding any tracker. Gate any new optional browser storage on `allows(...)` from `src/lib/consent.ts`.
- **Open:** The Terms speak of accepting them "through the application", but the app has no acceptance step. The Privacy Policy's provider list does not name CoinGecko or DefiLlama, which now receive visitors' IP addresses when coin logos load. Both are for Godwin and whoever reviews the documents.
- **Refs:** commits `3c6ff5f`..`e0c431e`.

### 2026-10-12 · Godwin (Claude Code) · Web app: landing page logos from CoinGecko; Markets mini chart colours

- **Area:** `apps/web`.
- **What:** The landing page now takes coin logos from the same lookup as the app pages: `getLogos` (CoinGecko), then DefiLlama, then the file in `public/tokens`, then a letter. `src/landing/coin.tsx` is a client module (`Coin`, `CoinFace`, `CoinNode`) built on the new `useCoinLogo` hook in `src/components/coin-icon.tsx`, and `Landing` wraps the page in `LogoProvider`. The featured coin and the coin pile no longer skip coins without a local file. At Godwin's request the disc behind landing logos is dark grey (`disc`, `#1C1C1F`, in `tokens.stylex.ts`) instead of orange. On Markets, each mini chart takes its colour from the figure beside it: table rows from performance since launch, the Index card from the last hour. Before, both used the last 4 hours, so a green figure could sit next to a red line. Supersedes the statement in Godwin's 2026-10-12 "Web app: coin logos from CoinGecko and DefiLlama" entry that the landing page uses only the files in `public/tokens`.
- **Rules for agents:** A Markets table line still draws the last 4 hours, so a line's slope can disagree with its colour; the colour follows the Performance column. Use `useCoinLogo` for any new coin image so the fallback order stays the same everywhere.
- **Open:** The grey disc was checked by computed style, not by eye; the dark Ethereum logo may look faint on it.
- **Refs:** commits `23c5fbd`, `acfa94b`.

### 2026-10-12 · Godwin (Claude Code) · Web app: cookie banner reworded; leading coin shown by logo

- **Area:** `apps/web`.
- **What:** At Godwin's instruction the cookie banner now reads "We use cookies and analytics to improve Relative. See our Privacy Policy and Terms of Use.", with both names linked. The landing page's "No. 1 on the board" block shows the leading coin's logo (96px, from the shared lookup) in place of its ticker in stencil lettering. Qualifies the statement in Godwin's 2026-10-12 "Web app: cookie notice, Terms of Use and Privacy Policy" entry that the notice says the site sets no analytics cookies: the banner no longer says that.
- **Rules for agents:** No analytics tool is installed; the banner wording is Godwin's decision, not a record of what the site does. Do not add a tracker on the strength of the banner: the Privacy Policy still requires naming the provider and getting permission first.
- **Open:** Godwin: the Manage panel still says "No tracking, analytics or advertising cookies are used on Relative.", and the Privacy Policy says analytics is not authorised; both now disagree with the banner.
- **Refs:** commits `41eeab9` and the one before this entry.

### 2026-10-12 · Joel (Claude Code) · Live API concurrency raised; first fee trade verified

- **Area:** Cloud Run `cox-app-api-live`; pool 1 on devnet.
- **What:** Each open `/v1/stream` connection holds one Cloud Run request slot, and the live API allowed only 80 at once on its single instance. About 80 open pages would have blocked every other request. At Joel's request the live API now accepts 1,000 at once (revision `cox-app-api-live-00006-k46`, same image `253208f`). After the restart it rebuilt history from the archive: publications 0 to 1278 without gaps, status fresh, vault covered.
- **Fee activation:** version 1 (2 bps, cap 2,000,000) became active at publication 394, the 17:00 UTC cutoff, on 2026-10-11. Publications 391 to 393 were still at version 0.
- **First fee trade:** wallet `GpgFFekD…nnepN` deposited 5,000,000 into CRYPTO (request `DwPfeuqx…K8c2`, fee version 1). Publication 427 filled it, charging fee 1,000 (2 bps of 5,000,000) and minting 4,999 units for the net 4,999,000. Committed fees went from 0 to 1,000, and the vault (18,998,590) equals active + pending + payable + residual + committed fees. Joel did not see the quote shown before signing, but the receipt matches the formula and the program's quote for the same amount.
- **Open:** The live API still runs one instance, which can hold at most 500 streams and 200 watched wallets. Scaling beyond that needs edge caching for public reads, shared submission storage, one shared on-chain listener for portfolios and a paid RPC plan. Simultaneous trading at scale is limited by the pool-global request nonce and per-request execution (Peter).

### 2026-10-12 · Joel (Claude Code) · Live API runs on multiple instances

- **Area:** `apps/app-api`; Cloud Run `cox-app-api-live`; bucket `gs://colosseum-cox-app-api-history-dev`; Firestore database `cox-app-api`; dev VM.
- **What:** Peter approved only the multi-instance step of the scaling plan. Portfolios, quotes and builds still read the chain on every request, and no chain state is copied into a database.
  - **History:** indexed history is sealed in immutable blocks of 360 publications. Each block is created only if absent, in the bucket for Cloud Run and in `state/history-<pool>` on the VM. An instance starts from the segment listing and the latest block, reads older blocks on demand, and keeps 8 in memory. Memory stays flat as history grows, and new instances start quickly.
  - **Stream replay:** a stream without a cursor starts at the latest publication. Replay is capped at 1,440 publications.
  - **Submissions:** submission tracking is in the separate Firestore database `cox-app-api` (collection `coxSubmissionsPool1`, TTL on `expireAt`, 30 days). The API's service account can reach only that database, not the signer's `(default)` database.
  - **Deployed:** `cox-app-api-live-00007-c8q` at `a7a8636`, 1 to 10 instances, 1,000 concurrent requests each. Also the fixture API `cox-app-api-00004-grk` and the VM.
  - **Verified:** the VM's full log migrated into 3 segments on first start. Cloud Run rebuilt from the archive and wrote the same 3 segments to the bucket. Publications 0 to 1359 are served without gaps, status is fresh, and Firestore lookups work.
- **Rules for agents:** Never delete or overwrite history segments; the service account cannot. A VM redeploy restarts the archiver, which costs a few cutoffs and can briefly show `delayed`.
- **Open:** Scale-out has not been load-tested. Every instance polls the RPC independently, so RPC load grows with the instance count.
- **Refs:** commits `88b8d8b`..`a7a8636`, `apps/app-api/README.md`.

### 2026-10-12 · Joel (Claude Code) · Live API load test

- **Area:** Cloud Run `cox-app-api-live` (`00007-c8q`, 1 to 10 instances, 1 vCPU, 1,000 concurrent requests each).
- **What:** At Joel's request, read routes were load-tested from a temporary VM in europe-west1 (`autocannon`), deleted afterwards. Routes that call the RPC (portfolio, quotes, builds) and streams beyond the 8-per-client cap were not tested.
  - **50 connections on `/v1/status`:** 2,300 requests/s on one instance, p50 11 ms, p99 80 ms, no errors.
  - **1,000 connections (status, latest publication, assets):** 5,500 requests/s, p50 73 ms, p99 1.3 s, 0.2 % errors. Cloud Run scaled from 1 to 9 instances about 60 s in, and new instances served within about 1 s of starting. All 908 errors were Cloud Run aborts in one 2 s burst before the new instances were ready; none came from the application.
  - **5,000 connections (the same routes plus `/v1/publications?limit=100`):** the service reached the 10-instance cap. Throughput was 4,600 requests/s, p50 490 ms and p99 15.8 s, with 5 % 429 or 503 from Cloud Run at the cap and 457 timeouts. The 100-publication page (about 1.2 MB a response) used about 870 MB/s of egress and dominated.
  - **Publishing:** stayed fresh throughout.
- **Open:** Ways to lift the ceiling, none applied yet: response compression, a minimum of 2 or 3 warm instances, more instances or larger instances, smaller history pages, and the CDN only for immutable history (Peter's condition).

### 2026-10-16 · Godwin (Claude Code) · Web app: Google login through Privy, Buy with USDC, performance-position wording

- **Area:** `apps/web`, `pnpm-lock.yaml`; branch `feat/privy-login`.
- **What:**
  - **Login:** with `NEXT_PUBLIC_PRIVY_APP_ID` set, Log in opens Privy (`@privy-io/react-auth` 3.47.0) with Google and Solana wallets. Google users get a Privy Solana wallet created at login. Privy wallets sign with no confirmation window (`showWalletUIs: false`). Unset, the app keeps wallet-adapter. Owner and signing go through `useSigner` in `src/components/signer.tsx`. Privy's Solana entry needs `@solana/kit` 5.5.1 and `@solana-program/{system,token,memo}` under webpack; they are direct dependencies.
  - **Verified on devnet pool 1:** a Google-created wallet signed a 10 USDC deposit into CRYPTO and a 2 USDC deposit straight into ETH; both went through `/v1/transactions/submit` and filled.
  - **Buy with USDC:** Godwin decided Buy on asset pages pays with USDC by default, as one deposit into the coin's class; paying with $CRYPTO remains as a switch. Supersedes the rule in Godwin's 2026-10-11 "Web app: swap for CRYPTO, then buy and sell assets with CRYPTO" entry that USDC enters only through the Swap page.
  - **Wording:** holdings are named performance positions ("BTC performance position", "BTC vs $CRYPTO"). Portfolio request history says Back and Exit and reports "ETH units"; the asset page buttons keep Buy and Sell.
- **Rules for agents:** The Privy app ID is public; the Privy app secret must never be committed or given a `NEXT_PUBLIC_` name. The Privy app must allow Google, Solana wallets and each site origin. Keep the app API's rule that the user's wallet is the only signer and fee payer; Privy's own gas sponsorship sends transactions itself and would bypass the submit route. Lockfile changes were made with pnpm 10.34.7; pnpm 10.18.3 drops the lockfile's `libc` fields.
- **Open:** Google users still fund SOL and USDC by hand from the Faucet page; sponsored fees need Joel's builder and submit changes. The Privy app uses Privy's Google credentials, so Google's consent screen names Privy. The Privacy Policy does not yet name Privy (Godwin). Vercel needs `NEXT_PUBLIC_PRIVY_APP_ID` and its origin allowed in Privy before deploying. One-click preset buttons are not built.
- **Refs:** `apps/web/README.md` (Configuration, Swap, buy and sell).

### 2026-10-16 · Godwin (Claude Code) · Web app: portfolio login prompts open the top-bar login

- **Area:** `apps/web`.
- **What:** At Godwin's request the Portfolio says "Login to Relative to see your requests", with Login as a highlighted link, and the withdraw button says "Login to withdraw". `openLogin()` in `src/components/signer.tsx` opens whatever the top-bar button opens (Privy, or the wallet list without a Privy app ID). Every `SendButton` is now clickable while logged out and opens login; the other forms still label it "Connect wallet to …".
- **Rules for agents:** Open login only through `openLogin()`, so every prompt shows the same window as the top bar.
- **Refs:** `apps/web/src/components/signer.tsx`, `apps/web/src/components/send-button.tsx`.
### 2026-10-14 · Peter (Codex) · Relative X link in landing footer

- **Area:** `apps/web/src/landing/landing.tsx`.
- **What:** At Peter's request, added `X · @getrelativ` below the footer's Open app button, linking to `https://x.com/getrelativ` in a new tab with the existing footer-link styling.
- **Refs:** Public X handle supplied by Peter; no deployment in this change.

### 2026-10-15 · Peter (Codex) · Swap SDK composition research

- **Area:** `packages/cox-client/SWAP-PLAN.md`; implementation unchanged.
- **What:** Traced one-wallet-transaction DEX funding plus future-publication position entry. Existing deposits accept any current class; SDK lifecycle remains benchmark-only and API submission rejects DEX programs and lookup tables. All 29 client tests and type check pass in an isolated copy using existing dependencies. Peter deferred faster publication and described future epoch pools as separate pools alongside the current one.
- **Rules for agents:** Direct class entry is not equivalent to minting CRYPTO then switching: fees, rounding and timing differ. Existing deposits take fixed amounts; depositing all variable DEX proceeds needs additional on-chain routing logic. Jupiter v2 Build supports ExactIn only. Preserve the API-owned unsigned transaction and wallet-signing boundary.
- **Open:** Direct-entry economics, full-output routing proof and intended-network DEX coverage before implementation. No changes to pool accounting or system policy are approved by this research.
- **Refs:** `packages/cox-client/SWAP-PLAN.md`; current user direction; `product.md` v14 predates the expanded SDK scope.

### 2026-10-16 · Peter (Codex) · Direct-class and full-output SDK entry

- **Area:** `packages/cox-client`, new `packages/cox-router`, `product.md` v15; existing pool program unchanged.
- **What:** Peter selected direct collateral-to-performance-class entry with one deposit fee and required the full actual DEX output to be queued. Added class quotes/preparation/balances/request lifecycle, a routed-entry builder, a server-side Jupiter Build provider and a separate router that measures collateral increase and invokes the existing deposit ABI. Verification passes: 50 client tests/type check, 8 router host tests and 3 compiled LiteSVM tests, including excess output, existing-balance preservation, rollback and next-publication single-fee fill.
- **Rules for agents:** Queue the entire observed collateral increase, not the quoted minimum; preserve prior wallet collateral. No intermediate CRYPTO issuance or second switch fee. Keep future-publication eligibility, minimum units, refunds and fee-version protections. Treat compiled controlled-swap tests separately from live Jupiter proof. Faster publication is deferred; future epoch pools coexist with the current pool.
- **Open:** No router deployment or API/UI activation. Jupiter provider is mainnet-only while the current COX SDK remains devnet-only; require a same-network executable route and explicit composed API integration before claiming the live user journey works. Native SOL must already be wrapped; Token-2022 routes remain unsupported.
- **Refs:** `packages/cox-client/README.md`, `packages/cox-client/SWAP-PLAN.md`, `packages/cox-router/README.md`, `packages/cox-router/results/verification.json`; supersedes the unresolved direct-entry/full-output choices in the preceding swap research entry.

### 2026-10-18 · Peter (Codex) · Market halt traced to publisher RPC failure

- **Area:** Read-only pool 1 live API and dev VM publisher/archiver diagnosis.
- **What:** Live API reports latest publication sequence 9756 at cutoff 2026-10-18 06:10 UTC and automatic halted status after 60 missed cutoffs. Publisher remains active but has repeatedly received HTTP 502 `every upstream failed` through `cox-rpc-proxy.variance.space` since the 06:11 minute; its configuration has one RPC URL and no independent publisher fallback. Archiver remains active with current admissible 30-asset snapshots. Direct public devnet `getSlot` from the same VM succeeds. API reports no executing batch and matching vault/ledger (247156989 base units).
- **Rules for agents:** Distinguish publisher RPC/proxy outage from price-feed failure or a vault shortfall. A running service does not prove successful publication. Do not log authenticated RPC paths.
- **Open:** Proxy upstream failure cause and recovery; no service configuration, restart, deployment or on-chain state changed in this diagnosis.
- **Refs:** `apps/cox-publisher/src/config.ts`, `packages/app-api/src/cox-types.ts`, live `/v1/status`, VM service journal.

### 2026-10-20 · Peter (Codex) · SDK-only swap closeout and explicit Express capability

- **Area:** `packages/cox-client`, `packages/cox-router`; existing pool, UI and API unchanged.
- **What:** Peter limited closeout to SDK/contracts/tests/docs. Added typed direct/Express capability results, explicit Express opt-in, compatible-provider and executable-router checks, and early `SwapExpressUnavailable` errors with reasons. Direct entry needs no router or DEX credentials. Transaction preparation rechecks nonce, fee and plan integrity after composed simulation. Direct configuration is captured; adversarial router coverage expanded. All 56 client tests/type check, 12 host tests and 3 compiled LiteSVM tests pass; rebuilt router binary is unchanged. Source/artifact hashes and the checked closeout record are refreshed.
- **Rules for agents:** Express remains unavailable on the current devnet deployment: no reviewed router address or compatible live route is verified. Availability is a configuration check, not a guarantee of liquidity, pool readiness or reviewed binary identity. Preserve the mainnet-provider/devnet-pool guard. Controlled swap tests are not live Jupiter evidence. API/UI, dual-collateral support and deployment are separate work; do not add them to this closeout.
- **Open:** User review and commit approval. No staging, commit or deployment performed; keep this agent-log entry in its own commit and preserve earlier uncommitted entries and unrelated changes.
- **Refs:** `packages/cox-client/SWAP-PLAN.md`, `packages/cox-client/README.md`, `packages/cox-router/results/verification.json`.

### 2026-10-20 · Peter (Codex) · Shared working branch and swap commit approval

- **Area:** Repository workflow and swap SDK closeout.
- **What:** Peter approved splitting the reviewed changes into commits, pushing a new branch named `working`, and emailing Godwin with Joel copied. The shared continuation branch is `working`; bring in the latest team main before publishing it.
- **Rules for agents:** Continue new shared development on `working`, preserve local changes when switching, and keep agent-log commits separate. This approval supersedes the pending commit approval in the preceding SDK-only swap closeout entry. It does not authorise deployment or live Express activation.
- **Refs:** `packages/cox-client/SWAP-PLAN.md`, `packages/cox-router/results/verification.json`.

### 2026-10-20 · Godwin (Claude Code) · Web app: down page when the app cannot load

- **Area:** `apps/web` (`src/components/down-page.tsx`, `src/app/error.tsx`, `src/app/global-error.tsx`, `src/app/(app)/error.tsx`).
- **What:** On 2026-10-20 every app page returned Next's default "This page couldn't load" screen. Cloud Run `cox-app-api-live` could not start: its genesis check failed on `cox-rpc-proxy.anyaogupeter601.workers.dev` ("is not on the expected network", `apps/app-api/src/cox/rpc.ts:61`), the process exited before opening its port, and every API request got Google's HTML 500. `(app)/error.tsx` never ran because an `error.tsx` does not catch errors from the `layout.tsx` beside it, and `(app)/layout.tsx` is what fetches status and deployment. At Godwin's request a minimal down page (wordmark, "Temporarily down", "We'll be back in a few minutes", positions safe on chain, Try again reloads) is now shown by a root `error.tsx`, a `global-error.tsx` and `(app)/error.tsx`. Checked locally against the failing live API on desktop and phone widths.
- **Rules for agents:** Errors thrown in `(app)/layout.tsx` are caught by `src/app/error.tsx`, not `(app)/error.tsx`; keep that root boundary. The down page shows no error detail or digest.
- **Open:** Joel/Peter: the RPC proxy upstream (likely the same outage as Peter's 2026-10-18 "Market halt traced to publisher RPC failure" entry) and whether the API's start-up genesis check should fail over to the next RPC instead of exiting. Joel: `packages/app-api/src/cox-client.ts` calls `res.json()` on any response, so an HTML 500 surfaces as "Unexpected token '<'" instead of an HTTP status. Not redeployed to Vercel.
- **Refs:** commit `322af5d`.

### 2026-10-20 · Peter (Codex) · Legacy pool retired and owners paid automatically

- **Area:** `packages/cox`, `packages/cox-client`; devnet pool 1.
- **What:** Peter approved retirement-only commit `e7beb50`, program upgrade and automatic owner payouts. Deployed executable SHA-256 `453dd32179ea2fad1813138f4c83738c742bfeeb34ff097a76e4d0e9332837ad` matches the isolated committed build. Paused registry, froze sequence 9756 and its existing state digest, retired all four positions and paid 247.077151 official devnet USDC directly to their owner-controlled token accounts. All four payments finalized; final audit slot 513274208 confirms zero active backing, pending principal, owner payables, refundable balances, position units and locks. Vault retains 0.059409 protocol fees plus 0.020429 residual; deployment buffer was consumed.
- **Rules for agents:** Pool 1 is irreversibly retired (pool schema 3) and registry remains paused. Do not resume its publisher or treat retained publication references as live trading. Preserve historical publications and owner receipts. `pay_retirement` requires no owner signature, pays only the position owner's collateral token account and cannot redirect custody. New Basic/Epoch work remains separate and uncommitted.
- **Open:** Deployment-record and agent-log updates remain uncommitted; no new pool activation or service rollout occurred. The retirement-only commit is local on `working`.
- **Refs:** `packages/cox/deploy/deployed-devnet.json`; 68 SDK tests/type check, 34 compiled contract tests and captured-live-account payout rehearsal passed before deployment.

### 2026-10-21 · Peter (Codex) · Native rewrite ownership boundary

- **Area:** Peter-owned protocol publisher, oracle verification, benchmark calculation and settlement workers.
- **What:** Peter requested a native rewrite for critical server paths and clarified ownership: APIs belong to Joel, web to Godwin, protocol and contracts to Peter. Rust is the selected publisher implementation; existing TypeScript remains a behavioural comparison during migration.
- **Rules for agents:** Do not rewrite Joel's API/signing service or Godwin's web application under this migration. Proxy retirement may change private RPC configuration using their existing interfaces. Keep the legacy pool retired and its publisher stopped. Do not claim a language change guarantees one-second end-to-end latency; measure calculation, signing, RPC and confirmation separately.
- **Open:** Native implementation and measured verification; no replacement pool or native service activation.

### 2026-10-21 · Peter (Codex) · Protocol signer scope and direct developer follow-ups

- **Area:** Protocol publisher and `apps/signer`; developer handoffs.
- **What:** Peter explicitly authorised protocol-required signer changes and instructed the agent to email Joel and Godwin whenever their fixes and pushes are needed, without waiting for immediate replies. This supersedes the signing-service exclusion in the preceding Native rewrite ownership boundary entry; API and web ownership remains unchanged.
- **Rules for agents:** Keep signing authentication, key separation and instruction restrictions intact. New transaction formats and protocol bindings require explicit configuration; do not broaden live signing permissions automatically. Send concrete integration requests and ask developers to push shared work to `working`.
- **Open:** Native publisher runtime composition and new protocol signing bindings remain unfinished; no new pool or native-service activation.

### 2026-10-21 · Peter (Codex) · Native publisher entry point and reusable Rust methodology

- **Area:** `apps/cox-publisher/native`, `packages/cox-methodology/rust`, publisher package scripts and service template.
- **What:** Connected native Pyth verification, independent geometric calculation/history, processed gRPC wakeups, confirmed account reads, bounded Basic/Epoch execution, remote signing and durable transaction recovery. Default publisher commands and service template now select Rust; TypeScript is explicitly retained for legacy comparison. Moved inclusion and exact-rational Epoch research simulation into the reusable `relative-methodology` crate. Verified 53 publisher and 15 methodology Rust tests, 130 publisher and 33 methodology legacy tests, legacy publisher type-check and disabled CLI startup. Read-only Alchemy devnet simulation accepts a 1,790-byte V1 transaction after explicitly setting its loaded-account data budget; zero transactions submitted.
- **Rules for agents:** A partial port is not a runtime migration: distinguish implemented modules, selected entry points and live deployment. Preserve publisher state and archive-before-overwrite protection. Native archive v2 records are confirmed observations, not finalized evidence. Keep legacy TS methodology until Joel migrates API fixture/provenance imports; Joel was emailed with Godwin copied. Retain shared price feeds and the independent monitor. Native service expects private `native.json` and `native.env`; old minute-publisher configuration is incompatible.
- **Open:** No commit, new pool deployment or service activation. New protocol signer bindings, larger-pool account discovery/pagination, dynamic inclusion integration and historical Pyth backfill remain separate work. Retired pool 1 remains rejected. Whole-directory deletion is not yet safe; retirement scope is publisher TS implementation, methodology TS protocol implementation after consumer migration, and the protocol RPC-proxy dependency.
- **Refs:** `apps/cox-publisher/README.md`, `packages/cox-methodology/README.md`; native tests and ignored `.cox/native-transaction-verification.json`.

### 2026-10-21 · Peter (Codex) · Adaptive custody and native recovery verification

- **Area:** `packages/cox`, `packages/cox-client`, `apps/signer`, `apps/cox-publisher/native`, publisher service templates.
- **What:** Verified default Basic compiled runtime (42 passing, one captured-live test ignored) and devnet dual collateral (45 passing, one ignored). SDK accepts either configured mint against combined reserves, binds the second vault, checks selected-mint liquidity and supports partial refunds without changing original principal. All 78 client tests and TypeScript checks pass. Signer pins optional dual custody and Epoch snapshot closure; 49 tests and type checks pass. Native publisher passes 82 tests, including paged discovery, optional custody ABI and 11 local backup/recovery tests; backup service template now selects Rust.
- **Rules for agents:** Combined reserves do not guarantee liquidity in each mint. Dual collateral is a default-off devnet feature; never enable it in production. Snapshot rent returns only to the configured operator after references are copied. Native archive v2 remains confirmed provenance. No new protocol was committed, deployed or activated by this verification.
- **Open:** Truthful adaptive methodology commitment, dynamic inclusion integration, deployment/configuration and actual Cloud Storage backup/IAM verification remain unfinished. Do not treat green local tests as live signer/service integration.
- **Refs:** `packages/cox-client/README.md`, `apps/signer/README.md`, `apps/cox-publisher/README.md`.

### 2026-10-21 · Peter (Codex) · Activation target postponed twelve hours

- **Area:** New Basic/Epoch rollout timing and developer handoff.
- **What:** Peter moved the target from 2026-10-22 00:00 UTC to 2026-10-22 12:00 UTC (13:00 Lagos), because Joel is temporarily unavailable. Updated the private activation intent and emailed Joel with Godwin copied.
- **Rules for agents:** This is an unarmed target. Complete protocol verification and Joel's new-deployment API integration before configuring activation. Godwin's UI deployment remains independent. Legacy pool 1 stays retired and paused; shared work continues on `working`.
- **Open:** New pools and native service have not been activated.

### 2026-10-21 · Peter (Codex) · Versioned adaptive methodology and cross-pool verification

- **Area:** `packages/cox`, `packages/cox-client`, `apps/signer`, `apps/cox-publisher/native`, Epoch compiled tests.
- **What:** Added typed canonical adaptive methodology, schema-2 sealing and legacy/schema separation without changing Methodology account layout. Genesis prices must match the sealed origin. Native publisher validates canonical bytes and binds feed IDs, original prices, universe, geometric origin and freshness settings; Basic and Epoch must share the methodology digest. SDK adds the seal builder and schema-2 readers. Three compiled combined tests verify shared-snapshot Basic/Epoch execution, snapshot rent recovery and rollback when either pool fails late.
- **Rules for agents:** Legacy JSON/minute policy is schema 1; adaptive canonical policy is typed Borsh schema 2. Sealed policy is a commitment, not an on-chain Pyth/formula proof. Preserve permanent origins separately from scheduled admission. Combined compiled runtime success is not live V1 transport or remote-signer evidence.
- **Open:** Release remains uncommitted and undeployed; live signer bindings, V1 end-to-end and API integration remain readiness requirements.
- **Refs:** `apps/cox-publisher/README.md`, `packages/cox-client/README.md`; final verification: 46 default Basic and 49 dual Basic compiled tests (one captured-live test ignored in each), 79 client tests, 52 signer tests, 91 native tests, 14 Epoch compiled tests including 3 cross-pool tests. Client/signer type checks pass.

### 2026-10-21 · Peter (Codex) · Immutable inclusion and methodology preparation

- **Area:** Rust methodology transition module and native preparation commands.
- **What:** Added strict create-only `prepare-inclusion` and `prepare-methodology` commands. Inclusion artifacts bind universe lineage, explicit asset/feed mappings, retained permanent references and outstanding activation blockers. Methodology artifacts produce actual canonical bytes, digest, PDA and seal/admission arguments. Native benchmark supports 256 assets; methodology has 17 passing tests.
- **Rules for agents:** Preparation does not activate assets or authenticate operator-supplied historical references. Current Basic runtime remains limited to 30 assets. Dynamic Basic roster, Epoch snapshot staging, verified activation price capture and runtime transition integration remain outstanding; do not claim live continuous inclusion is complete.
- **Refs:** `apps/cox-publisher/README.md`, `packages/cox-methodology/rust/src/transition.rs`.

### 2026-10-21 · Peter (Codex) · Deployable Epoch identity and guarded infrastructure preparation

- **Area:** `packages/cox-epoch`, native Dockerfile, `deploy/dev/native-publisher-release.py`.
- **What:** Read-only devnet check found the earlier Epoch placeholder undeployed and without a local program key. Generated a separate ignored mode-0600 program key and updated the declared identity, IDL and public prepared deployment record to `4RRBbmzExtPDMYNUgCaetfz3wNYkF2mrAYKZVY4iXz2w`. Rebuilt both Epoch variants and reran all 14 compiled tests. Added source-only committed-release staging, reviewed artifact hashes, pinned Linux build inputs and disabled/unarmed devnet preflight; four infrastructure tests pass. New read-only native feed probe verified 30 Pyth signatures/prices, whole-second alignment and Alchemy gRPC with zero submitted transactions.
- **Rules for agents:** Program identity generation does not deploy a program. Operator keys remain in KMS. Never stage secrets or claim hash integrity proves source-build provenance. Docker daemon was unavailable; Linux release build and live backup/remote-signer rollout are unverified. Target remains 2026-10-22 12:00 UTC, unarmed. Joel received endpoints and the existing Secret Manager reference only; Peter declined emailing live API keys.
- **Open:** Commit approval, committed Linux build, contract/service deployments, explicit signing bindings and live end-to-end/recovery verification.
- **Refs:** `packages/cox-epoch/deploy/devnet.json`, `deploy/dev/README.md`; Epoch single SHA-256 `f53f3f29c5e795a8f1d1af73aab474283f0da4282de790cb5e108b73542fd3a7`, dual `b6dd486b206f4038daab1bc3a6696cffc3f40ad389e8b9b15eec797a5a20f6d7`.

### 2026-10-21 · Peter (Codex) · Approved checkpoint pushed and devnet programs deployed

- **Area:** Shared `working` branch, Basic/Epoch deployment records and native infrastructure.
- **What:** Peter approved scoped commits. Created seven, rebased onto the team branch while preserving Godwin's append-only log/web changes, and pushed through `5f1e382c6bb23301110e12872beab5d826bbf0d5`. Rebuilt committed dual artifacts and deployed Basic upgrade `675c77dc7ef4822c099fdccf8bf83cbf8259b81713388dbe2431512711cc92ee` plus separate Epoch `b6dd486b206f4038daab1bc3a6696cffc3f40ad389e8b9b15eec797a5a20f6d7`. Finalized executable bytes, zero allocation padding and separate upgrade authorities match. Retired pool 1 and registry bytes are unchanged. No new pools initialized or activation armed.
- **Rules for agents:** Retirement commit `e7beb50` was already represented remotely by `7846c57`; rebase correctly skipped the duplicate patch. Verify genesis using the exact CLI connection before broadcasting; incomplete CLI YAML can silently fall back to defaults. Keep upgrade/program keys distinct from the KMS operator. `devnet-collateral` is explicitly enabled only for this devnet release.
- **Refs:** `packages/cox/deploy/deployed-devnet.json`, `packages/cox-epoch/deploy/devnet.json`.

### 2026-10-21 · Peter (Codex) · Linux release staged and live fixture recovery verified

- **Area:** Native publisher Linux release and European dev VM infrastructure.
- **What:** Built committed source with Rust 1.90.0 and digest-pinned Linux images; executable SHA-256 `4a5c4b8773e2ad05fa15c09e9ba754f111ed1e496dc092c0c1d1f5180531238c`. Installed under the immutable commit release directory on `eox-dev` in `europe-west1-b`; current symlink remains `fees-658afd5`, publisher inactive/disabled. Three explicitly isolated fixture files backed up to the existing private Cloud Storage bucket and restored with exact hashes using VM workload identity. Native server probe verified signed one-second Pyth prices for all 30 feeds plus Alchemy gRPC, submitting zero transactions.
- **Rules for agents:** The old US `eox-dev` in `us-central1-a` is terminated; use the current deployment guide/European zone, never start the old VM as a workaround. Fixture recovery proves transport/integrity, not recovery of real active pool history. Existing legacy backup timer was preserved. No temporary probe credentials remain on the VM. Do not switch the publisher or enable V1 signer permissions before verified pool/config bindings exist.
- **Open:** New pool/methodology initialization, native runtime configuration and service switch, signer image/bindings, live V1 protocol end-to-end, dynamic inclusion integration and Joel API handoff. Target remains 2026-10-22 12:00 UTC, unarmed. Joel and Godwin were emailed the pushed checkpoint; live API keys were not emailed.
- **Refs:** `apps/cox-publisher/README.md`, `deploy/dev/README.md`; ignored `.cox/native-vm-staging-verification.json` and `.cox/native-server-feed-verification.json`.

### 2026-10-22 · Peter (Codex) · Real origin and inactive adaptive pool accounts prepared

- **Area:** Native origin capture, Basic pool 2, Epoch config 2 and integration record.
- **What:** Added tested `capture-origin`; captured 30 actual Pyth Pro prices at 2026-10-21 23:05:21 UTC, with signed payload and trusted-storage provenance, then used the Rust methodology preparer to seal digest `2b8360bed080095ebd1a0a8ca81479010580d24d771881b59b6b86557964bdba`. Initialized Basic pool `HPnHZGLeQ8oisu3V8ZEBfPRT2Sai8XWnpfQmcZ8sTZE4`, dual custody and pending 2-bps/$0.20 fee. Created Epoch config `61LyZqtLHzdqDKZ5qsK7c6xU5R9F5HaNbpaX77kRyiq9`, grew its 12:00 UTC draft to 64,000 bytes and appended the 30-member universe. Finalized audit slot 513684272 verifies exact identities, zero custody balances and unchanged retired pool 1.
- **Rules for agents:** Registry remains paused; Basic has no initial publication. Epoch stays unsealed because it has no Basic-style global pause and would otherwise admit entries automatically at opening. The fixed genesis price-universe commitment is not an inclusion `UniverseSnapshot`; no token mints were invented for price-only instruments. Pyth catalogue Core identities are explicitly mapped to signed Pro numeric feeds.
- **Open:** Bootstrap Basic and finalize the initial fee configuration before admission; live V1 signer/publication checks and readiness decision still required. Disabled native configuration and original signed observation are installed on the European VM; service/current release remain unchanged. Joel and Godwin received actual account identities without credentials.
- **Refs:** `packages/cox/deploy/adaptive-pool-2-devnet.json`, `apps/cox-publisher/README.md`.

### 2026-10-22 · Peter (Codex) · Initial fee wake-up and dual fee-builder correction

- **Area:** Native chain work planning and SDK admin fee builders.
- **What:** A due pending fee schedule now creates one price-publication task without waiting for user orders; future schedules retain idle polling, pause/bootstrap/accepted-batch rules remain authoritative and the task ends when the pending schedule clears. Fee configuration builders now omit the secondary custody account, which their on-chain admin context does not accept. Capture and fee regressions bring native verification to 96 passing tests; SDK has 80 passing tests and TypeScript checks pass.
- **Rules for agents:** Fee scheduling alone does not activate fees. Finalize a qualifying publication and verify active version, 2 bps and 200,000-base-unit cap before opening. Never allow the first user batch to inherit zero initial fees accidentally. Publisher work planning changes timing of configuration commitment, not economic arithmetic.
- **Open:** New source and this agent log await commit approval before the next native release build. Signer image from committed `5f1e382` passes 52 tests; its new target configuration remains explicitly disabled, with no live traffic promotion authorised by these facts.
- **Refs:** `apps/cox-publisher/native/src/chain.rs`, `packages/cox-client/test/client.test.ts`.

### 2026-10-22 · Peter (Codex) · Disabled signer revision verified from publisher identity

- **Area:** Signer candidate image, Cloud Run canary and native configuration.
- **What:** Built signer source from committed `5f1e382` in a 41-file allowlisted context excluding secrets; all 52 container tests and type checks pass. Pushed a config-only image layer with both new targets disabled and deployed `eox-signer-adaptive-5f1e382-disabled` at zero traffic. Existing revision retains 100%. The European VM's authorised publisher identity received HTTP 200 from canary health and key-directory endpoints, matching operator, KMS version and network. No signing endpoint calls or transactions occurred. Installed actual native configuration disabled and original signed observation with restricted permissions; current service/release remain unchanged.
- **Rules for agents:** Do not infer signing or transaction execution from authenticated key-directory success. New target enablement, traffic promotion, Basic bootstrap and fee finalization remain explicit remaining steps. Preserve existing RPC secret, workload identity and IAM. Local activation intent now records prepared pool accounts, paused Basic and unsealed Epoch; no activation is armed.
- **Refs:** `apps/signer/README.md`; private `.cox/signer-disabled-revision-verification.json` and `.cox/adaptive-readiness-checkpoint.json`.

### 2026-10-22 · Joel (Claude Code) · Fixture on the Rust CLI; app API reads Basic pool 2 and Epoch (not deployed)

- **Area:** `apps/app-api`, `packages/app-api`, one line in `apps/web/src/lib/view.ts`; branch `working`.
- **What:**
  - **Fixture:** Peter's request done. `scripts/cox-fixture-build.ts` gets every `reference`, `revalue` and `batch` result from the Rust `cox` CLI (`COX_CLI`, or `cargo run`) and no longer imports `packages/cox-methodology`. Provenance hashes `Cargo.lock` and every `.rs` file under `crates/math/src` and `crates/cli/src`, with line endings normalised. Fixture economics are unchanged; `reference` is still the legacy arithmetic benchmark. Joel confirmed that Peter wants only publisher-touching code in Rust; the API stays TypeScript.
  - **Basic pool 2:** adaptive pools (schema 4) read correctly: Borsh methodology `COX/METHODOLOGY/ADAPTIVE/V1`, Pyth prices (`venue: "pyth"`, step 0), one-second batches from a non-minute origin, and both vaults in reads, reconciliation and every builder. Deposits, refunds and withdrawals take an optional `collateralMint`. Fees count as migrated for schema 4. `deployment` gains `mode`, `publicationIntervalSeconds`, `tradingOpensAt` and `secondaryCollateralMint`; `status.trading` gives `{ open, gate, opensAt }`. Trades and quotes return 409 `TRADING_CLOSED` while the pool is retired, paused, uninitialised or before `tradingOpensAt`.
  - **Archive v2:** `cox.publication-archive/v2` records (`commitment: "confirmed"`, `observedSlot`) are read and served with `finalization.finalized: false`. A record mixing v1 and v2 provenance is refused.
  - **Epoch:** with `COX_EPOCH_CONFIG`, the API serves `GET /v1/epochs`, `/v1/epochs/:opensAt` and `/v1/epochs/:opensAt/lots?owner=`, plus builders `POST /v1/transactions/epoch-entry` and `epoch-withdraw`. Submission relays the user-signed Epoch instructions `queue`, `withdraw` and `withdraw_partial`.
  - **Verified:** 72 app API tests pass and the web app type-checks. A read-only local run against devnet (public RPC) reported pool 2 correctly: adaptive, paused, opening 12:00 UTC, active fees version 0 with version 1 scheduled, 30 assets and both mints. It returned `TRADING_CLOSED` for builds and quotes, and showed the 12:00 Epoch draft `J8c7…VQs` with 30 members.
- **Rules for agents:**
  - Count adaptive `expiryBatch` in seconds; a minute-pool "plus 3 batches" means 3 seconds on pool 2.
  - Never present a v2 archive publication as finalized.
  - Epoch asset ids are the same 0–29 roster indexes as Basic.
- **Open:**
  - **Deployment:** nothing here is deployed. Cloud Run and the VM still point at retired pool 1. Switching them to pool 2, `COX_EPOCH_CONFIG` and the direct Alchemy secret `cox-direct-alchemy-devnet-rpc-urls` needs Joel's approval.
  - **Archive path:** pool 2's archive location is not configured yet (Peter's native archive path or bucket).
  - **Previews:** live benchmark and portfolio previews from the Pyth stream need the Pyth key and are not built.
  - **Godwin:** web changes for one-second expiry, `status.trading`, the second mint and the Epoch routes.
- **Refs:** `apps/app-api/README.md` (Adaptive pools and Epoch), commits `0f42194`..`11c49ed`.

### 2026-10-22 · Joel (Claude Code) · Correction: app API test count

- **What:** Corrects the 2026-10-22 "Fixture on the Rust CLI; app API reads Basic pool 2 and Epoch (not deployed)" entry. 67 app API tests pass, not 72, and nothing else in that entry changes.

### 2026-10-22 · Joel (Claude Code) · Live APIs switched to Basic pool 2 and Epoch config 2

- **Area:** Cloud Run `cox-app-api-live`, dev VM `cox-app-api-live`, `deploy/dev`, `pnpm-workspace.yaml`.
- **What:** With Joel's approval, both live APIs moved off retired pool 1.
  - **Cloud Run:** revision `cox-app-api-live-00009-jw9` (image `cox-app-api:d03dba2`) serves 100% at `api.getrelative.trade`. Traffic had been pinned to `00007-c8q`; Peter's failed `00008-ksl` never took it. Settings: `COX_POOL_ID=2`, `COX_POLL_MS=1000`, `COX_EPOCH_CONFIG=61Ly…yq9`, and history in `gs://colosseum-cox-app-api-history-dev/pool-2/`. RPC is the direct Alchemy secret `cox-direct-alchemy-devnet-rpc-urls` (Alchemy, then public devnet), and the pool 1 archive variable is removed. Firestore has a TTL policy for `coxSubmissionsPool2`.
  - **VM:** `cox-app-api-live` runs at `669c0ae` with the same pool, Epoch and polling settings. Its RPC list is the same secret, kept in the root-only `/opt/eox/cox-app-api-live.env`.
  - **Install fix:** VM installs failed on `working` (`ERR_PNPM_IGNORED_BUILDS`) for `@reown/appkit` and `keccak`, browser-only dependencies of the web login. `pnpm-workspace.yaml` now denies their install scripts.
  - **Verified from outside:** pool 2 is adaptive, interval 1, gate `paused`, opening 1792670400. Fees show version 0 active and version 1 (2 bps, cap 200,000) scheduled. The Epoch draft `J8c7…VQs` lists 30 members. CORS `*` works, quotes return 409 `TRADING_CLOSED`, and the new revision logged no errors.
- **Rules for agents:** Peter's native publisher can publish every second while the API polls each second, so a publication overwritten between polls can only be recovered from an archive. Without one the indexer stops at the gap and says so; it never skips it.
- **Open:**
  - **Peter:** where the native publisher's pool 2 archive will be readable before 12:00 UTC. The VM API can read a local directory (`COX_PUBLICATION_ARCHIVE`). Cloud Run needs per-sequence records in Cloud Storage; the native backup's object and manifest layout is not that format.
  - **Fixture API:** `cox-app-api` on Cloud Run still runs the previous image and lacks the new fields.

### 2026-10-22 · Peter (Codex) · Activation postponed and pool 2 archive export prepared

- **Area:** Native publisher, release preflight and adaptive pool deployment record.
- **What:** Peter postponed Basic activation another two hours to 2026-10-22 14:00 UTC, still unarmed and registry-paused. Its immutable on-chain lower bound remains 12:00 UTC. Prepared the aligned 16:00 UTC Epoch draft `CV3mYahZPMqbzfPLzxf74TLKNBXsgN4yzPS5wApMELwz` with all 30 assets, unsealed; the 12:00 draft remains unsealed. Disabled VM configuration now targets 16:00, with no runtime identity established. Native validation permits first Epoch opening after Basic's lower bound; prepared-release checks preserve disabled/unarmed gates and four-hour Epoch alignment.
- **Rules for agents:** A target is not an automatic activation. Keep registry paused and both drafts unsealed until readiness. Joel/Godwin received the revised timing and archive contract by email. API backfill URL is `gs://colosseum-cox-publication-archives-dev/pool-2/history/`, with `<decimal sequence>/<sha256>.json`; local records are `/var/lib/cox-publisher/basic-2-adaptive/publications/<sequence>.json`. New optional Rust backup export verifies account identity, sequence and provenance and preserves exact v2 confirmed bytes. Recovery CAS under `basic-2/native` is separate. Cloud export lags successful backup runs; latest publication remains on chain until archived before its next overwrite. Never label confirmed records finalized.
- **Open:** Export/source changes are tested but not committed or installed. No pool 2 publication exists yet. Commit approval and verified native release/backup rollout remain necessary before the API can depend on the cloud path. Initial Basic bootstrap must complete before its existing 12:00 on-chain lower bound; actual admission stays gated until the postponed target or later readiness.
- **Refs:** `apps/cox-publisher/README.md`, `packages/cox/deploy/adaptive-pool-2-devnet.json`; 99 native tests and 5 release-tool tests pass.

### 2026-10-22 · Peter (Codex) · Rust publisher and pool 2 cloud history live while paused

- **Area:** Native runtime/backup on European dev VM, Basic pool 2 and deployment evidence.
- **What:** Approved source pushed through `027fd7420021742cf86b3174caea69177f3ad771`; pinned Linux executable SHA-256 `1f45ed0368499d0e281194c755db2ba6c1c3f76613a00a318afb29c1df132dcd` passed direct devnet/source/artifact checks and is installed/running. A bounded real canary-signed bootstrap completed eight successful finalized pool transactions, initial publication and due-fee activation. Finalized audit slot 513865679 verifies sequence 1, active fee version 1 at 2 bps/cap 200000, no active batch/user requests, zero custody and registry paused. Legacy pool 1 remains retired/empty; both Epoch drafts are unsealed.
- **Rules for agents:** Native config identity is now established with `enabled=true` and first Epoch 16:00 UTC; stop the service rather than toggling enabled or changing its bound config. A legacy `pool-1.conf` service override required a lexically later `zz-native.conf` to select Rust; verify actual ExecStart when changing units. Runtime uses the enabled signer canary; default signer traffic remains unchanged. Pool 2 archive URL is live, exact publication 0 bytes downloaded/hash/identity checked. Existing API identity already has bucket objectViewer; Joel was emailed to connect the URL and verify gap recovery. No API source/deployment was changed here.
- **Open:** Actual Basic admission still targets 14:00 UTC under the registry gate; Epoch targets 16:00 UTC and remains unsealed. Real user entry/redemption and live Epoch settlement are not established by empty-pool bootstrap. Backup timer is enabled and a real 69-file recovery manifest restored into an isolated directory; incremental upload/retention optimization remains necessary for sustained price history. API backfill integration and remaining inclusion/readiness work remain outstanding.
- **Refs:** `packages/cox/deploy/adaptive-pool-2-devnet.json`, `apps/cox-publisher/README.md`; cloud prefix `gs://colosseum-cox-publication-archives-dev/pool-2/history/`, recovery manifest `d9bee9c4861266da3f1940d98eddd6186231451a7d41ada9cb22591664260e7e`.

### 2026-10-22 · Peter (Codex) · Retired publisher and methodology TypeScript removed

- **Area:** `apps/cox-publisher`, `packages/cox-methodology`, native backup references, root commands/lockfile and existing docs.
- **What:** Peter approved cleanup before dynamic inclusion, live Basic deposit/redemption and incremental backup/retention work. Removed the retired TypeScript publisher/methodology source, comparison tests, old publisher config, unused draft manifest, JS package exports/dependencies and fixture-generator commands. Removed the retired TypeScript backup script after the real native backup/restore verification. Rust crates and shared protocol fixtures remain unchanged. Joel's API fixture builder already uses the Rust CLI, so its former imports no longer block removal. Updated stale executable documentation paths; historical economic specifications and append-only logs remain intact.
- **Rules for agents:** Publisher/methodology package directories remain required for Rust. Do not restore TypeScript arithmetic or create a second fixture oracle; check retained vectors through Rust. API, web, browser SDK, signer and unrelated local files are outside this cleanup. Proxy code/deployment is retained while Joel/Godwin confirm external consumers; protocol and live API no longer require it. No new plan file was created.
- **Open:** Cleanup awaits commit approval; dynamic inclusion still needs the actual versioned contract/runtime transition, not a preparation flag. The deployed native binary is unaffected by these source deletions. Proxy deployment retirement requires its consumer check.
- **Refs:** `apps/cox-publisher/README.md`, `packages/cox-methodology/README.md`; 99 native and 17 methodology tests pass, frozen offline workspace lock validation and client type check pass, shared Rust CLI vectors pass (9 arithmetic, 2 price, 1 snapshot). Lockfile change removes only the publisher importer dependencies; unrelated dependency resolutions are preserved.

### 2026-10-22 · Joel (Claude Code) · Pool 2 archive connected; RPC proxy no longer used by Joel's services

- **Area:** `apps/app-api` (`src/cox/chain.ts`), `deploy/dev`; Cloud Run `cox-app-api-live`, dev VM `cox-app-api-live`.
- **What:** Following Peter's 2026-10-22 archive emails, both live APIs read missed pool 2 publications from `gs://colosseum-cox-publication-archives-dev/pool-2/history/` (`COX_PUBLICATION_ARCHIVE_GCS`). Their service accounts already had read and list access. Adaptive pools now report `missedBatches: []`. Before, publication 1 listed all 43,319 idle seconds since publication 0, which made each response about 240 KB.
  - **Deployed:** Cloud Run `cox-app-api-live-00011-qbc` (image `cox-app-api:605e2ee`) and the VM at `4838161`. The VM's stale pool 2 cache was moved aside to `publications-2.jsonl.pre-4838161` and rebuilt.
  - **Verified:** both APIs serve publication 0 from the archive as `finalized: false` (observed slot 513864091) and sequence 1 from the chain. The pool reports paused, gate `paused` and the vault covered. 68 app API tests pass.
  - **RPC proxy:** the signer and both live APIs use the secret `cox-direct-alchemy-devnet-rpc-urls`. No VM env file or unit refers to `rpc.getrelative.trade` or `cox-rpc-proxy.variance.space`. Their remaining mentions are in `AGENTS.md`, `apps/rpc-proxy`, the domain table in `deploy/dev/README.md` and the retired `publisher-pool-1-devnet.json`.
- **Open:**
  - **Godwin:** check the Vercel values of `NEXT_PUBLIC_SOLANA_RPC_URL` and `COX_RPC_URL`. Unset, they fall back to public devnet.
  - **Secrets:** `solana-devnet-rpc-urls` and `cox-app-api-live-rpc-urls` are no longer used by these services and can be disabled once the proxy is removed.

### 2026-10-22 · Joel (Claude Code) · Live preview routes in the app API (not deployed)

- **Area:** `apps/app-api` (`src/cox/preview.ts`, server, stream), `packages/app-api`.
- **What:** Peter's publisher evaluates the methodology every second but publishes on chain only when there is work to settle. Peter confirmed on 2026-10-22 that it will export one `relative.preview/v1` record per second to `gs://colosseum-cox-publication-archives-dev/pool-2/preview/<unix seconds>.json`. With `COX_PREVIEW_GCS`, the API follows that prefix:
  - **`GET /v1/preview`:** `{ record, ageSeconds, stale }`, stale after 10 seconds without a newer record.
  - **`GET /v1/preview/portfolio?owner=`:** each position's `estimatedValue` from the publisher's `basicProjection`.
  - **Stream:** `preview` events on `/v1/stream`.
  - **Client:** `preview()`, `previewPortfolio(owner)` and the `preview` stream event in `@eox/app-api`.
  - **Checks:** each record's network, program, pool, methodology, scales, asset order and CRYPTO row must match before it is relayed unchanged. Missing seconds stay gaps.
  - **Verified:** 76 app API tests pass, with constructed records only.
- **Rules for agents:**
  - Previews are estimates. Never present one as confirmed, and never confirm one because a later publication arrived; committed values come from publications.
  - The API computes no reference or redistribution. A wallet estimate exists only when `basicProjection` starts from the pool's latest publication; otherwise `unavailable` says why and every value is `null`.
- **Open:**
  - **Peter:** a real uploaded sample. No preview object exists yet, and nothing is deployed; the parser may need adjusting to the real record.
  - **Godwin:** show previews between publications, labelled as estimates and marked stale when `stale` is true.
- **Refs:** `apps/app-api/README.md` (Live previews), commits `a24a5f5`..`e5e0bd0`.

### 2026-10-22 · Peter (Codex) · Basic live verification exposed snapshot selection race

- **Area:** Devnet Basic pool 2 verification and native snapshot selection.
- **What:** Cloud command approval became available again. A fresh test wallet deposited 1,000,000 test-USDC base units into class 0 through the SDK, but native settlement timed out. Registry pause was restored. SDK cancellation and refund subsequently finalized, returning all 1,000,000 units with no trading fee; no redemption success is claimed. Authoritative request reads and unsigned publish/evaluate simulations succeeded. Found and locally fixed a timing race where a newer feed observation arriving during account reads hides the eligible archived observation at the tick timestamp. Added regression coverage and safe error-category logging; all 106 native tests pass.
- **Rules for agents:** Keep Basic paused and Epoch unsealed pending a successful live round trip. Exact Epoch closing timestamps and existing freshness/entry eligibility checks remain unchanged. The local timing fix is not evidence of a successful deployed repair. No operator key was created or copied; the isolated user test key is private under `.cox/keys`.
- **Open:** Scoped commit approval, release/install and another real deposit, settlement, redemption and withdrawal. Preview deployment and retention/incremental backup work remain outstanding.
- **Refs:** `apps/cox-publisher/native/src/runtime.rs`; private `.cox/basic-roundtrip-verification.json` records finalized deposit, pause restoration, cancellation and refund signatures.

### 2026-10-22 · Peter (Codex) · Basic deposit redemption and withdrawal verified live

- **Area:** Rust publisher rollout and devnet Basic pool 2 verification.
- **What:** Approved timing repair `69072b5` and separate log `3c5e73d` were rebased onto Joel's latest work and pushed. Built the isolated 100-test release from `3c5e73d3b61b661ababddfe6bc62aa9280f799ff`; installed Linux SHA-256 `0c6420d524c8c9e664d32b821eb81818b218464c9759800d499447671f77c952` without changing the bound configuration or signer traffic. A real SDK class-0 deposit of 1,000,000 test-USDC units settled at sequence 3, redemption settled at sequence 4, and withdrawal returned 999,601 units. Fees were 200 on entry and 199 on redemption. The verification harness was corrected to use the SDK's committed receipt interpretation; raw staged request status may remain queued after commitment.
- **Rules for agents:** Finalized audit slot 513977460 verifies Basic paused, no active batch, zero active/pending/payable liabilities, custody 399 units matching protocol fees, unsealed Epoch drafts and unchanged empty retired pool 1. Test wallet has no units, payable or refundable amount. This proves the test-collateral functional round trip, not official-USDC interchange, live Epoch settlement or one-second end-to-end latency. Publisher is active with zero restarts since installation. Joel and Godwin were emailed the outcome; previews remain separate and not deployed.
- **Open:** Per-second preview release, retention/incremental uploads, new activation readiness/timing and sustained-load latency verification. Dynamic inclusion remains deferred.
- **Refs:** `packages/cox/deploy/adaptive-pool-2-devnet.json`; finalized withdrawal `vS3aKdVNUjSko6brUbdWqfrtNm6uSQrDvCA17gjxrwzD7bwcyzNyrWSRHBobPFNs1YDGrVApZ9Y75jXW1RQqNos`.

### 2026-10-22 · Joel (Claude Code) · Preview routes deployed; pool 2 history records 1 to 3 copied to the bucket

- **Area:** Cloud Run `cox-app-api-live`, dev VM `cox-app-api-live`, `gs://colosseum-cox-publication-archives-dev/pool-2/history/`.
- **What:** Supersedes the "not deployed" status in Joel's 2026-10-22 "Live preview routes in the app API" entry. At Peter's request, `addedResidual` moved to the root of `basicProjection` (`0280222`).
  - **Deployed:** Cloud Run `cox-app-api-live-00012-4hz` (image `cox-app-api:0280222`) and the VM at `abbb511`, both with `COX_PREVIEW_GCS=gs://colosseum-cox-publication-archives-dev/pool-2/preview/`. `/v1/preview` answers 404 `NO_PREVIEW` until Peter's exporter uploads records.
  - **History gap:** the new Cloud Run instance rebuilt from the archive, which had only sequence 0. Publications 1 to 3 had lived only in the old instance's memory, so the public API showed no publications. At Joel's approval, the publisher's local `1.json` to `3.json` were copied unchanged to `history/<sequence>/<sha256>.json` with `--no-clobber`, from the VM's existing write-only bucket access. The name pattern matched `0.json`, whose local hash equals its bucket name. Cloud Run then served 0 to 4 without gaps, with 1 to 3 `finalized: false`, and the vault covered (399).
- **Rules for agents:** A Cloud Run restart rebuilds unsealed history (under 360 publications) only from the archive bucket. Until Peter's incremental backup keeps the bucket current, check that the bucket holds every sequence up to the chain's before restarting or redeploying Cloud Run. The VM API keeps its history on disk.
- **Open:**
  - **Peter:** incremental history uploads, and the first real preview record.
  - **Godwin:** preview display.

### 2026-10-22 · Peter (Codex) · Inclusion deferred to prioritize activation

- **Area:** Protocol work sequencing and local unfinished inclusion work.
- **What:** Peter deferred dynamic inclusion after it expanded beyond the activation window. Approved TypeScript cleanup was committed and pushed in `2fb7a7e` and `1f0642d`, superseding the earlier cleanup entry's pending-approval status. Unfinished inclusion changes were saved privately under `.cox/deferred-inclusion-20261022`, then restored out of the working tree; no inclusion upgrade was deployed.
- **Rules for agents:** Keep the existing 30-asset release for activation work. Do not resume inclusion or modify API/UI as part of this closeout. Preserve unrelated working-tree files.
- **Open:** Live Basic deposit/redemption, activation verification and incremental backup/retention remain outstanding.

### 2026-10-22 · Peter (Codex) · Per-second preview export prepared for Joel

- **Area:** Native publisher preview exporter and service template.
- **What:** Added a separate Rust export command for `pool-2/preview/<unix seconds>.json`, schema `relative.preview/v1`, containing source time, benchmark, 30 prices/references and optional Basic class backing projections using existing protocol maths. Confirmed ledger metadata is exported during existing reads; preview cloud retries do not block settlement. Joel was emailed the format, with Godwin copied, explicitly stating it is not deployed. All 105 native tests pass, including six preview tests; final diff whitespace check passes.
- **Rules for agents:** Treat previews as estimates, preserve source timestamps and missing seconds, and reconcile actual publications. References alone are not portfolio NAV. Publication history remains a separate archive. No new RPC reads, credentials, financial logic or activation changes belong in this exporter.
- **Open:** Source awaits scoped commit approval, Linux release and live installation/sample verification. Cloud checks/installation are blocked because automatic approval review hit an account usage limit; the rejected action did not execute. Scheduled targets have passed without activation executed by this work; current chain state requires fresh verification.
- **Refs:** `apps/cox-publisher/README.md`, `deploy/dev/cox-publisher-preview.service`, `apps/cox-publisher/native/tests/preview.rs`.

### 2026-10-22 · Peter (Codex) · Benchmark archive latency and cloud backup lag measured

- **Area:** Read-only latency audit of native benchmark files and cloud recovery/history.
- **What:** At 18:47 UTC, 1,790 immutable observations over 30 minutes had source-timestamp-to-local-file-write latency median 135.95 ms, p95 140.64 ms, p99 143.72 ms and maximum 159.61 ms. VM clock reports synchronized; the recent 598-observation ten-minute sample has no missing seconds. This includes feed delivery, validation, computation and file writing, not isolated CPU time or on-chain settlement.
- **Rules for agents:** Local benchmark availability is distinct from cloud delivery. At 18:48 UTC the newest completed cloud recovery manifest was uploaded at 11:30:02 UTC and contains benchmarks only through 11:28:10 UTC (about 7h20m behind). Recent 30-second/5-minute benchmark objects were absent. Backup service logs show repeated 120-second start timeouts. Cloud publication history still contains only sequence 0, despite local/on-chain progress to 4. APIs must retain honest archive-gap reporting; do not skip publications or label estimates confirmed.
- **Open:** Incremental uploads and retention must restore cloud progress and prioritize publication history. Per-second preview export remains separate and undeployed. No service, pool or API was changed by this audit.
- **Refs:** Private `.cox/benchmark-latency-audit-output.txt`, `.cox/benchmark-cloud-lag-audit.json`; existing backup implementation and service timeout in `apps/cox-publisher/native/src/backup.rs` and `deploy/dev/cox-publisher-backup.service`.

### 2026-10-22 · Peter (Codex) · Incremental archive recovery and retention prepared

- **Area:** Native backup/restore, preview release and operational service/policy files.
- **What:** Peter authorized archive repair, preview rollout and Basic activation after readiness. Prepared opt-in verified upload receipts, exclusive backup lock, publication-first ordering, 32 bounded uploads/restores, and restart progress reuse before a manifest exists. Local price retention accepts 36–48 hours, pruning only after a complete acknowledged cloud snapshot; latest observations, anchors, publication evidence and financial pointers remain. Local receipt garbage collection and three completed markers bound local metadata. Prepared seven-day cloud expiry only for preview and recovery-manifest prefixes; recovery CAS and publication history are preserved. Longer low-priority backup service startup accommodates initial catch-up.
- **Rules for agents:** Receipt reuse assumes immutable cloud objects; do not delete/overwrite recovery CAS objects or apply lifecycle expiry to that prefix. Clear receipts and fully revalidate if cloud immutability changes. Basic/Epoch remain paused/unsealed during installation and recovery verification. Preview residual is shared at `basicProjection.addedResidual`, not on each class row; Joel was emailed the required API correction.
- **Open:** Tested source awaits scoped commit approval before release; live catch-up, isolated restore, preview sample/consumer verification and Basic activation remain pending. No API/UI source was changed.
- **Refs:** `apps/cox-publisher/README.md`, `deploy/dev/cox-publisher-backup.service`, `deploy/dev/cox-publisher-preview.service`, `deploy/dev/cox-archive-lifecycle.json`; 111 native tests pass.

### 2026-10-22 · Peter (Codex) · Epoch lifecycle verified and next draft prepared

- **Area:** Epoch compiled verification, devnet config 2 and its next draft.
- **What:** Peter requested item 4 (Epoch verification/activation). All 17 engine tests and 13 compiled devnet runtime tests pass against the exact deployed binaries, covering candidate payouts, held fees, zero-score/unexecuted refunds, exact closing/void deadlines, dual custody, snapshot cleanup and combined Basic/Epoch rollback. The production-only dual-collateral rejection test was excluded from this devnet-artifact run; an obsolete single-build artifact initially failed its program-ID binding and was replaced by the verified deployed artifact for the devnet suite. No contract source changed.
- **Rules for agents:** Prepared 20:00–00:00 UTC draft `6nxNFyTzB8xNtDD1sQpkjTBh4K9xefVBrzmtr6e8ZZHo`, 30 exact configured assets, unsealed with empty vaults, finalized audit slot 513985219. A real devnet unsigned simulation of native V1 publication plus snapshot close succeeded at slot 513985894 (1,853 bytes, 45,416 compute units). This is simulation, not a live prediction or closing. Basic remains paused; existing runtime config identity and earlier drafts remain unchanged. Never seal an expired draft or change the four-hour clock to shorten verification.
- **Open:** Archive recovery/readiness still blocks enabling entries. Archive/preview release awaits commit approval. Once ready, seal a future boundary and verify a real entry, execution and exact-time closing/claim; a 20:00 epoch cannot complete before 00:00 UTC. If readiness misses opening, prepare a later draft instead.
- **Refs:** `packages/cox/deploy/adaptive-pool-2-devnet.json`; private `.cox/epoch-20-verification-preparation.json`, `.cox/epoch-live-publication-probe.json`, local test logs.

### 2026-10-22 · Peter (Codex) · Archive recovery verified and Basic opened

- **Area:** Rust publisher deployment, archive lifecycle, per-second previews and devnet Basic pool 2.
- **What:** Approved scoped release commits `1368920`, `93b8a85`, `b90429b` and separate log `1ec3d96` were pushed. Installed release `1ec3d96107bc8a42d177be9bb873badb6e75db3e`, executable SHA-256 `c2aa8c7bc0281b6bdd234b912c4cbfa9046a2ff4090285f0684cded7eac74b6b`. Both publisher/preview services are active with zero restarts; backup timer is active and the latest backup succeeded. Corrects the previous prepared entry's test count: 112 native tests passed.
- **Verification:** Restored and checksum-verified all 32,414 files from manifest `84af7fc872115fd36414e8e0549a487ff990a0dec0dff6e8e7bd2700413a750d` into an isolated directory; immutable runtime identity matches live. Incremental manifests are progressing again. Retention is 36 hours of local prices, 128 local publications, and seven days of cloud previews/recovery manifests; cloud recovery objects and publication history have no expiry. Existing manually copied history 1–3 received verified SHA metadata only, without changing bytes or object generations.
- **What:** Real previews reach both APIs. A 121-record steady sample measured cloud upload lag median 0.507 seconds, maximum 0.516 seconds; these are preview delivery measurements, not settlement latency. Public API confirms fresh estimates and covered custody. Basic unpause finalized at 20:19 UTC, signature `55rRjpkd3kwDEBvihrugW4MQ3a624CwSTm8zf9NX2THGtbJkZ1N7Kw3RkqMNTgWZP3qQ3LBubsAPsCSDgTEdAFhy`; SDK and public API confirm trading open, fee version 1 at 2 bps capped at 200,000 base units.
- **Rules for agents:** Supersedes earlier paused/undeployed/archive-blocked status for Basic and previews. Preview estimates remain distinct from committed publications; preserve immutable recovery objects. No API/UI source or bound runtime identity changed. Epoch's 20:00 draft missed opening and remains unsealed; never seal it late.
- **Open:** Epoch needs a future four-hour UTC draft and real entry, execution, exact-time close and withdrawal verification. Dynamic inclusion remains deferred. Godwin owns preview UI and the remaining proxy-consumer check; Joel's preview producer/archive blockers are cleared.
- **Refs:** `packages/cox/deploy/adaptive-pool-2-devnet.json`, `apps/cox-publisher/README.md`, `deploy/dev/cox-archive-lifecycle.json`.

### 2026-10-22 · Peter (Codex) · Next Epoch sealed for unattended live lifecycle verification

- **Area:** Devnet Epoch config 2 and isolated diagnostic runner; Basic unchanged.
- **What:** Peter requested the real four-hour verification first. Prepared and sealed Epoch `FN5K1VRfnvA1EyFMA3aa6mnpmBVchEXCPiBZdrzaktcq` for 2026-10-23 00:00–04:00 UTC with the exact 30 configured assets, finalized preparation slot 514004801. Seal signature `4WjvVxHstNumFBKdze4Qp4Wf7n8fqGrmYBPpiaN3ZFuszQuq7hrf5auHrHbjkrLhMz74iBT8Rb6q2xn3TQQuAwMV`. Small test wallet received 0.03 devnet SOL for rent; Peter explicitly approved copying its key to the VM after automatic review rejected the initial export. Admin/operator keys were not transferred.
- **Rules for agents:** Private isolated runner `cox-epoch-lifecycle-1792713600.service` waits until opening, queues two 100,000-base-unit test-USDC lots, observes native execution, requires the exact closing timestamp, checks integer candidate payouts and withdraws the wallet's claims. Preflight passed. Do not report this scheduled test as completed or shorten the four-hour clock. Keep Basic open and old expired drafts unsealed. Test records are private under `/var/lib/cox-publisher/epoch-lifecycle-1792713600`.
- **Open:** Real entry/execution and closing/payout/withdrawal results after 04:00 UTC. Alchemy measurements and dynamic inclusion remain explicitly deferred.
- **Refs:** `packages/cox/deploy/adaptive-pool-2-devnet.json`.

### 2026-10-22 · Peter (Codex) · RPC proxy retired and price-feed consumers checked

- **Area:** `apps/rpc-proxy` removal, workspace lock importer, existing documentation and Cloudflare deployment.
- **What:** Peter explicitly requested complete proxy retirement without waiting on frontend migration. Deleted Cloudflare Worker `cox-rpc-proxy` and its `rpc.getrelative.trade` / `cox-rpc-proxy.variance.space` custom domains; verified Worker/domain absence and preservation of the API, fixture and signer gateway domains. Public API still reports Basic open, covered custody and fresh previews. Removed six tracked proxy files and its lock importer; frozen offline lock validation passes with pnpm 10.34.7 and diff whitespace check passes. Historical deployment evidence remains intact.
- **Rules for agents:** Do not restore or depend on the proxy. Server transport is direct Alchemy with public devnet fallback. No API/UI source changed. `packages/price-feeds` is unused by Rust/Pyth but remains required by the live enabled `cox-archiver` and `cox-monitor` services; retain it until those consumers are separately retired or migrated. This supersedes the consumer-check gate in the 2026-10-22 TypeScript cleanup/Basic opening entries.
- **Open:** Scoped source/log commits await approval. Godwin should remove any old proxy URLs from Vercel environment configuration; the retired endpoint will not be restored for them.
- **Refs:** `deploy/dev/README.md`, `apps/cox-publisher/README.md`, `packages/price-feeds/README.md`.
- **Completion facts:** Peter approved the scoped commits and push. Both obsolete proxy-secret sets (`solana-devnet-rpc-urls` versions 1–2 and `cox-app-api-live-rpc-urls` version 1) are disabled; active direct-Alchemy version 1 remains enabled. Temporary checks are scheduled in this chat for entry and closing verification; remove the VM's isolated test-wallet copy after successful withdrawal. The live Epoch test remains pending the real clock.

### 2026-10-22 · Peter (Codex) · Event-driven publisher and shared notification release prepared

- **Area:** Rust publisher scheduling, gRPC, Pyth signer refresh, archive exporter and RPC diagnostics.
- **What:** Peter approved replacing continuous idle reads with event-driven work and a 20-minute safety reconciliation. Prepared filtered protocol/custody/signer-storage subscriptions, coalesced processed/confirmed notifications, exact future work wakeups, bounded confirmation retry and error backoff. Removed the 30-second idle timer and minute signer-key polling. Health leases write locally without RPC. Physical HTTP attempt counters record method, trigger and provider name without URLs or credentials.
- **Rules for agents:** Independent `pool-2/chain-changes/<20-digit Unix milliseconds>-<sha256>.json` records (`relative.chain-notification/v1`) continue during Pyth outages, with 20-second heartbeats and seven-day retention. Nested `chainChange` also appears on preview v1 records. Generation changes, confirmed relevant activity, stream catch-up or changed reconciled account data invalidate consumer caches; price-only updates do not. Notifications are not financial finality. Confirmed relevant activity outside the publisher's active working set must invalidate completed-Epoch wallet caches too. The liveness lease expires after 15 seconds; consumers mark missing notification heartbeats unhealthy after 60 seconds.
- **Open:** Source awaits scoped commit approval and isolated Linux rollout/live quiet-window verification. Joel was emailed the exact producer contract and owns removing API Solana polling and periodic wallet refreshes on VM/Cloud Run; his consumer deployment is required before total idle HTTP usage is fixed. Dynamic inclusion is separate unfinished work. Preserve the real 00:00–04:00 UTC Epoch test.
- **Refs:** `apps/cox-publisher/README.md`, `deploy/dev/cox-archive-lifecycle.json`; isolated native test context under private `.cox/billing-review-context`.

### 2026-10-22 · Peter (Codex) · Exchange services and source packages retired

- **Area:** `apps/cox-monitor`, `packages/price-feeds`, exchange-only `packages/ingestion`, root commands, lock importers and shared VM setup.
- **What:** Peter explicitly approved retirement. Both VM services are stopped, disabled and masked; an idempotent shared-setup helper prevents their restoration. Removed their source/deployment hooks and retained four recorded venue samples under protocol fixtures. Native publisher/preview remain active. Historical evidence API health and a cutoff page were verified after retirement; database records, state directories and publication archives were preserved.
- **Rules for agents:** Do not restore exchange fetching or the obsolete monitor as a fallback for native Pyth. Historical evidence access remains supported; preserve append-only data. This supersedes the keep-price-feeds decision in the earlier RPC proxy retirement entry.
- **Open:** Scoped source/log commits await approval. No replacement polling monitor is introduced.
- **Refs:** `deploy/dev/retire-exchange-stack.sh`, `deploy/dev/README.md`, `apps/evidence-api/README.md`; frozen offline pnpm 10.34.7 lock validation, shell syntax and evidence API/store TypeScript checks pass.

### 2026-10-23 · Joel (Claude Code) · Live APIs read Solana only after a chain change

- **Area:** `apps/app-api` (`src/cox/chain-changes.ts`, live source, stream, Epoch source), `deploy/dev`; Cloud Run `cox-app-api-live`, dev VM.
- **What:** At Peter's request (2026-10-22, "Action required" and "Live: shared chain-change feed" emails), both live APIs stopped polling Solana every second.
  - **Feed:** with `COX_CHAIN_CHANGES_GCS=gs://colosseum-cox-publication-archives-dev/pool-2/chain-changes/`, each API process lists Peter's `relative.chain-notification/v1` files about once a second (Cloud Storage, not Solana). It reads the chain once on start, on a higher or skipped revision, on a new generation, and when the feed turns healthy again.
  - **Finality:** notifications are confirmed but the API reads finalized. After a change it reads again after 4, 8, 16 and 32 seconds until the finalized slot reaches the notified one.
  - **Removed:** the one-second indexer loop and the 15-second wallet refresh on streams.
  - **Caching:** wallet portfolios, Epoch accounts and Epoch lots are cached until the next change. One safety read runs every 20 minutes per process. Quotes, builds and submissions still read fresh.
  - **Status:** `status.chain` gives `readAt`, `slot` and `feed` (`healthy`, `unhealthy` after 60 seconds without a heartbeat or when the publisher says so, or `polling` without the feed). An unhealthy feed never starts fast polling.
  - **Previews:** a `chainChange` block in preview files is checked when present.
  - **Monitor:** the API never used the exchange monitor; `status.monitor` stays `null`.
  - **Deployed:** Cloud Run `cox-app-api-live-00013-qch` (image `cox-app-api:7d297d1`) and the VM at `7d297d1`.
  - **Verified:** both checked Peter's real notification and preview files, served publications 0 to 4, previews 1 second old, vault covered and feed `healthy`. On each, `status.chain.readAt` stayed unchanged over 60 seconds, so no chain reads happened while idle. 86 app API tests pass.
- **Rules for agents:** Do not add timers, polls, websockets or per-instance subscriptions that call Solana or Alchemy; react to the change feed instead. `COX_POLL_MS` applies only when `COX_CHAIN_CHANGES_GCS` is unset.
- **Refs:** `apps/app-api/README.md` (Reading the chain only after a change), commits `9fc0832`..`7d297d1`.

### 2026-10-23 · Joel (Claude Code) · Preview history route and class table deployed

- **Area:** `apps/app-api`, `packages/app-api`; Cloud Run `cox-app-api-live`, dev VM.
- **What:**
  - **Preview history:** at Godwin's request (2026-10-23 email), `GET /v1/preview/history?from=&to=&step=` returns `{ assets, step, from, to, points }`. Each point is `{ end, timestamp, benchmark, prices, references }`: the last preview record at or before the end of its step. Empty steps are left out. `step` is 1, 60, 300 or 3600 seconds, with at most 1,440 steps per response; one-second steps cover the last hour, longer steps seven days.
  - **History store:** each process keeps it in memory from the previews it reads, and fills seven days from the bucket once at start in the background (about 66 seconds from a laptop on real data). It makes no Solana calls.
  - **Preview feed:** it now reads every new preview file each tick, not just the newest.
  - **Caching:** settled ranges are sent with `Cache-Control: public, max-age=86400, immutable` and without the `status` block. Peter's gateway at `api.getrelative.trade` currently rewrites every response to `no-store` (`deploy/domains/gateway.mjs` lines 28 to 31).
  - **Dynamic inclusion, first part:** classes now go through the methodology's class table, with `CRYPTO` at a fixed class instead of last, for publications, references, `/v1/assets`, previews and portfolio estimates. Epoch tickers come from an injectable map. Reading Peter's `readDynamicManifest`, publication encoding v4 and `committedPosition` waits for his SDK commit.
  - **Deployed:** Cloud Run `cox-app-api-live-00014-zjw` (image `cox-app-api:1723a85`) and the VM at `1723a85`.
  - **Verified:** publications 0 to 5 and the change feed `healthy`. History serves 641 one-minute points for the last day, 1,353 one-second points and 9 hourly points. 95 app API tests pass.
- **Rules for agents:**
  - Do not compute or average history points; a missing step stays a gap.
  - The first VM deploy attempt lost its SSH connection after `setup.sh` had replaced `/opt/eox/app` but before `pnpm install`. Running services kept working from memory, but any restart would have failed. If a VM deploy drops, check `/opt/eox/app/node_modules` and rerun `deploy/dev/deploy.sh` at once.
- **Refs:** `apps/app-api/README.md` (Live previews), commits `4abc5f0`..`1723a85`.

### 2026-10-23 · Godwin (Claude Code) · Web app on pool 2 with live estimates; deployed

- **Area:** `apps/web`; Vercel project `cox-web`.
- **What:**
  - **Pool 2:** trades follow `status.trading` (closed buttons say why and no quotes are requested; withdraw, cancel and refund stay open) and `TRADING_CLOSED` has its own message. Expiry is about three minutes converted to batches with `publicationIntervalSeconds` (`src/lib/market.ts`). Buying with collateral and withdrawing offer USDC and tUSDC as `collateralMint`.
  - **Live estimates:** prices, references, the $CRYPTO level, projected unit values and wallet value come from the previews (`src/lib/estimate.ts`, `src/components/live.tsx`). One line under the top bar says "Live estimate" or "Estimate paused" and gives the last on-chain settlement time.
  - **Charts:** the browser keeps the previews it receives for up to 4 hours. Market line charts and sparklines add one point a minute, with settled publications as dots. Position unit value and worth update every second.
  - **Other:** Next.js 16.4.2 (security advisories), optional Privy, pino and ox build warnings removed.
  - **Deployed:** `ca371dd` to production at <https://getrelative.trade> (deployment `cox-2tvb7dhcj-gef-228639f6`).
  - **RPC proxy check (Peter):** Vercel sets no `NEXT_PUBLIC_SOLANA_RPC_URL` or `COX_RPC_URL`, so the site uses public devnet and never depended on the retired proxy.
- **Rules for agents:**
  - Label preview values as estimates and keep settled publication values separate; a later publication does not confirm a preview.
  - The web app reads previews only from the app API: the stream, and `/v1/preview` every 2 seconds while the stream is down. Do not add Solana or Alchemy calls to it.
  - Market line charts move once a minute; only the user's own position may update every second.
- **Open:** Godwin: start charts from Joel's `/v1/preview/history` so they open filled instead of only collecting from page load. The landing page's unused names and the Privacy Policy (Privy, CoinGecko, DefiLlama) are unchanged.
- **Refs:** `apps/web/README.md` (Trading gate, expiry and collateral; Live estimates), commits `1d4319d`..`ca371dd`.

### 2026-10-23 · Godwin (Claude Code) · Web app charts open filled from preview history

- **Area:** `apps/web` (`src/lib/estimate.ts`, `src/components/live.tsx`, `src/components/asset-chart.tsx`).
- **What:** Following Joel's 2026-10-23 "Preview history route and class table deployed" entry, charts no longer start empty.
  - **On load:** each tab fetches `GET /v1/preview/history` once, with 60-second steps for the last 4 hours, and puts it before the live previews (`joinHistory`; only strictly newer times are added after it). Markets sparklines, the Index, Leading and Trailing cards and the 1H/4H charts are filled on first paint.
  - **Longer ranges:** 1D asks for 300-second steps and 1W/1M for 3600-second steps over at most 7 days less one hour (the route refuses a `from` exactly 7 days back). Each range is fetched once and kept for 5 minutes, shared by every asset page.
  - **Line choice:** a chart shows estimates when they cover at least as much time as the settled publications or hold more points (`preferEstimates`); settled publications stay as dots. When the API holds less than the range, the chart says how much it covers.
  - **Unchanged:** market lines still move once a minute and only the position's unit value and worth move every second. The history route has no unit values, so position charts still start from the previews the tab receives.
  - **Verified:** against `https://api.getrelative.trade` in the dev server: BTC and ETH 1H, 4H, 1D and 1W open filled (the API held about 11 hours of previews), Markets sparklines filled on first paint. 53 web tests and the type check pass. Not checked with a connected wallet; not deployed to Vercel.
- **Rules for agents:** Do not fetch preview history on a timer or per second; fetch it on load and on a range change. A malformed or missing step stays a gap; never fill or average it. History points are estimates like previews.
- **Refs:** commits `32faa31`, `a124d1a`.

### 2026-10-23 · Godwin (Claude Code) · Web app offers only USDC

- **Area:** `apps/web`.
- **What:** Godwin decided only USDC (Circle's devnet USDC, the pool's primary mint) is allowed in the web app. The tUSDC choices are removed: the swap card's mint picker, the asset page's "Pay with" tUSDC button and the portfolio's "Receive as" picker. Buys, refunds and withdrawals no longer send `collateralMint`, so the app API builds them against the primary mint. `Market.collaterals` and `collateralsOf` are gone. The landing page now says "devnet USDC" instead of "test USDC". Supersedes the second-mint part of Godwin's 2026-10-23 "Web app on pool 2 with live estimates; deployed" entry. 47 web tests and the type check pass; checked in the dev server against the live API.
- **Rules for agents:** Do not offer the test mint (`5rpGrekf…wV3X`) or a mint picker in `apps/web`.
- **Open:** Only the web app changed. Pool 2 still has a second vault on chain, and the app API, signer, SDK and program still accept `collateralMint`/`secondaryCollateralMint` (Joel and Peter); removing tUSDC there is their decision. Not deployed to Vercel.
- **Refs:** commits `c0ac913`, `c8e25cc`.

### 2026-10-23 · Godwin (Claude Code) · Correction: web test count

- **What:** Corrects the 2026-10-23 "Web app offers only USDC" entry: 51 web tests pass, not 47. Nothing else in that entry changes.

### 2026-10-23 · Godwin (Claude Code) · Market charts move the current minute live

- **Area:** `apps/web` (`src/lib/estimate.ts`, `src/components/asset-chart.tsx`, `src/components/live.tsx`).
- **What:** Godwin decided market charts should work like an exchange chart. Finished minutes stay one fixed point each, and the minute in progress follows every new preview (`withLiveMinute`). The end of the line and the last candle therefore move every second and always match the figure on the card. Card and Markets sparklines draw finished minutes plus the latest value. Supersedes the "market line charts move once a minute" rule in Godwin's 2026-10-23 "Web app on pool 2 with live estimates; deployed" and "Web app charts open filled from preview history" entries. Verified in the dev server against the live API: on the ETH price chart the last value changed every 1–2 seconds within one minute and matched the Price card each time, in line and candle mode. 54 web tests and the type check pass. Not deployed to Vercel.
- **Rules for agents:** Never rewrite a finished minute; only the minute in progress may change. Do not fetch anything extra for this: it reuses the previews the stream already delivers.
- **Refs:** commit `c113255`.
### 2026-10-23 · Peter (Codex) · Adaptive settlement deadline fix verified

- **Area:** Rust publisher execution, scheduling and diagnostics.
- **What:** A real Basic test deposit exposed `CommitDeadlinePassed` failures. Refresh price-selection time after authoritative reads; remove redundant post-simulation and pre-broadcast reads while preserving the final pre-signing nonce, fee and custody guard. Reuse validated publication archives and rebuild expired unsigned drafts without a fatal restart. Preserve signed-transaction uncertainty until resolved.
- **Verification:** 130 isolated native tests and 174 tests with the unfinished inclusion changes pass. Peter explicitly approved the scoped source/log commits and rollout. The five-second price limit, contracts and signing permissions are unchanged.
- **Open:** Committed Linux build, live installation and successful trade verification remain required. The replacement 08:00–12:00 UTC Epoch queued two lots but its diagnostic runner timed out awaiting execution; this is not a passed lifecycle. Preserve its original closing timestamp and existing lots.
- **Refs:** `apps/cox-publisher/native/src/executor.rs`, `apps/cox-publisher/native/src/worker.rs`; source commit `490a285`.

### 2026-10-23 · Peter (Codex) · Real Epoch test stopped before entry construction

- **Area:** Devnet Epoch `FN5K1VRfnvA1EyFMA3aa6mnpmBVchEXCPiBZdrzaktcq`, private lifecycle runner and existing deployment record.
- **What:** The 00:00–04:00 UTC test failed at 00:00:05 before any transaction was constructed: raw IDL `test_vault` was looked up in a camelCase account map. Corrected the runner to use Anchor-normalized `program.idl.instructions`; syntax and real-IDL queue encoding checks pass. Preserved the failed runner/result. Finalized audit at slot 514134697 confirms nonce 0, no lots, all Epoch liabilities and both vaults zero, and the owner's original 999601 test-collateral units unchanged. Publisher/preview remain active. Removed the temporary VM wallet copy after verifying its local original and removed the temporary follow-up.
- **Rules for agents:** This is a failed live lifecycle verification, not successful closing/payout/withdrawal evidence. Do not insert late entries, alter this Epoch's timing or replace its closing timestamp. The corrected runner was installed but not restarted. A new future four-hour run is required before passing the live Epoch gate.
- **Open:** Live execution, exact closing, payout and withdrawal verification remain unproven. Deployment-record and agent-log commits require approval; keep the log commit separate. No API/UI, operator/admin keys or contract was changed by this follow-up.
- **Refs:** `packages/cox/deploy/adaptive-pool-2-devnet.json`; private `.cox/epoch-00-live-failed-result.json`, `.cox/epoch-lifecycle-runner.cjs`.

### 2026-10-23 · Peter (Codex) · Deadline release restored live execution

- **Area:** Rust publisher release and existing devnet deployment record.
- **What:** Approved source `490a285` and separate log `90d4def` were rebased onto the team's current `working` branch and pushed. Installed release `90d4deff3e344a7a88d1069e306bc93c067b7f2a`, Linux SHA-256 `fd8d427f125bcd8e14d04ea361dabcee00806211359dca3b07b29d603fc8d773`, preserving configuration and the previous release for rollback. No contract or signer binding changed. Refunded expired Basic diagnostic nonce 3 in full.
- **Verification:** Fresh Basic nonce 5 deposit, nonce 6 redemption and withdrawal finalized through sequences 7–8, charging 20 and 19 test-collateral units. Final custody and liabilities both equal 5,000,431 units; the owner retains no test-position units, locks or payable. Other users' positions remain in the pool. Both already-queued replacement Epoch lots executed at 10:14:58 UTC with 30 references each; custody 200,000 equals net stakes 199,960 plus held fees 40.
- **Open:** Exact 12:00 UTC Epoch closing, candidate payouts and withdrawals remain unverified. The failed 08:05 diagnostic report is preserved; recovery adds no entries. These results do not establish subsecond end-to-end settlement.
- **Refs:** `packages/cox/deploy/adaptive-pool-2-devnet.json`; private `.cox/deadline-fixed-basic-roundtrip.json`, `.cox/event-driven-basic-refund.json`.

### 2026-10-23 · Peter (Codex) · Dynamic contract SDK and signer foundation verified

- **Area:** Basic contract, generated IDL, client SDK and signer dynamic bindings; prepared source only.
- **What:** Prepared schema-5 in-place migration and immutable universe versions, stable classes/origins, scheduled inclusion and bounded snapshot preparation. CRYPTO remains class 30; this release supports at most 255 underlying assets plus CRYPTO. SDK reads zero-pad older positions and decode version-4 publications. Strict dynamic signer bindings and staged Epoch snapshots are opt-in; no live binding or contract changed.
- **Verification:** Host 46, SDK 88, signer 68, compiled devnet 56 and production 53 tests pass (one existing ignored test per compiled suite). Devnet artifact SHA-256 `c9b4892051951e53f992100eeae36638dd64de32895a4c31cd5042df7dc0d276`. Captured-state rehearsal preserved sequence 4, one position, three requests and custody; local signature verification was disabled for rehearsal, so this is not a live signing proof.
- **Rules for agents:** Preserve current positions and custody. Preparation phases 4–6 and canceled phase 7 are not committed financial state. Joel must finish versioned manifest/history/cache integration before live activation. Re-capture current state before migration; the old rehearsal capture is not a current predecessor.
- **Open:** Scoped commit approval, real Epoch lifecycle pass, signer rollout, fresh-state rehearsal and operator-approved live inclusion. LIT is the selected candidate, not an active asset.
- **Refs:** `packages/cox-client/README.md`, `apps/signer/README.md`; contract and SDK tests.

### 2026-10-23 · Peter (Codex) · Native inclusion transition and recovery prepared

- **Area:** Rust publisher, methodology, previews and backup recovery; prepared source only.
- **What:** Added validated candidate preparation, exact-boundary signed Pyth capture, immutable predecessor-linked receipts, confirmed schedule checks and staged transition execution using the existing signer/checkpoint. Preserve global benchmark continuity and permanent origins; freeze each Epoch's roster and each executed 30-asset basket. Missing boundary data requires explicit rescheduling. Staged snapshots and receipts join recovery; old-universe preview export stops at the boundary.
- **Verification:** Integrated native suite passes 174 tests, including 255-asset capacity, recovery, signer/lineage guards and staged snapshot behavior. Worst-case request is approximately 2.74 MB and stored journal 5.90 MB. LIT Pyth Pro feed 2921 was validated with signed one-second data; its proposed class is 31 and it has no invented mint.
- **Rules for agents:** Before expanded activation raise backup `max_file_bytes` to 16 MiB; the deployed 1 MiB setting is insufficient. Historical signer keys unavailable after restart fail closed. Benchmark computation remains operator-attested. Neither the dynamic contract nor this prepared runtime has been deployed.
- **Open:** Scoped source/log approval and release gates described in the publisher README; no live LIT approval, schedule or activation yet.
- **Refs:** `apps/cox-publisher/README.md`, `packages/cox-methodology/README.md`; native inclusion/capacity tests.

### 2026-10-23 · Joel (Claude Code) · App API ready for pools that add assets (not deployed)

- **Area:** `apps/app-api`, `packages/app-api`; branch `working`.
- **What:** Peter's 2026-10-23 "SDK ready on working" request, on SDK `3807cdb`.
  - **Manifest:** methodology schema 3 is read with `readDynamicManifest`. Each asset's class, Epoch id and Pyth feed come from its instrument. `CRYPTO` stays class 30, and LIT would be class 31 and Epoch asset 30.
  - **Publications and requests:** every publication is decoded with the methodology its own state names, loaded from chain by digest and kept in memory, so history survives a methodology change. Schema 3 requests use `fromId`/`toId`, with 65535 as no class.
  - **Batches:** only batch phase 2 counts as committed, so phases 4 to 7 are already ignored.
  - **Positions:** read through the SDK's `committedPosition`, which pads older positions with zero units.
  - **Trades on pool schema 5:** every transaction starts with a 256 KB heap frame. Trades use `deposit_v2`, `switch_v2` and `redeem_v2`, and quotes use `quote_request_v2`. Submission accepts the V2 instructions (fee version in their last 8 bytes) and `initialize_dynamic_position` and `grow_dynamic_account`.
  - **Position preparation:** new `POST /v1/transactions/prepare-position` (`buildPreparePosition`) creates or grows a wallet's position until it fits; it answers 409 `NOTHING_TO_DO` when ready. Trades on a too-small position are refused with that instruction.
  - **Methodology change:** if the pool switches methodology, the process exits with "cox pool methodology changed" and its supervisor restarts it with the new list.
  - **Fixture:** only its source hash changed (`b5c42f14…`). A `cox.exe` rebuilt from Peter's current crates gives the same economics.
  - **Verified:** 100 app API tests pass, including a 31-instrument manifest built with the SDK's encoder, V2 builds, preparation and relay. Godwin's web app type-checks.
- **Rules for agents:** never derive a class from list position on a schema 5 pool; use the methodology's class table. Do not deploy before Peter's live Epoch verification and his go-ahead for the dynamic contract.
- **Open:**
  - **Peter:** a live schema 5 pool to verify against. Historical manifest loading is covered by code but has no test with two real methodologies yet.
  - **Godwin:** call `prepare-position` when a trade asks for it.
- **Refs:** `apps/app-api/README.md` (Pools that add assets), commits `79b5233`..`60820f4`.

### 2026-10-23 · Godwin (Claude Code) · Web app trades any class directly with USDC

- **Area:** `apps/web` (`swap-form.tsx`, `trade-form.tsx`, `position-view.tsx`, `portfolio-view.tsx`, Swap and $CRYPTO pages).
- **What:** At Peter's request, the web app uses direct entry (`product.md` version 15): USDC goes straight into the chosen class and straight back out, one request and one fee. The Swap card picks any of the 30 assets or $CRYPTO in both directions (`buildDeposit`, `buildRedeem`). On coin pages, Sell now receives USDC by default (`buildRedeem`), with $CRYPTO as a switch; Buy is unchanged (USDC by default). Cash out is on every Portfolio row and position page, not only $CRYPTO. The $CRYPTO page and $CRYPTO position page show the swap card fixed to $CRYPTO. Supersedes the rules in Godwin's 2026-10-11 "Web app: swap for CRYPTO, then buy and sell assets with CRYPTO" and "Web app on the real-time stream" entries that USDC enters and leaves only through $CRYPTO and that redeeming is offered only for $CRYPTO. 54 web tests and the type check pass; the Swap and ETH pages were checked in the dev server against the live API without a wallet.
- **Rules for agents:** $CRYPTO is the benchmark and one holdable class, not a required step into or out of a coin. Transactions still come from the app API; the web app does not import `@cox/client/swap`.
- **Open:** No direct sale to USDC or swap into a coin class has been signed with a real wallet. Not deployed to Vercel.
- **Refs:** commit `a106a11`, `apps/web/README.md` (Swap, buy and sell).

### 2026-10-23 · Godwin (Claude Code) · Faucet page grants 20 tUSDC

- **Area:** `apps/web` (`src/app/faucet-actions.ts`, `src/components/faucet-panel.tsx`, `src/lib/faucet.ts`).
- **What:** At Peter's request, step 3 of the Faucet page is split in two. Step 3, "Get 20 tUSDC", mints 20 tUSDC (`5rpGrekf…wV3X`) to the connected wallet from a server action signed by `TUSDC_FAUCET_SECRET_KEY`, creating its token account if needed. Step 4 is the Circle USDC link. Godwin decided each wallet can claim twice in any 24 hours. Each grant carries the memo `relative-faucet:<wallet>`, and the limit is counted from the faucet key's last 1,000 transactions on chain, so it needs no database. The balances box shows tUSDC. 58 web tests and the type check pass; the page was checked in the dev server without a wallet.
- **Rules for agents:** The faucet key must never be the registry admin key (`4rCo36GY…Pp9N`, tUSDC's mint authority today) and must never get a `NEXT_PUBLIC_` name. A claim refuses to send unless the key is tUSDC's mint authority.
- **Open:** Peter: a faucet-only key that holds tUSDC's mint authority, funded with devnet SOL; Godwin sets it on Vercel before deploying. No claim has been sent yet. The site still trades only USDC, so tUSDC from the faucet cannot be used on Buy or Swap until that changes.
- **Refs:** commit `39f94cf`, `apps/web/README.md` (Faucet page, Secrets).

### 2026-10-23 · Godwin (Claude Code) · Faucet balances moved to the wallet menu

- **Area:** `apps/web` (`faucet-panel.tsx`, `wallet-button.tsx`, `src/app/faucet-actions.ts`).
- **What:** At Godwin's request the Faucet page no longer has a balances card. The wallet menu (connected state) shows devnet SOL, USDC and tUSDC, read in one `getMultipleAccountsInfo` call whenever the menu opens. The server action `faucetBalances` is replaced by `faucetClaims`, which returns only the claims left. Qualifies the balances part of Godwin's 2026-10-23 "Faucet page grants 20 tUSDC" entry. 58 web tests and the type check pass; the wallet menu was not checked with a connected wallet.
- **Refs:** commit `946a6cb`.

### 2026-10-23 · Godwin (Claude Code) · Faucet test collateral as one step

- **Area:** `apps/web` (`faucet-panel.tsx`).
- **What:** At Godwin's request the Faucet page has three steps. Step 3, "Get test collateral", offers tUSDC (the 20-token claim) and devnet USDC (link to Circle's faucet) side by side, saying both work as collateral for testing. Supersedes the separate steps 3 and 4 in Godwin's 2026-10-23 "Faucet page grants 20 tUSDC" entry.
- **Open:** The page says tUSDC works for testing, but Buy and Swap still send only USDC. Until they accept tUSDC again, tUSDC can only be used outside the site.
- **Refs:** commit `8a1a425`.

### 2026-10-23 · Godwin (Claude Code) · Faucet page redesigned as a token picker

- **Area:** `apps/web` (`faucet-panel.tsx`, Faucet page).
- **What:** At Godwin's request, the Faucet page follows the layout of Circle's faucet. Three token cards (tUSDC, USDC, SOL), then the network (Solana Devnet), the wallet address and one button. tUSDC sends 20 tUSDC; USDC and SOL copy the address and open Circle's or Solana's faucet. Without a wallet the button opens login. Supersedes the numbered steps in Godwin's 2026-10-23 "Faucet test collateral as one step" entry. Checked at desktop and phone widths in the dev server without a wallet.
- **Refs:** commit `70d2fda`.

### 2026-10-23 · Godwin (Claude Code) · Faucet requires SOL before collateral

- **Area:** `apps/web` (`faucet-panel.tsx`, `src/app/faucet-actions.ts`, `MIN_GAS_SOL` in `src/lib/config.ts`).
- **What:** At Godwin's request, a wallet must hold at least 0.01 devnet SOL before the Faucet page lets it claim tUSDC or open the Circle USDC faucet. Below that, the page selects the SOL card, marks it "Start here", and locks the other two buttons ("Get SOL first"). `claimTestTokens` also refuses below the minimum with code `NO_GAS`. `faucetStatus` (replacing `faucetClaims`) returns the SOL balance and claims left, and is read again whenever the tab gets focus. The Circle link is only gated in the page, since Circle's site cannot be controlled. Not checked with a connected wallet.
- **Refs:** commit `f2b3238`.

### 2026-10-23 · Godwin (Claude Code) · Epochs page in the web app

- **Area:** `apps/web` (`src/app/(app)/epochs`, `src/components/epochs-view.tsx`, `src/lib/epoch.ts`, Epoch intents in `src/lib/requests.ts` and `src/app/actions.ts`).
- **What:** At Peter's request, `/epochs` (in the menu as Epochs) shows the four-hour Epoch rounds from Joel's `/v1/epochs` routes. A row of round cards, a board of each coin's move against $CRYPTO since the open and its share of the gains (the program's score formula, from the open rather than per entry), an entry box (`epoch-entry`, basket = all 30 tickers) and the wallet's entries with score, payout and withdraw (`epoch-withdraw`). 64 web tests pass. Checked against the live API at desktop and phone width without a wallet; the settled 08:00–12:00 round's board shows ZEC first with 16.9%.
- **Rules for agents:** Epoch references are on a base of 1 at scale 10^12; preview references are on a base of 100. The page multiplies Epoch closing references by 100 before comparing them.
- **Open:**
  - **Joel:** `GET /v1/epochs` and `/v1/epochs/:opensAt` return an empty `universe` for both current rounds. The page falls back to the closing references, then to `/v1/assets`, so an entry's basket comes from the market roster.
  - **Peter:** no round is taking entries now. Entry and withdraw have not been tried; a sealed upcoming round is needed to test them.
- **Refs:** commit `909d1e0`, `apps/web/README.md` (Epochs page).

### 2026-10-23 · Godwin (Claude Code) · Epochs page redesigned as a round carousel

- **Area:** `apps/web` (`epochs-view.tsx`, Epochs page).
- **What:** At Godwin's request, the Epochs page follows PancakeSwap Prediction's layout. Rounds are large swipeable cards centred on the live round, the live card has a countdown ring, pot, entries and Enter round, which turns the card into the entry form. Leaders show as tiles (top 10, toggle for all 30), and the rules sit behind a How it works button. Your entries appear only when the wallet has any. The server passes its clock to the page to avoid a hydration mismatch in the countdown. Supersedes the layout in Godwin's 2026-10-23 "Epochs page in the web app" entry. The live card and entry form were checked with a temporary fake live round (removed before commit); no real entry has been sent.
- **Refs:** commit `2ff8189`.

### 2026-10-23 · Godwin (Claude Code) · Epochs page in a three-column market layout

- **Area:** `apps/web` (`epochs-view.tsx`, Epochs page).
- **What:** At Godwin's request, the Epochs page follows Polymarket's Combos layout. Rounds in a left column (tabs on narrow screens), the selected round's coins in the middle grouped into "Ahead of $CRYPTO" and "Behind $CRYPTO" with a Back button each and a coin search, and a sticky entry slip on the right ("Pick 1 coin", stake, fee, enter) above the wallet's entries. On phones the slip is a bottom sheet once a coin is picked. Supersedes the carousel in Godwin's 2026-10-23 "Epochs page redesigned as a round carousel" entry. Checked at 1600px and phone width with a temporary fake live round, removed before commit; no real entry has been sent.
- **Refs:** commit `cf9bfd8`.

### 2026-10-23 · Godwin (Claude Code) · Web faucet minting removed; tUSDC waits for the faucet service

- **Area:** `apps/web` (`src/app/faucet-actions.ts`, `faucet-panel.tsx`, `src/lib/config.ts`; `src/lib/faucet.ts` deleted).
- **What:** Following Peter's 2026-10-23 faucet emails (mint authority stays with the admin; claims come from faucet wallet `EXdRi1ko…A9e1` through a `devnet-faucet` signer role that only Joel's Cloud Run API may call, after a signed ownership challenge), the web app no longer mints tUSDC. `claimTestTokens`, `TUSDC_FAUCET_SECRET_KEY` and the memo-based claim count are removed. The tUSDC card stays on the Faucet page with a disabled "tUSDC claims not open yet" button; the page opens on USDC; the 0.01 SOL requirement now applies only to the Circle USDC button. Supersedes the claim parts of Godwin's 2026-10-23 "Faucet page grants 20 tUSDC" and "Faucet requires SOL before collateral" entries.
- **Rules for agents:** The web app must hold no faucet or mint key. tUSDC claims go through Joel's API once Peter verifies the faucet signer.
- **Open:** Joel: the typed faucet API contract (challenge, eligibility, claim, status). Godwin: Get test funds UI against it, and a tUSDC option on Buy and Swap.
- **Refs:** commit `ad94e33`.

### 2026-10-23 · Godwin (Claude Code) · Epochs page behind EPOCHS_ENABLED

- **Area:** `apps/web` (`src/app/(app)/epochs/page.tsx`, `epochsEnabled` in `src/lib/config.ts`).
- **What:** At Godwin's request, `/epochs` shows a "Coming soon" card unless the server variable `EPOCHS_ENABLED` is `true`; then it shows the full Epochs page. Off by default everywhere, including local development and production. With the flag off the page makes no Epoch API calls. The menu item stays. Checked in the dev server both ways.
- **Rules for agents:** Do not set `EPOCHS_ENABLED` on Vercel production, or in shared local defaults, until Godwin approves the Epochs page for users.
- **Refs:** commit `ead6681`, `apps/web/README.md` (Configuration, Epochs page).

### 2026-10-23 · Godwin (Claude Code) · Epochs on in local development

- **What:** At Godwin's request, `epochsEnabled` in `apps/web/src/lib/config.ts` returns true whenever `NODE_ENV` is `development` (`pnpm dev`), so Epochs works on a local machine with no setting. Deployed builds still show "Coming soon" unless `EPOCHS_ENABLED=true`. Qualifies Godwin's 2026-10-23 "Epochs page behind EPOCHS_ENABLED" entry, which had local development off by default.
- **Refs:** commit `5a09164`.

### 2026-10-23 · Godwin (Claude Code) · Epoch page reworked to Peter's design brief (pass 1)

- **Area:** `apps/web` (`epochs-view.tsx`, `src/lib/epoch.ts`).
- **What:** Pass 1 of Peter's 2026-10-23 "Relative Epoch — comprehensive visual direction" email, on the current API. Removed the share-of-gains odds buttons, the "scores X% if it ended now" hint and the "led the round" card. Added the Basic / Epoch switch, a clock strip (date, UTC window, status, countdown, local close time, previous/next), relative moves since Epoch start labelled as live estimate, paused or closing reference, an entry panel with backed asset, 30-asset basket summary, stake with wallet balance, held fee, net stake and a Review entry step before the wallet, the Net stake pot with queued stake kept apart, the settlement timeline (Closing at zero, not Settled), a How your payout works panel, and My entries with Pending / Active / Withdrawable / History filters and each entry's execution basis. Shows score and payout only when the API supplies them; computes no live payout. Still on only in local development (`pnpm dev`); deployed sites show "Coming soon". Checked with a temporary fake open round at desktop and phone width; no real entry sent.
- **Open:**
  - **Joel:** `universe` is still empty in `/v1/epochs`; charts per Epoch and per entry need reference series (one-second preview history only covers an hour); recovery details (void deadline, refund reason) are not in the API.
  - **Godwin:** pass 2 (chart, entry detail view, basket editor once a universe exceeds 30, design frames if Peter wants them).
- **Refs:** commit `f81b221`, `apps/web/README.md` (Epochs page).

### 2026-10-23 · Peter (Codex) · Real four-hour Epoch lifecycle completed

- **Area:** Devnet Epoch `AnBEd8ne65Jmq5MP2dgqmx2KQHCGEz25kqBsmuzd8kjG`, existing deployment record and temporary verification runner.
- **What:** The 08:00–12:00 UTC Epoch settled against exact oracle timestamp `1792756800`, with no later-price substitution. Both previously queued lots executed at 10:14:58 UTC after the deadline fix; no recovery entries were added. The resume-only watcher completed at 12:00:47 UTC, preserving the original 08:05 timeout report. A fresh confirmed/finalized read independently verified exact closing and recomputed both candidate scores/payouts from the on-chain entry and closing references.
- **Verification:** Payouts 41,849 and 158,110 test-collateral base units both finalized to the original owner account (slots 514239360/514239370). Returned total 199,959; both lots withdrawn. Remaining custody 41 equals committed fees 40 plus rounding residual 1, with pending stake, active stake, held fees and claims all zero. Publisher remains active with zero restarts. This closes the real lifecycle gate; it does not erase the earlier harness timeout or establish subsecond execution latency.
- **Rules for agents:** Preserve original and completed verification reports. Remove only the temporary VM test-wallet copy after confirming successful withdrawals; keep the local test wallet and all operator/admin boundaries. Retire the temporary verification follow-up. Joel's API rollout, fresh-state dynamic migration and approved LIT activation remain separate gates.
- **Refs:** `packages/cox/deploy/adaptive-pool-2-devnet.json`; private `.cox/epoch-08-completed-result.json`, `.cox/epoch-08-final-audit.json`.

### 2026-10-23 · Peter (Codex) · Dedicated devnet faucet prepared and funded

- **Area:** Signer/signing role types, isolated faucet configuration, SDK grant builder and public key/funding records. No API/UI source or pool accounting changed.
- **What:** Peter approved the faucet plan. Created a separate non-exportable Ed25519 KMS key and pre-funded its canonical ATA with 10,000 tUSDC plus 1.25 devnet SOL. Faucet address `EXdRi1koWKTW5cdTR8SdUFVWz7vX7h9dyQJtceswA9e1`; source ATA `A6DGt726ydBHKZB1Jcrrz6u2quphDxwJD37irPkLYHNo`; mint authority remains the admin. Funding finalized with signature `CcT2ndTcC6TuhQGDjYfwrqQv379CvAhNJ2TnQfHVUJAMsN1SkycnfFhpyYN8np3Tn6m5dBDeUzVDb2eDYBT33fv`.
- **Rules for agents:** Prepared optional `devnet-faucet` role is devnet-only, requires its own KMS key, canonical recipient ATA and one capped checked-token transfer (100 tUSDC), with optional same-user SOL up to 0.01. Confirmed treasury/mint/account checks precede KMS; no minting or authority changes are allowed. Signing requests use `devnet-faucet-claim` and expire within 60 seconds. Existing oracle/default configurations remain compatible. Only the Cloud Run API identity is in the prepared faucet caller list; the shared VM identity and publisher are excluded. VM claims must forward to the Cloud Run handler.
- **Verification:** Signer 88 and SDK 91 tests pass, including browser bundling, negative policy/account checks, exact-request replay and transient-RPC recovery; signer, SDK and signing-client type checks pass. No faucet signer release has been deployed and public claims remain disabled.
- **Open:** Scoped commit approval and isolated signer canary/KMS verification. Joel owns ownership challenges, durable cross-instance cooldown/idempotency/limits and low-SOL eligibility; Godwin owns explicit devnet tUSDC and claim UI. Both were emailed. Do not enable claims before the ledger and integration tests pass.
- **Refs:** `apps/signer/README.md`, `apps/signer/config/dev-faucet.json`, `packages/cox-client/README.md`, `packages/cox/deploy/adaptive-pool-2-devnet.json`.

### 2026-10-23 · Peter (Codex) · Existing test collateral named rlUSD

- **Area:** Existing devnet token metadata, faucet SDK labels and public deployment record.
- **What:** Peter selected `rlUSD` as the custom test token name and symbol. Created Metaplex metadata `HsSpMTWNvyxrBqRhjWXS6ijnQCbxwz4Di9WD9Bzod9AY` for the existing mint `5rpGrekfBLHdF8PD8eKLzXQPPmhyF7FCKeE1VA5CwV3X`; finalized at 17:13:58 UTC with signature `2XvrqNbPX3nbXAKJMCmUMVMKxjrrBe3Vo1Worcndttod8LEZrsgu49tST6MW4Zvb7PeZas6UoveDM2nu3RVC6mbi`. Independent finalized reads verified name/symbol and unchanged mint bytes, including supply and mint authority. Metadata is mutable with admin update authority; no URI/logo is set.
- **Rules for agents:** This supersedes `tUSDC` display wording in the earlier faucet entry. Reuse the same mint, custody and six decimals. Circle's official devnet USDC keeps its identity. API/UI implementation remains with its owners; Peter's closeout covers protocol, publisher, SDK and signer. At Peter's request, blockers go directly to Joel without copying Godwin. Public faucet API delivery and UI completion do not block the tested SDK/signer handoff.
- **Open:** Prepared source/records require scoped commit approval; isolated faucet signer deployment and real grant verification follow the committed release. Dynamic activation remains gated on Joel's deployed consumers and operator approval.
- **Refs:** `packages/cox-client/README.md`, `apps/signer/README.md`, `packages/cox/deploy/adaptive-pool-2-devnet.json`.

### 2026-10-23 · Peter (Codex) · Fresh dynamic migration rehearsal passed

- **Area:** Read-only current devnet Basic state and local compiled migration verification.
- **What:** Captured finalized slot 514318053, sequence 8 and 21 accounts. Rebuilt the genesis universe receipt against that predecessor and rehearsed the prepared dynamic program `c9b4892051951e53f992100eeae36638dd64de32895a4c31cd5042df7dc0d276`. Preserved two positions, seven requests, all financial pool fields and both custody accounts. Ten simulated transactions fit the packet limit (maximum 901 bytes); sealing used 338,264 CU and migration 56,500 CU.
- **Rules for agents:** This replaces the stale sequence-4 rehearsal as the latest captured-state evidence, not as a permanent approval for any later predecessor. No live transaction was submitted, local signature verification was disabled and no live KMS or deployment proof is claimed. Recheck the predecessor immediately before live migration.
- **Open:** Joel's dynamic API deployment, coordinated protocol/signer/runtime rollout and explicitly approved LIT activation timestamp. Existing balances must remain intact.
- **Refs:** `packages/cox/deploy/adaptive-pool-2-devnet.json`; private `.cox/dynamic-fresh-rehearsal-evidence-20261023.json` and `.cox/dynamic-captured-upgrade-rehearsal-fresh-20261023.json`.

### 2026-10-23 · Peter (Codex) · Publisher quiet-hour and active-window HTTP audit

- **Area:** Read-only archived process counters and current publisher diagnostics.
- **What:** Existing backup snapshots from 14:01:43 to 15:01:54 UTC increased HTTP attempts by 15, all `getMultipleAccounts` and all safety-triggered. Adjacent quiet windows also increased by 15. The existing 10:23:44–12:07:25 UTC active/Epoch-closing window added 160 calls: active 88, event 5, safety 24, scheduled 21 and stream recovery 22. The audit generated no Solana calls or trades. Current stream is healthy and publisher has zero restarts.
- **Rules for agents:** Scope is this publisher process only, using archive timestamps as approximate capture boundaries. Do not present these as total account billing, sustained-load benchmarks, gRPC byte measurements or an Alchemy dashboard comparison. Preserve the 20-minute safety policy; no new monitor or polling was introduced.
- **Open:** Authenticated dashboard comparison and separate gRPC billing are not verified. No authenticated Alchemy browser session was available; native browser inspection was unavailable while the Mac was locked. API/signer/wallet/operator usage must be counted separately before reconciling dashboard totals.
- **Refs:** `packages/cox/deploy/adaptive-pool-2-devnet.json`; private `.cox/publisher-usage-audit-2026-10-23.json`.

### 2026-10-23 · Peter (Codex) · Isolated rlUSD faucet signer verified live

- **Area:** Signer canary, dedicated API invocation permission and existing public deployment/key records.
- **What:** Peter approved scoped commits, push and canary verification. Source through `b474325` was built from a committed allowlist excluding private state. All 88 Linux-container signer tests and type checks passed. Deployed zero-traffic revision `eox-signer-faucet-b474325`, tag `faucet-devnet`, image digest `f983e6cf4c8d087ca5424ed9ee2b5518e542010adf433edaf2dd954b047e9403`. Existing default 100% traffic and adaptive tags are unchanged.
- **Verification:** A one-shot job using only the designated Cloud Run API identity obtained a real KMS signature and finalized a 100 rlUSD plus 0.01 devnet SOL grant to isolated test wallet `EiNseoffGHoty8tXgPVwxcv3WpVWFspdYz73hWFjaYAJ`. Exact replay matched; changed-request conflicts, over-limit grants and oracle-role requests were rejected. Independent finalized audit at slot 514325719 verifies the recipient, treasury 9,900 rlUSD, unchanged mint authority/supply and 5,000-lamport transaction fee. Signature `4JRpdx9RZqwJk4iTDYpvf6qhDsa4Ny2YTFYy4WQMyukRPaqcXbjUsE1og3m3ahhumVUYpcE6dqZ5AhUURvoP3PAs`.
- **Rules for agents:** Faucet keys remain non-exportable; only the API service account has the faucet role. Publisher/shared VM identities have none. Temporary verification job was removed; test-wallet key stays local. Signer replay is not a wallet cooldown. Public claims remain disabled until Joel's authenticated, durable cross-instance claim ledger/limits are verified.
- **Open:** Joel's faucet API and dynamic-consumer deployment; approved LIT activation remains separate. Peter's faucet signer/SDK handoff is verified. Dashboard gRPC billing comparison still requires authenticated access.
- **Refs:** `apps/signer/README.md`, `packages/cox-client/README.md`, `packages/cox/deploy/adaptive-pool-2-devnet.json`; private `.cox/faucet-canary-finalized-audit.json`.

### 2026-10-23 · Joel (Claude Code) · App API for pools that add assets deployed

- **Area:** Cloud Run `cox-app-api-live`, dev VM `cox-app-api-live`.
- **What:** Supersedes the "not deployed" status in Joel's 2026-10-23 "App API ready for pools that add assets" entry. After Peter's live Epoch pass, both live APIs run `cc1e7d9`: Cloud Run revision `cox-app-api-live-00016-tlz` (image `cox-app-api:cc1e7d9`, 100% of traffic, settings unchanged) and the VM. The archive bucket held history 0 to 8, matching the chain, before the restart.
  - **Verified on current pool 2 (schema 4):** publications 0 to 8 without gaps, status fresh, vault covered (5,000,431), trading open, fee version 1, change feed `healthy`, previews 1 second old, 30 assets, Epoch routes 200, no warnings logged by the new revision.
- **Rules for agents:** The schema 5 paths (class table, V2 instructions, `prepare-position`) have only been tested against constructed accounts; check them again on the live pool after Peter's migration.
- **Open:** Peter: the schema 5 migration and the LIT activation time. Joel: the faucet API (ownership challenge, shared claim ledger, limits).

### 2026-10-23 · Joel (Claude Code) · Devnet faucet API live behind an allowlist

- **Area:** `apps/app-api` (`src/cox/faucet.ts`, `src/cox/document-store.ts`, server, main), `packages/app-api`; Cloud Run `cox-app-api-live`; Firestore database `cox-app-api`; Secret Manager `cox-faucet-ip-key`.
- **What:** The API side of Peter's 2026-10-23 faucet plan.
  - **Routes:** `POST /v1/faucet/challenge`, `POST /v1/faucet/claim`, `GET /v1/faucet/status?owner=`, with client calls `faucetChallenge`, `faucetClaim` and `faucetStatus`.
  - **Grant:** 100 rlUSD, plus 0.01 devnet SOL when the wallet holds under 0.005, built with Peter's `devnetFaucetInstructions`.
  - **Ledger:** challenges, wallet cooldowns, daily budgets and claims are kept in Firestore. One transaction uses the challenge, starts the 24-hour cooldown and counts the per-IP (3) and global (50) daily budgets.
  - **Unclear sends:** signed bytes are saved before broadcast. An unclear send or confirmation is checked on chain before the wallet can claim again.
  - **Deployed:** revision `cox-app-api-live-00021-cmn` (image `cox-app-api:67670d1`) with `COX_FAUCET_ENABLED=false` and one allowlisted test wallet, `AfXvGQpYcZwc7MWBPw9HW7TRsMXx4bL6sqbU6huxQYsN`. The signer endpoint and audience are Cloud Run settings only.
  - **Verified on devnet:**
    - One claim finalized at slot 514360859 (signature `4QBoB5kL…rVSUz5`), confirmed in 4.5 s.
    - The wallet holds 100 rlUSD and 0.01 SOL; the faucet treasury went from 9,900 to 9,800 rlUSD.
    - A second claim got 429 `FAUCET_COOLDOWN` with `retry-after`, and a wallet off the allowlist got 409 `FAUCET_DISABLED`.
    - Two earlier attempts on `00018-bz9` were signed but never sent, because the API compared the signer's base64 signature as base58 (fixed in `5cd66e9`). Both were released, with no cooldown or budget kept.
- **Rules for agents:**
  - The visitor's address is the first `X-Forwarded-For` entry, which the gateway sets. The trade POST limit uses the last entry, Cloudflare's, so it may be shared by every gateway visitor; this is still unchecked.
  - Never add a timer that reads wallets or the chain for the faucet.
- **Open:**
  - **Godwin:** the Get test funds UI against `apps/app-api/README.md` (Devnet faucet).
  - **Peter:** approval to open claims (`COX_FAUCET_ENABLED=true`).
  - **Joel:** set `COX_FAUCET_FORWARD_URL` on the VM API. Secret version 1 of `cox-faucet-ip-key` holds a stray carriage return and is unused; version 2 is live.
- **Refs:** `apps/app-api/README.md` (Devnet faucet), commits `25ee894`..`67670d1`.

### 2026-10-23 · Joel (Claude Code) · VM API forwards faucet routes

- **Area:** `deploy/dev/cox-app-api-live.service`, dev VM `cox-app-api-live`.
- **What:** Closes the VM forwarding item in Joel's 2026-10-23 "Devnet faucet API live behind an allowlist" entry. The VM API runs `30be7ac` with `COX_FAUCET_FORWARD_URL=https://api.getrelative.trade`. It holds no faucet signer settings and passes every `/v1/faucet/*` request to the public live API. Verified on the VM: status returns the test wallet's confirmed claim from Cloud Run, and a challenge for a wallet off the allowlist returns `FAUCET_DISABLED`. All publications and the change feed are served as before.
- **Rules for agents:** Calls through the VM reach Cloud Run through the gateway, which counts them under the VM's own address for the per-IP limit. That is acceptable because the VM API is reachable only through SSH tunnels.
- **Refs:** commit `30be7ac`.

### 2026-10-23 · Peter (Codex) · Hourly UTC publisher refresh prepared

- **Area:** Rust publisher chain work planning and existing scheduling documentation.
- **What:** Peter requested a `:00:00 UTC` push so Basic's committed ledger does not remain idle for many hours. Interpreted as every `HH:00:00 UTC`. Added a future Basic publication task derived from its last committed price timestamp, preserving UTC alignment after trades. After downtime, missed hours collapse into one current refresh rather than historical publication replay. No separate HTTP loop, contract change or signer permission is introduced.
- **Rules for agents:** Hourly scheduling targets a wakeup, not guaranteed on-chain inclusion at the exact second. Use fresh eligible prices; keep exact Epoch closing timestamps and never substitute later closing prices. Paused pools remain paused, accepted batches drain first, and normal pending work retains the one-second cadence. The 20-minute safety reconciliation stays unchanged. No API/UI change belongs in this task.
- **Open:** Scoped source and separate log commits require approval before building and redeploying the publisher. Live hourly verification remains required; this source is not deployed. Dynamic inclusion activation remains separately gated.
- **Refs:** `apps/cox-publisher/native/src/chain.rs`, `apps/cox-publisher/README.md`; offline native tests pass.
- **Verification:** All 176 native tests pass, including UTC alignment from a nonaligned origin, idle wakeup, missed-hour coalescing, pause/stage preservation and exact Epoch closing priority when an hourly refresh is also due. Final diff whitespace check passes.

### 2026-10-23 · Peter (Codex) · Confirmed clock bounds hourly publication prices

- **Area:** Native chain reader, price-selection guard and focused publisher regressions.
- **What:** Approved hourly source/log commits `c874eeb`/`cf2ecf8` were pushed and built, but live unsigned simulation rejected the latest Pyth observation with `TooEarly` (6011). Rolled back to healthy `90d4def` before any signing or broadcast. A read-only reproduction used observation/wall timestamp 1792788568 while confirmed Solana Clock was 1792788567; the contract rejection was correct. Prepared a price-selection ceiling from the confirmed Clock sysvar, appended to an existing account batch with no additional RPC call or loop.
- **Rules for agents:** Keep the five-second wall-time price limit and final signing/nonce/fee guards. Use actual archived signed observations at or before the confirmed clock; never restamp a price. Exact Epoch closing waits for the clock and retains its predefined price timestamp. Missing, malformed, future or stale clock data fails closed. Clock bytes stay outside the financial change digest, avoiding price-only cache invalidations. The failed hourly build is not the active release and is not verified-success evidence.
- **Open:** Corrected committed build, guarded rollout and real publication/idle verification remain required under Peter's approved hourly rollout. No contract, signer permission, API, UI or inclusion activation changed.
- **Refs:** `apps/cox-publisher/native/src/chain.rs`, `worker.rs`, `executor.rs`; private `.cox/hourly-vm-input-simulation.txt`, `.cox/hourly-rollout-failure.json`.
- **Verification:** Final native suite passes all 182 tests, including malformed/stale/future Clock, ceiling violations, unchanged wall-time freshness and exact closing wait. Diff whitespace check passes.

### 2026-10-23 · Peter (Codex) · Hourly UTC publisher refresh verified live

- **Area:** Native publisher rollout, existing README and pool 2 deployment record.
- **What:** Deployed approved source `acd9f15`, Linux SHA-256 `06851d9a983c0beb1975d89d5f2b4d021d65dd66a75985e79071ae905d0fee79`, preserving configuration and runtime identity. Finalized Basic publication 10 uses the exact 21:00:00 UTC price cutoff and committed at 21:00:20 UTC. API indexed sequence 10 with custody and ledger both 5000431; units, fees, liabilities and request nonce are unchanged. Both services have zero restarts. All 182 native tests pass.
- **Rules for agents:** Hourly scheduling is live, not a subsecond commitment guarantee. The shared publisher returns to idle: local physical HTTP counters stayed at 106 from 21:00:47 through 21:01:18 UTC. The cycle logged three rejected sendTransaction calls before successful commitment. Keep the 20-minute safety reconciliation and confirmed clock guard; no contract, signer permission, API or UI rollout accompanied this change. Inclusion remains unactivated.
- **Correction:** Supersedes the no-signing/no-broadcast statement in the earlier 2026-10-23 "Confirmed clock bounds hourly publication prices" entry: later journal review showed sendTransaction attempts and finalized publication 9 at 20:41:21 UTC before this corrected rollout. Do not describe the earlier attempt as having no transaction side effects. Publication 10 independently verifies the corrected release.
- **Refs:** `packages/cox/deploy/adaptive-pool-2-devnet.json` nativeRuntime.hourlyRefreshRollout; `apps/cox-publisher/README.md`.

### 2026-10-23 · Peter (Codex) · Midnight LIT dynamic release prepared

- **Area:** `apps/signer/config/dev-dynamic.json`, committed dynamic Basic source and fresh upgrade evidence.
- **What:** Peter approved LIT activation at 2026-10-24 00:00:00 UTC (01:00 Lagos). Rebuilt committed Basic source with pinned SBF v1.48 and devnet collateral support; reviewed SHA-256 `4c63f6955546438346309883fa06ed163a83c6bda432cf36b728e168e12a6ba1`. All 57 compiled tests pass, including migration of freshly captured sequence 10 with two positions/seven requests and unchanged financial fields. Prepared disabled dynamic signer configuration with original identities, source methodology, caller/key boundaries and limits; 29 instruction and four combined-shape policy checks pass. Epoch executable is unchanged; preserve the live hourly/confirmed-clock Rust publisher.
- **Rules for agents:** Enable only the isolated dynamic publisher route after committed-source release review. Keep admin/upgrade keys outside KMS runtime and off the VM. No LIT activation before the approved midnight boundary; missing qualifying boundary data requires explicit rescheduling. Billing verification remains uncommitted under Peter's separate instruction.
- **Open:** Commit approval for this required signer configuration, coordinated devnet upgrade, migration, backup 16 MiB limit, scheduled inclusion and live preservation/roundtrip verification. Prepared evidence is not live success.
- **Refs:** `apps/signer/config/dev-dynamic.json`; private `.cox/reviewed-dynamic-lit-20261023.json`, `.cox/dynamic-captured-upgrade-rehearsal-lit-reviewed-20261023.json`, `.cox/signer-dynamic-lit-tests.json`.

### 2026-10-23 · Joel (Claude Code) · Devnet faucet open to the public

- **Area:** Cloud Run `cox-app-api-live`.
- **What:** Peter asked (2026-10-23 16:27, team chat) for the faucet to be public, not allowlisted. Revision `cox-app-api-live-00022-k2k` sets `COX_FAUCET_ENABLED=true`; image and every other setting are unchanged from `00021-cmn`. Supersedes the allowlist-only status in Joel's 2026-10-23 "Devnet faucet API live behind an allowlist" entry. Verified: the startup log reports the faucet open, a wallet never on the allowlist gets `enabled: true` and a challenge, and the API stays fresh (publication 10, change feed healthy, vault covered). No extra claim was made.
- **Rules for agents:** The limits still apply to everyone: one claim per wallet per 24 hours, 3 per visitor address and 50 in total per UTC day. The treasury held 9,800 rlUSD after the verification claim, about 98 claims.
- **Open:** Godwin: the Get test funds UI. Joel: the trade POST limit fix (`b019a0b`) is pushed but not deployed, and the gateway header waits on Peter.

### 2026-10-23 · Joel (Claude Code) · Trade and stream limits count each visitor

- **Area:** `apps/app-api` (`src/cox/server.ts`, `src/main.ts`); Cloud Run `cox-app-api-live`.
- **What:** Every POST to the live API in a 6-hour sample came from a Cloudflare address, because the trade limit keyed on the last `X-Forwarded-For` entry. Visitors sharing a Cloudflare address shared one 30-per-minute bucket, and one visitor spread across several. Since `b019a0b`, the trade limit, the stream limit and the faucet all key on the first entry, the visitor address the gateway sets from `cf-connecting-ip`. With `APP_API_GATEWAY_SECRET` set, the first entry is trusted only on requests carrying a matching `x-relative-gateway` header; others count under the last entry, which Google sets. Deployed as revision `cox-app-api-live-00024-xwb` (image `cox-app-api:6e4a214`), with the faucet still open. Verified: 45 parallel requests from one machine through the gateway gave exactly 30 accepted and 15 `RATE_LIMITED`, while a request from the VM straight after was accepted. 114 app API tests pass.
- **Rules for agents:** Until the gateway sends the header and `APP_API_GATEWAY_SECRET` is set, a caller that skips the gateway and calls the Cloud Run address directly can choose its own first entry.
- **Open:**
  - **Joel:** create Secret Manager `cox-app-api-gateway-secret`.
  - **Peter:** have the gateway send `x-relative-gateway` (not to the signer) from Worker secret `GATEWAY_SECRET`.
  - **Joel, after that:** mount the secret as `APP_API_GATEWAY_SECRET`.
- **Refs:** `apps/app-api/README.md` (Configuration), commits `b019a0b`, `6e4a214`.

### 2026-10-23 · Joel (Claude Code) · Gateway header verifies the visitor address

- **Area:** `deploy/domains/gateway.mjs`; Cloudflare Worker `relative-service-gateway`; Cloud Run `cox-app-api-live`; Secret Manager `cox-app-api-gateway-secret`.
- **What:** Closes the open items in Joel's 2026-10-23 "Trade and stream limits count each visitor" entry. Peter asked Joel to make the gateway change himself (2026-10-23 17:41, team chat).
  - **Gateway:** strips any incoming `x-relative-gateway` header and sets it from Worker secret `GATEWAY_SECRET` for the API and fixture API, not the signer (`636dd3f`). Deployed as Worker version `bc8d02be-6562-40e4-a434-c49c92ee9903`; the secret was copied from Secret Manager without being shown.
  - **API:** revision `cox-app-api-live-00025-5jj` mounts `cox-app-api-gateway-secret:1` as `APP_API_GATEWAY_SECRET`. The image is unchanged (`6e4a214`) and the faucet is still open.
  - **Verified:** 45 parallel requests straight to the Cloud Run address, each with a different faked first `X-Forwarded-For` entry, gave 30 accepted and 15 `RATE_LIMITED`. 45 through the gateway a minute later gave the same split. All three domains answer as before (the signer still refuses calls without a token), and the API is fresh with the change feed healthy.
- **Rules for agents:** Rotate by adding a new secret version, putting it in the Worker first and then pointing Cloud Run at it; while the two differ, gateway visitors count under Cloudflare's address. Never log or commit the value.
- **Refs:** commits `b019a0b`, `636dd3f`; `apps/app-api/README.md` (Configuration).

### 2026-10-23 · Godwin (Claude Code) · Epoch page rebuilt as a dashboard

- **Area:** `apps/web` (`epochs-view.tsx`).
- **What:** At Godwin's request, the Epoch page follows a trading-dashboard layout with light use of the Relative orange gradient. Header plus a dismissible status banner. Top row: Epoch clock card (large countdown with dimmed seconds, stage chip, local close time, New entry / Previous / Next), Pot card (net or settlement pot, entries, queued, five-step progress bar) and one gradient card that opens How payouts work. Main column: Relative moves (leading or backed asset as the headline figure, Leader / Laggard / ahead / behind $CRYPTO stats, ranked list capped at 440px with its own scroll) and My entries as a table (asset, Epoch, status, stake, basis, score, payout, withdraw, basket). Side column: Create entry (Back / VS / Against boxes, stake, fee, gradient Review) and the Settlement timeline. Supersedes the layouts in Godwin's 2026-10-23 Epoch page entries; data, routes and entry logic are unchanged. Checked at 1440px and phone width with a temporary fake open round (removed before commit); no real entry sent. Still on only in local development.
- **Refs:** commit before this entry.

### 2026-10-23 · Godwin (Claude Code) · Epochs live in production

- **Area:** `apps/web`; Vercel project `cox-web`.
- **What:** At Godwin's request, `EPOCHS_ENABLED=true` is set on Vercel production and `84582fb` is deployed (`cox-op25x9vy0-gef-228639f6`), so <https://getrelative.trade/epochs> shows the full Epoch page instead of "Coming soon". Supersedes the rule in Godwin's 2026-10-23 "Epochs page behind EPOCHS_ENABLED" entry that production keeps the flag off. The payout rules now open as a six-slide carousel. The dashboard uses three columns only from 1280px; narrower screens get two columns and the mobile entry sheet.
- **Rules for agents:** To hide Epochs again, remove `EPOCHS_ENABLED` from Vercel production and redeploy.
- **Open:** No real entry, execution or withdrawal has been sent through the app yet. Joel: `universe` and per-entry reference series, as in the earlier Epoch entries.
- **Refs:** commits `3872099`..`84582fb`.

### 2026-10-24 · Godwin (Claude Code) · rlUSD faucet claims and rlUSD as collateral in the web app

- **Area:** `apps/web` (`faucet-panel.tsx`, `signer.tsx`, `trade-form.tsx`, `swap-form.tsx`, `portfolio-view.tsx`, `src/lib/market.ts`, `config.ts`, `errors.ts`).
- **What:** At Godwin's request, following Joel's 2026-10-23 faucet entries.
  - **Faucet:** the Faucet page claims 100 rlUSD through Joel's `/v1/faucet/challenge`, a wallet `signMessage` of the returned text, and `/v1/faucet/claim`, called from the browser so the per-visitor limits see each visitor. Status is read on load, on tab focus and after a claim, never on a timer. The signer context now exposes `signMessage` for wallet-adapter and Privy wallets.
  - **Collateral:** reverses Godwin's 2026-10-23 "Web app offers only USDC" entry. Buy (coin pages) and Swap offer USDC or rlUSD, sent as `collateralMint`; withdrawals offer both; selling still receives into the shared payable balance.
  - **Name:** the test mint `5rpG…wV3X` is shown as rlUSD everywhere (`TEST_COLLATERAL`).
- **Verified:** type check and 63 tests pass. In the dev server, the faucet status call works against the live API, and the Buy, Sell and Swap choices switch correctly. No claim or rlUSD trade has been signed with a real wallet. Not deployed.
- **Refs:** commits `29a37c4`, `3595d7d`.

### 2026-10-24 · Godwin (Claude Code) · Epoch page describes scoring from each entry's execution

- **Area:** `apps/web` (`epochs-view.tsx`, `src/lib/epoch.ts`).
- **What:** Peter said the Epoch page described the game wrongly. Checked against `packages/cox-epoch` and his 23 Oct brief; fixed:
  - **Subtitle:** "Back one coin against $CRYPTO for four hours" is now "Back one coin in a basket of 30. Your entry counts from its execution to the fixed Epoch close." Payouts depend on the basket and other entries, not only on beating $CRYPTO, and an entry runs only from its execution to the fixed UTC close.
  - **Moves card:** the selected coin is no longer labelled "your pick" with its since-Epoch-start move. While a round is open, a note says moves before a new entry's execution do not count toward it.
  - **Entry box, explainer and promo card:** the "Back — VS — Against the other 29" layout is now a basket box ("30 coins · 1 backed + 29 comparison"). The text says the score includes the backed coin's own rise.
  - **My entries:** each entry shows its backed coin's move against $CRYPTO since execution. Expanding it shows all 30 basket moves, from the lot's execution references to the closing references (or the live estimate while open, labelled). `executionReferences` rebases only; no score or payout is computed in the browser.
  - **Verified:** on the real 23 Oct 08:00 entries, the computed BTC/ETH score ratio (0.26469) matches the contract's payout split (41,849 / 158,110 = 0.26468). Type check and 65 web tests pass.
- **Rules for agents:** Do not label a since-Epoch-start move as the user's entry result; an entry counts only from its own execution. Do not describe Epoch as a bet against $CRYPTO or as four hours from entry.
- **Open:**
  - **Not checked:** the entry box and the per-entry moves have not been seen in a browser. No round was open, and no wallet with entries was connected.
  - **Not deployed:** this change is not on Vercel yet.
  - **Joel/Peter:** the 23 Oct 00:00 Epoch (no entries) still reports phase `open` long after its close, so the page shows it as "Closing" indefinitely.

### 2026-10-24 · Godwin (Claude Code) · Epoch page: expired rounds, final results, rlUSD entries

- **Area:** `apps/web` (`epochs-view.tsx`, `src/lib/epoch.ts`, `src/lib/requests.ts`, `src/app/actions.ts`, Epochs page, README).
- **What:** At Godwin's request, the Epoch page was checked against `packages/cox-epoch` and corrected.
  - **States:** an Epoch still `open` more than 24 hours after its close shows "Not closed": the program can no longer close it, only void it. It no longer says it is waiting for a closing reference. A draft past its opening shows "Not opened". The moves card shows a live-estimate badge only while the Epoch is open.
  - **Final results:** the program keeps a score only while an entry is scored, and the API drops the payout once it is withdrawn. Finished entries showed "Score —" and "Not settled". `finalScore` and `finalPayout` now recompute both from on-chain values with the contract's integer arithmetic. On the 23 Oct 08:00 entries they match the on-chain total weight and the recorded payouts 41,849 and 158,110 (`test/fixtures/epoch-2026-10-23-0800.json`).
  - **rlUSD:** entries can be paid in USDC or rlUSD (`collateralMint`). Withdraw reads both Epoch vaults, because the program pays from the vault matching the destination mint. It takes the payout from a vault that holds all of it, or withdraws part of it when neither vault does.
  - **Wording:**
    - Slide 4 now states the all-zero refund.
    - The review says an entry cannot be cancelled.
    - The fee shows its cap and when it is refunded.
    - The moves card says it starts from the opening estimate, since an Epoch has no on-chain opening reference.
    - The closed-entry panel says whether another Epoch exists, and shows below 1280px too.
    - An entry pending after the close reads "Not executed · refund due".
  - **Layout:** the Leader / Laggard / Ahead / Behind row keeps 140px cells and scrolls sideways when the card is too narrow, instead of squeezing them. The "30 coins · 4 hours" chip on the explainer card is removed.
  - **Verified:** 74 web tests and the type check pass. Both live Epochs were checked in the dev server, and the stats row at 390, 844 and 1440px.
  - **Deployed:** `3710a40` to production at <https://getrelative.trade> (deployment `cox-mx010dez3-gef-228639f6`). Checked there: the expired 00:00 Epoch reads Not closed and the chip is gone.
- **Rules for agents:** Keep `finalScore`/`finalPayout` identical to `packages/cox-epoch/src/math.rs`; they replicate committed values and are not estimates. Do not describe an Epoch past its 24-hour closing window as closing.
- **Open:**
  - **Not checked with a wallet:** no wallet was connected, so the entries table, the rlUSD entry and the vault-aware withdraw have not been seen with real entries.
  - **Joel's refund fields:** the web app does not yet use the new `refund`, `closingDeadline` and `voidable` fields or the `epoch-refund` builder (`af8feea`). It computes the closing deadline itself and relies on the publisher's refund cranks.
  - **Peter:** the 23 Oct 00:00 Epoch (no entries) passed its window at 04:00 UTC on 24 Oct and is still `open` on chain; the publisher has not voided it.
  - **Joel:** `universe` is empty because the deployed API (image `6e4a214`) reads the top-level `universe`, which `seal_epoch` clears after moving the list into `state`. Joel's fix `9829dba` is on `working` but not deployed. Until it is, the deployed `epoch-entry` builder rejects every basket asset of a sealed Epoch ("not in this Epoch's universe"), so no entry can be built through the API; Godwin emailed Joel on 24 Oct to deploy it. Keeping each lot's final score and paid amount in the API would also let the page stop recomputing them.
- **Refs:** commits `1488066`..`3710a40`, `apps/web/README.md` (Epochs page).

### 2026-10-24 · Peter (Codex) · Dynamic publication archive recovery fix prepared

- **Area:** Native `publications.rs`, coordinated LIT rollout and existing private release evidence.
- **What:** Peter replaced the missed midnight activation with 2026-10-24 08:30 UTC. Basic upgraded to reviewed executable `4c63f6955546438346309883fa06ed163a83c6bda432cf36b728e168e12a6ba1`; fresh sequence-22 migration preserved all captured financial fields/custody and the additional deposit. KMS sealed the original 30-asset genesis universe. Exact 08:30 signed capture and boundary publication 23 committed at 08:30:14, but the old archive reader rejected schema 4 and stopped the publisher before LIT activation. Prepared bounded schema-4/dynamic-domain validation through 255 assets, retaining old identity/hash/fee/predecessor checks and strict legacy allocation.
- **Rules for agents:** Keep the preserved 08:30 prices and accepted boundary; never restamp or substitute later prices. Publisher is intentionally stopped until the corrected committed release is installed. Backup configuration must retain root:cox-publisher 0640 ownership/mode; an atomic update accidentally made it unreadable and preview access was restored. Do not treat captured boundary publication as completed LIT inclusion. Alchemy records remain uncommitted under Peter's instruction.
- **Verification:** Nine focused archive checks pass, including actual finalized publication 23, protocol-encoded 30/31/32/255-asset records and malformed schema/fee/tail/identity/size rejection. All 185 native tests pass; live recovery remains required.
- **Refs:** `apps/cox-publisher/native/src/publications.rs`; private `.cox/lit-live-rollout-progress-20261024.json`, `.cox/lit-schema4-publication-live.json`, `.cox/lit-after-boundary-publication.json`.

### 2026-10-24 · Peter (Codex) · LIT inclusion and live roundtrip verified

- **Area:** Basic pool 2, native publisher/signer rollout and existing deployment records/READMEs.
- **What:** Supersedes the earlier “Dynamic publication archive recovery fix prepared” stopped state. Committed publisher `d798b31` is deployed; exact approved 08:30 UTC signed capture resumed without price substitution. LIT is active in universe version 2: 31 underlying assets, LIT class 31, CRYPTO class 30. Live migration preserved captured positions/requests/financial state/custody, inclusion preserved the benchmark and permanent origins, and the existing Epoch universe and two fixed baskets remain unchanged. Actual SDK 0.1 rlUSD deposit, redemption and owner withdrawal passed at publications 24/25. Cloud archives 23/24 pass object/account hashes and SDK state validation; preview and publisher are healthy. Quiet post-rollout counters stayed at 353 physical HTTP calls across 93 seconds.
- **Rules for agents:** Keep the isolated dynamic-lit signer route and non-exportable operator key boundary. The live roster has 31 assets; 255 is tested capacity, not a 255-asset live verification. Boundary publication committed at 08:30:14, not subsecond. Alchemy billing records remain uncommitted under Peter's instruction.
- **Open:** Joel must deploy existing sealed-Epoch universe-reader fix `9829dba`; public Epoch API still returns an empty selection universe. Peter approved the exact brief follow-up and it was emailed to Joel alone. Basic API roster/cache/previews are healthy. No API/UI changes made here.
- **Refs:** `packages/cox/deploy/adaptive-pool-2-devnet.json` dynamicLitRollout; `apps/cox-publisher/README.md`; `apps/signer/README.md`; 185 native tests, 57 compiled contract tests, 29 individual signer instructions and four combined shapes passed.

### 2026-10-24 · Godwin (Claude Code) · Web app survives a coin joining the market

- **Area:** `apps/web` (`src/lib/view.ts`, Markets, coin, $CRYPTO and landing pages, `src/lib/epoch.ts`, `epochs-view.tsx`, `src/lib/logos.ts`).
- **What:** LIT joined at publication 26 (09:00 UTC). `/markets`, `/assets/LIT` and `/portfolio/LIT` then showed the down page with "no reference for LIT". The landing board also fell back to its placeholder. The view helpers threw on any publication without the coin.
  - **Helpers:** a coin's price and reference history now starts at its first publication. A missing price, class or empty history gives no value instead of throwing. `standings` ranks only coins with a reference, and `marketRow` builds a Markets row.
  - **Markets:** a listed coin with no publication yet shows "No data yet".
  - **Epoch:** baskets come only from the Epoch's own universe or closing references, never the market list, and an entry needs exactly 30 coins.
  - **Wording:** the landing page and the $CRYPTO position note no longer say 30 coins.
  - **Logo:** LIT is Lighter; its price matched CoinGecko's `lighter` ($3.06), not `litentry` ($0.11).
  - **Tests:** a history where a coin appears later, and a coin listed before any publication. Against the old helpers six of them fail with "no reference for LIT".
  - **Verified:** 82 web tests and the type check pass. Every page was checked against the live API with 31 coins.
  - **Deployed:** `5a42d66` to production at <https://getrelative.trade> (deployment `cox-i3za4w1gy-gef-228639f6`). Checked there: Markets lists 31 coins with LIT, `/assets/LIT` and `/portfolio/LIT` load, and the landing board shows 31 coins ranked.
- **Rules for agents:**
  - Treat every asset as able to join, or be missing, at any publication.
  - Never throw while rendering because one coin lacks data. Use the `view.ts` helpers, which return `null` or skip.
  - Never hard-code the number of coins in the market. The Epoch basket stays at 30 because the contract fixes it.
- **Open:**
  - **Joel:** `/v1/preview/history` now starts at 08:47 UTC; preview history from before the asset list changed was dropped, so every chart's estimate history is short for now. The API also returns `assets` for the current list only, so a point from before a change cannot be matched to coins.
  - **Joel:** `/v1/assets` gives LIT no full name.
- **Refs:** commits `0d3d0e1`..`5a42d66`.

### 2026-10-24 · Godwin (Claude Code) · Epoch page: hero banner, rounds list, entry timeline

- **Area:** `apps/web` (`epochs-view.tsx`, new `src/components/empty-market.tsx`, `src/app/(app)/epochs/loading.tsx`).
- **What:** At Godwin's request, the Epoch page follows a new layout. Supersedes the layout in Godwin's 2026-10-23 "Epoch page rebuilt as a dashboard" entry; data, routes, entry logic and the final score and payout arithmetic are unchanged.
  - **Header:** "Epoch" with the line "Your entry counts from its execution to the fixed Epoch close.", and the Basic / Epoch switch.
  - **Hero banner:** the selected round's status, date and UTC window, clock, pot, entries and queued stake, with New entry and How payouts work. A sphere of coin logos shows from 640px up.
  - **Rounds and timeline:** a dated rounds list replaces Previous / Next. Beside it, a timeline draws each of the wallet's entries from its execution to the fixed close; pending entries are dashed.
  - **Empty moves:** when the moves card has nothing to rank, it shows the reusable `EmptyMarket` illustration with a title and the reason. The footnote under the card is removed.
  - **Palette:** the page uses only the app's black and orange; the orange-to-violet gradient and the explainer's violet glow are gone.
  - **Verified:** 82 web tests and the type check pass. Checked at 1440px and 390px locally, and on production.
  - **Deployed:** `d8994bd` to production at <https://getrelative.trade> (deployment `cox-leougvuwy-gef-228639f6`).
- **Rules for agents:** Keep the Epoch page to the app palette (`accent`, `surface`, `ink`, `muted` and the status colours); do not reintroduce violet. Use `EmptyMarket` for other no-data states rather than a new drawing.
- **Open:** The entry bars on the timeline and the open-round banner were seen only with temporary fake data, removed before commit; no wallet with real entries has been connected.
- **Refs:** commits `80411e9`, `d8994bd`.

### 2026-10-24 · Joel (Claude Code) · Sealed-Epoch universe fix and Epoch refunds deployed

- **Area:** `apps/app-api` (`src/cox/epoch-source.ts`, `src/cox/submissions.ts`, server), `packages/app-api`; Cloud Run `cox-app-api-live`, dev VM.
- **What:** Answers Peter's and Godwin's 2026-10-24 requests and closes the empty-`universe` item in Godwin's 2026-10-24 Epoch entries.
  - **Universe:** a sealed Epoch's list is read from `state.universe`, since `seal_epoch` clears the draft-level `universe` (`9829dba`). The `epoch-entry` builder now accepts basket assets of sealed Epochs.
  - **Refunds:** each Epoch reports `closingDeadline` (close plus the program's 86,400-second grace) and `voidable`. Each lot reports `refund` (`not-executed`, `voided` or `null`). New `POST /v1/transactions/epoch-refund` (`buildEpochRefund`) builds refund then withdraw in one transaction; submission accepts it.
  - **Deployed:** Cloud Run `cox-app-api-live-00026-h96` (image `cox-app-api:3dbd4fd`, settings unchanged) and the VM at `3dbd4fd`.
  - **Verified from outside:** both Epochs list 30 coins. The 23 Oct 00:00 Epoch is `open` past its deadline 1792814400 and reports `voidable: true`; the 08:00 Epoch is `settled`. Publications 0 to 29 without gaps, status fresh, feed healthy, vault covered, 31 assets with LIT as class 31, previews 200, faucet open. 115 app API tests pass.
- **Rules for agents:** Use `closingDeadline`, `voidable` and `refund` from the API instead of computing them in the web app.
- **Open:** Peter: the 23 Oct 00:00 Epoch has no entries and is voidable; whether the publisher should void it. Godwin: switch the web app to the new fields and the `epoch-refund` builder.
- **Refs:** commits `9829dba`..`3dbd4fd`, `apps/app-api/README.md` (Epoch).

### 2026-10-24 · Joel (Claude Code) · Epoch chart history route; preview history kept across methodology changes

- **Area:** `apps/app-api` (`src/cox/preview-history.ts`, `src/cox/live-source.ts`, server, main), `packages/app-api`; Cloud Run `cox-app-api-live`.
- **What:** Answers the per-Epoch chart item in Godwin's 2026-10-23 Epoch entries and the short-history item in his 2026-10-24 "Web app survives a coin joining the market" entry.
  - **History fix:** preview history dropped every record written before LIT joined, because each record was checked only against the current 31-asset methodology. It now loads an earlier methodology from chain by its digest (once per digest, cached) and keeps those records (`8e37636`). `/v1/preview/history` still returns only points that carry every current asset, so its shape is unchanged.
  - **Epoch route:** `GET /v1/epochs/:opensAt/history?step=60|300` (client `epochHistory`) returns the preview history shape over `opensAt` to `closesAt`, or to the current step while open, for the Epoch's own basket in universe order (`3b49abe`). Points from any methodology are used when they carry every basket asset. Values are base 100 from the permanent origin, not rebased. History older than seven days answers 410 `HISTORY_EXPIRED`.
  - **Deployed:** Cloud Run `cox-app-api-live-00027-d6m` (image `cox-app-api:3b49abe`, settings unchanged). The VM API is not updated.
  - **Verified from outside:** the 23 Oct 00:00 and 08:00 Epochs each return 240 one-minute points for 30 assets. Publications to 31, feed healthy, no warnings logged. 118 app API tests pass.
- **Rules for agents:** Rebase Epoch charts in the web app; the API serves estimates only and computes no Epoch reference or score.
- **Open:** Godwin: draw Epoch and per-entry charts from `epochHistory`. Joel: deploy `3b49abe` to the VM API.
- **Refs:** `apps/app-api/README.md` (Live previews), commits `8e37636`, `3b49abe`.

### 2026-10-24 · Joel (Claude Code) · Epoch chart history on the VM API

- **What:** Closes the VM item in Joel's 2026-10-24 "Epoch chart history route; preview history kept across methodology changes" entry. The VM API runs `62bd1f0`. After its seven-day backfill, the 23 Oct 00:00 and 08:00 Epochs each return 240 one-minute points, as on Cloud Run, with publications to 31 and the change feed healthy.
- **Rules for agents:** After a restart the Epoch history route answers with no points until the backfill finishes, about a minute on the VM.

### 2026-10-24 · Peter (Codex) · Lifecycle audit supersedes broad completion claim

- **Area:** Publisher/Epoch lifecycle, dynamic universe integration and verification boundaries; audit only, no runtime changes.
- **What:** Peter challenged the earlier closeout. LIT financial/continuity/archive tests passed, but continuous product operation was not complete: publisher never creates/seals successor Epochs; financially empty Open epochs are skipped before an on-chain terminal transition; every completed inclusion intentionally exits for boot-time universe adoption. Current engine reproduction confirms 31 global prices are rejected by an active frozen 30-asset Epoch for both entry and close, while projected 30-price snapshots pass. Snapshot PDA uses config+sequence, so simultaneous frozen universes need explicit identity handling. Prior settled-basket immutability audit did not cover this case.
- **Rules for agents:** Do not call the overall pipeline complete from one successful inclusion/roundtrip. Require automatic successor creation, empty-round terminalization, active-Epoch inclusion crossing, hot universe adoption and deployed consumer entry verification. Do not reset the benchmark to hide its decline: independent high-precision recomputation of publication 23 matches 90.519760989063; all original inputs were below origin. Preserve custody and origin history until an explicit migration is approved.
- **Open:** Sealed-Epoch API roster remains empty; market-page HTTP 500 observed although direct confirmed Basic registry read at 09:09:40 UTC is unpaused (sequence 26). Website server-error cause is not yet established. Earlier schema-4 archive incompatibility and backup-config permissions incident were rollout defects, not intrinsic requirements of adding an asset.
- **Refs:** native `chain.rs`, `executor.rs`, `inclusion_execution.rs`, `runtime.rs`; `packages/cox-epoch/src/lib.rs`; private `.cox/audit-current-chain.json`, `.cox/audit-current-epochs.json`; executable repro `/private/tmp/relative-epoch-audit/repro.rs`.

### 2026-10-24 · Peter (Codex) · Correction to active-Epoch inclusion audit

- **Area:** Corrects the earlier 2026-10-24 “Lifecycle audit supersedes broad completion claim” snapshot-filtering assertion.
- **What:** Its engine-only reproduction bypassed the existing on-chain `select_snapshot` wrapper. The wrapper already filters global prices into each frozen Epoch universe; a compiled contract test now verifies entry and closing with 31 global prices and a frozen 30-asset round. No replacement snapshot namespace is required for this case. The separate missing rollover, empty cleanup and restart-coupling findings remain valid.
- **Rules for agents:** Trace the actual contract wrapper before inferring live behavior from engine-only tests. Preserve the existing frozen-universe filter and immutable executed baskets.
- **Refs:** `packages/cox-epoch/programs/epoch/src/lib.rs`; `packages/cox-epoch/program-tests/tests/custody.rs`.

### 2026-10-24 · Peter (Codex) · Fresh-generation registry and lifecycle source prepared

- **Area:** Basic/Epoch contracts and IDLs, client SDK, signer policy, native publisher and configuration installation.
- **What:** Implements direct 31–255-asset genesis, shared versioned Basic-owned registry, permanent per-asset origins, explicit instance lifecycle and irreversible archival, permissionless bounded current-Epoch preparation/resumption, and empty-round terminalization. Peter changed the fresh generation to CRYPTO class 0; underlying classes are 1–31 with LIT 31, while legacy schema-1 history retains CRYPTO 30. Peter confirmed both inventory wallets `4ECs…oqya` and `GpgF…nepN` are discardable test positions. New test positions are not migrated/refunded/swept during reset. Geometric math, 30-member baskets, dual devnet collateral and 2-bps/$0.20 fees remain.
- **Verification:** SDK 100, signer 90, native 192, Epoch engine 22, compiled Epoch 20, compiled devnet Basic 61 (one pre-existing ignored test), and configuration helper six tests pass; SDK/signer type checks pass. Actual compiled tests cover direct pool-7 genesis, 255 assets, Preparing admission rejection after its opening timestamp, archived rejection/refund rights, successor entry while predecessor remains unsettled, empty drafts and frozen-roster filtering. These are component/compiled integration tests, not the complete running-services local-validator rehearsal or live acceptance.
- **Rules for agents:** Use the schema-aware CRYPTO class, generation-specific state/archive/cache identities, canonical registry pages and existing frozen-Epoch filter. Publisher preparation uses the contract's eight-asset page and 8192-byte growth limits. Successful inclusion adopts its committed anchor/mappings/subscriptions in process. Do not reset/deploy/open from these source results. Preserve the uncommitted Alchemy billing entry. Recheck final ownership/activity inventory before discarding old test positions.
- **Open:** Full running-services rehearsal and live Pause A/B remain. Joel was emailed the compatibility contract, class-0 correction, sealed/empty-round fields and deployed-evidence requirements; no API/UI implementation was changed. Old accounts/custody remain untouched. No reset timestamp has been selected.
- **Refs:** `packages/cox-client/README.md` fresh-generation handoff; `apps/cox-publisher/README.md` lifecycle reset release; `apps/signer/README.md`; `packages/cox/fixtures/generation/`.

### 2026-10-24 · Peter (Codex) · Discard scope clarification

- **Area:** Clarifies “Fresh-generation registry and lifecycle source prepared”.
- **What:** Its discard wording applies only to the approved old-generation test positions in the final inventory. Fresh-generation deposits retain all normal settlement, refund and withdrawal rights. This release does not waive those rights or sweep either generation's custody.
- **Rules for agents:** Stop for Peter's review if the final old-generation inventory contains unexpected ownership or activity. No new live accounts have been created by this source-preparation work.

### 2026-10-25 · Joel (Claude Code) · App API ready for fresh generations; live pool 2 unreadable by the new SDK (not deployed)

- **Area:** `apps/app-api`, `packages/app-api`; branch `working`.
- **What:** Peter's 2026-10-24 fresh-generation handoff (`18ec5cd`, SDK `76d5e0c`).
  - **Pools:** the CRYPTO class comes from the methodology's universe schema (class 0 for schema 2, 30 for schema 1), and the API refuses a pool whose own `cryptoClass` disagrees. `status.trading` adds `lifecycle` (`preparing`, `active`, `archived`) and the gates `preparing` and `archived`, apart from `paused`. Preparing and archived markets refuse trades and quotes; cancel, refund and withdraw stay available. `deployment` adds `cryptoClass` and `generation` (id, asset registry, Epoch config and the SDK's composite key).
  - **Epoch:** configurations report `lifecycle` and `assetRegistry`, and entries need an active configuration. Rounds marked `emptyFinalized` show as phase `empty`, sealed or not. Registry-bound rounds report `registry`: the frozen version, universe digest and each asset's origin benchmark, with scale 10^12.
  - **Preparation:** `POST /v1/transactions/epoch-prepare` builds the next bounded transaction of the SDK's `prepareCurrentEpoch` for the current round, using the registry version effective at its opening. It answers `TRADING_CLOSED` while an asset change due at or before the opening is unresolved, and `NOTHING_TO_DO` once sealed. `POST /v1/transactions/epoch-finalize-empty` builds `finalizeEmpty`. Submission relays both.
  - **Startup:** an RPC that cannot answer at start is skipped with a warning instead of stopping the API (`4a5cb2c`). This was the 22 Oct market-page 500: Cloud Run revision `00007` could not start because the old proxy failed its network check. No API 5xx since 24 Oct.
  - **Verified:** 132 app API tests pass, including Peter's preparing, active and archived generation fixtures. Read-only devnet run: the live Epoch config and both Epochs read correctly with the new Epoch IDL.
- **Rules for agents:** Do not deploy these commits yet. Peter's SDK `decodeAccount` cannot read the live pool 2: it is schema 5 like fresh pools, and since LIT joined, the bytes where the SDK expects `lifecycleVersion` hold leftover data (`0x48` at offset 2180 of 4,096), so decoding fails. The deployed API still uses the older SDK and is unaffected.
- **Open:**
  - **Peter:** a rule to tell a legacy schema-5 pool from a fresh one, in the SDK and the program, before Pause A can be verified.
  - **Godwin:** `TradingStatus` now has `lifecycle`; `apps/web/src/lib/market.test.ts` needs it, and `market.ts` has no wording for the `preparing` and `archived` gates.
- **Refs:** `apps/app-api/README.md` (Adaptive pools and Epoch), commits `8720493`..`4a5cb2c`.


### 2026-10-24 · Peter (Codex) · Section-one revalidation and legacy lifecycle storage fix

- **Area:** Basic/Epoch account serialization, SDK/signer readers, compiled tests and old-generation inventory.
- **What:** Peter corrected the premature source handoff: finish sections 1, 2 and 3 in order before declaring readiness or entering Pause A. Section-one live read-only capture found 81 accounts and only the three approved test owners. It also exposed nonzero legacy padding that the earlier unmarked appended enum could not deserialize. Replaced unmarked footers with explicit `RLPOOL01`, `RLCFG001` and `RLEPCH01` markers; absent markers retain legacy behavior, recognized malformed/unsupported extensions fail closed. SDK decodes a marker-only header before the full extension; native uses the corrected contract types, and signer offsets validate the markers. No live mutations occurred.
- **Verification:** Compiled Basic default 60 tests (one pre-existing ignored), dual collateral five, compiled Epoch 21, SDK 102, signer 91 and native 192 pass. Tests include captured live Pool2 bytes, dirty Epoch tails, zero-liability genesis, archive irreversibility after unpause, publication/config rejection and preserved settled withdrawals/refunds. IDLs, compiler-produced fixtures and four executable artifacts were refreshed. Basic pool 3/Epoch config 3 and isolated namespaces are prepared privately; neither instance exists and no reset timestamp has been chosen.
- **Rules for agents:** Do not deploy the earlier unmarked-footer artifacts or treat arbitrary padding as lifecycle data. Drain accepted work before atomic pause+archive, with its stage guard and final inventory recheck. New ownership/activity requires Peter's review. Preserve Alchemy billing records uncommitted. Do not skip ahead to section 2 or send another readiness handoff while section 1 remains open.
- **Open:** Cloud archival/history-object verification is blocked by expired GCP project-account authentication; the hashed local inventory is saved. Peter was asked to reauthenticate. Section 1 is not closed, Pause A has not been reached, and new source fixes require scoped commit approval later.
- **Refs:** `packages/cox/deploy/README.md` fresh-generation reset boundary; `packages/cox-client/README.md`; `packages/cox/fixtures/generation/legacy-pool-dirty-padding.json`; private `.cox/fresh-generation-inventory/latest.json`, `.cox/fresh-generation-preparation.json`.


### 2026-10-25 · Peter (Codex) · Section-one archive verified after reauthentication

- **Area:** Old-generation inventory and immutable cloud evidence; resolves the cloud blocker in “Section-one revalidation and legacy lifecycle storage fix”.
- **What:** Uploaded the 81-account inventory and identities/checksums for 37 existing publication objects (sequences 0–36) as one create-only archive. Downloaded bytes match SHA-256 `11445caa20c6091620ce433adefcdf5ae2f9dd861e4f8a1fa3166734a9e52d9b`. The inventory contains only the three approved test owners. No account, collateral, publication or historical object was changed or deleted. New Basic pool 3/Epoch config 3 remain uncreated.
- **Rules for agents:** Section 1’s pre-cutover preparation is verified; repeat the inventory/activity check at actual cutover. Unexpected ownership/activity still requires Peter’s review. Do not interpret archival evidence as on-chain archival or permission to skip Pause A/B.
- **Refs:** `packages/cox/deploy/README.md`; private `.cox/section-one-verification.json`; cloud `generation-archives/legacy-basic-2-epoch-2/11445caa20c6091620ce433adefcdf5ae2f9dd861e4f8a1fa3166734a9e52d9b.json` in the existing publication archive bucket.


### 2026-10-25 · Peter (Codex) · Section-two registry and continuous Epoch verification

- **Area:** Compiled Basic/Epoch tests, native discovery and chain-time round planning.
- **What:** Verified actual registry activation preserves existing units, custody, pending requests, class IDs and permanent origins. Compiled Epoch tests cover bounded permissionless preparation by another payer, late opening-version selection, successor entry while a predecessor remains Open, frozen-wrapper filtering, exact closing and empty terminalization. Fixed discovery retaining only oldest/current: schema 2 durably tracks intermediate unfinished rounds, inspects at most eight historical openings per reconciliation and fails closed above 64 tracked unfinished rounds. Failed/unstable reads do not advance its journal. Round planning uses confirmed chain Clock from the existing batched read.
- **Verification:** 13 compiled Basic dynamic tests, 22 compiled Epoch tests and 200 native tests passed at this boundary. These are controlled component tests, not full running-services rehearsal or live acceptance.
- **Rules for agents:** A missing historical round is logically empty; an instantiated round leaves discovery only with confirmed and finalized terminal/absence evidence. An approved unresolved activation at an opening blocks roster preparation until activation or explicit cancellation/rescheduling. Section 3 and deployed Pause A/B remain separate gates.
- **Refs:** `apps/cox-publisher/README.md`; `packages/cox/crates/program-tests/tests/dynamic.rs`; `packages/cox-epoch/program-tests/tests/custody.rs`; private `.cox/section-two-verification.json`.


### 2026-10-25 · Peter (Codex) · Section-three durable adoption and generation isolation verified

- **Area:** Native publisher adoption, accepted transition journals, preview/notification spools, backup/restore and release helper.
- **What:** Confirmed inclusion adopts in process after accepted Basic and recovered Epoch stages clear. Invalid candidates remain nonfatal; accepted-journal corruption/storage failures fail closed. Staged benchmark and Pyth signature checks precede durable anchor replacement, including startup using the existing trusted-key read. Controlled production-component tests continue the same benchmark task across roster adoption with shared consumers/feed subscriptions and zero HTTP calls. Preview and notification exporters bind both spools before any upload and reject wrong-pool records.
- **Rules for agents:** Fresh generations use `relative.backup/v2`, requiring absolute `runtime_config_path`, derived publication identity and canonical `pool-{id}/native` plus `pool-{id}/history`. Restore checks runtime identity before creating its destination. Legacy v1 recovery remains supported but is not the fresh-generation binding. Nonempty unbound old spools must be explicitly drained or archived; never silently assign them to the new market. Market generation differs from chain-change revision generation. Pool 3 uses isolated history/preview/chain-changes/native prefixes and fresh state.
- **Verification:** Final native 211, SDK 106, signer 91 and release-helper seven tests pass; SDK/signer TypeScript and final diff checks pass. Compiled Basic 60 (one pre-existing ignored), dual-collateral five and Epoch 22 checks remain valid; contract sources are unchanged since those verified artifacts. Full running-services rehearsal and live Pause A/B remain unperformed. No live reset, upgrade, custody mutation or admission occurred.
- **Open:** New scoped commit approval is required before source push/release. Sections 1–3 are verified at source/component level in their required order. Do not bypass Joel's deployed-consumer evidence or equate these tests with the later continuous live acceptance. Preserve Alchemy records uncommitted.
- **Refs:** `apps/cox-publisher/README.md`; `deploy/dev/native-publisher-release.py`; private `.cox/section-three-verification.json`.


### 2026-10-25 · Peter (Codex) · Typed Epoch integration readers and lifecycle fixtures

- **Area:** `packages/cox-client`, Basic/Epoch generated IDLs and controlled account fixtures.
- **What:** Added exported typed `EpochReader`, `decodeEpochAccount`, `epochRoster` and `isEpochTerminal`. Owner/PDA/context checks and marked legacy extension handling preserve historical reads. Eight compiled Epoch fixtures cover preparing/active/archived configurations, frozen 31 versus active 32 assets, successor while predecessor remains Open, empty terminal sealed/draft rounds and dirty legacy padding. Public README specifies reference scales, immutable origin benchmarks, generation cache identities and stale/unavailable versus confirmed pause semantics. SDK 106 tests include browser bundles and all fixture readers.
- **Rules for agents:** New-generation consumers must use the updated IDLs and marker-aware readers. Read sealed rosters from `state.universe`; do not classify an empty finalized draft as unsettled. Claimable withdrawal balances do not prevent a terminal predecessor's successor. Fresh CRYPTO is class 0; underlying IDs remain distinct from Basic classes. Fixtures label compiled outputs, canonical Basic prestate and fault injection; they are not live deployments or Pyth captures.
- **Open:** Joel's deployed backward-compatible readers/builders and generation isolation must pass Pause A; actual new selection/previews/prepared transactions must pass Pause B. Source commits or email acknowledgements are insufficient.
- **Refs:** `packages/cox-client/README.md`; `packages/cox-epoch/fixtures/generation/`; `packages/cox/fixtures/generation/`.

### 2026-10-25 · Joel (Claude Code) · Fresh-generation API deployed for Pause A

- **Area:** `apps/app-api`; Cloud Run `cox-app-api-live`, dev VM.
- **What:** Supersedes the "not deployed" status and the pool 2 read blocker in Joel's 2026-10-25 "App API ready for fresh generations" entry. On Peter's SDK fix (`ad17e55`), Epoch accounts are read through `decodeEpochAccount`, rosters through `epochRoster`, and each Epoch reports `terminal` from `isEpochTerminal` (`f886558`).
  - **Tests:** 140 pass, with one test per fixture in `packages/cox-epoch/fixtures/generation/` (all eight) and Peter's Basic generation fixtures.
  - **Deployed:** Cloud Run `cox-app-api-live-00028-znr` (image `cox-app-api:f886558`, settings unchanged) and the VM at `f886558`.
  - **Verified on both:** pool 2 reads as a legacy pool: `cryptoClass` 30, `generation` null, 31 assets, lifecycle `active`, gate `open`. Publications 0 to 48 without gaps, status fresh, feed healthy, vault covered. The Epoch config reads `active` with no registry. The 00:00 Epoch is `open`, voidable, not terminal; the 08:00 Epoch is `settled` and terminal; both list 30 coins with `registry` null. `epoch-prepare` answers `TRADING_CLOSED` for this operator-prepared configuration. Epoch history, previews and the faucet answer as before. No warnings logged.
- **Rules for agents:** Pause B still needs this API pointed at the new pool 3 with its own `pool-3/` history, preview and chain-change prefixes, and checked there before admission opens.
- **Refs:** commits `8720493`..`f886558`, `apps/app-api/README.md`.

### 2026-10-25 · Godwin (Claude Code) · Web dev server on Turbopack

- **Area:** `apps/web` (`next.config.ts`, `package.json`, `src/lib/empty-module.ts`, README).
- **What:** At Godwin's request, `pnpm dev` runs `next dev` on Turbopack instead of webpack. Cold page loads measured on a fresh server: `/markets` 52 s → 10–15 s, `/` 22 s → 5–7 s, `/epochs` 14 s → 2.5–3 s, other app pages 6–15 s → about 2 s. `turbopack.resolveAlias` maps the two `.js` specifiers in `@eox/app-api` (`./cox-client.js`, `./cox-types.js`) to their `.ts` files, stubs `@farcaster/mini-app-solana` and `pino-pretty` with `src/lib/empty-module.ts`, and a `turbopack.rules` entry runs the StyleX Babel step on `src/landing` only (landing styles checked). `agentRules: false` stops Next.js writing its own `AGENTS.md` into `apps/web`. Production builds (`next build --webpack`, Vercel) are unchanged.
- **Rules for agents:** Joel: a new file in `@eox/app-api` imported with a `.js` specifier must be added to `turbopack.resolveAlias`, or `pnpm dev` cannot resolve it; webpack is unaffected. Do not run a second `next dev` in `apps/web` while one is running; they share `.next`.
- **Refs:** commit `45f86a5`, `apps/web/README.md`.

### 2026-10-25 · Godwin (Claude Code) · Epoch page reworked with automatic baskets; deployed

- **Area:** `apps/web` (`src/components/epochs-view.tsx`, `src/lib/epoch.ts`, tests, README); Vercel project `cox-web`.
- **What:** At Godwin's direction. Supersedes the layouts in Godwin's 2026-10-24 Epoch page entries; data routes, entry and withdraw logic and `finalPayout` are unchanged.
  - **Hero:** the coin sphere and the status sentence are gone. The left side alternates every 6 s between the last settled round and the open round (or the next one), each with status, date, UTC window, countdown or close time, Pot and Entries. With no round scheduled on chain, the next slide counts down to the next four-hour UTC boundary and shows "—" for pot and entries. The right side ranks the coins of the open round, else the last finished round, against $CRYPTO. "How Epoch Works" is a text link at the top right. The rounds list and entry timeline are removed.
  - **Below:** coins in "Ahead of $CRYPTO" and "Behind $CRYPTO" tiles that reorder at most once a minute; an entry panel that follows the Buy form (no Sell, since entries cannot be exited) with the exact fee; entries as cards.
  - **Basket:** the contract requires exactly 30 distinct coins from the round including the backed coin (`queue` takes `[u16; BASKET_SIZE]`). Picking a coin fills the basket automatically (`defaultTeam`: the other coins in the round's own order). In a round of more than 30 coins, Edit basket asks which coins to leave out (`leaveOutCount`), or for 29 to include above 58 coins. Before this, a round with more than 30 coins blocked every entry in the app. How Epoch Works is four steps: Back one coin, Add to basket, Get a score, Share the pot.
  - **Fixtures:** web test fixtures gained the API's `lifecycle`, `terminal` and `registry` fields; their type errors had made the Vercel build fail.
  - **Deployed:** `8679ba9` to production at <https://getrelative.trade> (`cox-h8vipcnw0-gef-228639f6`). Checked there: `/epochs`, `/markets` and `/` return 200 and the Epoch hero renders.
- **Rules for agents:** Do not tell users the basket is optional or "up to" 29; it is exactly 30. Keep the basket size in `EPOCH_BASKET_SIZE` and `TEAMMATES`, never a literal.
- **Open:** Every live round so far has 30 coins, so the basket picker has only been seen on a development-only preview round of 31 coins; it needs a check on the first real round with LIT. The last settled round (23 Oct 08:00) predates the API's preview history, so its ranking and coin board show "Prices from the start of this round are not available". Nothing was checked with a connected wallet; no entry was signed.
- **Refs:** commits `c054b1a`, `3bc94f0`, `8679ba9`; `apps/web/README.md` (Epochs page).

### 2026-10-25 · Godwin (Claude Code) · Epoch page: baskets beyond 30 coins, unnamed coins, failed refreshes, real rounds only

- **Area:** `apps/web` (`src/lib/epoch.ts`, `src/lib/data.ts`, `src/components/epochs-view.tsx`, Epochs page, tests); Vercel project `cox-web`.
- **What:** At Godwin's request.
  - **Basket editor:** in a round of 31 to 59 coins, the editor opened full with the right coins already left out, so no coin could be swapped. The click rules are now `toggleMate` and `mateLocked`. With 31 to 59 coins you choose which to leave out; with 60 or more you pick 29. Tests cover rounds of 31, 32, 45, 59, 60, 100 and 255 coins.
  - **Unnamed coins:** a coin named like `#31` is left out of every coin list on the page (`epochBasket`) until it has a name. Scores and payouts still use every coin in the round. If hiding leaves fewer than 30 coins, entries for that round are blocked with "This Epoch's asset list is not available yet."
  - **Failed refreshes:** if `/v1/epochs` fails, the page shows the newest rounds it has, from the server's last good read or the browser's, with "Rounds could not be refreshed. Showing them as of HH:MM UTC." A failed `/v1/assets` request no longer breaks the page.
  - **Hero:** it no longer makes up a next round at the coming four-hour boundary. It shows the last finished round and an open or scheduled round only when one exists, and slides only when there are two; with none it says "No round scheduled". Supersedes the next-round slide in Godwin's 2026-10-25 "Epoch page reworked with automatic baskets; deployed" entry.
  - **Verified:** 132 web tests and the type check pass. `11782a4` is deployed to production at <https://getrelative.trade> (`cox-rll9n3r10-gef-228639f6`); `/epochs` shows only the settled 23 Oct 08:00 round.
- **Rules for agents:** Never show a round in the Epoch page that the API does not list. Read a round's coins through `epochBasket`, never `universe` directly, so unnamed coins stay hidden.
- **Open:**
  - **Joel:** `ticker()` in `apps/app-api/src/cox/epoch-source.ts` throws `EpochAssetUnknown` for an Epoch asset id the manifest does not name, which fails all of `/v1/epochs`. Godwin asked Joel to return `#<id>` with a warning instead, and to add API tests for an entry with an unnamed coin and an entry in a round of more than 30 coins.
  - **Peter:** no round after 23 Oct 08:00 has been created; the 23 Oct 00:00 round is still open past its closing window.
  - **Not checked:** the out-of-date notice, unnamed coins and the editor in a real round of more than 30 coins have not been seen in a browser.
- **Refs:** commits `cb0e7bf`..`11782a4`.

### 2026-10-25 · Joel (Claude Code) · Pause A blockers fixed and deployed

- **Area:** `apps/app-api` (`src/cox/epoch-source.ts`, `src/cox/publication-history.ts`, `src/cox/live-source.ts`, `src/main.ts`), `packages/app-api`; Cloud Run `cox-app-api-live`, dev VM.
- **What:** Fixes the three blockers in Peter's 2026-10-25 emails.
  - **Configuration refresh:** `EpochSource.invalidate()` now reads the Epoch configuration again, on the same chain-change refresh path as before. There is no new per-request or timed read. A refresh that fails keeps the previous configuration and is logged.
  - **Entries:** `entriesOpen` is true only while the configuration is `active`. Withdrawals and refunds are unchanged.
  - **Fresh genesis:** publication history, backfill and segment indexing start at publication 1 on fresh generations (`generation` not null) and at 0 on legacy pools. A fresh generation's first publication must be batch 0 with a zero predecessor digest. Publication 0 is never requested or made up, and a missing segment or publication is never skipped.
  - **Void builder:** new `POST /v1/transactions/epoch-void` builds the program's permissionless `void_epoch` for a round still open after its closing deadline, and submission relays it.
  - **Tests:** 144 pass. New ones cover Active to Archived and to Preparing through `invalidate()` on Peter's compiled fixtures, an Archived configuration with an otherwise open round, and a fresh history from publication 1. The first two fail on the previous code.
  - **Deployed:** Cloud Run `cox-app-api-live-00029-2vs` (image `cox-app-api:6d72ce9`, settings unchanged) and the VM at `6d72ce9`.
  - **Verified on both:** pool 2 legacy, publications 0 to 56 without gaps, status fresh, feed healthy, vault covered. The Epoch config is `active`; the 00:00 round is `open` with `entriesOpen: false` (past its close) and the 08:00 round `settled`.
- **Rules for agents:** Await `EpochSource.invalidate()`; it now returns a promise. Never derive a fresh generation's history from sequence 0.
- **Refs:** commits `b030751`..`6d72ce9`, `apps/app-api/README.md`.

### 2026-10-25 · Peter (Codex) · Independent Pause A verification found lifecycle-cache blockers

- **Area:** Read-only verification of Joel’s API deployment and compiled fixture consumers; no API/protocol implementation changes.
- **What:** Verified Cloud Run `cox-app-api-live-00028-znr` serves 100% traffic from `f886558`; public and VM responses match current confirmed Basic/Epoch accounts, sealed rosters and terminal status. Both previews are fresh. Independently reran all 140 API tests. Permissionless preparation succeeds against the complete compiled registry/configuration fixture set; the deployed legacy configuration correctly rejects it. Fresh-generation live selection remains Pause B work.
- **Blockers:** Actual fixture reproduction shows `EpochSource.invalidate()` does not refresh its once-loaded configuration: Active → Archived still reports Active. Separately, a freshly read Archived configuration can report `entriesOpen: true` for an otherwise Open round because that field ignores lifecycle. Source tests passing do not clear these runtime transition failures. Joel was emailed the exact reproduction and requested to refresh configuration through the shared confirmed event path, gate entry status on lifecycle, add transition tests and redeploy both instances.
- **Rules for agents:** Pause A remains closed; do not perform live protocol cutover. Do not add continuous/per-request HTTP polling to resolve lifecycle caching. Keep refunds/withdrawals available. No protocol transaction was submitted; only unsigned preparation was requested. Preserve uncommitted Alchemy records.
- **Refs:** `apps/app-api/src/cox/epoch-source.ts`; private `.cox/pause-a-interfaces-audit.mts`, `.cox/pause-a-20261025/verification.json`; Joel email thread `1a171a909685571a`.

### 2026-10-25 · Peter (Codex) · Fresh genesis archive starts at its real sequence

- **Area:** `apps/cox-publisher/native/src/publications.rs`, publisher README.
- **What:** Actual direct 31-asset local genesis publishes sequence 1, batch 0; no sequence-0 publication exists. Added a strict schema-4 genesis exception requiring zero predecessor, empty economic state, initial benchmark/references 100 and the approved initial fee policy. Legacy predecessor checks, intermediate-gap rejection and create-only records remain unchanged. Eleven archive tests pass, including linked continuation and restart.
- **Rules for agents:** Never fabricate publication 0. Joel must support the verified generation starting sequence through API backfill, history and segment offsets; this is an additional Pause A consumer requirement. The exact requirement was emailed to Joel alone without credentials.
- **Open:** Source remains uncommitted pending approval. No live upgrade or archive mutation occurred.
- **Refs:** `apps/cox-publisher/README.md`; private `.cox/local-rehearsal/archive-report.json`; Joel email thread `1a171a909685571a`.

### 2026-10-25 · Peter (Codex) · Missing closing data yields publisher scheduling turns

- **Area:** `apps/cox-publisher/native/src/worker.rs`, worker integration tests.
- **What:** The actual local delayed-close rehearsal exposed scheduling starvation: missing exact closing data repeatedly selected the predecessor while preventing successor preparation. Persisting the scheduling fairness turn before snapshot selection lets bounded maintenance and other Basic/Epoch entries progress while the predecessor keeps waiting. Twelve worker tests pass, including restart-persisted multi-step maintenance and entry fairness.
- **Rules for agents:** Preserve the exact closing timestamp; never substitute a later price. Waiting for a closing snapshot must not block current-round preparation or unrelated entries. This changes scheduling only, not oracle verification, fees or payouts.
- **Verification:** Actual local publisher automatically prepared and sealed the midnight successor and executed its entry while the executed predecessor remained nonterminal with no closing snapshot. No admin round creation was used.
- **Open:** Source remains uncommitted pending approval; no live deployment.
- **Refs:** `apps/cox-publisher/README.md`; private `.cox/local-rehearsal/epoch-successor-admission.json`.

### 2026-10-25 · Peter (Codex) · Isolated lifecycle rehearsal and launch timing fixes

- **Area:** Native publisher test harness, executor, fresh-genesis helper and publisher README.
- **What:** Peter authorized local section-4 rehearsal while Pause A remains blocked. Actual programs on an offline V1-capable local validator accepted direct 31-asset pool-0 genesis, class-0 CRYPTO, dual collateral, actual SDK requests and native policy-checked publisher transactions. Removed an arbitrary fresh pool-0 rejection and allowed registry-bound current Epochs whose opening precedes Basic admission, while retaining legacy timing and matching-registry checks. Basic deposit/redemption/withdrawal, exact Epoch closing, independently recomputed payouts and owner withdrawals passed. The automatic sealed successor and permissionless entry-free finalization passed. Incremental backup restored 62 files byte-for-byte, rejected wrong-generation/tampered objects and rebuilt 31-asset previews from signed local history.
- **Verification:** Native 219 tests and SDK 106 tests pass. The two explicitly configured local integration tests also passed. Test-only loopback, clock and controlled feed-signature hooks are excluded from production builds. Disposable local signatures are not live Pyth delivery; local policy signing is not Cloud KMS/IAM. Controlled clock advances are not four hours of live operation. The filesystem object transport is not GCS.
- **Rules for agents:** Pause A remains blocked by deployed API lifecycle caching/admission issues and fresh-genesis history compatibility; Pause B is unchanged. No live reset, upgrade, admission, custody mutation or deployment occurred. Keep test keys/reports ignored. Preserve the separate uncommitted Alchemy entry.
- **Open:** Scheduled inclusion through the complete running local services, gRPC/cloud integration and later live acceptance remain separate verification. New scoped commit approval is required before source push.
- **Refs:** `apps/cox-publisher/README.md`; private `.cox/local-rehearsal/epoch-audit.json`, `epoch-empty-audit.json`, `epoch-successor-admission.json`, `archive-report.json`, `native-suite-final.log`.

### 2026-10-25 · Peter (Codex) · Independent Pause A re-check passed

- **Area:** Read-only deployed API verification and isolated release tests; no protocol/API implementation changes.
- **What:** Supersedes the blocked gate in Peter’s 2026-10-25 “Independent Pause A verification found lifecycle-cache blockers” entry and the later fresh-genesis history requirement. Verified Cloud Run `cox-app-api-live-00029-2vs` at 100% traffic with image `6d72ce9`; five VM source files match that release exactly with CRLF line endings. Independently ran all 144 API tests and TypeScript check. Compiled fixtures verify Active → Archived/Preparing reload and archived admission rejection. Fresh-history sequence-1, legacy-0, segment restart and missing-history tests pass. Both APIs match confirmed current pool/Epoch accounts and serve contiguous publications 0–57 with matching sequence/batch/commitment identities, healthy feed, covered custody and fresh previews. No new polling was added.
- **Rules for agents:** Pause A is cleared. This does not bypass the remaining local running-services/scheduled-inclusion rehearsal, final inventory, committed-source release, future reset boundary or Pause B. Peter withheld the local-fix commits until this re-check; approval is still required before any commit/push. No live mutation, commit or deployment occurred during verification. Preserve the uncommitted Alchemy entry.
- **Open:** Fresh actual generation selection and prepared transactions remain Pause B work. Historical API instances retain different observation/finality metadata and optional flow detail; do not equate those fields with the matching immutable publication commitments.
- **Refs:** Joel commits `0476586`, `5f1725e`, `6d72ce9`; private `.cox/pause-a-recheck-6d72ce9/verification.json`, `source-verification.json`, `chain-comparison.json`.

### 2026-10-25 · Peter (Codex) · Versioned fresh inclusion class reservation

- **Area:** `packages/cox-methodology/rust`, native inclusion validator and tests.
- **What:** Local fresh-generation inclusion exposed the legacy unconditional class-30 reservation. Transition request v1 retains CRYPTO class 30; explicit v2 reserves CRYPTO class 0 and permits underlying class 30. Native successor validation binds the request version to the canonical predecessor schema. Existing asset bindings and origins remain immutable; the legacy commitment digest is pinned unchanged.
- **Verification:** Methodology 26 tests and native inclusion checks pass; the actual local 31→32 transition passed with fresh class 0.
- **Rules for agents:** Use request v2 only for fresh universe schema 2. Do not silently reinterpret a v1 request or change legacy commitments.
- **Refs:** `packages/cox-methodology/README.md`; private `.cox/local-rehearsal/completion-verification.json`.

### 2026-10-25 · Peter (Codex) · Rotate due closing timestamps without substituting prices

- **Area:** Native scheduler, worker, protocol and worker tests.
- **What:** Supplements Peter’s earlier “Missing closing data yields publisher scheduling turns” entry: entry/maintenance fairness alone did not stop an older missing Epoch close from monopolizing later close-only work, including an inclusion boundary. Added a persisted optional closing-timestamp cursor with backward-compatible checkpoint defaults. Due timestamp groups rotate; work at one exact timestamp remains batched together. Missing data remains pending under its original timestamp.
- **Verification:** Actual local first attempt captured the boundary but safely required rescheduling while the old market and accepted deposit continued. After the fix, the exact replacement boundary publication and full inclusion completed. Restart tests cover multiple missing closes followed by a later available boundary. No freshness window or 24-hour failure rule changed.
- **Rules for agents:** Never replace an unavailable closing reference with a later price or permanently skip its round.
- **Refs:** `apps/cox-publisher/README.md`; private `.cox/local-rehearsal/inclusion-attempt-1/`.

### 2026-10-25 · Peter (Codex) · Grow expanded publication staging before price work

- **Area:** Native chain reader, executor, instruction builder and tests.
- **What:** The actual contract rejected the first post-inclusion publication because 33 classes require 16 KiB batch/publication accounts while their previous allocation was 8 KiB. Added bounded growth maintenance before new price work. Expanded-account sizes join the existing confirmed methodology batch read; no polling timer or additional RPC request is introduced. Both allocations enter the final signing guard. Growth uses the generated ABI’s writable permissions and is resumable, bounded to 8 KiB per account step, and forbidden during accepted Basic work.
- **Verification:** Actual local growth of both accounts succeeded, followed by publication and older frozen-Epoch settlement. Unit coverage includes partial completion/restart, complete allocations, malformed oversizing, accepted-stage protection and maximum-class page bounds. No contract source, economic arithmetic or ABI changed.
- **Refs:** `apps/cox-publisher/README.md`; private `.cox/local-rehearsal/publisher-frozen-close-final.log`.

### 2026-10-25 · Peter (Codex) · Disabled signer template supports bound registry registration

- **Area:** `apps/signer/config/dev-dynamic.json`, generation linkage tests.
- **What:** Local policy signing correctly rejected missing `register_asset_registry_version` permission. Added that already-validated instruction to the disabled release template with operator, registry/pool/system bindings and exact writable indices. Existing protocol-linkage validation still checks the canonical methodology, registry generation and approved successor schedule. The program remains disabled; no live signer configuration changed and no admin instruction was added.
- **Verification:** All 92 signer tests and type check pass. New compiled-fixture policy test accepts only the bound operator and rejects archived generations. Actual local registry registration passed the same policy/linkage functions.
- **Refs:** `apps/signer/test/generation-linkage.test.ts`; private `.cox/local-rehearsal/registry-policy-tests.log`.

### 2026-10-25 · Peter (Codex) · Local scheduled inclusion and frozen Epoch acceptance verified

- **Area:** Native local integration harness, actual programs/SDK/policy execution, existing READMEs.
- **What:** Completes the controlled local inclusion checks left open by Peter’s earlier “Isolated lifecycle rehearsal and launch timing fixes” entry. An exact signed 31→32 synthetic capture activated immutable registry version 2 and adopted the new anchor/feed watch in one uninterrupted publisher process. Benchmark level, existing class backing/units, fees, liabilities and permanent origins were preserved. The earlier boundary deposit completed under version 1 across the first boundary and incurred exactly one 200-base-unit fee. Failed attempts and explicit cancellation/rescheduling evidence are retained privately.
- **Verification:** The actual wrapper settled the older frozen 31-asset Epoch from a global 32-asset snapshot: its on-chain closing digest matches the full signed-history commitment, its prices are filtered to 31, and the successor freezes 32. The 999800-base-unit payout was withdrawn, leaving only the 200-base-unit fee. Post-inclusion backup restored 924 files byte-for-byte, exported ten publication records and rebuilt 32-asset previews; tampering and wrong-generation restores were rejected. Final suites: native 225, SDK 106, signer 92, methodology 26; SDK/signer type checks and diff check pass.
- **Rules for agents:** These are isolated-validator and production-component results using disposable keys and controlled signed feeds. They do not certify live Pyth/gRPC, Cloud KMS/IAM, GCS transport, subsecond latency or four hours of real elapsed operation. Test-only loopback, genesis and clock scopes do not relax production network/authentication checks. No live mutation, commit or deployment occurred. Preserve uncommitted Alchemy records.
- **Open:** Scoped commit approval, final old-account inventory, reviewed release build/cutover and future reset capture remain. Pause A is passed; Pause B and live section-5 acceptance remain required. An intentionally missing-close predecessor remains unsettled only in the disposable test ledger.
- **Refs:** `apps/cox-publisher/README.md`, `packages/cox-methodology/README.md`; private `.cox/local-rehearsal/completion-verification.json`, `epoch-post-inclusion-verification.json`, `archive-post-inclusion-report.json`.

### 2026-10-25 · Joel (Claude Code) · Archived legacy market read correctly; unnamed Epoch coins

- **Area:** `apps/app-api` (`src/cox/live-source.ts`, `src/cox/epoch-source.ts`, `src/main.ts`); Cloud Run `cox-app-api-live`, dev VM.
- **What:** Follows Peter's 2026-10-25 email that pool 2 and Epoch config 2 are Archived on chain.
  - **Startup bug:** archiving gave pool 2 a lifecycle marker but no generation id or asset registry. The API refused to start on that (`PoolGenerationMissing`), and the VM API was down for a few minutes after a redeploy. A pool with a lifecycle but neither a generation nor a registry is now read as a legacy pool (`generation: null`, history from publication 0); one with only one of the two is still refused (`199a047`).
  - **Status:** both APIs report gate and lifecycle `archived`, trading closed, and both Epoch rounds `entriesOpen: false`. The chain-change feed is `unhealthy` because the publisher is stopped, so this came from the start-up read and the 20-minute safety read; no faster polling was added.
  - **Unnamed Epoch coins:** an Epoch asset id the methodology does not name is returned as `#<id>` with a one-time warning, instead of failing every Epoch route (Godwin's request in his 2026-10-25 Epoch entry). Tests cover entering with an unnamed coin and choosing 30 of a 32-coin round (`9a91900`).
  - **Tests:** 147 pass.
  - **Deployed:** Cloud Run `cox-app-api-live-00031-s9d` (image `cox-app-api:199a047`, settings unchanged) and the VM at `199a047`.
  - **Verified on both:** publications 0 to 61 without gaps, vault covered, previews `stale`.
- **Rules for agents:** Do not treat a lifecycle marker as proof of a fresh generation; read the generation id and registry.
- **Open:** Pause B: pool 3 and Epoch config 3 identities from Peter, then their `pool-3/` prefixes.
- **Refs:** commits `9a91900`, `199a047`.

### 2026-10-25 · Joel (Claude Code) · Pause B prepared; live APIs not switched

- **Area:** `apps/app-api` (`src/cox/epoch-source.ts`); Cloud Run `cox-app-api-live`, dev VM; Firestore `cox-app-api`; local branch `pause-b-pool-3`.
- **What:** Peter's 2026-10-25 Pause B request for Basic pool 3 `Dwkxra6m…ETZT` and Epoch config 3 `GrCCt9M2…aPhs`.
  - **Preparation fix:** the Epoch program lets anyone prepare a round while its configuration is Preparing and refuses only Archived. The API refused anything but Active, so it could not build the 16:00 round's preparation before admission opens. It now refuses only Archived (`62a64e8`). The Preparing fixture builds a preparation; an Archived configuration is still refused. 148 tests pass.
  - **Deployed:** Cloud Run `cox-app-api-live-00032-vn6` (image `cox-app-api:8d9a3f6`) and the VM at `8d9a3f6`, both still on archived pool 2.
  - **Staged, not applied:** the VM switch to pool 3 is commit `102f4a1` on local branch `pause-b-pool-3`, not pushed, so no deploy from `working` can switch early. It sets pool 3, Epoch config 3, the three `pool-3/` prefixes and the new state directory `/opt/eox/state/cox-app-api-live-pool-3`. On Cloud Run the switch is `COX_POOL_ID=3`, `COX_EPOCH_CONFIG`, the three `pool-3/` prefixes and `APP_API_HISTORY_GCS=gs://colosseum-cox-app-api-history-dev/pool-3/`; RPC and secrets stay the same.
  - **Isolation:** both `pool-3/` storage prefixes are empty. Submissions go to Firestore `coxSubmissionsPool3`, whose expiry policy is now set.
- **Rules for agents:** Do not switch either API to pool 3 before Peter's initialization-ready message; the accounts do not exist yet, and the API would fail at start.
- **Open:** Peter: the ready message with the methodology and registry-version addresses and digests.

### 2026-10-26 · Godwin (Claude Code) · Web app tidy-up from Peter's review; landing product cards

- **Area:** `apps/web` (navigation, charts, Epoch page, landing page).
- **What:** At Godwin's request, following Peter's review notes.
  - **Wording:** `$CRYPTO` is shown as "the benchmark" (`CRYPTO_NAME = "Benchmark"`), and "back a coin" is now "trade an asset's performance". The class id sent to the API is still `CRYPTO`.
  - **Navigation:** the sidebar has a Trade tab (Markets, assets and Epochs, with a Basic / Epoch switch). Swap and Faucet moved to the sidebar footer, and the logo is the only link home. A hint links to the Faucet when the wallet holds nothing (`funds-hint.tsx`). The Circle USDC and Solana faucet links no longer need a wallet.
  - **Charts:** candles are the default; the on-chain settlement dots are removed, since adaptive publication makes them either sparse or crowded.
  - **Epoch:** uses the API's `closingDeadline`, `refund`, the `empty` phase and the configuration `lifecycle`, and the `epoch-refund` and `epoch-void` builders.
  - **Landing:**
    - Out-of-date claims are corrected: Pyth prices every second, fills within seconds, a 0.20 USDC fee cap, Google login and rlUSD.
    - The footer's test-product and not-financial-advice lines are removed at Godwin's request.
    - A new Products section shows Basic, Epoch and the benchmark as stacked sticky cards.
    - The feature grid now has one wide card and three below it, with status labels.
  - **Verified:** 136 web tests and the type check pass. The landing page was checked in a browser at 1440px only.
- **Rules for agents:** Do not tell users they can hold the benchmark; the landing page no longer says so. The Epoch product card's countdown, pot and entry count are labelled example figures, not live data.
- **Open:** the Swap page, the Benchmark page's swap card and "pay with benchmark" on Buy still offer benchmark entry; whether to remove them is Godwin's decision. The landing cards have not been checked at phone width.
- **Refs:** commits `c31b076`..`1677dc6`.

### 2026-10-26 · Joel (Claude Code) · Empty chain feed no longer refreshes Solana every second

- **Area:** `apps/app-api` (`src/cox/chain-changes.ts`); Cloud Run `cox-app-api-live`, dev VM.
- **What:** Peter found (2026-10-26 email) that `ChainChangeFeed.tick()` set `catchUp = this.cursor === null` on every tick. With the publisher stopped, no notifications arrived, the cursor stayed null, and each one-second tick told both APIs to refresh from the chain. Each refresh was one `getMultipleAccounts` plus the Epoch configuration's `getAccountInfo`, about 215k to 219k CU an hour overnight. The start-up catch-up is now latched on its own, independent of the cursor (`67f673a`). An empty, invalid or failing feed stays `unhealthy` and asks for no chain reads. Recovery, a new generation, a skipped revision and the 20-minute safety read still trigger one refresh each.
  - **Tests:** 149 pass. A new test runs 10 empty, 10 invalid and 10 failing ticks and gets one catch-up each; it fails on the previous code.
  - **Deployed:** Cloud Run `cox-app-api-live-00033-dqz` (image `cox-app-api:67f673a`) and the VM at `67f673a`, both still on archived pool 2.
  - **Quiet window:** `status.chain.readAt` stayed at its start-up value for 90 seconds on the VM and 96 seconds on Cloud Run, with the feed `unhealthy`.
- **Rules for agents:** Never derive a chain catch-up from feed state that can stay empty; latch one-off work separately.
- **Refs:** commit `67f673a`.

### 2026-10-26 · Joel (Claude Code) · Live APIs switched to Basic pool 3 and Epoch config 3 (Pause B)

- **Area:** `apps/app-api` (`src/cox/chain.ts`, `src/cox/epoch-source.ts`), `deploy/dev`; Cloud Run `cox-app-api-live`, dev VM.
- **What:** After Peter's 2026-10-26 initialization-ready email, both live APIs read Basic pool 3 `Dwkxra6m…ETZT` and Epoch config 3 `GrCCt9M2…aPhs`. Supersedes the "not applied" status in Joel's 2026-10-25 "Pause B prepared" entry.
  - **Settings:** `COX_POOL_ID=3`, the Epoch config, and the `pool-3/` history, preview and chain-change prefixes. Cloud Run history segments go to `gs://colosseum-cox-app-api-history-dev/pool-3/`, and the VM uses `/opt/eox/state/cox-app-api-live-pool-3`. Submissions go to Firestore `coxSubmissionsPool3`. RPC and secrets are unchanged (`494dceb`).
  - **Genesis predecessor:** publication 1 reported `predecessorSequence: 0`, which does not exist. The first publication in the log now has no predecessor sequence (`a23e5df`). The VM had already logged the wrong value, so its pool 3 log was moved aside (`*.pre-genesis-fix`) and rebuilt from the archive.
  - **Epoch heap:** `epoch-prepare` failed in simulation with `ProgramFailedToComplete`, a write outside the default 32 KB heap. Epoch preparation, empty finalization and void now start with a 256 KB heap request, as the publisher does (`7ce2c40`). A devnet simulation with a funded payer prepared and sealed a whole round in one transaction, using about 700,000 compute units. Nothing was sent.
  - **Deployed:** Cloud Run `cox-app-api-live-00036-g6d` (image `cox-app-api:7ce2c40`) and the VM at `7ce2c40`. 149 tests pass.
  - **Verified on both:** pool 3, methodology digest `9e1bb324…463c`, generation `2699b776…d25d`, registry `94dvDz5J…Fb9`, 31 assets, `cryptoClass` 0, gate and lifecycle `preparing`, `opensAt` 1793030400. History runs 1 to 4 from publication 1 (batch 0, no predecessor), with no publication 0. Vault 0 and covered, feed `healthy`, previews fresh.
- **Rules for agents:** `epoch-prepare` builds for the current four-hour window. Before 16:00 UTC that is the 12:00 round, which must not be prepared; do not submit a preparation before the 16:00 boundary.
- **Open:** At 16:00 UTC: verify permissionless preparation of the 16:00 round, its frozen `state.universe` and the 20:00 close through both APIs. Admission stays closed until Pause B passes.

### 2026-10-26 · Joel (Claude Code) · Every Epoch build requests a 256 KB heap

- **Area:** `apps/app-api` (`src/cox/epoch-source.ts`); Cloud Run `cox-app-api-live`, dev VM.
- **What:** Peter's 2026-10-26 live acceptance found `POST /v1/transactions/epoch-entry` failing with `ProgramFailedToComplete`, the same default-heap write fault as the earlier preparation fix in Joel's 2026-10-26 "Live APIs switched to Basic pool 3 and Epoch config 3" entry. Entry, withdraw and refund now start with a 262,144-byte heap request too, so every Epoch build carries one (`5e7c690`).
  - **Tests:** 149 pass, with instruction positions updated for the heap request.
  - **Deployed:** Cloud Run `cox-app-api-live-00037-bfg` (image `cox-app-api:5e7c690`) and the VM at `5e7c690`.
  - **Verified:** a devnet simulation of an entry on the live sealed 16:00 round (31 assets, configuration `active`) succeeded at 56,671 compute units, the same as Peter's measurement. Both APIs then built that entry (HTTP 200, nonce 0). Nothing was signed or sent.
- **Rules for agents:** Any new Epoch transaction builder must start with the 256 KB heap request; the program fails to read its accounts on the default heap.
- **Refs:** commits `7ce2c40`, `5e7c690`.

### 2026-10-25 · Peter (Codex) · Fresh reset target and committed release preparation

- **Area:** Ignored fresh-generation preparation, inventory and release artifacts; no live protocol mutation.
- **What:** Peter requested tomorrow noon for the new benchmark/reference origin. Recorded 26 October 2026 12:00 UTC (13:00 Lagos), with the first Epoch 12:00–16:00 UTC using existing scheduling. The target remains unarmed pending readiness; an elapsed boundary requires explicit rescheduling. Joel was emailed the target and unchanged Pause B requirement.
- **Verification:** Rebuilt committed `ef3c861` Basic/Epoch artifacts with pinned Agave 2.2.1/platform-tools v1.48 and locked dependencies. Separate production and devnet compiled runtime suites pass: Basic 60 production and 63 devnet; Epoch/combined 22. Initial test-artifact/feature mismatch was corrected before complete reruns. The separate Linux publisher Docker build is in progress on the VM; no installation/restart occurred.
- **Open:** Latest inventory retains the same three approved owners, economic request records and custody bytes, but routine publications changed backing and rounding balances. The discard/archive step is held for Peter's required economic-inventory review. No archival, collateral movement, live upgrade or admission occurred. Preserve the unrelated uncommitted Alchemy entry.
- **Refs:** Private `.cox/fresh-generation-preparation.json`, `.cox/fresh-release-ef3c861/contract-build.json`; Joel email `1a174a4ce99cb89f`.

### 2026-10-25 · Peter (Codex) · Inventory approval and exact-origin capture preflight

- **Area:** Ignored release/capture preparation and immutable cloud evidence; no live protocol mutation.
- **What:** Peter approved excluding the same three test positions despite routine revaluation. Their accounts and collateral remain untouched. The updated81-account inventory was stored create-only through the VM's existing archive identity and downloaded with matching SHA256 `6d9932ce7de2d9f8207866332171b02d6b32032d50c87923c774d552692c4b7b`. The expired local project login was not replaced or given wider permissions.
- **Verification:** An ignored one-off Rust exact-capture helper reuses the committed publisher's feed, trusted-signer and origin validation functions. A real31-feed exact-second preflight at1792960753000000us passed, with zero transactions and0600 create-only output. This test capture must never seed production genesis. Linux helper compilation and the production timer are not complete; no publisher source was modified.
- **Schedule:** Use Peter's allowed four-hours-later option:26October12:00UTC origins; Basic admission lower bound and first Epoch16:00UTC, closing20:00UTC. Joel received this clarification. Admission still requires PauseB. All targets remain unarmed pending release readiness.
- **Open:** The release build remains isolated on the VM. Admin has8.296345732devnetSOL; Basic's temporary upload buffer plus allocation growth needs about9.68SOL. Public faucet request failed; Peter was asked for2–3devnetSOL. No collateral, operator funds, upgrade authority or live service configuration was changed. Preserve unrelated uncommitted Alchemy records.
- **Refs:** Private `.cox/fresh-generation-preparation.json`, `.cox/fresh-release-ef3c861/preflight.json`, `inventory-cloud-archive-result.json`, `exact-capture/preflight-result.json`; Joel email `1a174c74c55b8d1a`.

### 2026-10-26 · Peter (Codex) · Fresh release deployed and legacy generation archived

- **Area:** Basic/Epoch devnet programs, legacy pool2/config2 and immutable cloud archives.
- **What:** Supersedes the pending funding/upgrade/archive status in Peter’s25October “Fresh reset target and committed release preparation” and “Inventory approval and exact-origin capture preflight” entries. Peter funded the existing deployment wallet; committed ef3c861 Basic/Epoch executables were upgraded, downloaded at finalized and matched their reviewed hashes. Authorities and KMS boundaries are unchanged. After intake pause and a final81-account inventory with the same three approved test owners, Basic2 and Epoch config2 were atomically Archived; global Basic intake remains paused. Reactivation simulations reject both archived instances. No collateral moved, positions migrated or refunds executed.
- **Verification:** Existing units, liabilities, custody bytes and request records were preserved. Full stopped legacy state was archived create-only and downloaded with matching SHA25638d5125002868a61ca407c21ad190692cd122018df8650061341679cee664337. Genuine publications0–61 were individually exported and verified without inventing a missing record. The prior incremental-backup cold run timed out; the complete immutable snapshot and individual exports provide preservation. Original VM files remain intact.
- **Rules for agents:** Legacy publisher/preview services and backup timer are deliberately stopped/disabled. Do not restart them against archived instances or recover new state from their directory. New pool3/config3 do not exist yet; admission remains gated by PauseB. Preserve the unrelated uncommitted Alchemy records.
- **Refs:** Private `.cox/fresh-release-ef3c861/basic-deployment-verified.json`, `epoch-deployment-verified.json`, `legacy-archive-verified.json`, `stopped-legacy-cloud-archive-result.json`.

### 2026-10-26 · Peter (Codex) · Exact noon capture armed after VM rehearsal

- **Area:** Ignored operational Linux release and one-off exact Pyth capture; existing publisher remains stopped.
- **What:** Committed ef3c861 Linux publisher and separate exact-capture helper builds completed and their ELF/source hashes were verified. Both binaries were installed in the versioned release directory without changing the current publisher service. The helper successfully verified all31 real signed feeds at exact1792971905000000us under the restricted cox-publisher account. It submits zero transactions. A synchronized-clock systemd timer now preconnects26October11:59UTC and captures only12:00UTC1793016000000000us. No automatic retry or later-price substitution is allowed; output is create-only0600.
- **Rules for agents:** Capture alone does not initialize or activate markets. Actual genesis requires that exact capture and the approved fresh-generation bindings. Basic admission lower bound and first Epoch remain16:00UTC, closing20:00UTC; PauseB still gates admission. Do not use either rehearsal capture as production origins. The one-time12:01UTC follow-up is read-only verification, not an unattended rollout.
- **Open:** Disabled fresh-generation signer image built but artifact upload was denied for the VM identity; the existing local project login is expired. Peter was asked to reauthenticate. No IAM expansion, signer revision, role key, default traffic or live signer policy changed. Fresh pool3/config3 are not initialized. Preserve unrelated uncommitted Alchemy evidence.
- **Refs:** Private `.cox/fresh-release-ef3c861/publisher/release.json`, `exact-capture/provenance.json`, `exact-capture/armed.json`; source ef3c861.

### 2026-10-26 · Peter (Codex) · Business account owns release access

- **Area:** GCP release authentication; operational signer upload.
- **What:** Peter corrected the account assumption: use hello@wades.io for project work, not his personal account. Direct IAM permission checks confirm its existing artifact upload/download, signer service get/update, service usage and service-account actAs permissions. The isolated disabled signer image was uploaded successfully using this identity without changing IAM.
- **Rules for agents:** Check the active business identity and resource-specific permissions before assuming an expired personal login is a blocker. Never request personal-account reauthentication when the authorized business identity already has the required access. The VM identity’s upload denial does not establish that Peter lacks upload access. Short-lived upload credentials were passed privately to a temporary Docker configuration and removed afterward; no keys or credentials are committed.
- **Refs:** Private `.cox/fresh-release-ef3c861/business-account-permissions.json`, `push-signer-business.py`. Supersedes the expired-project-login blocker in the earlier26October “Exact noon capture armed after VM rehearsal” entry.

### 2026-10-26 · Peter (Codex) · Fresh-generation signer canaries verified

- **Area:** Existing eox-signer Cloud Run service and ignored deployment bindings; committed ef3c861 signer source.
- **What:** Using Peter’s corrected business account hello@wades.io, uploaded and deployed disabled and enabled fresh-generation canaries with zero default traffic. Enabled revision eox-signer-fresh-ef3c861-enabled uses image c43979ed9b475b77129e3fdb3b5a2f948b47d7b5ad61e3f24e57e1b053b8462d and the reviewed pool3/config3/shared-registry/generation bindings. Configuration changes between candidates are only the two protocol enable flags. All38 individual instruction policies and four existing combined shapes pass; wrong pool/admin instruction/unsafe writable access/excess priority remain rejected.
- **Verification:** Existing publisher IAM identity authenticated to both canaries and returned the unchanged operator/key directory. Default traffic, every existing tagged revision, signer service account, canonical audience and protected RPC environment values remain unchanged. No signature was requested; no pool/config initialized or admission opened. Temporary business-account upload credentials were removed after use. The prior expired-login blocker is resolved without using the personal account or changing IAM.
- **Rules for agents:** New publisher must use the fresh-generation tag with its existing canonical signer audience and KMS operator; do not repoint default or faucet traffic. Actual genesis still requires the approved26October12:00UTC signed capture. PauseB and16:00UTC admission lower bound remain in force. Preserve uncommitted Alchemy evidence; current operational log entries are uncommitted pending approval.
- **Refs:** Private `.cox/fresh-release-ef3c861/signer-fresh-rollout-verified.json`, `signer-fresh-policy-tests.json`, `business-account-permissions.json`.

### 2026-10-26 · Peter (Codex) · Early Pause B preparation handed to Joel

- **Area:** API integration handoff only; no API/UI implementation or admission change.
- **What:** At Peter’s request, emailed Joel alone the prepared pool3/config3/registry/on-chain generation identities, CRYPTO0 and separate Epoch mapping, isolated archive/preview/notification prefixes, current SDK/fixtures, reference scales and exact26October12:00UTC capture/16:00–20:00UTC Epoch schedule. Sent explicit PauseB evidence requirements for both Cloud Run and VM. New accounts still depend on the noon capture and are not initialized.
- **Rules for agents:** Joel can stage configuration now but must not switch consumers or start missing-account polling against uncreated instances. No old-generation caches/history/submissions may be reused. Final methodology/version addresses and digests plus runtime feed identity must come from verified initialization, not guesses or the on-chain generation hash. Admission stays closed until actual deployed evidence passes PauseB;16:00 is only the earliest bound. The first round can only be instantiated at its real boundary.
- **Refs:** Email1a17587e4593a7f9; `packages/cox-client/README.md`; private `.cox/fresh-generation-preparation.json`. No credentials or Godwin CC were included.
