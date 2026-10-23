"use client";

import { useEffect, useId, useRef, useState } from "react";
import { formatAmount, formatSigned } from "@/lib/format";
import type { Bar } from "@/lib/bars";

export interface ChartLine {
  value: number;
  label: string;
  tone: "ink" | "up" | "down";
}

export interface ChartMark {
  cutoff: number;
  side: "buy" | "sell" | "settled";
  label: string;
}

const PAD = { top: 20, right: 84, bottom: 30, left: 8 };
const colors = { ink: "var(--ink)", up: "var(--up)", down: "var(--down)" };

function nearest(points: readonly { cutoff: number }[], cutoff: number): number | null {
  if (points.length === 0 || cutoff < points[0].cutoff - 60 || cutoff > points[points.length - 1].cutoff + 60) return null;
  let best = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (Math.abs(points[index].cutoff - cutoff) < Math.abs(points[best].cutoff - cutoff)) best = index;
  }
  return best;
}

function stamp(cutoff: number, long: boolean): string {
  const iso = new Date(cutoff * 1000).toISOString();
  return long ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso.slice(11, 16);
}

export function TradeChart({ bars, candles = false, digits, label, lines = [], marks = [], compare, height = 420 }: { bars: Bar[]; candles?: boolean; digits: number; label: string; lines?: ChartLine[]; marks?: ChartMark[]; compare?: number; height?: number }) {
  const points = bars;
  const frame = useRef<HTMLDivElement>(null);
  const gradient = useId();
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ index: number; y: number } | null>(null);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const values = bars.map((bar) => bar.close);
  const long = bars.length > 1 && bars[bars.length - 1].cutoff - bars[0].cutoff > 20 * 3600;
  const last = values[values.length - 1];
  const start = compare ?? values[0];
  const rising = last >= start;
  const stroke = candles ? (rising ? "var(--up)" : "var(--down)") : "var(--accent)";
  const included = [...(candles ? bars.flatMap((bar) => [bar.high, bar.low]) : values), ...lines.map((line) => line.value)];
  const rawLow = Math.min(...included);
  const rawHigh = Math.max(...included);
  const margin = (rawHigh - rawLow || Math.abs(rawHigh) * 0.001 || 1) * 0.12;
  const low = rawLow - margin;
  const high = rawHigh + margin;
  const plotWidth = Math.max(0, width - PAD.left - PAD.right);
  const plotHeight = height - PAD.top - PAD.bottom;
  const span = Math.max(1, points.length - 1);
  const slot = plotWidth / (candles ? points.length : span);
  const x = (index: number) => (candles ? PAD.left + (index + 0.5) * slot : PAD.left + (index / span) * plotWidth);
  const body = Math.max(1, Math.min(14, slot * 0.64));
  const y = (value: number) => PAD.top + (1 - (value - low) / (high - low)) * plotHeight;
  const path = values.map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const area = `${path} L${x(points.length - 1).toFixed(1)},${PAD.top + plotHeight} L${x(0).toFixed(1)},${PAD.top + plotHeight} Z`;
  const ticks = [0, 1, 2, 3, 4, 5].map((step) => low + ((high - low) * step) / 5);
  const timeTicks = [...new Set([0, 1, 2, 3, 4].map((step) => Math.round((span * step) / 4)))];
  const active = hover?.index ?? points.length - 1;
  const change = start === 0 ? 0 : (values[active] / start - 1) * 100;
  const axisX = PAD.left + plotWidth;
  const tag = (value: number, fill: string, text: string, key: string) => (
    <g key={key}>
      <rect x={axisX + 2} y={y(value) - 9} width={PAD.right - 4} height={18} rx={4} fill={fill} />
      <text x={axisX + PAD.right / 2} y={y(value) + 4} textAnchor="middle" fontSize="11" fill="var(--surface)" className="num">{text}</text>
    </g>
  );

  return (
    <div ref={frame} className="relative w-full select-none" style={{ height }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${label}: latest ${formatAmount(last, digits)}`}
          className="cursor-crosshair"
          onPointerMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const ratio = (event.clientX - bounds.left - PAD.left) / (plotWidth || 1);
            setHover({ index: Math.min(points.length - 1, Math.max(0, candles ? Math.floor(ratio * points.length) : Math.round(ratio * span))), y: Math.min(PAD.top + plotHeight, Math.max(PAD.top, event.clientY - bounds.top)) });
          }}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.5" />
              <stop offset="55%" stopColor="var(--glow)" stopOpacity="0.2" />
              <stop offset="100%" stopColor="var(--glow)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={PAD.left} x2={axisX} y1={y(tick)} y2={y(tick)} stroke="var(--line)" strokeWidth="1" />
              <text x={axisX + PAD.right / 2} y={y(tick) + 4} textAnchor="middle" fontSize="11" fill="var(--muted)" className="num">{formatAmount(tick, digits)}</text>
            </g>
          ))}
          {timeTicks.map((index) => (
            <g key={index}>
              <line x1={x(index)} x2={x(index)} y1={PAD.top} y2={PAD.top + plotHeight} stroke="var(--line)" strokeWidth="1" />
              <text x={x(index)} y={height - 9} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"} fontSize="11" fill="var(--muted)" className="num">
                {stamp(points[index].cutoff, long)}
              </text>
            </g>
          ))}
          <line x1={axisX} x2={axisX} y1={PAD.top} y2={PAD.top + plotHeight} stroke="var(--line)" strokeWidth="1" />
          {candles ? (
            bars.map((bar, index) => {
              const up = bar.close >= bar.open;
              const color = up ? "var(--up)" : "var(--down)";
              const top = y(Math.max(bar.open, bar.close));
              return (
                <g key={bar.cutoff}>
                  <line x1={x(index)} x2={x(index)} y1={y(bar.high)} y2={y(bar.low)} stroke={color} strokeWidth="1" />
                  <rect x={x(index) - body / 2} y={top} width={body} height={Math.max(1, y(Math.min(bar.open, bar.close)) - top)} fill={color} />
                </g>
              );
            })
          ) : (
            <>
              <path d={area} fill={`url(#${gradient})`} />
              <path d={path} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            </>
          )}
          {lines.map((line) => (
            <g key={line.label}>
              <line x1={PAD.left} x2={axisX} y1={y(line.value)} y2={y(line.value)} stroke={colors[line.tone]} strokeWidth="1" strokeDasharray="5 4" />
              <rect x={PAD.left + 6} y={y(line.value) - 19} width={line.label.length * 6.4 + 12} height={16} rx={4} fill={colors[line.tone]} />
              <text x={PAD.left + 12} y={y(line.value) - 7.5} fontSize="10.5" fill="var(--surface)">{line.label}</text>
              {tag(line.value, colors[line.tone], formatAmount(line.value, digits), `tag-${line.label}`)}
            </g>
          ))}
          {marks.map((mark, order) => {
            const index = nearest(points, mark.cutoff);
            if (index === null) return null;
            const cx = x(index);
            if (mark.side === "settled") {
              return (
                <g key={`${mark.cutoff}-${order}`}>
                  <circle cx={cx} cy={y(values[index])} r="4.5" fill="var(--surface)" stroke="var(--ink)" strokeWidth="1.5" />
                  <title>{mark.label}</title>
                </g>
              );
            }
            const buy = mark.side === "buy";
            const cy = y(values[index]) + (buy ? 20 : -20);
            return (
              <g key={`${mark.cutoff}-${order}`}>
                <line x1={cx} x2={cx} y1={y(values[index])} y2={cy} stroke={buy ? "var(--up)" : "var(--down)"} strokeWidth="1" />
                <circle cx={cx} cy={cy} r="9" fill={buy ? "var(--up)" : "var(--down)"} />
                <text x={cx} y={cy + 3.5} textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--surface)">{buy ? "B" : "S"}</text>
                <title>{mark.label}</title>
              </g>
            );
          })}
          <line x1={PAD.left} x2={axisX} y1={y(last)} y2={y(last)} stroke={stroke} strokeWidth="1" strokeDasharray="2 3" opacity="0.7" />
          {tag(last, stroke, formatAmount(last, digits), "last")}
          {hover && (
            <g>
              <line x1={x(hover.index)} x2={x(hover.index)} y1={PAD.top} y2={PAD.top + plotHeight} stroke="var(--muted)" strokeWidth="1" strokeDasharray="3 3" />
              <line x1={PAD.left} x2={axisX} y1={hover.y} y2={hover.y} stroke="var(--muted)" strokeWidth="1" strokeDasharray="3 3" />
              <rect x={axisX + 2} y={hover.y - 9} width={PAD.right - 4} height={18} rx={4} fill="var(--ink)" />
              <text x={axisX + PAD.right / 2} y={hover.y + 4} textAnchor="middle" fontSize="11" fill="var(--surface)" className="num">
                {formatAmount(low + (1 - (hover.y - PAD.top) / plotHeight) * (high - low), digits)}
              </text>
              <rect x={Math.min(axisX - 84, Math.max(PAD.left, x(hover.index) - 42))} y={height - 24} width={84} height={18} rx={4} fill="var(--ink)" />
              <text x={Math.min(axisX - 42, Math.max(PAD.left + 42, x(hover.index)))} y={height - 11} textAnchor="middle" fontSize="11" fill="var(--surface)" className="num">
                {stamp(points[hover.index].cutoff, true)}
              </text>
            </g>
          )}
          {!candles && <circle cx={x(active)} cy={y(values[active])} r="4" fill={stroke} stroke="var(--surface)" strokeWidth="2" />}
        </svg>
      )}
      <div className="pointer-events-none absolute left-3 top-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
        <span className="font-medium text-ink">{label}</span>
        {candles ? (
          <span className="num text-muted">
            O <span className="text-ink">{formatAmount(bars[active].open, digits)}</span> H <span className="text-ink">{formatAmount(bars[active].high, digits)}</span> L <span className="text-ink">{formatAmount(bars[active].low, digits)}</span> C <span className="text-ink">{formatAmount(bars[active].close, digits)}</span>
          </span>
        ) : (
          <span className="num text-ink">{formatAmount(values[active], digits)}</span>
        )}
        <span className={`num ${change >= 0 ? "text-up" : "text-down"}`}>{formatSigned(change, 3)}%</span>
        <span className="num text-muted">{stamp(points[active].cutoff, true)} UTC</span>
      </div>
    </div>
  );
}
