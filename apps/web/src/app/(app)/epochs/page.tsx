import { Timer } from "lucide-react";
import { EpochsView } from "@/components/epochs-view";
import { epochsEnabled } from "@/lib/config";
import { getAssets, getEpochs } from "@/lib/data";

function ComingSoon() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-title font-semibold tracking-tight">Epochs</h1>
      <section className="flex flex-col items-center gap-3 rounded-card border border-line bg-surface px-6 py-16 text-center shadow-card">
        <Timer size={32} aria-hidden="true" className="text-accent" />
        <h2 className="text-lg font-semibold">Coming soon</h2>
        <p className="max-w-md text-sm text-muted">Four-hour performance predictions. Back one coin against $CRYPTO and share the pot when the round closes.</p>
      </section>
    </div>
  );
}

export default async function EpochsPage() {
  if (!epochsEnabled()) return <ComingSoon />;

  const [overview, assets] = await Promise.all([getEpochs(), getAssets()]);
  if (!overview) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-display text-title font-semibold tracking-tight">Epochs</h1>
        <section className="rounded-card border border-line bg-surface p-6 text-sm text-muted shadow-card">Epochs are not available right now.</section>
      </div>
    );
  }

  return <EpochsView overview={overview} roster={assets.map((asset) => asset.assetId)} serverNow={Math.floor(Date.now() / 1000)} />;
}
