import { Activity, Coins, LayoutList } from "lucide-react";
import Link from "next/link";
import { CoinIcon } from "@/components/coin-icon";
import { FirstPublication } from "@/components/first-publication";
import { LeaderCards } from "@/components/leader-cards";
import { LiveChange, LiveFigure, LiveSparkline } from "@/components/live";
import { CardTitle, Figure, StatCard } from "@/components/stat-card";
import { getAssets, getDeployment, getPublications } from "@/lib/data";
import { formatAmount } from "@/lib/format";
import { decimalsOf, standingOf, classViews, currentOf, findClass, latest, levelSeries, priceSeries, referenceSeries } from "@/lib/view";

const SPARK = 240;
const EMPTY = "—";

function EmptyRow({ id, name, href }: { id: string; name: string; href: string }) {
  return (
    <tr className="relative border-b border-line transition-colors last:border-b-0 duration-150 hover:bg-surface-2">
      <th scope="row" className="px-4 py-3 text-left font-normal">
        <Link href={href} className="flex items-center gap-2.5 after:absolute after:inset-0 after:content-['']">
          <CoinIcon id={id} />
          <span className="font-medium text-ink">{id}</span>
          {name !== id && <span className="text-xs text-muted">{name}</span>}
        </Link>
      </th>
      <td className="num px-4 py-3 text-right text-muted">{EMPTY}</td>
      <td className="num px-4 py-3 text-right text-base text-muted">{EMPTY}</td>
      <td className="px-4 py-3 text-right text-muted">{EMPTY}</td>
      <td className="px-4 py-3 text-muted">{EMPTY}</td>
      <td className="num px-4 py-3 text-right">{formatAmount(0)}</td>
    </tr>
  );
}

export default async function MarketsPage() {
  const [assets, deployment, publications] = await Promise.all([getAssets(), getDeployment(), getPublications()]);
  const current = currentOf(publications);

  const classes = classViews(current, assets, decimalsOf(deployment));
  const active = classes.reduce((sum, item) => sum + item.backing, 0);
  const level = levelSeries(publications);
  const ranked = current
    ? assets
        .map((asset) => {
          const reference = referenceSeries(publications, asset.assetId);
          return { id: asset.assetId, reference, standing: standingOf(reference) };
        })
        .sort((left, right) => right.standing - left.standing)
    : [];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-display text-title font-semibold tracking-tight">Markets</h1>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={Activity}
          title="Index"
          value={<LiveFigure kind="level" committed={current ? latest(level) : null} />}
          badge={<LiveChange kind="level" pill committed={current ? latest(level) / 100 - 1 : null} />}
          chart={<LiveSparkline kind="level" card fallback={current ? level.slice(-SPARK) : []} />}
        />
        <LeaderCards contenders={ranked.map((item) => ({ id: item.id, standing: item.standing, points: item.reference }))} />
        <StatCard icon={Coins} title="Pool TVL" value={<Figure text={formatAmount(active)} unit="USDC" />} caption={`settled, across ${classes.length} classes`} />
      </div>

      {!current && <FirstPublication />}

      <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
        <div className="border-b border-line px-4 py-3">
          <CardTitle icon={LayoutList} aside={`${assets.length} coins`}>All markets</CardTitle>
        </div>
        <table className="w-full min-w-[660px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th scope="col" className="px-4 py-3 font-normal">Asset</th>
              <th scope="col" className="px-4 py-3 text-right font-normal">Price (USD)</th>
              <th scope="col" className="px-4 py-3 text-right font-normal">Relative reference</th>
              <th scope="col" className="px-4 py-3 text-right font-normal">Performance</th>
              <th scope="col" className="px-4 py-3 font-normal">Trend</th>
              <th scope="col" className="px-4 py-3 text-right font-normal">Class backing</th>
            </tr>
          </thead>
          <tbody>
            {assets.map((asset) => {
              const reference = referenceSeries(publications, asset.assetId);
              const claim = findClass(classes, asset.assetId);
              if (!current) return <EmptyRow key={asset.assetId} id={asset.assetId} name={asset.name} href={`/assets/${asset.assetId}`} />;
              return (
                <tr key={asset.assetId} className="relative border-b border-line transition-colors last:border-b-0 duration-150 hover:bg-surface-2">
                  <th scope="row" className="px-4 py-3 text-left font-normal">
                    <Link href={`/assets/${asset.assetId}`} className="flex items-center gap-2.5 after:absolute after:inset-0 after:content-['']">
                      <CoinIcon id={asset.assetId} />
                      <span className="font-medium text-ink">{asset.assetId}</span>
                      {asset.name !== asset.assetId && <span className="text-xs text-muted">{asset.name}</span>}
                    </Link>
                  </th>
                  <td className="num px-4 py-3 text-right"><LiveFigure kind="price" id={asset.assetId} committed={latest(priceSeries([current], asset.assetId))} plain /></td>
                  <td className="num px-4 py-3 text-right text-base"><LiveFigure kind="reference" id={asset.assetId} committed={latest(reference)} plain /></td>
                  <td className="px-4 py-3 text-right"><LiveChange kind="reference" id={asset.assetId} committed={standingOf(reference)} /></td>
                  <td className="px-4 py-3"><LiveSparkline kind="reference" id={asset.assetId} fallback={reference.slice(-SPARK)} /></td>
                  <td className="num px-4 py-3 text-right">{formatAmount(claim.backing)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

    </div>
  );
}
