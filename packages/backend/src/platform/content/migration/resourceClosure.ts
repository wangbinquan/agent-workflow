import { decodeAgentReferenceDocument } from '@agent-workflow/shared'
import { lookupKey, type LookupBuilder } from '@/platform/persistence/migration/conversion/lookups'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'

interface ContentResourceUse {
  readonly taskId: string
  readonly evidence: readonly string[]
}
export const CONTENT_RESOURCE_TASKS = lookupKey<readonly ContentResourceUse[]>(
  'content/resource-tasks',
  1,
)
const resourceKey = (kind: string, id: string, tree?: string): string =>
  canonicalSchemaJson([kind, id, tree ?? null])

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function json(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return object(JSON.parse(value))
  } catch {
    return undefined
  }
}
function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

export function contentResourceKey(row: SourceRow): string | null {
  const v = row.values
  if (row.table === 'skills' && typeof v.id === 'string') return resourceKey('skill', v.id, 'live')
  if (typeof v.skill_id === 'string') {
    if (row.table === 'skill_versions')
      return resourceKey('skill', v.skill_id, `version:${v.version_index}`)
    if (row.table === 'skill_content_entries' && typeof v.tree === 'string')
      return resourceKey('skill', v.skill_id, v.tree)
  }
  const ref =
    row.table === 'development_object_artifacts'
      ? v.reference
      : row.table === 'hosted_object_publications' && v.scope === null
        ? v.logical_key
        : null
  return typeof ref === 'string' ? resourceKey('development', ref) : null
}

export const contentResourceTasksLookup: LookupBuilder<readonly ContentResourceUse[]> = {
  key: CONTENT_RESOURCE_TASKS,
  sources: ['tasks', 'agents', 'skills', 'node_runs', 'employee_reaction_rounds'],
  build(staged, put) {
    const agents = new Map(
      [...staged.rows('agents')].map((row) => {
        const refs = decodeAgentReferenceDocument({
          skills: row.values.skills,
          dependsOn: row.values.depends_on,
        })
        return [
          row.values.id,
          {
            skills: list(refs.skills).flatMap((value) => {
              const ref = object(value)
              return ref?.kind === 'managed' && typeof ref.skillId === 'string' ? [ref.skillId] : []
            }),
            dependsOn: list(refs.dependsOn).filter(
              (value): value is string => typeof value === 'string',
            ),
          },
        ] as const
      }),
    )
    const versions = new Map(
      [...staged.rows('skills')].map((row) => [row.values.id, row.values.content_version]),
    )
    const uses = new Map<string, Map<string, Set<string>>>()
    const add = (key: string, taskId: string, path: string) => {
      const tasks = uses.get(key) ?? new Map<string, Set<string>>()
      const evidence = tasks.get(taskId) ?? new Set<string>()
      evidence.add(path)
      tasks.set(taskId, evidence)
      uses.set(key, tasks)
    }
    for (const task of staged.rows('tasks')) {
      const taskId = task.values.id
      if (typeof taskId !== 'string') continue
      const roots = new Map<string, string>()
      const groupAgents = (value: unknown, path: string) => {
        for (const [index, member] of list(object(value)?.members).entries()) {
          const m = object(member)
          if (m?.memberType !== 'human' && typeof m?.agentId === 'string')
            roots.set(m.agentId, `${path}.members[${index}].agentId`)
        }
      }
      const definitionAgents = (value: unknown, path: string) => {
        for (const [index, node] of list(object(value)?.nodes).entries()) {
          const n = object(node)
          if (n?.kind === 'agent-single' && typeof n.agentId === 'string')
            roots.set(n.agentId, `${path}.nodes[${index}].agentId`)
        }
      }
      definitionAgents(json(task.values.workflow_snapshot), 'tasks.workflow_snapshot')
      groupAgents(json(task.values.workgroup_config_json), 'tasks.workgroup_config_json')
      const closure = json(task.values.ref_closure_json)
      for (const [key, ref] of Object.entries(object(closure?.workflows) ?? {}))
        definitionAgents(
          object(ref)?.definition,
          `tasks.ref_closure_json.workflows[${JSON.stringify(key)}].definition`,
        )
      for (const [key, ref] of Object.entries(object(closure?.workgroups) ?? {}))
        groupAgents(
          object(ref)?.group,
          `tasks.ref_closure_json.workgroups[${JSON.stringify(key)}].group`,
        )
      for (const run of staged.group('node_runs', 'task_id', taskId))
        if (typeof run.values.agent_override_id === 'string')
          roots.set(run.values.agent_override_id, `node_runs:${run.encodedKey}.agent_override_id`)
      const seen = new Set<string>()
      const queue = [...roots]
      for (let index = 0; index < queue.length; index++) {
        const [id, path] = queue[index]!
        if (seen.has(id)) continue
        seen.add(id)
        const agent = agents.get(id)
        if (!agent) continue
        for (const skillId of agent.skills) {
          const evidence = `${path}->agents[${JSON.stringify(id)}].skills[${JSON.stringify(skillId)}]`
          add(resourceKey('skill', skillId, 'live'), taskId, evidence)
          const version = versions.get(skillId)
          if (typeof version === 'number')
            add(resourceKey('skill', skillId, `version:${version}`), taskId, evidence)
        }
        for (const dependency of agent.dependsOn)
          queue.push([dependency, `${path}->agents[${JSON.stringify(id)}].depends_on`])
      }
    }
    // Only structured reference fields in the frozen tool input count. Prompt
    // text, result ledgers and today's mission/catalog state are not a closure.
    const references = (value: unknown, taskId: string, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => references(item, taskId, `${path}[${index}]`))
        return
      }
      for (const [field, child] of Object.entries(object(value) ?? {})) {
        const at = `${path}.${field}`
        if (['artifactRefs', 'materialArtifactRefs', 'evidenceRefs'].includes(field))
          for (const ref of list(child))
            if (typeof ref === 'string' && /^(blob|bundle):/.test(ref))
              add(resourceKey('development', ref), taskId, at)
        if (typeof child === 'string') {
          if (['bundleId', 'bundleRef'].includes(field))
            add(resourceKey('development', `bundle:${child}`), taskId, at)
          if (['blobRef', 'contextRef'].includes(field))
            add(
              resourceKey('development', child.startsWith('blob:') ? child : `blob:${child}`),
              taskId,
              at,
            )
          if (['contextsJson', 'stateJson'].includes(field)) {
            let decoded: unknown
            try {
              decoded = JSON.parse(child)
            } catch {
              continue
            }
            references(decoded, taskId, at)
          }
        } else references(child, taskId, at)
      }
    }
    for (const round of staged.rows('employee_reaction_rounds')) {
      const taskIds = new Set<string>()
      if (typeof round.values.execution_ref === 'string') taskIds.add(round.values.execution_ref)
      for (const task of staged.group('tasks', 'digital_employee_round_id', round.values.id!))
        if (typeof task.values.id === 'string') taskIds.add(task.values.id)
      const envelope = json(json(round.values.plan_json)?.inputEnvelopeJson)
      for (const taskId of taskIds)
        references(
          envelope,
          taskId,
          `employee_reaction_rounds:${round.encodedKey}.plan_json.inputEnvelopeJson`,
        )
    }
    for (const [key, tasks] of uses)
      put(
        key,
        [...tasks]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([taskId, evidence]) => ({ taskId, evidence: [...evidence].sort() })),
      )
  },
}
