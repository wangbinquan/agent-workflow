// RFC-395 C-1: enumerate actual launch selectors; history text never keeps a placeholder alive.
import { expect, test } from 'bun:test'
import { TASK_DEFINITION_HOSTS } from '@agent-workflow/shared'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { convertFixtures, readFixtureRows, seedCollabTask } from './helpers/rfc395V2/collabFixtures'
import { workflowsRule } from '@/modules/resource-catalog/infrastructure/migration/workflowsRule'
import { resourceGrantsRule } from '@/modules/resource-catalog/infrastructure/migration/resourceGrantsRule'
import {
  hostPlaceholders,
  referencedWorkflowIds,
} from '@/modules/resource-catalog/infrastructure/migration/lookups'
import type { TaskFacts } from '@/platform/persistence/migration/conversion/lookups/keys'

const conversion = {
  rules: [workflowsRule, resourceGrantsRule],
  validators: [],
  lookups: [hostPlaceholders, referencedWorkflowIds],
}
const host = TASK_DEFINITION_HOSTS.agent
const skeleton = '{"inputs":[],"nodes":[],"edges":[]}'
const schedule = {
  id: 'schedule',
  name: 'schedule',
  owner_user_id: 'u',
  launch_kind: 'workflow',
  launch_payload: JSON.stringify({
    workflowId: host.id,
    name: 'scheduled',
    inputs: {},
    scratch: true,
  }),
  schedule_spec: '{"kind":"cron","cron":"0 * * * *","timezone":"UTC"}',
}
const webhook = {
  id: 'webhook',
  name: 'webhook',
  endpoint_id: 'endpoint',
  owner_user_id: 'u',
  repo_scope: 'all',
  event_types: '["push"]',
  launch_kind: 'workflow',
  launch_ref_id: host.id,
  launch_payload: '{"name":"hook","inputs":{},"space":{"kind":"scratch"}}',
}
const eventRule = {
  id: 'event-rule',
  name: 'event rule',
  owner_user_id: 'u',
  source_id: 'source',
  source_revision: 1,
  event_type_id: 'event',
  event_type_revision: 1,
  subject_type: 'repo',
  target_json: JSON.stringify({
    kind: 'workflow',
    refId: host.id,
    nameTemplate: 'event task',
    inputs: {},
  }),
  created_at: 1,
  updated_at: 1,
}

describeV2Providers('RFC-395 V2-C catalog reference positions', (h) => {
  test('schedule payload, webhook target and event-rule target are explicit catalog references', async () => {
    await h.install()
    await h.write('users', [
      { id: 'u', username: 'u', display_name: 'U', created_at: 1, updated_at: 1 },
    ])
    await h.write('workflows', [{ ...host, builtin: true, definition: skeleton }])
    await h.write('webhook_endpoints', [
      {
        id: 'endpoint',
        name: 'endpoint',
        provider: 'github',
        url_token: 'fixture',
        secret_enc: 'fixture',
      },
    ])
    await h.write('scheduled_tasks', [{ ...schedule, enabled: false }])
    await h.write('webhook_triggers', [webhook])
    await h.write('event_response_rules', [eventRule])
    await h.write('resource_grants', [
      { resource_type: 'workflow', resource_id: host.id, user_id: 'u', added_by: 'u', added_at: 1 },
    ])
    const { summary, sink } = await convertFixtures(h, [conversion], { taskFacts: [] })
    const block = summary.blocks.find((block) => block.code === 'v2-host-still-referenced')!
    expect(block.detail).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'scheduled_tasks', path: 'launch_payload.workflowId' }),
        expect.objectContaining({ table: 'webhook_triggers', path: 'launch_ref_id' }),
        expect.objectContaining({ table: 'event_response_rules', path: 'target_json.refId' }),
      ]),
    )
    expect(block.detail).toHaveLength(3)
    expect(summary.blocks.some((block) => block.code === 'v2-host-grant-deletion-blocked')).toBe(
      true,
    )
    expect(sink.rows('workflows')).toEqual([])
    expect(sink.rows('resource_grants')).toEqual([])
  }, 180_000)

  test('other target kinds, nested text and malformed schedule payloads do not refer to workflows', async () => {
    await h.install()
    await h.write('users', [
      { id: 'u', username: 'u', display_name: 'U', created_at: 1, updated_at: 1 },
    ])
    await h.write('workflows', [{ ...host, builtin: true, definition: skeleton }])
    await h.write('webhook_endpoints', [
      {
        id: 'endpoint',
        name: 'endpoint',
        provider: 'github',
        url_token: 'fixture',
        secret_enc: 'fixture',
      },
    ])
    await h.write('scheduled_tasks', [
      { ...schedule, launch_kind: 'agent' },
      {
        ...schedule,
        id: 'nested',
        launch_payload: JSON.stringify({
          workflowId: 'real',
          inputs: { text: host.id, nested: JSON.stringify({ workflowId: host.id }) },
        }),
      },
      { ...schedule, id: 'malformed', launch_payload: `{broken:${host.id}` },
    ])
    await h.write('webhook_triggers', [
      { ...webhook, launch_kind: 'agent' },
      {
        ...webhook,
        id: 'text-hook',
        launch_ref_id: 'real',
        launch_payload: JSON.stringify({ name: host.id, workflowId: host.id }),
      },
    ])
    await h.write('event_response_rules', [
      {
        ...eventRule,
        target_json: JSON.stringify({ kind: 'agent', refId: host.id, nameTemplate: host.id }),
      },
      {
        ...eventRule,
        id: 'rule-text',
        target_json: JSON.stringify({
          kind: 'workflow',
          refId: 'real',
          nameTemplate: host.id,
          inputs: { text: host.id },
        }),
      },
    ])
    const { summary, dispositions } = await convertFixtures(h, [conversion], { taskFacts: [] })
    expect(summary.status).toBe('converted')
    expect(
      dispositions.filter((disposition) => disposition.kind === 'deleted-placeholder'),
    ).toHaveLength(1)
  }, 180_000)

  test('all history task subjects, launch receipts, memory scopes and definition text are not catalog references', async () => {
    await h.install()
    await h.write('workflows', [{ ...host, builtin: true, definition: skeleton }])
    const tasks: TaskFacts[] = []
    for (const status of ['failed', 'canceled', 'done']) {
      for (const subjectKind of ['unknown', 'workflow', 'agent'] as const) {
        const id = `${status}-${subjectKind}`
        const fixture = await seedCollabTask(
          h,
          id,
          status,
          status === 'done' ? 'terminal-history' : 'retryable-history',
          {
            workflow_id: host.id,
            source_agent_name: '',
            workflow_snapshot: JSON.stringify({
              id: host.id,
              nodes: [{ kind: 'call-workflow', workflowName: host.name, workflowId: host.id }],
            }),
            ref_closure_json: JSON.stringify({
              workflows: { [host.name]: { id: host.id, definition: { nodes: [] } } },
            }),
          },
        )
        tasks.push({
          ...fixture.task,
          subjectKind,
          definitionAnchorId: host.id,
          sourceId: subjectKind === 'unknown' ? null : host.id,
        })
      }
    }
    const active = await seedCollabTask(h, 'active-agent', 'running', 'executable', {
      workflow_id: host.id,
      source_agent_name: 'agent',
    })
    tasks.push({
      ...active.task,
      subjectKind: 'agent',
      sourceId: 'agent',
      definitionAnchorId: host.id,
    })
    await h.write('task_execution_intents', [
      {
        id: 'intent',
        task_id: 'active-agent',
        kind: 'launch',
        state: 'pending',
        source: 'rest',
        request_hash: 'fixture',
        payload_json: JSON.stringify({ v: 1, workflowId: host.id }),
        execution_lineage_id: 'lineage',
        continuation_slot_key: 'slot',
        slot_path_json: '[]',
        expected_task_revision: 0,
        created_at: 1,
        updated_at: 1,
      },
    ])
    await h.write('memory_distill_jobs', [
      {
        id: 'distill',
        debounce_key: 'distill',
        source_kind: 'task-run',
        source_event_id: 'event',
        task_id: 'active-agent',
        scope_resolved_json: JSON.stringify({ workflowId: host.id }),
        status: 'pending',
        next_run_at: 1,
        created_at: 1,
        user_prompt_md: host.id,
      },
    ])
    await h.write('memory_scope_move_events', [
      {
        id: 'move',
        memory_id: 'memory',
        actor_user_id: 'u',
        actor_source: 'system',
        from_scope_type: 'workflow',
        from_scope_id: host.id,
        to_scope_type: 'global',
        to_scope_id: null,
        expected_version: 1,
        resulting_version: 2,
        correlation_id: 'move',
        occurred_at: 1,
      },
    ])
    await h.write('intent_provenance', [
      {
        resource_type: 'workflow',
        resource_id: host.id,
        commit_id: 'commit',
        session_id: 'session',
        created_at: 1,
      },
    ])
    await h.write('agents', [
      {
        id: 'agent',
        name: 'agent',
        body_md: host.id,
        frontmatter_extra: JSON.stringify({ workflowId: host.id }),
      },
    ])
    await h.write('workgroups', [{ id: 'group', name: 'group', instructions: host.id }])
    const tables = [
      'task_execution_intents',
      'memory_distill_jobs',
      'memory_scope_move_events',
      'intent_provenance',
      'agents',
      'workgroups',
    ]
    const before = await Promise.all(tables.map((table) => readFixtureRows(h, table)))
    const { summary, dispositions } = await convertFixtures(h, [conversion], { taskFacts: tasks })
    expect(summary.status).toBe('converted')
    expect(
      dispositions.filter((disposition) => disposition.kind === 'deleted-placeholder'),
    ).toHaveLength(1)
    expect(await Promise.all(tables.map((table) => readFixtureRows(h, table)))).toEqual(before)
  }, 180_000)
})
