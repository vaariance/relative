import * as stylex from "@stylexjs/stylex";
import { CoinFace, CoinNode } from "./coin";
import { color } from "./tokens.stylex";

const NARROW = "@media (max-width: 860px)";
const STILL = "@media (prefers-reduced-motion: reduce)";

const draw = stylex.keyframes({
  "0%": { strokeDashoffset: 1 },
  "45%": { strokeDashoffset: 0 },
  "100%": { strokeDashoffset: 0 },
});
const reveal = stylex.keyframes({
  "0%": { opacity: 0 },
  "35%": { opacity: 0 },
  "55%": { opacity: 1 },
  "100%": { opacity: 1 },
});
const ping = stylex.keyframes({
  "0%": { opacity: 0.7, scale: "1" },
  "100%": { opacity: 0, scale: "2.6" },
});
const travel = stylex.keyframes({
  "0%": { offsetDistance: "0%", opacity: 0 },
  "12%": { opacity: 1 },
  "88%": { opacity: 1 },
  "100%": { offsetDistance: "100%", opacity: 0 },
});
const toast = stylex.keyframes({
  "0%": { opacity: 0, translate: "0 26px", scale: "0.96" },
  "12%": { opacity: 1, translate: "0 0", scale: "1" },
  "80%": { opacity: 1, translate: "0 0", scale: "1" },
  "92%": { opacity: 0, translate: "0 -14px", scale: "0.98" },
  "100%": { opacity: 0, translate: "0 -14px", scale: "0.98" },
});
const bob = stylex.keyframes({
  "0%": { translate: "0 0" },
  "50%": { translate: "0 -8px" },
  "100%": { translate: "0 0" },
});

const styles = stylex.create({
  grid: { display: "grid", gridTemplateColumns: { default: "repeat(2, minmax(0, 1fr))", [NARROW]: "minmax(0, 1fr)" }, gap: 18 },
  card: {
    display: "flex",
    flexDirection: "column",
    borderRadius: 22,
    overflow: "hidden",
    backgroundColor: color.panel,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.line,
  },
  art: {
    position: "relative",
    height: { default: 330, [NARROW]: 280 },
    display: "grid",
    placeItems: "center",
    padding: 24,
    overflow: "hidden",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: color.line,
  },
  body: { display: "flex", flexDirection: "column", gap: 8, padding: 28 },
  title: { margin: 0, fontSize: 17, fontWeight: 600 },
  text: { margin: 0, color: color.muted, lineHeight: 1.65, maxWidth: "44ch" },

  screen: {
    width: "100%",
    maxWidth: 420,
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: 18,
    borderRadius: 16,
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.09)",
  },
  screenTop: { display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13, color: color.muted },
  tag: { paddingInline: 8, paddingBlock: 2, borderRadius: 999, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", backgroundColor: color.fg, color: color.bg },
  figureRow: { display: "flex", alignItems: "center", gap: 10 },
  figure: { fontSize: 34, fontWeight: 600, lineHeight: 1, letterSpacing: "-0.03em", fontVariantNumeric: "tabular-nums" },
  delta: { paddingInline: 8, paddingBlock: 3, borderRadius: 999, fontSize: 11, fontWeight: 600, color: color.accent, backgroundColor: "rgba(242, 98, 46, 0.14)" },
  chart: { display: "block", width: "100%", height: "auto", overflow: "visible" },
  stroke: {
    strokeDasharray: 1,
    strokeDashoffset: 0,
    animationName: { default: draw, [STILL]: "none" },
    animationDuration: "7s",
    animationTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    animationIterationCount: "infinite",
  },
  area: {
    animationName: { default: reveal, [STILL]: "none" },
    animationDuration: "7s",
    animationIterationCount: "infinite",
  },
  pulse: {
    transformBox: "fill-box",
    transformOrigin: "center",
    animationName: { default: ping, [STILL]: "none" },
    animationDuration: "1.8s",
    animationTimingFunction: "ease-out",
    animationIterationCount: "infinite",
  },

  flow: { display: "block", width: "100%", maxWidth: 460, height: "auto", overflow: "visible" },
  dot: {
    offsetRotate: "0deg",
    offsetDistance: "50%",
    animationName: { default: travel, [STILL]: "none" },
    animationDuration: "3.2s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },

  stack: { position: "relative", width: "100%", maxWidth: 400 },
  ghost: {
    position: "absolute",
    left: "6%",
    right: "6%",
    top: -14,
    height: 40,
    borderRadius: 14,
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.07)",
  },
  ghostFar: { left: "12%", right: "12%", top: -26, opacity: 0.6 },
  toast: {
    position: "relative",
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    gap: 14,
    alignItems: "start",
    padding: 18,
    borderRadius: 16,
    backgroundColor: "#151517",
    boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.12), 0 20px 40px rgba(0, 0, 0, 0.5)",
    animationName: { default: toast, [STILL]: "none" },
    animationDuration: "6s",
    animationTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    animationIterationCount: "infinite",
  },
  glow: {
    position: "absolute",
    left: "8%",
    right: "8%",
    bottom: -8,
    height: 16,
    borderRadius: 999,
    backgroundImage: `linear-gradient(90deg, transparent, ${color.accent}, #FFB199, ${color.accent}, transparent)`,
    filter: "blur(12px)",
    opacity: 0.85,
    animationName: { default: toast, [STILL]: "none" },
    animationDuration: "6s",
    animationTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    animationIterationCount: "infinite",
  },
  check: {
    width: 24,
    height: 24,
    display: "grid",
    placeItems: "center",
    borderRadius: "50%",
    fontSize: 13,
    color: color.accent,
    boxShadow: `inset 0 0 0 2px ${color.accent}`,
  },
  toastTitle: { margin: 0, fontSize: 15, fontWeight: 600 },
  toastText: { margin: 0, marginTop: 4, fontSize: 13, color: color.muted, lineHeight: 1.5 },
  close: { color: color.muted, fontSize: 16, lineHeight: 1 },
  note: { position: "absolute", top: 14, right: 16, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: color.muted },

  pile: { display: "flex", flexDirection: "column", alignItems: "center", gap: 18, rotate: "-24deg" },
  coins: { display: "flex", alignItems: "center" },
  coin: {
    width: 62,
    height: 62,
    marginInlineStart: -16,
    borderRadius: "50%",
    overflow: "hidden",
    display: "grid",
    placeItems: "center",
    backgroundColor: color.disc,
    color: color.fg,
    fontWeight: 700,
    fontSize: 22,
    boxShadow: `0 0 0 3px ${color.panel}, 0 12px 24px rgba(0, 0, 0, 0.45)`,
    animationName: { default: bob, [STILL]: "none" },
    animationDuration: "4s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
  },
  badge: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    paddingBlock: 8,
    paddingInline: 16,
    borderRadius: 999,
    fontSize: 13,
    backgroundColor: "#151517",
    boxShadow: `inset 0 0 0 1px rgba(255, 255, 255, 0.12), 0 10px 26px -6px ${color.accent}`,
  },
  live: { width: 7, height: 7, borderRadius: "50%", backgroundColor: color.accent },
});

function Chart({ values }: { values: number[] }) {
  const width = 380;
  const height = 130;
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  const span = high - low || 1;
  const x = (index: number) => (index / Math.max(values.length - 1, 1)) * (width - 8);
  const y = (value: number) => 8 + (1 - (value - low) / span) * (height - 16);
  const line = values.map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)} ${y(value).toFixed(1)}`).join(" ");
  const lastX = x(values.length - 1);
  const lastY = y(values[values.length - 1]);
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${width} ${height}`} {...stylex.props(styles.chart)}>
      <defs>
        <linearGradient id="feature-fade" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.2" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${lastX.toFixed(1)} ${height} L0 ${height} Z`} fill="url(#feature-fade)" {...stylex.props(styles.area)} />
      <line x1="0" x2={width} y1={y(0)} y2={y(0)} stroke="rgba(255, 255, 255, 0.25)" strokeDasharray="3 5" />
      <path d={line} pathLength={1} fill="none" stroke="#F4F4F5" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" {...stylex.props(styles.stroke)} />
      <circle cx={lastX} cy={lastY} r="5" fill="#F4F4F5" {...stylex.props(styles.pulse)} />
      <circle cx={lastX} cy={lastY} r="4" fill="#09090A" stroke="#F4F4F5" strokeWidth="2" />
    </svg>
  );
}

const LEFT = [56, 140, 224];
const HUBS = [98, 182];
const LINKS: Array<{ d: string; delay?: number }> = [
  { d: `M68 ${LEFT[0]} C140 ${LEFT[0]} 150 ${HUBS[0]} 212 ${HUBS[0]}`, delay: 0 },
  { d: `M68 ${LEFT[1]} C140 ${LEFT[1]} 150 ${HUBS[0]} 212 ${HUBS[0]}` },
  { d: `M68 ${LEFT[1]} C140 ${LEFT[1]} 150 ${HUBS[1]} 212 ${HUBS[1]}`, delay: -1.1 },
  { d: `M68 ${LEFT[2]} C140 ${LEFT[2]} 150 ${HUBS[1]} 212 ${HUBS[1]}`, delay: -2.2 },
  { d: `M268 ${HUBS[0]} C330 ${HUBS[0]} 340 ${LEFT[0]} 412 ${LEFT[0]}`, delay: -1.6 },
  { d: `M268 ${HUBS[0]} C330 ${HUBS[0]} 340 ${LEFT[1]} 412 ${LEFT[1]}` },
  { d: `M268 ${HUBS[1]} C330 ${HUBS[1]} 340 ${LEFT[1]} 412 ${LEFT[1]}`, delay: -0.5 },
  { d: `M268 ${HUBS[1]} C330 ${HUBS[1]} 340 ${LEFT[2]} 412 ${LEFT[2]}`, delay: -2.7 },
];

function Flow({ from, to }: { from: string[]; to: string[] }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 480 280" {...stylex.props(styles.flow)}>
      {LINKS.map((link) => (
        <path key={link.d} d={link.d} fill="none" stroke="rgba(255, 255, 255, 0.28)" strokeDasharray="4 6" />
      ))}
      {LINKS.filter((link) => link.delay !== undefined).map((link) => (
        <circle key={link.d} r="3.5" fill="#FFFFFF" {...stylex.props(styles.dot)} style={{ offsetPath: `path("${link.d}")`, animationDelay: `${link.delay}s` }} />
      ))}
      {from.map((id, index) => (
        <CoinNode key={`f${id}`} id={id} x={40} y={LEFT[index]} />
      ))}
      {to.map((id, index) => (
        <CoinNode key={`t${id}`} id={id} x={440} y={LEFT[index]} />
      ))}
      {HUBS.map((y) => (
        <g key={y}>
          <circle cx="240" cy={y} r="29" fill="#D9D9DC" />
          <path d={`M229 ${y + 6}H251M229 ${y}H251M229 ${y - 6}H251`} stroke="#151517" strokeWidth="2.2" strokeLinecap="round" />
        </g>
      ))}
    </svg>
  );
}

export interface FeatureData {
  leader: string;
  lead: string;
  ahead: boolean;
  spark: number[];
  top: string[];
  bottom: string[];
  count: number;
}

export function Features({ data }: { data: FeatureData }) {
  const pile = [...new Set([...data.top, "BTC", "ETH", "SOL", "XRP", "SUI"])].slice(0, 5);
  return (
    <div {...stylex.props(styles.grid)}>
      <article {...stylex.props(styles.card)}>
        <div {...stylex.props(styles.art)}>
          <div {...stylex.props(styles.screen)}>
            <div {...stylex.props(styles.screenTop)}>
              <span>{data.leader} against the market</span>
              <span {...stylex.props(styles.tag)}>SINCE LAUNCH</span>
            </div>
            <div {...stylex.props(styles.figureRow)}>
              <span {...stylex.props(styles.figure)}>{data.lead}</span>
              <span {...stylex.props(styles.delta)}>{data.ahead ? "ahead" : "behind"}</span>
            </div>
            <Chart values={data.spark} />
          </div>
        </div>
        <div {...stylex.props(styles.body)}>
          <h3 {...stylex.props(styles.title)}>Live scores</h3>
          <p {...stylex.props(styles.text)}>Every coin is measured against the market and updated every second.</p>
        </div>
      </article>

      <article {...stylex.props(styles.card)}>
        <div {...stylex.props(styles.art)}>
          <Flow from={data.bottom} to={data.top} />
        </div>
        <div {...stylex.props(styles.body)}>
          <h3 {...stylex.props(styles.title)}>Winners are paid by the rest</h3>
          <p {...stylex.props(styles.text)}>When a coin pulls ahead, value moves to its backers from the coins that fall behind.</p>
        </div>
      </article>

      <article {...stylex.props(styles.card)}>
        <div {...stylex.props(styles.art)}>
          <span {...stylex.props(styles.note)}>Example</span>
          <div {...stylex.props(styles.stack)}>
            <span {...stylex.props(styles.ghost, styles.ghostFar)} />
            <span {...stylex.props(styles.ghost)} />
            <span {...stylex.props(styles.glow)} />
            <div {...stylex.props(styles.toast)}>
              <span {...stylex.props(styles.check)}>✓</span>
              <div>
                <p {...stylex.props(styles.toastTitle)}>Order filled</p>
                <p {...stylex.props(styles.toastText)}>250 USDC is now backing {data.leader}.</p>
              </div>
              <span {...stylex.props(styles.close)}>×</span>
            </div>
          </div>
        </div>
        <div {...stylex.props(styles.body)}>
          <h3 {...stylex.props(styles.title)}>Trade it in one step</h3>
          <p {...stylex.props(styles.text)}>Choose an amount and confirm. Your order fills at the next price, usually within seconds.</p>
        </div>
      </article>

      <article {...stylex.props(styles.card)}>
        <div {...stylex.props(styles.art)}>
          <div {...stylex.props(styles.pile)}>
            <div {...stylex.props(styles.coins)}>
              {pile.map((id, index) => (
                <span key={id} {...stylex.props(styles.coin)} style={{ animationDelay: `${index * -0.6}s`, zIndex: pile.length - index }}>
                  <CoinFace id={id} />
                </span>
              ))}
            </div>
            <span {...stylex.props(styles.badge)}>
              <span {...stylex.props(styles.live)} />
              {data.count} coins ranked
            </span>
          </div>
        </div>
        <div {...stylex.props(styles.body)}>
          <h3 {...stylex.props(styles.title)}>One market, {data.count} coins</h3>
          <p {...stylex.props(styles.text)}>Bitcoin, Ethereum, Solana and the newer names, all ranked on the same board.</p>
        </div>
      </article>
    </div>
  );
}
