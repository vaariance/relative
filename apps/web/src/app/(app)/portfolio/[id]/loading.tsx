import { Shimmer, ShimmerCard } from "@/components/shimmer";

export default function PositionLoading() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label="Loading position">
      <Shimmer className="h-3 w-36" />

      <ShimmerCard>
        <div className="flex items-center gap-3">
          <Shimmer className="size-9 rounded-full" />
          <Shimmer className="h-8 w-56" />
        </div>
        <div className="flex flex-wrap gap-6">
          {[0, 1, 2, 3, 4, 5].map((stat) => (
            <div key={stat} className="flex flex-col gap-2">
              <Shimmer className="h-3 w-20" />
              <Shimmer className="h-5 w-24" />
            </div>
          ))}
        </div>
      </ShimmerCard>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <ShimmerCard>
            <div className="flex gap-2">
              <Shimmer className="h-7 w-36" />
              <Shimmer className="h-7 w-20" />
            </div>
            <Shimmer className="h-96 w-full" />
          </ShimmerCard>
          <ShimmerCard>
            <Shimmer className="h-4 w-28" />
            <Shimmer className="h-10 w-full" />
            <Shimmer className="h-10 w-full" />
          </ShimmerCard>
        </div>
        <ShimmerCard>
          <Shimmer className="h-10 w-full" />
          <Shimmer className="h-12 w-full" />
          <Shimmer className="h-4 w-28" />
          <Shimmer className="h-10 w-full" />
          <Shimmer className="h-11 w-full" />
        </ShimmerCard>
      </div>
    </div>
  );
}
