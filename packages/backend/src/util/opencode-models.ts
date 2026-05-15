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

const log = createLogger('opencode-models')

const ID_LINE = /^[a-z0-9._-]+\/.+$/i

export interface ListOpencodeModelsResult {
  binary: string
  models: OpencodeModel[]
  cached: boolean
}

let cache: { binary: string; models: OpencodeModel[] } | null = null

/** Test hook: drop the in-memory cache. */
export function clearOpencodeModelsCache(): void {
  cache = null
}

export async function listOpencodeModels(
  binary: string,
  opts?: { refresh?: boolean },
): Promise<ListOpencodeModelsResult> {
  if (!opts?.refresh && cache !== null && cache.binary === binary) {
    return { binary, models: cache.models, cached: true }
  }

  const cmd = [binary, 'models', '--verbose']
  if (opts?.refresh) cmd.push('--refresh')

  const proc = Bun.spawn({ cmd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  if (exitCode !== 0) {
    log.warn('opencode models non-zero exit', { binary, exitCode })
    throw new Error(`opencode models exited ${exitCode}: ${stderr.trim() || '(no stderr)'}`)
  }

  const models = parseModelsOutput(stdout)
  cache = { binary, models }
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
