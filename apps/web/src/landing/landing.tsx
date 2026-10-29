import * as stylex from "@stylexjs/stylex";
import Link from "next/link";
import { formatChange } from "@/lib/format";
import { type Board, loadBoard } from "./board-data";
import { LogoProvider } from "@/components/coin-icon";
import { CookieSettingsButton } from "@/components/cookie-consent";
import { getCoinInfo } from "@/lib/data";
import { Coin } from "./coin";
import { Faq, type Question } from "./faq";
import { Features } from "./features";
import { Products } from "./products";
import { HeroBackdrop } from "./hero-backdrop";
import { Stencil } from "./stencil";
import { color, font } from "./tokens.stylex";

const NARROW = "@media (max-width: 860px)";

const hover = stylex.keyframes({
  "0%": { translate: "0 0" },
  "50%": { translate: "0 -12px" },
  "100%": { translate: "0 0" },
});

const styles = stylex.create({
  page: {
    minHeight: "100vh",
    backgroundColor: color.bg,
    color: color.fg,
    fontFamily: font.mono,
    fontSize: 14,
    lineHeight: 1.6,
  },
  wrap: { maxWidth: 1360, marginInline: "auto", paddingInline: { default: 32, [NARROW]: 18 } },
  stencil: { margin: 0, fontWeight: 400, lineHeight: 1 },
  label: { margin: 0, fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: color.muted },
  muted: { margin: 0, color: color.muted },
  ahead: { color: color.ahead },
  behind: { color: color.behind },
  accent: { color: color.accent },
  button: {
    display: "inline-flex",
    alignItems: "center",
    gap: 10,
    paddingBlock: 13,
    paddingInline: 20,
    borderRadius: 10,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    textDecoration: "none",
    color: color.onAccent,
    backgroundColor: { default: color.accent, ":hover": "#D9531F" },
    transitionProperty: "background-color",
    transitionDuration: "150ms",
    outlineColor: color.fg,
    outlineOffset: 2,
  },

  navBar: { position: "sticky", top: 14, zIndex: 10, paddingTop: 14 },
  nav: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    paddingBlock: 8,
    paddingInlineStart: 18,
    paddingInlineEnd: 8,
    borderRadius: 16,
    backgroundColor: "rgba(22, 22, 24, 0.72)",
    backdropFilter: "blur(14px)",
    boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.1), 0 12px 30px rgba(0, 0, 0, 0.4)",
  },
  logo: { display: "flex", alignItems: "center", fontSize: 20, color: color.fg, textDecoration: "none" },
  links: { display: { default: "flex", [NARROW]: "none" }, gap: 28, marginInlineStart: "auto", marginInlineEnd: 12 },
  link: {
    fontSize: 11,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    textDecoration: "none",
    color: { default: color.muted, ":hover": color.fg },
  },

  journey: { position: "relative" },
  hero: {
    position: "relative",
    height: { default: 760, [NARROW]: 600 },
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 22,
    textAlign: "center",
  },
  heroTitle: { fontSize: "clamp(2.6rem, 12.6vw, 10.2rem)", width: "100%" },
  tagline: { margin: 0, fontSize: 12, letterSpacing: { default: "0.22em", [NARROW]: "0.14em" }, textTransform: "uppercase", color: color.muted },
  roster: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 28,
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    paddingBlock: 7,
    paddingInline: 12,
    borderRadius: 10,
    fontSize: 12,
    fontWeight: 600,
    backgroundColor: color.panel,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.line,
  },
  chipExtra: { display: { default: "inline-flex", [NARROW]: "none" } },
  chipCompact: { display: { default: "none", [NARROW]: "inline-flex" } },
  chipMore: { color: color.muted },

  product: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr) minmax(0, 1fr)", [NARROW]: "minmax(0, 1fr)" },
    columnGap: 96,
    rowGap: 40,
    alignItems: "center",
    paddingBlock: { default: 120, [NARROW]: 64 },
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: color.line,
  },
  productName: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    alignItems: { default: "flex-end", [NARROW]: "center" },
    textAlign: { default: "right", [NARROW]: "center" },
  },
  productInfo: {
    gridColumnStart: { default: 2, [NARROW]: 1 },
    display: "flex",
    flexDirection: "column",
    gap: 14,
    alignItems: { default: "flex-start", [NARROW]: "center" },
    textAlign: { default: "left", [NARROW]: "center" },
  },
  figure: { fontSize: "clamp(2.2rem, 4.6vw, 3.4rem)", lineHeight: 1, fontWeight: 600, letterSpacing: "-0.03em", fontVariantNumeric: "tabular-nums" },

  night: {
    backgroundColor: "#111113",
    borderBlockWidth: 1,
    borderBlockStyle: "solid",
    borderBlockColor: color.line,
    color: "#F2F2F2",
    paddingBlock: { default: 150, [NARROW]: 96 },
    textAlign: "center",
  },
  nightLabel: { margin: 0, marginBottom: 22, fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: "#9C9DA1" },
  nightTitle: { fontSize: "clamp(1.7rem, 6vw, 4.6rem)" },
  nightText: { margin: 0, marginTop: 28, marginInline: "auto", maxWidth: "44ch", color: "#9C9DA1" },

  section: { paddingBlock: { default: 130, [NARROW]: 80 } },
  split: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1.25fr) minmax(0, 1fr)", [NARROW]: "minmax(0, 1fr)" },
    gap: { default: 64, [NARROW]: 40 },
    alignItems: "center",
  },
  panel: {
    borderRadius: 22,
    backgroundColor: color.panel,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.line,
    boxShadow: "0 24px 60px rgba(17, 18, 20, 0.07)",
  },
  boardPanel: { paddingBlock: 10, paddingInline: 22 },
  boardRow: {
    display: "grid",
    gridTemplateColumns: "92px minmax(0, 1fr) 76px",
    alignItems: "center",
    gap: 12,
    paddingBlock: 16,
    borderTopStyle: "solid",
    borderTopColor: color.line,
    borderTopWidth: { default: 1, ":first-child": 0 },
  },
  ticker: { display: "flex", alignItems: "center", gap: 10, fontWeight: 600 },
  bar: { position: "relative", height: 16 },
  middle: { position: "absolute", left: "50%", top: -16, bottom: -16, width: 1, backgroundColor: color.line },
  barAhead: { position: "absolute", top: 0, bottom: 0, left: "50%", borderRadius: 3, backgroundColor: color.ahead },
  barBehind: { position: "absolute", top: 0, bottom: 0, right: "50%", borderRadius: 3, backgroundColor: color.behind },
  lead: { textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 500 },
  splitText: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    gap: 24,
    alignItems: "flex-start",
    alignSelf: "stretch",
    padding: { default: 44, [NARROW]: 28 },
    borderRadius: 22,
    backgroundImage: "linear-gradient(140deg, #F6E3DA 0%, #F2B9A2 100%)",
  },
  split2: { alignItems: "stretch" },
  intro: { margin: 0, maxWidth: "34ch", color: color.muted },
  splitTitle: { fontSize: "clamp(2.2rem, 5vw, 3.6rem)" },

  centerTitle: { fontSize: "clamp(1.5rem, 5vw, 3.6rem)", marginBottom: { default: 56, [NARROW]: 36 } },
  steps: { display: "grid", gridTemplateColumns: { default: "repeat(3, minmax(0, 1fr))", [NARROW]: "minmax(0, 1fr)" }, gap: 18 },
  step: { display: "flex", flexDirection: "column", gap: 18, padding: 22, minHeight: 300 },
  stepTitle: { margin: 0, marginTop: "auto", fontSize: 15, fontWeight: 600 },
  mini: { display: "flex", flexDirection: "column", gap: 10 },
  miniRow: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    alignItems: "center",
    gap: 10,
    paddingBlock: 9,
    paddingInline: 12,
    borderRadius: 12,
    fontWeight: 600,
    backgroundColor: color.bg,
  },
  miniPicked: { boxShadow: `inset 0 0 0 2px ${color.accent}`, backgroundColor: color.panel },
  miniHead: { display: "flex", alignItems: "center", gap: 10, fontWeight: 600 },
  amount: { fontSize: 46, lineHeight: 1, fontWeight: 600, letterSpacing: "-0.03em", fontVariantNumeric: "tabular-nums" },
  unit: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: color.muted },
  pill: {
    alignSelf: "flex-start",
    paddingBlock: 9,
    paddingInline: 16,
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 600,
    backgroundColor: color.accent,
    color: color.onAccent,
  },
  done: {
    alignSelf: "flex-start",
    paddingBlock: 5,
    paddingInline: 12,
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 600,
    backgroundColor: color.fg,
    color: color.bg,
  },

  feature: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 0.85fr) minmax(0, 1.5fr)", [NARROW]: "minmax(0, 1fr)" },
    gap: { default: 56, [NARROW]: 36 },
    alignItems: "center",
    padding: { default: 64, [NARROW]: 24 },
    borderRadius: { default: 36, [NARROW]: 26 },
    backgroundColor: color.bg,
    color: color.fg,
    backgroundImage: `radial-gradient(70% 90% at 0% 100%, rgba(242, 98, 46, 0.34) 0%, transparent 70%)`,
  },
  featureText: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 28 },
  featureTitle: { fontSize: "clamp(2.4rem, 5vw, 4.6rem)" },
  featureLine: { margin: 0, maxWidth: "30ch", fontSize: 16, color: color.muted },

  bigTitle: { fontSize: "clamp(1.7rem, 5.6vw, 4.6rem)", marginBottom: { default: 64, [NARROW]: 36 } },
  cards: { display: "grid", gridTemplateColumns: { default: "repeat(3, minmax(0, 1fr))", [NARROW]: "minmax(0, 1fr)" }, gap: 20 },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: 24,
    minHeight: { default: 520, [NARROW]: 420 },
    padding: { default: 36, [NARROW]: 26 },
    borderRadius: 32,
  },
  cardLight: { backgroundColor: "#F7F7F8", color: "#111214" },
  cardAccent: { backgroundColor: color.accent, color: "#111214" },
  cardDark: { backgroundColor: "#121212", color: "#F4F4F5" },
  cardNumber: { fontSize: { default: "3.4rem", [NARROW]: "2.6rem" } },
  cardArt: { flexGrow: 1, display: "flex", alignItems: "center", justifyContent: "center" },
  cardName: { fontSize: { default: "1.7rem", [NARROW]: "1.4rem" } },
  cardLine: { margin: 0, fontSize: 15, opacity: 0.72, maxWidth: "28ch" },
  pile: { display: "flex", alignItems: "center" },
  lift: {
    borderRadius: "50%",
    boxShadow: "0 0 0 5px currentColor, 0 22px 40px rgba(0, 0, 0, 0.28)",
    animationName: { default: hover, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "5s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
  },
  tuck: { marginInlineStart: -26 },
  front: { zIndex: 1 },
  late: { animationDelay: "-1.6s" },
  later: { animationDelay: "-3.2s" },

  productBlock: { paddingTop: { default: 110, [NARROW]: 64 } },
  blockHead: { display: "flex", flexDirection: "column", gap: 20, marginBottom: { default: 48, [NARROW]: 32 } },
  blockTitle: { fontSize: { default: "clamp(2rem, 4.4vw, 3.6rem)", [NARROW]: "1.8rem" } },
  featureBlock: { paddingBlock: { default: 96, [NARROW]: 64 } },
  plain: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr) minmax(0, 1.7fr)", [NARROW]: "minmax(0, 1fr)" },
    columnGap: 80,
    rowGap: 40,
    alignItems: "start",
    paddingBlock: { default: 96, [NARROW]: 64 },
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: color.line,
  },
  aside: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 20 },
  plainTitle: { fontSize: { default: "2rem", [NARROW]: "1.6rem" } },
  plainText: { margin: 0, maxWidth: "32ch", color: color.muted, lineHeight: 1.7 },
  textLink: {
    fontSize: 14,
    color: color.fg,
    textDecorationLine: "underline",
    textDecorationColor: { default: color.line, ":hover": color.fg },
    textUnderlineOffset: 6,
    outlineColor: color.fg,
    outlineOffset: 4,
  },
  list: { display: "flex", flexDirection: "column" },
  listHead: {
    display: "grid",
    gridTemplateColumns: "88px minmax(0, 1fr) 72px",
    gap: 16,
    paddingBottom: 12,
    fontSize: 11,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: color.muted,
  },
  listEnds: { gridColumnStart: 2, display: "flex", justifyContent: "space-between" },
  listRow: {
    display: "grid",
    gridTemplateColumns: "88px minmax(0, 1fr) 72px",
    alignItems: "center",
    gap: 16,
    height: 60,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: color.line,
  },
  listName: { display: "flex", alignItems: "center", gap: 10, fontSize: 15 },
  lane: { position: "relative", height: "100%" },
  laneMiddle: { position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, backgroundColor: color.line },
  laneBar: { position: "absolute", top: "50%", height: 2, marginTop: -1, backgroundColor: color.fg },
  laneAhead: { left: "50%" },
  laneBehind: { right: "50%", backgroundColor: color.behind },
  listLead: { textAlign: "right", fontSize: 15, fontVariantNumeric: "tabular-nums" },
  trio: {
    display: "grid",
    gridTemplateColumns: { default: "repeat(3, minmax(0, 1fr))", [NARROW]: "minmax(0, 1fr)" },
    columnGap: 40,
    rowGap: 36,
  },
  trioItem: { display: "flex", flexDirection: "column", gap: 12 },
  trioNumber: { fontSize: 12, letterSpacing: "0.12em", color: color.muted },
  trioName: { margin: 0, fontSize: 18, fontWeight: 500 },
  trioText: { margin: 0, color: color.muted, lineHeight: 1.7, maxWidth: "26ch" },
  footer: {
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: color.line,
    paddingTop: { default: 88, [NARROW]: 56 },
  },
  footTop: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1.5fr) repeat(4, minmax(0, 1fr))", [NARROW]: "repeat(2, minmax(0, 1fr))" },
    columnGap: 40,
    rowGap: 48,
    paddingBottom: { default: 80, [NARROW]: 48 },
  },
  footIntro: {
    gridColumn: { default: "auto", [NARROW]: "1 / 3" },
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 20,
  },
  footLogo: { fontSize: 26 },
  footText: { margin: 0, maxWidth: "34ch", color: color.muted, lineHeight: 1.7 },
  footColumn: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 14 },
  footLink: {
    fontSize: 14,
    textDecoration: "none",
    color: { default: color.fg, ":hover": color.accent },
    outlineColor: color.fg,
    outlineOffset: 4,
  },
  footButton: { padding: 0, borderWidth: 0, backgroundColor: "transparent", fontFamily: "inherit", textAlign: "left", cursor: "pointer" },
  footFact: { fontSize: 14, color: color.fg },
  footWord: { paddingTop: 24, paddingBottom: 32, color: color.fg },
  end: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    paddingBlock: 40,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: color.line,
  },
  endLogo: { fontSize: 18 },

  foot: { paddingTop: 40, paddingBottom: 28, overflow: "hidden" },
  footLine: { display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 12, marginBottom: 12 },
  word: { paddingTop: 12 },
});

const night = stylex.createTheme(color, {
  bg: "#121212",
  panel: "#1C1C1E",
  line: "rgba(255, 255, 255, 0.16)",
  fg: "#F4F4F5",
  muted: "#A1A2A8",
  accent: "#F2622E",
  onAccent: "#FFFFFF",
  ahead: "#F4F4F5",
  behind: "#77797F",
});

const ROSTER = ["BTC", "ETH", "SOL", "XRP", "BNB", "AVAX", "SUI", "NEAR"];
const ROSTER_NARROW = 4;

const questions: Question[] = [
  { ask: "What is Relative?", answer: "A market where you trade a coin's performance against the rest of crypto. You are not betting on the price going up. You are betting on your coin beating the others." },
  { ask: "What is \"the market\"?", answer: "It is the average of every coin on the board, with each coin counted equally. Every coin is scored against that average." },
  { ask: "How do I win?", answer: "Your share grows when your coin does better than the market. A coin can fall in price and still win, as long as it falls less than the rest." },
  { ask: "Can I lose money?", answer: "Yes. If your coin falls behind the market, your share shrinks." },
  { ask: "Where do winnings come from?", answer: "From the other people in the pool. Everyone's money sits in one shared pool. When your coin pulls ahead, value moves to its backers from the coins that fell behind. Nothing is created from nowhere." },
  { ask: "Do I own the coin I trade?", answer: "No. You hold a share of the pool that follows how the coin performs against the benchmark. You never hold the coin itself." },
  { ask: "Which coins can I trade?", answer: "Every coin on the board, including Bitcoin, Ethereum, Solana and a set of newer names. Stablecoins are left out because their price is not meant to move." },
  { ask: "How fast does an order fill?", answer: "At the next price, usually within seconds. The price is not locked at the moment you tap, so the fill can differ a little from what you saw." },
  { ask: "Where do prices come from?", answer: "From Pyth, updated every second. Between settlements on chain, the app shows live estimates." },
  { ask: "Can I move from one coin to another?", answer: "Yes. You can move what you have behind one coin to another coin without cashing out first." },
  { ask: "How do I cash out?", answer: "Choose cash out on any position. It fills at the next price, and then you collect the USDC to your wallet." },
  { ask: "Are there fees?", answer: "A small one: 0.02% of each trade, and never more than 0.20 USDC. Solana also charges its usual small network fee." },
  { ask: "What do I need to start?", answer: "Log in with Google or a Solana wallet, then claim free rlUSD on the Faucet page. Wallets low on SOL also get a little devnet SOL for network fees. You can use devnet USDC from Circle too." },
  { ask: "Is this real money?", answer: "Not yet. Relative runs on Solana devnet with devnet USDC and rlUSD, test dollars with no real value." },
];

export async function Landing() {
  const [board, { logos }] = await Promise.all([loadBoard(), getCoinInfo()]);
  const total = Math.max(board?.count ?? ROSTER.length, ROSTER.length);
  const star = board?.star ?? { rank: 1, id: "SOL", name: "Solana", lead: 0 };
  const up = star.lead >= 0;
  const picks = [...new Set([star.id, ...(board?.top ?? []).map((row) => row.id), "SOL", "BTC", "ETH"])].slice(0, 3);

  return (
    <LogoProvider logos={logos}>
    <div {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.wrap, styles.navBar)}>
        <nav aria-label="Main" {...stylex.props(styles.nav)}>
          <a href="#top" {...stylex.props(styles.logo)}>
            <Stencil lines={["RELATIVE"]} />
          </a>
          <div {...stylex.props(styles.links)}>
            <a href="#board" {...stylex.props(styles.link)}>Board</a>
            <a href="#how" {...stylex.props(styles.link)}>How it works</a>
            <a href="#products" {...stylex.props(styles.link)}>Products</a>
            <a href="#faq" {...stylex.props(styles.link)}>FAQ</a>
          </div>
          <Link href="/markets" {...stylex.props(styles.button)}>Open app</Link>
        </nav>
      </div>

      <div id="top" {...stylex.props(styles.journey)}>
        <HeroBackdrop />
        <header {...stylex.props(styles.wrap, styles.hero)}>
          <h1 {...stylex.props(styles.stencil, styles.heroTitle)}>
            <Stencil lines={["Trade On", "Performance"]} />
          </h1>
          <p {...stylex.props(styles.tagline)}>Pick the coin your research says will outperform the market.</p>
          <div {...stylex.props(styles.roster)}>
            {ROSTER.map((id, index) => (
              <span key={id} {...stylex.props(styles.chip, index >= ROSTER_NARROW && styles.chipExtra)}>
                <Coin id={id} size={18} />
                {id}
              </span>
            ))}
            <span {...stylex.props(styles.chip, styles.chipMore, styles.chipExtra)}>+{total - ROSTER.length} more</span>
            <span {...stylex.props(styles.chip, styles.chipMore, styles.chipCompact)}>+{total - ROSTER_NARROW} more</span>
          </div>
        </header>

        <section {...stylex.props(styles.wrap)}>
          <div {...stylex.props(styles.product)}>
            <div {...stylex.props(styles.productName)}>
              <p {...stylex.props(styles.label)}>No. {star.rank} on the board</p>
              <Coin id={star.id} size={96} />
            </div>
            <div {...stylex.props(styles.productInfo)}>
              <p {...stylex.props(styles.label)}>Introduction</p>
              <p {...stylex.props(styles.intro)}>Every coin is ranked by how it does against the whole market. {star.id} is leading.</p>
              <span {...stylex.props(styles.figure, up ? styles.ahead : styles.behind)}>{formatChange(star.lead)}</span>
              <p {...stylex.props(styles.muted)}>{up ? "ahead of" : "behind"} the market</p>
              <Link href={`/assets/${star.id}`} {...stylex.props(styles.button)}>Trade {star.id} →</Link>
            </div>
          </div>
        </section>
      </div>

      <section {...stylex.props(styles.night)}>
        <div {...stylex.props(styles.wrap)}>
          <p {...stylex.props(styles.nightLabel)}>About Relative</p>
          <h2 {...stylex.props(styles.stencil, styles.nightTitle)}>
            <Stencil lines={["A coin can fall", "and still win"]} />
          </h2>
          <p {...stylex.props(styles.nightText)}>Here it is not about up or down. What counts is the gap between your coin and the rest of the market.</p>
        </div>
      </section>

      <div {...stylex.props(styles.wrap)}>
        <section id="products" {...stylex.props(styles.productBlock)}>
          <div {...stylex.props(styles.blockHead)}>
            <p {...stylex.props(styles.label)}>Products</p>
            <h2 {...stylex.props(styles.stencil, styles.blockTitle)}>
              <Stencil lines={["Three ways", "to trade"]} align="start" tones={[undefined, "#4A4B51"]} />
            </h2>
          </div>
          <Products
            data={{
              leader: star.id,
              lead: formatChange(star.lead),
              ahead: up,
              spark: board?.spark ?? [0, 0],
              count: total,
              top: board?.top.map((row) => row.id) ?? picks,
              level: board?.level ?? null,
              levelSpark: board?.levelSpark ?? [],
            }}
          />
        </section>
        {board && (
          <section {...stylex.props(styles.featureBlock)}>
            <div {...stylex.props(styles.blockHead)}>
              <p {...stylex.props(styles.label)}>Features</p>
              <h2 {...stylex.props(styles.stencil, styles.blockTitle)}>
                <Stencil lines={["One market", "one benchmark"]} align="start" tones={[undefined, "#4A4B51"]} />
              </h2>
            </div>
            <Features
              data={{
                leader: star.id,
                lead: formatChange(star.lead),
                ahead: up,
                spark: board.spark,
                top: board.top.map((row) => row.id),
                bottom: board.bottom.map((row) => row.id),
                count: board.count,
              }}
            />
          </section>
        )}
        {board && (
          <section id="board" {...stylex.props(styles.plain)}>
            <div {...stylex.props(styles.aside)}>
              <p {...stylex.props(styles.label)}>The board</p>
              <h2 {...stylex.props(styles.stencil, styles.plainTitle)}>
                <Stencil lines={["Rank it.", "Trade it."]} align="start" />
              </h2>
              <p {...stylex.props(styles.plainText)}>Every coin is measured against the market. Right of the line is ahead. Left is behind.</p>
              <Link href="/markets" {...stylex.props(styles.textLink)}>See all {board.count} coins</Link>
            </div>
            <div {...stylex.props(styles.list)}>
              <div aria-hidden="true" {...stylex.props(styles.listHead)}>
                <div {...stylex.props(styles.listEnds)}>
                  <span>Behind</span>
                  <span>Ahead</span>
                </div>
              </div>
              {board.rows.map((row) => {
                const up = row.lead >= 0;
                const width = `${(Math.abs(row.lead) / board.scale) * 48}%`;
                return (
                  <div key={row.id} {...stylex.props(styles.listRow)}>
                    <span {...stylex.props(styles.listName)}>
                      <Coin id={row.id} size={20} />
                      {row.id}
                    </span>
                    <span {...stylex.props(styles.lane)}>
                      <span {...stylex.props(styles.laneMiddle)} />
                      <span {...stylex.props(styles.laneBar, up ? styles.laneAhead : styles.laneBehind)} style={{ width }} />
                    </span>
                    <span {...stylex.props(styles.listLead, !up && styles.muted)}>{formatChange(row.lead)}</span>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <section id="how" {...stylex.props(styles.plain)}>
          <div {...stylex.props(styles.aside)}>
            <p {...stylex.props(styles.label)}>How it works</p>
            <h2 {...stylex.props(styles.stencil, styles.plainTitle)}>
              <Stencil lines={["Three steps"]} align="start" />
            </h2>
          </div>
          <div {...stylex.props(styles.trio)}>
            <div {...stylex.props(styles.trioItem)}>
              <span {...stylex.props(styles.trioNumber)}>01</span>
              <h3 {...stylex.props(styles.trioName)}>Pick a coin</h3>
              <p {...stylex.props(styles.trioText)}>Choose the one your research says will lead.</p>
            </div>
            <div {...stylex.props(styles.trioItem)}>
              <span {...stylex.props(styles.trioNumber)}>02</span>
              <h3 {...stylex.props(styles.trioName)}>Trade it</h3>
              <p {...stylex.props(styles.trioText)}>Put USDC behind it. Your share grows when it beats the market.</p>
            </div>
            <div {...stylex.props(styles.trioItem)}>
              <span {...stylex.props(styles.trioNumber)}>03</span>
              <h3 {...stylex.props(styles.trioName)}>Cash out</h3>
              <p {...stylex.props(styles.trioText)}>Leave any time. USDC goes back to your wallet.</p>
            </div>
          </div>
        </section>

        <section id="faq" {...stylex.props(styles.plain)}>
          <div {...stylex.props(styles.aside)}>
            <p {...stylex.props(styles.label)}>FAQ</p>
            <h2 {...stylex.props(styles.stencil, styles.plainTitle)}>
              <Stencil lines={["Questions"]} align="start" />
            </h2>
          </div>
          <Faq questions={questions} />
        </section>

        <footer {...stylex.props(styles.footer)}>
          <div {...stylex.props(styles.footTop)}>
            <div {...stylex.props(styles.footIntro)}>
              <span {...stylex.props(styles.footLogo)}>
                <Stencil lines={["RELATIVE"]} align="start" />
              </span>
              <p {...stylex.props(styles.footText)}>Trade the performance of the coin your analysis says will beat the rest of crypto.</p>
              <Link href="/markets" {...stylex.props(styles.button)}>Open app →</Link>
              <a href="https://x.com/getrelativ" target="_blank" rel="noopener noreferrer" {...stylex.props(styles.footLink)}>X · @getrelativ</a>
            </div>
            <nav aria-label="App" {...stylex.props(styles.footColumn)}>
              <p {...stylex.props(styles.label)}>App</p>
              <Link href="/markets" {...stylex.props(styles.footLink)}>Markets</Link>
              <Link href="/epochs" {...stylex.props(styles.footLink)}>Epoch</Link>
              <Link href="/portfolio" {...stylex.props(styles.footLink)}>Portfolio</Link>
              <Link href="/swap" {...stylex.props(styles.footLink)}>Swap</Link>
              <Link href="/faucet" {...stylex.props(styles.footLink)}>Faucet</Link>
            </nav>
            <nav aria-label="This page" {...stylex.props(styles.footColumn)}>
              <p {...stylex.props(styles.label)}>Learn</p>
              <a href="#board" {...stylex.props(styles.footLink)}>The board</a>
              <a href="#how" {...stylex.props(styles.footLink)}>How it works</a>
              <a href="#products" {...stylex.props(styles.footLink)}>Products</a>
              <a href="#faq" {...stylex.props(styles.footLink)}>Questions</a>
              <a href="#top" {...stylex.props(styles.footLink)}>Back to top</a>
            </nav>
            <div {...stylex.props(styles.footColumn)}>
              <p {...stylex.props(styles.label)}>Status</p>
              <span {...stylex.props(styles.footFact)}>Solana devnet</span>
              <span {...stylex.props(styles.footFact)}>Devnet USDC and rlUSD</span>
              <span {...stylex.props(styles.footFact)}>{board ? `${board.count} coins listed` : "Coins ranked live"}</span>
              <span {...stylex.props(styles.footFact)}>Prices every second</span>
            </div>
            <nav aria-label="Legal" {...stylex.props(styles.footColumn)}>
              <p {...stylex.props(styles.label)}>Legal</p>
              <Link href="/terms" {...stylex.props(styles.footLink)}>Terms of Use</Link>
              <Link href="/privacy" {...stylex.props(styles.footLink)}>Privacy Policy</Link>
              <CookieSettingsButton className={stylex.props(styles.footLink, styles.footButton).className} />
            </nav>
          </div>
          <div aria-hidden="true" {...stylex.props(styles.footWord)}>
            <Stencil lines={["RELATIVE"]} fill />
          </div>
        </footer>
      </div>
    </div>
    </LogoProvider>
  );
}
