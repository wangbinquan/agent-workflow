import type { AgentSkillRef } from '@agent-workflow/shared'
import { encodeAgentSkillReferenceKey } from '../../domain/agentReferenceKey'
import { idSetLookup } from '@/platform/persistence/migration/conversion/lookups'
import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import type { ConversionRule } from '@/platform/persistence/migration/conversion/rule'
import type {
  ConversionBlock,
  JsonValue,
  SourceRow,
  TargetRow,
} from '@/platform/persistence/migration/conversion/types'
import { resourceDecision } from './evidence'

export const AGENT_REFERENCE_IDS = {
  skill: idSetLookup('skills', 'id').key,
  agent: idSetLookup('agents', 'id').key,
  mcp: idSetLookup('mcps', 'id').key,
  plugin: idSetLookup('plugins', 'id').key,
}

export function explodeAgentReferences(row: SourceRow) {
  const agent = Object.fromEntries(
    Object.entries(row.values).filter(
      ([column]) => !['skills', 'depends_on', 'mcp', 'plugins'].includes(column),
    ),
  )
  const decisions: { code: string; detail: JsonValue }[] = []
  const blocks: ConversionBlock[] = []
  const skillRefs: TargetRow[] = [],
    mcpRefs: TargetRow[] = [],
    pluginRefs: TargetRow[] = [],
    dependencies: TargetRow[] = []
  function list(column: string): unknown[] {
    let value: unknown
    try {
      value = JSON.parse(String(row.values[column]))
    } catch {
      value = undefined
    }
    if (!Array.isArray(value)) {
      blocks.push(rowBlock('v2-agent-reference-shape', row, { column }, [column]))
      return []
    }
    return value
  }
  const counts = new Map<string, number>()
  function occurrence(column: string, key: string, ordinal: number): number {
    const tuple = JSON.stringify([column, key])
    const value = counts.get(tuple) ?? 0
    counts.set(tuple, value + 1)
    if (value)
      decisions.push({
        code: 'v2-agent-duplicate-reference',
        detail: { column, key, ordinal, occurrence: value },
      })
    return value
  }
  list('skills').forEach((value, ordinal) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      blocks.push(
        rowBlock(
          typeof value === 'string'
            ? 'v2-agent-reference-name-unproven'
            : 'v2-agent-reference-shape',
          row,
          { column: 'skills', ordinal },
          ['skills'],
        ),
      )
      return
    }
    const ref = value as Record<string, unknown>
    const field = ref.kind === 'managed' ? 'skillId' : 'name'
    if (ref.kind === 'managed' && typeof ref.skillId !== 'string' && typeof ref.name === 'string') {
      blocks.push(
        rowBlock(
          'v2-agent-reference-name-unproven',
          row,
          { column: 'skills', ordinal, name: ref.name },
          ['skills.skillId'],
        ),
      )
      return
    }
    if (
      (ref.kind !== 'managed' && ref.kind !== 'project') ||
      typeof ref[field] !== 'string' ||
      Object.keys(ref).some((key) => key !== 'kind' && key !== field)
    ) {
      blocks.push(
        rowBlock(
          'v2-agent-reference-shape',
          row,
          { column: 'skills', ordinal, reason: 'unrepresentable kind, selector or parameters' },
          ['skills'],
        ),
      )
      return
    }
    const typed = ref as AgentSkillRef
    const key = encodeAgentSkillReferenceKey(typed)
    skillRefs.push({
      agent_id: row.values.id!,
      reference_key: key,
      occurrence: occurrence('skills', key, ordinal),
      ordinal,
      kind: typed.kind,
      skill_id: typed.kind === 'managed' ? typed.skillId : null,
      project_name: typed.kind === 'project' ? typed.name : null,
    })
  })
  for (const [column, target, field] of [
    ['depends_on', dependencies, 'dependency_agent_id'],
    ['mcp', mcpRefs, 'mcp_id'],
    ['plugins', pluginRefs, 'plugin_id'],
  ] as const)
    list(column).forEach((value, ordinal) => {
      if (typeof value !== 'string') {
        blocks.push(rowBlock('v2-agent-reference-shape', row, { column, ordinal }, [column]))
        return
      }
      target.push({
        agent_id: row.values.id!,
        [field]: value,
        ordinal,
        occurrence: occurrence(column, value, ordinal),
      })
    })
  return { agent, skillRefs, mcpRefs, pluginRefs, dependencies, decisions, blocks }
}

export const agentsRule: ConversionRule = {
  ref: { id: 'resource-catalog/agent-references', version: 1 },
  owner: 'resource-catalog',
  claims: ['agents'],
  produces: [
    'agents',
    'agent_skill_refs',
    'agent_mcp_refs',
    'agent_plugin_refs',
    'agent_dependencies',
  ].map((table) => ({ table })),
  lookups: Object.values(AGENT_REFERENCE_IDS),
  unit: { kind: 'source-chunk', table: 'agents' },
  convert(unit, ctx) {
    for (const row of unit.rows.get('agents') ?? []) {
      const result = explodeAgentReferences(row)
      if (result.blocks.length) {
        resourceDecision(
          row,
          ctx,
          'v2-agent-reference-unconverted',
          { blocks: result.blocks.map((b) => b.code) },
          [],
        )
        for (const block of result.blocks) ctx.out.block(block)
        continue
      }
      for (const [refs, field, key] of [
        [result.skillRefs, 'skill_id', AGENT_REFERENCE_IDS.skill],
        [result.dependencies, 'dependency_agent_id', AGENT_REFERENCE_IDS.agent],
        [result.mcpRefs, 'mcp_id', AGENT_REFERENCE_IDS.mcp],
        [result.pluginRefs, 'plugin_id', AGENT_REFERENCE_IDS.plugin],
      ] as const)
        for (const ref of refs) {
          const id = ref[field]
          if (typeof id === 'string' && !ctx.lookup(key).get(id))
            result.decisions.push({
              code: 'v2-agent-dangling-reference',
              detail: { field, id, ordinal: ref.ordinal as number },
            })
        }
      const targets = [
        { table: 'agents', values: result.agent },
        ...result.skillRefs.map((values) => ({ table: 'agent_skill_refs', values })),
        ...result.mcpRefs.map((values) => ({ table: 'agent_mcp_refs', values })),
        ...result.pluginRefs.map((values) => ({ table: 'agent_plugin_refs', values })),
        ...result.dependencies.map((values) => ({ table: 'agent_dependencies', values })),
      ]
      for (const target of targets) ctx.out.row(target.table, target.values, row)
      if (result.decisions.length)
        resourceDecision(
          row,
          ctx,
          'v2-agent-reference-decisions',
          result.decisions,
          targets.map((target) => ({
            table: target.table,
            key: ctx.target.key(target.table, target.values),
          })),
        )
    }
  },
}
