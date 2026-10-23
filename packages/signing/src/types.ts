export const SIGNING_SCHEMA_VERSION = "eox.signing/v1";

export const SIGNING_ROLES = ["oracle-operator", "devnet-faucet"] as const;
export type SigningRole = (typeof SIGNING_ROLES)[number];

export type SigningChain = "solana";
export type Chain = "solana" | "evm";
export type KeyAlgorithm = "ed25519" | "secp256k1";
export type Environment = "dev" | "testnet" | "mainnet";
export type KeyState = "pending" | "active" | "retired" | "revoked";
export type UnixSeconds = number;

export const ROLE_CHAINS: Readonly<Record<SigningRole, SigningChain>> = {
  "oracle-operator": "solana",
  "devnet-faucet": "solana",
};

export const CHAIN_ALGORITHMS: Readonly<Record<Chain, KeyAlgorithm>> = {
  solana: "ed25519",
  evm: "secp256k1",
};

export interface KeyDirectoryEntry {
  role: string;
  environment: Environment;
  chain: Chain;
  network: string;
  algorithm: KeyAlgorithm;
  publicKey: string;
  address: string;
  keyVersion: string;
  state: KeyState;
  validFrom: UnixSeconds;
  validUntil: UnixSeconds | null;
}

export interface KeyDirectory {
  schemaVersion: typeof SIGNING_SCHEMA_VERSION;
  environment: Environment;
  version: number;
  generatedAt: UnixSeconds;
  entries: KeyDirectoryEntry[];
}

export interface OperationIdentity {
  operationId: string;
  kind: string;
}

interface SignRequestBase {
  requestId: string;
  role: SigningRole;
  keyVersion: string;
  network: string;
  operation: OperationIdentity;
  expiresAt: UnixSeconds;
}

export interface SignSolanaTransactionRequest extends SignRequestBase {
  chain: "solana";
  transactionBase64: string;
}

export type SignRequest = SignSolanaTransactionRequest;

export type RejectionCode =
  | "UNAUTHENTICATED"
  | "ROLE_NOT_PERMITTED"
  | "KEY_NOT_ACTIVE"
  | "NETWORK_NOT_PERMITTED"
  | "TARGET_NOT_BOUND"
  | "OPERATION_NOT_PERMITTED"
  | "LIMIT_EXCEEDED"
  | "REQUEST_EXPIRED"
  | "REQUEST_ID_CONFLICT"
  | "INVALID_REQUEST"
  | "SIGNER_UNAVAILABLE";

export interface SignedResult {
  schemaVersion: typeof SIGNING_SCHEMA_VERSION;
  requestId: string;
  decision: "signed";
  payloadSha256: string;
  signer: { role: SigningRole; address: string; keyVersion: string };
  signature: string;
  signedTransaction: string;
  decidedAt: UnixSeconds;
}

export interface RejectedResult {
  schemaVersion: typeof SIGNING_SCHEMA_VERSION;
  requestId: string;
  decision: "rejected";
  payloadSha256: string | null;
  code: RejectionCode;
  reason: string;
  decidedAt: UnixSeconds;
}

export type SignResult = SignedResult | RejectedResult;

export interface RemoteSigner {
  getPublicKey(role: SigningRole): Promise<KeyDirectoryEntry>;
  keyDirectory(): Promise<KeyDirectory>;
  signSolanaTransaction(request: Omit<SignSolanaTransactionRequest, "chain">): Promise<SignResult>;
}
