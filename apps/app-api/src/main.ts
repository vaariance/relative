import { dirname, join, resolve } from "node:path";
import { addresses } from "@cox/client";
import { PublicKey } from "@solana/web3.js";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { loadProgram } from "./cox/chain.js";
import { EpochSource } from "./cox/epoch-source.js";
import { CoxFixtureSource } from "./cox/fixture-source.js";
import { LiveCoxSource, PoolMethodologyChanged } from "./cox/live-source.js";
import { ChainChangeFeed, gcsChainChangeStore } from "./cox/chain-changes.js";
import { gcsPreviewStore, PreviewFeed } from "./cox/preview.js";
import { PreviewHistory } from "./cox/preview-history.js";
import { directorySource, gcsSource, PublicationArchive, type ArchiveSource } from "./cox/publication-archive.js";
import { directorySegments, gcsSegments } from "./cox/publication-history.js";
import { FileSubmissionStore, FirestoreSubmissionStore } from "./cox/submission-store.js";
import { GoogleAuth } from "google-auth-library";
import { checkGenesis, failoverConnection, parseRpcUrls } from "./cox/rpc.js";
import { createCoxApiServer, type CoxApiServerOptions } from "./cox/server.js";
import { CoxSubmissions } from "./cox/submissions.js";
import { CoxTransactions } from "./cox/transactions.js";
import { FirestoreDocumentStore } from "./cox/document-store.js";
import { CoxFaucet } from "./cox/faucet.js";
import { createSigningClient } from "@eox/signing";
import type { Connection } from "@solana/web3.js";

const GENESIS: Record<string, string> = {
  "solana-devnet": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};
const POOL_WAIT_MS = 30_000;
const here = dirname(fileURLToPath(import.meta.url));

const mode = process.env.APP_API_SOURCE ?? "cox-fixture";
if (mode !== "cox-fixture" && mode !== "cox-live") throw new Error(`unsupported APP_API_SOURCE: ${mode}`);
const host = process.env.APP_API_HOST ?? "127.0.0.1";
const port = Number(process.env.APP_API_PORT ?? "8790");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid APP_API_PORT: ${port}`);

const corsOrigin = process.env.APP_API_CORS_ORIGIN ?? null;
if (corsOrigin !== null && corsOrigin !== "*" && !/^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(corsOrigin)) {
  throw new Error(`invalid APP_API_CORS_ORIGIN: ${corsOrigin}`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for APP_API_SOURCE=cox-live`);
  return value;
}

function whole(name: string, fallback: string, min: number): number {
  const text = process.env[name] ?? fallback;
  if (!/^[0-9]{1,15}$/.test(text) || Number(text) < min) throw new Error(`invalid ${name}: ${text}`);
  return Number(text);
}

async function openFaucet(connection: Connection, genesis: string, network: string, token: () => Promise<string>, auth: GoogleAuth): Promise<CoxFaucet | null> {
  const url = process.env.COX_FAUCET_SIGNER_URL;
  if (!url) return null;
  if (process.env.COX_FAUCET_FORWARD_URL) throw new Error("set only one of COX_FAUCET_SIGNER_URL and COX_FAUCET_FORWARD_URL");
  if (!/^https:\/\/[A-Za-z0-9.-]+(\/)?$/.test(url)) throw new Error("invalid COX_FAUCET_SIGNER_URL");
  const audience = required("COX_FAUCET_SIGNER_AUDIENCE");
  const address = new PublicKey(required("COX_FAUCET_ADDRESS"));
  const ipKeyText = required("COX_FAUCET_IP_KEY");
  if (!/^[0-9a-f]{64,128}$/.test(ipKeyText)) throw new Error("COX_FAUCET_IP_KEY must be 32 to 64 bytes of lowercase hex");
  const project = required("APP_API_SUBMISSIONS_FIRESTORE_PROJECT");
  const allowlist = new Set((process.env.COX_FAUCET_ALLOWLIST ?? "").split(",").map((owner) => owner.trim()).filter(Boolean).map((owner) => new PublicKey(owner).toBase58()));
  const idClient = await auth.getIdTokenClient(audience);
  const identityToken = async (): Promise<string> => {
    const headers = (await idClient.getRequestHeaders()) as Record<string, string>;
    const value = (headers.Authorization ?? headers.authorization ?? "").replace(/^Bearer /, "");
    if (!value) throw new Error("no identity token for the faucet signer");
    return value;
  };
  const signer = createSigningClient({ baseUrl: url, identityToken });
  const signingNetwork = `solana:${genesis.slice(0, 32)}`;
  const directory = await signer.keyDirectory();
  if (!Array.isArray(directory.entries)) throw new Error(`the faucet signer refused the key directory request: ${JSON.stringify(directory).slice(0, 200)}`);
  const key = directory.entries.filter((entry) => entry.role === "devnet-faucet" && entry.state === "active" && entry.network === signingNetwork);
  if (key.length !== 1) throw new Error(`expected one active devnet-faucet key, found ${key.length}`);
  if (key[0]!.address !== address.toBase58()) throw new Error(`faucet signer key ${key[0]!.address} is not COX_FAUCET_ADDRESS`);
  const faucet = new CoxFaucet({
    store: new FirestoreDocumentStore(project, process.env.APP_API_SUBMISSIONS_FIRESTORE_DATABASE ?? "(default)", token),
    connection,
    signer,
    faucet: address,
    keyVersion: key[0]!.keyVersion,
    network: signingNetwork,
    networkLabel: network,
    enabled: process.env.COX_FAUCET_ENABLED === "true",
    allowlist,
    ipKey: Buffer.from(ipKeyText, "hex"),
    limits: {
      cooldownSeconds: whole("COX_FAUCET_COOLDOWN_SECONDS", "86400", 3600),
      ipDaily: whole("COX_FAUCET_IP_DAILY", "3", 1),
      globalDaily: whole("COX_FAUCET_GLOBAL_DAILY", "50", 1),
      solGrantLamports: BigInt(whole("COX_FAUCET_SOL_LAMPORTS", "10000000", 0)),
      solBelowLamports: BigInt(whole("COX_FAUCET_SOL_BELOW_LAMPORTS", "5000000", 0)),
      reserveLamports: BigInt(whole("COX_FAUCET_RESERVE_LAMPORTS", "50000000", 0)),
    },
    onError: (error: unknown) => console.error("cox faucet", error),
  });
  console.log(`cox faucet ready for ${address.toBase58()} (${process.env.COX_FAUCET_ENABLED === "true" ? "open" : `allowlist of ${allowlist.size}`})`);
  return faucet;
}

async function live(): Promise<Pick<CoxApiServerOptions, "source" | "transactions" | "submissions" | "epochs" | "preview" | "previewHistory" | "classes" | "faucet">> {
  const network = process.env.COX_NETWORK ?? "solana-devnet";
  const genesis = GENESIS[network];
  if (!genesis) throw new Error(`unsupported COX_NETWORK: ${network}`);
  const poolText = process.env.COX_POOL_ID ?? "0";
  if (!/^(0|[1-9][0-9]{0,18})$/.test(poolText)) throw new Error(`invalid COX_POOL_ID: ${poolText}`);
  const pollMs = Number(process.env.COX_POLL_MS ?? "5000");
  if (!Number.isInteger(pollMs) || pollMs < 1000) throw new Error(`invalid COX_POLL_MS: ${pollMs}`);
  const stateDir = resolve(required("APP_API_STATE_DIR"));
  const urls = parseRpcUrls(process.env.COX_RPC_URLS, "COX_RPC_URLS");
  await checkGenesis(urls, genesis);
  const connection = failoverConnection(urls, "finalized", (from, to, reason) => console.warn(`cox rpc failover from ${from} to ${to}: ${reason}`));
  const program = loadProgram(connection, process.env.COX_IDL_PATH ?? join(here, "..", "..", "..", "packages", "cox", "idl", "cox.json"));
  const poolId = BigInt(poolText);
  const archiveDir = process.env.COX_PUBLICATION_ARCHIVE;
  const archiveGcs = process.env.COX_PUBLICATION_ARCHIVE_GCS;
  if (archiveDir && archiveGcs) throw new Error("set only one of COX_PUBLICATION_ARCHIVE and COX_PUBLICATION_ARCHIVE_GCS");
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const token = async (): Promise<string> => {
    const value = await auth.getAccessToken();
    if (!value) throw new Error("no Google access token");
    return value;
  };
  let source: ArchiveSource | null = null;
  if (archiveDir) source = directorySource(resolve(archiveDir));
  if (archiveGcs) source = gcsSource(archiveGcs, token);
  const historyGcs = process.env.APP_API_HISTORY_GCS;
  const segments = historyGcs ? gcsSegments(historyGcs, token) : directorySegments(join(stateDir, `history-${poolId}`));
  const faucet = await openFaucet(connection, genesis, network, token, auth);
  const firestoreProject = process.env.APP_API_SUBMISSIONS_FIRESTORE_PROJECT;
  const store = firestoreProject
    ? new FirestoreSubmissionStore(firestoreProject, `coxSubmissionsPool${poolId}`, token, fetch, process.env.APP_API_SUBMISSIONS_FIRESTORE_DATABASE ?? "(default)")
    : new FileSubmissionStore(join(stateDir, `submissions-${poolId}.json`));
  const epochConfig = process.env.COX_EPOCH_CONFIG;
  if (epochConfig !== undefined && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(epochConfig)) throw new Error(`invalid COX_EPOCH_CONFIG: ${epochConfig}`);
  const epochs = epochConfig
    ? await EpochSource.open({ connection, program: loadProgram(connection, process.env.COX_EPOCH_IDL_PATH ?? join(here, "..", "..", "..", "packages", "cox-epoch", "idl", "epoch.json")), config: new PublicKey(epochConfig) })
    : null;
  const poolAddress = addresses(program.programId).pool(poolId);
  const archive = source ? new PublicationArchive(source, program, poolAddress, genesis) : null;
  const changesGcs = process.env.COX_CHAIN_CHANGES_GCS;
  const changes = changesGcs
    ? new ChainChangeFeed({
        store: gcsChainChangeStore(changesGcs, token),
        identity: { networks: [network, genesis], program: program.programId.toBase58(), pools: [poolAddress.toBase58(), poolId.toString()] },
        nowMs: () => Date.now(),
        onError: (error: unknown) => console.error("cox chain change tick failed", error),
      })
    : null;
  if (changes) epochs?.cacheUntilInvalidated();
  const options = { connection, program, poolId, network, history: { path: join(stateDir, `publications-${poolId}.jsonl`), store: segments }, pollMs, archive, changes, onError: (error: unknown) => {
    if (error instanceof PoolMethodologyChanged) {
      console.error("cox pool methodology changed; restarting to load the new roster");
      process.exit(1);
    }
    console.error("cox indexer tick failed", error);
  } };
  for (;;) {
    try {
      const source = await LiveCoxSource.open(options);
      const epochAssets = new Map(source.manifest.assets.flatMap((asset) => (asset.epochId === null ? [] : [[asset.epochId, asset.assetId] as const])));
      if (epochAssets.size > 0) epochs?.nameAssets(epochAssets);
      source.onChainRefresh?.(() => epochs?.invalidate());
      source.start();
      changes?.start();
      const transactions = new CoxTransactions({
        connection, program, poolId, pool: source.poolAddress, vault: source.vaultAddress, mint: source.collateralMint, testVault: source.testVaultAddress, testMint: source.secondaryMint,
        origin: source.manifest.origin, interval: source.interval, acceptanceDeadline: source.acceptanceDeadline, classes: source.classes, dynamic: source.manifest.dynamic,
      });
      const submissions = new CoxSubmissions({ connection, programId: program.programId, epochProgramId: epochs?.programId ?? null, store, feeVersion: () => transactions.feeVersion() });
      const previewGcs = process.env.COX_PREVIEW_GCS;
      const previewStore = previewGcs ? gcsPreviewStore(previewGcs, token) : null;
      const previewIdentity = {
        networks: [network, genesis],
        program: program.programId.toBase58(),
        pools: [source.poolAddress.toBase58(), poolId.toString()],
        methodologyDigest: source.manifest.digest,
        assets: source.manifest.assets.map((asset) => asset.assetId),
        classes: source.classes,
      };
      const nowSeconds = () => Math.floor(Date.now() / 1000);
      const preview = previewStore
        ? new PreviewFeed({ store: previewStore, identity: previewIdentity, now: nowSeconds, onError: (error: unknown) => console.error("cox preview tick failed", error) })
        : null;
      const previewHistory = previewStore
        ? new PreviewHistory({
            store: previewStore,
            identity: previewIdentity,
            earlier: async (methodologyDigest: string) => ({ ...previewIdentity, methodologyDigest, ...(await source.methodologyRoster(methodologyDigest)) }),
            now: nowSeconds,
            onError: (error: unknown) => console.error("cox preview history record skipped", error),
          })
        : null;
      if (preview && previewHistory) {
        preview.onRecord((record) => previewHistory.add(record));
        void previewHistory.backfill().catch((error: unknown) => console.error("cox preview history backfill failed", error));
      }
      preview?.start();
      return { source, transactions, submissions, epochs, preview, previewHistory, classes: source.classes, faucet };
    } catch (error) {
      if (!(error instanceof Error) || !["CoxAccountNotFound", "PoolMethodologyNotSealed"].includes(error.message)) throw error;
      console.log(`cox pool ${poolId} is not active on ${network} yet (${error.message}); checking again in ${POOL_WAIT_MS / 1000} s`);
      await sleep(POOL_WAIT_MS);
    }
  }
}

const sources = mode === "cox-live" ? await live() : { source: new CoxFixtureSource(join(here, "..", "fixtures", "cox-fixture.json")) };
const postPerMinute = Number(process.env.APP_API_POST_LIMIT_PER_MINUTE ?? "30");
if (!Number.isInteger(postPerMinute) || postPerMinute < 1) throw new Error(`invalid APP_API_POST_LIMIT_PER_MINUTE: ${postPerMinute}`);
const postLimit = { perMinute: postPerMinute, trustForwardedFor: process.env.APP_API_TRUST_FORWARDED_FOR === "true" };
const faucetForward = process.env.COX_FAUCET_FORWARD_URL ?? null;
if (faucetForward !== null && !/^https:\/\/[A-Za-z0-9.-]+$/.test(faucetForward)) throw new Error("invalid COX_FAUCET_FORWARD_URL");
const gatewaySecret = process.env.APP_API_GATEWAY_SECRET ?? null;
if (gatewaySecret !== null && !/^[A-Za-z0-9_-]{32,128}$/.test(gatewaySecret)) throw new Error("APP_API_GATEWAY_SECRET must be 32 to 128 URL-safe characters");
const server = createCoxApiServer({ ...sources, corsOrigin, postLimit, faucetForward, gatewaySecret, onError: (error) => console.error("app-api request failed", error) });
server.listen(port, host, () => console.log(`app-api (${mode}) listening on http://${host}:${port}`));

function shutdown(): void {
  server.close(() => process.exit(0));
  server.closeAllConnections();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
