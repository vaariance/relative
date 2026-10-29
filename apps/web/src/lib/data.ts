import "server-only";
import { FIXTURE_DEMO_WALLET } from "./config";
import { chunk } from "./coingecko-match";
import { COINGECKO_IDS } from "./logos";
import { type CoxAsset, type CoxDeployment, type CoxStatus, type CryptoComposition, type EpochOverview, type Portfolio, type Preview, type Publication, CoxApiError, createCoxApiClient } from "@eox/app-api";

const HISTORY = 1440;
const PAGE = 100;
const MAX_PAGES = 20;
const OWNER = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const configuredWallet = process.env.COX_DEMO_WALLET;
function configuredApiUrl(): string {
  const value = process.env.COX_API_URL?.trim();
  if (!value) throw new Error("COX_API_URL is not set. Add it to apps/web/.env.local or to the hosting environment.");
  return value.replace(/\/+$/, "");
}

export const API_URL = configuredApiUrl();
export const api = createCoxApiClient({
  baseUrl: API_URL,
  fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
});

export async function getDeployment(): Promise<CoxDeployment> {
  return (await api.deployment()).data;
}

export async function getStatus(): Promise<CoxStatus> {
  return (await api.status()).data;
}

export async function getPreview(): Promise<Preview | null> {
  try {
    return (await api.preview()).data;
  } catch {
    return null;
  }
}

export interface EpochsRead {
  overview: EpochOverview;
  fetchedAt: number;
  fresh: boolean;
}

let lastEpochs: { overview: EpochOverview; fetchedAt: number } | null = null;

export async function getEpochs(): Promise<EpochsRead | null> {
  try {
    lastEpochs = { overview: (await api.epochs()).data, fetchedAt: Math.floor(Date.now() / 1000) };
    return { ...lastEpochs, fresh: true };
  } catch {
    return lastEpochs ? { ...lastEpochs, fresh: false } : null;
  }
}

export async function getAssets(): Promise<CoxAsset[]> {
  return (await api.assets()).data;
}

export async function getCrypto(): Promise<CryptoComposition> {
  return (await api.crypto()).data;
}

interface History {
  pool: string | null;
  publications: Publication[];
}

let history: History = { pool: null, publications: [] };
let loading: Promise<Publication[]> | null = null;

async function loadPublications(): Promise<Publication[]> {
  const { deployment, data: status } = await api.status();
  const pool = deployment.poolAddress ?? deployment.network;
  const latest = status.latestSequence;
  const held = history.pool === pool ? history.publications : [];
  if (latest === null) {
    history = { pool, publications: [] };
    return [];
  }
  const last = held.length > 0 ? held[held.length - 1].identity.sequence : null;
  const known = last !== null && last <= latest ? held : [];
  const floor = latest - HISTORY;
  let after: number | null = known.length > 0 ? known[known.length - 1].identity.sequence : floor >= 0 ? floor : null;
  const publications = [...known];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data } = await api.publications(after, PAGE);
    publications.push(...data.events.map((event) => event.publication));
    if (data.events.length < PAGE || data.nextAfter === null) break;
    after = data.nextAfter;
  }
  history = { pool, publications: publications.slice(-HISTORY) };
  return history.publications;
}

export async function getPublications(): Promise<Publication[]> {
  loading ??= loadPublications().finally(() => {
    loading = null;
  });
  return loading;
}

const LOGO_SECONDS = 86400;
const LOGO_BATCH = 250;

async function logoImages(ids: string[], key: string | undefined): Promise<Array<[string, string]>> {
  try {
    const response = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=${LOGO_BATCH}&ids=${ids.join(",")}`, {
      headers: key ? { accept: "application/json", "x-cg-demo-api-key": key } : { accept: "application/json" },
      next: { revalidate: LOGO_SECONDS },
    });
    if (!response.ok) return [];
    const coins = (await response.json()) as Array<{ id: string; image?: string }>;
    return coins.flatMap((coin) => (coin.image ? [[coin.id, coin.image] as [string, string]] : []));
  } catch {
    return [];
  }
}

export async function getLogos(): Promise<Record<string, string>> {
  const key = process.env.COINGECKO_API_KEY?.trim();
  const images = new Map((await Promise.all(chunk([...new Set(Object.values(COINGECKO_IDS))], LOGO_BATCH).map((ids) => logoImages(ids, key)))).flat());
  return Object.fromEntries(Object.entries(COINGECKO_IDS).flatMap(([assetId, id]) => (images.has(id) ? [[assetId, images.get(id) as string]] : [])));
}

export async function getDemoPortfolio(): Promise<Portfolio | null> {
  if ((await getDeployment()).origin !== "fixture") return null;
  const demoWallet = configuredWallet ?? FIXTURE_DEMO_WALLET;
  if (!OWNER.test(demoWallet)) return null;
  try {
    return (await api.portfolio(demoWallet)).data;
  } catch (error) {
    if (error instanceof CoxApiError && error.code === "UNKNOWN_WALLET") return null;
    throw error;
  }
}
