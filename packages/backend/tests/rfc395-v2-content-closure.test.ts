// RFC-395 V2-X X-6: missing resource bytes are required only by their frozen consumers.
import { expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import {
  contentFixture,
  contentLookups,
  contentTask,
  frozenValues,
  seedContentParents,
  FakeContentInventory,
  objectId,
} from './helpers/rfc395V2/contentFixtures'
import { conversion as contentConversion } from '@/platform/content/migration'
import { CONTENT_CATALOG } from '@/platform/content/migration/catalog'
import { contentTaskLookups } from '@/platform/content/migration/receipts'
import { convertContentReference } from '@/platform/content/migration/convert'
import type {
  ConversionContribution,
  ConversionRule,
} from '@/platform/persistence/migration/conversion/rule'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'

// B owns skills/versions in the registered assembly. These probes exercise X's common
// content/consumer boundary with real frozen origins; tree identity is covered by boot-skill tests.
const skillClosureProbes: ConversionRule[] = ['skills', 'skill_versions'].map((table) => ({
  ref: { id: `fixture/content-closure/${table}`, version: 1 },
  owner: 'fixture',
  claims: [table],
  produces: [{ table }],
  lookups: [CONTENT_CATALOG, ...contentTaskLookups],
  unit: { kind: 'source-chunk', table },
  async convert(unit, ctx) {
    for (const row of unit.rows.get(table)!) {
      const decoded = ctx.lookup(CONTENT_CATALOG).require(row.encodedKey)
      expect(decoded.error).toBeNull()
      for (const slot of decoded.slots) await convertContentReference(slot, row, ctx)
      ctx.out.record(
        { kind: 'decision', code: 'fixture-content-closure-probe', payload: row.encodedKey },
        row,
      )
    }
  },
}))
const conversion: ConversionContribution = {
  ...contentConversion,
  rules: [...contentConversion.rules, ...skillClosureProbes],
}

const absent = {
  state: 'absent',
  cause: 'originally-absent',
  evidence: 'absent in source backup',
} as const
const active = contentTask('executable', 'running')
const consumer = { ...active, taskId: 'consumer' }
const skillPath = 'skills/other-skill/files'
const definition = { nodes: [{ id: 'agent', kind: 'agent-single', agentId: 'root' }], edges: [] }

describeV2Providers('RFC-395 V2-X frozen content consumers', (h) => {
  for (const execution of ['executable', 'retryable-history', 'terminal-history'] as const) {
    test(`publication scope binds only its ${execution} owner, never the unrelated executable task`, async () => {
      await h.install()
      await seedContentParents(h)
      await h.write('hosted_object_publications', [contentFixture('hosted_object_publications')])
      const input = await h.input(
        [conversion, contentLookups([contentTask(execution), consumer])],
        {
          content: new FakeContentInventory().set(
            { codec: 'hosted-object-id', value: objectId },
            absent,
          ),
        },
      )
      try {
        const sink = new V2MemorySink()
        const result = await runConversion(input, sink)
        if (execution === 'executable') {
          expect(result.blocks).toHaveLength(1)
          expect(result.blocks[0]).toMatchObject({
            sourceTable: 'hosted_object_publications',
            taskId: 'task',
            code: 'v2-content-required-missing',
          })
        } else {
          expect(result.blocks).toEqual([])
          expect([...sink.units.values()].flatMap((unit) => unit.dispositions)).toContainEqual(
            expect.objectContaining({
              sourceTable: 'hosted_object_publications',
              kind: 'history-only',
              history: expect.objectContaining({ taskId: 'task', execution }),
            }),
          )
          expect(sink.rows('content_publications')).toHaveLength(1)
        }
      } finally {
        await input.source.close()
      }
    })
  }
  test('unknown publication scope is unprovable rather than assigned to every task', async () => {
    await h.install()
    await seedContentParents(h)
    await h.write('hosted_object_publications', [
      contentFixture('hosted_object_publications', { scope: 'missing-task' }),
    ])
    const input = await h.input([conversion, contentLookups([active])], {
      content: new FakeContentInventory().set(
        { codec: 'hosted-object-id', value: objectId },
        absent,
      ),
    })
    try {
      const result = await runConversion(input, new V2MemorySink())
      expect(result.blocks).toHaveLength(1)
      expect(result.blocks[0]).toMatchObject({
        code: 'v2-content-task-unprovable',
        taskId: 'missing-task',
      })
    } finally {
      await input.source.close()
    }
  })
  test('unreferenced skill, development object and unscoped publication retain absence evidence with executable tasks present', async () => {
    await h.install()
    await seedContentParents(h)
    await h.write('skills', [contentFixture('skills')])
    await h.write('development_object_artifacts', [contentFixture('development_object_artifacts')])
    await h.write('hosted_object_publications', [
      contentFixture('hosted_object_publications', { scope: null }),
    ])
    const input = await h.input([conversion, contentLookups([active])], {
      content: new FakeContentInventory()
        .set({ codec: 'hosted-object-id', value: objectId }, absent)
        .set({ codec: 'skill-path', value: skillPath }, absent),
    })
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).blocks).toEqual([])
      const records = [...sink.units.values()].flatMap((unit) => unit.records)
      expect(
        records.filter(
          (record) => record.kind === 'decision' && record.code === 'v2-content-required-missing',
        ),
      ).toHaveLength(3)
      expect(
        [...sink.units.values()]
          .flatMap((unit) => unit.dispositions)
          .some((d) => d.kind === 'history-only'),
      ).toBe(false)
      expect(sink.rows('development_object_artifacts')).toHaveLength(1)
      expect(sink.rows('content_publications')).toHaveLength(1)
    } finally {
      await input.source.close()
    }
  })
  for (const origin of ['definition', 'call-closure', 'workgroup'] as const) {
    test(`${origin}: only the frozen agent dependency closure makes a managed skill required`, async () => {
      await h.install()
      await seedContentParents(h)
      await h.write('skills', [contentFixture('skills')])
      await h.write('agents', [
        frozenValues('agents', { id: 'root', name: 'root', depends_on: '["dependency"]' }),
        frozenValues('agents', {
          id: 'dependency',
          name: 'dependency',
          skills: '[{"kind":"managed","skillId":"other-skill"}]',
        }),
      ])
      await h.write('tasks', [
        frozenValues('tasks', {
          id: 'consumer',
          workflow_id: 'workflow',
          inputs: '{}',
          status: 'running',
          workflow_snapshot: JSON.stringify(
            origin === 'definition' ? definition : { nodes: [], edges: [] },
          ),
          ref_closure_json:
            origin === 'call-closure'
              ? JSON.stringify({
                  closureVersion: 2,
                  workflows: { 'workflow#call': { id: 'callee', version: 1, definition } },
                  workgroups: {},
                })
              : null,
          workgroup_config_json:
            origin === 'workgroup'
              ? JSON.stringify({ members: [{ memberType: 'agent', agentId: 'root' }] })
              : null,
        }),
      ])
      const input = await h.input([conversion, contentLookups([active, consumer])], {
        content: new FakeContentInventory().set({ codec: 'skill-path', value: skillPath }, absent),
      })
      try {
        const result = await runConversion(input, new V2MemorySink())
        expect(result.blocks).toHaveLength(1)
        expect(result.blocks[0]).toMatchObject({
          sourceTable: 'skills',
          code: 'v2-content-required-missing',
          taskId: 'consumer',
        })
      } finally {
        await input.source.close()
      }
    })
  }
  for (const version of [1, 2]) {
    test(`skill version ${version}: only the selected content version belongs to the consumer closure`, async () => {
      await h.install()
      await seedContentParents(h)
      await h.write('skills', [contentFixture('skills', { content_version: 2 })])
      await h.write('skill_versions', [
        contentFixture('skill_versions', {
          skill_id: 'other-skill',
          version_index: version,
          files_path: `skills/other-skill/versions/v${version}/files`,
        }),
      ])
      await h.write('agents', [
        frozenValues('agents', {
          id: 'root',
          skills: '[{"kind":"managed","skillId":"other-skill"}]',
        }),
      ])
      await h.write('tasks', [
        frozenValues('tasks', {
          id: 'consumer',
          workflow_id: 'workflow',
          inputs: '{}',
          workflow_snapshot: JSON.stringify(definition),
          status: 'running',
        }),
      ])
      const input = await h.input([conversion, contentLookups([active, consumer])], {
        content: new FakeContentInventory().set(
          { codec: 'skill-path', value: `skills/other-skill/versions/v${version}/files` },
          absent,
        ),
      })
      try {
        const result = await runConversion(input, new V2MemorySink())
        if (version === 1) expect(result.blocks).toEqual([])
        else {
          expect(result.blocks).toHaveLength(1)
          expect(result.blocks[0]).toMatchObject({
            sourceTable: 'skill_versions',
            taskId: 'consumer',
          })
        }
      } finally {
        await input.source.close()
      }
    })
  }
  test('a history consumer keeps its skill restriction without blocking an unrelated executable task', async () => {
    await h.install()
    await seedContentParents(h)
    await h.write('skills', [contentFixture('skills')])
    await h.write('agents', [
      frozenValues('agents', {
        id: 'root',
        skills: '[{"kind":"managed","skillId":"other-skill"}]',
      }),
    ])
    await h.write('tasks', [
      frozenValues('tasks', {
        id: 'consumer',
        workflow_id: 'workflow',
        inputs: '{}',
        workflow_snapshot: JSON.stringify(definition),
        status: 'failed',
      }),
    ])
    const input = await h.input(
      [
        conversion,
        contentLookups([active, { ...consumer, execution: 'retryable-history', status: 'failed' }]),
      ],
      {
        content: new FakeContentInventory().set({ codec: 'skill-path', value: skillPath }, absent),
      },
    )
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).blocks).toEqual([])
      expect([...sink.units.values()].flatMap((unit) => unit.dispositions)).toContainEqual(
        expect.objectContaining({
          sourceTable: 'skills',
          kind: 'history-only',
          history: expect.objectContaining({ taskId: 'consumer', execution: 'retryable-history' }),
        }),
      )
    } finally {
      await input.source.close()
    }
  })
  for (const referenced of [false, true]) {
    test(`development frozen input ${referenced ? 'references' : 'only mentions'} an object`, async () => {
      await h.install()
      await seedContentParents(h)
      await h.write('employee_cases', [frozenValues('employee_cases', { id: 'case' })])
      await h.write('tasks', [
        frozenValues('tasks', {
          id: 'consumer',
          workflow_id: 'workflow',
          inputs: '{}',
          workflow_snapshot: '{"nodes":[],"edges":[]}',
          status: 'running',
          digital_employee_round_id: 'round',
        }),
      ])
      await h.write('employee_reaction_rounds', [
        frozenValues('employee_reaction_rounds', {
          id: 'round',
          case_id: 'case',
          execution_ref: 'consumer',
          plan_json: JSON.stringify({
            inputEnvelopeJson: JSON.stringify({
              contextsJson: JSON.stringify([
                {
                  stateJson: JSON.stringify({
                    materialArtifactRefs: referenced ? ['blob:fixture'] : [],
                    description: 'blob:fixture',
                  }),
                  artifactRefs: [],
                },
              ]),
            }),
          }),
        }),
      ])
      await h.write('development_object_artifacts', [
        contentFixture('development_object_artifacts'),
      ])
      const input = await h.input([conversion, contentLookups([active, consumer])], {
        content: new FakeContentInventory().set(
          { codec: 'hosted-object-id', value: objectId },
          absent,
        ),
      })
      try {
        const result = await runConversion(input, new V2MemorySink())
        if (!referenced) expect(result.blocks).toEqual([])
        else {
          expect(result.blocks).toHaveLength(1)
          expect(result.blocks[0]).toMatchObject({
            sourceTable: 'development_object_artifacts',
            taskId: 'consumer',
          })
        }
      } finally {
        await input.source.close()
      }
    })
  }
})
