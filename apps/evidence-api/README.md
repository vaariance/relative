# COX evidence API

Read-only historical HTTP access to archived exchange cutoff prices and their exact source artifacts. The retired exchange publisher and monitor used this service; the native Pyth publisher reads its own signed-feed archive. Existing consumers can read historical evidence without connecting directly to PostgreSQL. This API does not calculate references or fetch exchange prices on demand.

## Run

Install workspace dependencies and apply the [evidence-store migrations](../../packages/evidence-store), then supply a database connection:

```sh
DATABASE_URL=postgres://localhost/cox \
pnpm --filter @eox/evidence-api start
```

`EVIDENCE_API_HOST` defaults to `127.0.0.1`; `EVIDENCE_API_PORT` defaults to `8787`. The service has no built-in authentication. Keep it on a private interface or place it behind an appropriately controlled gateway.

## Routes

| Route | Result |
|---|---|
| `GET /health` | `{ "status": "ok" }`; process health only |
| `GET /v1/prices/cutoffs/:cutoff` | Completed archived snapshot, chosen prices, fallback attempts and incidents |
| `GET /v1/prices/changes?after=&limit=` | Commit-safe snapshot change feed |
| `GET /v1/artifacts/:sha256` | Original source bytes, verified against their SHA-256 digest |

Only GET is accepted. Invalid parameters return HTTP 400, missing artifacts or snapshots return 404, unsupported methods return 405, and storage failures return 500. JSON errors use `{ error: string }`.

### Cutoff snapshots

A cutoff is positive Unix seconds on a minute boundary. The response includes the snapshot's `digest`, `digestEncoding`, `admissible` and `recordedAtMs`, followed by each asset's attempts and selected price in canonical roster order. A cutoff returns 404 until its snapshot row exists, preventing partially archived cutoffs from being served.

Each attempt identifies the fallback step, venue, outcome and artifact digest. Selected prices retain the venue's close text, candle start, trade evidence and age, USD price at scale 10⁸, admissibility and rejection reason. Bybit prices also retain the USDT/USD conversion and its artifact digest. Incidents distinguish collection failures from valid observations.

Admissible snapshots labelled `COX/WIRE/V1` use the canonical commitment defined in the [COX specification](../../packages/cox/SPEC.md). Inadmissible snapshots have no canonical digest. Older snapshots with an unlabelled provisional encoding must not be compared as `COX/WIRE/V1`.

### Changes and artifacts

The change feed returns `{ schema, after, cutoffs }`. Treat `after` as an opaque cursor and pass it back unchanged. The default page size is 128, with a maximum of 500. Empty pages retain the cursor. Only snapshots older than every running database transaction are emitted, so a transaction that commits late is not skipped.

Artifact responses use `application/octet-stream`, `x-content-sha256` and `x-source-content-type`. Content-addressed bytes are immutable and cacheable for one year. Kraken WebSocket artifacts contain the ordered raw frames for a candle, separated by newlines. The API recalculates SHA-256 before serving an artifact and refuses corrupted content.

## Verification

```sh
pnpm --filter @eox/evidence-api build
pnpm --filter @eox/evidence-api test
```

The exchange archiver and monitor are retired. Existing snapshot, source-artifact and append-only database records remain available as historical evidence. Native Pyth publication does not append new exchange candles to this API. See the [deployment guide](../../deploy/dev/README.md) for service operations and retirement safeguards.
