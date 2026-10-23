import { EpochsView } from "@/components/epochs-view";
import { getAssets, getEpochs } from "@/lib/data";

export default async function EpochsPage() {
  const [overview, assets] = await Promise.all([getEpochs(), getAssets()]);

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-display text-title font-semibold tracking-tight">Epochs</h1>
      {overview ? (
        <EpochsView overview={overview} roster={assets.map((asset) => asset.assetId)} serverNow={Math.floor(Date.now() / 1000)} />
      ) : (
        <section className="rounded-card border border-line bg-surface p-6 text-sm text-muted shadow-card">Epochs are not available right now.</section>
      )}
    </div>
  );
}
