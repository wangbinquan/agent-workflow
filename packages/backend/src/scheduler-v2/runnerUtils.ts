// RFC-061 PR-B T10 — runner-v2 utility helpers extracted from the
// (deleted) services/runner.ts. After T10 these live here under
// scheduler-v2/ where runner-v2 + ProductionRunnerAdapter consume them
// directly.

import { cpSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Agent, Mcp, Plugin } from '@agent-workflow/shared'
import { type Logger } from '@/util/log'

export type SkillSource = 'managed' | 'external' | 'project'

export interface ResolvedSkill {
  name: string
  sourceKind: SkillSource
  sourcePath?: string
}

export interface AgentOverrides {
  model?: string
  variant?: string
  temperature?: number
}

export interface RunResult {
  status: 'done' | 'failed' | 'canceled'
  exitCode: number | null
  outputs: Record<string, string>
  tokenUsage: {
    input: number
    output: number
    cacheCreate: number
    cacheRead: number
    total: number
  }
  errorMessage?: string
  prompt: string
  sessionId?: string
}

/**
 * Lay out skill bundles inside the per-attempt opencode config dir.
 * `managed` skills are copied into `runDir/skills/<name>/`. `external`
 * skills are symlinked. `project` skills are left for opencode self-
 * discovery via repo-local `.opencode/skills/`.
 */
export function prepareSkills(runDir: string, skills: ResolvedSkill[], log: Logger): void {
  if (skills.length === 0) return
  const skillsDir = join(runDir, 'skills')
  try {
    mkdirSync(skillsDir, { recursive: true })
  } catch {
    /* exists */
  }
  for (const s of skills) {
    if (s.sourceKind === 'project') continue
    if (!s.sourcePath) continue
    const target = join(skillsDir, s.name)
    try {
      rmSync(target, { recursive: true, force: true })
    } catch {
      /* first run */
    }
    try {
      mkdirSync(dirname(target), { recursive: true })
      if (s.sourceKind === 'managed') {
        cpSync(s.sourcePath, target, { recursive: true })
      } else {
        symlinkSync(s.sourcePath, target, 'dir')
      }
    } catch (err) {
      log.warn('prepareSkills failed for skill', {
        skill: s.name,
        sourceKind: s.sourceKind,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

export function buildInlineAgentEntry(
  agent: Agent,
  overrides?: AgentOverrides,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    prompt: (agent as { prompt?: string }).prompt ?? '',
  }
  const m = overrides?.model ?? (agent as { model?: string }).model
  if (m) entry.model = m
  const v = overrides?.variant ?? (agent as { variant?: string }).variant
  if (v) entry.variant = v
  const t = overrides?.temperature ?? (agent as { temperature?: number }).temperature
  if (typeof t === 'number') entry.temperature = t
  const perm = (agent as { permission?: unknown }).permission
  if (perm && typeof perm === 'object') entry.permission = perm
  const tools = (agent as { tools?: unknown }).tools
  if (tools !== undefined) entry.tools = tools
  return entry
}

export function buildInlineConfig(
  agent: Agent,
  overrides: AgentOverrides | undefined,
  dependents: readonly Agent[],
  mcps: readonly Mcp[] = [],
  plugins: readonly Plugin[] = [],
): {
  agent: Record<string, Record<string, unknown>>
  mcp?: Record<string, Record<string, unknown>>
  plugin?: Array<string | [string, Record<string, unknown>]>
} {
  const map: Record<string, Record<string, unknown>> = {
    [agent.name]: buildInlineAgentEntry(agent, overrides),
  }
  for (const dep of dependents) {
    if (dep.name === agent.name) continue
    if (map[dep.name] !== undefined) continue
    map[dep.name] = buildInlineAgentEntry(dep)
  }
  const out: {
    agent: Record<string, Record<string, unknown>>
    mcp?: Record<string, Record<string, unknown>>
    plugin?: Array<string | [string, Record<string, unknown>]>
  } = { agent: map }
  const mcpMap: Record<string, Record<string, unknown>> = {}
  for (const m of mcps) {
    if ((m as { enabled?: boolean }).enabled === false) continue
    if (mcpMap[m.name] !== undefined) continue
    mcpMap[m.name] = buildInlineMcpEntry(m)
  }
  if (Object.keys(mcpMap).length > 0) out.mcp = mcpMap
  const pluginArr: Array<string | [string, Record<string, unknown>]> = []
  const pluginSeen = new Set<string>()
  for (const p of plugins) {
    if ((p as { enabled?: boolean }).enabled === false) continue
    if (pluginSeen.has(p.name)) continue
    pluginSeen.add(p.name)
    const cachedPath = (p as { cachedPath: string }).cachedPath
    const pathSpec = cachedPath.startsWith('file://') ? cachedPath : `file://${cachedPath}`
    const opts = (p as { options?: Record<string, unknown> }).options
    const optsClean = opts && Object.keys(opts).length > 0 ? opts : undefined
    pluginArr.push(optsClean === undefined ? pathSpec : [pathSpec, optsClean])
  }
  if (pluginArr.length > 0) out.plugin = pluginArr
  return out
}

function buildInlineMcpEntry(m: Mcp): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    type: (m as { type: string }).type,
    enabled: (m as { enabled?: boolean }).enabled,
  }
  const mr = m as Record<string, unknown>
  if (entry.type === 'local') {
    if (Array.isArray(mr.command)) entry.command = mr.command
    if (mr.env && typeof mr.env === 'object') entry.environment = mr.env
  } else {
    if (typeof mr.url === 'string') entry.url = mr.url
    if (mr.headers && typeof mr.headers === 'object') entry.headers = mr.headers
    if (mr.oauth) entry.oauth = mr.oauth
  }
  const timeoutMs = mr.timeoutMs
  if (typeof timeoutMs === 'number') entry.timeout = timeoutMs
  return entry
}

export async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => Promise<void> | void,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (line.length > 0) await onLine(line)
      }
    }
    if (buffer.length > 0) await onLine(buffer)
  } finally {
    reader.releaseLock()
  }
}

export function extractTextFromEvent(evt: Record<string, unknown>): string | null {
  const part = evt.part as Record<string, unknown> | undefined
  if (part && typeof part === 'object') {
    const t = part.text
    if (typeof t === 'string') return t
  }
  const t2 = (evt as { text?: unknown }).text
  if (typeof t2 === 'string') return t2
  return null
}

export function inferEventKind(
  evt: Record<string, unknown>,
): 'tool_use' | 'text' | 'reasoning' | 'permission_asked' | 'error' | 'step_start' | 'step_finish' {
  const t = evt.type
  if (typeof t === 'string') {
    if (t === 'tool_use') return 'tool_use'
    if (t === 'text') return 'text'
    if (t === 'reasoning') return 'reasoning'
    if (t === 'permission.asked' || t === 'permission_asked') return 'permission_asked'
    if (t === 'error') return 'error'
    if (t === 'step_start') return 'step_start'
    if (t === 'step_finish') return 'step_finish'
  }
  return 'text'
}

export function accumulateTokens(evt: Record<string, unknown>, acc: RunResult['tokenUsage']): void {
  const sources: Array<Record<string, unknown> | undefined> = [
    (evt as { tokens?: Record<string, unknown> }).tokens,
    (evt as { part?: { tokens?: Record<string, unknown> } }).part?.tokens,
    (evt as { usage?: Record<string, unknown> }).usage,
    (evt as { step?: { tokens?: Record<string, unknown> } }).step?.tokens,
    (evt as { message?: { usage?: Record<string, unknown> } }).message?.usage,
  ]
  for (const src of sources) {
    if (!src) continue
    acc.input = Math.max(acc.input, numOrZero(src.input_tokens ?? src.inputTokens ?? src.input))
    acc.output = Math.max(
      acc.output,
      numOrZero(src.output_tokens ?? src.outputTokens ?? src.output),
    )
    acc.cacheCreate = Math.max(
      acc.cacheCreate,
      numOrZero(src.cache_creation_input_tokens ?? src.cacheCreate),
    )
    acc.cacheRead = Math.max(acc.cacheRead, numOrZero(src.cache_read_input_tokens ?? src.cacheRead))
  }
  acc.total = acc.input + acc.output + acc.cacheCreate + acc.cacheRead
}

function numOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
