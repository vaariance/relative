import { createHash } from "node:crypto";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import type { EpochLinkage } from "./config.js";
import type { AccountFetcher } from "./cox-linkage.js";
import { universe } from "./dynamic-linkage.js";
import { PolicyRejection } from "./policy-errors.js";

const deny = (reason: string): never => { throw new PolicyRejection("TARGET_NOT_BOUND", reason); };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest();
const keyAt = (bytes: Buffer, offset: number) => bytes.length >= offset + 32 ? new PublicKey(bytes.subarray(offset, offset + 32)) : deny("truncated registry preparation account");
const same = (actual: PublicKey, expected: PublicKey) => { if (!actual.equals(expected)) deny("wrong registry preparation binding"); };
export const EPOCH_PREPARATION_NAMES = ["initialize_current_epoch", "grow_current_epoch", "copy_registry_assets", "seal_current_epoch"];

export async function checkEpochPreparation(program: PublicKey, linkage: EpochLinkage, name: string, bytes: Buffer, keys: PublicKey[], root: Buffer, fetch: AccountFetcher): Promise<void> {
  if (!linkage.registry) return deny("Epoch registry preparation is not enabled");
  const basic = new PublicKey(linkage.registry.programId), registryKey = new PublicKey(linkage.registry.assetRegistry);
  const generation = Buffer.from(linkage.registry.generation, "hex");
  const pda = (owner: PublicKey, ...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, owner)[0];
  async function account(key: PublicKey, owner: PublicKey, type: string, minimum: number): Promise<Buffer> {
    const [value] = await fetch([key]);
    if (!value || !value.owner.equals(owner) || value.data.length < minimum || !value.data.subarray(0, 8).equals(hash(Buffer.from(`account:${type}`)).subarray(0, 8))) return deny("invalid registry preparation account owner or schema");
    return value.data;
  }
  const initializing = name === "initialize_current_epoch";
  if (keys.length !== (initializing ? 12 : 7)) return deny("invalid registry preparation accounts");
  same(keys[0]!, new PublicKey(linkage.operator)); same(keys[1]!, new PublicKey(linkage.config)); same(keys[2]!, registryKey);
  same(registryKey, pda(basic, Buffer.from("asset-registry"), generation));
  same(keys[keys.length - 1]!, SystemProgram.programId);
  const methodOffset = root[112] === 1 ? 145 : 113;
  if (root.length < methodOffset + 95 || root[methodOffset + 61] !== 1 || root[methodOffset + 62]! > 1) return deny("Epoch config is not available for preparation");
  same(keyAt(root, methodOffset + 63), registryKey);
  const registry = await account(registryKey, basic, "AssetRegistry", 187);
  const version = await account(keys[3]!, basic, "AssetRegistryVersion", 188);
  const method = await account(keys[4]!, basic, "Methodology", 48);
  if (registry.readUInt16LE(8) !== 1 || version.readUInt16LE(8) !== 1 || !registry.subarray(11, 43).equals(generation) || !version.subarray(43, 75).equals(generation) || version[187] !== 1) return deny("wrong registry generation or unsealed version");
  same(keyAt(version, 11), registryKey); same(keyAt(version, 75), keys[4]!);
  const digest = version.subarray(107, 139);
  same(keys[3]!, pda(basic, Buffer.from("asset-version"), registryKey.toBuffer(), digest));
  same(keys[4]!, pda(basic, Buffer.from("methodology"), digest));
  const length = method.readUInt32LE(43);
  if (length > 131072 || method.length < 48 + length || method.readUInt16LE(8) !== 3 || method[47 + length] !== 1 || !method.subarray(11, 43).equals(digest)) return deny("invalid registry canonical methodology");
  const canonical = method.subarray(47, 47 + length);
  if (!hash(canonical).equals(digest)) return deny("registry canonical hash mismatch");
  const manifest = universe(canonical);
  same(manifest.pool, keyAt(registry, 75));
  if (manifest.source.toString("hex") !== linkage.methodologyDigest || !manifest.operator.equals(new PublicKey(linkage.operator))) return deny("registry source or operator mismatch");
  const epochKey = keys[initializing ? 7 : 5]!;
  let opening: bigint, draftCount = 0, allocated = 2048;
  if (initializing) {
    if (bytes.length !== 16) return deny("invalid current Epoch initialization payload");
    opening = bytes.readBigUInt64LE(8);
    same(keys[5]!, keyAt(root, 80));
    same(keys[6]!, root[112] === 1 ? keyAt(root, 113) : keyAt(root, 80));
    same(keys[8]!, pda(program, Buffer.from("vault"), epochKey.toBuffer()));
    same(keys[9]!, pda(program, Buffer.from("test-vault"), epochKey.toBuffer()));
    same(keys[10]!, new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
  } else {
    const epoch = await account(epochKey, program, "EpochAccount", 152);
    same(keyAt(epoch, 8), new PublicKey(linkage.config));
    opening = epoch.readBigUInt64LE(40); draftCount = epoch.readUInt32LE(113); allocated = epoch.length;
    const stateTag = 117 + 50 * draftCount;
    if (draftCount > manifest.count || epoch.length < stateTag + 34 || epoch[stateTag] !== 0 || epoch[stateTag + 1] !== 1) return deny("Epoch is not a registry-bound draft");
    same(keyAt(epoch, stateTag + 2), keys[3]!);
    if (name === "grow_current_epoch") {
      if (bytes.length !== 12 || bytes.readUInt32LE(8) < 1 || bytes.readUInt32LE(8) > 8192 || allocated + bytes.readUInt32LE(8) > 64000) return deny("invalid current Epoch growth");
    } else if (name === "copy_registry_assets") {
      if (bytes.length !== 12 || bytes.readUInt16LE(8) !== draftCount || bytes.readUInt16LE(10) < 1 || bytes.readUInt16LE(10) > 8 || draftCount + bytes.readUInt16LE(10) > manifest.count) return deny("invalid canonical Epoch page");
    } else if (bytes.length !== 8 || draftCount !== manifest.count || allocated < 64000) return deny("incomplete current Epoch seal");
  }
  const now = BigInt(Math.floor(Date.now() / 1000)), openingBytes = Buffer.alloc(8); openingBytes.writeBigUInt64LE(opening);
  same(epochKey, pda(program, Buffer.from("epoch"), new PublicKey(linkage.config).toBuffer(), openingBytes));
  if (opening !== now / 14400n * 14400n || version.readBigUInt64LE(171) > opening || version.readBigUInt64LE(179) !== 0n && opening >= version.readBigUInt64LE(179)
    || registry.readBigUInt64LE(179) !== 0n && opening >= registry.readBigUInt64LE(179)) return deny("wrong opening registry interval or pending activation");
  if (version.readBigUInt64LE(179) === 0n) same(keyAt(registry, 107), keys[3]!);
}
