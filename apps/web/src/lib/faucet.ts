export const FAUCET_WINDOW_SECONDS = 24 * 60 * 60;

export interface FaucetRecord {
  memo: string | null;
  blockTime: number | null;
  failed: boolean;
}

export interface ClaimAllowance {
  left: number;
  nextAt: number | null;
}

export function faucetMemo(owner: string): string {
  return `relative-faucet:${owner}`;
}

export function claimAllowance(records: readonly FaucetRecord[], owner: string, now: number, perDay: number): ClaimAllowance {
  const memo = faucetMemo(owner);
  const since = now - FAUCET_WINDOW_SECONDS;
  const times = records
    .filter((record) => !record.failed && record.memo !== null && record.memo.includes(memo))
    .map((record) => record.blockTime ?? now)
    .filter((time) => time > since)
    .sort((a, b) => a - b);
  const left = Math.max(0, perDay - times.length);
  const nextAt = left > 0 ? null : times[times.length - perDay]! + FAUCET_WINDOW_SECONDS;
  return { left, nextAt };
}
