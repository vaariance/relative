import { Shimmer, ShimmerCard } from "@/components/shimmer";

export default function EpochsLoading() {
  return (
    <div className="flex flex-col gap-5" role="status" aria-label="Loading Epochs">
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Shimmer className="h-9 w-32" />
          <Shimmer className="h-4 w-72" />
        </div>
        <Shimmer className="h-9 w-36" />
      </div>

      <Shimmer className="h-[260px] w-full rounded-[28px]" />

      <div className="grid gap-6 rounded-[24px] border border-line bg-surface p-5 shadow-card lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          <Shimmer className="h-4 w-20" />
          {[0, 1, 2].map((row) => (
            <Shimmer key={row} className="h-20 w-full rounded-2xl" />
          ))}
        </div>
        <div className="flex flex-col gap-3">
          <Shimmer className="h-4 w-32" />
          <Shimmer className="h-48 w-full rounded-2xl" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-4 xl:col-span-8">
          <ShimmerCard>
            <Shimmer className="h-5 w-56" />
            {[0, 1, 2, 3, 4, 5].map((row) => (
              <Shimmer key={row} className="h-10 w-full" />
            ))}
          </ShimmerCard>
          <ShimmerCard>
            <Shimmer className="h-5 w-32" />
            <Shimmer className="h-10 w-full" />
          </ShimmerCard>
        </div>
        <div className="flex min-w-0 flex-col gap-4 xl:col-span-4">
          <ShimmerCard className="hidden xl:flex">
            <Shimmer className="h-5 w-32" />
            <Shimmer className="h-20 w-full" />
            <Shimmer className="h-12 w-full" />
            <Shimmer className="h-11 w-full" />
          </ShimmerCard>
          <ShimmerCard>
            <Shimmer className="h-5 w-40" />
            {[0, 1, 2, 3, 4].map((step) => (
              <Shimmer key={step} className="h-6 w-full" />
            ))}
          </ShimmerCard>
        </div>
      </div>
    </div>
  );
}
