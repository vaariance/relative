# COX web app

A Next.js interface for exploring the CRYPTO benchmark, asset performance, portfolios and trading requests on Solana devnet. It reads the versioned COX app API and uses the connected wallet to authorize live trading requests.

The default API serves synthetic fixture data. Fixture pages are labelled and trading controls are disabled. Live mode uses the configured deployment's test collateral; it does not imply mainnet availability or real USDC support.

## Get started

Install workspace dependencies from the repository root, then run:

```sh
pnpm --filter @eox/web dev
```

Open <http://localhost:3100> for the landing page, or <http://localhost:3100/markets> for the app. The default fixture API is hosted remotely, so a local API is optional. If the configured API is unavailable, the app displays an error and retry control rather than substituting built-in prices.

## Configuration

| Variable | Purpose |
| --- | --- |
| `COX_API_URL` | Required. Server-side base URL for a `cox.app-api/v1` API; the app does not start without it. It is also sent to the browser for the real-time stream, so it must be publicly reachable. The live devnet API is `https://api.getrelative.trade`. Copy `.env.example` to `.env.local` for local work. The fixture API is `https://fixture-api.getrelative.trade`. For a local fixture API, use `http://127.0.0.1:8790`. |
| `COX_DEMO_WALLET` | Portfolio wallet used with fixture data. Defaults to the first fixture wallet; ignored in live mode. |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | Browser wallet-adapter RPC. Defaults to public Solana devnet. This value is exposed to browsers; use only an endpoint intended for public client access. |
| `NEXT_PUBLIC_PRIVY_APP_ID` | Privy app ID. When set, Log in opens Privy with Google and Solana wallets, Google users get a Privy Solana wallet, and Privy wallets sign without a confirmation window. Unset, the app connects browser wallets through wallet-adapter. The ID is public by design; never put the Privy app secret in a `NEXT_PUBLIC_` variable. The Privy app must allow Google and Solana wallet login and the site's origin. |
| `EPOCHS_ENABLED` | Epochs is always on when the app runs locally with `pnpm dev`. In a deployed build it shows a "Coming soon" card unless this is set to `true`. Not set on Vercel production. |

### Secrets

| Secret | Purpose |
| --- | --- |
| `COINGECKO_API_KEY` | CoinGecko Demo API key, sent as `x-cg-demo-api-key` when coin logos are looked up once a day. Optional: without it the lookup uses CoinGecko's keyless access, which has a lower shared limit. |

Treat this as a secret, not as configuration. Store it as a Sensitive environment variable on the host and in the untracked `.env.local` for local work. Never commit it, never log it, and never give it a `NEXT_PUBLIC_` name. It is read only in `src/lib/data.ts`, which is marked server-only so it cannot be bundled for browsers.

The browser RPC and API deployment must target the same network. Private infrastructure credentials must not be supplied through `NEXT_PUBLIC_*` variables.

## Data and trading

The app reads through `createCoxApiClient` from [`@eox/app-api`](../../packages/app-api/README.md). Protocol reference values come from the API. Displayed estimates of redeemable collateral multiply holder units by the latest published class state and are labelled approximate.

In live mode, Buy, Switch, Redeem, Cancel, Refund and Withdraw forms use this flow:

1. Convert form values to exact collateral base units and position units at scale 10¹², with an inclusive expiry batch.
2. Request an unsigned transaction from the app API through a server action.
3. Check that the connected wallet is the fee payer and only signer, then ask the wallet to sign.
4. Return signed bytes to the API for broadcast and request-status tracking.

Portfolio, positions and requests belong to the connected wallet and refresh every 15 seconds. Before the first publication, pages retain their layout and show a dash for unavailable values. Trade submission does not imply immediate execution: eligible requests are processed through subsequent accepted publication batches under the protocol's reservation and expiry rules.

The UI supports the request flow, but this README does not establish a completed live wallet-to-fill acceptance test. See the [protocol documentation](../../packages/cox/README.md) for execution and custody rules.

## Build and test

```sh
pnpm --filter @eox/web test
pnpm --filter @eox/web build
pnpm --filter @eox/web start
```

Development and production builds use webpack. [`next.config.ts`](next.config.ts) maps `.js` import specifiers to workspace TypeScript sources through `resolve.extensionAlias`; use the package scripts to preserve that configuration.

## Swap, buy and sell

Trades use direct entry (`product.md` version 15): USDC goes straight into the
chosen class and comes straight back out, as one request with one fee, so
$CRYPTO is the benchmark and one holdable class, not the way in or out.

- **Swap page:** USDC to any class and any class to USDC, with the class picked
  from a list of the 30 assets and $CRYPTO (`buildDeposit`, `buildRedeem`). The
  $CRYPTO page and the $CRYPTO position page show the same card fixed to
  $CRYPTO.
- **Asset pages:** Buy pays with USDC by default (`buildDeposit`) or with
  $CRYPTO as a switch (`buildSwitch`). Sell receives USDC by default
  (`buildRedeem`) or $CRYPTO as a switch (`buildSwitch`). The user picks under
  the amount.
- **Cash out:** on every Portfolio row and position page, redeems all free
  units of that class to USDC (`buildRedeem`).

The app API builds every transaction; the app does not import
`@cox/client/swap`, although these are the same requests as its
`prepareDeposit` and `prepareRedeem`.

### Trading gate, expiry and collateral

`status.trading` decides whether trades can be sent. While it is closed
(`paused`, `before-opening`, `not-initialized` or `retired`), Buy, Sell, Swap
and Cash out show the reason or the opening time instead of sending, no quotes
are requested, and the status banner explains it. Withdrawals, cancellations
and refunds stay available. The API's `TRADING_CLOSED` error has its own
message in `src/lib/errors.ts`.

Every trade stays valid for about three minutes (`VALID_SECONDS` in
`src/lib/market.ts`), converted to batches with
`deployment.publicationIntervalSeconds`: 3 batches on a minute pool, 180 on a
one-second pool such as pool 2.

When the pool has `deployment.secondaryCollateralMint`, buying with collateral
(coin pages and Swap) and withdrawing offer both mints: USDC (Circle's devnet
USDC) and rlUSD (Relative's test dollar from the faucet). The choice is sent as
`collateralMint`. Selling always receives the primary mint into the payable
balance; payables are one balance across both mints, and a withdrawal needs
liquidity in the chosen mint's vault. Refunds use the primary mint.

### Live estimates

Prices, references, the $CRYPTO level, projected class unit values and wallet value come from the per-second previews: the first one is loaded on the server, then `preview` events on the stream replace it, and the wallet estimate is read from `/v1/preview/portfolio` every 5 seconds while it is fresh. One line under the top bar (`EstimateBar`) says "Live estimate", or "Estimate paused" after 10 seconds without a newer record or when the API marks it stale, and gives the time of the last on-chain settlement. Without a preview the figures fall back to the last settled publication values and the line says so; stale figures are dimmed. A projected unit value is used only when its basis is the latest publication. The browser keeps up to 4 hours of previews (`appendHistory`). On load it fetches the last 4 hours of `/v1/preview/history` at one-minute steps and puts them before the live previews (`joinHistory`); the 1D range fetches 5-minute steps and 1W/1M hourly steps over at most 7 days, once per range. Market charts work like an exchange chart (`withLiveMinute`): finished minutes are one fixed point each, and the minute in progress follows every new preview, so the end of the line and the last candle move every second and always match the figure on the card. Card and Markets sparklines draw finished minutes plus the latest value. A chart range uses estimates when they cover at least as much time as the settled publications or hold more points (`preferEstimates`), and shows settled publications as dots. On the position page, unit value and worth use the projected unit value every second, with 1s, 5s and 15s intervals, when its basis is the latest publication. History steps that the API left out stay gaps.

Units are shown at 10^(12 + collateral decimals) quanta per displayed unit, so
with USDC one displayed unit is 10^18 quanta. An empty class mints one unit of
10^12 quanta per collateral base unit, so 10 USDC reads as 10 CRYPTO and a
fresh class has a unit value of 1. Requests are still sent in exact quanta.

## Faucet page

The Faucet page follows the layout of Circle's faucet: pick a token (rlUSD,
USDC or SOL), see the network (Solana Devnet) and the connected wallet's
address, then press one button.

- **rlUSD** is claimed through the app API's devnet faucet (`apps/app-api/README.md`, Devnet faucet), straight from the browser so the API's per-visitor limits see each visitor: `POST /v1/faucet/challenge`, the wallet signs the returned message with `signMessage` (no transaction), then `POST /v1/faucet/claim` with the base64 signature. A claim gives 100 rlUSD, plus 0.01 devnet SOL when the wallet is low, so it needs no SOL first. `GET /v1/faucet/status` is read on load, on tab focus and once after each claim (never on a timer) and drives the button: closed, next claim countdown, confirming, or claim. Faucet errors have their own wording in `src/lib/errors.ts`.
- **USDC and SOL** open Circle's and Solana's faucets with the address copied. The Circle button stays locked until the wallet holds at least 0.01 devnet SOL (`MIN_GAS_SOL`).

The web app holds no faucet key and mints nothing.

## Epochs page

The page is on in local development (`pnpm dev`) and shows "Coming soon" on deployed sites unless `EPOCHS_ENABLED` is `true` (see Configuration).

`/epochs` is the four-hour game run by the separate Epoch program
(`packages/cox-epoch`), read through the app API's `/v1/epochs` routes. A user
backs one coin in a basket of 30 and stakes USDC or rlUSD while a round is
open. The entry counts from its own execution to the fixed close. Its score is
the backed coin's rise against $CRYPTO as a share of all the basket's rises
(coins that did worse than $CRYPTO count as zero). The pot is every executed
entry's net stake, shared by score times net stake. If every entry scores
zero, every stake is refunded in full, fee included.

The layout follows Peter's Epoch design brief (2026-10-23):

- **Top:** a Basic / Epoch switch (Basic goes to Markets) and a clock card with
  the date, exact UTC window, status, countdown and local closing time. Arrows
  browse the previous and next Epochs. At zero the status reads Closing, not
  Settled. Past the 24-hour closing window with no closing reference it reads
  Not closed, and a draft that missed its opening reads Not opened.
- **Relative moves since Epoch start:** every asset ranked by its move against
  $CRYPTO, starting from the live estimate at the Epoch's opening (an Epoch has
  no on-chain opening reference). The end is labelled "Live estimate · as of
  …" or "Estimate paused" while open, and "Closing reference" once final. It
  ranks assets, not entries or payouts; there are no odds or live payout
  estimates. During an open Epoch a row can be picked as the backed asset.
- **Create entry:** the backed asset, the basket ("30 coins · 1 backed + 29
  comparison"), the stake with the wallet balance of the chosen collateral
  (USDC or rlUSD, sent as `collateralMint`), the fee with its cap, the net
  stake and when the fee is refunded, then Review entry. The review notes that
  an entry cannot be cancelled and that an unexecuted entry is refunded in
  full. Entries use the API's `entriesOpen` gate. When no round is open, the
  panel says whether another Epoch is open or scheduled; below 1280px it shows
  under the top cards.
- **Pot and timeline:** Net stake pot (active net stake; the settlement pot
  once allocating), queued unexecuted stake and entries, and the timeline Open
  → Closing reference → Scoring → Allocating payouts → Withdrawable, with the
  API's scored and allocated counts.
- **How payouts work:** a carousel with the four steps and Peter's worked
  example.
- **My entries:** one row per entry with All / Pending / Active /
  Withdrawable / History filters. Each shows gross and net stake, its execution
  time, score, payout and gain or loss (payout minus gross stake), and the
  basket. The program keeps a score only while an entry is scored and drops the
  payout once it is withdrawn, so `finalScore` and `finalPayout` in
  `src/lib/epoch.ts` recompute both from on-chain values (execution and closing
  references, net stake, pot and total weight) with the contract's integer
  arithmetic. They reproduce the 23 Oct 08:00 payouts exactly
  (`test/fixtures/epoch-2026-10-23-0800.json`). Withdraw reads both Epoch vaults
  and takes the payout from one that holds it all, or part of it when neither
  does.

When the API sends an empty `universe` for a round, the page takes the coin
list from the closing references, or else from `/v1/assets`.

## Gain or loss

The Portfolio page and each "Your position" box show what a position cost,
what it is worth now and the difference, to six decimal places. The app API
has no deposited basis, so `src/lib/basis.ts` works the cost out from the
wallet's filled requests at average cost: a swap in costs its USDC amount, a
buy costs the value moved from CRYPTO (`receipt.proceeds`), and a sale or swap
out reduces the cost in proportion. No figure is shown when the filled
requests do not account for the units held.

## Order confirmation and position view

After a buy, sale, cash out or swap is sent, a snackbar at the top of the
page says the order was placed, what it was and which batch it fills in, with
links to the portfolio and the transaction. It closes after ten seconds.

Clicking a row on the Portfolio page opens `/portfolio/<class>`, laid out as a
trading screen: a header with the unit value and the position's gain or loss,
a strip with bought at, sold at, units, paid and worth, a chart beside the
Buy, Sell and Cash out form, and a table of the wallet's filled trades with
the price of each. The chart (`src/components/trade-chart.tsx`, also used on
the asset and CRYPTO pages) has a crosshair with price and time tags, a tag
for the latest value, a dashed "Bought at" line at the average entry price and
B and S markers where trades filled. Bought-at and sold-at prices come from
filled requests (`src/lib/trades.ts`): the USDC value moved divided by the
units. The Portfolio and position pages reload their publication data every 20
seconds.

## Candles, intervals and ranges

Every chart can be drawn as a line or as candlesticks, with bars of 1 minute
to 1 day and ranges of 1H, 4H, 1D, 1W and 1M. The source has one value per
publication, so a candle opens at the previous bar's close and its high and
low are the highest and lowest values in the bar (`src/lib/bars.ts`).

The server keeps the last 1,440 publications (24 hours) in memory and fetches
only newer ones on each request (`src/lib/data.ts`). The 1W and 1M ranges
therefore show at most 24 hours until the app API offers a compact history
route; the chart says how much history it is showing.
