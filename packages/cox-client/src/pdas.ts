import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import { bytes32, integer } from "./wire.ts";

export const PROGRAM_ID = new PublicKey("G6iQGoupNSfduw1QJxQ9vcVi9FnCC6cbippXsi4QQzJF");
export function addresses(programId: PublicKey = PROGRAM_ID) {
  const derive = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
  return {
    registry: () => derive(Buffer.from("registry")),
    methodology: (digest: Uint8Array) => derive(Buffer.from("methodology"), bytes32(digest)),
    pool: (poolId: bigint) => derive(Buffer.from("pool"), integer(poolId, 8)),
    vault: (pool: PublicKey) => derive(Buffer.from("vault"), pool.toBytes()),
    retirement: (pool: PublicKey) => derive(Buffer.from("retirement"), pool.toBytes()),
    position: (pool: PublicKey, owner: PublicKey) => derive(Buffer.from("position"), pool.toBytes(), owner.toBytes()),
    request: (pool: PublicKey, nonce: bigint) => derive(Buffer.from("request"), pool.toBytes(), integer(nonce, 8)),
    batch: (pool: PublicKey) => derive(Buffer.from("batch"), pool.toBytes()),
    publication: (pool: PublicKey) => derive(Buffer.from("publication"), pool.toBytes())
  };
}
