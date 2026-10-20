import { Buffer } from "buffer";
import type { Program } from "@coral-xyz/anchor";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import type { Accounts, Class, Position, Request } from "./accounts.ts";
import { addresses } from "./pdas.ts";
import { committedPosition, committedRequest, decodeAccount } from "./readers.ts";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const number = (value: { toString(): string }): bigint => BigInt(value.toString());
export interface RetirementAuditOptions { readonly poolId: bigint; readonly maxRequests?: number; readonly batchSize?: number }
export interface RetirementOwnerPreview {
  readonly owner: PublicKey;
  readonly position: PublicKey;
  readonly existingPayable: bigint;
  readonly existingRefundable: bigint;
  readonly pendingDepositPrincipal: bigint;
  readonly positionRetirementPayable: bigint;
  readonly totalCollateralClaim: bigint;
}
export interface RetirementAuditReport {
  readonly pool: PublicKey;
  readonly finalizedSlot: number;
  readonly sequence: bigint;
  readonly stateDigest: Uint8Array;
  readonly requestCount: number;
  readonly queuedRequestCount: number;
  readonly positionCount: number;
  readonly flags: { readonly paused: boolean; readonly retired: boolean; readonly initialized: boolean; readonly requiresMigration: boolean; readonly ready: boolean };
  readonly totals: {
    readonly active: bigint; readonly pending: bigint; readonly payable: bigint; readonly refundable: bigint;
    readonly fees: bigint; readonly residual: bigint; readonly vault: bigint; readonly vaultSurplus: bigint;
    readonly positionRetirementPayable: bigint; readonly retirementRoundingResidual: bigint;
    readonly projectedResidual: bigint; readonly classUnits: readonly bigint[]; readonly lockedUnits: readonly bigint[];
  };
  readonly owners: readonly RetirementOwnerPreview[];
}

export async function auditRetirement(program: Program, options: RetirementAuditOptions): Promise<RetirementAuditReport> {
  const maxRequests = options.maxRequests ?? 10_000;
  const batchSize = options.batchSize ?? 100;
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 0 || maxRequests > 10_000
    || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error("InvalidRetirementAuditBounds");
  const connection = program.provider.connection;
  const pdas = addresses(program.programId);
  const poolKey = pdas.pool(options.poolId);
  const registryKey = pdas.registry();
  const vaultKey = pdas.vault(poolKey);
  const initial = await connection.getMultipleAccountsInfoAndContext([poolKey, registryKey, vaultKey], { commitment: "finalized" });
  let minContextSlot = initial.context.slot;
  if (!Number.isSafeInteger(minContextSlot) || minContextSlot < 0 || initial.value.length !== 3) throw new Error("RetirementAuditInconsistentRead");
  const required = (info: AccountInfo<Buffer> | null | undefined): AccountInfo<Buffer> => {
    if (!info) throw new Error("RetirementAuditAccountMissing");
    return info;
  };
  const checked = <K extends keyof Accounts>(name: K, key: PublicKey, info: AccountInfo<Buffer> | null | undefined, seeds: readonly Uint8Array[]): Accounts[K] => {
    const value = decodeAccount(program, name, required(info));
    let expected: PublicKey;
    try { expected = PublicKey.createProgramAddressSync([...seeds, Uint8Array.of(value.bump)], program.programId); }
    catch { throw new Error("RetirementAuditPdaMismatch"); }
    if (!expected.equals(key)) throw new Error("RetirementAuditPdaMismatch");
    return value;
  };
  const initialPool = required(initial.value[0]);
  const poolBytes = Buffer.from(initialPool.data);
  const registryBytes = Buffer.from(required(initial.value[1]).data);
  const vaultBytes = Buffer.from(required(initial.value[2]).data);
  const pool = checked("pool", poolKey, initialPool, [Buffer.from("pool"), poolBytesForId(options.poolId)]);
  const registry = checked("registry", registryKey, initial.value[1], [Buffer.from("registry")]);
  if (number(pool.poolId) !== options.poolId || !pool.registry.equals(registryKey) || !pool.vault.equals(vaultKey)
    || pool.classes.length < 3 || pool.classes.length > 31 || pool.references.length !== pool.classes.length) throw new Error("RetirementAuditPoolMismatch");
  if (pool.classes.some((value) => number(value.units) === 0n && number(value.backing) !== 0n)) throw new Error("RetirementAuditLedgerMismatch");
  if (pool.stage) throw new Error("RetirementAuditBatchBusy");
  const nonceEnd = number(pool.nextRequestNonce);
  if (nonceEnd < 0n || nonceEnd > BigInt(maxRequests)) throw new Error("RetirementAuditRequestLimit");
  const readMany = async (keys: readonly PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> => {
    const infos: (AccountInfo<Buffer> | null)[] = [];
    for (let index = 0; index < keys.length; index += batchSize) {
      const response = await connection.getMultipleAccountsInfoAndContext(keys.slice(index, index + batchSize), { commitment: "finalized", minContextSlot });
      if (response.context.slot < minContextSlot || response.value.length !== Math.min(batchSize, keys.length - index)) throw new Error("RetirementAuditInconsistentRead");
      minContextSlot = response.context.slot;
      infos.push(...response.value);
    }
    return infos;
  };
  const requestKeys = Array.from({ length: Number(nonceEnd) }, (_, index) => pdas.request(poolKey, BigInt(index)));
  const requestInfos = await readMany(requestKeys);
  const requests: Request[] = requestInfos.map((info, index) => {
    const request = checked("request", requestKeys[index]!, info, [Buffer.from("request"), poolKey.toBytes(), poolBytesForId(BigInt(index))]);
    if (!request.pool.equals(poolKey) || number(request.nonce) !== BigInt(index) || !Number.isInteger(request.status)
      || request.status < 0 || request.status > 7 || request.operation < 0 || request.operation > 2
      || (request.applied && number(request.boundSequence) > number(pool.sequence))) throw new Error("RetirementAuditRequestMismatch");
    return committedRequest(request, pool);
  });
  const ownerKeys = [...new Map(requests.map((request) => [request.owner.toBase58(), request.owner])).values()];
  const positionKeys = ownerKeys.map((owner) => pdas.position(poolKey, owner));
  const positionInfos = await readMany(positionKeys);
  const positions: Position[] = positionInfos.map((info, index) => {
    const position = checked("position", positionKeys[index]!, info, [Buffer.from("position"), poolKey.toBytes(), ownerKeys[index]!.toBytes()]);
    if (!position.pool.equals(poolKey) || !position.owner.equals(ownerKeys[index]!) || position.classes.length !== pool.classes.length
      || (position.staged && number(position.stagedSequence) > number(pool.sequence))) throw new Error("RetirementAuditPositionMismatch");
    return committedPosition(position, pool);
  });
  let fixed: readonly Class[] = pool.classes;
  if (pool.schemaVersion === 3) {
    const key = pdas.retirement(poolKey);
    const [info] = await readMany([key]);
    const retirement = checked("retirement", key, info, [Buffer.from("retirement"), poolKey.toBytes()]);
    if (!retirement.pool.equals(poolKey) || number(retirement.sequence) !== number(pool.sequence)
      || !Buffer.from(retirement.stateDigest).equals(Buffer.from(pool.stateDigest)) || retirement.classes.length !== pool.classes.length) throw new Error("RetirementAuditSnapshotMismatch");
    fixed = retirement.classes;
  }
  const classUnits = pool.classes.map(() => 0n);
  const lockedUnits = pool.classes.map(() => 0n);
  const expectedLocked = pool.classes.map(() => 0n);
  const pendingByOwner = new Map<string, bigint>();
  const refundableByOwner = new Map<string, bigint>();
  let pending = 0n;
  let queuedRequestCount = 0;
  for (const request of requests) {
    if (request.status === 0) queuedRequestCount++;
    const owner = request.owner.toBase58();
    if (request.operation === 0 && [0, 2, 3, 4, 5, 7].includes(request.status)) {
      const amount = number(request.amount);
      pending += amount;
      pendingByOwner.set(owner, (pendingByOwner.get(owner) ?? 0n) + amount);
      if (request.status !== 0) refundableByOwner.set(owner, (refundableByOwner.get(owner) ?? 0n) + amount);
    } else if (request.operation !== 0 && request.status === 0) {
      if (request.from >= pool.classes.length) throw new Error("RetirementAuditRequestClassMismatch");
      expectedLocked[request.from] += number(request.units);
    }
  }
  let payable = 0n;
  let refundable = 0n;
  let positionRetirementPayable = 0n;
  const owners = positions.map((position, index): RetirementOwnerPreview => {
    let claim = 0n;
    for (const [classId, holding] of position.classes.entries()) {
      const units = number(holding.units);
      const locked = number(holding.locked);
      const denominator = number(fixed[classId]!.units);
      if (units < 0n || locked < 0n || locked > units || (units > 0n && denominator === 0n)) throw new Error("RetirementAuditInvalidPositionBalance");
      classUnits[classId] += units;
      lockedUnits[classId] += locked;
      claim += units === 0n ? 0n : units * number(fixed[classId]!.backing) / denominator;
    }
    const existingPayable = number(position.payable);
    const existingRefundable = number(position.refundable);
    if (existingRefundable !== (refundableByOwner.get(position.owner.toBase58()) ?? 0n)) throw new Error("RetirementAuditRefundableMismatch");
    payable += existingPayable;
    refundable += existingRefundable;
    positionRetirementPayable += claim;
    const pendingDepositPrincipal = pendingByOwner.get(position.owner.toBase58()) ?? 0n;
    return { owner: position.owner, position: positionKeys[index]!, existingPayable, existingRefundable,
      pendingDepositPrincipal, positionRetirementPayable: claim, totalCollateralClaim: existingPayable + pendingDepositPrincipal + claim };
  });
  const active = pool.classes.reduce((sum, value) => sum + number(value.backing), 0n);
  if (active !== number(pool.active) || pending !== number(pool.pending) || payable !== number(pool.payable)
    || classUnits.some((units, index) => units !== number(pool.classes[index]!.units))
    || lockedUnits.some((units, index) => units !== expectedLocked[index])) throw new Error("RetirementAuditLedgerMismatch");
  const retirementRoundingResidual = active - positionRetirementPayable;
  if (retirementRoundingResidual < 0n) throw new Error("RetirementAuditValuationMismatch");
  const vaultInfo = required(initial.value[2]);
  if (!vaultInfo.owner.equals(TOKEN_PROGRAM) || vaultBytes.length !== 165 || vaultBytes[108] !== 1
    || !vaultBytes.subarray(0, 32).equals(pool.collateralMint.toBuffer()) || !vaultBytes.subarray(32, 64).equals(poolKey.toBuffer())) throw new Error("RetirementAuditVaultMismatch");
  const vault = vaultBytes.readBigUInt64LE(64);
  const fees = number(pool.fees);
  const residual = number(pool.residual);
  const requiredVault = active + pending + payable + fees + residual;
  if (vault < requiredVault) throw new Error("RetirementAuditVaultShortfall");
  const final = await connection.getMultipleAccountsInfoAndContext([poolKey, registryKey, vaultKey], { commitment: "finalized", minContextSlot });
  if (final.context.slot < minContextSlot || final.value.length !== 3 || final.value.some((info, index) => !info || !info.data.equals([poolBytes, registryBytes, vaultBytes][index]!)
    || !info.owner.equals(index === 2 ? TOKEN_PROGRAM : program.programId))) throw new Error("RetirementAuditStateChanged");
  const retired = pool.schemaVersion === 3;
  const requiresMigration = pool.schemaVersion === 1;
  return { pool: poolKey, finalizedSlot: final.context.slot, sequence: number(pool.sequence), stateDigest: Uint8Array.from(pool.stateDigest),
    requestCount: requests.length, queuedRequestCount, positionCount: positions.length,
    flags: { paused: registry.paused, retired, initialized: pool.initialized, requiresMigration,
      ready: registry.paused && pool.initialized && !retired && !requiresMigration },
    totals: { active, pending, payable, refundable, fees, residual, vault, vaultSurplus: vault - requiredVault,
      positionRetirementPayable, retirementRoundingResidual, projectedResidual: residual + vault - requiredVault + retirementRoundingResidual, classUnits, lockedUnits }, owners };
}

function poolBytesForId(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}
