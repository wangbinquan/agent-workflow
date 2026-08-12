// RFC-276 — natural OpenCode model enumeration.
//
// RFC-284 T19 —— `opencode models --verbose` 的解析/缓存主体自
// `util/opencode-models.ts` 迁入驱动邻位（RFC-282 C3 的归目原则：opencode 专属
// 实现住 driver 目录）。生产消费方只有本目录 driver（listModels /
// evictBinaryCaches 能力面）；registry 不再具名依赖 opencode 缓存。
//
// ── 原 util/opencode-models.ts 头注（历史保留）─────────────────────────────
// RFC-001: parse `opencode models --verbose` into a structured list, with a
// tiny in-memory cache keyed by binary path so changing `opencodePath` from
// settings invalidates the cache automatically.
//
// `opencode models --verbose` prints (see opencode source cli/cmd/models.ts:38-46):
//
//   <provider>/<modelID>
//   { ... JSON metadata (pretty-printed, multi-line) ... }
//   <provider>/<modelID>
//   { ... }
//
// Without --verbose only the id lines are emitted. We always pass --verbose
// and treat the JSON block as optional (parse failure → still keep the id).

import type { OpencodeModel } from '@agent-workflow/shared'
import { createLogger } from '@/util/log'
import { spawnVersionProbe } from '@/util/process'
import type { ListModelsOpts, RuntimeModelList } from '../types'

const log = createLogger('opencode-models')

const ID_LINE = /^[a-z0-9._-]+\/.+$/i

export interface ListOpencodeModelsResult {
  binary: string
  models: OpencodeModel[]
  cached: boolean
}

// RFC-114 D4: keyed by binary so multiple registered runtimes (a custom fork +
// the default opencode) cache independently — a single slot would thrash to
// `cached:false` whenever two binaries are queried alternately. admin-managed +
// low-cardinality (a handful of runtimes), so an unbounded Map is fine; it's
// also evicted on runtime delete / binary change (evictOpencodeModelsCache).
const cache = new Map<string, OpencodeModel[]>()

/** Test hook: drop the entire in-memory cache. */
export function clearOpencodeModelsCache(): void {
  cache.clear()
}

/** RFC-114 P3-6: drop one binary's slot (call on runtime delete / binary change). */
export function evictOpencodeModelsCache(binary: string): void {
  cache.delete(binary)
}

// RFC-114 P2-3: `<binary> models` now runs arbitrary admin-registered fork
// binaries, so bound it like the smoke probe — a hung fork must not wedge the
// daemon, and a flooding one must not OOM it.
const DEFAULT_MODELS_TIMEOUT_MS = 30_000
const MAX_MODELS_OUTPUT_BYTES = 4 * 1024 * 1024 // 4 MiB per stream
const MODELS_GROUP_REAP_WAIT_MS = 250

export async function listOpencodeModels(
  binary: string,
  opts?: {
    refresh?: boolean
    timeoutMs?: number
    cacheKey?: string
    env?: Record<string, string>
    cwd?: string
    beforeCacheWrite?: () => void | Promise<void>
  },
): Promise<ListOpencodeModelsResult> {
  const cacheKey = opts?.cacheKey ?? binary
  if (!opts?.refresh) {
    const hit = cache.get(cacheKey)
    if (hit !== undefined) return { binary, models: hit, cached: true }
  }

  const cmd = [binary, 'models', '--verbose']
  if (opts?.refresh) cmd.push('--refresh')

  // RFC-284 T8：spawn/双流 capped 读/有界组死 reap 骨架收敛
  // util/process.spawnVersionProbe（models 形态：maxBytes + awaitReapMs；
  // detached 恒开——恒有 timeout）。本函数只留 models 策略（超时/非零抛错、
  // 解析、缓存）；「plain proc.kill 留活孙进程」的 CI 教训与 detached 理由
  // 见骨架头注。
  const r = await spawnVersionProbe(cmd, {
    timeoutMs: opts?.timeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS,
    ...(opts?.env !== undefined ? { env: opts.env } : {}),
    ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
    maxBytes: MAX_MODELS_OUTPUT_BYTES,
    awaitReapMs: MODELS_GROUP_REAP_WAIT_MS,
  })

  if (r.timedOut) {
    log.warn('opencode models timed out', { binary })
    throw new Error(
      `opencode models timed out after ${opts?.timeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS}ms`,
    )
  }
  if (r.exitCode !== 0) {
    log.warn('opencode models non-zero exit', { binary, exitCode: r.exitCode })
    throw new Error(`opencode models exited ${r.exitCode}: ${r.stderr.trim() || '(no stderr)'}`)
  }

  const models = parseModelsOutput(r.stdout)
  await opts?.beforeCacheWrite?.()
  cache.set(cacheKey, models)
  return { binary, models, cached: false }
}

/** Pure parser — exposed for unit tests. */
export function parseModelsOutput(stdout: string): OpencodeModel[] {
  const lines = stdout.split(/\r?\n/)
  const out: OpencodeModel[] = []
  let current: { id: string; provider: string; modelID: string; jsonBuf: string[] } | null = null

  const flush = (): void => {
    if (current === null) return
    const model: OpencodeModel = {
      id: current.id,
      provider: current.provider,
      modelID: current.modelID,
    }
    const raw = current.jsonBuf.join('\n').trim()
    if (raw.length > 0) {
      try {
        const meta = JSON.parse(raw) as { name?: unknown }
        if (typeof meta.name === 'string' && meta.name.length > 0) model.name = meta.name
      } catch {
        // Verbose metadata may be missing or malformed for some providers;
        // fall back to id-only entry.
      }
    }
    out.push(model)
    current = null
  }

  for (const line of lines) {
    if (ID_LINE.test(line) && !line.trim().startsWith('{') && !line.trim().startsWith('"')) {
      flush()
      const slash = line.indexOf('/')
      const provider = line.slice(0, slash)
      const modelID = line.slice(slash + 1)
      current = { id: line, provider, modelID, jsonBuf: [] }
      continue
    }
    if (current !== null) current.jsonBuf.push(line)
  }
  flush()
  return out
}

export async function listOpencodeModelsNatural(
  binary: string,
  opts: ListModelsOpts = {},
): Promise<RuntimeModelList> {
  return listOpencodeModels(binary, {
    refresh: opts.refresh === true,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    cwd: opts.cwd ?? process.cwd(),
    env:
      opts.env ??
      Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => {
          return typeof entry[1] === 'string'
        }),
      ),
  })
}
