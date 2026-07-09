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
import { resolveSpawnCmd } from './opencode'

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
  opts?: { refresh?: boolean; timeoutMs?: number; cmd?: string[] },
): Promise<ListOpencodeModelsResult> {
  if (!opts?.refresh) {
    const hit = cache.get(binary)
    if (hit !== undefined) return { binary, models: hit, cached: true }
  }

  // cmd override allows cross-platform test stubs (Windows can't spawn .js directly)
  const cmd = opts?.cmd
    ? [...opts.cmd, 'models', '--verbose']
    : resolveSpawnCmd(binary, 'models', '--verbose')
  if (opts?.refresh) cmd.push('--refresh')

  // detached → the child leads its own process group, so the timeout can group-
  // kill it. A binary that forks a grandchild (a shell stub `sleep`s, real
  // opencode can spawn helpers) would otherwise keep the inherited stdout pipe
  // open and block the drain past the timeout (CI caught this — a plain
  // `proc.kill` left the grandchild alive). Mirrors runtimeSmoke.
  // On Windows, detached breaks the stdout pipe (the child gets its own console),
  // so we skip it there — killProcessTree handles Windows via taskkill /T /F.
  const isWindows = process.platform === 'win32'
  const proc = Bun.spawn({
    cmd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    ...(isWindows ? {} : { detached: true }),
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
  cache.set(binary, models)
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
