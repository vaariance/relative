import { PublicKey } from "@solana/web3.js";
import type { AccountFetcher, ChainAccount } from "./cox-linkage.js";
import type { DevnetFaucetBinding } from "./faucet-policy.js";
import type { PolicyTransaction } from "./solana.js";
import { PolicyRejection } from "./policy-errors.js";

const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const deny = (message: string): never => { throw new PolicyRejection("TARGET_NOT_BOUND", message); };

export async function checkFaucetAccounts(binding: DevnetFaucetBinding, transaction: PolicyTransaction, signer: PublicKey, fetch: AccountFetcher): Promise<void> {
  const mint = new PublicKey(binding.mint), source = new PublicKey(binding.sourceTokenAccount);
  const message = transaction.message;
  const create = message.compiledInstructions.find(ix => message.staticAccountKeys[ix.programIdIndex]!.equals(ASSOCIATED));
  if (!create) deny("faucet destination owner is missing");
  const destination = message.staticAccountKeys[create!.accountKeyIndexes[1]!]!;
  const recipient = message.staticAccountKeys[create!.accountKeyIndexes[2]!]!;
  const accounts = await fetch([mint, source, destination]);
  const mintAccount = accounts[0];
  if (accounts.length !== 3 || !mintAccount?.owner.equals(TOKEN) || mintAccount.data.length !== 82 || mintAccount.data[44] !== 6 || mintAccount.data[45] !== 1) deny("faucet mint is not initialized six-decimal legacy SPL");
  const checkToken = (account: ChainAccount | null | undefined, owner: PublicKey, treasury: boolean): Buffer => {
    if (!account?.owner.equals(TOKEN) || account.data.length !== 165 || !new PublicKey(account.data.subarray(0, 32)).equals(mint)
      || !new PublicKey(account.data.subarray(32, 64)).equals(owner) || account.data[108] !== 1) deny("faucet token account identity or state mismatch");
    const data = account!.data;
    if (data.readUInt32LE(109) !== 0) deny("wrapped native collateral is forbidden");
    if (treasury && (data.readUInt32LE(72) !== 0 || data.readBigUInt64LE(121) !== 0n || data.readUInt32LE(129) !== 0)) deny("faucet treasury must have no delegate or close authority");
    return data;
  };
  const treasury = checkToken(accounts[1], signer, true);
  const transfer = message.compiledInstructions.find(ix => message.staticAccountKeys[ix.programIdIndex]!.equals(TOKEN));
  if (!transfer || treasury.readBigUInt64LE(64) < Buffer.from(transfer.data).readBigUInt64LE(1)) deny("faucet treasury has insufficient tokens");
  if (accounts[2]) checkToken(accounts[2], recipient, false);
}
