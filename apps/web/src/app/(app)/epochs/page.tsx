import { EpochsView } from "@/components/epochs-view";
import { getAssets, getEpochs } from "@/lib/data";

export default async function EpochsPage() {
  const [overview, assets] = await Promise.all([getEpochs(), getAssets()]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-title font-semibold tracking-tight">Epochs</h1>
        <p className="max-w-2xl text-sm text-muted">
          Four-hour rounds. Pick the coin you think will gain the most against $CRYPTO and stake USDC on it. When the round closes, the coins that rose share the pot.
        </p>
      </div>
      {overview ? (
        <EpochsView overview={overview} roster={assets.map((asset) => asset.assetId)} />
      ) : (
        <section className="rounded-card border border-line bg-surface p-6 text-sm text-muted shadow-card">Epochs are not available right now.</section>
      )}
    </div>
  );
}
