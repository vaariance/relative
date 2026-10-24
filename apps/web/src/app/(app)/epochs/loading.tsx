import { Shimmer, ShimmerCard } from "@/components/shimmer";

export default function EpochsLoading() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label="Loading Epochs">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Shimmer className="h-8 w-28" />
          <Shimmer className="h-4 w-60" />
        </div>
        <Shimmer className="h-9 w-36" />
      </div>

      <Shimmer className="h-10 w-full" />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-12">
        <ShimmerCard className="md:col-span-2 xl:col-span-5">
          <Shimmer className="h-4 w-24" />
          <Shimmer className="h-12 w-44" />
          <div className="flex justify-between gap-2">
            <Shimmer className="h-6 w-40" />
            <Shimmer className="h-9 w-32" />
          </div>
        </ShimmerCard>
        <ShimmerCard className="xl:col-span-4">
          <Shimmer className="h-4 w-20" />
          <Shimmer className="h-10 w-32" />
          <Shimmer className="h-2 w-full" />
        </ShimmerCard>
        <ShimmerCard className="xl:col-span-3">
          <Shimmer className="h-5 w-40" />
          <Shimmer className="h-14 w-full" />
          <Shimmer className="h-9 w-36" />
        </ShimmerCard>
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
