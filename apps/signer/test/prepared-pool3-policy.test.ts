import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import { loadSignerConfig } from "../src/config.js";
import { checkSolanaPolicy, PolicyRejection } from "../src/policy.js";
import { parseSolanaTransaction } from "../src/solana.js";
const require = createRequire(import.meta.url);
const { compileTransaction, getTransactionEncoder } = require("@solana/transactions");
const { setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } = require("@solana/transaction-messages");
const config = loadSignerConfig(new URL("../config/dev-prepared-pool3.json", import.meta.url).pathname);
const binding = structuredClone(config.bindings["oracle-operator"]!);
const program = binding.solana!.programs.find(value => value.linkage?.kind === "cox-dynamic-v1")!;
assert(program.linkage?.kind === "cox-dynamic-v1");
const operator = program.linkage.operator;
const idl = JSON.parse(readFileSync(new URL("../../../packages/cox/idl/cox.json", import.meta.url), "utf8")) as {
  instructions: { name: string; discriminator: number[]; accounts: { name: string; writable?: boolean; signer?: boolean }[] }[];
};
const fake = (name: string) => new PublicKey(createHash("sha256").update(`prepared-policy:${name}`).digest()).toBase58();
function instruction(name: string) {
  const definition = idl.instructions.find(value => value.name === name)!;
  const rule = program.instructions!.find(value => value.discriminator === Buffer.from(definition.discriminator).toString("hex"))!;
  assert(rule);
  return { programAddress: program.programId, data: Buffer.from(definition.discriminator), accounts: definition.accounts.map((account, index) => {
    const fixed = rule.accounts[String(index)];
    return { address: fixed === "$signer" ? operator : fixed ?? fake(account.name), role: account.signer ? account.writable ? 3 : 2 : account.writable ? 1 : 0 };
  }) };
}
function transaction(instructions: ReturnType<typeof instruction>[]) {
  const message = setTransactionMessageFeePayer(operator, { version: 1, config: { computeUnitLimit: 1400000, heapSize: 262144, priorityFeeLamports: 100n, loadedAccountsDataSizeLimit: 67108864 }, instructions });
  const timed = setTransactionMessageLifetimeUsingBlockhash({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100n }, message);
  return parseSolanaTransaction(Buffer.from(getTransactionEncoder().encode(compileTransaction(timed))).toString("base64"));
}
const enabled = () => { const value = structuredClone(binding); value.solana!.programs.forEach(program => { program.enabled = true; }); return value; };
test("current-pool policy permits combined handoff privileges and remains disabled by default", () => {
  for (const names of [["begin_dynamic_publication", "begin_universe_handoff"], ["begin_dynamic_publication", "begin_universe_handoff", "append_dynamic_prices"], ["append_universe_handoff_prices", "append_universe_handoff_prices"], ["finalize", "activate_prepared_universe"]]) {
    const tx = transaction(names.map(instruction));
    assert.doesNotThrow(() => checkSolanaPolicy("oracle-operator", enabled(), tx, new PublicKey(operator)));
    assert.throws(() => checkSolanaPolicy("oracle-operator", binding, tx, new PublicKey(operator)), PolicyRejection);
  }
});
test("combined handoff denies writable methodology and a different pool", () => {
  const instructions = [instruction("finalize"), instruction("activate_prepared_universe")];
  const writable = structuredClone(instructions);
  writable[1]!.accounts[4]!.role = 1;
  assert.throws(() => checkSolanaPolicy("oracle-operator", enabled(), transaction(writable), new PublicKey(operator)), PolicyRejection);
  const foreign = structuredClone(instructions);
  foreign[1]!.accounts[2]!.address = fake("foreign-pool");
  assert.throws(() => checkSolanaPolicy("oracle-operator", enabled(), transaction(foreign), new PublicKey(operator)), PolicyRejection);
});
