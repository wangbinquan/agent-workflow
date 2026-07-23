// RFC-038 — pure detection + merge helpers for the AgentForm "auto-detect
// dependencies from body" button.
//
// Detection is plain `body.includes(name)` against four inventories
// (agents / skills / mcps / plugins). Case-sensitive, no word boundary, no
// fuzzy match — user explicit. False positives (e.g. `digit` matching
// `digit-validator`) are filtered by the user in the dialog before import.
//
// Empty inventory groups (query pending / failed) come in as `undefined`
// and produce an empty candidates list for that group, letting the caller
// surface "skipped" UI separately.

import type { AgentSkillRef, CreateAgent } from '@agent-workflow/shared'

export interface DetectInventoryRow {
  id: string
  name: string
  description?: string | null
  ownerUserId?: string | null
}

export interface DetectInventory {
  agents?: readonly DetectInventoryRow[]
  skills?: readonly DetectInventoryRow[]
  mcps?: readonly DetectInventoryRow[]
  plugins?: readonly DetectInventoryRow[]
}

export interface DetectExisting {
  dependsOn: readonly string[]
  skills: readonly string[]
  mcp: readonly string[]
  plugins: readonly string[]
}

export interface DetectionGroup {
  candidates: readonly DetectInventoryRow[]
}

export interface DetectionResult {
  agents: DetectionGroup
  skills: DetectionGroup
  mcps: DetectionGroup
  plugins: DetectionGroup
}

export type DetectionGroupKey = 'agents' | 'skills' | 'mcps' | 'plugins'

function buildGroup(
  body: string,
  rows: readonly DetectInventoryRow[] | undefined,
  existing: readonly string[],
  selfId: string | undefined,
): DetectionGroup {
  if (rows === undefined || rows.length === 0) return { candidates: [] }
  const existingSet = new Set(existing)
  const seen = new Set<string>()
  const out: DetectInventoryRow[] = []
  for (const r of rows) {
    if (typeof r.id !== 'string' || r.id.length === 0) continue
    if (typeof r.name !== 'string' || r.name.length === 0) continue
    if (r.id === selfId) continue
    if (existingSet.has(r.id)) continue
    if (seen.has(r.id)) continue
    if (!body.includes(r.name)) continue
    seen.add(r.id)
    out.push(r)
  }
  return { candidates: out }
}

export function detectAgentDeps(
  bodyMd: string,
  inventory: DetectInventory,
  existing: DetectExisting,
  selfId?: string,
): DetectionResult {
  const body = bodyMd ?? ''
  if (body === '') {
    return {
      agents: { candidates: [] },
      skills: { candidates: [] },
      mcps: { candidates: [] },
      plugins: { candidates: [] },
    }
  }
  return {
    agents: buildGroup(body, inventory.agents, existing.dependsOn, selfId),
    skills: buildGroup(body, inventory.skills, existing.skills, undefined),
    mcps: buildGroup(body, inventory.mcps, existing.mcp, undefined),
    plugins: buildGroup(body, inventory.plugins, existing.plugins, undefined),
  }
}

export interface DepSelection {
  agents: readonly string[]
  skills: readonly string[]
  mcps: readonly string[]
  plugins: readonly string[]
}

function appendUnique(
  prev: readonly string[] | undefined,
  add: readonly string[],
): { next: readonly string[]; changed: boolean } {
  const base = prev ?? []
  if (add.length === 0) return { next: base, changed: false }
  const existingSet = new Set(base)
  const additions: string[] = []
  for (const n of add) {
    if (existingSet.has(n)) continue
    existingSet.add(n)
    additions.push(n)
  }
  if (additions.length === 0) return { next: base, changed: false }
  return { next: [...base, ...additions], changed: true }
}

export function mergeAgentDeps(value: CreateAgent, selection: DepSelection): CreateAgent {
  // RFC-223: detection matches display names in prose, but every selected
  // catalog row already carries its immutable id. Persist those ids directly;
  // name is never an identity fallback.
  const a = appendUnique(value.dependsOn, selection.agents)
  const s = appendSkillRefs(value.skills, selection.skills)
  const m = appendUnique(value.mcp, selection.mcps)
  const p = appendUnique(value.plugins, selection.plugins)
  if (!a.changed && !s.changed && !m.changed && !p.changed) return value
  return {
    ...value,
    dependsOn: a.next as string[],
    skills: s.next,
    mcp: m.next as string[],
    plugins: p.next as string[],
  }
}

const skillRefKey = (ref: AgentSkillRef): string =>
  ref.kind === 'managed' ? `m:${ref.skillId}` : `p:${ref.name}`

function appendSkillRefs(
  prev: readonly AgentSkillRef[] | undefined,
  addIds: readonly string[],
): { next: AgentSkillRef[]; changed: boolean } {
  const base = [...(prev ?? [])]
  if (addIds.length === 0) return { next: base, changed: false }
  const existing = new Set(base.map(skillRefKey))
  const additions: AgentSkillRef[] = []
  for (const id of addIds) {
    const ref: AgentSkillRef = { kind: 'managed', skillId: id }
    const key = skillRefKey(ref)
    if (existing.has(key)) continue
    existing.add(key)
    additions.push(ref)
  }
  if (additions.length === 0) return { next: base, changed: false }
  return { next: [...base, ...additions], changed: true }
}

export function totalCandidates(result: DetectionResult): number {
  return (
    result.agents.candidates.length +
    result.skills.candidates.length +
    result.mcps.candidates.length +
    result.plugins.candidates.length
  )
}
