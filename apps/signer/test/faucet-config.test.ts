import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSignerConfig } from "../src/config.js";
import { keyDirectory, resolveKeys } from "../src/directory.js";
import { crc32c } from "../src/crc32c.js";

const ring = "projects/colosseum-eox/locations/us-central1/keyRings/eox-signing-dev/cryptoKeys";
const network = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const caller = "cox-faucet@colosseum-eox.iam.gserviceaccount.com";
const key = (name: string) => ({ keyVersion: `${ring}/${name}/cryptoKeyVersions/1`, network, validFrom: 0 });
const legacy = () => ({ environment: "dev", audience: "", keys: { "oracle-operator": key("oracle-operator") }, callers: {}, bindings: {}, directoryVersion: 3, retired: [] });
const faucet = () => ({
  ...legacy(),
  keys: { "oracle-operator": key("oracle-operator"), "devnet-faucet": key("devnet-faucet") },
  callers: { [caller]: ["devnet-faucet"] },
  bindings: { "devnet-faucet": { faucet: {
    mint: "5rpGrekfBLHdF8PD8eKLzXQPPmhyF7FCKeE1VA5CwV3X",
    sourceTokenAccount: "11111111111111111111111111111111", decimals: 6,
    maxTokenAmount: "100000000", maxSolLamports: "10000000",
  } } },
});
function load(value: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "faucet-config-"));
  try {
    const path = join(directory, "config.json");
    writeFileSync(path, JSON.stringify(value));
    return loadSignerConfig(path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("legacy signer configuration remains valid without a faucet role", () => {
  assert.equal(load(legacy()).keys["devnet-faucet"], undefined);
  const config = legacy();
  assert.throws(() => load({ ...config, keys: {} }), /missing key for oracle-operator/);
});

test("faucet configuration requires devnet, its own KMS key and integer validity", () => {
  assert.equal(load(faucet()).keys["devnet-faucet"]?.network, network);
  for (const environment of ["testnet", "mainnet"]) assert.throws(() => load({ ...faucet(), environment }), /devnet-only/);
  for (const wrongNetwork of ["solana:mainnet", "solana:testnet", `${network}x`]) {
    const value = faucet(); value.keys["devnet-faucet"].network = wrongNetwork;
    assert.throws(() => load(value), /devnet-only/);
  }
  for (const validFrom of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const value = faucet(); value.keys["devnet-faucet"].validFrom = validFrom;
    assert.throws(() => load(value), /validFrom/);
  }
  const sameKey = faucet();
  sameKey.keys["devnet-faucet"].keyVersion = `${ring}/oracle-operator/cryptoKeyVersions/2`;
  assert.throws(() => load(sameKey), /dedicated KMS key/);
});

test("faucet callers and bindings cannot enable an unconfigured optional key", () => {
  const enabled = faucet();
  assert.throws(() => load({ ...enabled, keys: legacy().keys }), /has no key/);
  assert.throws(() => load({ ...legacy(), bindings: enabled.bindings }), /have no key/);
});

test("faucet role cannot escape through general programs or oracle bindings", () => {
  const enabled = faucet();
  const solana = { maxComputeUnitPriceMicroLamports: "1", programs: [] };
  assert.throws(() => load({ ...enabled, bindings: { "devnet-faucet": { solana } } }), /only its transfer policy/);
  assert.throws(() => load({ ...enabled, bindings: { "devnet-faucet": {} } }), /binding required/);
  assert.throws(() => load({ ...enabled, bindings: { "oracle-operator": enabled.bindings["devnet-faucet"] } }), /only Solana programs/);
});

test("faucet limits and token identities are explicit and bounded", () => {
  const base = faucet();
  const binding = base.bindings["devnet-faucet"].faucet;
  const invalid = [
    { mint: "So11111111111111111111111111111111111111112" },
    { mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" },
    { sourceTokenAccount: "not-a-public-key" }, { decimals: 9 },
    { maxTokenAmount: "0" }, { maxTokenAmount: "100000001" },
    { maxTokenAmount: 100000000 }, { maxTokenAmount: "01" },
    { maxSolLamports: "10000001" }, { maxSolLamports: "-1" },
    { extra: true },
  ];
  for (const patch of invalid) {
    assert.throws(() => load({ ...base, bindings: { "devnet-faucet": { faucet: { ...binding, ...patch } } } }), /invalid signer config/);
  }
  const zeroSol = faucet(); zeroSol.bindings["devnet-faucet"].faucet.maxSolLamports = "0";
  assert.equal(load(zeroSol).bindings["devnet-faucet"]?.faucet?.maxSolLamports, "0");
});

test("key resolution and directory omit an unconfigured faucet and resolve it only when present", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  const pem = generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString();
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ pem, algorithm: "EC_SIGN_ED25519", protectionLevel: "SOFTWARE", pemCrc32c: String(crc32c(new TextEncoder().encode(pem))) }), { status: 200 });
  };
  try {
    const config = load(legacy());
    const keys = await resolveKeys(config, async () => "test");
    assert.equal(calls.length, 1);
    assert.deepEqual(keyDirectory(config, keys, 1).entries.map(entry => entry.role), ["oracle-operator"]);
    const enabled = load(faucet());
    const enabledKeys = await resolveKeys(enabled, async () => "test");
    assert.equal(calls.length, 3);
    assert.deepEqual(keyDirectory(enabled, enabledKeys, 1).entries.map(entry => entry.role), ["oracle-operator", "devnet-faucet"]);
    enabledKeys.delete("devnet-faucet");
    assert.throws(() => keyDirectory(enabled, enabledKeys, 1), /missing resolved key/);
  } finally { globalThis.fetch = original; }
});
