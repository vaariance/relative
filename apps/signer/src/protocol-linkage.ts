import { checkDynamicCoxLinkage } from "./dynamic-linkage.js";
import { createHash } from "node:crypto";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import type { AdaptiveCoxLinkage, EpochLinkage, ProtocolLinkage, SolanaProgramBinding } from "./config.js";
import { checkCoxLinkage, type AccountFetcher } from "./cox-linkage.js";
import { PolicyRejection } from "./policy.js";
import type { PolicyTransaction } from "./solana.js";
import { checkEpochPreparation, EPOCH_PREPARATION_NAMES } from "./epoch-preparation.js";
const deny = (reason: string): never => { throw new PolicyRejection("TARGET_NOT_BOUND", reason); };
const disc = (kind: string, name: string): Buffer => createHash("sha256").update(`${kind}:${name}`).digest().subarray(0, 8);
const u64 = (value: bigint): Buffer => {
  if (value < 0n || value > 18446744073709551615n)
    return deny("invalid u64 binding");
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
};
const keyAt = (bytes: Buffer, offset: number): PublicKey => bytes.length >= offset + 32 ? new PublicKey(bytes.subarray(offset, offset + 32)) : deny("truncated account key");
const same = (actual: PublicKey, expected: PublicKey, label: string): void => {
  if (!actual.equals(expected))
    deny(`wrong ${label}`);
};
export async function checkProtocolLinkage(binding: SolanaProgramBinding, linkage: ProtocolLinkage, transaction: PolicyTransaction, fetch: AccountFetcher): Promise<void> {
  if (linkage.kind === "cox-dynamic-v1") return checkDynamicCoxLinkage(binding, linkage, transaction, fetch);
  if (linkage.kind === "cox-v2")
    return checkCoxLinkage(binding, linkage, transaction, fetch);
  if (linkage.kind !== "cox-adaptive-v1" && linkage.kind !== "epoch-v1")
    return deny("unknown protocol linkage");
  const program = new PublicKey(binding.programId);
  const relevant = transaction.message.compiledInstructions.filter(instruction => transaction.message.staticAccountKeys[instruction.programIdIndex]?.equals(program));
  if (relevant.length === 0)
    return;
  const operator = new PublicKey(linkage.operator);
  same(transaction.message.staticAccountKeys[0]!, operator, "operator fee payer");
  if (transaction.message.header.numRequiredSignatures !== 1)
    deny("protocol needs a sole operator signature");
  const pda = (...seeds: Buffer[]): PublicKey => PublicKey.findProgramAddressSync(seeds, program)[0];
  const cache = new Map<string, Buffer>();
  async function account(key: PublicKey, name: string, min: number): Promise<Buffer> {
    let bytes = cache.get(key.toBase58());
    if (!bytes) {
      const [value] = await fetch([key]);
      if (!value || !value.owner.equals(program))
        return deny(`wrong ${name} owner`);
      bytes = value.data;
      cache.set(key.toBase58(), bytes);
    }
    if (bytes.length < min || !bytes.subarray(0, 8).equals(disc("account", name)))
      deny(`invalid ${name} account schema`);
    return bytes;
  }
  const call = (instruction: typeof relevant[number]) => {
    const bytes = Buffer.from(instruction.data);
    const at = (index: number): PublicKey => transaction.message.staticAccountKeys[instruction.accountKeyIndexes[index]!] ?? deny("missing bound account");
    return { bytes, at, count: instruction.accountKeyIndexes.length };
  };
  if (linkage.kind === "cox-adaptive-v1") {
    const l: AdaptiveCoxLinkage = linkage;
    const pool = new PublicKey(l.pool);
    const registry = pda(Buffer.from("registry"));
    const methodology = new PublicKey(l.methodology);
    same(pool, pda(Buffer.from("pool"), u64(BigInt(l.poolId))), "Basic pool PDA");
    if (l.poolId === "1")
      deny("retired pool is forbidden");
    const roots = await account(pool, "Pool", 147);
    if (roots.readUInt16LE(8) !== 4 || roots.readBigUInt64LE(11) !== BigInt(l.poolId))
      deny("unsupported adaptive pool schema");
    same(keyAt(roots, 19), registry, "pool registry");
    same(keyAt(roots, 51), methodology, "pool methodology");
    const vault = pda(Buffer.from("vault"), pool.toBuffer());
    same(keyAt(roots, 115), vault, "pool vault");
    const registryData = await account(registry, "Registry", 75);
    if (registryData.readUInt16LE(8) !== 1)
      deny("unsupported registry schema");
    same(keyAt(registryData, 43), operator, "registry operator");
    const method = await account(methodology, "Methodology", 48);
    if (method.readUInt16LE(8) !== 2)
      deny("adaptive methodology schema 2 required");
    if (method.subarray(11, 43).toString("hex") !== l.methodologyDigest)
      deny("wrong methodology digest");
    same(methodology, pda(Buffer.from("methodology"), method.subarray(11, 43)), "methodology PDA");
    const canonicalLength = method.readUInt32LE(43);
    if (canonicalLength > 8192 || method.length <= 47 + canonicalLength || method[47 + canonicalLength] !== 1)
      deny("unsealed methodology");
    const canonical = method.subarray(47, 47 + canonicalLength);
    if (createHash("sha256").update(canonical).digest("hex") !== l.methodologyDigest)
      deny("methodology canonical digest mismatch");
    const domain = Buffer.from("COX/METHODOLOGY/ADAPTIVE/V1");
    if (canonical.length < 4 + domain.length || canonical.readUInt32LE(0) !== domain.length || !canonical.subarray(4, 4 + domain.length).equals(domain))
      deny("wrong adaptive methodology domain");
    const batch = pda(Buffer.from("batch"), pool.toBuffer());
    const publication = pda(Buffer.from("publication"), pool.toBuffer());
    const testVault = pda(Buffer.from("test-vault"), pool.toBuffer());
    if (l.testCollateralMint !== undefined) {
      const mint = new PublicKey(l.testCollateralMint);
      if (mint.equals(keyAt(roots, 83)))
        deny("test collateral must differ from primary collateral");
      const [value] = await fetch([testVault]);
      const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
      if (!value || !value.owner.equals(tokenProgram) || value.data.length !== 165)
        return deny("invalid test vault token owner or schema");
      const token = value.data;
      same(keyAt(token, 0), mint, "test vault mint");
      same(keyAt(token, 32), pool, "test vault authority");
      if (token.readUInt32LE(72) !== 0 || token[108] !== 1 || token.readUInt32LE(109) !== 0 || token.readUInt32LE(129) !== 0)
        deny("unsafe test vault token state");
    }
    const optionalVault = (at: (index: number) => PublicKey, count: number, fixed: number): void => {
      if (l.testCollateralMint !== undefined) {
        if (count !== fixed + 1)
          deny("missing test vault accounts");
        same(at(fixed), testVault, "test vault PDA");
      } else if (count === fixed + 1) {
        same(at(fixed), program, "absent test vault sentinel");
      } else if (count !== fixed) {
        deny("invalid optional vault accounts");
      }
    };
    const names = ["publish_adaptive", "evaluate", "safety", "execute", "seal_evaluation", "finalize"];
    for (const instruction of relevant) {
      const { bytes, at, count } = call(instruction);
      const name = names.find(value => bytes.subarray(0, 8).equals(disc("global", value)));
      if (!name)
        return deny("instruction is not adaptive runtime");
      if (name === "publish_adaptive") {
        optionalVault(at, count, 8);
        if (bytes.length < 116)
          deny("invalid publication accounts");
        const prices = bytes.readUInt32LE(56);
        if (prices < 1 || prices > 30 || bytes.length !== 116 + 20 * prices)
          deny("invalid adaptive publication payload");
        same(at(0), operator, "payer");
        same(at(1), operator, "operator");
        same(at(2), registry, "registry");
        same(at(3), pool, "pool");
        same(at(4), methodology, "methodology");
        same(at(5), batch, "batch");
        same(at(6), vault, "vault");
        same(at(7), SystemProgram.programId, "system program");
      }
      else if (name === "finalize") {
        optionalVault(at, count, 8);
        if (bytes.length !== 8)
          deny("invalid finalization");
        same(at(0), operator, "operator");
        same(at(1), registry, "registry");
        same(at(2), pool, "pool");
        same(at(3), batch, "batch");
        same(at(4), methodology, "methodology");
        same(at(5), publication, "publication");
        same(at(6), vault, "vault");
        same(at(7), SystemProgram.programId, "system program");
      }
      else {
        const fixed = name === "seal_evaluation" ? 4 : 6;
        optionalVault(at, count, fixed);
        if (bytes.length !== 8)
          deny("invalid Basic crank");
        same(at(0), registry, "registry");
        same(at(1), pool, "pool");
        same(at(2), batch, "batch");
        same(at(fixed - 1), vault, "vault");
        if (name !== "seal_evaluation") {
          const request = await account(at(3), "Request", 83);
          if (request.readUInt16LE(8) !== 4)
            deny("unsupported adaptive request schema");
          same(keyAt(request, 11), pool, "request pool");
          same(at(3), pda(Buffer.from("request"), pool.toBuffer(), u64(request.readBigUInt64LE(75))), "request nonce PDA");
          same(at(4), pda(Buffer.from("position"), pool.toBuffer(), request.subarray(43, 75)), "request owner position");
        }
      }
    }
    return;
  }
  const l: EpochLinkage = linkage;
  const config = new PublicKey(l.config);
  const admin = new PublicKey(l.admin);
  same(config, pda(Buffer.from("config"), admin.toBuffer(), u64(BigInt(l.configId))), "Epoch config PDA");
  const root = await account(config, "PoolConfig", 113);
  same(keyAt(root, 8), admin, "config admin");
  if (root.readBigUInt64LE(40) !== BigInt(l.configId))
    deny("wrong config id");
  same(keyAt(root, 48), operator, "config operator");
  if (root[112] !== 0 && root[112] !== 1)
    deny("unsupported config schema");
  const methodOffset = root[112] === 1 ? 145 : 113;
  if (root.length < methodOffset + 32 || root.subarray(methodOffset, methodOffset + 32).toString("hex") !== l.methodologyDigest)
    deny("wrong Epoch methodology");
  const lifecycleMarked = root.subarray(methodOffset + 61, methodOffset + 69).equals(Buffer.from("RLCFG001"));
  if (lifecycleMarked && root.length < methodOffset + 103) deny("truncated Epoch lifecycle extension");
  const lifecycleVersion = lifecycleMarked ? root[methodOffset + 69]! : 0;
  const lifecycle = lifecycleVersion === 0 ? 1 : root[methodOffset + 70]!;
  if (lifecycleVersion > 1 || lifecycle > 2) deny("unsupported Epoch lifecycle extension");
  interface StagedSnapshot { sequence: bigint; timestamp: bigint; benchmark: bigint; expected: number; prices: Buffer[]; sealed: boolean; allocated: number }
  const stagedSnapshots = new Map<string, StagedSnapshot>(), closedSnapshots = new Set<string>();
  const now = () => BigInt(Math.floor(Date.now() / 1000));
  const uint128 = (value: Buffer, offset: number) => value.readBigUInt64LE(offset) + (value.readBigUInt64LE(offset + 8) << 64n);
  const maxReference = 1000000000000000000000000n;
  async function stagedSnapshot(key: PublicKey): Promise<StagedSnapshot> {
    if (closedSnapshots.has(key.toBase58())) return deny("snapshot was already closed");
    const cached = stagedSnapshots.get(key.toBase58()); if (cached) return cached;
    const bytes = await account(key, "SnapshotAccount", 144);
    same(keyAt(bytes, 8), config, "staged snapshot config");
    const sequence = bytes.readBigUInt64LE(40), timestamp = bytes.readBigUInt64LE(48), benchmark = uint128(bytes, 56), expected = bytes.readUInt16LE(72), count = bytes.readUInt32LE(106);
    same(key, pda(Buffer.from("snapshot"), config.toBuffer(), u64(sequence)), "staged snapshot sequence PDA");
    if (sequence !== timestamp || timestamp > now() || benchmark === 0n || benchmark > maxReference || expected < 1 || expected > 255 || count > expected || bytes.length < 144 + count * 50 || bytes[110 + count * 50]! > 1 || bytes.subarray(74, 106).toString("hex") !== l.methodologyDigest) return deny("invalid staged snapshot metadata or source");
    const value = { sequence, timestamp, benchmark, expected, prices: Array.from({ length: count }, (_, index) => bytes.subarray(110 + index * 50, 160 + index * 50)), sealed: bytes[110 + count * 50] === 1, allocated: bytes.length };
    stagedSnapshots.set(key.toBase58(), value); return value;
  }
  function appendSnapshotPrices(value: StagedSnapshot, prices: Buffer[]): void {
    const combined = [...value.prices];
    for (const price of prices) {
      const id = price.readUInt16LE(0), feed = price.subarray(2, 34), amount = uint128(price, 34);
      if (id > 255 || feed.every(byte => byte === 0) || amount === 0n || amount > maxReference || combined.length && combined[combined.length - 1]!.readUInt16LE(0) >= id || combined.some(previous => previous.subarray(2, 34).equals(feed))) return deny("invalid staged snapshot price identity or order");
      combined.push(price);
    }
    value.prices = combined;
  }
  const names = ["publish_snapshot", "initialize_snapshot", "grow_snapshot", "append_prices", "seal_snapshot", "close_snapshot", "execute", "begin_close", "score", "allocate", "refund", "finalize_scores", "void_epoch", "finalize_empty", ...EPOCH_PREPARATION_NAMES];
  for (const [instructionIndex, instruction] of relevant.entries()) {
    const { bytes, at, count } = call(instruction);
    const name = names.find(value => bytes.subarray(0, 8).equals(disc("global", value)));
    if (!name)
      return deny("instruction is not Epoch runtime");
    if (EPOCH_PREPARATION_NAMES.includes(name)) {
      await checkEpochPreparation(program, l, name, bytes, Array.from({ length: count }, (_, index) => at(index)), root, fetch);
      continue;
    }
    if (lifecycle !== 1 && !["refund", "close_snapshot", "finalize_empty"].includes(name)) deny("Epoch configuration is not active");
    if (name === "finalize_empty") {
      if (bytes.length !== 8 || count !== 4) return deny("invalid empty Epoch finalization");
      same(at(0), config, "empty Epoch config");
      const epoch = await account(at(1), "EpochAccount", 113), opens = epoch.readBigUInt64LE(40);
      same(keyAt(epoch, 8), config, "empty Epoch account config");
      same(at(1), pda(Buffer.from("epoch"), config.toBuffer(), u64(opens)), "empty Epoch PDA");
      same(at(2), pda(Buffer.from("vault"), at(1).toBuffer()), "empty Epoch vault");
      same(at(3), pda(Buffer.from("test-vault"), at(1).toBuffer()), "empty Epoch test vault");
      if (opens % 14400n !== 0n || opens + 14400n > now()) return deny("empty Epoch has not closed");
      continue;
    }
    if (["initialize_snapshot", "grow_snapshot", "append_prices", "seal_snapshot"].includes(name)) {
      if (l.allowStagedSnapshots !== true || count !== 4) return deny("staged Epoch snapshots are not enabled or accounts mismatch");
      same(at(0), operator, "staged snapshot operator"); same(at(1), config, "staged snapshot config"); same(at(3), SystemProgram.programId, "staged snapshot system program");
      const key = at(2);
      if (name === "initialize_snapshot") {
        if (bytes.length !== 42) return deny("invalid staged snapshot initialization payload");
        const sequence = bytes.readBigUInt64LE(8), timestamp = bytes.readBigUInt64LE(16), benchmark = uint128(bytes, 24), expected = bytes.readUInt16LE(40);
        same(key, pda(Buffer.from("snapshot"), config.toBuffer(), u64(sequence)), "staged snapshot sequence PDA");
        if (sequence !== timestamp || timestamp > now() || benchmark === 0n || benchmark > maxReference || expected < 1 || expected > 255 || stagedSnapshots.has(key.toBase58())) return deny("invalid staged snapshot initialization");
        stagedSnapshots.set(key.toBase58(), { sequence, timestamp, benchmark, expected, prices: [], sealed: false, allocated: 2048 });
      } else {
        const value = await stagedSnapshot(key); if (value.sealed) return deny("sealed snapshot is immutable");
        if (name === "grow_snapshot") {
          if (bytes.length !== 12) return deny("invalid staged snapshot growth payload");
          const growth = bytes.readUInt32LE(8);
          if (growth < 1 || growth > 8192 || value.allocated + growth > Math.min(14000, 144 + 50 * value.expected)) return deny("staged snapshot growth exceeds bound");
          value.allocated += growth;
        } else if (name === "append_prices") {
          const prices = bytes.length >= 12 ? bytes.readUInt32LE(8) : 0;
          if (prices < 1 || prices > 8 || bytes.length !== 12 + prices * 50 || value.prices.length + prices > value.expected || 144 + 50 * (value.prices.length + prices) > value.allocated) return deny("invalid staged snapshot price page or capacity");
          appendSnapshotPrices(value, Array.from({ length: prices }, (_, index) => bytes.subarray(12 + 50 * index, 62 + 50 * index)));
        } else {
          if (bytes.length !== 8 || value.prices.length !== value.expected) return deny("incomplete staged snapshot seal"); value.sealed = true;
        }
      }
      continue;
    }
    if (name === "publish_snapshot") {
      if (count !== 4 || bytes.length < 44)
        deny("invalid snapshot instruction");
      const prices = bytes.readUInt32LE(40);
      if (prices < 1 || prices > 30 || bytes.length !== 44 + 50 * prices)
        deny("invalid snapshot payload");
      same(at(0), operator, "snapshot operator");
      same(at(1), config, "snapshot config");
      same(at(2), pda(Buffer.from("snapshot"), config.toBuffer(), bytes.subarray(8, 16)), "snapshot sequence PDA");
      same(at(3), SystemProgram.programId, "system program");
      if (l.allowStagedSnapshots === true) {
        const sequence = bytes.readBigUInt64LE(8), timestamp = bytes.readBigUInt64LE(16), benchmark = uint128(bytes, 24);
        if (sequence !== timestamp || timestamp > now() || benchmark === 0n || benchmark > maxReference) return deny("invalid atomic Epoch snapshot identity");
        const value: StagedSnapshot = { sequence, timestamp, benchmark, expected: prices, prices: [], sealed: true, allocated: 144 + prices * 50 };
        appendSnapshotPrices(value, Array.from({ length: prices }, (_, index) => bytes.subarray(44 + 50 * index, 94 + 50 * index)));
        stagedSnapshots.set(at(2).toBase58(), value);
      }
      continue;
    }
    if (bytes.length !== 8)
      deny("unexpected Epoch runtime args");
    if (name === "close_snapshot") {
      if (count !== 3)
        deny("invalid snapshot close accounts");
      same(at(0), operator, "snapshot rent recipient");
      same(at(1), config, "snapshot close config");
      if (l.allowStagedSnapshots === true) {
        const value = await stagedSnapshot(at(2));
        if (!value.sealed && value.timestamp + 60n > now()) return deny("unsealed snapshot cleanup requires a stale entry timestamp");
      } else await snapshot(at(2), instructionIndex);
      closedSnapshots.add(at(2).toBase58());
      continue;
    }
    const signed = name === "execute" || name === "begin_close";
    const shift = signed ? 1 : 0;
    const lot = name === "execute" || ["score", "allocate", "refund"].includes(name);
    if (count !== (name === "execute" ? 7 : name === "begin_close" ? 6 : lot ? 5 : 4))
      deny("invalid Epoch runtime accounts");
    if (signed)
      same(at(0), operator, "Epoch operator");
    same(at(shift), config, "Epoch config");
    const epochKey = at(shift + 1);
    const epoch = await account(epochKey, "EpochAccount", 121);
    same(keyAt(epoch, 8), config, "epoch config");
    const opens = epoch.readBigUInt64LE(40);
    const draftCount = epoch.readUInt32LE(113);
    if (draftCount > 256)
      deny("invalid epoch universe");
    const stateAt = 118 + 50 * draftCount;
    if (epoch.length < stateAt + 197 || epoch[stateAt - 1] !== 1)
      deny("unsealed epoch state");
    same(keyAt(epoch, stateAt), config, "epoch state pool");
    same(keyAt(epoch, stateAt + 32), admin, "epoch state admin");
    same(keyAt(epoch, stateAt + 64), operator, "epoch state operator");
    if (epoch.subarray(stateAt + 129, stateAt + 161).toString("hex") !== l.methodologyDigest || epoch.readBigUInt64LE(stateAt + 189) !== opens)
      deny("epoch state methodology or opening mismatch");
    if (opens % 14400n !== 0n)
      deny("invalid epoch opening");
    same(epochKey, pda(Buffer.from("epoch"), config.toBuffer(), u64(opens)), "epoch PDA");
    const vault = pda(Buffer.from("vault"), epochKey.toBuffer());
    const testVault = pda(Buffer.from("test-vault"), epochKey.toBuffer());
    same(keyAt(epoch, 48), vault, "epoch vault");
    same(keyAt(epoch, 80), testVault, "epoch test vault");
    const vaultIndex = shift + (lot ? 3 : 2);
    same(at(vaultIndex), vault, "vault");
    same(at(vaultIndex + 1), testVault, "test vault");
    if (lot) {
      const value = await account(at(shift + 2), "LotAccount", 130);
      same(keyAt(value, 8), epochKey, "lot epoch");
      const nonce = value.readBigUInt64LE(40);
      same(at(shift + 2), pda(Buffer.from("lot"), epochKey.toBuffer(), u64(nonce)), "lot nonce PDA");
      if (value[49] !== 1)
        deny("uninitialized lot");
      same(keyAt(value, 50), config, "lot state pool");
      if (value.readBigUInt64LE(82) !== opens || value.readBigUInt64LE(90) !== nonce)
        deny("lot state identity mismatch");
      if (keyAt(value, 98).equals(SystemProgram.programId))
        deny("invalid lot owner");
    }
    if (signed)
      await snapshot(at(count - 1), instructionIndex);
  }
  async function snapshot(snapshotKey: PublicKey, instructionIndex: number): Promise<void> {
    if (closedSnapshots.has(snapshotKey.toBase58())) return deny("snapshot was already closed");
    const staged = stagedSnapshots.get(snapshotKey.toBase58());
    if (staged) { if (!staged.sealed) return deny("snapshot methodology or seal mismatch"); return; }
    const produced = relevant.slice(0, instructionIndex).some(candidate => Buffer.from(candidate.data).subarray(0, 8).equals(disc("global", "publish_snapshot")) && transaction.message.staticAccountKeys[candidate.accountKeyIndexes[2]!]?.equals(snapshotKey));
    if (produced)
      return;
    const data = await account(snapshotKey, "SnapshotAccount", 110);
    same(keyAt(data, 8), config, "snapshot config");
    same(snapshotKey, pda(Buffer.from("snapshot"), config.toBuffer(), data.subarray(40, 48)), "snapshot PDA");
    const prices = data.readUInt32LE(106);
    if (prices < 1 || prices > 256 || data.length <= 110 + 50 * prices || data[110 + 50 * prices] !== 1 || data.subarray(74, 106).toString("hex") !== l.methodologyDigest)
      deny("snapshot methodology or seal mismatch");
  }
}
