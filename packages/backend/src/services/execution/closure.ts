// RFC-242 §3.1 — the launch-time reference-closure freeze.
//
// A parent task whose definition contains call nodes freezes EVERY transitively
// referenced workflow definition (by authoritative NAME selector) into
// `tasks.ref_closure_json` at launch. Runtime never re-reads the referenced
// resource rows (D9): edits/deletes after launch cannot change a running tree,
// and grandchildren inherit the relevant subset instead of resolving live.
//
// The walk doubles as the authoritative cycle gate (validator's 4f rule is the
// advisory twin over possibly-stale resolvers): a cycle or an unresolvable
// name fails the LAUNCH closed with id-only payloads (design-gate P2-6 —
// names are display data the launcher may not be entitled to echo).
import { asc, inArray } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { workflows, workgroups as workgroupsTable } from '@/db/schema'
import { getWorkgroupById } from '@/services/workgroups'
import { ValidationError } from '@/util/errors'
import {
  collectWorkflowCallRefs,
  collectWorkgroupCallRefs,
  detectCallCycles,
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
} from '@agent-workflow/shared'

export interface FrozenWorkflowRef {
  id: string
  version: number
  definition: WorkflowDefinition
}

/** RFC-242 PR-4 — a frozen workgroup RESOURCE row (member roster included).
 *  Stored opaquely: the frozen-launch face re-derives the runtime config via
 *  buildWorkgroupRuntimeConfig(group, renderedGoal) at call time, so the
 *  closure never bakes a goal in. Workgroups are closure LEAVES (the dw
 *  validator rejects call nodes in generated DAGs). */
export interface FrozenWorkgroupRef {
  id: string
  version: number
  group: unknown
}

export interface FrozenCallClosure {
  workflows: Record<string, FrozenWorkflowRef>
  workgroups: Record<string, FrozenWorkgroupRef>
}

/** Parse a stored closure JSON. Returns null for NULL/corrupt (callers fail
 *  closed with `workflow-call-ref-missing` at the consumption site). */
export function parseCallClosure(json: string | null): FrozenCallClosure | null {
  if (json === null || json === '') return null
  try {
    const parsed = JSON.parse(json) as { workflows?: unknown }
    if (typeof parsed !== 'object' || parsed === null) return null
    const rawWorkflows = parsed.workflows
    if (typeof rawWorkflows !== 'object' || rawWorkflows === null) return null
    const out: FrozenCallClosure = { workflows: {}, workgroups: {} }
    for (const [name, ref] of Object.entries(rawWorkflows as Record<string, unknown>)) {
      const r = ref as { id?: unknown; version?: unknown; definition?: unknown }
      if (typeof r.id !== 'string' || typeof r.version !== 'number') return null
      const def = WorkflowDefinitionSchema.safeParse(r.definition)
      if (!def.success) return null
      out.workflows[name] = { id: r.id, version: r.version, definition: def.data }
    }
    const rawWorkgroups = (parsed as { workgroups?: unknown }).workgroups
    if (rawWorkgroups !== undefined) {
      if (typeof rawWorkgroups !== 'object' || rawWorkgroups === null) return null
      for (const [name, ref] of Object.entries(rawWorkgroups as Record<string, unknown>)) {
        const r = ref as { id?: unknown; version?: unknown; group?: unknown }
        if (typeof r.id !== 'string' || typeof r.version !== 'number') return null
        if (typeof r.group !== 'object' || r.group === null) return null
        out.workgroups[name] = { id: r.id, version: r.version, group: r.group }
      }
    }
    return out
  } catch {
    return null
  }
}

export function frozenWorkflowFromClosure(
  closureJson: string | null,
  name: string,
): FrozenWorkflowRef | null {
  return parseCallClosure(closureJson)?.workflows[name] ?? null
}

export function frozenWorkgroupFromClosure(
  closureJson: string | null,
  name: string,
): FrozenWorkgroupRef | null {
  return parseCallClosure(closureJson)?.workgroups[name] ?? null
}

/**
 * The closure subset a CHILD task passes down to its own grandchildren: every
 * entry except definitions unreachable from the child's definition. Keeping
 * the exact reachable set (BFS over the frozen graph, no DB) preserves the
 * recursion invariant "a task's closure covers its own call nodes".
 */
export function childClosureSubset(
  closureJson: string | null,
  childDefinition: WorkflowDefinition,
): string | null {
  const closure = parseCallClosure(closureJson)
  if (closure === null) return null
  const kept: FrozenCallClosure = { workflows: {}, workgroups: {} }
  const keepWorkgroupsOf = (defn: WorkflowDefinition): void => {
    for (const ref of collectWorkgroupCallRefs(defn)) {
      const g = closure.workgroups[ref.workgroupName]
      if (g !== undefined) kept.workgroups[ref.workgroupName] = g
    }
  }
  keepWorkgroupsOf(childDefinition)
  const queue = collectWorkflowCallRefs(childDefinition).map((r) => r.workflowName)
  const seen = new Set<string>()
  while (queue.length > 0) {
    const name = queue.shift()!
    if (seen.has(name)) continue
    seen.add(name)
    const ref = closure.workflows[name]
    if (ref === undefined) continue // consumption site fails closed later
    kept.workflows[name] = ref
    keepWorkgroupsOf(ref.definition)
    for (const next of collectWorkflowCallRefs(ref.definition)) queue.push(next.workflowName)
  }
  return Object.keys(kept.workflows).length === 0 && Object.keys(kept.workgroups).length === 0
    ? null
    : JSON.stringify(kept)
}

/**
 * Freeze the reference closure for a PARENT launch. Returns null when the
 * definition has no call nodes (byte-compat fast path). Throws:
 *   - `workflow-call-ref-missing` — a referenced name has no resource row (or
 *     its stored definition no longer parses);
 *   - `workflow-call-cycle` — the frozen call graph contains a cycle (payload
 *     lists resource-id paths only).
 */
export async function freezeCallClosure(
  db: DbClient,
  root: { id: string; definition: WorkflowDefinition },
): Promise<string | null> {
  const rootRefs = collectWorkflowCallRefs(root.definition)
  const rootWorkgroupRefs = collectWorkgroupCallRefs(root.definition)
  if (rootRefs.length === 0 && rootWorkgroupRefs.length === 0) return null

  const resolved = new Map<string, FrozenWorkflowRef>()
  let frontier = [...new Set(rootRefs.map((r) => r.workflowName))]
  while (frontier.length > 0) {
    const missing = frontier.filter((name) => !resolved.has(name))
    if (missing.length === 0) break
    // `workflows.name` is NOT unique (YAML import collisions live behind a
    // dialog). Freeze-time has no dialog — resolution must be DETERMINISTIC:
    // oldest row (lowest ULID) wins, first-wins per name. The validator's
    // closure loader follows the same rule so editor preview and launch bind
    // the same row.
    const rows = await db
      .select({
        id: workflows.id,
        name: workflows.name,
        version: workflows.version,
        definition: workflows.definition,
      })
      .from(workflows)
      .where(inArray(workflows.name, missing))
      .orderBy(asc(workflows.id))
    const byName = new Map<string, (typeof rows)[number]>()
    for (const r of rows) if (!byName.has(r.name)) byName.set(r.name, r)
    const nextFrontier: string[] = []
    for (const name of missing) {
      const row = byName.get(name)
      if (row === undefined) {
        throw new ValidationError(
          'workflow-call-ref-missing',
          `a call node references workflow '${name}' which does not exist`,
        )
      }
      let definition: WorkflowDefinition
      try {
        const parsed = WorkflowDefinitionSchema.safeParse(JSON.parse(row.definition))
        if (!parsed.success) throw new Error('schema')
        definition = parsed.data
      } catch {
        throw new ValidationError(
          'workflow-call-ref-missing',
          `referenced workflow '${row.id}' has an unreadable definition`,
        )
      }
      resolved.set(name, { id: row.id, version: row.version, definition })
      for (const ref of collectWorkflowCallRefs(definition)) nextFrontier.push(ref.workflowName)
    }
    frontier = [...new Set(nextFrontier)]
  }

  // Authoritative cycle gate over the exact frozen graph.
  const report = detectCallCycles(root, (name) => {
    const ref = resolved.get(name)
    return ref === undefined ? null : { id: ref.id, definition: ref.definition }
  })
  if (report.cycles.length > 0) {
    throw new ValidationError('workflow-call-cycle', 'workflow call graph contains a cycle', {
      // id-only payload (RFC-099 D1 echo discipline) — first cycle is enough
      // to act on; the validator's advisory twin lists them all in-editor.
      cycle: report.cycles[0],
    })
  }
  if (report.unresolved.length > 0) {
    // Freezing resolved every reachable name; a leftover here means the walk
    // and the detector disagree — fail closed rather than launch half-frozen.
    throw new ValidationError(
      'workflow-call-ref-missing',
      'workflow call closure could not be fully resolved',
    )
  }

  // Workgroup leaves: union over the root + every frozen workflow definition,
  // resolved by the SAME deterministic name rule (oldest ULID wins) and
  // hydrated with the full member roster.
  const workgroupNames = new Set(rootWorkgroupRefs.map((r) => r.workgroupName))
  for (const ref of resolved.values()) {
    for (const g of collectWorkgroupCallRefs(ref.definition)) workgroupNames.add(g.workgroupName)
  }
  const frozenWorkgroups: Record<string, FrozenWorkgroupRef> = {}
  if (workgroupNames.size > 0) {
    const rows = await db
      .select({
        id: workgroupsTable.id,
        name: workgroupsTable.name,
        version: workgroupsTable.version,
      })
      .from(workgroupsTable)
      .where(inArray(workgroupsTable.name, [...workgroupNames]))
      .orderBy(asc(workgroupsTable.id))
    const rowByName = new Map<string, (typeof rows)[number]>()
    for (const r of rows) if (!rowByName.has(r.name)) rowByName.set(r.name, r)
    for (const name of workgroupNames) {
      const row = rowByName.get(name)
      if (row === undefined) {
        throw new ValidationError(
          'workflow-call-ref-missing',
          `a call node references workgroup '${name}' which does not exist`,
        )
      }
      const group = await getWorkgroupById(db, row.id)
      if (group === null) {
        throw new ValidationError(
          'workflow-call-ref-missing',
          `referenced workgroup '${row.id}' could not be loaded`,
        )
      }
      frozenWorkgroups[name] = { id: row.id, version: row.version, group }
    }
  }

  const closure: FrozenCallClosure = { workflows: {}, workgroups: frozenWorkgroups }
  for (const [name, ref] of resolved) closure.workflows[name] = ref
  return JSON.stringify(closure)
}
