import { readFileSync, writeFileSync } from "node:fs";
import { type CoinGeckoCoin, chunk, matchCoin, tickerSymbol } from "../src/lib/coingecko-match.ts";

const IDS_FILE = new URL("../src/lib/coingecko-ids.json", import.meta.url);
const API_URL = (process.env.COX_API_URL?.trim() || "https://api.getrelative.trade").replace(/\/+$/, "");
const KEY = process.env.COINGECKO_API_KEY?.trim();
const SYMBOLS_PER_CALL = 50;
const PAGE_SIZE = 250;
const PAUSE_MS = KEY ? 2_500 : 20_000;
const RETRY_MS = 65_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function json<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "relative-logo-ids", ...headers } });
    if (response.status === 429 && attempt < 3) {
      console.log(`  rate limited, waiting ${RETRY_MS / 1000}s`);
      await sleep(RETRY_MS);
      continue;
    }
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url.split("?")[0]}`);
    return (await response.json()) as T;
  }
}

async function livePrices(): Promise<{ assets: string[]; prices: Map<string, number> }> {
  const assets = (await json<{ data: Array<{ assetId: string }> }>(`${API_URL}/v1/assets`)).data.map((asset) => asset.assetId);
  const record = (await json<{ data: { record: { scales: { price: string }; assets: Array<{ assetId: string; priceE8: string }> } } }>(`${API_URL}/v1/preview`)).data.record;
  const scale = Number(record.scales.price);
  return { assets, prices: new Map(record.assets.map((asset) => [asset.assetId, Number(asset.priceE8) / scale])) };
}

async function coinsFor(symbols: string[]): Promise<CoinGeckoCoin[]> {
  const headers: Record<string, string> = KEY ? { "x-cg-demo-api-key": KEY } : {};
  const coins: CoinGeckoCoin[] = [];
  for (let page = 1; ; page += 1) {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&include_tokens=all&per_page=${PAGE_SIZE}&page=${page}&symbols=${symbols.join(",")}`;
    const batch = await json<CoinGeckoCoin[]>(url, headers);
    coins.push(...batch);
    if (batch.length < PAGE_SIZE) return coins;
    await sleep(PAUSE_MS);
  }
}

async function main(): Promise<void> {
  const known = JSON.parse(readFileSync(IDS_FILE, "utf8")) as Record<string, string>;
  const { assets, prices } = await livePrices();
  const missing = assets.filter((assetId) => !known[assetId]);
  console.log(`${assets.length} live assets, ${assets.length - missing.length} already have an id, ${missing.length} to look up${KEY ? "" : " (no COINGECKO_API_KEY, going slowly)"}`);

  const priced = missing.filter((assetId) => (prices.get(assetId) ?? 0) > 0);
  const unresolved: string[] = missing.filter((assetId) => !priced.includes(assetId)).map((assetId) => `${assetId} (no live price)`);
  const found: Record<string, string> = {};
  const groups = chunk(priced, SYMBOLS_PER_CALL);
  for (const [index, group] of groups.entries()) {
    console.log(`  batch ${index + 1} of ${groups.length}`);
    const coins = await coinsFor([...new Set(group.map(tickerSymbol))]);
    for (const assetId of group) {
      const id = matchCoin(assetId, prices.get(assetId) as number, coins);
      if (id) found[assetId] = id;
      else unresolved.push(assetId);
    }
    if (index < groups.length - 1) await sleep(PAUSE_MS);
  }

  const merged: Record<string, string> = {};
  for (const assetId of assets) {
    const id = known[assetId] ?? found[assetId];
    if (id) merged[assetId] = id;
  }
  for (const [assetId, id] of Object.entries(known)) merged[assetId] ??= id;
  writeFileSync(IDS_FILE, `${JSON.stringify(merged, null, 2)}\n`);

  console.log(`added ${Object.keys(found).length}, ${Object.keys(merged).length} assets now have an id`);
  if (unresolved.length > 0) console.log(`no confident match, add these by hand in src/lib/coingecko-ids.json:\n  ${unresolved.join("\n  ")}`);
}

await main();
