import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TASK_DEFINITION_HOSTS, SPACE_KINDS } from '@agent-workflow/shared'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'
import type { RunSlot } from '@/modules/task-execution/domain/runSelection/slots'
import { historySourceTables } from '@/platform/persistence/migration/archives/codeHistory'
import { contentSourceTables } from '@/platform/content/migration/specs'
import type { V2Harness } from '../rfc395V2Harness'
import { taskRow, repoRow, workgroupConfig, writeTaskFixture } from './taskFixtures'
import { ordinaryDefinition, runValues } from './runFixtures'
import { answer, question, roundRow, gateRow } from './collabFixtures'
import { frozenValues, contentFixture, contentText, contentBytes } from './contentFixtures'
import type { ExpectedRun } from './integration'

export const plainSnapshot = JSON.stringify(ordinaryDefinition)
export const nodeSlot = (
  nodeId = 'ordinary',
  containerRunId: string | null = null,
  iteration = 0,
): RunSlot => ({ kind: 'node', nodeId, frame: { containerRunId, iteration } })
export const syntheticSlot = (
  taskId: string,
  discriminator: string,
  syntheticKind: Extract<RunSlot, { kind: 'synthetic' }>['syntheticKind'],
  parent?: string,
): RunSlot => ({
  kind: 'synthetic',
  syntheticKind,
  discriminator,
  owner: parent ? { kind: 'attempt', id: parent } : { kind: 'task', id: taskId },
})

export async function seedRequiredRows(h: V2Harness): Promise<void> {
  const source = await h.sourceHarness.source()
  const missing: string[] = []
  try {
    await source.preflight()
    for (const [table, id] of [
      ['users', '__system__'],
      ['auth_login_policy', 'global'],
      ['employee_os_writer_state', 'global'],
    ] as const)
      if (!(await source.readChunk(table, null, 1000)).decodedRows.some((row) => row.id === id))
        missing.push(table)
  } finally {
    await source.close()
  }
  for (const table of missing)
    await h.write(table, [
      frozenValues(
        table,
        table === 'users'
          ? { id: '__system__', username: '__system__', display_name: 'System' }
          : table === 'employee_os_writer_state'
            ? {
                id: 'global',
                active_generation: 0,
                mode: 'pre-cutover',
                legacy_admissions_enabled: true,
                legacy_open_mission_count: 0,
                updated_at: 123,
              }
            : { id: 'global' },
      ),
    ])
}

export async function seedSimpleTask(
  h: V2Harness,
  id: string,
  status: string,
  overrides: DecodedSourceRow = {},
) {
  const task = taskRow(id, {
    status,
    space_kind: 'internal',
    workflow_snapshot: plainSnapshot,
    ...overrides,
  })
  await writeTaskFixture(h, task)
  return task
}

/** Every write is h.write -> frozen raw writer; expected slots are fixture facts, not converter output. */
export async function seedMixedInstance(h: V2Harness): Promise<ExpectedRun[]> {
  await seedRequiredRows(h)
  await h.write('users', [
    frozenValues('users', { id: 'editor', username: 'editor', created_by: '__system__' }),
  ])
  await h.write('maintenance_state', [
    { key: 'integration-copy', value: ' { "bytes": "保留" }\r\n', updated_at: 123 },
  ])
  await h.write('skills', [
    contentFixture('skills', {
      id: 'skill',
      name: 'fixture-skill',
      managed_path: 'database:skill_content_entries',
      content_version: 1,
      version_state: 'snapshot-authoritative',
    }),
  ])
  await h.write('agents', [
    { id: 'dependency', name: 'dependency' },
    {
      id: 'agent',
      name: 'integration-agent',
      skills:
        '[{"kind":"managed","skillId":"skill"},{"kind":"project","name":"local/技能"},{"kind":"managed","skillId":"skill"}]',
      depends_on: '["dependency","dependency"]',
      mcp: '["mcp","mcp"]',
      plugins: '["plugin","plugin"]',
    },
  ])
  await h.write('mcps', [frozenValues('mcps', { id: 'mcp', name: 'integration-mcp' })])
  await h.write('plugins', [frozenValues('plugins', { id: 'plugin', name: 'integration-plugin' })])
  await h.write('resource_grants', [
    frozenValues('resource_grants', {
      resource_type: 'agent',
      resource_id: 'agent',
      user_id: 'editor',
      added_by: '__system__',
    }),
  ])
  const graph = {
    $schema_version: 7,
    inputs: [],
    nodes: [
      { id: 'ordinary', kind: 'script' },
      { id: 'review', kind: 'review' },
      { id: 'fan', kind: 'wrapper-fanout', nodeIds: ['shard', 'agg'], shardSourcePort: 'items' },
      { id: 'shard', kind: 'script' },
      { id: 'agg', kind: 'agent-single', agentId: 'agent', agentName: 'integration-agent' },
      { id: 'outer', kind: 'wrapper-loop', nodeIds: ['inner'] },
      { id: 'inner', kind: 'wrapper-loop', nodeIds: ['clarify'] },
      { id: 'clarify', kind: 'clarify' },
    ],
    edges: [
      {
        id: 'fanout-input',
        source: { nodeId: 'fan', portName: 'items' },
        target: { nodeId: 'shard', portName: 'in' },
        boundary: 'wrapper-input',
      },
      {
        id: 'fanout-aggregate',
        source: { nodeId: 'shard', portName: 'out' },
        target: { nodeId: 'agg', portName: 'in' },
      },
      {
        id: 'fanout-output',
        source: { nodeId: 'agg', portName: 'out' },
        target: { nodeId: 'fan', portName: 'out' },
        boundary: 'wrapper-output',
      },
    ],
  }
  await h.write('workflows', [
    { id: 'workflow', name: 'integration-workflow', definition: JSON.stringify(graph) },
  ])
  await seedSimpleTask(h, 'task', 'awaiting_human', {
    workflow_id: 'workflow',
    workflow_snapshot: JSON.stringify(graph),
  })
  const expected: ExpectedRun[] = []
  const add = async (
    id: string,
    taskId: string,
    slot: RunSlot,
    seq: number,
    extra: DecodedSourceRow = {},
    frame?: { container: string; scope: string },
  ) => {
    const values = runValues(id, {
      task_id: taskId,
      node_id: slot.kind === 'synthetic' ? slot.discriminator : slot.nodeId,
      seq,
      started_at: 1000 + seq,
      ...extra,
    })
    await h.write('node_runs', [values])
    expected.push({
      id,
      taskId,
      slot,
      seq,
      container: frame?.container ?? (values.container_run_id as string | null),
      scope: frame?.scope ?? String(values.scope_path),
      iteration: Number(values.iteration),
    })
  }
  await add('run', 'task', nodeSlot(), -3, {
    status: 'done',
    pre_snapshot: 'pre-run',
    iso_base_snapshot: 'base-run',
    iso_node_tree: 'tree-run',
  })
  await add('review-first', 'task', nodeSlot('review'), -2, { status: 'done' })
  await add('review-rerun', 'task', nodeSlot('review'), -1, {
    status: 'awaiting_review',
    review_iteration: 1,
    rerun_cause: 'review-rerun',
    consumed_upstream_runs_json: '{ "ordinary": "run" }',
  })
  await add(
    'fan',
    'task',
    { kind: 'container', nodeId: 'fan', frame: { containerRunId: null, iteration: 0 } },
    1,
    { rerun_cause: 'wrapper-init' },
  )
  for (const [seq, key] of [
    [2, 'a'],
    [3, 'b'],
  ] as const)
    await add(
      `shard-${key}`,
      'task',
      { kind: 'shard', nodeId: 'shard', iteration: 0, shardKey: key },
      seq,
      {
        parent_node_run_id: 'fan',
        container_run_id: 'fan',
        scope_path: 'fan:0',
        shard_key: key,
        shard_value_hash: `hash-${key}`,
        rerun_cause: 'fanout-shard',
      },
    )
  await add('agg', 'task', { kind: 'aggregator', nodeId: 'agg', iteration: 0 }, 4, {
    parent_node_run_id: 'fan',
    container_run_id: 'fan',
    scope_path: 'fan:0',
    rerun_cause: 'fanout-aggregator',
    consumed_upstream_runs_json: '{"shard":"shard-b"}',
  })
  await add(
    'outer',
    'task',
    { kind: 'container', nodeId: 'outer', frame: { containerRunId: null, iteration: 0 } },
    5,
    { rerun_cause: 'wrapper-init' },
  )
  await add(
    'inner',
    'task',
    { kind: 'container', nodeId: 'inner', frame: { containerRunId: 'outer', iteration: 0 } },
    6,
    { rerun_cause: 'wrapper-init' },
    { container: 'outer', scope: 'outer:0' },
  )
  await add(
    'clarify',
    'task',
    nodeSlot('clarify', 'inner'),
    7,
    { status: 'awaiting_human' },
    { container: 'inner', scope: 'outer:0/inner:0' },
  )
  await add(
    'clarify-next',
    'task',
    nodeSlot('clarify', 'inner', 1),
    8,
    { iteration: 1, status: 'done' },
    { container: 'inner', scope: 'outer:0/inner:1' },
  )
  await add(
    'commit',
    'task',
    syntheticSlot('task', '__commit_push__:ordinary', 'commit-push', 'run'),
    9,
    {
      parent_node_run_id: 'run',
      rerun_cause: 'commit-push',
      commit_push_json: '{ "head":"commit-sha" }',
    },
  )
  await add(
    'commit-session',
    'task',
    syntheticSlot('task', '__commit_push__:ordinary', 'commit-session', 'commit'),
    10,
    { parent_node_run_id: 'commit', rerun_cause: 'commit-push-session' },
  )
  await h.write('node_run_seq_allocations', [
    { seq: 500, task_id: 'task', node_run_id: 'pruned-run', allocated_at: 900 },
  ])
  await h.write('clarify_rounds', [
    roundRow('standalone', 'task', {
      asking_node_id: 'clarify',
      asking_node_run_id: 'clarify',
      intermediary_node_id: 'clarify',
      intermediary_node_run_id: 'clarify',
      status: 'awaiting_human',
      answered_at: null,
      answer_attributions_json: '{ "q": {"userId":"editor","role":"owner","updatedAt":110} }',
    }),
    roundRow('legacy-answer', 'task', {
      asking_node_id: 'clarify',
      asking_node_run_id: 'clarify',
      intermediary_node_id: 'clarify',
      intermediary_node_run_id: 'clarify',
      answers_json: ' "legacy answer"\n',
    }),
    roundRow('partial', 'task', {
      asking_node_id: 'clarify',
      asking_node_run_id: 'clarify',
      intermediary_node_id: 'clarify',
      intermediary_node_run_id: 'clarify',
      status: 'awaiting_human',
      answered_at: null,
      questions_json: JSON.stringify([question(), question('q2')]),
      answers_json: JSON.stringify([answer()]),
      draft_answers_json: '{"q2":{"customText":"draft"}}',
    }),
  ])
  await h.write('collaboration_gate_operations', [
    gateRow('gate', 'task', {
      state: 'completed',
      gate_kind: 'review',
      gate_ref: 'review-rerun',
      receipt_json: ' { "accepted": true }\n',
      result_gate_revision: 1,
      committed_at: 120,
      completed_at: 121,
    }),
  ])

  // Five subjects x five space kinds. Workgroups use actual platform host snapshots.
  for (const subject of [
    'workflow',
    'agent',
    'workgroup',
    'digital-employee',
    'code-round',
  ] as const)
    for (const space of SPACE_KINDS) {
      const id = `${subject}-${space}`
      const task = taskRow(id, {
        status: 'pending',
        space_kind: space,
        workflow_id: subject === 'workflow' ? 'workflow' : TASK_DEFINITION_HOSTS[subject].id,
        ...(subject === 'agent'
          ? { source_agent_name: 'integration-agent', source_agent_id: 'agent' }
          : {}),
        ...(subject === 'workgroup'
          ? { workgroup_id: 'group', workgroup_config_json: workgroupConfig() }
          : {}),
        ...(subject === 'code-round' ? { code_round_id: 'finished-round' } : {}),
      })
      await writeTaskFixture(
        h,
        task,
        subject === 'workgroup' ? { state: { gate_status: 'approved' } } : {},
      )
    }
  await add(
    'host',
    'workgroup-internal',
    { kind: 'workgroup-host', nodeId: '__wg_leader__', shardKey: null },
    1,
    { rerun_cause: 'wg-leader-round', wg_round: 1 },
  )
  await add(
    'host-gate',
    'workgroup-internal',
    syntheticSlot('workgroup-internal', '__wg_leader__', 'wg-gate'),
    2,
    { rerun_cause: 'wg-gate', status: 'awaiting_review' },
  )
  await add(
    'member',
    'workgroup-internal',
    { kind: 'workgroup-host', nodeId: '__wg_member__', shardKey: 'msg:member:message' },
    3,
    { rerun_cause: 'wg-message-turn', shard_key: 'msg:member:message' },
  )
  await h.write('workgroup_assignments', [
    {
      id: 'assignment',
      task_id: 'workgroup-internal',
      source: 'system',
      title: 'persisted host writer',
      status: 'done',
      created_by_run_id: 'host',
      node_run_id: 'member',
      created_at: 1,
      updated_at: 2,
    },
  ])
  for (const phase of ['generating', 'executing'] as const) {
    const id = `dynamic-${phase}`
    await writeTaskFixture(
      h,
      taskRow(id, {
        status: 'awaiting_review',
        workflow_id: TASK_DEFINITION_HOSTS.workgroup.id,
        workgroup_id: 'group',
        workgroup_config_json: workgroupConfig('dynamic_workflow'),
        ...(phase === 'executing' ? { workflow_snapshot: plainSnapshot } : {}),
      }),
      {
        state: {
          gate_status: 'awaiting_confirmation',
          dw_state_json: JSON.stringify({ phase, generateAttempts: 1, rejectRounds: 0 }),
        },
      },
    )
    await add(`${id}-host`, id, syntheticSlot(id, '__dw_orchestrator__', 'dw-orchestrator'), 1, {
      rerun_cause: 'dw-generate',
    })
    await add(`${id}-gate`, id, syntheticSlot(id, '__dw_orchestrator__', 'dw-gate'), 2, {
      rerun_cause: 'dw-gate',
      status: 'awaiting_review',
    })
  }
  for (const journal of [false, true]) {
    const id = journal ? 'prep-new' : 'prep-old'
    await seedSimpleTask(h, id, 'interrupted', { worktree_path: '' })
    if (journal)
      await h.write('task_workspace_preparations', [
        {
          id: 'prep-journal',
          admission_key: 'prep-admission',
          request_digest: 'prep-digest',
          lane: 'repository-preparation',
          state: 'admitted',
          admitted_task_id: id,
          created_at: 1,
          updated_at: 2,
        },
      ])
    await add(`${id}-high-retry`, id, syntheticSlot(id, '__repo_prep__', 'repo-prep'), 1, {
      retry_index: 9,
      status: 'failed',
      started_at: 1786665600000,
    })
    await add(`${id}-high-seq`, id, syntheticSlot(id, '__repo_prep__', 'repo-prep'), 2, {
      retry_index: 2,
      status: 'interrupted',
      started_at: 1786665601000,
    })
  }
  const sample = taskRow('sample-227', {
    status: 'running',
    space_kind: 'internal',
    branch: 'publish/task-227',
    base_branch: 'sha-227',
    base_commit: 'sha-227',
    workflow_snapshot: plainSnapshot,
  })
  await writeTaskFixture(h, sample, { repos: [repoRow(sample, { branch: '' })] })
  await add('sample-227-run', 'sample-227', nodeSlot(), 1)
  const single = taskRow('single-member', {
    status: 'interrupted',
    space_kind: 'internal',
    workflow_snapshot: plainSnapshot,
  })
  await writeTaskFixture(h, single, {
    repos: [
      repoRow(single, {
        mount_path: 'svc',
        worktree_dir_name: 'svc',
        worktree_path: '/work/single-member/svc',
      }),
    ],
  })
  await add('member-merged', 'single-member', nodeSlot(), 1, {
    merge_state: 'merged',
    iso_worktree_path: '/iso/svc',
    iso_base_snapshot: 'base-only',
    iso_node_tree: null,
  })

  await seedAlignmentAndHistory(h)
  for (const table of contentSourceTables)
    if (table !== 'skills')
      await h.write(table, [
        contentFixture(
          table,
          table === 'skill_versions'
            ? { files_path: 'database:skill_content_entries', content_hash: null }
            : {},
        ),
      ])
  await h.write('skills', [contentFixture('skills')])
  await h.write('skill_content_entries', [
    frozenValues('skill_content_entries', {
      skill_id: 'skill',
      tree: 'version:1',
      path: 'SKILL.md',
      encoding: 'utf8',
      content: contentText,
      size: contentBytes.length,
    }),
  ])
  const localRoot = join(h.sourceHarness.operationRoot, 'skills', 'other-skill', 'files')
  await mkdir(localRoot, { recursive: true })
  await writeFile(join(localRoot, 'SKILL.md'), contentBytes)
  return expected
}

async function seedAlignmentAndHistory(h: V2Harness): Promise<void> {
  const put = async (table: string, values: DecodedSourceRow) =>
    h.write(table, [frozenValues(table, values)])
  await put('task_collaborators', { task_id: 'task', user_id: 'editor', added_by: '__system__' })
  await put('memories', {
    id: 'memory',
    scope_type: 'global',
    scope_id: null,
    supersedes_id: null,
    superseded_by_id: null,
  })
  await put('repo_groups', { id: 'group', name: 'fixture-group' })
  await put('repo_group_nodes', {
    group_id: 'group',
    path: '',
    attachment_kind: null,
    child_group_id: null,
    cached_repo_id: null,
  })
  await put('development_missions', {
    id: 'mission',
    status: 'done',
    terminal_at: 999,
    source_kind: 'direct',
    delivery_kind: 'adopt-merge-request',
  })
  await put('intent_sessions', { id: 'session', owner_user_id: 'editor' })
  await put('intent_turns', { id: 'turn', session_id: 'session' })
  await put('intent_turn_events', {
    id: 7001,
    turn_id: 'turn',
    event_seq: 1,
    external_event_id: null,
    payload: 'original event bytes',
  })
  await put('runtime_session_leases', {
    protocol: 'opencode',
    session_id: 'lease',
    task_id: 'task',
    created_node_run_id: 'run',
    lease_node_run_id: 'run',
    lease_nonce_digest: 'digest',
    leased_at: 100,
    reset_pending: false,
  })
  await put('user_access_audit', { id: 'audit', target_user_id: 'editor' })
  await h.write('intent_apply_journal', [
    {
      id: 'intent-apply',
      session_id: 'session',
      client_mutation_id: 'apply-key',
      draft_id: 'draft',
      draft_hash: 'hash',
      state: 'committed',
      prepared_artifacts_json:
        ' [ { "kind":"skill-stage", "skillId":"skill", "opId":"original-op", "skillDir":"original" } ]\n',
      receipt_json: '{ "same":true }',
      created_at: 1,
      updated_at: 2,
    },
  ])
  await h.write('resource_bundle_applies', [
    {
      id: 'bundle-apply',
      scope: 'scope',
      key: 'bundle-key',
      actor_user_id: 'editor',
      state: 'committed',
      prepared_artifacts_json: '{ "scene":"resource-package", "version":1, "artifacts":[] }',
      receipt_json: '{ "journalId":"bundle-apply", "applied":[] }',
      created_at: 1,
      updated_at: 2,
    },
  ])
  await put('code_work_items', {
    id: 'finished-work',
    anchor_id: 'finished-anchor',
    status: 'settled',
  })
  await put('code_work_items', {
    id: 'adopted-work',
    anchor_id: 'adopted-anchor',
    status: 'awaiting',
    pending_generation: 7,
  })
  await put('code_work_rounds', {
    id: 'finished-round',
    work_item_id: 'finished-work',
    outcome: 'published',
    ended_at: 900,
  })
  await put('code_work_rounds', {
    id: 'adopted-round',
    work_item_id: 'adopted-work',
    outcome: 'awaiting',
    ended_at: 900,
  })
  await put('legacy_code_work_item_links', {
    id: 'adoption',
    mission_id: 'mission',
    legacy_work_item_id: 'adopted-work',
    legacy_round_id: 'adopted-round',
    cutover_receipt_json:
      '{"observedState":"opened","headSha":null,"targetBranch":null,"adoptedAt":123}',
  })
  await put('code_ai_attempts', {
    id: 'attempt',
    round_id: 'finished-round',
    status: 'validated',
    ended_at: 900,
  })
  await put('code_round_stages', {
    id: 'stage',
    round_id: 'finished-round',
    status: 'done',
    ended_at: 900,
  })
  await put('code_findings', {
    id: 'finding',
    lifecycle: 'active',
    closed_at: null,
    resolved_at: null,
  })
  await put('code_trigger_deliveries', {
    id: 'delivery',
    outcome: 'ok',
    step: 'round',
    round_id: 'finished-round',
  })
  const source = await h.sourceHarness.source()
  let present: Set<string>
  try {
    present = new Set((await source.preflight()).tables.map((table) => table.table))
  } finally {
    await source.close()
  }
  for (const table of historySourceTables)
    if (
      present.has(table) &&
      [
        'code_artifacts',
        'code_fix_attempts',
        'code_mr_leases',
        'code_produced_mrs',
        'code_publish_intents',
        'code_work_observations',
      ].includes(table)
    )
      await put(table, {})
  await put('committed_event_family_cutovers', {
    producer: 'task-execution',
    family: 'review',
    mode: 'dispatchable',
    epoch: 77,
    changed_at: 456,
    change_ref: 'integration-cutover',
  })
}
