import { getAssets, getPublications } from "@/lib/data";
import { standings } from "@/lib/view";

const DAY = 86400;
const TOP = 3;
const BOTTOM = 2;
const SPARK = 60;

export interface BoardRow {
  rank: number;
  id: string;
  name: string;
  lead: number;
}

export interface Board {
  rows: BoardRow[];
  top: BoardRow[];
  count: number;
  scale: number;
  star: BoardRow;
  bottom: BoardRow[];
  spark: number[];
}

function sample(values: number[], size: number): number[] {
  if (values.length <= size) return values;
  const step = (values.length - 1) / (size - 1);
  return Array.from({ length: size }, (_, index) => values[Math.round(index * step)]);
}

export async function loadBoard(): Promise<Board | null> {
  try {
    const [assets, publications] = await Promise.all([getAssets(), getPublications()]);
    if (publications.length < 2 || assets.length < TOP + BOTTOM) return null;
    const names = new Map(assets.map((asset) => [asset.assetId, asset.name]));
    const standing = standings(publications, assets.map((asset) => asset.assetId));
    if (standing.length < TOP + BOTTOM) return null;
    const ranked = standing.map((row, index) => ({ id: row.id, name: names.get(row.id) ?? row.id, lead: row.standing, rank: index + 1 }));
    const top = ranked.slice(0, TOP);
    const rows = [...top, ...ranked.slice(-BOTTOM)];
    const scale = Math.max(...rows.map((row) => Math.abs(row.lead)), 0.0001);
    const star = ranked[0]!;
    const series = standing[0]!.points;
    const end = series[series.length - 1].cutoff;
    const day = series.filter((point) => point.cutoff >= end - DAY);
    const spark = sample(day.map((point) => point.value / day[0].value - 1), SPARK);
    return { rows, top, count: ranked.length, scale, star, bottom: ranked.slice(-3), spark };
  } catch {
    return null;
  }
}
