import type { Point } from "@/lib/view";

export function Sparkline({ points, tone, width = 120, height = 32, area = false, fluid = false }: { points: Point[]; tone: "up" | "down" | "flat"; width?: number; height?: number; area?: boolean; fluid?: boolean }) {
  const values = points.map((point) => point.value);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || 1;
  const path = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - 2 - ((value - low) / span) * (height - 4);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const stroke = tone === "up" ? "var(--up)" : tone === "down" ? "var(--down)" : "var(--muted)";
  const fill = `spark-${tone}`;
  return (
    <svg width={fluid ? "100%" : width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio={fluid ? "none" : undefined} aria-hidden="true" className={fluid ? "block" : "shrink-0"} style={fluid ? { maxWidth: width } : undefined}>
      {area && (
        <>
          <defs>
            <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${path} L${width},${height} L0,${height} Z`} fill={`url(#${fill})`} />
        </>
      )}
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
