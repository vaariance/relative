# Relative methodology

The native implementation is the `relative-methodology` Rust crate in `rust/`. It exposes inclusion lifecycle rules and canonical commitments, immutable four-hour universe selection, exact-rational Epoch research simulation, and the shared `cox-math` geometric benchmark. The Rust publisher consumes this crate without invoking TypeScript.

```sh
pnpm --filter @cox/methodology build
pnpm --filter @cox/methodology test
```

Use Rust 1.90 or later for this standalone workspace. The inclusion capacity is 255 underlying assets plus the reserved CRYPTO class, separate from a personal basket's 30 members. The current publisher/contracts still bind a sealed Basic roster of at most 30; library support does not activate dynamic inclusion. Epoch simulation preserves the candidate score, 2-basis-point fee capped at 200,000 six-decimal units ($0.20), all-zero refunds and chart-only sensitivity. Exact research fractions are not a replacement for the contract's bounded arithmetic safeguards.

## Shared protocol fixtures

The legacy TypeScript implementation, public exports and fixture generator have been removed. Joel’s API fixture builder now calls the Rust `cox` CLI. The versioned protocol fixtures in `packages/cox/fixtures` remain unchanged and are checked by Rust tests; do not regenerate historical expected values from the implementation being tested.

```sh
cargo run --manifest-path packages/cox/Cargo.toml --locked -p cox-cli -- verify-vectors packages/cox/fixtures/vectors.json
```

Canonical adaptive methodology preparation lives in the native publisher. Legacy minute-policy manifests and wire commitments remain historical protocol identities; removing their generator does not redefine existing sealed data.

Price-only instruments represent `tokenMint` as `null`; no mint is fabricated for an index feed. Minted asset/universe commitments retain their V1 domains, while null-mint identities use V2 domains. Activation requires the exact scheduled second; missing its qualifying signed capture requires an explicitly new schedule. Existing assets retain permanent references and class identities across transitions.

Admission evidence limits `sourceAuthority` to 256 UTF-8 bytes. Oversized identities are rejected without truncation or normalization; source documents remain separately bound by their digests.

The native inclusion request reader is bounded at 4 MiB; approved/execution journals are bounded at 16 MiB. Capacity verification includes a signed 254-to-255 transition with 64-byte stable IDs, 16-byte symbols, mint bindings and maximum-length authority strings requiring JSON escaping. Large-universe rollout backup configurations must allow 16 MiB per file; the older 1 MiB limit is insufficient for the execution journal.
