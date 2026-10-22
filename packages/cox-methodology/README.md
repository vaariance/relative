# Relative methodology

The native implementation is the `relative-methodology` Rust crate in `rust/`. It exposes inclusion lifecycle rules and canonical commitments, immutable four-hour universe selection, exact-rational Epoch research simulation, and the shared `cox-math` geometric benchmark. The Rust publisher consumes this crate without invoking TypeScript.

```sh
pnpm --filter @cox/methodology build
pnpm --filter @cox/methodology test
```

Use Rust 1.90 or later for this standalone workspace. The inclusion capacity of 256 is separate from a personal basket's 30 members. The current publisher/contracts still bind a sealed Basic roster of at most 30; library support does not activate dynamic inclusion. Epoch simulation preserves the candidate score, 2-basis-point fee capped at 200,000 six-decimal units ($0.20), all-zero refunds and chart-only sensitivity. Exact research fractions are not a replacement for the contract's bounded arithmetic safeguards.

## Shared protocol fixtures

The legacy TypeScript implementation, public exports and fixture generator have been removed. Joel’s API fixture builder now calls the Rust `cox` CLI. The versioned protocol fixtures in `packages/cox/fixtures` remain unchanged and are checked by Rust tests; do not regenerate historical expected values from the implementation being tested.

```sh
cargo run --manifest-path packages/cox/Cargo.toml --locked -p cox-cli -- verify-vectors packages/cox/fixtures/vectors.json
```

Canonical adaptive methodology preparation lives in the native publisher. Legacy minute-policy manifests and wire commitments remain historical protocol identities; removing their generator does not redefine existing sealed data.
