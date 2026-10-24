import { Shimmer, ShimmerCard } from "@/components/shimmer";

export default function PortfolioLoading() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="Loading portfolio">
      <div className="flex flex-col gap-2">
        <Shimmer className="h-8 w-40" />
        <Shimmer className="h-4 w-64" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((card) => (
          <ShimmerCard key={card}>
            <Shimmer className="h-4 w-28" />
            <Shimmer className="h-8 w-36" />
          </ShimmerCard>
        ))}
      </div>

      {[0, 1].map((section) => (
        <ShimmerCard key={section}>
          <Shimmer className="h-4 w-40" />
          <Shimmer className="h-10 w-full" />
          <Shimmer className="h-10 w-full" />
          <Shimmer className="h-10 w-full" />
        </ShimmerCard>
      ))}
    </div>
  );
}
