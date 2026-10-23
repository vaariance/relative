# COX signing service

A policy-restricted Solana signing service backed by a non-exportable Google Cloud KMS key. The publisher requests signatures through [`@eox/signing`](../../packages/signing/README.md); the service validates the caller, transaction and on-chain account relationships before signing.

The only active signing role is `oracle-operator`, using Ed25519. Admin, upgrade and user-wallet keys are outside this service. Historical role identities remain in the public-key directory for signature verification; they cannot request new signatures. The service exposes no EVM signing route.

## Requirements and startup

Install the workspace dependencies from the repository root. Running the service requires Google Application Default Credentials with access to the configured KMS key and Firestore decision store.

| Variable | Purpose |
| --- | --- |
| `SIGNER_CONFIG` | Required path to a signer configuration JSON file. |
| `GOOGLE_CLOUD_PROJECT` | Required project containing the Firestore decision store. |
| `SIGNER_SOLANA_RPC_URLS` | Ordered, whitespace-separated HTTPS RPC URLs; required when account-linkage checks are configured. Keep authenticated URLs in private runtime configuration. |
| `PORT` | HTTP port; defaults to `8080`. |

```sh
SIGNER_CONFIG=apps/signer/config/dev.json \
GOOGLE_CLOUD_PROJECT=colosseum-eox \
pnpm --filter @eox/signer start
```

The configuration defines the audience, permitted caller service accounts, immutable key version, network, program bindings and instruction rules. [`config/dev.json`](config/dev.json) is the devnet policy. Deployment requires the appropriate IAM permissions as well as these application-level bindings.

## API and authentication

The wire schema is `eox.signing/v1`.

| Endpoint | Behavior |
| --- | --- |
| `GET /health` | Process health; no application identity token required. |
| `GET /v1/keys` | Authenticated public-key directory, including retired identities. |
| `POST /v1/sign/solana` | Authenticated policy evaluation and signature request. |

Authenticated calls use a Google-signed identity token whose audience matches the configuration. The token must identify an allowlisted service account. Cloud Run deployments also require the caller to have service invocation permission. Generate short-lived tokens using workload identity or IAM service-account impersonation; do not distribute service-account key files.

The tracked dev configuration omits the deployment audience. Set
`SIGNER_AUDIENCE` in private runtime configuration before starting the signer.
It must match the existing Cloud Run invocation audience; the branded hostname
does not automatically change that audience.

## Signing policy

Each request carries an ID, role, network, key version, operation identity, expiry and exact transaction bytes. The service accepts expiry at most 600 seconds ahead. It records decisions in Firestore: retrying the same request returns its recorded result, while changed bytes or a different caller under the same ID produce `REQUEST_ID_CONFLICT`.

For the devnet COX binding, only `publish`, `evaluate`, `safety`, `seal_evaluation`, `execute` and `finalize` are authorized. Policy checks enforce the configured registry, pool, vault, sealed methodology, reusable batch and publication accounts. Request and position linkage is checked against live accounts. The signing key must be the fee payer.

Future Basic bindings use `cox-adaptive-v1` with an explicit pool ID (pool 1 is refused), pool address, operator, sealed methodology address and digest. Adaptive linkage requires methodology account schema 2, verifies the canonical byte hash and adaptive domain, and refuses the legacy minute policy schema 1. The `cox-v2` compatibility path is unchanged. Dual-collateral devnet bindings additionally set `testCollateralMint`. This requires the canonical trailing `test-vault` account on each runtime instruction and validates its classic SPL ownership, mint, pool authority and safe initialized state. Single-collateral bindings permit the trailing optional account to be omitted or represented by the program-ID sentinel; an arbitrary extra vault is refused. These checks preserve the preceding instruction account indices.

Future Epoch bindings use `epoch-v1`, pinning config ID/address, admin, operator and methodology digest. `close_snapshot` can return snapshot rent only to that operator, after validating the canonical snapshot and its seal/methodology or a valid earlier publication in the same transaction. It does not authorize closing epoch custody accounts. New bindings and transaction-V1 signing remain explicit configuration changes; this source support does not enable them in the current live configuration.


Transactions may include the bound instructions and permitted compute-budget instructions. Address lookup tables, other programs and other compute-budget operations are rejected. The devnet limits are 1,400,000 compute units and 1,000 micro-lamports per compute unit. Set a target's `enabled` flag to `false` to refuse signing for it.

RPC providers are checked against the configured network at startup. Account reads fail over on network failures, timeouts, HTTP 429 and server errors. Provider credentials belong in a secret store; failover logs identify hosts rather than complete URLs.

Successful requests return the verified KMS signature and signed transaction. Policy rejections return HTTP 403; missing authentication returns 401. KMS or decision-store unavailability returns 503. Signing does not broadcast the transaction or guarantee execution. Callers must reconcile chain state before building replacement transactions.

## Development

```sh
pnpm --filter @eox/signer build
pnpm --filter @eox/signer test
```

The `key-directory` script exports public identities from a configuration using a `GOOGLE_ACCESS_TOKEN`. The adapter proof script performs real KMS signing and can broadcast a funded devnet transaction; it is an operational check, not a read-only test.

See the [signing client](../../packages/signing/README.md) for request types and the [deployment guide](../../deploy/dev/README.md) for service operations.

### Versioned universes and staged snapshots

The prepared `cox-dynamic-v1` linkage pins Basic pool identity, its configured operator and the original `sourceMethodologyDigest`. It follows program-owned sealed universe versions, while requiring an admin-approved schedule, exact boundary capture, immutable prior instruments and bounded staging for operator-authored successors. Historical universe attestors remain historical: pending runtime rotation becomes effective only at its admin-scheduled publication batch. Administration, user trades and transfers remain outside the runtime signing allowlist.

Epoch's existing `epoch-v1` linkage requires explicit `allowStagedSnapshots: true` plus instruction allowlist entries before signing `initialize_snapshot`, `grow_snapshot`, `append_prices` or `seal_snapshot`. The guard binds the same operator, config, methodology and timestamp-derived snapshot PDA, caps new snapshots at 255 prices, enforces sorted unique pages of at most eight prices and preserves immutable sealed snapshots. This opt-in also permits refunding rent from an unsealed stage whose fixed oracle timestamp is at least 60 seconds old. Existing bindings keep their previous sealed-snapshot-only cleanup behavior. These source capabilities do not enable or deploy a live binding.
