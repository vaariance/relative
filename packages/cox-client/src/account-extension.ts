import { Buffer } from "buffer";
import { BorshAccountsCoder, type Idl, type Program } from "@coral-xyz/anchor";

const coders = new WeakMap<Program, Map<string, BorshAccountsCoder>>();
function coder(program: Program, name: string, extension: string, header: boolean): BorshAccountsCoder {
  let cache = coders.get(program);
  if (!cache) { cache = new Map(); coders.set(program, cache); }
  const key = `${name}:${extension}:${header}`;
  let value = cache.get(key);
  if (!value) {
    const idl = structuredClone(program.idl) as Idl;
    const account = idl.types!.find(type => type.name === name)!;
    if (account.type.kind !== "struct" || !account.type.fields) throw new Error("InvalidExtensionLayout");
    const fields = account.type.fields;
    if (!fields.every((field): field is Extract<typeof field, { name: string }> => typeof field === "object" && "name" in field)) throw new Error("InvalidExtensionLayout");
    const field = fields.find(field => field.name === extension);
    if (!field || !("type" in field) || typeof field.type !== "object" || !("defined" in field.type)) throw new Error("InvalidExtensionLayout");
    if (header) {
      const nestedName = field.type.defined.name;
      const nested = idl.types!.find(type => type.name === nestedName)!;
      if (nested.type.kind !== "struct" || !nested.type.fields) throw new Error("InvalidExtensionLayout");
      nested.type.fields = nested.type.fields.slice(0, 1);
    } else {
      account.type.fields = fields.filter(field => field.name !== extension);
    }
    value = new BorshAccountsCoder(idl);
    cache.set(key, value);
  }
  return value;
}

export function decodeMarkedAccount(program: Program, name: string, data: Buffer, extension: string, magic: string): { account: Record<string, unknown>; marked: boolean } {
  const prefix = coder(program, name, extension, false).decode<Record<string, unknown>>(name, data);
  let header: Record<string, unknown>;
  try { header = coder(program, name, extension, true).decode<Record<string, unknown>>(name, data); }
  catch { return { account: prefix, marked: false }; }
  const marker = (header[extension] as { magic: number[] }).magic;
  if (!Buffer.from(marker).equals(Buffer.from(magic))) return { account: prefix, marked: false };
  const account = program.coder.accounts.decode<Record<string, unknown>>(name, data);
  return { account: Object.assign(account, account[extension]), marked: true };
}
