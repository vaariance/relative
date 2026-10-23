import type { PublicKey } from "@solana/web3.js";
import { GoogleAuth } from "google-auth-library";
import { googleIdTokenVerifier } from "./auth.js";
import { loadSignerConfig } from "./config.js";
import { keyDirectory, resolveKeys } from "./directory.js";
import { createSignerServer } from "./server.js";
import { createSigningService } from "./service.js";
import { signSolanaTransaction } from "./solana.js";
import { FirestoreDecisionStore } from "./store.js";
import { checkGenesis, failoverConnection, parseRpcUrls } from "./rpc.js";

const configPath = process.env.SIGNER_CONFIG;
const project = process.env.GOOGLE_CLOUD_PROJECT;
if (!configPath || !project) throw new Error("SIGNER_CONFIG and GOOGLE_CLOUD_PROJECT are required");
const port = Number(process.env.PORT ?? "8080");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid PORT: ${port}`);

const config = loadSignerConfig(configPath);
config.audience = process.env.SIGNER_AUDIENCE ?? config.audience;
if (!config.audience) throw new Error("SIGNER_AUDIENCE is required");
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const token = async () => {
  const value = (await auth.getAccessToken()) as string | null | undefined;
  if (!value) throw new Error("no access token available");
  return value;
};
const now = () => Math.floor(Date.now() / 1000);

const needsSolanaReads = Object.values(config.bindings).some((b) => b?.faucet || b?.solana?.programs.some((p) => p.linkage));
let solanaAccounts;
if (needsSolanaReads) {
  const urls = parseRpcUrls(process.env.SIGNER_SOLANA_RPC_URLS, "SIGNER_SOLANA_RPC_URLS");
  await checkGenesis(urls, config.keys["oracle-operator"].network.slice("solana:".length));
  const connection = failoverConnection(urls, "confirmed", (from, to, reason) => console.warn(`solana rpc failover from ${from} to ${to}: ${reason}`));
  solanaAccounts = async (keys: PublicKey[]) =>
    (await connection.getMultipleAccountsInfo(keys, "confirmed")).map((a) => (a ? { owner: a.owner, data: Buffer.from(a.data) } : null));
}

const keys = await resolveKeys(config, token);
const directory = keyDirectory(config, keys, now());
const sign = createSigningService({
  config,
  keys,
  store: new FirestoreDecisionStore(project, token),
  signers: {
    solana: (keyVersion, rawPublicKey, transactionBase64) => signSolanaTransaction(token, keyVersion, rawPublicKey, transactionBase64),
  },
  now,
  log: (entry) => console.log(JSON.stringify({ severity: "INFO", message: "signing decision", ...entry })),
  solanaAccounts,
});

const server = createSignerServer({
  verifyCaller: googleIdTokenVerifier(config.audience, new Set(Object.keys(config.callers))),
  sign,
  directory: () => directory,
  onError: (error) => console.error(JSON.stringify({ severity: "ERROR", message: String(error) })),
});
server.listen(port, () => console.log(JSON.stringify({ severity: "INFO", message: `signer listening on ${port}`, environment: config.environment })));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
