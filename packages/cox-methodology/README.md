# Relative methodology

The native implementation is the `relative-methodology` Rust crate in `rust/`. It exposes inclusion lifecycle rules and canonical commitments, immutable four-hour universe selection, exact-rational Epoch research simulation, and the shared `cox-math` geometric benchmark. The Rust publisher consumes this crate without invoking TypeScript.

```sh
pnpm --filter @cox/methodology build
pnpm --filter @cox/methodology test
```

Use Rust 1.90 or later for this standalone workspace. The inclusion capacity of 256 is separate from a personal basket's 30 members. The current publisher/contracts still bind a sealed Basic roster of at most 30; library support does not activate dynamic inclusion. Epoch simulation preserves the candidate score, 2-basis-point fee capped at 200,000 six-decimal units ($0.20), all-zero refunds and chart-only sensitivity. Exact research fractions are not a replacement for the contract's bounded arithmetic safeguards.

Legacy TypeScript exports and fixture tooling remain temporarily because Joel's app API fixture generator imports `src/index.ts` and `src/vectors.ts`. Joel has been asked to migrate that consumer to the Rust `cox-cli` JSON interface and update provenance. Do not delete those files before the handoff. Run their comparison suite using `pnpm --filter @cox/methodology test:legacy`.

## Legacy catalogue, manifest and fixture reference

The following describes the retained TypeScript compatibility implementation.


`@cox/methodology` defines the asset catalogue, canonical methodology manifest and price/snapshot encodings for COX. It also provides a TypeScript arithmetic specification used to generate cross-language test vectors.

The package runs on Node.js 24 using native TypeScript stripping. It makes no exchange requests, holds no private keys and transfers no collateral.

## Run

From the repository root:

```sh
pnpm --filter @cox/methodology test
node packages/cox-methodology/src/fixtures.ts
```

The second command regenerates fixtures. Tests compare against stored expected bytes without rewriting them. Fixture output paths are resolved relative to the source files.

## Manifest compiler

`compileManifest(config)` returns `canonical`, `digest`, `assetCount` and `label`. The canonical representation is a UTF-8 JSON tuple hashed with SHA-256. It commits the ordered asset roster, rational equal weights, venue identifiers, fallback and conversion policies, publication timing, runtime identity, test mechanism and arithmetic rules.

```ts
import { compileManifest, DEV_RUNTIME } from "@cox/methodology";

const manifest = compileManifest({
  version: "example-1",
  assets: ["BTC", "ETH"],
  originUnixSeconds: null,
  runtimeAuthority: DEV_RUNTIME,
  bybitEnabled: true,
  feedCheckDigest: null,
  status: "draft",
});
```

A draft may omit the origin and feed-report digest. A sealed manifest requires both. The origin must be a positive UTC minute boundary; assets must appear in canonical catalogue order. Changing any committed field produces a different digest. Sealing validates representation, not the truth of the feed report or a deployment's readiness.

## Prices and wire encoding

| Function | Purpose |
| --- | --- |
| `exactUsd(value)` | Admit a positive USD decimal exactly at scale `10^8`, bounded by `u64` |
| `bybitUsd(close, conversion)` | Multiply exact decimal inputs and round their USD conversion under the named policy |
| `priceBytes(price)` | Encode a validated price under `COX/PRICE/V1` |
| `snapshotBytes(cutoff, prices, roster)` | Encode the ordered price digests under `COX/SNAPSHOT/V1` |
| `sha256(bytes)` | Return a lowercase hexadecimal SHA-256 digest |

`exactUsd` rejects scientific notation, excess decimal places and zero. `priceBytes` checks venue/step combinations, candle alignment and permitted trade age. `snapshotBytes` checks canonical order, roster completeness and cutoff-relative candle times. These checks do not authenticate a venue or establish that fallback attempts actually occurred.

Reference values use scale `10^12`. Monetary and fixed-point inputs remain `bigint` or decimal strings; do not convert them through JavaScript floating-point numbers.

## Arithmetic specification and compatibility

`src/vectors.ts` implements the reference arithmetic with checked signed-`i128` boundaries and assumes valid reserved requests and ledger inputs. The [Rust engine](../cox/README.md) executes the mechanism and adds storage, capacity and custody enforcement. Independent verification implementations should derive their calculations from the specification rather than reuse this oracle.

The [mechanism specification](../cox/SPEC.md) and [shared fixtures](../cox/fixtures/vectors.json) define the interoperable encoding. The one-minute schedule includes a snapshot acceptance bound of cutoff +55 seconds; this is not a trade completion deadline. The compiled manifest explicitly records asynchronous execution with no fill deadline and a one-minute operating capacity target.
