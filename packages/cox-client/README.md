# COX Solana client

`@cox/client` provides typed account readers, PDA derivation, unsigned instruction builders, read simulations and canonical receipt/state encoders for the COX Solana program. It is a workspace package for Node.js 24 and Anchor 0.31.1.

The client does not sign or broadcast transactions, fetch market prices or recalculate the economic reference. Wallets authorize user transactions; the approved signing service authorizes runtime publication.

## Setup

Install workspace dependencies from the repository root, then validate the package:

```sh
pnpm install --frozen-lockfile
pnpm --filter @cox/client build
pnpm --filter @cox/client test
```

Create an Anchor `Program` with the [generated IDL](../cox/idl/cox.json) and the intended provider, then construct the client helpers:

```ts
import { CoxReader, CoxInstructions, CoxSimulations } from "@cox/client";

const reader = new CoxReader(program);
const instructions = new CoxInstructions(program);
const simulations = new CoxSimulations(program, feePayerPublicKey);
const pool = await reader.pool(0n);
```

Here `program` is the configured Anchor instance and `feePayerPublicKey` identifies an existing account used by unsigned simulations. No private key is needed for a read simulation. Verify the RPC network, program release and pool before preparing transactions; constructing these helpers alone does not pin the network.

The `@cox/client/swap` and `@cox/client/routed` entry points are tested with browser bundles. The SDK prepares transactions; the app API remains responsible for supplying unsigned transactions to the web app.

## Direct performance-position entry

`prepareDeposit` queues collateral directly into an existing asset class or the CRYPTO class. This is one deposit request and one pool trading fee on successful fill. It does not mint intermediate CRYPTO units or submit a switch. Existing `prepareBuy` and `prepareSell` methods retain their benchmark behavior.

```ts
const market = await swap.market();
const quote = await swap.quoteDeposit(owner, selectedClassId, amount);
const plan = await swap.prepareDeposit({
  owner,
  tokenAccount,
  classId: selectedClassId,
  amount,
  minimumUnits,
  expiryBatch,
  expectedFeeVersion: quote.feeTerms.version,
});
const unsigned = await swap.transaction(plan);
```

Construct `swap` with `CoxSwapSdk(program, { poolId, collateralMint })` from
`@cox/client/swap`; no DEX provider, API key or router is needed. Each pool
accepts its configured collateral mint only. This SDK does not add a second
collateral token to an existing pool.

Select `classId` from `market.classes`, whose `assetId` comes from the sealed methodology roster. CRYPTO has `benchmark: true` and `assetId: null`. Numeric class indices are local to the pool; never infer an input token mint from an asset ticker or class index.

`classBalances(owner, classId)`, `quoteRedeem` and `prepareRedeem` support the selected position. `request(owner, nonce, classId)`, `prepareCancel(owner, nonce, classId)`, `prepareExpire(owner, nonce, classId)` and `prepareRefund({ owner, tokenAccount, nonce, classId })` retain the same destination/owner boundary. Omitting `classId` on lifecycle helpers preserves the existing CRYPTO-only default. Withdrawal payables and refundable collateral are wallet-wide, not exclusive to a class.

```ts
const held = await swap.classBalances(owner, selectedClassId);
const redemption = await swap.quoteRedeem(owner, selectedClassId, held.availableUnits);
const sell = await swap.prepareRedeem({
  owner, tokenAccount, classId: selectedClassId, units: held.availableUnits,
  minimumProceeds, expiryBatch, expectedFeeVersion: redemption.feeTerms.version,
});
const unsignedSell = await swap.transaction(sell);
const receipt = await swap.request(owner, sell.request!.nonce, selectedClassId);
```

Callers submit the wallet-signed transaction through their own transport.
Read the request after submission until it is filled, failed or expired.
After a filled redemption, use `prepareWithdraw({ owner, tokenAccount,
amount })` and `transaction` to withdraw committed payables. For a rejected
deposit with `refundRequired`, prepare a refund with the same class and
nonce. Staged credits and locked units are not spendable; a pending request
is not a completed position. Do not quote or redeem a zero available balance.

## Capabilities and devnet availability

```ts
const capabilities = await swap.capabilities();
if (!capabilities.directEntry.available) {
  throw new Error(capabilities.directEntry.reason);
}
```

`SwapCapabilities` has `directEntry` and `express` fields. Each is either
`{ available: true }` or `{ available: false, reason }`. The capability reports
network/configuration support, not pool readiness, funds or route liquidity;
preparation still enforces initialization, pause, halt, balance and fee rules.
RPC failures propagate as errors rather than being disguised as unsupported
features. `CoxSwapSdk.capabilities()` reports Express as
`router-not-configured`, without needing any Express configuration.

Express is experimental and disabled by default. `CoxRoutedEntrySdk` accepts
an optional `routerProgramId`, an optional route provider and
`expressEnabled: true` only for an explicitly enabled, independently verified
integration. Its `capabilities()` reports `router-not-configured`,
`provider-not-configured`, `provider-network-mismatch`, `express-not-enabled`,
`router-not-executable` or `network-mismatch` as applicable. Preparation and
transaction construction throw `ExpressUnavailableError` with
`code: "SwapExpressUnavailable"` and a typed `reason` when unavailable,
before requesting a route or constructing a wallet transaction.

The current release has no router deployment or verified devnet route, so
Express remains unavailable. Setting an enable flag does not prove a route:
even after configuration and executable-account checks pass, route validation
and full transaction simulation remain mandatory. These checks are not a
router binary audit or authentication of a caller-configured deployment.

## Full-output routed entry

The intended journey is supported input token → DEX → collateral → full output queued into the selected performance class. The DEX and request submission share one wallet-signed transaction; the position fills at its next applicable valid publication. Missed publications, failed output conditions and expiry retain the existing rules.

`CoxRoutedEntrySdk` in `@cox/client/routed` targets the separate [COX router](../cox-router/README.md), which invokes Jupiter, measures the owner's actual collateral increase and invokes the existing fee-aware deposit. Every collateral base unit received by that swap is queued. Collateral held before the swap stays in the wallet. The minimum collateral bound controls rejection, not how much of a successful output is deposited.

```ts
import { CoxRoutedEntrySdk } from "@cox/client/routed";

const routed = new CoxRoutedEntrySdk(program, {
  poolId: 1n,
  collateralMint: market.collateralMint,
  routerProgramId,
  genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  expressEnabled: true,
}, devnetRouteProvider);
const capabilities = await routed.capabilities();
if (!capabilities.express.available) {
  throw new Error(capabilities.express.reason);
}
const entry = await routed.prepare({
  owner,
  inputMint,
  inputTokenAccount,
  inputAmount,
  classId: selectedClassId,
  minimumUnits,
  expiryBatch,
  expectedFeeVersion: market.feeTerms.version,
  slippageBps: 50,
});
const unsignedEntry = await routed.transaction(entry);
```

The router address is explicit because this change does not deploy a router. The provider must supply an executable supported Jupiter route on the same network. Only classic SPL source accounts are supported in this first version; native SOL must already be wrapped. Token-2022 and arbitrary setup/cleanup instructions are rejected. Safe owner ATA setup and address lookup tables are supported. The complete transaction is simulated before signing, including creation of a missing collateral ATA and a measured compute budget. Fee changes and global request-nonce races require a rebuild.

`JupiterRouteProvider` in `@cox/client/jupiter` fetches Swap v2 Build instructions with exact-input routing, no integrator fee, a specified collateral destination and on-chain verification of lookup-table contents. Run it on the server with an injected API key. It is explicitly mainnet-only. **The current COX SDK remains devnet-only, so the mainnet provider cannot be combined with the current pool.** A usable devnet route or a separately approved production release is required for live integration; no cross-network route is attempted.

The routed SDK tests use mocked RPC simulation. Native router tests and any compiled-runtime evidence are documented in its README. They do not establish live Jupiter execution. The app API currently rejects routed transactions and lookup tables; its explicit route build/submission integration is a separate handoff. The web app does not automatically gain this behavior by updating the package.

If the initial composed transaction fails, the swap and deposit are rolled back together, apart from ordinary network fees. If the queued deposit is rejected later, its refund is in collateral, not the original input token. A later refund requires another wallet transaction; the success path needs no further user signature to fill.

## Benchmark swaps

`CoxSwapSdk` prepares unsigned transactions for collateral → CRYPTO and CRYPTO → collateral. CRYPTO is the final class, after every asset class. In the 30-asset pool its index is **30**; index **0** is BTC. Read `market().cryptoClass` rather than hard-coding an index.

```ts
import { PublicKey } from "@solana/web3.js";
import { CoxSwapSdk } from "@cox/client/swap";

const swap = new CoxSwapSdk(program, {
  poolId: 1n,
  collateralMint: new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
});
const market = await swap.market();
```

This configuration selects pool 1 with Circle devnet USDC. The SDK validates the network, mint and sealed methodology. `prepareBuy` reserves collateral for benchmark units; `prepareSell` reserves benchmark units for redemption. Both execute through a future publication. After redemption finalizes, `prepareWithdraw` prepares the separate transfer of committed collateral to the wallet. Quotes are estimates, and the SDK never signs or broadcasts transactions. Existing CRYPTO holders can still switch into individual asset positions with the trading instructions; new collateral can enter an asset class directly with `prepareDeposit`.

## Integer values

| Value | Representation |
| --- | --- |
| Builder amounts, units and sequence inputs | `bigint` |
| Decoded account and simulation integers | Anchor `BN` |
| USD input prices | Integer at scale `10^8` |
| Reference values and position unit quanta | Integer at scale `10^12` |
| Test collateral | Base units of a six-decimal classic SPL mint |

Serialize large integers as decimal strings in API responses. A relative reference is different from the redeemable backing per position unit. Empty classes mint `10^12` unit quanta for each collateral base unit; do not assume that one collateral token buys one whole position unit.

## Account reads

`CoxReader` reads finalized registry, pool, methodology, position, request, batch and publication accounts. It checks account ownership, schema version, expected addresses, linkage and applicable hashes. Sealed methodology bytes must match their digest, and publication state must match its committed identity and prices.

`position` and `request` return the effective committed state even before a materialization transaction. Staged credits remain unavailable until the pool commits their sequence. Separate RPC reads can cross a publication; an inconsistent newer position fails with `InconsistentRead`. Retry the complete read rather than combining values from different observations.

Account validation does not authenticate price venues or replace independent publication verification. Use the IDL and matching client release together: account layouts and PDA seeds are versioned protocol details.

Each pool has one reusable batch account and one latest-publication account at fixed seeds. Legacy pools and requests use schema 1; migrated pools and new requests use schema 2. Legacy batches and publications use schema 2, and fee-aware batches and publications use schema 3. Readers accept both releases, treating legacy fee fields as zero. `reader.batch(poolId, batchId)` and `reader.publication(poolId, sequence)` check that the requested identity is still retained and fail with `CoxHistoryNotRetained` after it has been overwritten. Historical publications must come from the publisher's archive; there is no per-sequence on-chain history account.

## User transactions

`CoxInstructions` returns `TransactionInstruction` values with account order, signer flags and write flags taken from the IDL. It supports deposit, switch, redeem, cancel, expire, refund and withdraw, plus registry, methodology, pool, publication and processing instructions.

A typical user flow is:

1. Read the pool's current global request nonce and derive the position and request addresses with `addresses(program.programId)`.
2. For a migrated pool, build `depositWithFee`, `switchWithFee` or `redeemWithFee` with exact amounts, net minimum output, inclusive expiry batch and the observed `pool.feeVersion`. Legacy instructions work only while the active fee version is zero.
3. Assemble a transaction, have the wallet sign it and submit it through the application's transaction transport.
4. Track the request through a future publication and batch finalization.
5. Withdraw committed redemption payables or refund a rejected/cancelled deposit when appropriate.

Submission reserves collateral or units. It does not guarantee execution at the current quote. Competing submissions using the same global nonce race; a rejected submission must reload state and rebuild. After an ambiguous network timeout, reconcile the original transaction and request before submitting a new deposit.

Refund and withdrawal are distinct operations. Redemption creates a payable after finalization; it does not immediately transfer tokens to the wallet. Supply the owner's token account for the configured mint, rather than assuming devnet test collateral is genuine USDC.

Adaptive pools use methodology schema 2. Upload the canonical bytes produced by the Rust `prepare-methodology` command, then call `sealAdaptiveMethodology` with its exact config before `initializeAdaptivePool`. The sealed policy binds Pyth numeric feed IDs, origin prices, the universe digest, freshness bounds and the geometric calculation. Legacy methodology schema 1 remains readable and is restricted to legacy pool initialization. Publication is operator-attested; this policy commitment does not prove the supplied benchmark on chain.

New adaptive devnet pools may configure a second six-decimal classic SPL test mint. Create a `CoxSwapSdk` with either configured mint; both fund one ledger at 1:1 test-dollar value. Preparation validates combined custody and includes the canonical second vault. Withdrawals and refunds pay the selected mint and require sufficient liquidity in that vault. A combined reserve balance does not guarantee either mint is individually liquid. `prepareRefund({ owner, tokenAccount, nonce, classId, amount })` prepares a partial refund for schema-4 pools; `request(...).remainingRefund` reports the unreturned principal. Omitting `amount` requests the full remainder. Legacy pools retain their single-mint behaviour. These are tested SDK/contract capabilities, not an activated deployment.


## Read simulations

`CoxSimulations.reference`, `position` and `quote` execute unsigned versioned transactions with `sigVerify: false` at finalized commitment. Results are accepted only when return data comes from the configured program. Simulation makes no trade and reserves nothing.

`quote` estimates the current committed valuation for legacy or zero-version pools. For migrated pools, use `quoteWithFee` with the observed configuration version; it returns gross collateral value, fee, net redemption proceeds or net minted units, and the configuration version. A future publication fixes the actual execution values, which may differ. Minimum-output and expiry checks remain authoritative on chain.

## Trading fees

Fees are calculated in collateral base units: `min(gross × bps / 10_000, cap)`, rounded down. Either a zero rate or zero cap disables charging. The program limits configuration to 100 bps and 2,000,000 base units ($2 for six-decimal USDC). Fees apply once to successful deposits, switches and redemptions; cancellations, failed requests, refunds and withdrawals carry no trading fee. Network fees are separate.

`CoxSwapSdk.market()` exposes active fee terms and any scheduled change. Quotes include `gross`, `fee`, `netCollateral`, `estimatedOutput` and `feeTerms`; quote amounts remain estimates for a future publication. Pass `quote.feeTerms.version` as `expectedFeeVersion` to `prepareBuy` or `prepareSell` to preserve the reviewed configuration. Prepared transactions are rejected if their fee version changes before signing or on-chain submission. Submitted requests retain their original fee rate and cap.

Request reads expose locked `feeTerms`; `gross` and `fee` become visible when a successful receipt is committed. Staged receipts cannot be treated as completed trades. The vault's committed treasury balance is `pool.fees` and remains separate from user backing, pending deposits, payables and residual.

Admin builders provide `migratePool`, `scheduleFees`, `cancelFees` and `withdrawFees`. The first schedule activates at a future publication; subsequent schedules require at least 24 hours' notice. Activation occurs when a qualifying publication finalizes. Treasury withdrawals must use an admin-owned token account for the pool's collateral mint. These instructions require admin authorization and are outside publisher authority.

Fee-aware receipts and states use `COX/RECEIPTS/V2` and `COX/STATE/V2`. `receiptRoot([], 2)` selects the empty V2 root; nonempty V2 receipts carry `feeTerms`. `State.feeState` selects V2 state encoding. `decodeState` retains V1 compatibility and verifies the V2 fee-policy digest. The original sealed methodology bytes remain immutable.

## Batch processing

The program fixes accepted values, evaluates eligible requests, performs aggregate safety checks, prepares position changes and finalizes. Processing resumes from the persistent phase and cursor after a restart. Safety passes may repeat when a class becomes blocked; cancelled slots remain queue tombstones. Time passing never permits skipping a slot or repricing accepted work.

Only `publish` requires runtime authority; batch-processing instructions are permissionless. The approved service may also pay processing fees. Admin changes, upgrades and user trades require their own authorities.

## Release fixtures

Client tests require the generated IDL and [account fixture](../cox/fixtures/accounts.json). Missing release artifacts fail verification. Regenerate canonical receipt/state vectors with:

```sh
pnpm --filter @cox/client fixtures
```

Regenerate the IDL through Anchor's compiler-backed builder:

```sh
cargo run --locked --manifest-path packages/cox/scripts/idl-builder/Cargo.toml -- "$PWD/packages/cox"
```

To regenerate account fixtures, run the [compiled lifecycle tests](../cox/crates/program-tests/README.md) with `COX_ACCOUNT_FIXTURES_PATH` set to the absolute fixture output path. Source or ABI changes require regeneration and verification of matching artifacts.

### Dynamic-universe account reads

Schema-5 Basic pools preserve CRYPTO at class 30 and support at most 255 underlying assets. Use `CoxReader.position(poolId, owner)` or `CoxSwapSdk.classBalances(owner)` for complete balances, including existing positions that have not yet materialized newly added zero balances. These read and validate account data directly. `CoxSimulations.position` is limited to 31 classes by Solana's return-data size and rejects larger dynamic pools with account-reader guidance. Versioned reference and quote simulations request the required 256 KiB heap.

Universe approvals bind the predecessor, ordered instrument identities, future activation timestamp and expiry. Only the registry-authorized runtime may upload the corresponding exact-boundary capture; activation consumes its approval. A universe's recorded operator is its historical attestor. Admin-scheduled runtime rotation takes effect at the configured Basic publication batch and does not rewrite historical universe records; successor captures record the newly authorized operator.

Before financial evaluation begins, a paused administrator may use `cancelDynamicPreparation` to recover an invalid or incomplete dynamic preparation in phases 4–6. It changes no balances, requests, fees, nonces or committed publication state. The batch becomes phase-7 cancellation evidence and its `pool.stageBatch` remains a high-water mark: that timestamp cannot be reused, even with different prices. Only a later publication can resume the untouched queue. Cancellation is forbidden once financial evaluation begins and is never permitted through the runtime signing service.


### Devnet faucet transaction preparation

The existing custom devnet mint is named **rlUSD**, with six decimals. Its mint address, balances and pool backing are unchanged. It is a test token distinct from Circle's devnet USDC; neither has real-dollar redemption value.

`@cox/client/faucet` exports `devnetFaucetInstructions`, `devnetFaucetTokenAccount`, the fixed rlUSD test mint, `DEVNET_FAUCET_TOKEN_SYMBOL`, `DEVNET_FAUCET_TOKEN_DECIMALS` and grant limits. The pure builder creates no network calls and contains no signing credentials. It always includes idempotent recipient ATA creation, then a checked six-decimal token transfer; an optional SOL grant targets the same recipient. The default token amount is 100 rlUSD and the maximum optional SOL grant is 0.01 devnet SOL.

```ts
const instructions = devnetFaucetInstructions({
  faucet: faucetPublicKey,
  recipient: userWallet,
  solLamports: needsDevnetSol ? 10_000_000n : 0n,
});
```

Joel's authenticated API validates the ownership challenge, durable eligibility and budget before preparing this transaction, obtains a fresh blockhash, and requests the dedicated `devnet-faucet` signer with operation kind `devnet-faucet-claim` and expiry within 60 seconds. Persist the signed transaction identity before broadcast; never replace an ambiguous submission without reconciliation. Wallet users do not sign the grant transaction or receive faucet authority. The frontend calls the claim API, labels the collateral rlUSD, and refreshes balances after confirmation without adding wallet RPC polling. Public claims are not enabled by these builders.
