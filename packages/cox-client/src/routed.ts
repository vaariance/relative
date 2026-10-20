import { Buffer } from "buffer";
import type { Program } from "@coral-xyz/anchor";
import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { CoxSwapSdk, SwapSdkError, type FeeTerms, type PreparedTransaction } from "./swap.ts";
import { addresses, PROGRAM_ID } from "./pdas.ts";
import { discriminator, integer, sha256 } from "./wire.ts";
import { swapCapabilities, SWAP_DEVNET_GENESIS, type SwapCapabilityReason } from "./capabilities.ts";

export const ROUTED_JUPITER_PROGRAM = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const U64_MAX = (1n << 64n) - 1n;
const DEVNET_GENESIS = SWAP_DEVNET_GENESIS;

export interface DexRouteRequest {
  genesisHash: string;
  owner: PublicKey;
  inputMint: PublicKey;
  inputTokenAccount: PublicKey;
  outputMint: PublicKey;
  outputTokenAccount: PublicKey;
  inputAmount: bigint;
  slippageBps: number;
}
export interface DexRoute extends DexRouteRequest {
  minimumOutputAmount: bigint;
  expectedOutputAmount: bigint;
  swapInstruction: TransactionInstruction;
  lookupTables: readonly AddressLookupTableAccount[];
  setupInstructions?: readonly TransactionInstruction[];
}
export interface DexRouteProvider {
  genesisHash: string;
  route(request: DexRouteRequest): Promise<DexRoute>;
}
export interface RoutedEntryOptions {
  poolId: bigint;
  collateralMint: PublicKey;
  routerProgramId?: PublicKey;
  genesisHash: string;
  expressEnabled?: boolean;
}
export class ExpressUnavailableError extends SwapSdkError {
  readonly reason: SwapCapabilityReason;
  constructor(reason: SwapCapabilityReason) { super("SwapExpressUnavailable"); this.reason = reason; }
}
export interface RoutedEntryInput {
  owner: PublicKey;
  inputMint: PublicKey;
  inputTokenAccount: PublicKey;
  inputAmount: bigint;
  classId: number;
  minimumUnits: bigint;
  expiryBatch: bigint;
  expectedFeeVersion: bigint;
  slippageBps: number;
}
export interface RoutedEntryPlan {
  kind: "swap-and-deposit";
  owner: PublicKey;
  pool: PublicKey;
  collateralMint: PublicKey;
  collateralTokenAccount: PublicKey;
  classId: number;
  request: { address: PublicKey; nonce: bigint; earliestBatchEstimate: bigint; expiryBatch: bigint };
  feeTerms: FeeTerms;
  observedSequence: bigint;
  minimumCollateral: bigint;
  expectedCollateral: bigint;
  collateralAmount: "full-observed-output";
  execution: "future-publication";
  testOnly: true;
  instructions: readonly TransactionInstruction[];
  lookupTables: readonly AddressLookupTableAccount[];
}
function check(condition: boolean, code: string): asserts condition {
  if (!condition) throw new SwapSdkError(code);
}
function uint(value: bigint, max = U64_MAX, positive = false) {
  check(typeof value === "bigint" && value >= (positive ? 1n : 0n) && value <= max, "InvalidSwapAmount");
}
export function routedCollateralAccount(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM)[0];
}
function validateSetup(ix: TransactionInstruction, owner: PublicKey): void {
  check(ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM) && ix.data.length === 1 && ix.data[0] === 1 && ix.keys.length === 6, "SwapUnsafeSetup");
  const keys = ix.keys;
  check(keys[0]!.pubkey.equals(owner) && keys[0]!.isSigner && keys[0]!.isWritable
    && keys[1]!.isWritable && keys[2]!.pubkey.equals(owner) && keys[4]!.pubkey.equals(SystemProgram.programId)
    && keys[5]!.pubkey.equals(TOKEN_PROGRAM) && keys.slice(1).every(key => !key.isSigner)
    && keys[1]!.pubkey.equals(routedCollateralAccount(owner, keys[3]!.pubkey)), "SwapUnsafeSetup");
}
function validateRoute(route: DexRoute): void {
  const data = route.swapInstruction.data;
  const kinds = ["route", "shared_accounts_route", "route_v2", "shared_accounts_route_v2"];
  const kind = kinds.findIndex(name => data.subarray(0, 8).equals(discriminator("global", name)));
  check(kind >= 0 && data.length >= 31, "SwapUnsupportedRoute");
  const fields = kind >= 2 ? data.subarray(kind === 3 ? 9 : 8) : data.subarray(data.length - 19);
  check(fields.length >= (kind >= 2 ? 26 : 19), "SwapUnsupportedRoute");
  check(fields.readBigUInt64LE(0) === route.inputAmount && fields.readBigUInt64LE(8) === route.expectedOutputAmount
    && fields.readUInt16LE(16) === route.slippageBps && (kind >= 2 ? fields.subarray(18, 22).every(byte => byte === 0) : fields[18] === 0), "SwapRouteMismatch");
  check(route.minimumOutputAmount >= route.expectedOutputAmount * BigInt(10_000 - route.slippageBps) / 10_000n, "SwapRouteSlippageMismatch");
  const bindings: [number, PublicKey][][] = [
    [[0, TOKEN_PROGRAM], [1, route.owner], [2, route.inputTokenAccount], [3, route.outputTokenAccount], [5, route.outputMint], [6, ROUTED_JUPITER_PROGRAM], [8, ROUTED_JUPITER_PROGRAM]],
    [[0, TOKEN_PROGRAM], [2, route.owner], [3, route.inputTokenAccount], [6, route.outputTokenAccount], [7, route.inputMint], [8, route.outputMint], [9, ROUTED_JUPITER_PROGRAM], [10, ROUTED_JUPITER_PROGRAM], [12, ROUTED_JUPITER_PROGRAM]],
    [[0, route.owner], [1, route.inputTokenAccount], [2, route.outputTokenAccount], [3, route.inputMint], [4, route.outputMint], [5, TOKEN_PROGRAM], [6, TOKEN_PROGRAM], [9, ROUTED_JUPITER_PROGRAM]],
    [[1, route.owner], [2, route.inputTokenAccount], [5, route.outputTokenAccount], [6, route.inputMint], [7, route.outputMint], [8, TOKEN_PROGRAM], [9, TOKEN_PROGRAM], [11, ROUTED_JUPITER_PROGRAM]],
  ];
  check(bindings[kind]!.every(([index, key]) => route.swapInstruction.keys[index]?.pubkey.equals(key)), "SwapRouteMismatch");
  if (kind === 0 || kind === 2) {
    const optionalDestination = route.swapInstruction.keys[kind === 0 ? 4 : 7]?.pubkey;
    check(!!optionalDestination && (optionalDestination.equals(ROUTED_JUPITER_PROGRAM)
      || optionalDestination.equals(route.outputTokenAccount)), "SwapRouteMismatch");
  }
}
function fingerprint(plan: RoutedEntryPlan): Buffer {
  return sha256(Buffer.concat([
    plan.owner.toBuffer(), plan.pool.toBuffer(), plan.collateralMint.toBuffer(), plan.collateralTokenAccount.toBuffer(),
    integer(BigInt(plan.classId), 1), integer(plan.request.nonce, 8), integer(plan.request.expiryBatch, 8), integer(plan.feeTerms.version, 8), integer(plan.minimumCollateral, 8), integer(plan.expectedCollateral, 8),
    ...plan.instructions.flatMap(ix => [ix.programId.toBuffer(), integer(BigInt(ix.keys.length), 4),
      ...ix.keys.flatMap(key => [key.pubkey.toBuffer(), Buffer.from([Number(key.isSigner), Number(key.isWritable)])]),
      integer(BigInt(ix.data.length), 4), ix.data]),
    ...plan.lookupTables.flatMap(table => [table.key.toBuffer(), ...table.state.addresses.map(key => key.toBuffer())]),
  ]));
}
export class CoxRoutedEntrySdk {
  private readonly direct: CoxSwapSdk;
  private readonly plans = new WeakMap<RoutedEntryPlan, Buffer>();
  private readonly program: Program;
  readonly options: RoutedEntryOptions;
  private readonly dex: DexRouteProvider | undefined;
  constructor(program: Program, options: RoutedEntryOptions, dex?: DexRouteProvider) {
    this.program = program; this.options = Object.freeze({ ...options }); this.dex = dex;
    check(options.genesisHash === DEVNET_GENESIS, "SwapNetworkMismatch");
    check(!options.routerProgramId || ![PROGRAM_ID, ROUTED_JUPITER_PROGRAM, SystemProgram.programId, TOKEN_PROGRAM].some(key => key.equals(options.routerProgramId!)), "SwapRouterMismatch");
    this.direct = new CoxSwapSdk(program, this.options);
  }
  async capabilities() {
    return swapCapabilities(this.program.provider.connection, this.options.genesisHash,
      { ...this.options, providerGenesisHash: this.dex?.genesisHash });
  }
  private async requireExpress() {
    const capabilities = await this.capabilities();
    if (!capabilities.express.available) throw new ExpressUnavailableError(capabilities.express.reason);
    return { routerProgramId: this.options.routerProgramId!, dex: this.dex! };
  }
  private async token(key: PublicKey, owner: PublicKey, mint: PublicKey, absent = false): Promise<bigint | null> {
    const info = await this.program.provider.connection.getAccountInfo(key, "finalized");
    if (!info && absent) return null;
    check(!!info && info.owner.equals(TOKEN_PROGRAM) && info.data.length === 165 && info.data[108] === 1
      && info.data.subarray(0, 32).equals(mint.toBuffer()) && info.data.subarray(32, 64).equals(owner.toBuffer()), "SwapWalletTokenMismatch");
    return info.data.readBigUInt64LE(64);
  }
  async prepare(input: RoutedEntryInput): Promise<RoutedEntryPlan> {
    uint(input.inputAmount, U64_MAX, true); uint(input.minimumUnits, 10n ** 24n);
    check(Number.isInteger(input.slippageBps) && input.slippageBps >= 0 && input.slippageBps <= 10_000, "SwapInvalidSlippage");
    check(!input.inputMint.equals(this.options.collateralMint), "SwapUseDirectDeposit");
    const { routerProgramId, dex } = await this.requireExpress();
    check((await this.token(input.inputTokenAccount, input.owner, input.inputMint))! >= input.inputAmount, "SwapInsufficientInput");
    const collateralTokenAccount = routedCollateralAccount(input.owner, this.options.collateralMint);
    const existingCollateral = await this.token(collateralTokenAccount, input.owner, this.options.collateralMint, true);
    const request: DexRouteRequest = { genesisHash: this.options.genesisHash, owner: input.owner, inputMint: input.inputMint,
      inputTokenAccount: input.inputTokenAccount, outputMint: this.options.collateralMint, outputTokenAccount: collateralTokenAccount,
      inputAmount: input.inputAmount, slippageBps: input.slippageBps };
    const route = await dex.route(request);
    check(route.genesisHash === request.genesisHash && route.inputAmount === request.inputAmount && route.slippageBps === request.slippageBps
      && route.owner.equals(request.owner) && route.inputMint.equals(request.inputMint) && route.inputTokenAccount.equals(request.inputTokenAccount)
      && route.outputMint.equals(request.outputMint) && route.outputTokenAccount.equals(request.outputTokenAccount), "SwapRouteMismatch");
    uint(route.minimumOutputAmount, 10n ** 11n, true); uint(route.expectedOutputAmount, 10n ** 11n, true);
    check(route.expectedOutputAmount >= route.minimumOutputAmount, "SwapRouteMismatch");
    check(route.swapInstruction.programId.equals(ROUTED_JUPITER_PROGRAM), "SwapRouteProgramMismatch");
    check(route.swapInstruction.keys.every(key => !key.isSigner || key.pubkey.equals(input.owner)), "SwapRouteSignerMismatch");
    validateRoute(route);
    for (const ix of route.setupInstructions ?? []) validateSetup(ix, input.owner);
    check(route.lookupTables.every(table => table.isActive()), "SwapLookupTableInactive");
    const context = await this.direct.entryContext(input.owner, input.classId, input.expiryBatch, input.expectedFeeVersion, route.minimumOutputAmount);
    const pdas = addresses(this.program.programId);
    const writable = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
    const readonly = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
    const instructions: TransactionInstruction[] = [];
    if (existingCollateral === null) instructions.push(new TransactionInstruction({ programId: ASSOCIATED_TOKEN_PROGRAM, data: Buffer.from([1]),
      keys: [{ pubkey: input.owner, isSigner: true, isWritable: true }, writable(collateralTokenAccount), readonly(input.owner),
        readonly(this.options.collateralMint), readonly(SystemProgram.programId), readonly(TOKEN_PROGRAM)] }));
    instructions.push(...route.setupInstructions ?? []);
    instructions.push(new TransactionInstruction({ programId: routerProgramId,
      data: Buffer.concat([discriminator("global", "swap_and_deposit"), integer(BigInt(input.classId), 1), integer(input.inputAmount, 8),
        integer(route.minimumOutputAmount, 8), integer(input.minimumUnits, 16), integer(input.expiryBatch, 8), integer(input.expectedFeeVersion, 8),
        integer(BigInt(route.swapInstruction.data.length), 4), route.swapInstruction.data]),
      keys: [{ pubkey: input.owner, isSigner: true, isWritable: true }, readonly(pdas.registry()), writable(context.pool),
        writable(pdas.position(context.pool, input.owner)), writable(context.request.address), writable(pdas.vault(context.pool)),
        writable(collateralTokenAccount), readonly(TOKEN_PROGRAM), readonly(SystemProgram.programId), writable(input.inputTokenAccount),
        readonly(ROUTED_JUPITER_PROGRAM), readonly(this.program.programId), ...route.swapInstruction.keys] }));
    const plan: RoutedEntryPlan = { kind: "swap-and-deposit", owner: input.owner, pool: context.pool, collateralMint: this.options.collateralMint,
      collateralTokenAccount, classId: input.classId, request: context.request, feeTerms: context.feeTerms, observedSequence: context.observedSequence,
      minimumCollateral: route.minimumOutputAmount, expectedCollateral: route.expectedOutputAmount, collateralAmount: "full-observed-output",
      execution: "future-publication", testOnly: true, instructions, lookupTables: route.lookupTables };
    this.plans.set(plan, fingerprint(plan));
    return plan;
  }
  async transaction(plan: RoutedEntryPlan): Promise<PreparedTransaction> {
    const original = this.plans.get(plan);
    check(!!original && original.equals(fingerprint(plan)), "SwapPlanMismatch");
    await this.requireExpress();
    const context = await this.direct.entryContext(plan.owner, plan.classId, plan.request.expiryBatch, plan.feeTerms.version, plan.minimumCollateral);
    check(context.request.nonce === plan.request.nonce, "SwapNonceChangedRebuild");
    const connection = this.program.provider.connection;
    const latest = await connection.getLatestBlockhash("finalized");
    const compile = (units: number) => new VersionedTransaction(new TransactionMessage({ payerKey: plan.owner, recentBlockhash: latest.blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...plan.instructions] }).compileToV0Message([...plan.lookupTables]));
    const transaction = compile(1_400_000);
    check(transaction.message.header.numRequiredSignatures === 1, "SwapRouteSignerMismatch");
    check(transaction.serialize().length <= 1232, "SwapTransactionTooLarge");
    const result = await connection.simulateTransaction(transaction, { commitment: "finalized", sigVerify: false });
    check(result.value.err === null, "SwapRouteSimulationFailed");
    check(typeof result.value.unitsConsumed === "number" && result.value.unitsConsumed > 0, "SwapSimulationUnitsMissing");
    const units = Math.min(1_400_000, Math.ceil(result.value.unitsConsumed * 1.2));
    const prepared = compile(units);
    const finalResult = await connection.simulateTransaction(prepared, { commitment: "finalized", sigVerify: false });
    check(finalResult.value.err === null, "SwapRouteSimulationFailed");
    const finalContext = await this.direct.entryContext(plan.owner, plan.classId, plan.request.expiryBatch, plan.feeTerms.version, plan.minimumCollateral);
    check(finalContext.request.nonce === plan.request.nonce, "SwapNonceChangedRebuild");
    check(original.equals(fingerprint(plan)), "SwapPlanMismatch");
    return { transaction: prepared, ...latest };
  }
}
