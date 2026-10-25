# COX devnet deployment

This directory contains configuration and recorded release information for the COX Solana program. It targets devnet and test collateral.

| File | Purpose |
| --- | --- |
| `devnet.json` | Expected network, program identity, authorities and toolchain |
| `deployed-devnet.json` | Verified release commit, executable hash, deployment transaction and on-chain authority |
| `signer-allowlist.json` | Permitted runtime instructions and their discriminators |
| `initialized-devnet.json` | Recorded registry, sealed methodology, test mint, pool and vault initialization |
| `methodology-devnet.json` | Sealed methodology inputs and canonical bytes |
| `publisher-devnet.json` | Repository publisher configuration template |
| `publisher-running-devnet.json` | Dated runtime installation and verification record |

The program address is `G6iQGoupNSfduw1QJxQ9vcVi9FnCC6cbippXsi4QQzJF`. Treat the deployment record as a release record, rather than current pool or publisher status. Deploying the executable does not initialize a registry, seal a methodology, create collateral or activate a pool.

## Requirements

Run commands from the repository root with Node.js 24 and the pinned toolchain:

- Anchor dependencies: `0.31.1`.
- Agave SBF wrapper: `2.2.1`.
- Platform tools: `v1.48`, using `rustc 1.84.1-dev`.
- A generated IDL whose address matches the configured program.
- A funded devnet deployment wallet and the separately controlled program and upgrade keys.

Local keys are stored under ignored `.cox/keys` as `cox-program-keypair.json`, `cox-admin-keypair.json` and `cox-upgrade-keypair.json`. Their public identities must match `devnet.json`; files must not be readable by other users. Preserve the upgrade key securely. Runtime publishing uses the non-exportable `oracle-operator` KMS identity; never create a local copy of its private key.

Keep authenticated RPC URLs in private configuration. Never commit or log provider API keys or proxy access tokens.

## Build and review

```sh
node packages/cox/scripts/deployment.ts build \
  --solana-bin /path/to/solana-release/bin \
  --platform-tools /path/to/v1.48/platform-tools
```

The build records source digests, IDL hash, tool versions, compiler hash, binary size and executable SHA-256 in ignored `.cox/reviewed-build.json`. Run the [compiled program tests](../crates/program-tests/README.md) against that artifact and review the exact release commit before deployment.

The Agave 2.2.1 wrapper's default platform version is v1.44. This release explicitly requires v1.48. Prepare a dedicated SDK tree whose `platform-tools-sdk/sbf/scripts/install.sh` platform version and `platform-tools-sdk/sbf/dependencies/platform-tools` link both use v1.48, so compilation and stripping use the same platform. The repository script does not modify system tool installations.

## Deploy

After the concrete release commit is approved, build that committed revision and run:

```sh
node packages/cox/scripts/deployment.ts deploy \
  --solana-bin /path/to/solana-release/bin \
  --platform-tools /path/to/v1.48/platform-tools \
  --approved-commit FULL_COMMIT_SHA
```

The script requires a clean committed `packages/cox` tree, matching HEAD/reviewed-build/approved commit identities, matching local key identities and the pinned devnet genesis hash. Deployment may run from any branch; there is no remote-membership requirement. Recheck devnet SOL balance, program rent and transaction fees before each deployment. Devnet SOL used for fees and rent is separate from pool collateral.

The script downloads the deployed executable, compares it with the reviewed build while allowing only zero allocation padding, verifies the upgrade authority and writes `deployed-devnet.json`. A mismatch fails verification.

## Verify an existing deployment

With the matching reviewed build and toolchain present:

```sh
node packages/cox/scripts/deployment.ts verify \
  --solana-bin /path/to/solana-release/bin \
  --platform-tools /path/to/v1.48/platform-tools
```

A verified executable is only one part of activation. Pool initialization must bind the intended registry, sealed methodology, mint and vault. The signing service must independently bind those accounts, the verified program and approved runtime instructions before enabling publication. Admin operations, upgrades, wallet trades and token transfers remain outside the runtime signer allowlist. See the [publisher guide](../../../apps/cox-publisher/README.md) for runtime configuration and execution.

## Fresh-generation reset boundary

The lifecycle reset is prepared source, not a deployed reset. Preserve old account bytes, program/program-data identities, collateral vaults and publication history in a hash-addressed inventory before cutover. The approved old test owners are recorded privately in `.cox/fresh-generation-known-owners.json`; no old position is migrated, refunded or swept by the reset. A new owner or changed economic inventory requires Peter's review before discarding those test positions. A current capture is required again immediately before cutover; a development-time inventory is not final approval.

Legacy accounts can have nonzero unused trailing storage. The reviewed lifecycle release recognizes extensions by explicit markers (`RLPOOL01`, `RLCFG001`, `RLEPCH01`) rather than interpreting that storage as a version or enum. Exact markers with unsupported versions or incomplete payloads fail closed. Compiled tests use the actual captured old Basic account and dirty-padding Epoch accounts, including archival and owner withdrawal/refund paths. Rebuild and record artifacts after account-layout changes; do not deploy the earlier unmarked-footer release.

New Basic/Epoch identities remain Preparing until the later cutover/readiness gates. A single qualifying signed Pyth capture establishes the new origins at benchmark/display references 100; calculations continue afterward. Keep the current geometric and payout arithmetic, 30-member baskets, dual devnet collateral and 2-bps/$0.20 cap. A reset does not correct or overwrite the old benchmark history.

Global Basic pause also blocks existing batch cranks. Finish accepted work first, then atomically pause and archive with the administrator; the archival stage guard rejects a concurrently accepted batch. Recheck ownership and activity before retrying. Archived instances stay archived after global unpause and preserve historical reads and existing withdrawal/refund rights. Live cutover must still wait for the deployed-consumer evidence at Pause A; admission remains closed through Pause B.

## Fee upgrade for an existing pool

The configurable fee release preserves pool 1 and its existing collateral,
positions, queued requests and publication history. The target initial policy
is 2 bps with a 2,000,000-base-unit cap. Neither fee activation nor a program
upgrade is implied by a prepared artifact. Use the matching IDL and client
release; do not upgrade a running service independently across this boundary.

1. Review the compiled fee lifecycle tests and exact executable hash; obtain
   commit and deployment approval before changing the live program.
2. Prepare the publisher release and matching readers. The publisher's
   `programSha256` must identify the newly deployed executable. Prepare signer
   account-layout validation and API/UI fee handling before enabling fees.
3. Let the accepted batch finish. Stop the publisher while idle, pause the
   registry with admin authority, and preserve the latest finalized publication
   through the existing archive writer. Verify the archive backup and record
   pool, positions, requests and vault totals before migration.
4. Upgrade the existing program with its separate upgrade authority. Use
   `CoxInstructions.migratePool(admin, { pool, vault })` to migrate the paused
   pool in place. The migration accepts only the verified legacy pool layout
   with no unfinished batch and initializes every fee field to zero.
5. Verify unchanged units, reservations, payables, collateral and predecessor
   digest. Retain the old publication bytes. Roll out matching publisher,
   signer, API and client readers, unpause, then resume the publisher. Confirm
   a V2 publication links the preserved V1 predecessor and backups still work.
6. Schedule initial fees with `scheduleFees(admin, { pool, vault }, 2,
   2_000_000n, activationCutoff)`. Choose a future minute-aligned cutoff only
   after clients display fee terms and submit the expected configuration
   version. The initial schedule has no 24-hour notice requirement; replacing
   or cancelling it consumes that exception. Every later schedule requires
   24 hours. No timer or service restart is needed to activate: finalization
   commits the eligible configuration.
7. Demonstrate a real devnet wallet deposit, switch, redemption and withdrawal,
   reconcile gross/fee/net receipts, then withdraw earned fees to the admin's
   USDC account. Confirm queued pre-activation requests remain fee-free.

Joel's signer must retain only the six existing publication/processing
instructions. Migration, scheduling, cancellation, fee withdrawals and wallet
trade instructions must stay outside its allowlist. The API must use
`depositWithFee`, `switchWithFee`, `redeemWithFee` and `quoteRequestWithFee`
for migrated pools, expose gross/fee/net and configuration versions, and
include committed fees in vault reconciliation. Godwin's app must display
those fees and net outputs before wallet signing and rebuild on a version
mismatch. The independent monitor needs V2 receipt/state decoding and must
keep legacy history verification. Historical archives must never be rewritten.

Pause and investigate if the deployment hash, migration totals, vault equality
or history linkage differ from the reviewed values. After migration, do not
roll back to a program that does not understand the new accounting; preserve
state and fix forward through the controlled upgrade process.
