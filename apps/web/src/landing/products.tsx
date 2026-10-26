import * as stylex from "@stylexjs/stylex";
import Link from "next/link";
import { Activity, CandlestickChart, Timer, type LucideIcon } from "lucide-react";
import { Coin } from "./coin";
import { Chart } from "./features";
import { color } from "./tokens.stylex";

const NARROW = "@media (max-width: 860px)";

const styles = stylex.create({
  stack: { display: "flex", flexDirection: "column", gap: { default: 28, [NARROW]: 18 } },
  card: {
    position: { default: "sticky", [NARROW]: "relative" },
    top: { default: "var(--stack-top)", [NARROW]: "auto" },
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr) minmax(0, 1.25fr)", [NARROW]: "minmax(0, 1fr)" },
    minHeight: { default: "min(calc(100vh - 150px), 640px)", [NARROW]: 0 },
    borderRadius: 22,
    overflow: "hidden",
    backgroundColor: color.panel,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.line,
    boxShadow: "0 -24px 48px rgba(0, 0, 0, 0.55)",
  },
  text: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 18,
    padding: { default: 44, [NARROW]: 26 },
    backgroundImage: "linear-gradient(rgba(255, 255, 255, 0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 255, 255, 0.025) 1px, transparent 1px)",
    backgroundSize: "36px 36px",
  },
  textEnd: { order: { default: 2, [NARROW]: 0 } },
  number: {
    position: "absolute",
    top: 18,
    right: 28,
    fontSize: { default: 120, [NARROW]: 80 },
    lineHeight: 1,
    fontWeight: 600,
    letterSpacing: "-0.04em",
    color: "transparent",
    WebkitTextStroke: "1px rgba(255, 255, 255, 0.09)",
    userSelect: "none",
  },
  icon: {
    width: 34,
    height: 34,
    display: "grid",
    placeItems: "center",
    borderRadius: "50%",
    color: color.accent,
    boxShadow: `inset 0 0 0 1px ${color.accent}`,
  },
  title: { margin: 0, fontSize: { default: "clamp(2rem, 3.4vw, 3rem)", [NARROW]: "1.8rem" }, fontWeight: 600, lineHeight: 1.05, letterSpacing: "-0.02em" },
  line: { margin: 0, maxWidth: "36ch", color: color.muted, lineHeight: 1.7 },
  facts: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    width: "100%",
    marginTop: "auto",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: color.line,
  },
  fact: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    paddingBlock: 16,
    paddingInlineEnd: 12,
    borderInlineEndWidth: { default: 1, ":last-child": 0 },
    borderInlineEndStyle: "solid",
    borderInlineEndColor: color.line,
    paddingInlineStart: { default: 12, ":first-child": 0 },
  },
  factLabel: { fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: color.muted },
  factValue: { margin: 0, fontSize: 14, fontVariantNumeric: "tabular-nums" },
  action: {
    display: "inline-flex",
    alignItems: "center",
    gap: 10,
    paddingBlock: 11,
    paddingInline: 18,
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    textDecoration: "none",
    color: color.accent,
    boxShadow: `inset 0 0 0 1px ${color.accent}`,
    backgroundColor: { default: "transparent", ":hover": "rgba(242, 98, 46, 0.12)" },
    transitionProperty: "background-color",
    transitionDuration: "150ms",
    outlineColor: color.fg,
    outlineOffset: 3,
  },
  art: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    minHeight: { default: 0, [NARROW]: 300 },
    padding: { default: 40, [NARROW]: 22 },
    backgroundColor: "#0D0D0F",
    backgroundImage: "radial-gradient(circle at 70% 20%, rgba(242, 98, 46, 0.14), transparent 55%)",
    borderInlineStartWidth: { default: 1, [NARROW]: 0 },
    borderInlineStartStyle: "solid",
    borderInlineStartColor: color.line,
    borderBottomWidth: { default: 0, [NARROW]: 1 },
    borderBottomStyle: "solid",
    borderBottomColor: color.line,
  },
  artStart: { borderInlineStartWidth: 0, borderInlineEndWidth: { default: 1, [NARROW]: 0 }, borderInlineEndStyle: "solid", borderInlineEndColor: color.line },
  status: { position: "absolute", top: 18, left: 22, display: "flex", alignItems: "center", gap: 8, fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: color.muted },
  dot: { width: 6, height: 6, borderRadius: "50%", backgroundColor: color.accent },
  screen: {
    width: "100%",
    maxWidth: 480,
    display: "flex",
    flexDirection: "column",
    gap: 14,
    padding: 22,
    borderRadius: 16,
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.09)",
  },
  screenTop: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, fontSize: 13, color: color.muted },
  screenName: { display: "flex", alignItems: "center", gap: 10, color: color.fg, fontWeight: 600 },
  figure: { fontSize: 38, fontWeight: 600, lineHeight: 1, letterSpacing: "-0.03em", fontVariantNumeric: "tabular-nums" },
  candles: { display: "block", width: "100%", height: "auto" },
  round: { display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", alignItems: "center", gap: 22 },
  ring: { display: "block", width: 132, height: 132 },
  roundFacts: { display: "flex", flexDirection: "column", gap: 10 },
  roundRow: { display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13, color: color.muted },
  roundValue: { color: color.fg, fontVariantNumeric: "tabular-nums" },
  basket: { display: "flex", alignItems: "center", gap: 12, paddingTop: 14, borderTopWidth: 1, borderTopStyle: "solid", borderTopColor: color.line, fontSize: 12, color: color.muted },
  coins: { display: "flex" },
  tuck: { marginInlineStart: -8, borderRadius: "50%", boxShadow: "0 0 0 2px #121214" },
  backed: { borderRadius: "50%", boxShadow: `0 0 0 2px ${color.accent}` },
  pile: { display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: color.muted },
});

export interface ProductData {
  leader: string;
  lead: string;
  ahead: boolean;
  spark: number[];
  count: number;
  top: string[];
  level: number | null;
  levelSpark: number[];
}

interface Fact {
  label: string;
  value: string;
}

interface Product {
  name: string;
  icon: LucideIcon;
  line: string;
  facts: Fact[];
  href: string;
  action: string;
  status?: string;
  art: React.ReactNode;
}

function Candles({ values }: { values: number[] }) {
  const size = 3;
  const bars = [];
  for (let start = 0; start + 1 < values.length; start += size) {
    const slice = values.slice(start, start + size + 1);
    bars.push({ open: slice[0], close: slice[slice.length - 1], high: Math.max(...slice), low: Math.min(...slice) });
  }
  const width = 420;
  const height = 150;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || 1;
  const y = (value: number) => 8 + (1 - (value - low) / span) * (height - 16);
  const step = width / Math.max(bars.length, 1);
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${width} ${height}`} {...stylex.props(styles.candles)}>
      {bars.map((bar, index) => {
        const x = index * step + step / 2;
        const up = bar.close >= bar.open;
        const top = y(Math.max(bar.open, bar.close));
        const body = Math.max(Math.abs(y(bar.open) - y(bar.close)), 1.5);
        const tone = up ? "#F4F4F5" : "#F2622E";
        return (
          <g key={index}>
            <line x1={x} x2={x} y1={y(bar.high)} y2={y(bar.low)} stroke={tone} strokeWidth="1.2" />
            <rect x={x - step * 0.3} y={top} width={step * 0.6} height={body} rx="1" fill={up ? "#09090A" : tone} stroke={tone} strokeWidth="1.2" />
          </g>
        );
      })}
    </svg>
  );
}

function Ring() {
  const radius = 54;
  const length = 2 * Math.PI * radius;
  return (
    <svg aria-hidden="true" viewBox="0 0 132 132" {...stylex.props(styles.ring)}>
      <circle cx="66" cy="66" r={radius} fill="none" stroke="rgba(255, 255, 255, 0.1)" strokeWidth="6" />
      <circle cx="66" cy="66" r={radius} fill="none" stroke="#F2622E" strokeWidth="6" strokeLinecap="round" strokeDasharray={`${length * 0.62} ${length}`} transform="rotate(-90 66 66)" />
      <text x="66" y="64" textAnchor="middle" fontSize="18" fontWeight="600" fill="#F4F4F5">2:31:07</text>
      <text x="66" y="84" textAnchor="middle" fontSize="9" letterSpacing="1.5" fill="#9A9BA1">LEFT</text>
    </svg>
  );
}

function products(data: ProductData): Product[] {
  const basket = [...new Set([data.leader, ...data.top, "BTC", "ETH", "SOL", "XRP"])].slice(0, 5);
  return [
    {
      name: "Basic",
      icon: CandlestickChart,
      line: "Trade one coin's performance against the benchmark. Buy when you think it will pull ahead and sell whenever you like.",
      facts: [
        { label: "Fills", value: "In seconds" },
        { label: "Fee", value: "0.02%" },
        { label: "Coins", value: String(data.count) },
      ],
      href: "/markets",
      action: "Open Basic",
      art: (
        <div {...stylex.props(styles.screen)}>
          <div {...stylex.props(styles.screenTop)}>
            <span {...stylex.props(styles.screenName)}>
              <Coin id={data.leader} size={24} />
              {data.leader} vs benchmark
            </span>
            <span>Since launch</span>
          </div>
          <span {...stylex.props(styles.figure)}>{data.lead}</span>
          <Candles values={data.spark} />
        </div>
      ),
    },
    {
      name: "Epoch",
      icon: Timer,
      line: "Four-hour rounds. Pick an asset, build a basket of 30 around it, and share the pot by score when the round closes.",
      facts: [
        { label: "Round", value: "4 hours" },
        { label: "Basket", value: "30 coins" },
        { label: "Pot", value: "Shared by score" },
      ],
      href: "/epochs",
      action: "Enter a round",
      status: "Example round",
      art: (
        <div {...stylex.props(styles.screen)}>
          <div {...stylex.props(styles.screenTop)}>
            <span {...stylex.props(styles.screenName)}>12:00 – 16:00 UTC</span>
            <span>Open</span>
          </div>
          <div {...stylex.props(styles.round)}>
            <Ring />
            <div {...stylex.props(styles.roundFacts)}>
              <span {...stylex.props(styles.roundRow)}>Pot <span {...stylex.props(styles.roundValue)}>1,240 USDC</span></span>
              <span {...stylex.props(styles.roundRow)}>Entries <span {...stylex.props(styles.roundValue)}>18</span></span>
              <span {...stylex.props(styles.roundRow)}>Your asset <span {...stylex.props(styles.roundValue)}>{data.leader}</span></span>
            </div>
          </div>
          <div {...stylex.props(styles.basket)}>
            <span {...stylex.props(styles.coins)}>
              {basket.map((id, index) => (
                <span key={id} {...stylex.props(index === 0 ? styles.backed : styles.tuck)} style={{ zIndex: basket.length - index }}>
                  <Coin id={id} size={26} />
                </span>
              ))}
            </span>
            +25 more in the basket
          </div>
        </div>
      ),
    },
    {
      name: "Benchmark",
      icon: Activity,
      line: "Every listed coin, weighted equally. It is the line every coin is measured against.",
      facts: [
        { label: "Level", value: data.level === null ? "—" : data.level.toFixed(2) },
        { label: "Weights", value: "Equal" },
        { label: "Prices", value: "Every second" },
      ],
      href: "/crypto",
      action: "See the benchmark",
      status: `${data.count} coins · equal weight`,
      art: (
        <div {...stylex.props(styles.screen)}>
          <div {...stylex.props(styles.screenTop)}>
            <span {...stylex.props(styles.screenName)}>Benchmark level</span>
            <span>Last 24 hours</span>
          </div>
          <span {...stylex.props(styles.figure)}>{data.level === null ? "—" : data.level.toFixed(2)}</span>
          <Chart values={data.levelSpark.length > 1 ? data.levelSpark : [0, 0]} fade="product-fade" />
          <div {...stylex.props(styles.pile)}>
            <span {...stylex.props(styles.coins)}>
              {data.top.slice(0, 4).map((id, index) => (
                <span key={id} {...stylex.props(index === 0 ? undefined : styles.tuck)} style={{ zIndex: 4 - index }}>
                  <Coin id={id} size={22} />
                </span>
              ))}
            </span>
            {data.count} coins, equal weight
          </div>
        </div>
      ),
    },
  ];
}

export function Products({ data }: { data: ProductData }) {
  return (
    <div {...stylex.props(styles.stack)}>
      {products(data).map((product, index) => {
        const flip = index % 2 === 1;
        const Icon = product.icon;
        return (
          <article key={product.name} {...stylex.props(styles.card)} style={{ "--stack-top": `${92 + index * 18}px` } as React.CSSProperties}>
            <div {...stylex.props(styles.text, flip && styles.textEnd)}>
              <span aria-hidden="true" {...stylex.props(styles.number)}>{String(index + 1).padStart(2, "0")}</span>
              <span {...stylex.props(styles.icon)}>
                <Icon size={16} aria-hidden="true" />
              </span>
              <h3 {...stylex.props(styles.title)}>{product.name}</h3>
              <p {...stylex.props(styles.line)}>{product.line}</p>
              <dl {...stylex.props(styles.facts)}>
                {product.facts.map((fact) => (
                  <div key={fact.label} {...stylex.props(styles.fact)}>
                    <dt {...stylex.props(styles.factLabel)}>{fact.label}</dt>
                    <dd {...stylex.props(styles.factValue)}>{fact.value}</dd>
                  </div>
                ))}
              </dl>
              <Link href={product.href} {...stylex.props(styles.action)}>{product.action} →</Link>
            </div>
            <div {...stylex.props(styles.art, flip && styles.artStart)}>
              {product.status && (
                <span {...stylex.props(styles.status)}>
                  <span {...stylex.props(styles.dot)} />
                  {product.status}
                </span>
              )}
              {product.art}
            </div>
          </article>
        );
      })}
    </div>
  );
}
