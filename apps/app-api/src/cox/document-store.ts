import { setTimeout as sleep } from "node:timers/promises";

const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const DATABASE = /^(\(default\)|[a-z][a-z0-9-]{2,61}[a-z0-9])$/;
const PATH = /^[A-Za-z][A-Za-z0-9_-]{0,99}\/[A-Za-z0-9._-]{1,200}$/;
const ATTEMPTS = 6;

export interface DocumentTransaction {
  get<T>(path: string): Promise<T | null>;
  set(path: string, value: unknown, expireAt: number): void;
  delete(path: string): void;
}

export interface DocumentStore {
  get<T>(path: string): Promise<T | null>;
  transact<T>(work: (tx: DocumentTransaction) => Promise<T>): Promise<T>;
}

export class TransactionConflict extends Error {
  constructor() {
    super("document transaction kept conflicting");
    this.name = "TransactionConflict";
  }
}

export function checkPath(path: string): string {
  if (!PATH.test(path)) throw new Error(`invalid document path: ${path}`);
  return path;
}

type Write = { update: { name: string; fields: Record<string, unknown> } } | { delete: string };

export class FirestoreDocumentStore implements DocumentStore {
  private readonly name: string;
  private readonly base: string;

  constructor(
    project: string,
    database: string,
    private readonly token: () => Promise<string>,
    private readonly request: typeof fetch = fetch,
  ) {
    if (!PROJECT.test(project)) throw new Error(`invalid Firestore project id: ${project}`);
    if (!DATABASE.test(database)) throw new Error(`invalid Firestore database: ${database}`);
    this.name = `projects/${project}/databases/${database}/documents`;
    this.base = `https://firestore.googleapis.com/v1/${this.name}`;
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    return this.request(url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${await this.token()}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  }

  private async read<T>(path: string, transaction: string | null): Promise<T | null> {
    const query = transaction ? `?transaction=${encodeURIComponent(transaction)}` : "";
    const response = await this.call(`${this.base}/${checkPath(path)}${query}`, { method: "GET" });
    if (response.status === 404) return null;
    if (response.status === 409) throw new Conflict();
    if (!response.ok) throw new Error(`Firestore read failed: ${response.status}`);
    const body = (await response.json()) as { fields?: { entry?: { stringValue?: string } } };
    const text = body.fields?.entry?.stringValue;
    if (text === undefined) throw new Error(`document ${path} has no entry`);
    return JSON.parse(text) as T;
  }

  get<T>(path: string): Promise<T | null> {
    return this.read<T>(path, null);
  }

  async transact<T>(work: (tx: DocumentTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const begun = await this.call(`${this.base}:beginTransaction`, { method: "POST", body: JSON.stringify({ options: { readWrite: {} } }) });
      if (!begun.ok) throw new Error(`Firestore transaction failed to start: ${begun.status}`);
      const { transaction } = (await begun.json()) as { transaction: string };
      const writes = new Map<string, Write>();
      const tx: DocumentTransaction = {
        get: <V>(path: string) => this.read<V>(path, transaction),
        set: (path, value, expireAt) => {
          writes.set(checkPath(path), {
            update: {
              name: `${this.name}/${path}`,
              fields: { entry: { stringValue: JSON.stringify(value) }, expireAt: { timestampValue: new Date(expireAt * 1000).toISOString() } },
            },
          });
        },
        delete: (path) => {
          writes.set(checkPath(path), { delete: `${this.name}/${path}` });
        },
      };
      let result: T;
      try {
        result = await work(tx);
      } catch (error) {
        await this.call(`${this.base}:rollback`, { method: "POST", body: JSON.stringify({ transaction }) }).catch(() => undefined);
        if (error instanceof Conflict) {
          await sleep(50 * 2 ** attempt);
          continue;
        }
        throw error;
      }
      const committed = await this.call(`${this.base}:commit`, { method: "POST", body: JSON.stringify({ writes: [...writes.values()], transaction }) });
      if (committed.ok) return result;
      if (committed.status !== 409) throw new Error(`Firestore commit failed: ${committed.status}`);
      await sleep(50 * 2 ** attempt);
    }
    throw new TransactionConflict();
  }
}

class Conflict extends Error {}
