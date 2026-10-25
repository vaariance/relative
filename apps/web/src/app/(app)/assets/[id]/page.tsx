import { Activity, ChevronRight, DollarSign, Layers } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AssetChart } from "@/components/asset-chart";
import { CoinIcon } from "@/components/coin-icon";
import { FirstPublication } from "@/components/first-publication";
import { LiveChange, LiveFigure, LiveSparkline, StandingNote } from "@/components/live";
import { MyPosition } from "@/components/my-position";
import { RequestList } from "@/components/request-list";
import { StatCard } from "@/components/stat-card";
import { TradeForm } from "@/components/trade-form";
import { getAssets, getDeployment, getPublications, getStatus } from "@/lib/data";
import { formatAmount } from "@/lib/format";
import { CRYPTO_CLASS, classViews, currentOf, decimalsOf, findClass, latest, levelSeries, priceDigits, priceSeries, referenceSeries, standingOf } from "@/lib/view";

const SPARK = 60;

function NoChart({ id }: { id?: string }) {
  return (
    <section className="flex h-80 items-center justify-center rounded-card border border-line bg-surface p-4 text-sm text-muted shadow-card">
      {id ? `The chart starts with ${id}'s first price update.` : "The chart starts with the first price update."}
    </section>
  );
}

export default async function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [assets, deployment, publications, status] = await Promise.all([getAssets(), getDeployment(), getPublications(), getStatus()]);
  const asset = assets.find((item) => item.assetId === id);
  if (!asset) notFound();

  const decimals = decimalsOf(deployment);
  const current = currentOf(publications);
  const classes = classViews(current, assets, decimals);
  const claim = findClass(classes, asset.assetId);
  const cryptoClass = findClass(classes, CRYPTO_CLASS);

  const price = priceSeries(publications, asset.assetId);
  const reference = referenceSeries(publications, asset.assetId);
  const level = levelSeries(publications);
  const relative = current ? standingOf(reference) : null;
  const priceNow = latest(price);
  const charted = price.length > 0 || reference.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs text-muted">
        <Link href="/markets" className="hover:text-ink">Markets</Link>
        <ChevronRight size={12} aria-hidden="true" />
        <span className="text-ink">{asset.assetId}</span>
      </nav>

      <h1 className="flex items-center gap-3 font-display text-title font-semibold tracking-tight">
        <CoinIcon id={asset.assetId} size={36} />
        {asset.assetId}
        {asset.name !== asset.assetId && <span className="text-base font-normal text-muted">{asset.name}</span>}
      </h1>

      {!current && <FirstPublication />}

      <div className="grid gap-3 md:grid-cols-3">
        <StatCard
          icon={DollarSign}
          title="Price"
          aside="USD"
          value={<LiveFigure kind="price" id={asset.assetId} committed={current ? priceNow : null} />}
          chart={<LiveSparkline kind="price" id={asset.assetId} card fallback={current ? price.slice(-SPARK) : []} />}
        />
        <StatCard
          icon={Activity}
          title="Relative reference"
          aside="starts at 100"
          value={<LiveFigure kind="reference" id={asset.assetId} committed={current ? latest(reference) : null} />}
          badge={<LiveChange kind="reference" id={asset.assetId} pill committed={current ? relative : null} />}
          caption={<StandingNote id={asset.assetId} committed={current ? relative : null} />}
          chart={<LiveSparkline kind="reference" id={asset.assetId} card fallback={current ? reference : []} />}
        />
        <StatCard
          icon={Layers}
          title="Class unit value"
          value={<LiveFigure kind="unitValue" id={asset.assetId} committed={claim.unitValue} />}
          caption={`${formatAmount(claim.backing)} USDC backing, settled`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-6">
          {current && charted ? (
            <AssetChart
              series={[
                { id: "reference", label: "Relative reference", points: reference, digits: 4, baseline: 100, live: { kind: "reference", id: asset.assetId } },
                { id: "price", label: "Price", points: price, digits: priceDigits(priceNow), live: { kind: "price", id: asset.assetId } },
                { id: "crypto", label: "Benchmark", points: level, digits: 4, baseline: 100, live: { kind: "level" } },
              ]}
            />
          ) : (
            <NoChart id={current ? asset.assetId : undefined} />
          )}
          <RequestList classId={asset.assetId} status={status} decimals={decimals} />
        </div>
        <div className="flex flex-col gap-6">
          <TradeForm claim={claim} crypto={cryptoClass} nextBatch={status.currentBatch} decimals={decimals} />
          <MyPosition classId={asset.assetId} unitValue={claim.unitValue} decimals={decimals} />
        </div>
      </div>
    </div>
  );
}
