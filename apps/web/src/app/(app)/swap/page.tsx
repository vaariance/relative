import { SwapForm } from "@/components/swap-form";
import { getAssets, getDeployment, getStatus } from "@/lib/data";
import { CRYPTO_CLASS, decimalsOf } from "@/lib/view";

export default async function SwapPage() {
  const [assets, deployment, status] = await Promise.all([getAssets(), getDeployment(), getStatus()]);
  const decimals = decimalsOf(deployment);
  const classes = [...assets.map((asset) => asset.assetId), CRYPTO_CLASS];

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-6">
      <h1 className="font-display text-title font-semibold tracking-tight">Swap</h1>
      <SwapForm classes={classes} nextBatch={status.currentBatch} decimals={decimals} />
    </div>
  );
}
