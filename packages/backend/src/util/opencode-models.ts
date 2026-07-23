// RFC-001: parse `opencode models --verbose` into a structured list, with a
// tiny in-memory cache keyed by binary path so changing `opencodePath` from
// settings invalidates the cache automatically.
//
// `opencode models --verbose` prints (see /Users/wangbinquan/Documents/code/opencode/.../cli/cmd/models.ts:38-46):
//
//   <provider>/<modelID>
//   { ... JSON metadata (pretty-printed, multi-line) ... }
//   <provider>/<modelID>
//   { ... }
//
// Without --verbose only the id lines are emitted. We always pass --verbose
// and treat the JSON block as optional (parse failure → still keep the id).

import type { OpencodeModel } from '@agent-workflow/shared'
import { createLogger } from './log'
import { killProcessTree } from './process'

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

function processGroupAlive(groupLeaderPid: number): boolean {
  try {
    process.kill(-groupLeaderPid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * A detached wrapper can fork a helper with closed stdio and then exit before
 * the timeout. The direct child and both drains are finished in that case, but
 * its process group can still contain the helper. Always kill the group and
 * give the kernel a short bounded window to reap it before returning.
 */
async function reapModelsProcessGroup(groupLeaderPid: number | undefined): Promise<void> {
  if (typeof groupLeaderPid !== 'number' || groupLeaderPid <= 0) return
  try {
    // The direct child has already been waited/reaped. Never use
    // killProcessTree's positive-PID fallback here: if the now-free leader PID
    // were reused, that fallback could kill an unrelated process. `detached`
    // guarantees our surviving descendants (if any) remain addressable only
    // through the original negative PGID.
    process.kill(-groupLeaderPid, 'SIGKILL')
  } catch {
    return
  }
  const deadline = Date.now() + MODELS_GROUP_REAP_WAIT_MS
  while (Date.now() < deadline && processGroupAlive(groupLeaderPid)) {
    await Bun.sleep(10)
  }
}

/** Drain a stream to EOF but stop ACCUMULATING past `cap` bytes (keep reading so
 *  the child's pipe never wedges). Returns the captured (possibly truncated) text. */
async function readCapped(
  stream: ReadableStream<Uint8Array> | undefined,
  cap: number,
): Promise<string> {
  if (stream === undefined) return ''
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined && total < cap) {
        chunks.push(value)
        total += value.byteLength
      }
    }
  } catch {
    /* stream closed under us (kill) */
  }
  return Buffer.concat(chunks).toString('utf-8')
}

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

  // detached → the child leads its own process group, so the timeout can group-
  // kill it. A binary that forks a grandchild (a shell stub `sleep`s, real
  // opencode can spawn helpers) would otherwise keep the inherited stdout pipe
  // open and block the drain past the timeout (CI caught this — a plain
  // `proc.kill` left the grandchild alive). Mirrors runtimeSmoke.
  const proc = Bun.spawn({
    cmd,
    ...(opts?.env !== undefined ? { env: opts.env } : {}),
    ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    detached: true,
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      if (typeof proc.pid === 'number') killProcessTree(proc.pid, 'SIGKILL')
      else proc.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }, opts?.timeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS)
  ;(timer as { unref?: () => void }).unref?.()

  let stdout = ''
  let stderr = ''
  let exitCode: number | null = null
  try {
    ;[stdout, stderr, exitCode] = await Promise.all([
      readCapped(proc.stdout as ReadableStream<Uint8Array> | undefined, MAX_MODELS_OUTPUT_BYTES),
      readCapped(proc.stderr as ReadableStream<Uint8Array> | undefined, MAX_MODELS_OUTPUT_BYTES),
      proc.exited,
    ])
  } finally {
    clearTimeout(timer)
    await reapModelsProcessGroup(proc.pid)
  }

  if (timedOut) {
    log.warn('opencode models timed out', { binary })
    throw new Error(
      `opencode models timed out after ${opts?.timeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS}ms`,
    )
  }
  if (exitCode !== 0) {
    log.warn('opencode models non-zero exit', { binary, exitCode })
    throw new Error(`opencode models exited ${exitCode}: ${stderr.trim() || '(no stderr)'}`)
  }

  const models = parseModelsOutput(stdout)
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
