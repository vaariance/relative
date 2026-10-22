# Relative

**Trade on performance.**

Back the coin you believe will outperform the market. Relative is a trading
application built by Variance Labs Ltd that measures supported crypto assets
against a shared benchmark and lets users express their views through
collateral-backed positions on Solana.

[Try Relative](https://getrelative.trade/markets) ·
[How the mechanism works](packages/cox/SPEC.md) ·
[Read the research](#research)

**Current release: Solana devnet.** The pilot covers 30 crypto assets and uses
Circle's devnet USDC, which has no real monetary value. This is an experimental
trading mechanism, not a mainnet or real-money release.

## Why Relative exists

A green candle answers whether a coin gained in dollars. It does not tell you
whether choosing that coin was better than holding exposure to the wider market.
If a coin gains 5% while the benchmark gains 9%, its price has risen, but it has
lost ground. A coin can also fall in price while outperforming a falling market.

Relative is for traders whose view is comparative: **"I think this asset will
perform better than the crypto market from here."** It puts that comparison at
the centre of the market, with a common benchmark, visible performance references
and a continuous entry-and-exit process.

Relative trading already exists through price pairs, portfolios and derivatives.
Our proposition is to bring a shared benchmark, asset selection and funded
positions into one experience. Users do not have to construct and manage a
separate long/short portfolio to participate in this mechanism. The resulting
payoff is specific to Relative's pool; it is not identical to a hedged pair trade.

## The benchmark: what CRYPTO measures

CRYPTO is a **price-performance index of the pilot's 30 admitted assets**. It is
not a claim to represent every cryptocurrency, the sum of their dollar prices,
or total crypto market capitalisation.

At each successful publication, the engine measures each asset's price growth
since the previous accepted publication, takes the equal-weight average of those
growth factors, and applies it to the previous benchmark level. Every admitted
asset contributes equally to that interval's calculation. Market cap, trading
volume and users' allocations do not determine the benchmark weights.

The index starts at 100. Each asset also has a **relative reference** starting at
100: its price growth since the common origin divided by CRYPTO's growth over
the same period. Above 100 means it has outperformed since that origin; below
100 means it has underperformed. A shorter-period change answers a different
question and must use matching start and end times.

For any matching interval, the idealised comparison is:

```text
relative change = (1 + asset return) / (1 + CRYPTO return) - 1
```

| Asset price change | CRYPTO change | Relative change | What happened |
| --- | --- | --- | --- |
| +5% | +9% | −3.67% | The coin rose, but fell behind the benchmark. |
| −5% | −10% | +5.56% | The coin fell, but held up better than the benchmark. |
| +9% | +9% | 0% | The coin matched the benchmark. |

These are illustrative **reference changes, not promised trading returns**.
The calculation uses ratios rather than percentage-point subtraction. The
implementation uses exact fixed-point operations with declared rounding at each
step; the [specification](packages/cox/SPEC.md#4-reference-engine) defines that order.

The publication target is once per minute. Missing or inadmissible snapshots do
not become invented prices: the next accepted publication measures from the
previous accepted one under the benchmark's rebalance-freeze rule. Membership
is fixed for the current pool; continuous asset admission is future work.

## What you own, and where gains come from

A Relative position is a claim on backing assigned to a class inside the pool.
Selecting BTC does not buy wallet-held bitcoin. The current app uses the CRYPTO
claim class as the entry point before switching into an asset-performance class.

**The benchmark level, the asset's relative reference and your redeemable
position value are three different quantities.** The CRYPTO claim itself can
change in USDC value; it is not a stablecoin or an ETF holding the benchmark's coins.

The current transfer mechanism, `COX/TRANSFER/MVP-0`, adjusts each funded class's
backing using its relative growth factor, then normalises the allocations to
the existing active collateral. CRYPTO's transfer factor is one. Revaluation
does not create money: increases in one allocation are funded by decreases in
others, with rounding dust accounted for separately.

For example, suppose an asset class and CRYPTO each have 100 USDC of backing.
If the asset's relative growth factor is 1.10 and CRYPTO's is 1, the same 200 USDC
is divided in the ratio 110:100. Ignoring fees and integer rounding, their new
backing is about 104.76 and 95.24 USDC. The asset's reference grew 10%; its backing
grew about 4.76%. This illustrates why reference performance and payout differ.

Actual outcomes depend on the funded allocations, entry and exit valuations,
fees and rounding. With only one funded class, there is no other allocation to
fund a performance gain. There is no borrowing or leverage, but positions can
lose value. Correct collateral accounting does not eliminate price-source,
smart-contract, operational or collateral risks.

The program reconciles the vault against:

```text
vault = active backing + pending deposits + payable collateral
        + non-distributable residual + committed trading fees
```

Pending deposits, completed redemption payables and fees do not participate in
performance redistribution. A collateral shortfall stops processing. See the
[transfer and accounting rules](packages/cox/SPEC.md#5-transfer-engine-coxtransfermvp-0).

## The trading journey

```text
devnet USDC → CRYPTO position → asset-performance position
            ←                 ←

redeem CRYPTO → available USDC → withdraw to your wallet
```

1. Connect a Solana-compatible wallet and obtain devnet SOL and USDC through
   the app's [Faucet page](https://getrelative.trade/faucet).
2. Use Swap to deposit test USDC into the CRYPTO class.
3. Buy an asset-performance position by switching from CRYPTO. Sell to switch back.
4. Redeem CRYPTO, wait for the request to complete, then withdraw the available USDC.

**Transaction confirmation is not trade completion.** Submission reserves funds
or units. A request becomes eligible at a future publication, never against the
reference at which it was created. Quotes are estimates; user minimum-output
conditions are checked after fees.

Acceptance fixes a batch's execution values. Processing can span transactions
and continue beyond a minute; it does not reprice or cancel the accepted work
because it is slow. Finalization makes the completed positions and payables
spendable together. Another publication cannot begin while the batch remains
unfinished. Cancellation, expiry and refunds follow the request-state rules.

This provides continuous request submission without a fixed market maturity,
not guaranteed instant execution or withdrawal during failures. Future-publication
execution alone is not a claim of immunity to front-running or manipulation.

## Fees and revenue

The implemented devnet fee policy starts at **2 basis points (0.02%) per successful
deposit, switch or redemption, capped at 2 USDC per request**. A 100 USDC trade
incurs 0.02 USDC before any other effects; a 20,000 USDC trade reaches the 2 USDC
cap. These are test-token fees on devnet, not real-dollar revenue.

Fees are deducted before minting destination units or crediting redemption
proceeds. Rejected, cancelled, expired and refunded requests pay no trading fee;
withdrawing completed proceeds adds none. Solana network costs are separate.

Each request locks its fee configuration at submission. Subsequent configuration
changes require at least 24 hours' notice and activate through publication
finalization. Committed fees are accounted for separately from users' backing.
The [fee-policy extension](packages/cox/SPEC.md#configurable-trading-fees--coxfeesv1)
defines the limits, administration and versioned accounting.

## Verification and trust

The native publisher validates signed Pyth observations and computes the benchmark
and asset references in Rust. Its adaptive on-chain publications commit the
operator-controlled benchmark and settle eligible work. Archived inputs,
methodology identities, publication commitments and receipts make calculations
inspectable; they do not eliminate operator trust.

The old exchange candle archiver, exchange clients and archive monitor are
retired. Historical evidence remains available through the evidence API and
append-only database. Recorded exchange samples are retained as historical
fixtures in `packages/cox/fixtures/legacy-exchange`; they are not live inputs.

Users sign their own trading requests. Runtime publishing uses a restricted,
non-exportable KMS key. Administrative and upgrade powers remain separate and
still exist in the devnet deployment; this is not an operator-free system.

The repository includes arithmetic vectors, simulations and compiled Solana
tests with SPL token transfers. These support reproducibility and implementation
checking, not a claim of independent security certification. Current deployment
identities and recorded builds are in the [deployment guide](packages/cox/deploy/README.md).
Deployment records are not live service-health reports.

## Research

Relative is the product. **COX (Crypto Outlook Index)** is the crypto-specific
engine developed from our **Relative Performance Markets (RPM)** research.

| Read | What it explains |
| --- | --- |
| [Relative Performance Markets — Paper 1](output/pdf/relative_performance_markets_paper_1.pdf) | The general framework: comparative outcomes, benchmark-relative claims, connections to existing market designs and unresolved financial-design questions. |
| [COX — Paper 3](output/pdf/cox_paper_3.pdf) | The crypto application: price versus performance, benchmark construction, continuous participation and the distinction between references and closed-pool payouts. Start with sections 1–6. |
| [Implementation specification](packages/cox/SPEC.md) | The selected devnet rules, ordered integer arithmetic, custody, execution, rolling history and the later fee-policy extension. |

The papers are research manuscripts, not independent audits or proof of product
demand. Paper 3 predates implementation and leaves choices open that the code and
specification subsequently resolve. In particular, its original fee assumptions
must be read with the explicit `COX/FEES/V1` extension. RPM describes the research
framework; it is not a claim of a new legal exemption or of inventing relative trading.

Earlier EOX research applied comparative measurement to economies. Relative's
current product focuses on crypto prices. Some package names retain `@eox/` for
compatibility; the legacy implementation is preserved in the `eox-archive` Git tag.

## What comes next

The next work is to make onboarding and trading simpler, complete monitoring,
strengthen price-source verification, support controlled asset additions and
enable agent integrations. These are development directions, not features
promised by the current release. The current pool remains a fixed 30-asset pilot.
Independent security and economic review, operational validation and applicable
legal review remain necessary before a real-money release.

## Repository map

| Component | Purpose |
| --- | --- |
| [COX program and math](packages/cox/README.md) | Rust calculation engine, Anchor program, fixtures and custody tests |
| [Methodology](packages/cox-methodology/README.md) | Rust inclusion lifecycle, geometric benchmark and Epoch research simulation |
| [Solana client](packages/cox-client/README.md) | Account readers, unsigned instruction builders and simulations |
| `packages/evidence-store` | Append-only PostgreSQL evidence and price storage |
| [Evidence API](apps/evidence-api/README.md) | Archived snapshots and source artifacts |
| [App API](apps/app-api/README.md) | Fixture/live data, portfolios and wallet transaction preparation |
| [App API client](packages/app-api/README.md) | Versioned API types and HTTP client |
| [Publisher](apps/cox-publisher/README.md) | Snapshot publication and persistent batch execution |
| [Signer](apps/signer/README.md) | Restricted runtime signing through Cloud KMS |
| [Signing client](packages/signing/README.md) | Typed signing requests and public-key discovery |
| [Web app](apps/web/README.md) | Market views and wallet interaction |
| [Dev infrastructure](deploy/dev/README.md) | VM services, logs, database and backups |

Use the names in package manifests, including retained `@eox/` names, when
running workspace commands.

## Local setup

Use Node.js 24 or newer, pnpm and Docker with Compose. Rust and Solana build tools
are required only for the program and calculation-engine workflows; their pinned
versions are documented in the [deployment guide](packages/cox/deploy/README.md).
Run these commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:migrate
```

The local database defaults to `postgres://eox:eox@localhost:5433/eox`. Set
`DATABASE_URL` in the service environment to use a different database. The
Compose credentials are for local development and must be replaced on a shared
host. Copying an `.env` file does not automatically export it to every Node process.

Start the fixture API and web app in separate terminals:

```sh
APP_API_SOURCE=cox-fixture APP_API_CORS_ORIGIN=http://localhost:3100 pnpm --filter @eox/app-api-server start
COX_API_URL=http://127.0.0.1:8790 pnpm --filter @eox/web dev
```

Open `http://localhost:3100`. Fixture data is synthetic and cannot execute trades.
Each service README explains its configuration and dependencies. The publisher
ships disabled; starting local demos does not activate it or create on-chain
accounts.

## Checks

```sh
pnpm -r build
pnpm -r test
pnpm cox:check
pnpm cox:test
```

Database-backed tests require PostgreSQL and migrations; program/client checks
may require generated artifacts and a compiled Solana binary. Follow the
[compiled-program test instructions](packages/cox/crates/program-tests/README.md)
for real SPL token custody tests rather than relying only on host-side math.

## Deployment and security

[Program deployment](packages/cox/deploy/README.md), service installation and pool
activation are separate operations. Verify the chain, program build, methodology,
collateral mint and signing authorities before enabling publishing. Local keys
for administration and upgrades remain separate from the non-exportable runtime
key. Users sign trades with their own wallets.

Keep database passwords, RPC access tokens and provider keys out of source control
and logs. Consult each component's documented limitations before operating it;
fixture APIs, archive-only monitor verdicts and local simulation results are not
proof of production readiness.
