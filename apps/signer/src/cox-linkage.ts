import type { PolicyTransaction } from "./solana.js";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import type { CoxLinkage, SolanaProgramBinding } from "./config.js";
import { PolicyRejection } from "./policy.js";

export interface ChainAccount {
  owner: PublicKey;
  data: Buffer;
}

export type AccountFetcher = (keys: PublicKey[]) => Promise<(ChainAccount | null)[]>;

const HEADER = 8 + 2 + 1;
const discriminator = (prefix: string, name: string) => createHash("sha256").update(`${prefix}:${name}`).digest().subarray(0, 8).toString("hex");
const INSTRUCTION = Object.fromEntries(
  ["publish", "evaluate", "safety", "seal_evaluation", "execute", "finalize"].map((name) => [discriminator("global", name), name]),
) as Record<string, string>;
const REQUEST = discriminator("account", "Request");
const REQUEST_SCHEMAS = new Set([1, 2]);

const deny = (message: string): never => {
  throw new PolicyRejection("TARGET_NOT_BOUND", message);
};

function u64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

export async function checkCoxLinkage(binding: SolanaProgramBinding, linkage: CoxLinkage, transaction: PolicyTransaction, fetch: AccountFetcher): Promise<void> {
  const program = new PublicKey(binding.programId);
  const pool = new PublicKey(linkage.pool);
  const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program)[0];
  if (!pda(Buffer.from("pool"), u64(BigInt(linkage.poolId))).equals(pool)) deny(`pool ${linkage.pool} is not pool ${linkage.poolId} of ${binding.programId}`);
  const batchAccount = pda(Buffer.from("batch"), pool.toBuffer());
  const publicationAccount = pda(Buffer.from("publication"), pool.toBuffer());
  const message = transaction.message;

  async function request(key: PublicKey): Promise<Buffer> {
    const [account] = await fetch([key]);
    if (!account) return deny(`request account ${key.toBase58()} does not exist`);
    if (!account.owner.equals(program)) deny(`request account ${key.toBase58()} is not owned by the COX program`);
    if (account.data.length < HEADER + 72 || account.data.subarray(0, 8).toString("hex") !== REQUEST) deny(`${key.toBase58()} is not a request account`);
    const schema = account.data.readUInt16LE(8);
    if (!REQUEST_SCHEMAS.has(schema)) deny(`request ${key.toBase58()} has unsupported schema ${schema}`);
    if (!new PublicKey(account.data.subarray(HEADER, HEADER + 32)).equals(pool)) deny(`request ${key.toBase58()} belongs to another pool`);
    return account.data;
  }

  function methodology(account: PublicKey): void {
    if (linkage.methodology === null) deny("no sealed methodology is bound");
    if (!account.equals(new PublicKey(linkage.methodology!))) deny(`methodology ${account.toBase58()} is not the bound methodology`);
  }

  function batch(account: PublicKey): void {
    if (!account.equals(batchAccount)) deny(`batch ${account.toBase58()} is not the pool's batch account ${batchAccount.toBase58()}`);
  }

  for (const instruction of message.compiledInstructions) {
    if (!message.staticAccountKeys[instruction.programIdIndex]!.equals(program)) continue;
    const data = Buffer.from(instruction.data);
    const name = INSTRUCTION[data.subarray(0, 8).toString("hex")];
    if (!name) deny("instruction is not a COX runtime instruction");
    const account = (index: number): PublicKey => {
      const key = message.staticAccountKeys[instruction.accountKeyIndexes[index]!];
      return key ?? deny(`${name} is missing account ${index}`);
    };
    if (name === "publish") {
      methodology(account(4));
      batch(account(5));
    } else if (name === "seal_evaluation") {
      batch(account(2));
    } else if (name === "finalize") {
      batch(account(3));
      methodology(account(4));
      if (!account(5).equals(publicationAccount)) deny(`finalize publication is not the pool's publication account ${publicationAccount.toBase58()}`);
    } else {
      batch(account(2));
      const stored = await request(account(3));
      const nonce = stored.readBigUInt64LE(HEADER + 64);
      if (!pda(Buffer.from("request"), pool.toBuffer(), u64(nonce)).equals(account(3))) deny(`request ${account(3).toBase58()} is not the PDA of nonce ${nonce}`);
      const owner = stored.subarray(HEADER + 32, HEADER + 64);
      if (!pda(Buffer.from("position"), pool.toBuffer(), owner).equals(account(4))) deny(`position ${account(4).toBase58()} is not the request owner's position`);
    }
  }
}
