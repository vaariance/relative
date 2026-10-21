import { readFileSync } from "node:fs";
import { SIGNING_ROLES, type Environment, type KeyDirectoryEntry, type SigningRole } from "@eox/signing";
import { assertKeyVersion } from "./kms.js";

export interface SolanaInstructionRule {
  discriminator: string;
  accounts: Record<string, string>;
  v1WritableAccounts?: number[];
}

export interface CoxLinkage {
  kind: "cox-v2";
  poolId: string;
  pool: string;
  methodology: string | null;
}

export interface AdaptiveCoxLinkage {
  kind: "cox-adaptive-v1";
  testCollateralMint?: string;
  poolId: string;
  pool: string;
  methodology: string;
  methodologyDigest: string;
  operator: string;
}

export interface EpochLinkage {
  kind: "epoch-v1";
  configId: string;
  config: string;
  admin: string;
  operator: string;
  methodologyDigest: string;
}

export type ProtocolLinkage = CoxLinkage | AdaptiveCoxLinkage | EpochLinkage;

export interface SolanaProgramBinding {
  programId: string;
  enabled?: boolean;
  allowTransactionV1?: boolean;
  discriminators: string[];
  instructions?: SolanaInstructionRule[];
  linkage?: ProtocolLinkage;
}

export const SIGNER_ACCOUNT = "$signer";

export interface RoleBindings {
  solana?: { maxComputeUnitPriceMicroLamports: string; maxComputeUnitLimit?: string; maxHeapBytes?: number; programs: SolanaProgramBinding[] };
}

export interface RoleKey {
  keyVersion: string;
  network: string;
  validFrom: number;
}

export interface SignerConfig {
  environment: Environment;
  audience: string;
  keys: Record<SigningRole, RoleKey>;
  callers: Record<string, SigningRole[]>;
  bindings: Partial<Record<SigningRole, RoleBindings>>;
  directoryVersion: number;
  retired: KeyDirectoryEntry[];
}

const EMAIL_PATTERN = /^[a-z0-9-]{6,30}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HEX_PATTERN = /^[0-9a-f]{2,64}$/;
const INTEGER_PATTERN = /^(0|[1-9][0-9]{0,30})$/;

function fail(message: string): never {
  throw new Error(`invalid signer config: ${message}`);
}

export function loadSignerConfig(path: string): SignerConfig {
  const config = JSON.parse(readFileSync(path, "utf8")) as SignerConfig;
  if (!["dev", "testnet", "mainnet"].includes(config.environment)) fail("environment");
  if (typeof config.audience !== "string") fail("audience");
  for (const role of SIGNING_ROLES) {
    const key = config.keys?.[role];
    if (!key) fail(`missing key for ${role}`);
    assertKeyVersion(key.keyVersion);
    if (!key.network.startsWith("solana:")) fail(`${role} network ${key.network} is not a Solana network`);
  }
  if (!Number.isSafeInteger(config.directoryVersion) || config.directoryVersion < 1) fail("directoryVersion");
  for (const entry of config.retired ?? []) {
    if ((SIGNING_ROLES as readonly string[]).includes(entry.role)) fail(`retired entry ${entry.role} is still a signing role`);
    if (entry.state !== "retired" || !Number.isSafeInteger(entry.validUntil) || entry.validUntil! < entry.validFrom) fail(`retired entry ${entry.role}`);
    assertKeyVersion(entry.keyVersion);
    if (entry.environment !== config.environment) fail(`retired entry ${entry.role} environment`);
  }
  for (const [email, roles] of Object.entries(config.callers ?? {})) {
    if (!EMAIL_PATTERN.test(email)) fail(`caller ${email} is not a service account`);
    for (const role of roles) if (!SIGNING_ROLES.includes(role)) fail(`caller ${email} has unknown role ${role}`);
  }
  for (const [role, bindings] of Object.entries(config.bindings ?? {})) {
    if (!SIGNING_ROLES.includes(role as SigningRole)) fail(`bindings for unknown role ${role}`);
    if (Object.keys(bindings ?? {}).some((k) => k !== "solana")) fail(`${role} may bind only Solana programs`);
    if (bindings?.solana) {
      if (!INTEGER_PATTERN.test(bindings.solana.maxComputeUnitPriceMicroLamports)) fail(`${role} compute price limit`);
      const unitLimit = bindings.solana.maxComputeUnitLimit;
      if (unitLimit !== undefined && (!INTEGER_PATTERN.test(unitLimit) || Number(unitLimit) > 1_400_000)) fail(`${role} compute unit limit`);
      if (bindings.solana.maxHeapBytes !== undefined && (!Number.isSafeInteger(bindings.solana.maxHeapBytes) || bindings.solana.maxHeapBytes < 32768 || bindings.solana.maxHeapBytes > 262144 || bindings.solana.maxHeapBytes % 1024 !== 0)) fail(`${role} heap limit`);
      for (const program of bindings.solana.programs) {
        if (program.allowTransactionV1 !== undefined && typeof program.allowTransactionV1 !== "boolean") fail(`${role} V1 flag`);
        if (!BASE58_PATTERN.test(program.programId)) fail(`${role} program ${program.programId}`);
        if (program.enabled !== undefined && typeof program.enabled !== "boolean") fail(`${role} program enabled flag`);
        if (program.linkage) {
          const l = program.linkage;
          if (l.kind === "cox-v2" || l.kind === "cox-adaptive-v1") {
            if (!INTEGER_PATTERN.test(l.poolId) || !BASE58_PATTERN.test(l.pool)) fail(`${role} COX linkage`);
            if (l.methodology !== null && !BASE58_PATTERN.test(l.methodology)) fail(`${role} COX methodology`);
            if (l.kind === "cox-adaptive-v1" && ((BigInt(l.poolId) > 18446744073709551615n || l.poolId === "1") || typeof l.methodology !== "string" || !BASE58_PATTERN.test(l.operator) || !/^[0-9a-f]{64}$/.test(l.methodologyDigest))) fail(`${role} adaptive linkage`);
            if (l.kind === "cox-adaptive-v1" && l.testCollateralMint !== undefined && !BASE58_PATTERN.test(l.testCollateralMint)) fail(`${role} adaptive test collateral mint`);
          } else if (l.kind === "epoch-v1") {
            if (!INTEGER_PATTERN.test(l.configId) || BigInt(l.configId) > 18446744073709551615n || ![l.config,l.admin,l.operator].every(value => BASE58_PATTERN.test(value)) || !/^[0-9a-f]{64}$/.test(l.methodologyDigest)) fail(`${role} Epoch linkage`);
          } else fail(`${role} unknown protocol linkage`);
        }
        for (const discriminator of program.discriminators) if (!HEX_PATTERN.test(discriminator)) fail(`${role} discriminator`);
        if (program.allowTransactionV1 === true && (!program.instructions || program.instructions.some(rule => !rule.v1WritableAccounts))) fail(`${role} V1 requires explicit writable account rules`);
        if (program.instructions) {
          for (const discriminator of program.discriminators) {
            if (!program.instructions.some((rule) => rule.discriminator === discriminator)) fail(`${role} discriminator ${discriminator} has no account rule`);
          }
          for (const rule of program.instructions) {
            if (rule.v1WritableAccounts !== undefined && (!Array.isArray(rule.v1WritableAccounts) || new Set(rule.v1WritableAccounts).size !== rule.v1WritableAccounts.length || rule.v1WritableAccounts.some(index => !Number.isSafeInteger(index) || index < 0 || index > 255))) fail(`${role} V1 writable account rule`);
            if (!program.discriminators.includes(rule.discriminator)) fail(`${role} account rule for unlisted discriminator ${rule.discriminator}`);
            for (const [index, account] of Object.entries(rule.accounts)) {
              if (!/^(0|[1-9][0-9]?)$/.test(index)) fail(`${role} account index ${index}`);
              if (account !== SIGNER_ACCOUNT && !BASE58_PATTERN.test(account)) fail(`${role} account ${account}`);
            }
          }
        }
      }
    }
  }
  return config;
}
