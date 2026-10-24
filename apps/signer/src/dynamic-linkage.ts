import { createHash } from "node:crypto";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import type { DynamicCoxLinkage, SolanaProgramBinding } from "./config.js";
import type { AccountFetcher } from "./cox-linkage.js";
import { PolicyRejection } from "./policy.js";
import type { PolicyTransaction } from "./solana.js";

const deny = (message: string): never => { throw new PolicyRejection("TARGET_NOT_BOUND", message); };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest();
const disc = (kind: string, name: string) => hash(Buffer.from(`${kind}:${name}`)).subarray(0, 8);
const u64 = (value: bigint) => { const out = Buffer.alloc(8); out.writeBigUInt64LE(value); return out; };
const same = (left: PublicKey, right: PublicKey, label: string) => { if (!left.equals(right)) deny(`wrong dynamic ${label}`); };
const equal = (left: Buffer, right: Buffer, label: string) => { if (!left.equals(right)) deny(`wrong dynamic ${label}`); };
const nonzero = (value: Buffer) => value.some(byte => byte !== 0);
class Cursor {
  offset = 0;
  constructor(readonly bytes: Buffer) {}
  take(size: number): Buffer { if (!Number.isSafeInteger(size) || size < 0 || this.offset + size > this.bytes.length) return deny("truncated dynamic encoding"); const out = this.bytes.subarray(this.offset, this.offset + size); this.offset += size; return out; }
  byte() { return this.take(1)[0]!; }
  u16() { return this.take(2).readUInt16LE(); }
  u32() { return this.take(4).readUInt32LE(); }
  u64() { return this.take(8).readBigUInt64LE(); }
  i128() { const bytes = this.take(16); return bytes.readBigUInt64LE() + (bytes.readBigInt64LE(8) << 64n); }
  key() { return new PublicKey(this.take(32)); }
  count(maximum: number) { const value = this.u32(); if (value > maximum) return deny("dynamic vector exceeds capacity"); return value; }
  vector(width: number, maximum: number) { const count = this.count(maximum); this.take(count * width); return count; }
  text(maximum: number) { const bytes = this.take(this.count(maximum)); const value = bytes.toString("utf8"); if (!Buffer.from(value).equals(bytes)) return deny("invalid dynamic UTF8"); return value; }
}
interface Universe {
  schemaVersion: 1 | 2;
  pool: PublicKey; operator: PublicKey; source: Buffer; version: bigint; predecessor: Buffer; count: number;
  timestamp: bigint; benchmark: bigint; prices: bigint[]; sequence: bigint; state: Buffer;
  identitiesDigest: Buffer; instruments: { identity: Buffer; complete: Buffer; price: bigint; benchmark: bigint; timestamp: bigint }[];
}
export function universe(bytes: Buffer): Universe {
  const c = new Cursor(bytes);
  if (c.text(64) !== "COX/UNIVERSE/OPERATOR-ATTESTED/V1") return deny("wrong dynamic universe domain or schema");
  const schemaVersion = c.u16(); if (schemaVersion !== 1 && schemaVersion !== 2) return deny("wrong dynamic universe schema");
  const pool = c.key(), operator = c.key(), source = c.take(32), version = c.u64(), predecessor = c.take(32), count = c.u16();
  if (count < 30 || count > 255 || version < 1n || (version === 1n) !== !nonzero(predecessor)) return deny("invalid dynamic universe version");
  if (!nonzero(c.take(32))) return deny("missing price universe commitment");
  const timestamp = c.u64(), benchmark = c.i128(), priceCount = c.count(255), prices = Array.from({ length: priceCount }, () => c.u64());
  if (timestamp === 0n || benchmark <= 0n || priceCount !== count || prices.some(value => value === 0n) || !nonzero(c.take(32)) || !nonzero(c.take(32))) return deny("invalid dynamic capture");
  const sequence = c.u64(), state = c.take(32);
  if (sequence !== 0n && !nonzero(state) || c.count(255) !== count) return deny("invalid dynamic capture identity");
  const ids = new Set<string>(), symbols = new Set<string>(), epochs = new Set<number>(), pro = new Set<number>(), core = new Set<string>(), mints = new Set<string>();
  const instruments = Array.from({ length: count }, (_, index) => {
    const start = c.offset, id = c.text(64), symbol = c.text(16), classId = c.u16(), epoch = c.u16(), feed = c.u32(), coreFeed = c.take(32), mintTag = c.byte();
    if (mintTag > 1) return deny("invalid dynamic mint tag");
    const mint = mintTag === 1 ? c.key().toBase58() : null;
    if (!/^[a-z0-9._:-]{1,64}$/.test(id) || !/^[A-Z0-9._-]{1,16}$/.test(symbol) || classId !== (schemaVersion === 2 ? index + 1 : index < 30 ? index : index + 1) || epoch > 255 || feed === 0 || !nonzero(coreFeed)
      || mint === PublicKey.default.toBase58() || ids.has(id) || symbols.has(symbol) || epochs.has(epoch) || pro.has(feed) || core.has(coreFeed.toString("hex")) || mint !== null && mints.has(mint)) return deny("invalid dynamic instrument identity");
    ids.add(id); symbols.add(symbol); epochs.add(epoch); pro.add(feed); core.add(coreFeed.toString("hex")); if (mint !== null) mints.add(mint);
    const identity = bytes.subarray(start, c.offset), price = c.u64(), originBenchmark = c.i128(), originTimestamp = c.u64();
    if (price === 0n || originBenchmark <= 0n || originTimestamp === 0n) return deny("invalid dynamic original reference");
    return { identity, complete: bytes.subarray(start, c.offset), price, benchmark: originBenchmark, timestamp: originTimestamp };
  });
  if (c.offset !== bytes.length) return deny("trailing dynamic canonical bytes");
  const domain = Buffer.from("COX/UNIVERSE/IDENTITIES/V1"), header = Buffer.alloc(4); header.writeUInt32LE(domain.length);
  const length = Buffer.alloc(4); length.writeUInt32LE(count);
  return { schemaVersion, pool, operator, source, version, predecessor, count, timestamp, benchmark, prices, sequence, state,
    identitiesDigest: hash(Buffer.concat([header, domain, length, ...instruments.map(value => value.identity)])), instruments };
}
interface Method { digest: Buffer; canonical: Buffer; sealed: boolean; activation: bigint; expected: number; value?: Universe }
function method(bytes: Buffer, requireSealed: boolean): Method {
  const c = new Cursor(bytes); c.take(8);
  if (c.u16() !== 3) return deny("dynamic methodology schema 3 required");
  c.byte(); const digest = c.take(32), canonical = c.take(c.count(130560)), tag = c.byte(), activation = c.u64(), expected = c.u32();
  if (tag > 1 || expected < 1 || expected > 130560 || canonical.length > expected || requireSealed && tag !== 1) return deny("unsealed or malformed dynamic methodology");
  if (tag === 1 && canonical.length !== expected) return deny("incomplete dynamic methodology");
  let value: Universe | undefined;
  if (canonical.length === expected) { equal(hash(canonical), digest, "canonical digest"); value = universe(canonical); }
  return { digest, canonical, sealed: tag === 1, activation, expected, value };
}
function poolFields(bytes: Buffer) {
  const c = new Cursor(bytes); c.take(147); const origin = c.u64(), batch = c.u64(), sequence = c.u64(), state = c.take(32), benchmark = c.i128();
  const origins = Array.from({ length: c.count(255) }, () => c.u64()), prices = Array.from({ length: c.count(255) }, () => c.u64());
  const references = c.vector(16, 256), classes = c.vector(24, 256); c.take(40);
  const tag = c.byte(); if (tag > 1) return deny("invalid dynamic stage"); const stage = tag ? c.key() : null;
  const initializedTag = c.byte(); if (initializedTag > 1) return deny("invalid dynamic initialization state");
  const initialized = initializedTag === 1; c.u64(); const stageBatch = c.u64();
  let lifecycle = 1, cryptoClass = 30, assetRegistry = PublicKey.default;
  let generation: Buffer = Buffer.alloc(32);
  if (c.bytes.length - c.offset >= 89) {
    c.take(8 + 8 + 2 + 8 + 8 + 8 + 1 + 8 + 2 + 8 + 8 + 1 + 8);
    const testMint = c.byte(); if (testMint > 1) return deny("invalid dynamic collateral option"); if (testMint) c.take(32);
    if (c.bytes.length - c.offset >= 66) {
      const version = c.byte(), state = c.byte();
      if (version > 1 || state > 2) return deny("unsupported dynamic lifecycle extension");
      lifecycle = version === 0 ? 1 : state; assetRegistry = c.key(); generation = c.take(32);
      if (version === 1) { if (c.bytes.length - c.offset < 2) return deny("missing dynamic CRYPTO class"); cryptoClass = c.u16(); }
    }
  }
  if (origins.length < 30 || prices.length !== origins.length || classes !== origins.length + 1 || references !== classes) return deny("invalid dynamic pool capacity");
  return { origin, batch, sequence, state, benchmark, origins, prices, classes, stage, stageBatch, initialized, lifecycle, assetRegistry, generation, cryptoClass };
}
function batchFields(bytes: Buffer) {
  const c = new Cursor(bytes); c.take(8); const schema = c.u16(); c.byte(); const pool = c.key();
  if (![2, 3, 4].includes(schema)) return deny("invalid dynamic batch schema");
  const batch = c.u64(), sequence = c.u64(); c.take(80);
  const prices = c.vector(20, 255); c.take(16); c.vector(16, 256); c.vector(24, 256); c.vector(16, 256); c.vector(16, 256); c.vector(16, 256); c.vector(1, 256);
  c.take(48); const cursor = c.u64(); c.take(80); const phase = c.byte();
  return { pool, batch, sequence, prices, cursor, phase };
}

export async function checkDynamicCoxLinkage(binding: SolanaProgramBinding, linkage: DynamicCoxLinkage, transaction: PolicyTransaction, fetch: AccountFetcher): Promise<void> {
  const program = new PublicKey(binding.programId), operator = new PublicKey(linkage.operator), pool = new PublicKey(linkage.pool);
  const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program)[0];
  const relevant = transaction.message.compiledInstructions.filter(value => transaction.message.staticAccountKeys[value.programIdIndex]?.equals(program));
  if (!relevant.length) return;
  same(transaction.message.staticAccountKeys[0]!, operator, "operator payer");
  if (transaction.message.header.numRequiredSignatures !== 1) return deny("dynamic protocol requires sole operator signer");
  same(pool, pda(Buffer.from("pool"), u64(BigInt(linkage.poolId))), "pool PDA");
  const cache = new Map<string, Buffer>();
  async function account(key: PublicKey, name: string, minimum: number) {
    let bytes = cache.get(key.toBase58());
    if (!bytes) { const [value] = await fetch([key]); if (!value || !value.owner.equals(program)) return deny(`wrong dynamic ${name} owner`); bytes = value.data; cache.set(key.toBase58(), bytes); }
    if (bytes.length < minimum || !bytes.subarray(0, 8).equals(disc("account", name))) return deny(`invalid dynamic ${name} account`);
    return bytes;
  }
  if (relevant.every(instruction => Buffer.from(instruction.data).subarray(0, 8).equals(disc("global", "seal_genesis_methodology")))) {
    const registry = pda(Buffer.from("registry")), root = await account(registry, "Registry", 75);
    same(new PublicKey(root.subarray(43, 75)), operator, "genesis registry operator");
    for (const instruction of relevant) {
      const bytes = Buffer.from(instruction.data), keys = instruction.accountKeyIndexes.map(index => transaction.message.staticAccountKeys[index] ?? deny("missing genesis account"));
      if (bytes.length !== 8 || keys.length !== 3) return deny("invalid fresh genesis seal");
      same(keys[0]!, operator, "genesis operator"); same(keys[1]!, registry, "genesis registry");
      const next = method(await account(keys[2]!, "Methodology", 60), false), value = next.value ?? deny("incomplete fresh genesis");
      same(keys[2]!, pda(Buffer.from("methodology"), next.digest), "fresh genesis PDA"); same(value.pool, pool, "fresh genesis pool"); same(value.operator, operator, "fresh genesis operator");
      equal(value.source, Buffer.from(linkage.sourceMethodologyDigest, "hex"), "fresh genesis source");
      if (next.sealed || value.schemaVersion !== 2 || value.version !== 1n || nonzero(value.predecessor) || value.sequence !== 0n || nonzero(value.state) || value.benchmark !== 100000000000000n
        || value.instruments.some((asset, index) => asset.price !== value.prices[index] || asset.benchmark !== value.benchmark || asset.timestamp !== value.timestamp)) return deny("fresh genesis must reset all origins and have no predecessor");
    }
    return;
  }
  const root = await account(pool, "Pool", 219), schema = root.readUInt16LE(8), registry = pda(Buffer.from("registry"));
  if (![4, 5].includes(schema) || root.readBigUInt64LE(11) !== BigInt(linkage.poolId)) return deny("unsupported dynamic pool schema");
  same(new PublicKey(root.subarray(19, 51)), registry, "registry");
  const registryBytes = await account(registry, "Registry", 75);
  if (registryBytes.readUInt16LE(8) !== 1) return deny("wrong dynamic registry schema");
  let expectedOperator = new PublicKey(registryBytes.subarray(43, 75));
  if (registryBytes.length > 75) {
    const r = new Cursor(registryBytes); r.take(75); const pending = r.byte();
    if (pending > 1) return deny("invalid dynamic runtime rotation");
    const next = pending ? r.key() : null, effectiveBatch = r.u64();
    const beginning = relevant.find(value => Buffer.from(value.data).subarray(0, 8).equals(disc("global", "begin_dynamic_publication")));
    if (next && beginning && beginning.data.length === 104 && Buffer.from(beginning.data).readBigUInt64LE(8) >= effectiveBatch) expectedOperator = next;
  }
  same(expectedOperator, operator, "registry operator");
  const methodology = new PublicKey(root.subarray(51, 83)), vault = pda(Buffer.from("vault"), pool.toBuffer()), batchKey = pda(Buffer.from("batch"), pool.toBuffer()), publication = pda(Buffer.from("publication"), pool.toBuffer());
  same(new PublicKey(root.subarray(115, 147)), vault, "primary vault");
  const fields = poolFields(root), source = Buffer.from(linkage.sourceMethodologyDigest, "hex");
  if (fields.lifecycle === 2) return deny("dynamic pool is archived");
  let current: Method | null = null;
  if (schema === 5) {
    current = method(await account(methodology, "Methodology", 60), true);
    same(methodology, pda(Buffer.from("methodology"), current.digest), "methodology PDA");
    same(current.value!.pool, pool, "universe pool"); equal(current.value!.source, source, "source methodology");
    if (current.value!.count !== fields.origins.length) return deny("dynamic universe/pool shape mismatch");
    if (fields.cryptoClass !== (current.value!.schemaVersion === 2 ? 0 : 30)) return deny("dynamic CRYPTO class does not match universe schema");
  } else {
    const old = await account(methodology, "Methodology", 60);
    if (old.readUInt16LE(8) !== 2) return deny("bootstrap requires adaptive methodology");
    equal(old.subarray(11, 43), source, "bootstrap source methodology");
    const length = old.readUInt32LE(43), domain = Buffer.from("COX/METHODOLOGY/ADAPTIVE/V1");
    if (length > 8192 || old.length <= 47 + length || old[47 + length] !== 1) return deny("unsealed bootstrap methodology");
    const canonical = old.subarray(47, 47 + length);
    equal(hash(canonical), source, "bootstrap canonical digest");
    if (canonical.length < 4 + domain.length || canonical.readUInt32LE(0) !== domain.length || !canonical.subarray(4, 4 + domain.length).equals(domain)) return deny("wrong bootstrap adaptive domain");
    same(methodology, pda(Buffer.from("methodology"), source), "bootstrap methodology PDA");
  }
  const testVault = pda(Buffer.from("test-vault"), pool.toBuffer());
  if (linkage.testCollateralMint !== undefined) {
    const [value] = await fetch([testVault]); const mint = new PublicKey(linkage.testCollateralMint);
    if (!value || !value.owner.equals(new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")) || value.data.length !== 165 || mint.equals(new PublicKey(root.subarray(83, 115)))) return deny("invalid dynamic test vault");
    same(new PublicKey(value.data.subarray(0, 32)), mint, "test mint"); same(new PublicKey(value.data.subarray(32, 64)), pool, "test vault authority");
    if (value.data.readUInt32LE(72) !== 0 || value.data[108] !== 1 || value.data.readUInt32LE(109) !== 0 || value.data.readUInt32LE(129) !== 0) return deny("unsafe dynamic test vault state");
  }
  const optionalVault = (keys: PublicKey[], fixed: number) => {
    if (linkage.testCollateralMint !== undefined) { if (keys.length !== fixed + 1) return deny("missing dynamic test vault"); same(keys[fixed]!, testVault, "test vault PDA"); }
    else if (keys.length === fixed + 1) same(keys[fixed]!, program, "test vault sentinel"); else if (keys.length !== fixed) return deny("unexpected dynamic accounts");
  };
  const bind = (actual: PublicKey[], expected: PublicKey[]) => { if (actual.length !== expected.length) return deny("wrong dynamic account count"); actual.forEach((key, index) => same(key, expected[index]!, `account ${index}`)); };
  async function schedule(key: PublicKey) {
    if (!current?.value) return deny("schedule requires dynamic pool");
    const bytes = await account(key, "UniverseSchedule", 167), c = new Cursor(bytes); c.take(8);
    if (c.u16() !== 1) return deny("invalid universe schedule schema"); c.byte(); same(c.key(), pool, "schedule pool");
    const predecessor = c.take(32), algorithm = c.take(32), version = c.u64(), identities = c.take(32), count = c.u16(), timestamp = c.u64(), expires = c.u64(), cancelled = c.byte(), consumed = c.byte();
    const now = BigInt(Math.floor(Date.now() / 1000));
    same(key, pda(Buffer.from("universe-schedule"), pool.toBuffer(), u64(version)), "schedule PDA");
    equal(predecessor, current.digest, "schedule predecessor"); equal(algorithm, source, "schedule algorithm");
    if (version !== current.value.version + 1n || count <= current.value.count || count > 255 || !nonzero(identities) || cancelled !== 0 || consumed !== 0 || now < timestamp || now > expires || expires < timestamp || expires > timestamp + 86400n || fields.origin + fields.batch !== timestamp || fields.stage) return deny("unapproved, expired, cancelled or non-boundary universe schedule");
    return { version, identities, count, timestamp, expires };
  }
  const verifyNext = (next: Method, approved: Awaited<ReturnType<typeof schedule>>) => {
    const value = next.value ?? deny("incomplete scheduled capture");
    same(value.pool, pool, "capture pool"); same(value.operator, operator, "capture operator"); equal(value.source, source, "capture algorithm");
    equal(value.predecessor, current!.digest, "capture predecessor"); equal(value.identitiesDigest, approved.identities, "approved instrument identities");
    if (value.schemaVersion !== current!.value!.schemaVersion || value.version !== approved.version || value.count !== approved.count || value.timestamp !== approved.timestamp || next.activation !== value.timestamp - fields.origin || value.sequence !== fields.sequence || !value.state.equals(fields.state) || value.benchmark !== fields.benchmark
      || !current!.value!.instruments.every((instrument, index) => instrument.complete.equals(value.instruments[index]!.complete)) || !fields.prices.every((price, index) => price === value.prices[index])) return deny("scheduled capture changed fixed lineage, benchmark or boundary");
    if (value.instruments.slice(current!.value!.count).some((instrument, index) => instrument.price !== value.prices[index + current!.value!.count] || instrument.benchmark !== value.benchmark || instrument.timestamp !== value.timestamp)) return deny("scheduled capture changed new original references");
  };
  const pendingMethods = new Map<string, Method>();
  async function nextMethod(key: PublicKey, sealed: boolean): Promise<Method> {
    const value = pendingMethods.get(key.toBase58()) ?? method(await account(key, "Methodology", 60), sealed);
    if (sealed && !value.sealed) return deny("unsealed dynamic successor");
    return value;
  }
  let stage: ReturnType<typeof batchFields> | null = null;
  async function batch() { if (!stage) { stage = batchFields(await account(batchKey, "Batch", 139)); same(stage.pool, pool, "batch pool"); } return stage; }
  const names = ["seal_dynamic_methodology", "initialize_dynamic_staging", "register_asset_registry_version", "activate_asset_registry_version", "register_scheduled_methodology", "upload_scheduled_methodology", "seal_scheduled_methodology", "activate_universe", "grow_dynamic_account", "begin_dynamic_publication", "append_dynamic_prices", "seal_dynamic_publication", "prepare_dynamic_revaluation", "finish_dynamic_revaluation", "evaluate", "safety", "execute", "seal_evaluation", "finalize"];
  for (const instruction of relevant) {
    const bytes = Buffer.from(instruction.data), name = names.find(value => bytes.subarray(0, 8).equals(disc("global", value))), keys = instruction.accountKeyIndexes.map(index => transaction.message.staticAccountKeys[index] ?? deny("missing dynamic account"));
    if (!name || schema === 4 && name !== "seal_dynamic_methodology") return deny("instruction is not approved dynamic runtime");
    if (name === "initialize_dynamic_staging") {
      if (bytes.length !== 8 || fields.initialized || fields.lifecycle !== 0) return deny("dynamic staging requires preparing genesis");
      bind(keys, [operator, pool, batchKey, publication, SystemProgram.programId]); continue;
    }
    if (name === "register_asset_registry_version" || name === "activate_asset_registry_version") {
      if (bytes.length !== 8 || fields.assetRegistry.equals(PublicKey.default) || !nonzero(fields.generation)) return deny("unbound asset registry operation");
      const registration = name === "register_asset_registry_version", methodKey = keys[registration ? 4 : 3]!;
      const next = method(await account(methodKey, "Methodology", 60), true);
      same(methodKey, pda(Buffer.from("methodology"), next.digest), "registry methodology PDA");
      same(next.value!.pool, pool, "registry universe pool"); same(next.value!.operator, operator, "registry universe operator"); equal(next.value!.source, source, "registry universe source");
      const assetRegistry = pda(Buffer.from("asset-registry"), fields.generation), versionKey = pda(Buffer.from("asset-version"), assetRegistry.toBuffer(), next.digest);
      same(assetRegistry, fields.assetRegistry, "asset registry PDA");
      if (registration) {
        bind(keys, [operator, registry, pool, assetRegistry, methodKey, versionKey, SystemProgram.programId]);
        if (!next.digest.equals(current!.digest)) verifyNext(next, await schedule(pda(Buffer.from("universe-schedule"), pool.toBuffer(), u64(next.value!.version))));
      } else {
        bind(keys, [operator, registry, pool, methodology, assetRegistry, versionKey, program]);
        const root = await account(assetRegistry, "AssetRegistry", 187), version = await account(versionKey, "AssetRegistryVersion", 188);
        if (next.value!.version !== 1n || !next.digest.equals(current!.digest) || nonzero(root.subarray(107, 139)) || version[187] !== 0 || !root.subarray(11, 43).equals(fields.generation) || !version.subarray(43, 75).equals(fields.generation) || !version.subarray(107, 139).equals(next.digest)) return deny("standalone registry activation is genesis-only");
      }
      continue;
    }
    if (name === "seal_dynamic_methodology") {
      if (schema !== 4 || bytes.length !== 8) return deny("genesis seal only allowed before migration");
      bind(keys.slice(0, 4), [operator, registry, pool, methodology]); if (keys.length !== 5) return deny("wrong genesis accounts");
      const next = method(await account(keys[4]!, "Methodology", 60), false), value = next.value ?? deny("incomplete genesis");
      same(keys[4]!, pda(Buffer.from("methodology"), next.digest), "genesis PDA");
      same(value.pool, pool, "genesis pool"); same(value.operator, operator, "genesis operator"); equal(value.source, source, "genesis source");
      if (next.sealed || value.version !== 1n || value.count !== 30 || value.timestamp !== fields.origin || value.benchmark !== 100000000000000n || value.sequence !== fields.sequence || !value.state.equals(fields.state)
        || !value.prices.every((price, index) => price === fields.origins[index]) || value.instruments.some((asset, index) => asset.price !== fields.origins[index] || asset.benchmark !== value.benchmark || asset.timestamp !== fields.origin)) return deny("invalid genesis capture");
      continue;
    }
    if (name === "register_scheduled_methodology") {
      if (bytes.length !== 44 || keys.length !== 7) return deny("invalid scheduled registration");
      const approved = await schedule(keys[4]!); bind(keys, [operator, registry, pool, methodology, keys[4]!, pda(Buffer.from("methodology"), bytes.subarray(8, 40)), SystemProgram.programId]);
      const length = bytes.readUInt32LE(40); if (!nonzero(bytes.subarray(8, 40)) || length < 1 || length > 130560 || approved.count < 31) return deny("invalid scheduled canonical length");
      pendingMethods.set(keys[5]!.toBase58(), { digest: bytes.subarray(8, 40), canonical: Buffer.alloc(0), expected: length, activation: approved.timestamp - fields.origin, sealed: false });
      continue;
    }
    if (["upload_scheduled_methodology", "seal_scheduled_methodology", "activate_universe"].includes(name)) {
      const activation = name === "activate_universe";
      if (activation) {
        const bound = !fields.assetRegistry.equals(PublicKey.default);
        const base = keys.length >= 11 ? keys.slice(0, 8) : keys;
        optionalVault(base, 7);
        if (bound) {
          if (keys.length !== 11) return deny("missing registry activation accounts");
          const next = await nextMethod(keys[4]!, true), assetRegistry = pda(Buffer.from("asset-registry"), fields.generation);
          bind(keys.slice(8), [assetRegistry, pda(Buffer.from("asset-version"), assetRegistry.toBuffer(), next.digest), pda(Buffer.from("asset-version"), assetRegistry.toBuffer(), current!.digest)]);
          same(assetRegistry, fields.assetRegistry, "activation registry");
        } else if (keys.length === 11) bind(keys.slice(8), [program, program, program]);
      }
      if (!activation && keys.length !== 6) return deny("unexpected scheduled upload accounts");
      const scheduleKey = keys[activation ? 6 : 4]!, approved = await schedule(scheduleKey), nextKey = keys[activation ? 4 : 5]!;
      const next = await nextMethod(nextKey, activation); same(nextKey, pda(Buffer.from("methodology"), next.digest), "next methodology PDA");
      bind(keys.slice(0, 4), [operator, registry, pool, methodology]);
      if (activation) same(keys[5]!, vault, "activation vault");
      if (next.activation !== approved.timestamp - fields.origin) return deny("next methodology is outside approved boundary");
      if (name === "upload_scheduled_methodology") {
        if (bytes.length < 17 || next.sealed || bytes.readUInt32LE(8) !== next.canonical.length || bytes.readUInt32LE(12) < 1 || bytes.readUInt32LE(12) > 900 || bytes.length !== 16 + bytes.readUInt32LE(12) || next.canonical.length + bytes.readUInt32LE(12) > next.expected) return deny("invalid scheduled upload cursor or page");
        next.canonical = Buffer.concat([next.canonical, bytes.subarray(16)]);
        if (next.canonical.length === next.expected) { equal(hash(next.canonical), next.digest, "uploaded canonical digest"); next.value = universe(next.canonical); }
        pendingMethods.set(nextKey.toBase58(), next);
      } else {
        if (bytes.length !== 8 || !activation && next.sealed) return deny("invalid scheduled seal"); verifyNext(next, approved);
        if (!activation) { next.sealed = true; pendingMethods.set(nextKey.toBase58(), next); }
      }
      continue;
    }
    if (name === "grow_dynamic_account") {
      bind(keys.slice(0, 3), [operator, registry, pool]); if (keys.length !== 5 || bytes.length !== 12 || fields.stage) return deny("invalid dynamic growth"); same(keys[4]!, SystemProgram.programId, "growth system program");
      const [target] = await fetch([keys[3]!]); const growth = bytes.readUInt32LE(8); if (!target || !target.owner.equals(program) || growth < 1 || growth > 8192) return deny("invalid dynamic growth target");
      let limit = 0;
      if (keys[3]!.equals(pool)) limit = 32768;
      else if (keys[3]!.equals(batchKey) || keys[3]!.equals(publication)) limit = Math.ceil((4096 + fields.classes * 128) / 8192) * 8192;
      else if (target.data.subarray(0, 8).equals(disc("account", "Position")) && target.data.length >= 75 && target.data.readUInt16LE(8) === 1) {
        same(new PublicKey(target.data.subarray(11, 43)), pool, "position growth pool"); same(keys[3]!, pda(Buffer.from("position"), pool.toBuffer(), target.data.subarray(43, 75)), "position growth PDA"); limit = Math.ceil((512 + fields.classes * 80) / 4096) * 4096;
      } else if (target.data.subarray(0, 8).equals(disc("account", "Methodology"))) {
        const next = method(target.data, false); if (next.sealed) return deny("sealed methodology growth forbidden"); same(keys[3]!, pda(Buffer.from("methodology"), next.digest), "growth methodology PDA");
        const approved = await schedule(pda(Buffer.from("universe-schedule"), pool.toBuffer(), u64(current!.value!.version + 1n)));
        if (next.activation !== approved.timestamp - fields.origin) return deny("unapproved methodology growth"); limit = next.expected + 512;
      }
      if (!limit || target.data.length + growth > limit || target.data.length + growth > 131072) return deny("dynamic growth exceeds target bound");
      continue;
    }
    if (name === "begin_dynamic_publication") {
      optionalVault(keys, 8); bind(keys.slice(0, 8), [operator, operator, registry, pool, methodology, batchKey, vault, SystemProgram.programId]);
      const genesis = !fields.initialized && fields.lifecycle === 0 && fields.sequence === 0n && bytes.length === 104 && bytes.readBigUInt64LE(8) === 0n;
      if (bytes.length !== 104 || fields.stage || !genesis && (bytes.readBigUInt64LE(8) <= fields.batch || bytes.readBigUInt64LE(8) <= fields.stageBatch) || bytes.readBigUInt64LE(16) !== fields.sequence + 1n || !bytes.subarray(24, 56).equals(fields.state)) return deny("invalid dynamic publication predecessor");
      const c = new Cursor(bytes.subarray(88)); if (c.i128() <= 0n || !nonzero(bytes.subarray(56, 88))) return deny("invalid dynamic publication benchmark");
      stage = { pool, batch: bytes.readBigUInt64LE(8), sequence: bytes.readBigUInt64LE(16), prices: 0, cursor: 0n, phase: 4 }; continue;
    }
    if (["append_dynamic_prices", "seal_dynamic_publication", "prepare_dynamic_revaluation", "finish_dynamic_revaluation"].includes(name)) {
      bind(keys, [operator, registry, pool, methodology, batchKey]); const state = await batch();
      if (name === "append_dynamic_prices") {
        const count = bytes.length >= 14 ? bytes.readUInt32LE(10) : 0;
        if (state.phase !== 4 || count < 1 || count > 16 || bytes.length !== 14 + count * 20 || bytes.readUInt16LE(8) !== state.prices || state.prices + count > current!.value!.count) return deny("invalid dynamic price page or cursor");
        const c = new Cursor(bytes.subarray(14)); for (let index = 0; index < count; index++) { if (c.u64() === 0n || c.byte() !== 3 || c.byte() !== 0 || c.u64() !== fields.origin + state.batch || c.u16() !== 0) return deny("invalid dynamic price source or timestamp"); }
        state.prices += count;
      } else if (name === "seal_dynamic_publication") {
        if (bytes.length !== 8 || state.phase !== 4 || state.prices !== current!.value!.count) return deny("invalid dynamic publication seal phase"); state.phase = current!.value!.count > 32 ? 5 : 0; state.cursor = 0n;
      } else {
        const phase = name === "prepare_dynamic_revaluation" ? 5 : 6, maximum = phase === 5 ? current!.value!.count : fields.classes;
        if (bytes.length !== 12 || state.phase !== phase || BigInt(bytes.readUInt16LE(8)) !== state.cursor || bytes.readUInt16LE(10) < 1 || bytes.readUInt16LE(10) > 16 || state.cursor >= BigInt(maximum)) return deny("invalid dynamic revaluation phase or cursor");
        state.cursor = BigInt(Math.min(Number(state.cursor) + bytes.readUInt16LE(10), maximum)); if (state.cursor === BigInt(maximum)) { state.phase = phase === 5 ? 6 : 0; state.cursor = 0n; }
      }
      continue;
    }
    const state = await batch();
    if (bytes.length !== 8) return deny("unexpected dynamic crank args");
    if (name === "finalize") { optionalVault(keys, 8); bind(keys.slice(0, 8), [operator, registry, pool, batchKey, methodology, publication, vault, SystemProgram.programId]); if (state.phase !== 1) return deny("invalid dynamic finalization phase"); continue; }
    const fixed = name === "seal_evaluation" ? 4 : 6; optionalVault(keys, fixed);
    same(keys[0]!, registry, "crank registry"); same(keys[1]!, pool, "crank pool"); same(keys[2]!, batchKey, "crank batch"); same(keys[fixed - 1]!, vault, "crank vault");
    const phases: Record<string, number[]> = { evaluate: [0], safety: [3], execute: [1], seal_evaluation: [0, 3] }; if (!phases[name]?.includes(state.phase)) return deny("invalid dynamic crank phase");
    if (name === "seal_evaluation") { state.phase = 1; continue; }
    const request = await account(keys[3]!, "Request", 83); if (![1, 2, 3, 4].includes(request.readUInt16LE(8))) return deny("unsupported dynamic request schema");
    same(new PublicKey(request.subarray(11, 43)), pool, "request pool"); same(keys[3]!, pda(Buffer.from("request"), pool.toBuffer(), request.subarray(75, 83)), "request nonce PDA"); same(keys[4]!, pda(Buffer.from("position"), pool.toBuffer(), request.subarray(43, 75)), "request owner position");
  }
}
