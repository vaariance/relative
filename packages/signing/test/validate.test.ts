import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSignRequest, type SignRequest } from "../src/index.js";

const now = 1_900_000_000;
const solana: SignRequest = {
  chain: "solana",
  requestId: "req-0001-oracle",
  role: "oracle-operator",
  keyVersion: "oracle-operator/dev/1",
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  operation: { operationId: "batch-42/publish", kind: "cox-publish" },
  expiresAt: now + 60,
  transactionBase64: "AQIDBA==",
};

test("accepts a well-formed Solana request for the oracle operator", () => {
  validateSignRequest(solana, now);
});

test("refuses retired roles, EVM requests and EVM networks", () => {
  for (const role of ["uma-asserter", "uma-challenger", "oracle-checker", "evm-relayer", "solana-relayer"]) {
    assert.throws(() => validateSignRequest({ ...solana, role } as unknown as SignRequest, now), /unknown role/, role);
  }
  assert.throws(() => validateSignRequest({ ...solana, chain: "evm" } as unknown as SignRequest, now), /does not sign for evm/);
  assert.throws(() => validateSignRequest({ ...solana, network: "eip155:11155111" }, now), /invalid network/);
});

test("rejects expired requests, unknown roles and malformed fields", () => {
  assert.throws(() => validateSignRequest({ ...solana, expiresAt: now }, now), /request expired/);
  assert.throws(() => validateSignRequest({ ...solana, role: "admin" } as unknown as SignRequest, now), /unknown role/);
  assert.throws(() => validateSignRequest({ ...solana, requestId: "x" }, now), /invalid request id/);
  assert.throws(() => validateSignRequest({ ...solana, transactionBase64: "not base64!" }, now), /invalid Solana transaction bytes/);
  assert.throws(() => validateSignRequest({ ...solana, operation: { operationId: "", kind: "publish" } }, now), /missing operation identity/);
});

test("accepts a dedicated devnet faucet signing role", () => {
  validateSignRequest({ ...solana, role: "devnet-faucet", operation: { operationId: "claim-0001", kind: "devnet-faucet-claim" } }, now);
});
