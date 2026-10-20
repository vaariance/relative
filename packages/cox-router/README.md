# Full-output entry router

This separate Solana program invokes a supported Jupiter exact-input swap,
measures the owner's resulting collateral increase, and invokes the existing
COX `deposit_with_fee` instruction with that entire increase. The existing pool
program, pool identity, custody accounts and future-publication fill mechanism
are unchanged. Queued collateral is gross collateral: the pool's existing
deposit fee still applies when the request fills.

No router program address or deployment is recorded. A caller must explicitly
configure the reviewed router program address. Source code and host tests alone
are not evidence of a deployed or usable DEX integration.

The routed SDK leaves Express disabled by default. Callers inspect
`capabilities()` before preparation; enablement requires `expressEnabled: true`,
a same-network route provider and an executable configured router. The SDK
rechecks capability before producing a wallet transaction. This release has no
verified devnet route, so Express is unavailable on the current deployment.
These configuration checks do not verify the deployed router's binary; its
address and release must be reviewed before enabling. Direct class entry does
not depend on this router.

## Transaction contract

The SDK builds any required owner collateral ATA creation followed by one
`swap_and_deposit` router instruction. The router performs both CPIs inside
that instruction. It has no persistent state, custody authority, privileged
signer or intermediate position.

The router pins Jupiter v6 `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`
and COX `G6iQGoupNSfduw1QJxQ9vcVi9FnCC6cbippXsi4QQzJF`. It accepts only
`route`, `shared_accounts_route`, `route_v2` and `shared_accounts_route_v2`.
Unknown discriminators, token-ledger instructions, exact-output instructions,
platform fees and positive-slippage fees are rejected. Both source and
collateral must be classic SPL Token accounts owned by the signing wallet.
Native SOL requires a separately funded wrapped SOL account in this initial
integration; routes containing Token-2022 token accounts are unsupported.

Before swap CPI, validation binds the route's signing authority, source,
destination, output mint, applicable input mint and token programs. Other
wallet-owned or wallet-delegated token accounts and COX pool accounts cannot
be included in the swap CPI. The owner's swap CPI authority is read-only, so
the DEX cannot spend its lamports. The route must consume exactly the signed
input amount. Its output must be positive and at least `minimum_collateral`.
The router verifies that the swap did not change either token account's
delegate, close authority or native-token status. It deposits
`collateral_after_swap - collateral_before_swap`, then checks that the
collateral balance equals its original value.

The existing COX program independently checks the pool's collateral mint,
account derivations, ownership, request nonce, fee version, expiry, queue
admission and funds transfer. Any CPI error is returned to the runtime, so the
transaction must fail atomically. A failed transaction may still pay ordinary
Solana transaction fees. The eventual performance position remains queued
until publication, subject to the existing minimum-units and refund rules.

## Instruction encoding

The first eight bytes are `[50, 21, 140, 74, 249, 6, 205, 24]`, the Anchor
discriminator for `global:swap_and_deposit`. The remaining bytes use Borsh:

| Field | Type |
| --- | --- |
| `target_class` | `u8` |
| `input_amount` | `u64` |
| `minimum_collateral` | `u64` |
| `minimum_units` | `u128` |
| `expiry` | `u64` |
| `expected_fee_version` | `u64` |
| `route_data` | `Vec<u8>` |

Fixed accounts, in order:

| Index | Account | Access |
| --- | --- | --- |
| 0 | owner | signer, writable |
| 1 | COX registry | read-only |
| 2 | COX pool | writable |
| 3 | owner position | writable |
| 4 | next request | writable |
| 5 | pool vault | writable |
| 6 | owner collateral token account | writable |
| 7 | classic SPL Token program | read-only |
| 8 | System program | read-only |
| 9 | owner source token account | writable |
| 10 | Jupiter program | read-only |
| 11 | COX program | read-only |

Remaining accounts reproduce Jupiter's swap instruction account order,
including repeated accounts and optional-account sentinels. The router
constructs CPI metas from the transaction privileges while constraining
signers to the owner and removing the owner's writable privilege for swap CPI.

## Verification scope

```sh
cargo test --locked --manifest-path packages/cox-router/Cargo.toml
```

Twelve host tests invoke the actual router processor with Solana CPI syscall stubs.
They exercise full-output funding with zero and existing collateral, forward
the destination/minimum-units/expiry/fee-version fields, reject substituted
authority/protected accounts, extra signers, other wallet-owned/delegated
accounts and persistent token-state changes. They reject under/overspending,
exercise legacy shared and direct/shared V2 bindings, and propagate
swap/deposit failures and insufficient-output errors. The production router
encodes a typed, fixed COX deposit ABI; a test compares it byte-for-byte with
the generated COX instruction over boundary amounts. The full COX program is
only a development dependency, so its unused handlers are not compiled into
the router.

The router also compiles for SBF. Three LiteSVM tests load the compiled router,
the existing compiled COX program and a controlled swap program at the pinned
Jupiter address. That fixture moves tokens through real SPL Token CPIs. Tests
prove full output above the quote is queued from both zero and existing
collateral balances, runtime rollback after DEX/minimum-output/fee-version
failure, and next-publication direct-class fill with one deposit fee and no
intermediate CRYPTO units. The [verification record](results/verification.json)
pins source and artifact hashes.

With the Solana platform-tools Rust compiler and its SBF target on PATH, the
compiled suite can be reproduced from the repository root:

```sh
cargo build --locked --release --target sbf-solana-solana --manifest-path packages/cox-router/Cargo.toml
CARGO_TARGET_DIR="$PWD/packages/cox-router/target" cargo build --locked --release --target sbf-solana-solana --manifest-path packages/cox-router/test-swap/Cargo.toml
COX_ROUTER_SO="$PWD/packages/cox-router/target/sbf-solana-solana/release/cox_router.so" \
COX_ROUTER_TEST_SWAP_SO="$PWD/packages/cox-router/target/sbf-solana-solana/release/cox_router_test_swap.so" \
COX_PROGRAM_SO="$PWD/packages/cox/target/deploy/cox.so" \
cargo test --locked --manifest-path packages/cox-router/program-tests/Cargo.toml
```

The test crate declares Rust 1.84; its lockfile was resolved with Cargo's
`resolver.incompatible-rust-versions=fallback` setting. This does not modify
the existing pool's dependencies or deployed binary. Use the pinned pool
artifact identified by the verification record, or rebuild and reverify the
matching pool release before treating results as equivalent.

Compiled tests exercise the legacy direct-route fixture; shared and V2
bindings are covered by host tests. The controlled swap program is not Jupiter.
Before deployment, still verify
an actual supported Jupiter route on the intended network,
including compute/account/packet limits. Mainnet liquidity does not establish
a route to the existing devnet test collateral.

## Encoding references

- [Jupiter Build integration](https://developers.jup.ag/docs/swap/build/index)
- [Jupiter's legacy CPI IDL](https://github.com/jup-ag/jupiter-cpi/blob/main/idl.json)
- [Carbon's RouteV2 decoder](https://github.com/sevenlabs-hq/carbon/blob/main/decoders/jupiter-swap-decoder/src/instructions/route_v2.rs)
- [Carbon's SharedAccountsRouteV2 decoder](https://github.com/sevenlabs-hq/carbon/blob/main/decoders/jupiter-swap-decoder/src/instructions/shared_accounts_route_v2.rs)

The V2 decoder schemas are an independent implementation reference; accepting
their discriminators is not a live route compatibility proof. The mainnet-only
Jupiter API provider cannot be combined with the currently devnet-only COX SDK.
No router is deployed, and the existing app API's submission rules still need
an explicit routed-entry integration.
