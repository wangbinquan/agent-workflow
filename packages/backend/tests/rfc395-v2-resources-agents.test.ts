import { expect, test } from 'bun:test'
import type { AgentSkillRef } from '@agent-workflow/shared'
import { describeV2Providers, fixtureLookup } from './helpers/rfc395V2Harness'
import { convertFixtures, readFixtureRows } from './helpers/rfc395V2/collabFixtures'
import {
  agentsRule,
  AGENT_REFERENCE_IDS,
} from '@/modules/resource-catalog/infrastructure/migration/agentsRule'
import {
  encodeAgentSkillReferenceKey,
  decodeAgentSkillReferenceKey,
} from '@/modules/resource-catalog/domain/agentReferenceKey'

const conversion = {
  rules: [agentsRule],
  validators: [],
  lookups: Object.values(AGENT_REFERENCE_IDS).map((key) => fixtureLookup(key, [])),
}

test('ar1 is structured, versioned and injective across kinds, separators and Unicode', () => {
  for (const value of ['', 'x:y/z', '["ar1","managed","x"]', '汉字', 'e\u0301', 'é']) {
    const managed = { kind: 'managed' as const, skillId: value }
    const project = { kind: 'project' as const, name: value }
    expect(decodeAgentSkillReferenceKey(encodeAgentSkillReferenceKey(managed))).toEqual(managed)
    expect(decodeAgentSkillReferenceKey(encodeAgentSkillReferenceKey(project))).toEqual(project)
    expect(encodeAgentSkillReferenceKey(managed)).not.toBe(encodeAgentSkillReferenceKey(project))
  }
  for (const key of [
    '["ar2","managed","x"]',
    '["ar1","managed","x",0]',
    '["ar1","managed",null]',
    '[ "ar1", "managed", "x" ]',
  ])
    expect(() => decodeAgentSkillReferenceKey(key)).toThrow()
})

describeV2Providers('RFC-395 V2-C agent references', (h) => {
  test('all four projections preserve order, duplicate occurrence, dangling identities and project names', async () => {
    await h.install()
    const skills: AgentSkillRef[] = [
      { kind: 'managed', skillId: 'gone:/:id' },
      { kind: 'project', name: '本地/skill' },
      { kind: 'managed', skillId: 'gone:/:id' },
    ]
    await h.write('agents', [
      {
        id: 'a',
        name: 'agent',
        skills: JSON.stringify(skills),
        depends_on: '["dep","dep","a"]',
        mcp: '["m","m"]',
        plugins: '["p","q","p"]',
        inputs: '[{"name":"in","kind":"string","required":true}]',
        permission: '{ "rules": [1] }\n',
        body_md: 'body\n',
        created_at: 10,
        updated_at: 11,
      },
    ])
    const source = (await readFixtureRows(h, 'agents'))[0]!
    const { summary, sink, dispositions } = await convertFixtures(h, [conversion])
    expect(summary.status).toBe('converted')
    const ordered = (table: string) =>
      [...sink.rows(table)].sort((a, b) => Number(a.ordinal) - Number(b.ordinal))
    expect(
      ordered('agent_skill_refs').map((r) => decodeAgentSkillReferenceKey(String(r.reference_key))),
    ).toEqual(skills)
    expect(ordered('agent_skill_refs').map((r) => r.occurrence)).toEqual([0, 0, 1])
    expect(ordered('agent_dependencies').map((r) => r.dependency_agent_id)).toEqual([
      'dep',
      'dep',
      'a',
    ])
    expect(ordered('agent_mcp_refs').map((r) => r.mcp_id)).toEqual(['m', 'm'])
    expect(ordered('agent_plugin_refs').map((r) => r.plugin_id)).toEqual(['p', 'q', 'p'])
    for (const [column, value] of Object.entries(source.values))
      if (!['skills', 'depends_on', 'mcp', 'plugins'].includes(column))
        expect(sink.rows('agents')[0]?.[column]).toEqual(value)
    expect(JSON.stringify(dispositions)).toContain('v2-agent-dangling-reference')
    expect(JSON.stringify(dispositions)).toContain('v2-agent-duplicate-reference')
  }, 180_000)

  test('name-only, parameter-bearing and malformed shapes produce evidence and never truncate to a successful list', async () => {
    await h.install()
    await h.write('agents', [
      { id: 'name', name: 'name', skills: '[{"kind":"managed","name":"ambiguous"}]' },
      {
        id: 'parameters',
        name: 'parameters',
        skills: '[{"kind":"managed","skillId":"x","required":true}]',
      },
      { id: 'shape', name: 'shape', mcp: '{"id":"m"}' },
      { id: 'json', name: 'json', plugins: '[not-json' },
    ])
    const { summary, sink, dispositions } = await convertFixtures(h, [conversion])
    expect(summary.status).toBe('blocked')
    expect(summary.blocks.map((b) => b.code)).toContain('v2-agent-reference-name-unproven')
    expect(summary.blocks.map((b) => b.code)).toContain('v2-agent-reference-shape')
    expect(summary.blocks.map((b) => b.code)).toContain('v2-source-codec')
    expect(sink.rows('agents')).toEqual([])
    expect(dispositions.filter((d) => d.kind === 'blocked')).toHaveLength(4)
  }, 180_000)
})
