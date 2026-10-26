import { notFound } from "next/navigation";
import { BasketView } from "@/components/epoch-flow";
import { epochsEnabled } from "@/lib/config";
import { getAssets, getEpochs } from "@/lib/data";

export default async function EpochBasketPage() {
  if (!epochsEnabled()) notFound();
  const [read, roster] = await Promise.all([getEpochs(), getAssets().then((assets) => assets.map((item) => item.assetId)).catch(() => [])]);
  if (!read || read.overview.epochs.length === 0) notFound();
  return <BasketView overview={read.overview} roster={roster} serverNow={Math.floor(Date.now() / 1000)} />;
}
