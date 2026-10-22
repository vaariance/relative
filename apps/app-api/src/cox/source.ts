import type { CoxAsset, CoxDeployment, CoxStatus, CryptoComposition, Portfolio, Publication } from "@eox/app-api";

export interface CoxSource {
  deployment(): Promise<CoxDeployment>;
  status(now: number): Promise<CoxStatus>;
  assets(now: number): Promise<CoxAsset[]>;
  crypto(): Promise<CryptoComposition>;
  latest(now: number): Promise<Publication | null>;
  publication(sequence: number, now: number): Promise<Publication | null>;
  publications(now: number, after: number | null, limit: number): Promise<readonly Publication[]>;
  portfolio(owner: string): Promise<Portfolio | null>;
  onPublication(listener: (publication: Publication) => void): () => void;
  onChainRefresh?(listener: () => void): () => void;
}
