import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import type { JsonOrBinaryResponse, LazerClientConfig, Request } from "@pythnetwork/pyth-lazer-sdk";
import type { ReconnectEvent, SubscribeRequest, SubscribeUpdate } from "@triton-one/yellowstone-grpc";
import { parsePythProUpdate, publisherSubscription, startAlchemyGrpc, startPythPro,
  type ChainWake, type FeedStatus, type PythClientPort, type UnverifiedPythUpdate } from "../src/live-feeds.ts";

const catalogue = [{ assetId: "BTC", priceFeedId: 1 }, { assetId: "ETH", priceFeedId: 2 }];
const program = new PublicKey("G6iQGoupNSfduw1QJxQ9vcVi9FnCC6cbippXsi4QQzJF");
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const update = (): JsonOrBinaryResponse => ({ type: "json", value: {
  type: "streamUpdated", subscriptionId: 7,
  parsed: { timestampUs: "123000000", priceFeeds: [
    { priceFeedId: 1, price: "100000000", exponent: -8, confidence: 100, feedUpdateTimestamp: 122999999 },
    { priceFeedId: 2, price: "200000000", exponent: -8, confidence: 200, feedUpdateTimestamp: 122999999 },
  ] }, solana: { encoding: "base64", data: Buffer.from("signed-evidence").toString("base64") },
} });

class FakePyth implements PythClientPort {
  message: (event: JsonOrBinaryResponse) => void = () => {};
  down: () => void = () => {};
  restored: () => void = () => {};
  requests: Request[] = [];
  stopped = 0;
  addMessageListener(handler: (event: JsonOrBinaryResponse) => void) { this.message = handler; }
  addAllConnectionsDownListener(handler: () => void) { this.down = handler; }
  addConnectionRestoredListener(handler: () => void) { this.restored = handler; }
  subscribe(request: Request) { this.requests.push(request); }
  shutdown() { this.stopped++; }
}

function chainEvent(update: Partial<SubscribeUpdate>, generation = "1"): ReconnectEvent {
  return { type: "Update", generation, update: { filters: [], createdAt: undefined, ...update } };
}

function fakeGrpc() {
  const stream = new PassThrough({ objectMode: true });
  let request: SubscribeRequest | undefined;
  let connected = false;
  return { stream, get request() { return request; }, createClient: () => ({
    async connect() { connected = true; },
    async subscribeWithReconnect(value: SubscribeRequest) { assert.equal(connected, true); request = value; return stream; },
  }) };
}

test("Pyth subscribes to explicit feeds with three warm connections and one-second signed Solana updates", async () => {
  const client = new FakePyth();
  const received: UnverifiedPythUpdate[] = [];
  const states: FeedStatus[] = [];
  let config: LazerClientConfig | undefined;
  const handle = await startPythPro({ token: "secret", catalogue, subscriptionId: 7, maxFeedAgeUs: 10n,
    onUpdate: (item) => received.push(item), onStatus: (state) => states.push(state),
    createClient: async (value) => { config = value; return client; } });
  assert.equal(config?.webSocketPoolConfig.numConnections, 3);
  assert.equal(config?.webSocketPoolConfig.urls?.length, 3);
  assert.deepEqual(client.requests, [{ type: "subscribe", subscriptionId: 7, priceFeedIds: [1, 2],
    properties: ["price", "exponent", "confidence", "feedUpdateTimestamp"], formats: ["solana"], deliveryFormat: "json",
    jsonBinaryEncoding: "base64", parsed: true, ignoreInvalidFeedIds: false, channel: "fixed_rate@1000ms" }]);
  assert.equal(states.includes("streaming"), false);
  client.message(update());
  assert.equal(received[0]?.verification, "unverified");
  assert.equal(received[0]?.batch.timestampUs, 123000000n);
  assert.equal(received[0]?.batch.prices[0]?.price, 100000000n);
  assert.equal(Buffer.from(received[0]!.batch.signedSolana).toString(), "signed-evidence");
  client.down();
  assert.equal(states.at(-1), "unavailable");
  client.restored();
  assert.equal(states.at(-1), "starting");
  handle.stop(); handle.stop();
  client.message(update());
  assert.equal(client.stopped, 1);
  assert.equal(received.length, 1);
});

test("Pyth validates external payload completeness, numeric precision and Solana bytes without authenticating JSON", () => {
  assert.throws(() => parsePythProUpdate({}, catalogue, 7, 10n), /InvalidPythUpdate/);
  const input = update();
  if (input.type !== "json" || input.value.type !== "streamUpdated") throw new Error("fixture");
  const value = input.value;
  assert.throws(() => parsePythProUpdate({ ...input, value: { ...value,
    parsed: { ...value.parsed, priceFeeds: value.parsed!.priceFeeds.slice(0, 1) } } }, catalogue, 7, 10n), /IncompletePythUpdate/);
  assert.throws(() => parsePythProUpdate({ ...input, value: { ...value,
    parsed: { ...value.parsed, priceFeeds: [value.parsed!.priceFeeds[0], value.parsed!.priceFeeds[0]] } } }, catalogue, 7, 10n), /InvalidPythUpdate/);
  assert.throws(() => parsePythProUpdate({ ...input, value: { ...value,
    parsed: { ...value.parsed, priceFeeds: [{ ...value.parsed!.priceFeeds[0], confidence: Number.MAX_SAFE_INTEGER + 1 }, value.parsed!.priceFeeds[1]] } } }, catalogue, 7, 10n), /InvalidPythUpdate/);
  assert.throws(() => parsePythProUpdate({ ...input, value: { ...value, solana: { encoding: "base64", data: "%%%" } } }, catalogue, 7, 10n), /InvalidPythUpdate/);
  assert.equal(parsePythProUpdate(input, catalogue, 8, 10n), null);
  const binary = parsePythProUpdate({ type: "binary", value: { subscriptionId: 7,
    parsed: value.parsed, solana: Buffer.from("binary") } }, catalogue, 7, 10n);
  assert.equal(Buffer.from(binary!.batch.signedSolana).toString(), "binary");
  assert.throws(() => parsePythProUpdate(input, [...catalogue, catalogue[0]!], 7, 10n), /InvalidPythCatalogue/);
});

test("Pyth rejects stale carried constituents, future feed timestamps and missing feed metadata", () => {
  const input = update();
  if (input.type !== "json" || input.value.type !== "streamUpdated") throw new Error("fixture");
  const value = input.value;
  for (const feedUpdateTimestamp of [122999989, 123000001, null, undefined]) {
    const changed = { ...input, value: { ...value, parsed: { ...value.parsed, priceFeeds: [
      { ...value.parsed!.priceFeeds[0], feedUpdateTimestamp }, value.parsed!.priceFeeds[1],
    ] } } };
    assert.throws(() => parsePythProUpdate(changed, catalogue, 7, 10n), /StalePythFeed|InvalidPythUpdate/);
  }
  assert.throws(() => parsePythProUpdate({ ...input, value: { ...value, parsed: { ...value.parsed, priceFeeds: [
    { ...value.parsed!.priceFeeds[0], exponent: null }, value.parsed!.priceFeeds[1],
  ] } } }, catalogue, 7, 10n), /InvalidPythUpdate/);
});

test("Pyth sanitizes SDK failures and rejects subscription errors without leaking tokens", async () => {
  await assert.rejects(startPythPro({ token: "secret", catalogue, subscriptionId: 7, maxFeedAgeUs: 10n, onUpdate() {},
    createClient: async () => { throw new Error("secret https://token.example"); } }), /^Error: PythConnectionFailed$/);
  const client = new FakePyth();
  const states: FeedStatus[] = [];
  const handle = await startPythPro({ token: "secret", catalogue, subscriptionId: 7, maxFeedAgeUs: 10n, onUpdate() {},
    onStatus: (state) => states.push(state), createClient: async () => client });
  client.message({ type: "json", value: { type: "subscriptionError", subscriptionId: 7, error: "secret" } });
  assert.equal(states.at(-1), "invalid-update");
  handle.stop();
});

test("Pyth abort closes the SDK and ignores later callbacks", async () => {
  const client = new FakePyth();
  const controller = new AbortController();
  const handle = await startPythPro({ token: "secret", catalogue, subscriptionId: 7, maxFeedAgeUs: 10n, signal: controller.signal,
    onUpdate() { assert.fail("received after abort"); }, createClient: async () => client });
  controller.abort();
  client.message(update());
  handle.stop();
  assert.equal(client.stopped, 1);
});

test("gRPC filters relevant programs, requests processed updates and tracks all slot commitments", () => {
  const request = publisherSubscription([program, program]);
  assert.equal(request.commitment, 0);
  assert.deepEqual(request.transactions.predictions?.accountInclude, [program.toBase58()]);
  assert.equal(request.transactions.predictions?.failed, false);
  assert.equal(request.slots.progress?.filterByCommitment, false);
  assert.deepEqual(request.blocks, {});
  assert.throws(() => publisherSubscription([]), /MissingProgramFilter/);
});

test("gRPC buffers bursts, propagates bank recovery, and cancels buffered wakes when stopped", async () => {
  const fake = fakeGrpc();
  const wakes: ChainWake[] = [];
  const states: FeedStatus[] = [];
  const handle = await startAlchemyGrpc({ endpoint: "https://example.com", programIds: [program],
    createClient: fake.createClient, onWake: (wake) => wakes.push(wake), onStatus: (state) => states.push(state) });
  assert.equal(states.includes("streaming"), false);
  for (let i = 1; i <= 100; i++) fake.stream.emit("data", chainEvent({ slot: { slot: String(i), status: 0 } }));
  fake.stream.emit("data", { type: "DiscardBanks", banks: [], reason: "IncompleteDelivery",
    replacement: { fromSlot: "90", generation: "2" }, winners: [] } satisfies ReconnectEvent);
  await tick();
  assert.deepEqual(wakes, [{ transaction: false, slot: true, reconcile: true, latestSlot: 100n }]);
  fake.stream.emit("data", chainEvent({ transactionStatus: { slot: "101", signature: new Uint8Array(64),
    isVote: false, index: "0", err: undefined, bankId: "1" } }, "2"));
  await tick();
  assert.equal(wakes[1]?.transaction, true);
  assert.equal(wakes[1]?.reconcile, true);
  fake.stream.emit("data", chainEvent({ slot: { slot: "102", status: 2 } }, "2"));
  handle.stop(); handle.stop();
  await tick();
  assert.equal(wakes.length, 2);
  assert.equal(fake.stream.destroyed, true);
});

test("gRPC errors trigger reconciliation without claiming a successful subscription or exposing credentials", async () => {
  await assert.rejects(startAlchemyGrpc({ endpoint: "http://example.com/secret", programIds: [program], onWake() {} }), /InvalidGrpcEndpoint/);
  await assert.rejects(startAlchemyGrpc({ endpoint: "https://example.com/secret", programIds: [program], onWake() {},
    createClient: () => ({ async connect() {}, async subscribeWithReconnect() { throw new Error("secret code12"); } }) }), /^Error: GrpcSubscriptionFailed$/);
  const fake = fakeGrpc();
  const wakes: ChainWake[] = [];
  const states: FeedStatus[] = [];
  const handle = await startAlchemyGrpc({ endpoint: "https://example.com/secret", programIds: [program],
    createClient: fake.createClient, onWake: (wake) => wakes.push(wake), onStatus: (state) => states.push(state) });
  fake.stream.emit("error", new Error("secret code12 /geyser.Geyser/Subscribe not found"));
  await tick();
  assert.equal(states.includes("streaming"), false);
  assert.equal(states.at(-1), "unavailable");
  assert.equal(wakes[0]?.reconcile, true);
  handle.stop();
});
