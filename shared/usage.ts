import type { SessionStats } from './types';
export function cacheHitRate(stats?: SessionStats) {
  if (!stats) return undefined;
  const { input, cacheRead, cacheWrite } = stats.tokens;
  if (![input, cacheRead, cacheWrite].every(n => Number.isFinite(n) && n >= 0)) return undefined;
  const totalInput = input + cacheRead + cacheWrite;
  return totalInput > 0 ? cacheRead / totalInput * 100 : undefined;
}

export function formatContextPercent(percent?: number | null) {
  if (percent == null || !Number.isFinite(percent) || percent < 0) return '—';
  if (percent > 0 && percent < 0.01) return '<0.01%';
  return `${percent.toLocaleString('en-US', { maximumFractionDigits: 2, useGrouping: false })}%`;
}
