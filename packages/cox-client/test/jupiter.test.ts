import assert from "node:assert/strict";
import test from "node:test";
import { AddressLookupTableAccount, PublicKey, type Connection } from "@solana/web3.js";
import { JupiterRouteProvider, JUPITER_MAINNET_GENESIS } from "../src/jupiter.ts";
import { routedCollateralAccount, ROUTED_JUPITER_PROGRAM, type DexRouteRequest } from "../src/routed.ts";

const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
function fixture() {
  const owner = key(1), inputMint = key(2), outputMint = key(3);
  const request: DexRouteRequest = { genesisHash: JUPITER_MAINNET_GENESIS, owner, inputMint, outputMint,
    inputTokenAccount: routedCollateralAccount(owner, inputMint), outputTokenAccount: routedCollateralAccount(owner, outputMint),
    inputAmount: 100n, slippageBps: 50 };
  const response = { inputMint: inputMint.toBase58(), outputMint: outputMint.toBase58(), inAmount: "100", outAmount: "200",
    otherAmountThreshold: "199", swapMode: "ExactIn", swapInstruction: { programId: ROUTED_JUPITER_PROGRAM.toBase58(), accounts: [], data: "AQ==" },
    setupInstructions: [], cleanupInstruction: null, otherInstructions: [], tipInstruction: null,
    addressesByLookupTableAddress: {} as Record<string, string[]> };
  const calls: { url: URL; options: RequestInit | undefined }[] = [];
  const tables = new Map<string, AddressLookupTableAccount>();
  let network = JUPITER_MAINNET_GENESIS;
  const connection = { getGenesisHash: async () => network,
    getAddressLookupTable: async (address: PublicKey) => ({ value: tables.get(address.toBase58()) ?? null }) } as unknown as Connection;
  const fetcher = (async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: new URL(url.toString()), options });
    return Response.json(response);
  }) as typeof fetch;
  const provider = new JupiterRouteProvider({ connection, apiKey: "test-key", fetch: fetcher });
  return { request, response, calls, tables, connection, provider, setNetwork: (value: string) => { network = value; } };
}
test("Jupiter builds exact-input routes for the reviewed owner and destination without logging credentials in URLs", async () => {
  const s = fixture();
  const route = await s.provider.route(s.request);
  assert.equal(route.inputAmount, 100n);
  assert.equal(route.expectedOutputAmount, 200n);
  assert.equal(route.minimumOutputAmount, 199n);
  assert.ok(route.swapInstruction.programId.equals(ROUTED_JUPITER_PROGRAM));
  const call = s.calls[0]!;
  assert.equal(call.url.origin, "https://api.jup.ag");
  assert.equal(call.url.pathname, "/swap/v2/build");
  assert.equal(call.url.searchParams.get("taker"), s.request.owner.toBase58());
  assert.equal(call.url.searchParams.get("destinationTokenAccount"), s.request.outputTokenAccount.toBase58());
  assert.equal(call.url.searchParams.get("wrapAndUnwrapSol"), "false");
  assert.equal(call.url.searchParams.get("platformFeeBps"), "0");
  assert.ok(!call.url.toString().includes("test-key"));
  assert.deepEqual(call.options!.headers, { "x-api-key": "test-key" });
});
test("mainnet Jupiter routes cannot be requested for devnet or a different source account", async () => {
  const s = fixture();
  await assert.rejects(s.provider.route({ ...s.request, genesisHash: "devnet" }), /SwapNetworkMismatch/);
  s.setNetwork("devnet");
  await assert.rejects(s.provider.route(s.request), /SwapNetworkMismatch/);
  assert.equal(s.calls.length, 0);
  s.setNetwork(JUPITER_MAINNET_GENESIS);
  await assert.rejects(s.provider.route({ ...s.request, inputTokenAccount: key(8) }), /SwapRouteSourceAccountUnsupported/);
});
test("Jupiter response cannot substitute asset, amount, mode, cleanup or extra instructions", async () => {
  const cases = [
    { outputMint: key(9).toBase58() }, { inAmount: "101" }, { inAmount: "1.0" }, { swapMode: "ExactOut" },
    { outAmount: "198" }, { cleanupInstruction: {} }, { otherInstructions: [{}] }, { tipInstruction: {} },
  ];
  for (const changed of cases) {
    const s = fixture();
    Object.assign(s.response, changed);
    await assert.rejects(s.provider.route(s.request), /SwapRouteMismatch|SwapRouteInstructionsUnsupported/);
  }
});
test("lookup table addresses are verified against the chain rather than trusting API-provided indices", async () => {
  const s = fixture();
  const table = new AddressLookupTableAccount({ key: key(7), state: { deactivationSlot: (1n << 64n) - 1n,
    lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [key(8), key(9)] } });
  s.response.addressesByLookupTableAddress[table.key.toBase58()] = table.state.addresses.map(address => address.toBase58());
  await assert.rejects(s.provider.route(s.request), /SwapLookupTableMismatch/);
  s.tables.set(table.key.toBase58(), table);
  const route = await s.provider.route(s.request);
  assert.equal(route.lookupTables[0], table);
  s.response.addressesByLookupTableAddress[table.key.toBase58()]!.reverse();
  await assert.rejects(s.provider.route(s.request), /SwapLookupTableMismatch/);
});
test("provider refuses missing credentials, unbounded route settings and unavailable services", async () => {
  const s = fixture();
  assert.throws(() => new JupiterRouteProvider({ connection: s.connection, apiKey: "" }), /SwapRouteApiKeyMissing/);
  assert.throws(() => new JupiterRouteProvider({ connection: s.connection, apiKey: "key", maxAccounts: 64 }), /SwapRouteAccountLimit/);
  for (const [status, code] of [[429, "SwapRouteRateLimited"], [503, "SwapRouteUnavailable"]] as const) {
    const provider = new JupiterRouteProvider({ connection: s.connection, apiKey: "key",
      fetch: (async () => new Response(null, { status })) as typeof fetch });
    await assert.rejects(provider.route(s.request), new RegExp(code));
  }
});
