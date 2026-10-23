import assert from "node:assert/strict";
import { test } from "node:test";
import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { checkFaucetPolicy, type DevnetFaucetBinding } from "../src/faucet-policy.js";
import { PolicyRejection } from "../src/policy-errors.js";
import type { PolicyTransaction } from "../src/solana.js";

const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const signer = Keypair.generate().publicKey;
const user = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const associated = (owner: PublicKey, token = mint) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), token.toBuffer()], ASSOCIATED)[0];
const source = associated(signer);
const destination = associated(user);
const binding: DevnetFaucetBinding = { mint: mint.toBase58(), sourceTokenAccount: source.toBase58(), decimals: 6, maxTokenAmount: "100000000", maxSolLamports: "10000000" };
const create = (owner = user, target = associated(owner)) => new TransactionInstruction({ programId: ASSOCIATED, keys: [
  { pubkey: signer, isSigner: true, isWritable: true }, { pubkey: target, isSigner: false, isWritable: true },
  { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false },
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: TOKEN, isSigner: false, isWritable: false },
], data: Buffer.from([1]) });
const transfer = (amount = 100000000n, target = destination) => {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(amount, 1);
  data[9] = 6;
  return new TransactionInstruction({ programId: TOKEN, keys: [
    { pubkey: source, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: target, isSigner: false, isWritable: true }, { pubkey: signer, isSigner: true, isWritable: false },
  ], data });
};
const sol = (owner = user, lamports = 10000000) => SystemProgram.transfer({ fromPubkey: signer, toPubkey: owner, lamports });
const transaction = (instructions: TransactionInstruction[], legacy = false, tables: AddressLookupTableAccount[] = []) => {
  const builder = new TransactionMessage({ payerKey: signer, recentBlockhash: PublicKey.default.toBase58(), instructions });
  return new VersionedTransaction(legacy ? builder.compileToLegacyMessage() : builder.compileToV0Message(tables));
};
const reject = (instructions: TransactionInstruction[], bound = binding) => assert.throws(() => checkFaucetPolicy(bound, transaction(instructions), signer), error => error instanceof PolicyRejection);
const clone = (instruction: TransactionInstruction) => new TransactionInstruction({ programId: instruction.programId, keys: instruction.keys.map(key => ({ ...key })), data: Buffer.from(instruction.data) });

test("faucet permits canonical legacy/v0 token grants with optional same-recipient SOL", () => {
  for (const legacy of [false, true]) {
    checkFaucetPolicy(binding, transaction([create(), transfer()], legacy), signer);
    checkFaucetPolicy(binding, transaction([ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), create(), transfer(), sol()], legacy), signer);
    checkFaucetPolicy(binding, transaction([create(), transfer(1n), sol(user, 1)], legacy), signer);
  }
});

test("faucet refuses aggregate-cap bypass using repeated token or SOL transfers", () => {
  reject([create(), transfer(60000000n), transfer(60000000n)]);
  reject([create(), transfer(), sol(user, 6000000), sol(user, 6000000)]);
  reject([create(), create(), transfer()]);
});

test("faucet requires exactly one positive bounded checked transfer and canonical instruction order", () => {
  for (const amount of [0n, 100000001n]) reject([create(), transfer(amount)]);
  reject([create()]);
  reject([transfer()]);
  reject([transfer(), create()]);
  reject([create(), sol(), transfer()]);
  reject([create(), transfer(), ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 })]);
  const unchecked = transfer();
  unchecked.data[0] = 3;
  reject([create(), unchecked]);
  const decimals = transfer();
  decimals.data[9] = 9;
  reject([create(), decimals]);
  const padded = transfer();
  padded.data = Buffer.concat([padded.data, Buffer.from([0])]);
  reject([create(), padded]);
});

test("faucet binds mint, canonical source, recipient ATA and SOL recipient", () => {
  reject([create(), transfer(1n, Keypair.generate().publicKey)]);
  reject([create(user, Keypair.generate().publicKey), transfer()]);
  reject([create(), transfer(), sol(Keypair.generate().publicKey)]);
  reject([create(signer), transfer(1n, source)]);
  reject([create(), transfer(1n, source)]);
  for (const index of [0, 1, 3]) {
    const changed = transfer();
    changed.keys[index]!.pubkey = Keypair.generate().publicKey;
    reject([create(), changed]);
  }
  const otherProgram = transfer();
  otherProgram.programId = Keypair.generate().publicKey;
  reject([create(), otherProgram]);
});

test("faucet permits only idempotent ATA creation with exact accounts", () => {
  for (const index of [0, 2, 3, 4, 5]) {
    const changed = create();
    changed.keys[index]!.pubkey = Keypair.generate().publicKey;
    reject([changed, transfer()]);
  }
  const nonIdempotent = create();
  nonIdempotent.data = Buffer.alloc(0);
  reject([nonIdempotent, transfer()]);
  const additional = create();
  additional.keys.push({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false });
  reject([additional, transfer()]);
  reject([create(PublicKey.findProgramAddressSync([Buffer.from("offcurve")], ASSOCIATED)[0]), transfer()]);
});

test("faucet rejects extra signers, multisig accounts and unexpected writable privilege", () => {
  const multisig = transfer();
  multisig.keys.push({ pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: false });
  reject([create(), multisig]);
  const extra = transfer();
  extra.keys.push({ pubkey: user, isSigner: false, isWritable: false });
  reject([create(), extra]);
  for (const instruction of [create(), transfer()]) {
    const changed = clone(instruction);
    changed.keys.find(key => key.pubkey.equals(mint))!.isWritable = true;
    reject(instruction.programId.equals(ASSOCIATED) ? [changed, transfer()] : [create(), changed]);
  }
  const programWritable = create();
  programWritable.keys.find(key => key.pubkey.equals(TOKEN))!.isWritable = true;
  reject([programWritable, transfer()]);
  const userWritable = create();
  userWritable.keys[2]!.isWritable = true;
  reject([userWritable, transfer()]);
});

test("faucet bounds compute settings and rejects duplicate, heap or account-bearing compute", () => {
  const units = ComputeBudgetProgram.setComputeUnitLimit({ units: 200001 });
  reject([units, create(), transfer()]);
  reject([ComputeBudgetProgram.setComputeUnitLimit({ units: 0 }), create(), transfer()]);
  reject([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1001 }), create(), transfer()]);
  reject([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), create(), transfer()]);
  reject([ComputeBudgetProgram.requestHeapFrame({ bytes: 32768 }), create(), transfer()]);
  reject([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2 }), create(), transfer()]);
  const withAccount = ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 });
  withAccount.keys.push({ pubkey: user, isSigner: false, isWritable: false });
  reject([withAccount, create(), transfer()]);
});

test("faucet rejects SOL-only, zero/excess SOL and other system operations", () => {
  reject([sol()]);
  reject([create(), transfer(), sol(user, 0)]);
  reject([create(), transfer(), sol(user, 10000001)]);
  reject([create(), transfer(), SystemProgram.assign({ accountPubkey: signer, programId: user })]);
  reject([create(), transfer(), sol()], { ...binding, maxSolLamports: "0" });
});

test("faucet refuses malformed or escalated configuration even when transaction is otherwise valid", () => {
  for (const bad of [
    { ...binding, sourceTokenAccount: destination.toBase58() }, { ...binding, decimals: 9 },
    { ...binding, maxTokenAmount: "100000001" }, { ...binding, maxTokenAmount: "0" },
    { ...binding, maxSolLamports: "10000001" }, { ...binding, maxSolLamports: "-1" },
    { ...binding, maxTokenAmount: "01" }, { ...binding, mint: "invalid" },
    { ...binding, mint: "So11111111111111111111111111111111111111112" },
  ]) reject([create(), transfer()], bad);
});

test("faucet rejects lookup tables, V1, unused keys and malformed compiled accounts", () => {
  const table = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: 18446744073709551615n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [destination] } });
  assert.throws(() => checkFaucetPolicy(binding, transaction([create(), transfer()], false, [table]), signer), PolicyRejection);
  assert.throws(() => checkFaucetPolicy(binding, { version: 1 } as PolicyTransaction, signer), PolicyRejection);
  const unused = transaction([create(), transfer()]);
  unused.message.staticAccountKeys.push(Keypair.generate().publicKey);
  assert.throws(() => checkFaucetPolicy(binding, unused, signer), PolicyRejection);
  const malformed = transaction([create(), transfer()]);
  malformed.message.compiledInstructions[1]!.accountKeyIndexes[0] = 255;
  assert.throws(() => checkFaucetPolicy(binding, malformed, signer), PolicyRejection);
  const wrongPayer = Keypair.generate().publicKey;
  assert.throws(() => checkFaucetPolicy(binding, transaction([create(), transfer()]), wrongPayer), PolicyRejection);
});
