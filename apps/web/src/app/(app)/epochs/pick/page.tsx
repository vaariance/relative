import { notFound } from "next/navigation";
import { PickPerformerView } from "@/components/epoch-flow";
import { epochsEnabled } from "@/lib/config";
import { getAssets, getEpochs } from "@/lib/data";

export default async function EpochPickPage() {
  if (!epochsEnabled()) notFound();
  const [read, roster] = await Promise.all([getEpochs(), getAssets().then((assets) => assets.map((item) => item.assetId)).catch(() => [])]);
  if (!read || read.overview.epochs.length === 0) notFound();
  return <PickPerformerView overview={read.overview} roster={roster} serverNow={Math.floor(Date.now() / 1000)} />;
}
