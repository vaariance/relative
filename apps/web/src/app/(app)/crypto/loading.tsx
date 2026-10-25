import { Shimmer, ShimmerCard } from "@/components/shimmer";

export default function CryptoLoading() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="Loading the benchmark">
      <Shimmer className="h-8 w-36" />

      <div className="grid gap-3 md:grid-cols-3">
        {[0, 1, 2].map((card) => (
          <ShimmerCard key={card}>
            <Shimmer className="h-3 w-24" />
            <Shimmer className="h-7 w-32" />
            <Shimmer className="h-8 w-full" />
          </ShimmerCard>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <ShimmerCard className="min-w-0">
          <div className="flex gap-2">
            <Shimmer className="h-7 w-36" />
            <Shimmer className="h-7 w-20" />
          </div>
          <Shimmer className="h-72 w-full" />
        </ShimmerCard>
        <ShimmerCard>
          <Shimmer className="h-10 w-full" />
          <Shimmer className="h-16 w-full" />
          <Shimmer className="h-16 w-full" />
          <Shimmer className="h-4 w-32" />
          <Shimmer className="h-11 w-full" />
        </ShimmerCard>
        <ShimmerCard>
          <Shimmer className="h-4 w-28" />
          <Shimmer className="h-4 w-full" />
        </ShimmerCard>
      </div>
    </div>
  );
}
