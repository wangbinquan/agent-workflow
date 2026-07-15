// RFC-191 (T1) — the single relative-time oracle for LIST-layer timestamps.
//
// 口径（RFC-191/192 决策 D4）：列表层 = 相对时间 + title 绝对时间；详情层保持
// 绝对时间。Pure token shape (i18n key + interpolation opts) so tests stay
// deterministic and the component renders via t().
//
// Past-direction thresholds mirror lib/homepage.ts#formatRelativeTime exactly;
// the two are locked against drift by relative-time.test.ts's cross-check
// (that helper is RFC-190's active battleground, so convergence is test-first
// instead of a code-level delegate for now — see RFC-191 design §3.3).

export type RelativeTimeKey =
  | 'justNow'
  | 'minAgo'
  | 'hourAgo'
  | 'dayAgo'
  | 'inMin'
  | 'inHour'
  | 'inDay'

export interface RelativeTimeTokenResult {
  /** i18n key under `common.relTime.*`. */
  key: RelativeTimeKey
  opts?: { n: number }
}

/**
 * Map a timestamp to an i18n token, both directions. Within 60 s of `now`
 * (either side) it is "just now" — the future side deliberately has no
 * seconds granularity so a scheduler firing imminently never renders a
 * silly「0 分钟后」.
 */
export function relativeTimeToken(nowMs: number, atMs: number): RelativeTimeTokenResult {
  const dt = nowMs - atMs
  const abs = Math.abs(dt)
  if (abs < 60_000) return { key: 'justNow' }
  const past = dt >= 0
  const mins = Math.floor(abs / 60_000)
  if (mins < 60) return { key: past ? 'minAgo' : 'inMin', opts: { n: mins } }
  const hours = Math.floor(abs / 3_600_000)
  if (hours < 24) return { key: past ? 'hourAgo' : 'inHour', opts: { n: hours } }
  const days = Math.floor(abs / 86_400_000)
  return { key: past ? 'dayAgo' : 'inDay', opts: { n: days } }
}

/**
 * Normalize the two timestamp shapes the app stores: epoch ms (tasks,
 * workflows, …) and ISO strings (`CachedRepo.lastFetchedAt`). Invalid input
 * → null so the component can fall back to an em dash instead of NaN text.
 */
export function toEpochMs(ts: number | string): number | null {
  const ms = typeof ts === 'number' ? ts : Date.parse(ts)
  return Number.isFinite(ms) ? ms : null
}
