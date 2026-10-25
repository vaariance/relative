import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import anchor, { type Idl } from "@coral-xyz/anchor";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { decodeEpochAccount, EpochReader, epochRoster, isEpochTerminal } from "../src/epoch-readers.ts";
import { marketLifecycle } from "../src/lifecycle.ts";
import { decodeAccount } from "../src/readers.ts";
import { readDynamicManifest } from "../src/dynamic.ts";

interface Fixture {
  programAddress: string; basicProgramAddress: string; evidence: string;
  expected: { lifecycle: string; frozenAssets?: number; emptyFinalized?: boolean; lifecycleVersion?: number };
  accounts: { name: string; address: string; owner: string; dataHex: string }[];
}
const idl = JSON.parse(readFileSync(new URL("../../cox-epoch/idl/epoch.json", import.meta.url), "utf8")) as Idl;
function fixture(name: string) {
  const input = JSON.parse(readFileSync(new URL(`../../cox-epoch/fixtures/generation/${name}.json`, import.meta.url), "utf8")) as Fixture;
  const rows = new Map<string, AccountInfo<Buffer>>(input.accounts.map(row => [row.address, { owner: new PublicKey(row.owner), data: Buffer.from(row.dataHex, "hex"), executable: false, lamports: 1, rentEpoch: 0 }]));
  const connection = { getAccountInfo: async (key: PublicKey) => rows.get(key.toBase58()) ?? null } as unknown as Connection;
  const program = new anchor.Program(idl, { connection }), reader = new EpochReader(program);
  const row = (name: string) => { const found = input.accounts.find(row => row.name === name)!; assert.ok(found); return { key: new PublicKey(found.address), info: rows.get(found.address)! }; };
  return { input, program, rows, reader, row };
}
test("typed Epoch readers consume compiled lifecycle, frozen roster and empty-terminal fixtures", async () => {
  for (const name of ["preparing", "active", "archived", "sealed-frozen-31", "successor-32", "empty-terminal-sealed", "empty-terminal-draft", "legacy-dirty-padding"]) {
    const f = fixture(name), root = f.row("config"), config = decodeEpochAccount(f.program, "poolConfig", root.info);
    assert.equal(marketLifecycle(config), f.input.expected.lifecycle.toLowerCase());
    assert.equal((await f.reader.config(config.admin, BigInt(config.configId.toString()))).configId.toString(), config.configId.toString());
    if (!f.input.accounts.some(row => row.name === "epoch")) continue;
    const row = f.row("epoch"), round = decodeEpochAccount(f.program, "epochAccount", row.info);
    const read = await f.reader.epoch({ config: root.key, opensAt: BigInt(round.opensAt.toString()) });
    assert.equal(read.bindingVersion, name === "legacy-dirty-padding" ? 0 : 1);
    if (f.input.expected.frozenAssets !== undefined) assert.equal(epochRoster(read).length, f.input.expected.frozenAssets);
    assert.equal(isEpochTerminal(read), !!f.input.expected.emptyFinalized);
    if (name === "legacy-dirty-padding") {
      assert.equal(config.lifecycleVersion, 0); assert.ok(config.assetRegistry.equals(PublicKey.default));
      assert.ok(read.registryVersion.equals(PublicKey.default));
    }
  }
});
test("frozen roster and permanent origins remain distinct from an expanded active registry", () => {
  const f = fixture("sealed-frozen-31"), round = decodeEpochAccount(f.program, "epochAccount", f.row("epoch").info);
  const basic = new anchor.Program(JSON.parse(readFileSync(new URL("../../cox/idl/cox.json", import.meta.url), "utf8")) as Idl, { connection: {} as Connection });
  const current = f.row("activeMethodology"), value = decodeAccount(basic, "methodology", current.info);
  const registry = decodeAccount(basic, "assetRegistry", f.row("assetRegistry").info);
  const frozen = f.row("methodology"), old = decodeAccount(basic, "methodology", frozen.info);
  assert.equal(readDynamicManifest(value, registry.sourcePool).instruments.length, 32);
  assert.equal(readDynamicManifest(old, registry.sourcePool).instruments.length, 31);
  assert.equal(round.universe.length, 0);
  assert.equal(epochRoster(round).length, 31);
  assert.ok(round.registryVersion.equals(f.row("assetRegistryVersion").key));
  assert.ok(!round.registryVersion.equals(registry.activeVersion));
  assert.ok(round.registryOriginBenchmarks.every(value => value.toString() === "100000000000000"));
  const next = fixture("successor-32"), successor = decodeEpochAccount(next.program, "epochAccount", next.row("epoch").info);
  assert.equal(successor.registryOriginBenchmarks.at(-1)!.toString(), "103000000000000");
  assert.equal(epochRoster(successor).length, 32);
  assert.ok("open" in decodeEpochAccount(next.program, "epochAccount", next.row("predecessorEpoch").info).state!.phase);
});
test("Epoch marker readers reject wrong ownership, unsupported versions and truncated marked data", () => {
  const f = fixture("active"), root = f.row("config").info, round = f.row("epoch").info;
  assert.throws(() => decodeEpochAccount(f.program, "poolConfig", { ...root, owner: PublicKey.default }), /AccountOwnerMismatch/);
  for (const [name, info, marker] of [["poolConfig", root, "RLCFG001"], ["epochAccount", round, "RLEPCH01"]] as const) {
    const offset = info.data.indexOf(Buffer.from(marker)); assert.ok(offset > 0);
    const version = Buffer.from(info.data); version[offset + 8] = 2;
    assert.throws(() => decodeEpochAccount(f.program, name, { ...info, data: version }), /Unsupported/);
    assert.throws(() => decodeEpochAccount(f.program, name, { ...info, data: info.data.subarray(0, offset + 9) }));
  }
});

test("Epoch readers reject forged context and retain terminal withdrawal balances", async () => {
  const f = fixture("active"), config = decodeEpochAccount(f.program, "poolConfig", f.row("config").info);
  const round = decodeEpochAccount(f.program, "epochAccount", f.row("epoch").info);
  const selection = { config: f.row("config").key, opensAt: BigInt(round.opensAt.toString()) };
  const wrong = new PublicKey(new Uint8Array(32).fill(91));
  f.rows.set(f.reader.pdas.config(wrong, BigInt(config.configId.toString())).toBase58(), f.row("config").info);
  await assert.rejects(f.reader.config(wrong, BigInt(config.configId.toString())), /EpochIdentityMismatch/);
  const changed = { ...selection, opensAt: selection.opensAt + 14_400n };
  f.rows.set(f.reader.pdas.epoch(changed).toBase58(), f.row("epoch").info);
  await assert.rejects(f.reader.epoch(changed), /EpochIdentityMismatch/);
  assert.ok(round.state);
  const state = { ...round.state, phase: { settled: {} }, ledger: { ...round.state.ledger,
    pendingGross: new anchor.BN(0), activeNet: new anchor.BN(0), heldFees: new anchor.BN(0), claimable: new anchor.BN(50) } };
  assert.equal(isEpochTerminal({ ...round, state }), true);
  assert.equal(isEpochTerminal({ ...round, state: { ...state, ledger: { ...state.ledger, pendingGross: new anchor.BN(1) } } }), false);
});
