export function byPopularity<T>(items: readonly T[], idOf: (item: T) => string, ranks: Readonly<Record<string, number>>): T[] {
  return items
    .map((item, index) => ({ item, index, rank: ranks[idOf(item)] }))
    .sort((a, b) => {
      const ar = a.rank ?? Number.POSITIVE_INFINITY;
      const br = b.rank ?? Number.POSITIVE_INFINITY;
      return ar === br ? a.index - b.index : ar - br;
    })
    .map((entry) => entry.item);
}
