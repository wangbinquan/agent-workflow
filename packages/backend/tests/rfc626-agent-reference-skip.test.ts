// RFC-626 design §3.4 row 9 and §3.3 (read-only probes). Locks that the automatic upgrade keeps
// an agent whose reference lists hold entries it cannot confirm (wrong shape, a skill named but
// not identified, a column that is not a list): only those entries are left out, each one
// recorded, and the remaining references of each column are renumbered so that the probe
// `resource-catalog:agent-reference-order` (ordinal from 0, occurrence counting earlier equal
// keys) passes on the result. With operator resolution the agent still blocks exactly as before.
import { describe, expect, test } from 'bun:test'
import {
  agentsRule,
  explodeAgentReferences,
  skippedAgentReferenceCode,
} from '@/modules/resource-catalog/infrastructure/migration/agentsRule'
import { readOnlyProbes as resourceProbes } from '@/modules/resource-catalog/infrastructure/migration/probes'
import {
  agentIds,
  mcpIds,
  pluginIds,
  skillIds,
} from '@/platform/persistence/migration/conversion/generic/references'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'
import { frozenValues } from './helpers/rfc395V2/contentFixtures'
import {
  probeConnection,
  runRuleUnit,
  sourceRow,
  type RuleUnitResult,
} from './helpers/rfc626CatalogRuleUnit'

const lookups = [skillIds, agentIds, mcpIds, pluginIds]
const REFERENCE_TABLES = [
  'agent_skill_refs',
  'agent_mcp_refs',
  'agent_plugin_refs',
  'agent_dependencies',
] as const

function agent(overrides: DecodedSourceRow): SourceRow {
  return sourceRow(
    'agents',
    frozenValues('agents', {
      id: 'agent-a',
      name: 'agent-a',
      skills: '[]',
      depends_on: '[]',
      mcp: '[]',
      plugins: '[]',
      ...overrides,
    }),
  )
}
const mixed = agent({
  skills: JSON.stringify([
    { kind: 'managed', skillId: 'skill-1' },
    'name-only',
    { kind: 'managed', name: 'by-name' },
    { kind: 'managed', skillId: 'skill-1' },
    { kind: 'project', name: 'local' },
    { kind: 'managed', skillId: 'skill-2', extra: true },
  ]),
  depends_on: JSON.stringify(['agent-b', 7, 'agent-b']),
  mcp: '{"not":"a list"}',
  plugins: JSON.stringify(['plugin-1']),
})

async function referenceOrder(result: RuleUnitResult) {
  const probe = resourceProbes.find(
    (entry) => entry.id === 'resource-catalog:agent-reference-order',
  )!
  return probe.run(
    probeConnection(
      {
        agents: result.rows('agents'),
        ...Object.fromEntries(REFERENCE_TABLES.map((table) => [table, result.rows(table)])),
      },
      Object.fromEntries(REFERENCE_TABLES.map((table) => [table, ['agent_id', 'ordinal']])),
    ),
  )
}
const texts = (values: readonly unknown[]) => values.map((value) => JSON.stringify(value)).sort()

describe('RFC-626 3.4 row 9: unconfirmable agent references', () => {
  test('explode: skipping renumbers kept entries; blocks are those of the operator flow', () => {
    const operator = explodeAgentReferences(mixed)
    const skipping = explodeAgentReferences(mixed, { skipUnconfirmed: true })
    // Operator numbering keeps the source positions, exactly as before RFC-626.
    expect(operator.skillRefs.map((ref) => [ref.ordinal, ref.occurrence])).toEqual([
      [0, 0],
      [3, 1],
      [4, 0],
    ])
    expect(skipping.skillRefs.map((ref) => [ref.ordinal, ref.occurrence])).toEqual([
      [0, 0],
      [1, 1],
      [2, 0],
    ])
    expect(skipping.dependencies.map((ref) => [ref.ordinal, ref.occurrence])).toEqual([
      [0, 0],
      [1, 1],
    ])
    expect(skipping.mcpRefs).toEqual([])
    expect(skipping.pluginRefs.map((ref) => [ref.plugin_id, ref.ordinal])).toEqual([
      ['plugin-1', 0],
    ])
    expect(skipping.blocks).toEqual(operator.blocks)
    expect(skipping.skipped).toEqual([
      {
        code: 'v2-agent-reference-name-unproven',
        column: 'skills',
        ordinal: 1,
        entry: '"name-only"',
      },
      {
        code: 'v2-agent-reference-name-unproven',
        column: 'skills',
        ordinal: 2,
        entry: '{"kind":"managed","name":"by-name"}',
      },
      {
        code: 'v2-agent-reference-shape',
        column: 'skills',
        ordinal: 5,
        entry: '{"kind":"managed","skillId":"skill-2","extra":true}',
      },
      { code: 'v2-agent-reference-shape', column: 'depends_on', ordinal: 1, entry: '7' },
      { code: 'v2-agent-reference-shape', column: 'mcp', ordinal: null, entry: '{"not":"a list"}' },
    ])
  })

  test('automatic resolution keeps the agent, records each left-out entry, and the probe passes', async () => {
    const result = await runRuleUnit({
      rule: agentsRule,
      lookups,
      rows: [mixed],
      resolution: 'automatic',
    })
    expect(result.output.blocks).toEqual([])
    expect(result.rows('agents')).toEqual([
      expect.objectContaining({ id: 'agent-a', name: 'agent-a' }),
    ])
    expect(Object.hasOwn(result.rows('agents')[0]!, 'skills')).toBe(false)
    expect(
      result
        .rows('agent_skill_refs')
        .map((row) => [row.ordinal, row.occurrence, row.kind, row.skill_id, row.project_name])
        .sort(),
    ).toEqual([
      [0, 0, 'managed', 'skill-1', null],
      [1, 1, 'managed', 'skill-1', null],
      [2, 0, 'project', null, 'local'],
    ])
    expect(
      result
        .rows('agent_dependencies')
        .map((row) => [row.ordinal, row.occurrence, row.dependency_agent_id])
        .sort(),
    ).toEqual([
      [0, 0, 'agent-b'],
      [1, 1, 'agent-b'],
    ])
    expect(result.rows('agent_mcp_refs')).toEqual([])
    expect(result.rows('agent_plugin_refs')).toHaveLength(1)
    expect(await referenceOrder(result)).toMatchObject({ passed: true, detail: { failures: [] } })

    const nameUnproven = result.decisions(
      skippedAgentReferenceCode('v2-agent-reference-name-unproven'),
    )
    const shape = result.decisions(skippedAgentReferenceCode('v2-agent-reference-shape'))
    expect(nameUnproven).toHaveLength(2)
    expect(shape).toHaveLength(3)
    for (const decision of [...nameUnproven, ...shape])
      expect(decision).toMatchObject({
        automatic: 'kept',
        sourceTable: 'agents',
        sourceKey: mixed.encodedKey,
        agentId: 'agent-a',
      })
    expect(shape).toContainEqual(
      expect.objectContaining({ column: 'mcp', ordinal: null, entry: '{"not":"a list"}' }),
    )
    // The row's disposition carries the same entries beside the existing reference decisions.
    const disposition = result.output.dispositions.find(
      (row) => row.decision?.code === 'v2-agent-reference-decisions',
    )
    expect(disposition?.class).toBe('converted')
    expect(disposition?.decision?.detail).toEqual(
      expect.arrayContaining([
        {
          code: 'v2-agent-reference-shape',
          detail: { column: 'mcp', ordinal: null, entry: '{"not":"a list"}', skipped: true },
        },
      ]),
    )
  })

  test('operator resolution blocks the agent with exactly the blocks it raised before', async () => {
    const result = await runRuleUnit({ rule: agentsRule, lookups, rows: [mixed] })
    for (const table of ['agents', ...REFERENCE_TABLES]) expect(result.rows(table)).toEqual([])
    // The rule hands on the operator explosion's blocks unchanged.
    expect(texts(result.output.blocks)).toEqual(texts(explodeAgentReferences(mixed).blocks))
    expect(result.output.blocks.map((block) => block.code).sort()).toEqual([
      'v2-agent-reference-name-unproven',
      'v2-agent-reference-name-unproven',
      'v2-agent-reference-shape',
      'v2-agent-reference-shape',
      'v2-agent-reference-shape',
    ])
    expect(result.output.blocks.every((block) => block.scope === 'row')).toBe(true)
    expect(result.decisions(skippedAgentReferenceCode('v2-agent-reference-shape'))).toEqual([])
  })

  test('a reference column that is not even JSON is an empty list, recorded', async () => {
    const broken = agent({ id: 'agent-b', name: 'agent-b', skills: '{', plugins: '["p"]' })
    const result = await runRuleUnit({
      rule: agentsRule,
      lookups,
      rows: [broken],
      resolution: 'automatic',
    })
    expect(result.output.blocks).toEqual([])
    expect(result.rows('agent_skill_refs')).toEqual([])
    expect(result.rows('agent_plugin_refs')).toEqual([
      expect.objectContaining({ agent_id: 'agent-b', plugin_id: 'p', ordinal: 0, occurrence: 0 }),
    ])
    expect(result.decisions(skippedAgentReferenceCode('v2-agent-reference-shape'))).toEqual([
      expect.objectContaining({ column: 'skills', ordinal: null, entry: '{' }),
    ])
    expect(await referenceOrder(result)).toMatchObject({ passed: true })
  })

  test('an agent whose references all confirm converts identically in both modes', async () => {
    const clean = agent({
      skills: JSON.stringify([
        { kind: 'managed', skillId: 'skill-1' },
        { kind: 'managed', skillId: 'skill-1' },
      ]),
      depends_on: JSON.stringify(['agent-b']),
      mcp: JSON.stringify(['mcp-1']),
    })
    const automatic = await runRuleUnit({
      rule: agentsRule,
      lookups,
      rows: [clean],
      resolution: 'automatic',
    })
    const operator = await runRuleUnit({ rule: agentsRule, lookups, rows: [clean] })
    expect(automatic.output.blocks).toEqual([])
    expect(automatic.output.rows).toEqual(operator.output.rows)
    expect(automatic.output.dispositions).toEqual(operator.output.dispositions)
    expect(automatic.output.records).toEqual(operator.output.records)
  })
})
