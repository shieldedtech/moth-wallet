// Per-wallet sync formatting — mirrors midnight-wallet-cli (Apache-2.0). See NOTICE.

export interface SubWalletProgress {
  applied: number;
  total: number;
}

/** Format applied/total with percentage, e.g. "123/456 (27%)". */
export function formatProgress(progress: SubWalletProgress | undefined): string {
  const applied = progress?.applied ?? 0;
  const total = progress?.total ?? 0;
  if (total === 0) return '0/0 (100%)';
  const pct = Math.floor((applied / total) * 100);
  return `${applied}/${total} (${pct}%)`;
}
