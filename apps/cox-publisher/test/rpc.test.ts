import { test } from "node:test";
import assert from "node:assert/strict";
import { DEV_GENESIS } from "../src/config.ts";
import { directDevnetFetch, directDevnetRpcUrls, PUBLIC_DEVNET_RPC } from "../src/rpc.ts";

const environment = { ALCHEMY_API_KEY: "private-key" };
const response = (result: unknown, status = 200) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status });

test("direct endpoints require a key and do not accept proxy overrides", () => {
  assert.throws(() => directDevnetRpcUrls({}), /^Error: InvalidAlchemyApiKey$/);
  assert.throws(() => directDevnetRpcUrls({ ALCHEMY_API_KEY: "secret?query" }), /^Error: InvalidAlchemyApiKey$/);
  assert.deepEqual(directDevnetRpcUrls(environment), ["https://solana-devnet.g.alchemy.com/v2/private-key", PUBLIC_DEVNET_RPC]);
});

test("Alchemy failures use verified public fallback and periodically return to primary", async () => {
  let now = 0, healthy = false;
  const calls: string[] = [];
  const switches: boolean[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = JSON.parse(String(init?.body)).method;
    calls.push(`${url === PUBLIC_DEVNET_RPC ? "public" : "alchemy"}:${method}`);
    if (url !== PUBLIC_DEVNET_RPC && !healthy) return response(null, 429);
    return response(method === "getGenesisHash" ? DEV_GENESIS : 42);
  };
  const send = directDevnetFetch(environment, { fetch: request, now: () => now, onFallback: active => switches.push(active) });
  const init = { method: "POST", body: JSON.stringify({ method: "getSlot" }) };
  assert.equal((await (await send("ignored", init)).json()).result, 42);
  assert.deepEqual(calls, ["alchemy:getGenesisHash", "public:getGenesisHash", "public:getSlot"]);
  healthy = true;
  await send("ignored", init);
  assert.equal(calls.at(-1), "public:getSlot");
  now = 30_000;
  await send("ignored", init);
  assert.deepEqual(calls.slice(-2), ["alchemy:getGenesisHash", "alchemy:getSlot"]);
  assert.deepEqual(switches, [true, false]);
});

test("public fallback with another genesis never receives an application request", async () => {
  const methods: string[] = [];
  const send = directDevnetFetch(environment, { fetch: async (url, init) => {
    if (String(url) !== PUBLIC_DEVNET_RPC) throw new Error("failed at private-key");
    methods.push(JSON.parse(String(init?.body)).method);
    return response("MAINNET");
  } });
  await assert.rejects(send("ignored", { body: JSON.stringify({ method: "sendTransaction" }) }), /^Error: RpcGenesisMismatch$/);
  assert.deepEqual(methods, ["getGenesisHash"]);
});

test("all upstream errors are sanitized and retries preserve signed transaction bytes", async () => {
  const sent: string[] = [];
  const signed = JSON.stringify({ method: "sendTransaction", params: ["same-signed-bytes"] });
  const send = directDevnetFetch(environment, { fetch: async (_url, init) => {
    if (JSON.parse(String(init?.body)).method === "getGenesisHash") return response(DEV_GENESIS);
    sent.push(String(init?.body));
    throw new Error("private-key endpoint leaked");
  } });
  await assert.rejects(send("ignored", { method: "POST", body: signed }), /^Error: DirectRpcUnavailable$/);
  assert.deepEqual(sent, [signed, signed]);
});
