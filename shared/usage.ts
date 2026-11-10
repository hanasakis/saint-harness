import type { SessionStats } from './types';
export function cacheHitRate(stats?: SessionStats) {
  if (!stats) return undefined;
  const { input, cacheRead, cacheWrite } = stats.tokens;
  if (![input, cacheRead, cacheWrite].every(n => Number.isFinite(n) && n >= 0)) return undefined;
  const totalInput = input + cacheRead + cacheWrite;
  return totalInput > 0 ? cacheRead / totalInput * 100 : undefined;
}
