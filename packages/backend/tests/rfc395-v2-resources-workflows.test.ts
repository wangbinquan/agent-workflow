// RFC-395 V2-C phase 2: catalog selectors, optional nodes and lossless dependency metadata.
import { expect, test } from 'bun:test'
import { TASK_DEFINITION_HOSTS, collectWorkflowDependencyRefs } from '@agent-workflow/shared'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { convertFixtures, readFixtureRows, seedCollabTask } from './helpers/rfc395V2/collabFixtures'
import { workflowsRule } from '@/modules/resource-catalog/infrastructure/migration/workflowsRule'
import { resourceGrantsRule } from '@/modules/resource-catalog/infrastructure/migration/resourceGrantsRule'
import {
  hostPlaceholders,
  referencedWorkflowIds,
} from '@/modules/resource-catalog/infrastructure/migration/lookups'
import { decodeStagedValue } from '@/platform/persistence/migration/conversion/staging'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'

const conversion = {
  rules: [workflowsRule, resourceGrantsRule],
  validators: [],
  lookups: [hostPlaceholders, referencedWorkflowIds],
}
const skeleton = '{ "$schema_version":7, "inputs":[], "nodes":[], "edges":[] }\n'
const hosts = Object.values(TASK_DEFINITION_HOSTS)

describeV2Providers('RFC-395 V2-C workflows and hosts', (h) => {
  test('revision/path index retains name selectors and canonical definition bytes', async () => {
    await h.install()
    const definition =
      '{"$schema_version":7,"nodes":[{"id":"a","kind":"agent-single","agentId":"agent"},{"id":"w","kind":"call-workflow","workflowName":"same","workflowId":"cached"},{"id":"g","kind":"call-workgroup","workgroupName":"group"}],"inputs":[],"edges":[]}\n'
    await h.write('workflows', [{ id: 'w', name: 'workflow', version: 8, definition }])
    const source = (await readFixtureRows(h, 'workflows'))[0]!
    const { summary, sink, dispositions } = await convertFixtures(h, [conversion], {
      taskFacts: [],
    })
    expect(summary.status).toBe('converted')
    expect(sink.rows('workflows')[0]).toEqual(source.values)
    const index = [...sink.rows('workflow_dependency_index')].sort((a, b) =>
      String(a.reference_path).localeCompare(String(b.reference_path)),
    )
    expect(
      index.map((r) => [r.revision, r.reference_path, r.selector_kind, r.selector_value]),
    ).toEqual([
      [8, 'nodes[0].agentId', 'id', 'agent'],
      [8, 'nodes[1].workflowName', 'name', 'same'],
      [8, 'nodes[2].workgroupName', 'name', 'group'],
    ])
    expect(index.map((r) => JSON.parse(String(r.namespace_json)))).toEqual([
      { version: 2, resourceType: 'agent', referenceKind: 'agentId', nodeKind: 'agent-single' },
      {
        version: 2,
        resourceType: 'workflow',
        referenceKind: 'workflowName',
        nodeKind: 'call-workflow',
      },
      {
        version: 2,
        resourceType: 'workgroup',
        referenceKind: 'workgroupName',
        nodeKind: 'call-workgroup',
      },
    ])
    expect(dispositions).toEqual([])
  }, 180_000)

  test('all four proven hosts and their grants are deleted together and original rows are archived', async () => {
    await h.install()
    await h.write('users', [
      { id: 'u', username: 'u', display_name: 'U', created_at: 1, updated_at: 1 },
    ])
    await h.write(
      'workflows',
      hosts.map((host) => ({ ...host, builtin: true, definition: skeleton })),
    )
    await h.write(
      'resource_grants',
      hosts.map((host) => ({
        resource_type: 'workflow',
        resource_id: host.id,
        user_id: 'u',
        added_by: 'u',
        added_at: 12,
      })),
    )
    const source = [
      ...(await readFixtureRows(h, 'workflows')),
      ...(await readFixtureRows(h, 'resource_grants')),
    ]
    const { summary, sink, dispositions, units } = await convertFixtures(h, [conversion], {
      taskFacts: [],
    })
    expect(summary.status).toBe('converted')
    expect(sink.rows('workflows')).toEqual([])
    expect(sink.rows('workflow_dependency_index')).toEqual([])
    expect(sink.rows('resource_grants')).toEqual([])
    expect(dispositions.filter((d) => d.kind === 'deleted-placeholder')).toHaveLength(8)
    const archived = units
      .flatMap((u) => u.archives)
      .map((archive) => decodeStagedValue<SourceRow>(new TextDecoder().decode(archive.bytes)))
    for (const row of source)
      expect(archived.find((a) => a.encodedKey === row.encodedKey)?.values).toEqual(row.values)
  }, 180_000)

  test('non-skeleton and non-builtin host IDs block without deleting grants', async () => {
    await h.install()
    await h.write('workflows', [
      {
        id: hosts[0]!.id,
        name: hosts[0]!.name,
        builtin: true,
        definition: '{"inputs":[],"nodes":[{"id":"user-node"}],"edges":[]}',
      },
      { id: hosts[1]!.id, name: hosts[1]!.name, builtin: false, definition: skeleton },
      {
        id: hosts[2]!.id,
        name: hosts[2]!.name,
        builtin: true,
        definition: '{"inputs":[],"nodes":[],"edges":[],"extra":"user fact"}',
      },
    ])
    const { summary, dispositions } = await convertFixtures(h, [conversion], { taskFacts: [] })
    expect(summary.blocks.filter((b) => b.code === 'v2-host-not-placeholder')).toHaveLength(3)
    expect(dispositions.some((d) => d.kind === 'deleted-placeholder')).toBe(false)
  }, 180_000)

  test('authored names and executable workflow subjects block, while stale caches and provenance do not', async () => {
    await h.install()
    await h.write('users', [
      { id: 'u', username: 'u', display_name: 'U', created_at: 1, updated_at: 1 },
    ])
    await h.write(
      'workflows',
      hosts.map((host) => ({ ...host, builtin: true, definition: skeleton })),
    )
    await h.write('workflows', [
      {
        id: 'caller',
        name: 'caller',
        definition: JSON.stringify({
          nodes: [
            {
              id: 'n',
              kind: 'call-workflow',
              workflowName: hosts[0]!.name,
              workflowId: hosts[0]!.id,
            },
            { id: 'c', kind: 'call-workflow', workflowName: 'renamed', workflowId: hosts[1]!.id },
          ],
        }),
      },
    ])
    const { task } = await seedCollabTask(h, 'real', 'running', 'executable', {
      workflow_id: hosts[2]!.id,
    })
    await h.write('intent_provenance', [
      {
        resource_type: 'workflow',
        resource_id: hosts[3]!.id,
        commit_id: 'c',
        session_id: 's',
        created_at: 1,
      },
    ])
    await h.write('resource_grants', [
      {
        resource_type: 'workflow',
        resource_id: hosts[0]!.id,
        user_id: 'u',
        added_by: 'u',
        added_at: 1,
      },
    ])
    const { summary, dispositions } = await convertFixtures(h, [conversion], {
      taskFacts: [{ ...task, sourceId: hosts[2]!.id, definitionAnchorId: hosts[2]!.id }],
    })
    expect(summary.blocks.filter((b) => b.code === 'v2-host-still-referenced')).toHaveLength(2)
    expect(JSON.stringify(summary.blocks)).not.toContain('intent_provenance')
    expect(summary.blocks.some((b) => b.code === 'v2-host-grant-deletion-blocked')).toBe(true)
    expect(dispositions.filter((d) => d.kind === 'deleted-placeholder')).toHaveLength(2)
  }, 180_000)

  test('a proved non-workflow task definition namespace is not a surviving catalog reference', async () => {
    await h.install()
    const host = TASK_DEFINITION_HOSTS.agent
    await h.write('workflows', [{ ...host, builtin: true, definition: skeleton }])
    const { task } = await seedCollabTask(h, 'agent-task', 'done', 'terminal-history', {
      workflow_id: host.id,
      workflow_snapshot: JSON.stringify({ id: host.id, nodes: [], inputs: [], edges: [] }),
      source_agent_name: 'agent',
      ref_closure_json: JSON.stringify({
        closureVersion: 2,
        workflows: {
          [`${host.id}#call`]: { id: 'real-workflow', name: 'child', definition: { nodes: [] } },
        },
        workgroups: {},
      }),
    })
    await h.write('memories', [
      {
        id: 'memory',
        scope_type: 'workflow',
        scope_id: host.id,
        title: 'shared scope',
        body_md: 'body',
        status: 'approved',
        source_kind: 'manual',
        created_at: 1,
      },
    ])
    const { summary, dispositions } = await convertFixtures(h, [conversion], {
      taskFacts: [
        { ...task, subjectKind: 'agent', sourceId: 'agent-id', definitionAnchorId: host.id },
      ],
    })
    expect(summary.status).toBe('converted')
    expect(dispositions.filter((d) => d.kind === 'deleted-placeholder')).toHaveLength(1)
    expect((await readFixtureRows(h, 'memories'))[0]?.values.scope_id).toBe(host.id)
    const legacy = await seedCollabTask(h, 'legacy-closure', 'done', 'terminal-history', {
      workflow_id: host.id,
      source_agent_name: 'agent',
      ref_closure_json: JSON.stringify({
        workflows: { [`${host.id}#call`]: { id: 'child' } },
        workgroups: {},
      }),
    })
    const legacyNamespace = await convertFixtures(h, [conversion], {
      taskFacts: [
        { ...task, subjectKind: 'agent', sourceId: 'agent-id', definitionAnchorId: host.id },
        { ...legacy.task, subjectKind: 'agent', sourceId: 'agent-id', definitionAnchorId: host.id },
      ],
    })
    expect(legacyNamespace.summary.status).toBe('converted')
    expect(
      legacyNamespace.dispositions.filter((d) => d.kind === 'deleted-placeholder'),
    ).toHaveLength(1)
  }, 180_000)

  test('unreadable definitions and cache-only selectors block their own rows without inventing host references', async () => {
    await h.install()
    await h.write('workflows', [
      { ...hosts[0]!, builtin: true, definition: skeleton },
      { id: 'invalid', name: 'invalid', definition: '{"nodes":null}' },
      {
        id: 'cache-only',
        name: 'cache-only',
        definition: '{"nodes":[{"kind":"call-workflow","workflowId":"cache"}]}',
      },
    ])
    const { summary, sink } = await convertFixtures(h, [conversion], { taskFacts: [] })
    expect(summary.blocks.filter((b) => b.code === 'v2-workflow-definition-shape')).toHaveLength(2)
    expect(summary.blocks.some((b) => b.code === 'v2-host-still-referenced')).toBe(false)
    expect(sink.rows('workflows')).toEqual([])
  }, 180_000)

  test('embedded text in maintenance payloads is not a catalog reference', async () => {
    await h.install()
    await h.write('workflows', [{ ...hosts[0]!, builtin: true, definition: skeleton }])
    await h.write('maintenance_state', [
      {
        key: 'reference',
        value: JSON.stringify({ nested: JSON.stringify({ workflowId: hosts[0]!.id }) }),
        updated_at: 1,
      },
    ])
    const { summary, dispositions } = await convertFixtures(h, [conversion], { taskFacts: [] })
    expect(summary.status).toBe('converted')
    expect(dispositions.filter((d) => d.kind === 'deleted-placeholder')).toHaveLength(1)
  }, 180_000)
  test('optional nodes preserve source bytes and generate no dependencies', async () => {
    await h.install()
    const definition = '{ "inputs": [], "edges": [] }\n'
    await h.write('workflows', [
      { ...hosts[0]!, builtin: true, definition: skeleton },
      { id: 'optional', name: 'optional', definition },
    ])
    const { summary, sink } = await convertFixtures(h, [conversion], { taskFacts: [] })
    expect(summary.status).toBe('converted')
    expect(sink.rows('workflows')).toHaveLength(1)
    expect(sink.rows('workflows')[0]?.definition).toBe(definition)
    expect(sink.rows('workflow_dependency_index')).toEqual([])
  }, 180_000)

  test('broad dependency metadata can reproduce the narrower nonempty agent-single reverse lookup', async () => {
    await h.install()
    const definition = {
      nodes: [
        { id: 'agent', kind: 'agent-single', agentId: 'target' },
        { id: 'empty', kind: 'agent-single', agentId: '' },
        { id: 'wrapper', kind: 'loop', agentId: 'target' },
        { id: 'call', kind: 'call-workflow', agentId: 'target', workflowName: 'callee' },
      ],
    }
    await h.write('workflows', [
      { id: 'kinds', name: 'kinds', definition: JSON.stringify(definition) },
    ])
    const { summary, sink } = await convertFixtures(h, [conversion], { taskFacts: [] })
    expect(summary.status).toBe('converted')
    const index = sink.rows('workflow_dependency_index')
    expect(index).toHaveLength(5)
    const reverse = index.filter((row) => {
      const namespace = JSON.parse(String(row.namespace_json)) as {
        referenceKind: string
        nodeKind: string
      }
      return (
        row.resource_kind === 'agent' &&
        namespace.referenceKind === 'agentId' &&
        namespace.nodeKind === 'agent-single' &&
        row.selector_value !== ''
      )
    })
    expect(reverse.map((row) => row.reference_path)).toEqual(['nodes[0].agentId'])
    expect(reverse.map((row) => row.reference_path)).toEqual(
      collectWorkflowDependencyRefs(definition)
        .filter((ref) => ref.resourceType === 'agent')
        .map((ref) => ref.referencePath),
    )
    expect(
      index.find((row) => row.reference_path === 'nodes[2].agentId')?.namespace_json,
    ).toContain('"nodeKind":"loop"')
  }, 180_000)
})
