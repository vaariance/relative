# COX P1 mechanism and protocol specification

Version 0.5 · 11 October 2026 · **Configurable fee extension; devnet test collateral only**

Authority: SYSTEM.md v2.4, product.md v13 and COX Paper 3 v0.1. This document
records P1 rules and the P3 implementation ABI; it does not change SYSTEM.md or claim
sign-off. All `MVP-0` outputs are test-mechanism claim values, not promised
reference returns. P2's Rust crate supplies the calculations; compiled-program
verification and deployment evidence are separate P3 deliverables. Version 0.4
records Peter's approved bounded-storage change: one reusable batch and one
latest publication per pool. This revision is not evidence that the upgrade is
deployed, and does not amend SYSTEM.md or claim its sign-off. Version 0.5 adds
Peter's approved fee policy below; it does not rewrite any sealed methodology.

## 1. Deliverables and activation boundary

- `crates/math` and `crates/cli`: Rust protocol arithmetic and JSON command interface.
- `fixtures/vectors.json`: frozen synthetic reference, transfer, flow and wire vectors.
- `../cox-methodology/rust`: inclusion lifecycle and Epoch research simulation.

Implementation-path update (22 October 2026): the original P1 TypeScript compiler,
arithmetic oracle and draft-manifest generator have been retired after their
consumers migrated to Rust. This does not change this historical specification's
economic rules or any sealed identity.

Joel can use the asset order, identifiers, decimal scales, digest bytes and
request conditions now. Godwin can use the same references and user outcomes.
Neither should describe the draft roster as sealed. A seal requires Joel's
seven-day feed report, removal (without substitution) of failing assets,
actual common origin and an explicit Bybit-access decision. The compiler binds
the report digest but does not verify its conclusions or grant team sign-off.

The checked-in draft disables Bybit pending Joel's VM/terms check. This is the
SYSTEM §10.1 permitted no-Bybit branch, not a claim that Bybit failed. Changing
that flag changes the manifest digest. No origin date is fabricated.

### Execution rule approved by Peter

A request becomes eligible from the next valid publication after submission;
it never executes when created. The snapshot must still be accepted by +55 s,
but eligible fills have no hard deadline. Once accepted, a batch continues at
its fixed valuation until complete; a slow batch is not cancelled, rolled or
repriced. No next publication starts until that batch completes. Expiry uses
the accepted batch ID, not the later fill time.

`COX/BATCH/ASYNC/V1` uses publish → execute → finalize. Preparation may span
transactions; finalization makes the resulting ledger/receipts spendable.
These mechanics do not promise a fill time. Discarding an accepted batch merely
because time elapsed is forbidden. Joel and Peter provision and load-test to
complete the supported workload within a minute; measure queue age, throughput,
worker recovery and chain confirmation latency. P3 must demonstrate the
implementation and capacity envelope. Network timing is outside server power.

## 2. Integers and exact operation order

All integers in JSON fixtures are decimal strings, except small enum codes,
array indices and synthetic batch numbers. No JSON floating-point amount.

| Quantity | Representation |
| --- | --- |
| Price | positive USD × 10^8, `u64` |
| Benchmark, growth, relative reference | positive/nonnegative `i128`, scale S = 10^12 |
| Backing, pending, payable, residual, vault | collateral base units, `u64` |
| Position and class units | unit quanta, `u128`; S quanta = one whole unit |
| Time, batch and publication sequence | nonnegative `u64`, Unix seconds for time |
| Class index | `u8`; assets 0..N−1, CRYPTO = N |

`R(n,d)` is nearest rounding of n/d, ties away from zero; d must be positive.
`F(n,d)` is floor for nonnegative n,d. Every multiplication, sum, division
input and output is checked in signed i128; stored fields are additionally
range-checked for their declared type. An overflow rejects the entire proposed
publication, never wraps, saturates or truncates. P2 must quantify the usable
numerical envelope; u64/u128 storage alone does not promise that every possible
stored value can be multiplied. Zero denominator is a named error. Fees = 0.

Kraken/Coinbase strings match `^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$` and convert
exactly to e8; even a ninth trailing zero is inadmissible under SYSTEM §5.1.
The original text/bytes remain evidence; a lexical format that this exact
conversion cannot represent is rejected rather than silently rewritten. No
precision is removed. Bybit conversion applies
`R(close_USDT × USDT_USD × 10^8, 1)` to the exact rational values of both source
decimals, only once at the end. The conversion rate must come from the same
cutoff traded Kraken or Coinbase candle; a carried conversion is forbidden.
Do not apply `exactUsd` to Bybit's intermediate input strings.

## 3. Manifest and identities: COX/WIRE/V1

Manifest canonicalization is the **fixed nested array** built by
`compileManifest`, not object-key sorting. Encode compact `JSON.stringify`
UTF-8, no BOM, whitespace or trailing newline. All monetary constants and
weights are decimal strings; clocks are small JSON integers. Array slots:

0 domain; 1 version; 2 draft/sealed; 3 feed-report SHA-256 or null;
4 ordered asset tuples `[id, krakenWs, krakenRest, coinbase|null, bybit|null,
weightNumerator, weightDenominator]`; 5 quote and price scale;
6 common-origin rule/time/base; 7 candle/fallback/Bybit/conversion/age rules;
8 clocks and rebalance freeze; 9 network/role/runtime public key;
10 transfer/test-only/fee; 11 scales/types/rounding/residual;
12 accounting/batch/wire rule IDs. The compiler is the exact slot definition.

Weights are exact rational 1/N, not rounded basis points. The roster is a
canonical subsequence of SYSTEM §4.1, preserving that order after removals.
Benchmark and tradable rosters are identical. CRYPTO is not a source asset.
Runtime key is the existing public dev key from `deploy/signing/dev-keys.json`;
program, pool and collateral addresses will be bound at P3 deployment, not
invented in a methodology draft. Activation checks the decoded 32-byte key,
network and deployed config; the draft compiler only checks base58 syntax.

Binary encodings below use little-endian integers. `str` = u32 byte length +
UTF-8 bytes, `vec` = u32 item count + items, `bytes32` = raw 32 bytes.
No hex text is hashed where bytes32 is specified. Enum `u8`; option = u8 0 or
1 + value. No implicit padding or serialization of struct field names.

| Identity | Exact bytes hashed with SHA-256 |
| --- | --- |
| Artifact | unmodified response/frame archive bytes |
| Price | `str("COX/PRICE/V1"), str(asset_id), venue:u8, step:u8, candle_start:u64, price_e8:u64, trade_age_minutes:u16` |
| Snapshot | `str("COX/SNAPSHOT/V1"), cutoff:u64, vec<price_digest:bytes32>` |
| Manifest | canonical JSON UTF-8 above |
| State | `str("COX/STATE/V1"), program:bytes32, pool:bytes32, sequence:u64, batch:u64, cutoff:u64, previous_state:bytes32, manifest:bytes32, snapshot:bytes32, benchmark:i128, vec<price:u64>, vec<reference:i128>, vec<pre_backing:u64,pre_units:u128,post_backing:u64,post_units:u128>, executed:u32,rejected:u32,active:u64,pending:u64,payable:u64,residual:u64,receipt_root:bytes32` |

Venue codes: Kraken 0, Coinbase 1, Bybit 2. Step/venue pairs: (1,0), (2,1),
(3,2), (4,0). Steps 1–3 have age 0 and candle_start=cutoff−60. Step 4 has
candle_start=cutoff−60−60·age, age ≤30, for Kraken's last traded candle.
The carried source candle's end establishes age; archive time never does.
Snapshot arrays have exactly N members in manifest order. A price digest does
not bind source evidence or authenticate a venue. Publication binds the
manifest and snapshot together; replay protection is program/pool/sequence
and predecessor, not the snapshot hash alone.

Receipt root: initialize SHA-256 of `str("COX/RECEIPTS/V1")`; fold each receipt
in immutable queue order as SHA-256(previous_hash || receipt_bytes).
Receipt bytes are `request:bytes32, status:u8, minted:u128, proceeds:u64`.
Statuses: Filled 0, ConditionFailed 1, Expired 2, ZeroValueClass 3.
Cancelled requests are excluded from execution counts/root; their queue
slots remain tombstones. A state with no predecessor uses 32 zero bytes.
The initial publication has no flows and initializes all price origins and
B=Q=100S. It may not retrospectively execute requests submitted before pool
initialization. The initial snapshot must meet the ordinary admission rules.

## 4. Reference engine

At origin save each P_i,0, and B_0=100S. At each later **successful publication**:

```
g_i = R(P_i,k · S, P_i,previous)
g_B = R(sum(g_i), N)
B_k = R(B_previous · g_B, S)
A_i = R(P_i,k · S, P_i,0)
W = R(B_k · S, 100S)
Q_i = R(100S · A_i, W)
h_i = R(g_i · S, g_B); h_CRYPTO = S
```

Reject B_k≤0, g_B≤0 or W≤0. Rounding is applied at **each line**, not once on
a combined rational expression. This explicitly resolves the finite-precision
interpretation of SYSTEM §4/5; it must be included in P2/monitor parity.

A missed minute has no prices, reference or revaluation inserted. Use the last
accepted prices/B once across the whole interval. Equal accepted gross returns
leave Q unchanged subject to the declared integer precision. Reference Q is
independent of pool allocation. No confidence, market cap, volume or signal
multiplier enters this arithmetic.

## 5. Transfer engine: COX/TRANSFER/MVP-0

Use active class backing only, excluding pending, payable and residual.
Let C=sum V_j, s_j=V_j·h_j, D=sum s_j, including CRYPTO.

```
V'_j = F(C · s_j, D)
transfer_residual = C − sum(V'_j)
```

Unit counts do not change. Move transfer_residual from active to the named
residual ledger. If C=0, backing stays zero, residual=0, skip the denominator.
If C>0 and D=0, reject the publication. A class with U=0 must have V=0;
a positive unit count with zero backing is permitted and cannot accept entry.

Integer transfer residual is never reallocated in a later publication, never
withdrawn by the operator and never earns returns. With only one funded class
and positive h, its backing is unchanged. MVP-0 does not guarantee Q-return
payouts. Finite rounding of h may also prevent perfect algebraic cancellation
of the common benchmark factor; the above operation order wins.

## 6. Fixed prices and aggregate flow accounting: COX/ACCOUNTING/V1

Fix rational valuation `(v_j,u_j)=(V'_j,U_j)` **once before all flows**.
Do not round a stored unit-price scalar or recompute a price after each request.
For an empty class use `(v,u)=(1,S)`; minting d base units then issues dS quanta.
For U>0,V'=0 reject deposits/switches into that class with ZeroValueClass.

```
deposit d: minted = F(d · u_to, v_to)
redeem x: proceeds = F(x · v_from, u_from)
switch x: intermediate = F(x · v_from, u_from)
          minted = F(intermediate · u_to, v_to)
```

Check conditions on these integer outputs. Positive deposits or switches
minting zero fail even if minimum=0. A zero-value redemption with minimum=0
may burn units for zero proceeds, allowing holders to close a worthless class.
Rejected requests change no active units. Never reserve more source units than
an owner has unlocked; sum of reservations cannot be offset with future mints.

Accumulate accepted burn/mint deltas; do not debit `ceil(x·p)` for each request.
At finalization, for **every class**, calculate:

```
U_final = U_before − accepted_burns + accepted_mints
V_final = F(U_final · v, u)
flow_residual = sum(V') + accepted_deposits − redemption_payables − sum(V_final)
```

For the empty-class bootstrap `(1,S)` use the same expression. Check
flow_residual≥0, add it to residual. All accepted deposits leave pending;
redemption proceeds become withdrawal payables. Rejected deposits remain
owner-specific refundable pending obligations, not active backing. A switch's
intermediate is internal, never added to vault/pending/payable.

Proof of conservation: each minted rational value ≤ its accepted deposit or
switch intermediate; each payable ≤ its burned rational value; flooring each
final class value cannot increase the sum. Consequently flow_residual≥0.
This aggregate rule prevents request-order dependence and avoids rounding up
many individual backing debits beyond a class's backing. Splitting requests
cannot increase the sum of minted units or redeemed proceeds because floor is
subadditive in this direction. P2 must verify these claims on mixed paths,
reservation constraints and repeated publications, beyond P1 smoke checks.

The Paper 3 §12 vector intentionally supplies post-revaluation backing 90/60;
it does not pretend those figures follow from unspecified prices. At S=10^12,
30 deposited into A mints 33,333,333,333,333 quanta. Its exact rational value
is slightly below 30. Final A backing floors to 119, B backing is 48,
payable=12, residual=1, vault=180. After paying 12, vault=168 and
active167+residual1=168. The paper's infinite-precision active168 becomes
active167 plus named residual1 under this discrete policy.

## 7. Batch and request lifecycle

`batch_id` names scheduled minutes; `publication_sequence` counts successful
commits. They are different: a missed batch advances the former only.
SYSTEM §5.2's “next sequence” means next publication sequence, not a ban on
skipping missed scheduled batches. Store both on every publication/receipt.

For submission time t≥origin, target_batch=floor((t−origin)/60)+1. Cutoff
belongs to the next batch exactly at the boundary. Expiry is an inclusive
scheduled batch ID and must be ≥target_batch. Source units remain exposed
through all missed minutes; deposits remain pending and earn no past return.

Request states: Queued → Bound/Staged → Filled/Rejected on final commit;
Queued → Cancelled before its eligible cutoff; Queued → Refunded only after
cancellation/rejection/expiry authorizes release. Staged is not a public fill.
Accepted requests remain binding until completion. Unaccepted rolled requests retain immutable original
target and expiry; a queue scheduler records effective eligible batch.
Expiry is checked before conditions; cutoff_batch>expiry produces Expired.
`expire` can reject an overdue request without a publication, releasing units
or marking a deposit refundable. It must never execute at a stale valuation.

Publication states: Idle → Executing → Committed → Idle. `publish` checks full snapshot, predecessor, archive attestation and
cutoff≤Clock≤cutoff+55. `execute` deterministically stages pending requests in
queue order, including rolled requests; one processed cursor prevents replay.
`finalize` requires the complete closed queue, unchanged predecessor, valid
ledger and no admin pause; it has no time deadline. It atomically activates staged ledger,
reference, receipt and position-version roots. No next publish during Staging.
An execution overrun keeps the batch active at the same fixed values. Admin
pause suspends execution without cancelling or repricing its binding requests. Archive by +30 is an operator attestation
checked by Joel/publisher/monitor; the program cannot authenticate database time.

During Staging, future-batch submissions may escrow tokens and lock units that
are currently unlocked; they cannot consume staged mints or units reserved by
the closed batch. Withdrawals spend only already committed payables. Stage
tracks deltas rather than overwriting current pending/payable totals so these
operations cannot be lost. Position entitlements are versioned: readers and
instructions materialize committed receipt deltas before spending. No staged
outcome, minted unit or new payable is spendable before finalize. P3 must prove
this implementation against concurrent submissions/withdrawals, pauses and restarts.

Cancellation: normal mode before the effective eligible cutoff, including a
rolled request reopened for a future minute; no cancellation of a closed batch.
At 60 missed cutoffs SYSTEM §9 permits cancelling unbound pending requests
even after cutoff and refunding their pending deposits. Requests already bound
to an accepted executing batch cannot be cancelled this way. Halted mode rejects withdraw too, even
for pre-existing payables, because SYSTEM says “only” cancellation/refund.
That interpretation is explicit for review, not an added stale redemption.
A valid publication may resume a staleness halt; it cannot override admin pause.
Admin pause prohibits financial execution/publication and new requests;
refund/cancel remains available. Admin unpause is required to resume.

## 8. Account schema contract

The commitment encoding remains `COX/WIRE/V1`; account storage has the rolling
ABI described below. The generated IDL and fixtures must match the built
program. The deployment manifest separately identifies the deployed build.
All public keys are bytes32. All accounts start with
`SHA256("account:"+Name)[0..8]`, then schema_version:u16, bump:u8.
Batch and Publication use schema version 2; every other account remains version 1.
Vectors are length-prefixed. Fixed arrays use N from the immutable manifest.
Account owner must be the cox program; validate discriminator, length, PDA,
pool linkage and version before reading. Untrusted caller fields never supply
an authority or ledger balance.

The table retains the P1 field outline. Section 11's implementation additions
and generated IDL define the actual payloads; StagePage below is a superseded
draft and is not an implemented account. The fixed Batch/Publication addresses
and their schema version 2 apply to the rolling-storage implementation.

| Account (PDA seeds in order) | Payload fields in serialization order |
| --- | --- |
| Registry (`"registry"`) | admin:pubkey, runtime:pubkey, pending_runtime:option<pubkey>, runtime_effective_batch:u64, paused:bool, next_pool_id:u64 |
| Methodology (`"methodology"`, digest32) | digest:bytes32, canonical:vec<u8>, sealed:bool, activation_batch:u64 |
| Pool (`"pool"`, pool_id:u64LE) | pool_id:u64, registry:pubkey, methodology:pubkey, collateral_mint:pubkey, vault:pubkey, origin:u64, last_batch:u64, sequence:u64, state_digest:bytes32, benchmark:i128, vec<origin_price:u64>, vec<last_price:u64>, vec<reference:i128>, vec<Class>, active:u64, pending:u64, payable:u64, residual:u64, next_request_nonce:u64, stage:option<pubkey> |
| Position (`"position"`, pool32, owner32) | pool:pubkey, owner:pubkey, applied_sequence:u64, vec<units:u128,locked:u128>, payable:u64, refundable:u64 |
| Request (`"request"`, pool32, nonce:u64LE) | pool:pubkey, owner:pubkey, nonce:u64, target_batch:u64, expiry_batch:u64, operation:u8, from:u8, to:u8, amount:u64, units:u128, minimum_units:u128, minimum_proceeds:u64, status:u8, eligible_batch:u64 |
| Batch (`"batch"`, pool32) | pool:pubkey, batch_id:u64, cutoff:u64, predecessor_sequence:u64, predecessor_digest:bytes32, snapshot_digest:bytes32, vec<PriceWire>, benchmark:i128, vec<reference:i128>, vec<fixed_backing:u64,fixed_units:u128>, vec<burns:u128,mints:u128>, accepted_deposits:u64, new_payable:u64, transfer_residual:u64, executed:u32, rejected:u32, closed_queue_end:u64, cursor:u64, staged_root:bytes32, receipt_root:bytes32, accepted_at:u64, status:u8 |
| StagePage (`"stage"`, batch32, page:u32LE) | batch:pubkey, page:u32, vec<request:pubkey,receipt_status:u8,minted:u128,proceeds:u64>, page_digest:bytes32 |
| Publication (`"publication"`, pool32) | state preimage from §3, vec<venue:u8,step:u8,trade_age:u16>, committed_at:u64 |

Class = backing:u64, units:u128. No separate class account. Vault is a classic
SPL Token account owned by pool PDA, exact mint, no transfer-fee/hook/rebasing
extensions. User token account owner and mint are checked. Program never
accepts caller-provided vault alternatives. Solana account rent is separate
from SPL collateral. Refundable is a subset of pending, not a fifth custody
category. Position payables sum to pool payable; request deposits/refunds sum
to pending; position units/locks reconcile with classes/requests. P3 versioned
receipt application must prevent counting a claim twice.

Operation codes: deposit0, switch1, redeem2. Unused amount/units/minimum fields
must be zero; unused source/destination=u8 255. Request states: Queued0,
Filled1, ConditionFailed2, Expired3, ZeroValueClass4, Cancelled5, Refunded6.
Staging is represented by Batch/StagePage, never changing committed request
status before finalize. Batch states: Executing0, Committed1.
Stage-page digests hash their serialized payload excluding page_digest, with
`str("COX/STAGE-PAGE/V1")` prefix; the staged root folds page digests in page
order from SHA256(str("COX/STAGE/V1")). Page sizes are a P3 capacity parameter
that must be included in the deployed program/IDL release, not user-selectable.

## 9. Instructions, events and errors

Instruction discriminator = SHA256["global:"+snake_case_name](0..8), followed
by fields in listed order using §3 binary encoding. No implicit accounts in
instruction data; account metas appear in the P3 IDL with signer/write flags.
Every mutating instruction validates Registry/Pool linkage and pool vault
balance both before and after it; read instructions do not mutate.

| Instruction / data | Required authority and result |
| --- | --- |
| initialize_registry(admin:pubkey,runtime:pubkey) | deployment admin signer; one-time registry |
| register_methodology(canonical:vec<u8>,digest:bytes32,activation_batch:u64) | admin signer; validate digest/seal; future activation only |
| initialize_pool(pool_id:u64,origin:u64) | admin signer; sealed methodology, test mint/vault; initialize via first admitted origin snapshot |
| deposit(to:u8,amount:u64,minimum_units:u128,expiry:u64) | owner signer; transfer tokens, queue request, pending increases |
| switch(from:u8,to:u8,units:u128,minimum_units:u128,expiry:u64) | owner signer; reserve unlocked units |
| redeem(from:u8,units:u128,minimum_proceeds:u64,expiry:u64) | owner signer; reserve unlocked units |
| cancel(nonce:u64) | request owner signer; timing/halt rules, unlock or mark refundable |
| expire(nonce:u64) | permissionless; expiry passed, no staging reservation, release |
| refund(nonce:u64) | request owner signer; refundable deposit only, transfer exact pending amount |
| publish(batch:u64,sequence:u64,predecessor:bytes32,prices:vec<PriceWire>,snapshot:bytes32,archive_time:u64) | runtime signer; archive_time≤cutoff+30, submit by+55, open stage |
| execute(batch:u64,max_requests:u16) | permissionless; stage bounded next requests at fixed values, no wallet signature or token transfer |
| finalize(batch:u64) | permissionless; all receipts staged, no fill deadline, atomically activate roots and ledger |
| withdraw(amount:u64) | owner signer; amount≤committed payable, transfer and debit once |
| pause() / unpause() | admin signer; immutable audit event, cannot rewrite values |
| rotate_runtime(new_runtime:pubkey,effective_batch:u64) | admin signer; future cutoff, no staging conflict |
| activate_methodology(digest:bytes32,effective_batch:u64) | admin signer; prospective compatible change only |
| read_reference(class:u8), read_position(owner:pubkey), quote_request(operation:u8,from:u8,to:u8,amount:u64,units:u128) | simulated readers; committed state and its age; quotes are estimates |

PriceWire = price_e8:u64, venue:u8, step:u8, candle_start:u64,
trade_age_minutes:u16. Asset ID is derived from canonical array position.
Price/snapshot hashes use the asset string even though PriceWire omits it.
Archive_time is attested, not independently proven. A valid operator signature
never proves venue truth or that an earlier fallback step was empty.

Methodology activation cannot reset price origins, class indices or holdings.
For MVP, changes to roster, origin, transfer rule or arithmetic are rejected for
an existing pool: create a new pool/version and allow explicit user migration.
Runtime rotation preserves all reference and accounting history. This narrows
the admin surface rather than permitting an unspecified migration algorithm.

Events use SHA256["event:"+Name](0..8) plus the listed fields:
RequestQueued(pool,request,owner,target_batch,expiry,operation);
RequestCancelled(pool,request); RequestRejected(pool,request,status);
RequestFilled(pool,request,sequence,minted,proceeds);
DepositRefunded(pool,request,amount); WithdrawalPaid(pool,owner,amount);
BatchAccepted(pool,batch,snapshot);
PublicationCommitted(pool,sequence,batch,state_digest,snapshot,manifest);
PauseChanged(registry,paused); RuntimeScheduled(registry,key,effective_batch);
MethodologyScheduled(pool,digest,effective_batch). Keys/digests=bytes32,
amount/proceeds/sequence/batch/expiry=u64, minted=u128, operation/status=u8,
paused=bool. One financial event per committed effect, never per tentative
stage. Monitor mismatch is an off-chain incident, not a self-executing verdict.

Error codes (u32) are stable from 6000 in this order:
Unauthorized, Paused, Halted, InvalidAccount, InvalidManifest,
UnsealedManifest, InvalidRoster, InvalidPrice, InvalidVenueStep,
InvalidCandle, InvalidSnapshotDigest, TooEarly, CommitDeadlinePassed,
ArchiveDeadlinePassed, WrongPredecessor, Replay, BatchBusy, BatchIncomplete,
InvalidRequest, InvalidExpiry, CancellationClosed, AlreadyProcessed,
InsufficientUnlockedUnits, ConditionFailed, ZeroValueClass,
ArithmeticOverflow, ZeroTransferDenominator, InvalidBenchmark,
VaultMismatch, InvalidCollateral, InsufficientPayable, NotRefundable,
IncompatibleMethodology, InvalidAuthority, InvalidOrigin.
ConditionFailed/Expired/ZeroValueClass at execution become committed rejected
receipts; malformed requests fail submission. Unexpected arithmetic or ledger
errors stop execution for investigation and deterministic recovery; they never
reprice or cancel an accepted batch merely because time has elapsed.

## 10. Handoff and verification

Verify the frozen vectors with `cargo run --manifest-path packages/cox/Cargo.toml
--locked -p cox-cli -- verify-vectors packages/cox/fixtures/vectors.json` and run
the Rust math/program suites. Historical expected vectors are retained unchanged;
the retired TypeScript generator is no longer an executable maintenance command.
These checks do not establish live oracle authenticity or deployment readiness.

The following P1 exchange handoff is historical. The exchange archiver, monitor,
`price-feeds` and exchange-only ingestion implementation were retired in favor
of native Pyth validation. Preserve historical evidence and vectors; do not
recreate exchange polling from this earlier handoff.

Joel: use only `packages/price-feeds` for exchanges; archive source evidence and
fallback attempts, produce canonical observations/snapshot digests and feed
report. API must expose publication sequence separately from scheduled batch,
reference separately from redeemable value, pending/refundable separately from
active, and the residual ledger. Build no unsigned transaction against an
invented program ID; wait for P3 IDL/account fixtures.

Godwin: independent monitor reimplements the **ordered integer operations**,
re-fetches venue evidence through price-feeds, checks all custody categories,
and reports incidents without signing privileges. UI displays test mechanism,
operator attestation, provisional/sealed pilot size, queued/final receipts,
expiry, age/staleness and explicit halt behaviour. It must not show staged fills
as completed or claim next-minute scheduling eliminates front-running.

Remaining gates: Joel feed check and
Bybit decision; actual origin and manifest seal; P2 Rust parity/numerical and
adversarial simulations; P3 IDL, transaction sizing, state-root materialization
and concurrency proofs; deployment/signer bindings. SYSTEM sign-off and real
collateral remain separate gates. No EOX deletion, deployment, commit or push
is part of this P1 draft.

## 11. P3 implementation ABI and safety additions

This section supersedes the draft account/instruction implementation details
in sections 8–9 where they differ. It preserves the canonical methodology,
price, snapshot, receipt-root and state-digest encodings in section 3 and the
P2 arithmetic order. The compiled Anchor-generated `idl/cox.json` describes
the actual account field order, instruction arguments and account metas.
Program source is `programs/cox/src/lib.rs`; client artifacts are in
`../cox-client`. Prepared deployment identities are in `deploy/devnet.json`.
These files do not assert deployment or live-pool activation by their presence.

### Bounded registration and execution

`register_methodology(digest,length,activation_batch)` creates the manifest
account. `upload_methodology(offset,bytes)` appends at the exact next offset,
up to 700 bytes per upload and 8,192 canonical bytes total.
`seal_methodology(config)` reconstructs the typed canonical manifest, checks
exact byte equality and its SHA-256, then seals it. No parser guesses the
meaning of arbitrary caller JSON. The typed configuration contains version,
canonical roster indices, origin, Bybit policy and feed-check digest. A local
synthetic fixture is not a real seven-day report or approval to activate a
live pool.

Active backing plus pending collateral is initially capped at 10^11 base
units, and each class at 10^24 unit quanta. Every request reserves tokens or
unlocked units at submission. Withdrawal of already committed payables and
submission of future requests remain possible while the current batch is
being prepared. No staged credit can fund either operation.

The persistent execution phases are:

| Phase code | Work and completion rule |
| --- | --- |
| 0 | Evaluate closed-queue requests at the fixed publication valuation. |
| 3 | Safety pass computes aggregate accepted burns and incoming mints. Seal the pass; if a destination becomes blocked, repeat with that entire incoming class excluded. |
| 1 | Prepare per-position deltas and permanent request receipts in queue order. |
| 2 | Committed; finalization has activated the global state and position-version effects. |

`evaluate`, `safety` and `execute` each process the next queue slot.
The closed queue span must fit u32; transaction cranks process one slot each.
`seal_evaluation` transitions a completed evaluation or safety pass. A new
publication cannot replace unfinished work, and no phase has a fill deadline.
The safety loop is monotonic: once blocked in that batch, a destination stays
blocked. All incoming requests to an over-capacity class receive the same
rejection, independent of processing order. Repeating the pass accounts for
switch burns that disappear when another destination is rejected.

An individually unsafe request is rejected and its reservation returned.
`SafetyRejected` is receipt status 4 and terminal request status 7, appended
without changing existing codes. `CapacityExceeded` is appended after the
existing error list. Malformed instructions still fail immediately. Snapshot
reference or revaluation failure rejects the snapshot before acceptance;
ordinary unsafe requests cannot force the accepted batch to reprice or abort.

### Actual account additions and receipt storage

Batch and Publication use schema version 2 and fixed per-pool seeds, without
batch ID or sequence in the address. All other accounts retain schema version 1
and their existing seeds. The actual IDL includes these additions to the draft fields:

| Account | Added fields or implementation changes |
| --- | --- |
| Registry | `max_accepted_batch:u64`, `active_batches:u64`; rotation must be later than every accepted batch and waits until no batch is executing. |
| Methodology | `expected_length:u32`, `roster:vec<u8>`, `origin:u64`, `bybit:bool` after the draft fields. |
| Pool | `initialized:bool`, `queue_start:u64`, `stage_batch:u64`, `stage_closed_end:u64` after the draft fields. |
| Position | `staged:bool`, `staged_sequence:u64`, burn/mint/unlock vectors, staged payable and refundable deltas after committed fields. |
| Request | `evaluated:bool`, bound batch/sequence, receipt status, minted/proceeds and `applied:bool` after the draft fields. |
| Batch | Explicit sequence, queue-start/next-queue-start, incoming/blocked vectors, phase and safety-pass flag; use IDL for their exact positions. |
| Publication | Pool, sequence, batch, state/snapshot/manifest digests, complete state-preimage bytes, prices and commit time; use IDL for exact serialization. |

There is no `StagePage` account in this implementation. Each immutable request
PDA holds its staged receipt and bound sequence. The position holds aggregate
deltas for that sequence. Finalization activates them through the global
committed sequence; subsequent instructions materialize those deltas once
before spending, while readers show the same committed view without writing.
A staged request status must not be presented as filled before that sequence
is committed.

The batch's internal `staged_root` is a different implementation commitment
from the draft section 8 page-root proposal. It starts at
`SHA256(str("COX/STAGE/V1"))` and folds each prepared receipt as
`SHA256(previous_staged_root || request_pubkey32 || new_receipt_root32)`.
It does not claim the draft `COX/STAGE-PAGE/V1` hash. The public receipt root
and state digest retain the exact section 3 encodings and golden vectors.
Executed counts filled receipts; rejected counts rejected receipts. Cancelled
tombstones contribute to neither count nor root.

Methodology, roster and origin remain fixed for a pool. Creating and sealing
another methodology does not migrate a live pool; a changed configuration
requires a new pool. This implementation deliberately provides no in-place
`activate_methodology` instruction. Runtime rotation is prospective and does
not rewrite publication history. Read-only reference/position presentation
is provided by checked account readers rather than a separate stored quote
scalar. The price of a future publication is unknown, so any preview is an
estimate and cannot make a queued trade spendable.

### Integration verification

`fixtures/state-vectors.json` supplies full receipt/state bytes and hashes,
including the appended safety status. Generated account fixtures and the IDL
are checked together by the client tests. The runtime signer allowlist is
`deploy/signer-allowlist.json`; the privileged instruction is `publish`.
Permissionless cranks do not require the runtime key on chain. The service
allowlist also permits runtime fee sponsorship of `evaluate`, `safety`,
`seal_evaluation`, `execute` and `finalize` for approved pool batches. Admin,
upgrade and user financial instructions are excluded. The unsigned `read_reference`, `read_position` and
`quote_request` builders expose the program's simulated return-data readers.
`read_position` includes committed lazy deltas; a quote uses committed class
backing/units and does not predict the next publication's execution value.
Registry initialization additionally requires the
actual program upgrade authority and verified upgradeable-loader program-data
account; a random first caller cannot select the admin or runtime identity.
`INTEGRATION.md` records the archive-byte mismatch
Joel must correct, the monitor handoff and the legacy callers retained until
their replacements land. Local test results, build measurements and the
deployment manifest must provide the evidence of completion; this ABI section
does not substitute for those results.

### Rolling storage and publication history

Each pool has one 8,192-byte Batch account and one 8,192-byte Publication
account. They are allocated once and reused. A new `publish` may overwrite
only a committed batch; it cannot replace accepted work in any unfinished
phase. `finalize` replaces the latest Publication only after the complete
batch commits. Batch ID and sequence remain checked payload fields, including
all existing predecessor, replay and publication-time checks.

The latest Publication remains available while the next batch executes.
Readers must obtain a coherent finalized view and verify pool linkage, schema,
sequence, state-preimage hash and decoded state identity. A requested historical
sequence is never silently answered with the current account's contents.

Before submitting another publication, the publisher must durably archive the
current finalized Publication's complete account bytes, full state preimage,
account-byte SHA-256, state digest, snapshot digest, methodology digest,
program/pool identity, sequence and batch. The archive binds these bytes to the
observed finalized chain context. It is separate from Joel's input-price
archive. Persisting only a digest or the `PublicationCommitted` event is
insufficient to reconstruct publication history. Archive failure or a conflicting
record blocks the next publication; restarting must not bypass this gate.
Historical API and monitor consumers read verified archived publications;
direct on-chain readers expose only the latest committed publication. The
program cannot prove an off-chain archive write, so this is a mandatory
publisher operating rule, not an on-chain durability guarantee.

At the devnet rent quote checked on 11 October 2026, each 8,192-byte account
requires 42,265,600 lamports: 84,531,200 lamports (0.0845312 SOL) for the pair
once per pool. Rent must be requoted when deploying. This excludes the program,
registry, methodology, pool, vault, mint, user position/request accounts and
transaction fees; their costs are not bounded by this pair's allocation.

Live activation requires compiled-program rolling-storage tests, publisher
archive/restart tests, archive backup and restore verification, Joel's signer
validation updated for fixed seeds/schema 2, and Godwin's latest/history reader
integration. A program upgrade and its actual build hash must be recorded
separately before these changes are described as deployed.

## Configurable trading fees — `COX/FEES/V1`

This explicit extension supersedes the zero-fee rule for migrated pools only.
The sealed methodology and its digest remain unchanged. Its fee-policy digest
is SHA-256 of the Borsh string `COX/FEES/V1`, methodology digest (32 bytes),
maximum rate `100` (`u16`), maximum cap `2000000` (`u64`) and notice period
`86400` (`u64`), in that order. Integers are little-endian.

The initial configuration is 2 basis points, capped at 2,000,000 collateral
base units ($2 in six-decimal USDC). Admin may select 0–100 basis points and
0–2,000,000 base units. Either zero disables fees. For gross collateral value
`g`, `fee = min(floor(g * bps / 10000), cap)`. There is no minimum fee.
Deposits use their submitted gross collateral; switches and redemptions use
floor-rounded source proceeds at the accepted batch's fixed valuation.
Deposits and switches mint from `gross - fee`; redemptions credit that net
amount. Minimum outputs apply after fees. A rejected, expired or cancelled
request pays zero. Refund and withdrawal instructions charge no fee.

Each request stores the configuration version, rate and cap at submission.
The fee-aware trade ABI includes an expected version and refuses a mismatch
before token transfer or reservation. Legacy trade instructions are available
only while the active version is zero. Legacy queued requests retain zero fees
regardless of later configuration changes. Quote simulations return sequence,
minted units, net proceeds, gross collateral value, fee and fee version; they
estimate current values rather than promising the execution result.

Admin schedules one pending configuration with a monotonically increasing
version. The first schedule may target any future minute-aligned cutoff.
Every subsequent schedule, including replacements after cancellation, requires
at least 86,400 seconds' notice. Activation occurs only when a publication
whose accepted cutoff reaches that time finalizes. Requests submitted during
processing keep the previously committed configuration. Cancellation cannot
remove a configuration whose activation publication is already accepted.
Rate, cap, activation and cancellation events are public.

Fees are staged with execution and committed only at finalization. The vault
identity becomes `active + pending + payable + residual + committed fees`.
Fees never participate in reference revaluation or unit backing, and rounding
residual remains non-distributable. Safety rejection clears provisional fees.
Only admin can withdraw committed fees, to an account of the pool's collateral
mint owned by that admin. The publisher cannot administer or withdraw fees.
Committed treasury withdrawals may occur during another batch's processing;
its staged fees remain unavailable. Vault shortfalls fail closed.

`migrate_pool` requires a paused registry and no accepted unfinished batch.
It verifies the legacy pool discriminator, owner, PDA, registry, vault and
collateral mint, decodes the legacy prefix independently of trailing padding,
then writes schema 2 with all fee fields zero. No positions or queued requests
are reset. Existing 4 KB pool, 320-byte request and 8 KB batch/publication
allocations are retained. Pool schema 1 is legacy; new initialized pools remain
legacy until explicitly migrated. Migrated requests use schema 2; their fee
fields append to the legacy layout. Migrated batches/publications use schema 3.
Old requests and historical publication schema 2 remain readable.

The V2 receipt root starts at SHA-256(Borsh string `COX/RECEIPTS/V2`). Each
ordered receipt extends the V1 receipt bytes with gross (`u64`), charged fee
(`u64`), fee version (`u64`), rate (`u16`) and cap (`u64`). V1 receipt status
numbers are unchanged. State domain becomes `COX/STATE/V2`; the V1 payload
layout is followed by committed fees, batch fees, active version, active rate,
active cap, next version, pending flag, pending version, pending rate, pending
cap, pending cutoff, initial-scheduled flag and fee-policy digest. Amounts,
versions and cutoffs are `u64`, rates `u16`, flags Borsh `bool`. V1 histories
keep their original domains and bytes. V2 links the actual previous digest,
including a V1 predecessor at migration. The client publishes both encoding
versions and shared vectors in `fixtures/fee-state-vectors.json`.
