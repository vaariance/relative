import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Program } from "@coral-xyz/anchor";
import { AddressLookupTableAccount, PublicKey, TransactionInstruction, TransactionMessage, type AccountInfo, type VersionedTransaction } from "@solana/web3.js";
import { build } from "esbuild";
import { CoxSwapSdk } from "../src/swap.ts";
import { addresses, PROGRAM_ID } from "../src/pdas.ts";
import { CoxRoutedEntrySdk, ExpressUnavailableError, ROUTED_JUPITER_PROGRAM, routedCollateralAccount, type DexRoute, type DexRouteRequest } from "../src/routed.ts";
import { discriminator, integer } from "../src/wire.ts";

const genesisHash = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
function setup(t: TestContext) {
  const owner = key(1), inputMint = key(2), inputTokenAccount = key(3), collateralMint = key(4), routerProgramId = key(5);
  const pool = addresses().pool(1n);
  const output = routedCollateralAccount(owner, collateralMint);
  const accounts = new Map<string, AccountInfo<Buffer>>();
  accounts.set(routerProgramId.toBase58(), { data: Buffer.alloc(0), owner: key(60), executable: true, lamports: 1, rentEpoch: 0 });
  const token = (mint: PublicKey, amount: bigint) => {
    const data = Buffer.alloc(165); mint.toBuffer().copy(data); owner.toBuffer().copy(data, 32); data.writeBigUInt64LE(amount, 64); data[108] = 1;
    return { data, owner: tokenProgram, executable: false, lamports: 10, rentEpoch: 0 };
  };
  accounts.set(inputTokenAccount.toBase58(), token(inputMint, 500n));
  let nonce = 9n, feeVersion = 2n, simulationError: object | null = null;
  let simulated: VersionedTransaction | null = null;
  const connection = {
    getGenesisHash: async () => genesisHash,
    getAccountInfo: async (address: PublicKey) => accounts.get(address.toBase58()) ?? null,
    getLatestBlockhash: async () => ({ blockhash: key(8).toBase58(), lastValidBlockHeight: 900 }),
    simulateTransaction: async (transaction: VersionedTransaction) => { simulated = transaction; return { value: { err: simulationError, unitsConsumed: 300_000 } }; },
  };
  const program = { programId: PROGRAM_ID, provider: { connection } } as unknown as Program;
  t.mock.method(CoxSwapSdk.prototype, "entryContext", async (_owner: PublicKey, classId: number, expiryBatch: bigint, expectedFee: bigint, minimumCollateral: bigint) => {
    assert.equal(expectedFee, feeVersion, "SwapFeeChangedRebuild"); assert.ok(minimumCollateral > 0n);
    return { owner, pool, collateralMint, classId, request: { address: addresses().request(pool, nonce), nonce, earliestBatchEstimate: 11n, expiryBatch },
      feeTerms: { version: feeVersion, bps: 2, cap: 2_000_000n }, observedSequence: 7n, testOnly: true as const };
  });
  let alter = (route: DexRoute): DexRoute => route;
  const provider = { genesisHash, route: async (request: DexRouteRequest): Promise<DexRoute> => alter({ ...request, minimumOutputAmount: 90n,
    expectedOutputAmount: 100n, lookupTables: [], swapInstruction: new TransactionInstruction({ programId: ROUTED_JUPITER_PROGRAM,
      keys: [tokenProgram, owner, inputTokenAccount, output, ROUTED_JUPITER_PROGRAM, collateralMint, ROUTED_JUPITER_PROGRAM, key(50), ROUTED_JUPITER_PROGRAM].map((pubkey, index) => ({ pubkey, isSigner: index === 1, isWritable: index === 2 || index === 3 })), data: Buffer.concat([discriminator("global", "route"), Buffer.from([0, 0, 0, 0]), integer(100n, 8), integer(100n, 8), integer(1000n, 2), Buffer.from([0])]) }) }) };
  const options = { poolId: 1n, collateralMint, routerProgramId, genesisHash, expressEnabled: true };
  const sdk = new CoxRoutedEntrySdk(program, options, provider);
  const input = { owner, inputMint, inputTokenAccount, inputAmount: 100n, classId: 0, minimumUnits: 1n, expiryBatch: 14n,
    expectedFeeVersion: 2n, slippageBps: 1000 };
  return { sdk, input, output, owner, pool, options, provider, program, connection, accounts, token,
    setRoute: (change: typeof alter) => { alter = change; }, setNonce: (value: bigint) => { nonce = value; },
    setFee: (value: bigint) => { feeVersion = value; }, setSimulationError: (error: object) => { simulationError = error; },
    simulated: () => simulated };
}

test("routed entry creates missing USDC ATA and encodes full-delta router call before complete simulation", async t => {
  const s = setup(t);
  const plan = await s.sdk.prepare(s.input);
  assert.equal(plan.instructions.length, 2);
  assert.equal(plan.instructions[0]!.data[0], 1);
  const ix = plan.instructions[1]!;
  assert.ok(ix.programId.equals(s.options.routerProgramId));
  assert.ok(ix.data.subarray(0, 8).equals(discriminator("global", "swap_and_deposit")));
  assert.equal(ix.data[8], 0); assert.equal(ix.data.readBigUInt64LE(9), 100n); assert.equal(ix.data.readBigUInt64LE(17), 90n);
  assert.equal(ix.data.readBigUInt64LE(41), 14n); assert.equal(ix.data.readBigUInt64LE(49), 2n);
  assert.ok(ix.keys[6]!.pubkey.equals(s.output)); assert.ok(ix.keys[9]!.pubkey.equals(s.input.inputTokenAccount));
  assert.equal(plan.collateralAmount, "full-observed-output"); assert.equal(plan.execution, "future-publication");
  const prepared = await s.sdk.transaction(plan);
  assert.equal(prepared.transaction, s.simulated());
  assert.equal(prepared.transaction.message.compiledInstructions.length, 3);
  assert.equal(prepared.transaction.message.header.numRequiredSignatures, 1);
  assert.ok(prepared.transaction.signatures[0]!.every(byte => byte === 0));
});

test("pre-existing USDC is preserved as baseline, never encoded as deposit amount", async t => {
  const s = setup(t);
  s.accounts.set(s.output.toBase58(), s.token(s.options.collateralMint, 9_000_000n));
  const plan = await s.sdk.prepare(s.input);
  assert.equal(plan.instructions.length, 1);
  assert.equal(plan.minimumCollateral, 90n);
  assert.equal(plan.expectedCollateral, 100n);
  await s.sdk.transaction(plan);
  assert.equal(s.accounts.get(s.output.toBase58())!.data.readBigUInt64LE(64), 9_000_000n);
});

test("provider destination, network, program and additional signatures are rejected", async t => {
  const s = setup(t);
  for (const change of [
    (route: DexRoute) => ({ ...route, outputTokenAccount: key(99) }),
    (route: DexRoute) => ({ ...route, genesisHash: "mainnet" }),
    (route: DexRoute) => ({ ...route, swapInstruction: new TransactionInstruction({ ...route.swapInstruction, programId: key(98) }) }),
    (route: DexRoute) => ({ ...route, swapInstruction: new TransactionInstruction({ ...route.swapInstruction, keys: [{ pubkey: key(97), isSigner: true, isWritable: true }] }) }),
  ]) {
    s.setRoute(change); await assert.rejects(s.sdk.prepare(s.input), /SwapRoute/);
  }
  assert.deepEqual((await new CoxRoutedEntrySdk(s.program, s.options, { ...s.provider, genesisHash: "mainnet" }).capabilities()).express,
    { available: false, reason: "provider-network-mismatch" });
});

test("Express is opt-in and rejects unavailable configurations before wallet reads or provider calls", async t => {
  const s = setup(t);
  const route = t.mock.method(s.provider, "route");
  const read = t.mock.method(s.connection, "getAccountInfo");
  const cases = [
    [new CoxRoutedEntrySdk(s.program, { ...s.options, routerProgramId: undefined }, s.provider), "router-not-configured"],
    [new CoxRoutedEntrySdk(s.program, s.options), "provider-not-configured"],
    [new CoxRoutedEntrySdk(s.program, s.options, { ...s.provider, genesisHash: "mainnet" }), "provider-network-mismatch"],
    [new CoxRoutedEntrySdk(s.program, { ...s.options, expressEnabled: undefined }, s.provider), "express-not-enabled"],
  ] as const;
  for (const [sdk, reason] of cases) {
    assert.deepEqual(await sdk.capabilities(), { directEntry: { available: true }, express: { available: false, reason } });
    await assert.rejects(sdk.prepare(s.input), error => error instanceof ExpressUnavailableError
      && error.code === "SwapExpressUnavailable" && error.reason === reason);
  }
  assert.equal(route.mock.callCount(), 0);
  assert.equal(read.mock.callCount(), 0);
});

test("Express requires an executable router and rechecks deployment before producing a transaction", async t => {
  const s = setup(t);
  const route = t.mock.method(s.provider, "route");
  assert.deepEqual((await s.sdk.capabilities()).express, { available: true });
  const plan = await s.sdk.prepare(s.input);
  const calls = route.mock.callCount();
  for (const info of [undefined, { ...s.accounts.get(s.options.routerProgramId.toBase58())!, executable: false }]) {
    if (info) s.accounts.set(s.options.routerProgramId.toBase58(), info);
    else s.accounts.delete(s.options.routerProgramId.toBase58());
    assert.deepEqual((await s.sdk.capabilities()).express, { available: false, reason: "router-not-executable" });
    await assert.rejects(s.sdk.prepare(s.input), error => error instanceof ExpressUnavailableError && error.reason === "router-not-executable");
    await assert.rejects(s.sdk.transaction(plan), /SwapExpressUnavailable/);
  }
  assert.equal(route.mock.callCount(), calls);
  assert.equal(s.simulated(), null);
});

test("Express capability is not a route guarantee and chain outages remain errors", async t => {
  const s = setup(t);
  t.mock.method(s.provider, "route", async () => { throw new Error("RouteUnavailable"); });
  assert.equal((await s.sdk.capabilities()).express.available, true);
  await assert.rejects(s.sdk.prepare(s.input), /RouteUnavailable/);
  t.mock.method(s.connection, "getGenesisHash", async () => "mainnet");
  assert.deepEqual(await s.sdk.capabilities(), { directEntry: { available: false, reason: "network-mismatch" },
    express: { available: false, reason: "network-mismatch" } });
  t.mock.method(s.connection, "getGenesisHash", async () => { throw new Error("RpcUnavailable"); });
  await assert.rejects(s.sdk.capabilities(), /RpcUnavailable/);
});

test("nonce and fee changes during composed simulation require rebuilding", async t => {
  const s = setup(t);
  const plan = await s.sdk.prepare(s.input);
  t.mock.method(s.connection, "simulateTransaction", async () => {
    s.setNonce(10n);
    return { value: { err: null, unitsConsumed: 300_000 } };
  });
  await assert.rejects(s.sdk.transaction(plan), /SwapNonceChangedRebuild/);
  s.setNonce(9n);
  t.mock.method(s.connection, "simulateTransaction", async () => {
    s.setFee(3n);
    return { value: { err: null, unitsConsumed: 300_000 } };
  });
  await assert.rejects(s.sdk.transaction(plan), /SwapFeeChangedRebuild/);
});

test("wrong source ownership, inadequate input and wrong collateral owner fail before quoting", async t => {
  const s = setup(t);
  await assert.rejects(s.sdk.prepare({ ...s.input, inputAmount: 501n }), /SwapInsufficientInput/);
  s.accounts.get(s.input.inputTokenAccount.toBase58())!.data[32] = 99;
  await assert.rejects(s.sdk.prepare(s.input), /SwapWalletTokenMismatch/);
  s.accounts.set(s.input.inputTokenAccount.toBase58(), s.token(s.input.inputMint, 500n));
  s.accounts.set(s.output.toBase58(), s.token(key(22), 5n));
  await assert.rejects(s.sdk.prepare(s.input), /SwapWalletTokenMismatch/);
});

test("nonce changes, modified plans and failed complete simulations prevent wallet signing", async t => {
  const s = setup(t);
  const plan = await s.sdk.prepare(s.input);
  s.setNonce(10n); await assert.rejects(s.sdk.transaction(plan), /SwapNonceChangedRebuild/); s.setNonce(9n);
  s.setSimulationError({ InstructionError: [1, "Custom"] });
  await assert.rejects(s.sdk.transaction(plan), /SwapRouteSimulationFailed/);
  plan.instructions[1]!.data[9] = 99;
  await assert.rejects(s.sdk.transaction(plan), /SwapPlanMismatch/);
});

test("lookup tables are used by the composed transaction and inactive tables are rejected", async t => {
  const s = setup(t);
  const table = new AddressLookupTableAccount({ key: key(42), state: { deactivationSlot: (1n << 64n) - 1n,
    lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, addresses: [s.input.inputTokenAccount, s.output] } });
  s.setRoute(route => ({ ...route, lookupTables: [table] }));
  const prepared = await s.sdk.transaction(await s.sdk.prepare(s.input));
  assert.equal(prepared.transaction.message.addressTableLookups.length, 1);
  const decoded = TransactionMessage.decompile(prepared.transaction.message, { addressLookupTableAccounts: [table] });
  assert.equal(decoded.instructions.length, 3);
  table.state.deactivationSlot = 3n;
  await assert.rejects(s.sdk.prepare(s.input), /SwapLookupTableInactive/);
});

test("routed entry bundles in browsers without service signing dependencies", async () => {
  const result = await build({ entryPoints: [new URL("../src/routed.ts", import.meta.url).pathname], bundle: true,
    platform: "browser", format: "esm", write: false, metafile: true, logLevel: "silent" });
  assert.ok(!Object.keys(result.metafile!.inputs).some(path => /packages\/signing|cox-publisher/.test(path)));
  assert.ok(result.outputFiles[0]!.text.length > 0);
});


test("intermediate setup permits only owner idempotent classic token accounts", async t => {
  const s = setup(t);
  const mint = key(55);
  const ata = routedCollateralAccount(s.owner, mint);
  const ataProgram = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  const setupIx = new TransactionInstruction({ programId: ataProgram, data: Buffer.from([1]), keys:
    [s.owner, ata, s.owner, mint, PublicKey.default, tokenProgram].map((pubkey, index) => ({ pubkey, isSigner: index === 0, isWritable: index < 2 })) });
  s.setRoute(route => ({ ...route, setupInstructions: [setupIx] }));
  assert.equal((await s.sdk.prepare(s.input)).instructions.length, 3);
  setupIx.keys[2]!.pubkey = key(99);
  await assert.rejects(s.sdk.prepare(s.input), /SwapUnsafeSetup/);
});

test("v2 fee fields and declared slippage are checked before composition", async t => {
  const s = setup(t);
  s.setRoute(route => {
    const keys = [s.owner, s.input.inputTokenAccount, s.output, s.input.inputMint, s.options.collateralMint,
      tokenProgram, tokenProgram, ROUTED_JUPITER_PROGRAM, key(50), ROUTED_JUPITER_PROGRAM];
    return { ...route, swapInstruction: new TransactionInstruction({ programId: ROUTED_JUPITER_PROGRAM,
      keys: keys.map((pubkey, index) => ({ pubkey, isSigner: index === 0, isWritable: index === 1 || index === 2 })),
      data: Buffer.concat([discriminator("global", "route_v2"), integer(100n, 8), integer(100n, 8), integer(1000n, 2), Buffer.alloc(8)]) }) };
  });
  await s.sdk.prepare(s.input);
  s.setRoute(route => ({ ...route, minimumOutputAmount: 1n }));
  await assert.rejects(s.sdk.prepare(s.input), /SwapRouteSlippageMismatch/);
  s.setRoute(route => { route.swapInstruction.data[route.swapInstruction.data.length - 1] = 1; return route; });
  await assert.rejects(s.sdk.prepare(s.input), /SwapRouteMismatch/);
});


test("configuration is captured at construction and optional destination accounts are bound", async t => {
  const s = setup(t);
  const originalMint = s.options.collateralMint;
  s.options.collateralMint = key(66);
  const plan = await s.sdk.prepare(s.input);
  assert.ok(plan.collateralMint.equals(originalMint));
  s.setRoute(route => {
    route.swapInstruction.keys[4]!.pubkey = key(67);
    return route;
  });
  await assert.rejects(s.sdk.prepare(s.input), /SwapRouteMismatch/);
});
