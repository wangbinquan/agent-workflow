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

/** RFC-626 §3.4 row 9: one reference the automatic upgrade left out of a kept agent. */
export interface SkippedAgentReference {
  /** The block this entry raises with operator resolution. */
  readonly code: string
  readonly column: string
  /** Position in the source list; null when the whole column is not a list. */
  readonly ordinal: number | null
  /** The source entry (or the column text) as JSON text; null when there is none. */
  readonly entry: string | null
}

/**
 * Explodes the four reference columns into reference rows. With `skipUnconfirmed` (RFC-626
 * §3.4 row 9, automatic resolution) an entry that cannot be confirmed is left out instead of
 * failing the agent, and the remaining entries of the column are numbered without gaps: the
 * read-only probe requires `ordinal` to run from 0 and `occurrence` to count earlier entries
 * with the same key. Without it the output is the operator flow's, unchanged.
 */
export function explodeAgentReferences(
  row: SourceRow,
  options: { readonly skipUnconfirmed?: boolean } = {},
) {
  const compact = options.skipUnconfirmed === true
  const agent = Object.fromEntries(
    Object.entries(row.values).filter(
      ([column]) => !['skills', 'depends_on', 'mcp', 'plugins'].includes(column),
    ),
  )
  const decisions: { code: string; detail: JsonValue }[] = []
  const blocks: ConversionBlock[] = []
  const skipped: SkippedAgentReference[] = []
  const skillRefs: TargetRow[] = [],
    mcpRefs: TargetRow[] = [],
    pluginRefs: TargetRow[] = [],
    dependencies: TargetRow[] = []
  const entryText = (value: unknown): string | null => JSON.stringify(value) ?? null
  function list(column: string): unknown[] {
    let value: unknown
    try {
      value = JSON.parse(String(row.values[column]))
    } catch {
      value = undefined
    }
    if (!Array.isArray(value)) {
      blocks.push(rowBlock('v2-agent-reference-shape', row, { column }, [column]))
      const raw = row.values[column]
      skipped.push({
        code: 'v2-agent-reference-shape',
        column,
        ordinal: null,
        entry: typeof raw === 'string' ? raw : null,
      })
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
  const reject = (
    block: ConversionBlock,
    column: string,
    ordinal: number,
    value: unknown,
  ): void => {
    blocks.push(block)
    skipped.push({ code: block.code, column, ordinal, entry: entryText(value) })
  }
  list('skills').forEach((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      reject(
        rowBlock(
          typeof value === 'string'
            ? 'v2-agent-reference-name-unproven'
            : 'v2-agent-reference-shape',
          row,
          { column: 'skills', ordinal: index },
          ['skills'],
        ),
        'skills',
        index,
        value,
      )
      return
    }
    const ref = value as Record<string, unknown>
    const field = ref.kind === 'managed' ? 'skillId' : 'name'
    if (ref.kind === 'managed' && typeof ref.skillId !== 'string' && typeof ref.name === 'string') {
      reject(
        rowBlock(
          'v2-agent-reference-name-unproven',
          row,
          { column: 'skills', ordinal: index, name: ref.name },
          ['skills.skillId'],
        ),
        'skills',
        index,
        value,
      )
      return
    }
    if (
      (ref.kind !== 'managed' && ref.kind !== 'project') ||
      typeof ref[field] !== 'string' ||
      Object.keys(ref).some((key) => key !== 'kind' && key !== field)
    ) {
      reject(
        rowBlock(
          'v2-agent-reference-shape',
          row,
          {
            column: 'skills',
            ordinal: index,
            reason: 'unrepresentable kind, selector or parameters',
          },
          ['skills'],
        ),
        'skills',
        index,
        value,
      )
      return
    }
    const typed = ref as AgentSkillRef
    const key = encodeAgentSkillReferenceKey(typed)
    // Every entry before this one was kept unless an entry was skipped, so the two agree
    // whenever the operator flow converts the agent at all.
    const ordinal = compact ? skillRefs.length : index
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
    list(column).forEach((value, index) => {
      if (typeof value !== 'string') {
        reject(
          rowBlock('v2-agent-reference-shape', row, { column, ordinal: index }, [column]),
          column,
          index,
          value,
        )
        return
      }
      const ordinal = compact ? target.length : index
      target.push({
        agent_id: row.values.id!,
        [field]: value,
        ordinal,
        occurrence: occurrence(column, value, ordinal),
      })
    })
  return { agent, skillRefs, mcpRefs, pluginRefs, dependencies, decisions, blocks, skipped }
}

/** RFC-626 §3.4 row 9: the decision code of a reference the automatic upgrade left out. */
export function skippedAgentReferenceCode(code: string): string {
  return `${code}-kept`
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
    // RFC-626 §3.4 row 9: the automatic upgrade keeps the agent and leaves out only the
    // references it cannot confirm; reference columns have no foreign key, so nothing else
    // depends on the entries left out.
    const automatic = ctx.resolution === 'automatic'
    for (const row of unit.rows.get('agents') ?? []) {
      const result = explodeAgentReferences(row, { skipUnconfirmed: automatic })
      if (automatic)
        for (const skip of result.skipped)
          result.decisions.push({
            code: skip.code,
            detail: {
              column: skip.column,
              ordinal: skip.ordinal,
              entry: skip.entry,
              skipped: true,
            },
          })
      if (result.blocks.length && !automatic) {
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
      if (automatic)
        for (const skip of result.skipped)
          ctx.out.record(
            {
              kind: 'decision',
              code: skippedAgentReferenceCode(skip.code),
              payload: {
                automatic: 'kept',
                sourcePhase: row.phase,
                sourceTable: row.table,
                sourceKey: row.encodedKey,
                agentId: String(row.values.id),
                column: skip.column,
                ordinal: skip.ordinal,
                entry: skip.entry,
              },
            },
            row,
          )
    }
  },
}
