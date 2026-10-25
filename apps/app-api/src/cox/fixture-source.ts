import { readFileSync } from "node:fs";
import {
  BATCH_SECONDS,
  batchFor,
  COX_TRANSFER_RULE,
  systemState,
  type ClassValuation,
  type CoxAsset,
  type CoxDeployment,
  type CoxStatus,
  type CryptoComposition,
  type FeeStatus,
  type FeeTerms,
  type Portfolio,
  type Publication,
} from "@eox/app-api";
import type { CoxSource } from "./source.js";

const FEE_FREE: FeeTerms = { version: "0", bps: 0, cap: "0" };
const FEE_STATUS: FeeStatus = { policy: null, migrated: false, active: FEE_FREE, scheduled: null, committed: "0" };

interface FixturePublication extends Omit<Publication, "identity" | "prices" | "receiptRoot" | "fees" | "flows" | "ledger"> {
  flows: Omit<Publication["flows"], "fees">;
  ledger: Omit<Publication["ledger"], "fees">;
  sequence: number;
  batch: number;
  predecessorSequence: number | null;
  predecessorBatch: number | null;
  missedBatches: number[];
  prices: { assetId: string; priceE8: string }[];
  classes: ClassValuation[];
}

interface FixtureFile {
  schema: "cox.app-api/fixture/v1";
  source: { oracle: string; oracleSha256: string; note: string };
  methodology: { digest: string | null; label: string; status: "draft"; assetCount: number };
  assets: { assetId: string; name: string; classIndex: number }[];
  publications: FixturePublication[];
  wallets: FixtureWallet[];
}

type FixtureRequest = Omit<Portfolio["requests"][number], "feeTerms" | "receipt"> & { receipt: Omit<NonNullable<Portfolio["requests"][number]["receipt"]>, "gross" | "fee"> | null };
type FixtureWallet = Omit<Portfolio, "appliedSequence" | "requests"> & { requests: FixtureRequest[] };

export class CoxFixtureSource implements CoxSource {
  private readonly fixture: FixtureFile;
  private readonly latestBatch: number;

  constructor(path: string) {
    this.fixture = JSON.parse(readFileSync(path, "utf8")) as FixtureFile;
    if (this.fixture.schema !== "cox.app-api/fixture/v1") throw new Error(`unsupported fixture schema ${this.fixture.schema}`);
    this.latestBatch = this.fixture.publications.at(-1)!.batch;
  }

  private origin(now: number): number {
    return Math.floor(now / BATCH_SECONDS) * BATCH_SECONDS - this.latestBatch * BATCH_SECONDS;
  }

  async deployment(): Promise<CoxDeployment> {
    return {
      origin: "fixture",
      network: "fixture",
      program: null,
      poolId: "0",
      poolAddress: null,
      collateralMint: null,
      collateralDecimals: null,
      secondaryCollateralMint: null,
      testCollateral: true,
      transferRule: COX_TRANSFER_RULE,
      methodology: this.fixture.methodology,
      mode: "minute",
      publicationIntervalSeconds: BATCH_SECONDS,
      tradingOpensAt: null,
      cryptoClass: null,
      generation: null,
      fixtureSource: `${this.fixture.source.oracle}@${this.fixture.source.oracleSha256.slice(0, 12)}: ${this.fixture.source.note}`,
    };
  }

  async latest(now: number): Promise<Publication | null> {
    return this.all(now).at(-1) ?? null;
  }

  async publication(sequence: number, now: number): Promise<Publication | null> {
    return this.all(now).find((p) => p.identity.sequence === sequence) ?? null;
  }

  async publications(now: number, after: number | null, limit: number): Promise<readonly Publication[]> {
    return this.all(now).filter((p) => after === null || p.identity.sequence > after).slice(0, limit);
  }

  private all(now: number): Publication[] {
    const origin = this.origin(now);
    return this.fixture.publications.map((p) => {
      const cutoff = origin + p.batch * BATCH_SECONDS;
      return {
        identity: {
          program: null,
          poolId: "0",
          sequence: p.sequence,
          batch: p.batch,
          predecessorSequence: p.predecessorSequence,
          predecessorBatch: p.predecessorBatch,
          missedBatches: p.missedBatches,
          cutoff,
          manifestDigest: this.fixture.methodology.digest,
          snapshotDigest: null,
          stateDigest: null,
          committedAt: cutoff + 20,
          finalization: { transaction: null, slot: null, finalized: true },
        },
        prices: p.prices.map((price) => ({ ...price, venue: "kraken", step: 1, candleStart: cutoff - BATCH_SECONDS, tradeAgeMinutes: 0 })),
        benchmarkGross: p.benchmarkGross,
        benchmark: p.benchmark,
        references: p.references,
        classes: p.classes,
        flows: { ...p.flows, fees: "0" },
        ledger: { ...p.ledger, fees: "0" },
        fees: null,
        receiptRoot: null,
      };
    });
  }

  async status(now: number): Promise<CoxStatus> {
    const latest = this.all(now).at(-1)!;
    const current = batchFor(now, this.origin(now));
    const missedCutoffs = Math.max(0, current.batch - latest.identity.batch - 1);
    return {
      asOf: now,
      latestSequence: latest.identity.sequence,
      latestBatch: latest.identity.batch,
      latestCutoff: latest.identity.cutoff,
      ageSeconds: now - latest.identity.cutoff,
      missedCutoffs,
      state: systemState(missedCutoffs, false, false),
      executing: false,
      monitor: null,
      reconciliation: { sequence: latest.identity.sequence, vault: latest.ledger.vault, ledger: latest.ledger.vault, fees: "0", covered: true },
      fees: FEE_STATUS,
      currentBatch: current,
      trading: { open: false, gate: "not-initialized", lifecycle: "active", opensAt: null },
    };
  }

  async assets(now: number): Promise<CoxAsset[]> {
    const latest = this.all(now).at(-1)!;
    return this.fixture.assets.map((asset) => {
      const price = latest.prices.find((p) => p.assetId === asset.assetId)!;
      return {
        assetId: asset.assetId,
        classIndex: asset.classIndex,
        name: asset.name,
        venues: { krakenWs: null, krakenRest: null, coinbase: null, bybit: null },
        latest: { sequence: latest.identity.sequence, batch: latest.identity.batch, priceE8: price.priceE8, venue: price.venue, step: price.step, tradeAgeMinutes: price.tradeAgeMinutes },
      };
    });
  }

  async crypto(): Promise<CryptoComposition> {
    const n = String(this.fixture.assets.length);
    return {
      label: this.fixture.methodology.label,
      methodologyDigest: this.fixture.methodology.digest,
      members: this.fixture.assets.map((a) => ({ assetId: a.assetId, weightNumerator: "1", weightDenominator: n })),
    };
  }

  async portfolio(owner: string): Promise<Portfolio | null> {
    const wallet = this.fixture.wallets.find((w) => w.owner === owner);
    if (!wallet) return null;
    return {
      ...wallet,
      appliedSequence: this.fixture.publications.at(-1)!.sequence,
      requests: wallet.requests.map((request) => ({ ...request, feeTerms: FEE_FREE, receipt: request.receipt ? { ...request.receipt, gross: null, fee: "0" } : null })),
    };
  }

  onPublication(): () => void {
    return () => {};
  }
}
