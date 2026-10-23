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

The Swap page deposits USDC into the CRYPTO class and redeems CRYPTO back to
USDC (`product.md` version 14), using the app API's `buildDeposit` and
`buildRedeem`. Asset pages have two actions. Buy pays with USDC by default,
as one deposit straight into that asset's class (`buildDeposit`), or with
$CRYPTO as a switch (`buildSwitch`); the user picks under the amount. Sell is
a switch back to CRYPTO (`buildSwitch`). Cash out, on asset pages and on each Portfolio row, redeems
straight from a class to USDC (`buildRedeem`), so leaving does not need a
sale and a swap. The CRYPTO page has no form; it links to Swap. The app does
not use `@cox/client/swap`, whose `CRYPTO_CLASS` is 0 while the program and
`packages/cox/SPEC.md` §3 put CRYPTO last.

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

The only collateral the app offers is USDC (Circle's devnet USDC, the pool's
primary mint). Buys, refunds and withdrawals never send `collateralMint`, so
the API uses the primary mint; a pool's `secondaryCollateralMint` is ignored.

### Live estimates

Prices, references, the $CRYPTO level, projected class unit values and wallet value come from the per-second previews: the first one is loaded on the server, then `preview` events on the stream replace it, and the wallet estimate is read from `/v1/preview/portfolio` every 5 seconds while it is fresh. One line under the top bar (`EstimateBar`) says "Live estimate", or "Estimate paused" after 10 seconds without a newer record or when the API marks it stale, and gives the time of the last on-chain settlement. Without a preview the figures fall back to the last settled publication values and the line says so; stale figures are dimmed. A projected unit value is used only when its basis is the latest publication. The browser also keeps every preview it receives, up to 4 hours (`appendHistory`). Market line charts (asset and $CRYPTO charts, the Markets trend column and the card sparklines) draw from it one point a minute (`perMinute`), adding a point only when a minute completes, so they move once a minute while the figures update every second. Each chart range uses the live history when it covers more of the range than settled publications do, and shows settled publications as dots; otherwise it draws settled values. On the position page, unit value and worth use the projected unit value every second, with 1s, 5s and 15s intervals, when its basis is the latest publication; reference and price there follow the one-minute rule. The history starts when the page opens and is lost on reload, so longer ranges usually show settled values until the API serves preview history.

Units are shown at 10^(12 + collateral decimals) quanta per displayed unit, so
with USDC one displayed unit is 10^18 quanta. An empty class mints one unit of
10^12 quanta per collateral base unit, so 10 USDC reads as 10 CRYPTO and a
fresh class has a unit value of 1. Requests are still sent in exact quanta.

## Faucet page

The Faucet page links to Solana's devnet SOL faucet and Circle's devnet USDC
faucet, shows the connected wallet's address to paste there, and reads its
devnet SOL and USDC balances (`COX_RPC_URL`, default public devnet).

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
