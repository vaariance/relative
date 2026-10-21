import anchor, { type Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createSigningClient } from "@eox/signing";
import { addresses } from "@cox/client";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { HttpArchive } from "./archive.ts";
import { assertReady, COX_PROGRAM_ID, loadConfig } from "./config.ts";
import { Journal } from "./journal.ts";
import { SolanaChain } from "./transport.ts";
import { Publisher } from "./worker.ts";
import { createPublisherIdentityToken } from "./identity.ts";
import { PublicationHistory } from "./history.ts";
import { createDirectDevnetConnection } from "./rpc.ts";

export const boundedFetch: typeof fetch = (input, init) => fetch(input, {
  ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
});

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf("--config");
  if (args.some((arg, index) => !["--config", "--locked", "--once"].includes(arg) && !(configIndex >= 0 && index === configIndex + 1))
      || (configIndex >= 0 && (!args[configIndex + 1] || args[configIndex + 1]!.startsWith("--")))) throw new Error("InvalidPublisherArguments");
  const path = configIndex >= 0 ? args[configIndex + 1]! : fileURLToPath(new URL("../config/dev.json", import.meta.url));
  const config = await loadConfig(path);
  if (!config.enabled) { console.log(JSON.stringify({ event: "disabled", livePublishing: false })); return; }
  assertReady(config);
  if (!args.includes("--locked")) {
    await mkdir(dirname(config.statePath), { recursive: true });
    const child = spawn("flock", ["--nonblock", "--no-fork", `${config.statePath}.flock`, process.execPath, ...process.execArgv,
      fileURLToPath(import.meta.url), ...args, "--locked"], { stdio: "inherit" });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.on("SIGTERM", forward); process.on("SIGINT", forward);
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject); child.once("close", code => resolve(code ?? 1));
    });
    process.off("SIGTERM", forward); process.off("SIGINT", forward);
    return;
  }
  const clock = { nowSeconds: () => BigInt(Math.floor(Date.now() / 1000)) };
  const policy = { assets: config.assets, origin: BigInt(config.origin), bybit: config.bybit, digest: config.methodologyDigest };
  const connection = createDirectDevnetConnection(process.env, "finalized");
  const idl = JSON.parse(await readFile(new URL("../../../packages/cox/idl/cox.json", import.meta.url), "utf8")) as Idl;
  const deployment = JSON.parse(await readFile(new URL("../../../packages/cox/deploy/deployed-devnet.json", import.meta.url), "utf8")) as { programId: string; deployedBuildSha256: string };
  const required = JSON.parse(await readFile(new URL("../../../packages/cox/deploy/publisher-build.json", import.meta.url), "utf8")) as { programId: string; sbfBuildSha256: string };
  const program = new anchor.Program(idl, { connection });
  if (program.programId.toBase58() !== COX_PROGRAM_ID || deployment.programId !== COX_PROGRAM_ID || required.programId !== COX_PROGRAM_ID) throw new Error("ProgramIdentityMismatch");
  if (deployment.deployedBuildSha256 !== required.sbfBuildSha256) throw new Error("RollingStorageUpgradeRequired");
  const signer = createSigningClient({ baseUrl: config.signerUrl, fetch: boundedFetch,
    identityToken: createPublisherIdentityToken(config.signerAudience, boundedFetch) });
  const poolId = BigInt(config.poolId);
  const identity = { program: COX_PROGRAM_ID, pool: addresses(program.programId).pool(poolId).toBase58(), genesisHash: config.genesisHash };
  const store = new Journal(config.statePath, identity);
  const history = new PublicationHistory(config.statePath + ".history", program, identity, poolId);
  const chain = new SolanaChain({ program, connection, poolId, policy, runtime: new PublicKey(config.runtimeAuthority),
    genesisHash: config.genesisHash, network: config.signerNetwork, keyVersion: config.keyVersion,
    programSha256: deployment.deployedBuildSha256, computeUnitLimit: config.computeUnitLimit,
    computeUnitPriceMicroLamports: config.computeUnitPriceMicroLamports, signer, store, clock,
    preservePublication: (info, slot) => history.preserve(info, slot) });
  const publisher = new Publisher({ identity, policy, chain, archive: new HttpArchive(config.archiveUrl), store, clock });
  const stop = new AbortController();
  const shutdown = () => stop.abort();
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
  let ready = false, failures = 0;
  try {
    do {
      const started = Date.now();
      try {
        if (!ready) { await chain.initialize(); ready = true; }
        const outcome = await publisher.tick();
        console.log(JSON.stringify({ event: "tick", outcome, durationMs: Date.now() - started, at: new Date().toISOString() }));
        failures = 0;
      } catch (error) {
        failures++;
        console.error(JSON.stringify({ event: "error", message: error instanceof Error ? error.message : String(error), failures }));
        if (args.includes("--once")) throw error;
      }
      if (args.includes("--once")) break;
      await delay(Math.min(config.retryMaxMs, config.pollMs * 2 ** Math.min(failures, 10)), undefined, { signal: stop.signal }).catch(error => {
        if (!stop.signal.aborted) throw error;
      });
    } while (!stop.signal.aborted);
  } finally { process.off("SIGTERM", shutdown); process.off("SIGINT", shutdown); }
}

main().catch(error => {
  console.error(JSON.stringify({ event: "fatal", message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
