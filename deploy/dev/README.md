# Development infrastructure

Scripts and systemd templates for a Solana devnet deployment on a Debian Compute
Engine VM. The shared deployment runs PostgreSQL, the price archiver, evidence
API, fixture app API and live app API. Publisher and monitor installations are
separate from the shared deployment. The signing service runs on Cloud Run;
the RPC proxy runs on Cloudflare Workers.

The supplied defaults target project `colosseum-eox`, instance `eox-dev`, zone
`europe-west1-b`. These are deployment defaults, not credentials or a public API
contract. Database and service endpoints bind to localhost; use SSH tunnels for
operator access.

## Service domains

| Hostname | Destination |
| --- | --- |
| `rpc.getrelative.trade` | Existing token-protected Solana RPC Worker; append the client's existing token path |
| `api.getrelative.trade` | Live Cloud Run app API |
| `fixture-api.getrelative.trade` | Synthetic Cloud Run fixture API |
| `signer.getrelative.trade` | Authenticated Cloud Run signer |
| `vm.getrelative.trade` | Compute Engine VM connection hostname, DNS only |

Cloud Run aliases use the Cloudflare Worker in `deploy/domains`. Deploy its
routes with `wrangler deploy --config deploy/domains/wrangler.toml`. Requests
require the Worker secrets `LIVE_API_ORIGIN`, `FIXTURE_API_ORIGIN` and
`SIGNER_ORIGIN`, containing the deployment's HTTPS origin URLs. Set them before
deploying; do not put their values in tracked files. Requests
and responses stream through without caching; authentication headers are
preserved. Existing Google and variance.space service URLs remain available.
The signer's Google identity-token audience is supplied privately at deployment
and remains unchanged when calling its alias.

The VM hostname does not expose its localhost services. Continue using SSH
tunnels for evidence, monitor and VM API access. Publisher and archiver are
background processes with no HTTP endpoint. These aliases do not automatically
change application configuration to use the new hostnames.

## Services

| Unit | Endpoint or role |
| --- | --- |
| `eox-evidence-api` | Evidence API, `127.0.0.1:8787` |
| `cox-app-api` | Synthetic fixture API, `127.0.0.1:8790` |
| `cox-app-api-live` | Devnet-backed app API for Basic pool 2 and Epoch config 2, `127.0.0.1:8791`; RPC URLs (direct Alchemy, then public devnet) in the root-only `/opt/eox/cox-app-api-live.env`; reads missed publications from `gs://colosseum-cox-publication-archives-dev/pool-2/history/` |
| `cox-archiver` | One-minute venue snapshot archive |
| `cox-publisher` | Snapshot publication and batch execution; installed separately |
| `cox-monitor` | Archive verdicts, `127.0.0.1:8792`; installed separately |

PostgreSQL 16 runs in Docker on host port 5433. Live API configuration and
transaction state are separate from the fixture service. A service reporting
`active` establishes process status, not successful publications or wallet fills.

## Shared service deployment

Prerequisites: authenticated Google Cloud CLI, SSH access, permissions to update
the VM and its backup bucket, and a reviewed commit containing the intended
release. From the repository root:

```sh
GCP_ACCOUNT=operator@example.com deploy/dev/deploy.sh
```

The script archives committed `HEAD`; uncommitted files are excluded. Overrides:
`GCP_PROJECT`, `GCP_ZONE`, `GCP_INSTANCE` and `GCP_BACKUP_BUCKET`. Select the cloud
account explicitly. This is a deployment action: it replaces the shared release,
runs migrations and restarts its managed services. It does not deploy the Solana
program, Cloud Run signer, Cloudflare proxy or independently installed monitor.
The publisher unit is supplied as a template and requires its own installation.

`setup.sh` installs Docker and Node.js 22 when missing, then pnpm 11.18.0.
The native publisher runs as a separately built Rust executable and does not need Node. API/SDK tooling that requires Node.js 24 needs its separately provisioned compatible runtime.

## Files and credentials

| Path | Purpose |
| --- | --- |
| `/opt/eox/app` | Committed shared-service release |
| `/opt/eox/DEPLOYED_COMMIT` | Shared release identity |
| `/opt/eox/.env` | Database credentials, mode 0600 |
| `/opt/eox/cox-app-api-live.env` | Live API configuration and RPC URLs |
| `/opt/eox/state/cox-app-api-live` | Persisted live API state |
| `/opt/eox/runtime/node-v24.21.0-linux-x64` | Checksum-pinned Node 24 for both app APIs (`@cox/client` needs Node 24) |
| `/opt/eox/logs/backup.log` | Database backup log |
| `/etc/cox-publisher/native.json` | Private native publisher configuration |
| `/var/lib/cox-publisher` | Publisher journal and recovery state |
| `/var/lib/cox-monitor/state.json` | Monitor progress and verdicts |

RPC URLs may contain credentials in their path or query. Store them in private
runtime configuration and avoid printing complete URLs. Keep the database off
the public internet. The publisher uses Google metadata credentials and IAM
identity-token generation for its dedicated caller identity; no runtime signing
key file belongs on the VM.

## Status and logs

Connect in the Cloud Console's VM SSH interface, or use:

```sh
gcloud compute ssh eox-dev --account="$GCP_ACCOUNT" --project=colosseum-eox --zone=europe-west1-b
```

Then inspect services and follow their logs:

```sh
systemctl list-units 'cox-*' 'eox-*' --type=service --all
sudo journalctl -u cox-publisher -f
sudo journalctl -u cox-archiver -n 50 --no-pager
sudo journalctl -u cox-app-api-live -n 50 --no-pager
sudo journalctl -u cox-monitor -n 50 --no-pager
```

Ctrl+C stops log viewing without stopping the service. Check an installed
publisher backup timer with `systemctl list-timers --all`. Preserve state across
restarts; deleting journals to clear retries can lose transaction recovery.

## Local access through SSH

Forward only the ports needed for the task:

```sh
gcloud compute ssh eox-dev --account="$GCP_ACCOUNT" --project=colosseum-eox --zone=europe-west1-b -- -L 5434:localhost:5433 -L 8787:localhost:8787 -L 8791:localhost:8791 -N
```

The database is then reachable on local port 5434, evidence API on 8787 and live
app API on 8791. Retrieve credentials through an authorized private channel;
do not paste database environment files into logs or public issue reports.

## Database backups and restore

`backup-db.sh` runs daily at 05:30 UTC under the service user. It creates a
custom-format `pg_dump`, validates it with `pg_restore --list`, uploads through
the Storage JSON API with `ifGenerationMatch=0` and checks the uploaded checksum.
Local dumps are retained for three days. The default private bucket is
`gs://colosseum-eox-db-backups`, with a 30-day lifecycle.

The VM service account has create-only bucket access. Restore with a separate
operator identity that can read backups, into a new database:

```sh
gcloud storage ls gs://colosseum-eox-db-backups/ --account="$GCP_ACCOUNT" --project=colosseum-eox
gcloud storage cp gs://colosseum-eox-db-backups/eox-<stamp>.dump . --account="$GCP_ACCOUNT" --project=colosseum-eox
createdb -h localhost -p 5433 -U eox eox_restore
pg_restore -h localhost -p 5433 -U eox -d eox_restore --no-owner eox-<stamp>.dump
```

Set database authentication privately. Never restore over the active database;
validate the restored data and append-only triggers before changing service
connections. Database backups do not automatically cover publisher journals,
publication archives or monitor state. Those require separate backup and restore procedures.

## Publisher archive backups

The Rust publisher archives confirmed pool 2 publication records at
`/var/lib/cox-publisher/basic-2-adaptive/publications/<sequence>.json` before
overwriting the reusable on-chain account. V2 records retain confirmed provenance;
backup does not make them finalized.

`cox-publisher-backup.timer` invokes the native `backup` command every minute.
API records are exported to
`gs://colosseum-cox-publication-archives-dev/pool-2/history/<sequence>/<sha256>.json`.
Recovery objects/manifests are separate under `basic-2/native`. The old TypeScript
backup script has been removed. Preserve historical pool 0/1 cloud objects.

See the [native backup and restore instructions](../../apps/cox-publisher/README.md#native-backup-and-restore)
for private configuration, workload identity, integrity checks and isolated restore.
Incremental uploads and explicit retention remain follow-up work. Check failures:

```sh
systemctl status cox-publisher-backup.timer
sudo journalctl -u cox-publisher-backup -n 30 --no-pager
```

## Separate components

- [Publisher configuration and recovery](../../apps/cox-publisher/README.md)
- [Monitor deployment](../../apps/cox-monitor/README.md)
- [App API configuration](../../apps/app-api/README.md)
- [Signer deployment and authentication](../../apps/signer/README.md)
- [RPC proxy deployment](../../apps/rpc-proxy/README.md)
- [Solana program deployment](../../packages/cox/deploy/README.md)

## Preparing the native publisher release

The source-only [native Dockerfile](../../apps/cox-publisher/native/Dockerfile)
uses Rust 1.90.0, the committed native Cargo lockfile and explicit path
dependencies. Its runtime is non-root and includes the system certificate
bundle. Configuration, credentials, journal state and build targets are not
copied into the image. The repository must first contain the approved committed
release; the staging command rejects dirty or untracked release inputs.

```sh
python3 deploy/dev/native-publisher-release.py stage \
  --approved-commit FULL_APPROVED_COMMIT \
  --basic-binary /reviewed/basic.so --epoch-binary /reviewed/epoch.so \
  --basic-sha256 REVIEWED_BASIC_SHA256 --epoch-sha256 REVIEWED_EPOCH_SHA256 \
  --output /private/release-bundle

python3 deploy/dev/native-publisher-release.py build \
  --bundle /private/release-bundle \
  --rust-image 'rust:1.90.0-bookworm@sha256:REVIEWED_IMAGE_DIGEST' \
  --runtime-image 'gcr.io/distroless/cc-debian12:nonroot@sha256:REVIEWED_IMAGE_DIGEST'

python3 deploy/dev/native-publisher-release.py verify \
  --bundle /private/release-bundle \
  --config /private/native.json --intent /private/activation-intent.json
```

Resolve and review both image digests before building; the release command
rejects floating tags. `build` exports an ELF64 x86-64 Linux executable and
records its hash and image inputs. The Dockerfile's `runtime` target can package
the same build as a container for a later reviewed rollout. Build reproducibility
means pinned source, dependencies, compiler and image inputs; compare independent
build hashes before claiming bit-for-bit reproduction.

`verify` needs `ALCHEMY_API_KEY` through the environment, checks direct Alchemy
with public devnet RPC as fallback, and never prints the authenticated URL. It
checks committed and staged source hashes, the supplied Basic/Epoch binary
hashes, both committed IDLs, Linux executable architecture and hash, a disabled
publisher configuration, and a matching unarmed activation intent at a future
four-hour UTC boundary. Origin and admission remain distinct. The contract
artifacts still require their separate reviewed build records and compiled
runtime test evidence; copying an artifact into the bundle does not prove its
provenance.

These commands do not install or start services, authorize remote signing,
create or activate pools, submit transactions, or grant deployment approval.
Keep private configuration and secrets outside the build context and release
bundle. After readiness and release approval, the service account needs write
access to its durable state directory and read-only mounted configuration;
credentials are supplied at runtime through the existing identity/secret paths.
