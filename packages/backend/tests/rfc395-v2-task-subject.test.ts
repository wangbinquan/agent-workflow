import { expect, test } from 'bun:test'
import { TASK_DEFINITION_HOSTS, canonicalJson } from '@agent-workflow/shared'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import {
  taskRow,
  repoRow,
  workgroupConfig,
  writeTaskFixture,
  convertTaskFixtures,
  assertTaskProjection,
} from './helpers/rfc395V2/taskFixtures'
import destinations from '@/bootstrap/targetColumnDestinations.json'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'

describeV2Providers('RFC-395 V2-T subject and definition', (h) => {
  test('TASK_FACTS classifies every D4 status once and supplies startedAt without any run', async () => {
    await h.install()
    const expected = {
      pending: 'executable',
      running: 'executable',
      awaiting_review: 'executable',
      awaiting_human: 'executable',
      interrupted: 'executable',
      failed: 'retryable-history',
      canceled: 'retryable-history',
      done: 'terminal-history',
    }
    for (const status of Object.keys(expected))
      await writeTaskFixture(
        h,
        taskRow(status, { status, started_at: 9876, worktree_path: '', base_commit: null }),
      )
    const result = await convertTaskFixtures(h)
    expect(result.summary.blocks).toEqual([])
    for (const [status, execution] of Object.entries(expected)) {
      expect(result.facts.get(status)).toMatchObject({ execution, startedAt: 9876 })
      assertTaskProjection(result, status)
    }
  })

  test('all five subjects preserve snapshots and use the fixed discriminator precedence', async () => {
    await h.install()
    const cases: (DecodedSourceRow & { readonly id: string })[] = [
      { id: 'workflow', workflow_id: 'deleted-workflow' },
      {
        id: 'agent',
        workflow_id: TASK_DEFINITION_HOSTS.agent.id,
        source_agent_name: 'Deleted agent',
        source_agent_id: 'deleted-agent',
      },
      {
        id: 'workgroup',
        workflow_id: TASK_DEFINITION_HOSTS.workgroup.id,
        workgroup_id: 'group',
        source_agent_name: 'lower-priority',
        workgroup_config_json: workgroupConfig(),
      },
      { id: 'digital-employee', workflow_id: TASK_DEFINITION_HOSTS['digital-employee'].id },
      {
        id: 'code-round',
        workflow_id: TASK_DEFINITION_HOSTS['code-round'].id,
        code_round_id: 'round',
        workgroup_id: 'group',
        source_agent_name: 'lower-priority',
      },
    ]
    for (const row of cases)
      await writeTaskFixture(h, taskRow(row.id, { ...row, status: 'pending' }))
    const result = await convertTaskFixtures(h)
    expect(result.summary.blocks).toEqual([])
    for (const row of cases) {
      const target = result.sink.rows('task_definitions').find((value) => value.task_id === row.id)!
      expect(target.subject_kind).toBe(row.id)
      expect(target.workflow_snapshot).toBe(taskRow(row.id, row).workflow_snapshot)
      expect(target.inputs).toBe('{ "goal": "frozen" }')
      expect(target.source_revision).toBe(7)
      assertTaskProjection(result, row.id)
    }
    expect(
      result.sink.rows('task_definitions').find((row) => row.task_id === 'digital-employee')!
        .source_id,
    ).toBeNull()
    expect(
      result.sink.rows('task_definitions').find((row) => row.task_id === 'code-round')!.source_id,
    ).toBe('round')
  })

  test('deleted workflow stays authored; a recorded builtin workflow is platform', async () => {
    await h.install()
    await h.write('workflows', [
      {
        id: 'builtin-fixture',
        name: 'Builtin fixture',
        definition: '{"inputs":[],"nodes":[],"edges":[]}',
        builtin: true,
        created_at: 1,
        updated_at: 1,
      },
    ])
    await writeTaskFixture(h, taskRow('deleted'))
    await writeTaskFixture(h, taskRow('builtin', { workflow_id: 'builtin-fixture' }))
    const result = await convertTaskFixtures(h)
    expect(result.summary.blocks).toEqual([])
    expect(
      result.sink.rows('task_definitions').find((row) => row.task_id === 'deleted')!
        .definition_origin,
    ).toBe('authored')
    expect(
      result.sink.rows('task_definitions').find((row) => row.task_id === 'builtin')!
        .definition_origin,
    ).toBe('platform')
    for (const id of ['deleted', 'builtin']) assertTaskProjection(result, id)
  })

  for (const status of [
    'pending',
    'running',
    'awaiting_review',
    'awaiting_human',
    'interrupted',
    'failed',
    'canceled',
    'done',
  ])
    test(`host discriminator mismatch is explicit unknown under ${status}`, async () => {
      await h.install()
      await writeTaskFixture(
        h,
        taskRow(status, {
          workflow_id: TASK_DEFINITION_HOSTS.agent.id,
          status,
          source_agent_name: '',
        }),
      )
      const result = await convertTaskFixtures(h)
      expect(result.facts.get(status)!.subjectKind).toBe('unknown')
      if (result.facts.get(status)!.execution === 'executable')
        expect(result.summary.blocks.some((row) => row.code === 'v2-task-subject-mismatch')).toBe(
          true,
        )
      else {
        expect(result.summary.blocks).toEqual([])
        expect(result.summary.historyOnly[0]!.history!.missingFields).toContain('subject_kind')
      }
      if (result.facts.get(status)!.execution === 'executable') {
        expect(result.sink.rows('task_definitions')).toEqual([])
        expect(result.sink.rows('tasks')).toEqual([])
        expect(result.sink.rows('execution_legacy_evidence')).toEqual([])
      } else {
        expect(result.sink.rows('task_definitions')).toHaveLength(1)
        expect(result.sink.rows('task_definitions')[0]).toMatchObject({
          task_id: status,
          subject_kind: 'unknown',
          engine_kind: 'unknown',
          source_id: TASK_DEFINITION_HOSTS.agent.id,
          workflow_snapshot: taskRow(status).workflow_snapshot,
        })
        expect(result.sink.rows('execution_legacy_evidence')[0]!.provenance_quality).toBe('unknown')
        assertTaskProjection(result, status)
      }
    })

  for (const [mode, phase, engine] of [
    ['leader_worker', null, 'workgroup-turns'],
    ['free_collab', null, 'workgroup-turns'],
    ['dynamic_workflow', 'generating', 'dw-generate'],
    ['dynamic_workflow', 'executing', 'dag'],
  ] as const)
    test(`${mode}/${phase} freezes the engine and splits five launch keys from exact runtime bytes`, async () => {
      await h.install()
      const config = workgroupConfig(mode, { goal: '', unknown: { preserve: 'raw' } })
      const task = taskRow('group-task', {
        workflow_id: TASK_DEFINITION_HOSTS.workgroup.id,
        workgroup_id: 'group',
        workgroup_config_json: config,
        status: 'running',
      })
      await writeTaskFixture(h, task, {
        state: {
          dw_state_json:
            phase === null ? null : JSON.stringify({ phase, generateAttempts: 0, rejectRounds: 0 }),
          gate_summary: 'old summary',
          pause_reason: 'pause',
        },
      })
      const result = await convertTaskFixtures(h)
      expect(result.summary.blocks).toEqual([])
      expect(result.facts.get('group-task')!.engineKind).toBe(engine)
      expect(result.sink.rows('task_definitions')[0]!.workgroup_config_json).toBe(
        canonicalJson({
          workgroupId: 'group',
          workgroupName: 'Frozen group',
          mode,
          goal: '',
          leaderMemberId: mode === 'leader_worker' ? 'member' : null,
        }),
      )
      expect(result.sink.rows('workgroup_task_state')[0]).toMatchObject({
        runtime_config_json: config,
        config_revision: 1,
        updated_at: 4321,
        gate_summary: 'old summary',
        pause_reason: 'pause',
      })
      assertTaskProjection(result, 'group-task')
    })

  test('missing workgroup state uses engine defaults and task.started_at deterministically', async () => {
    await h.install()
    await writeTaskFixture(
      h,
      taskRow('default-state', {
        workflow_id: TASK_DEFINITION_HOSTS.workgroup.id,
        workgroup_id: 'group',
        workgroup_config_json: workgroupConfig(),
        status: 'pending',
      }),
    )
    const result = await convertTaskFixtures(h)
    expect(result.summary.blocks).toEqual([])
    expect(result.sink.rows('workgroup_task_state')[0]).toEqual({
      task_id: 'default-state',
      gate_status: 'idle',
      gate_summary: null,
      gate_rejected_comment: null,
      pause_reason: null,
      dw_state_json: null,
      result_message_id: null,
      updated_at: 1001,
      runtime_config_json: workgroupConfig(),
      config_revision: 1,
    })
    expect(
      result.summary.records.some(
        (row) => row.kind === 'decision' && row.code === 'v2-task-workgroup-state-synthesized',
      ),
    ).toBe(true)
    assertTaskProjection(result, 'default-state')
  })

  for (const status of ['running', 'failed', 'done'])
    test(`incomplete configuration and frozen definition are classified using ${status}`, async () => {
      await h.install()
      await writeTaskFixture(
        h,
        taskRow('incomplete', {
          status,
          workflow_id: TASK_DEFINITION_HOSTS.workgroup.id,
          workgroup_id: 'group',
          workgroup_config_json: '{ "mode": "leader_worker", "goal": "partial" }',
          workflow_snapshot: 'malformed snapshot',
        }),
      )
      const result = await convertTaskFixtures(h)
      if (status !== 'running')
        expect(result.sink.rows('workgroup_task_state')[0]!.runtime_config_json).toBe(
          '{ "mode": "leader_worker", "goal": "partial" }',
        )
      if (status === 'running')
        expect(
          result.summary.blocks.some((row) => row.code === 'v2-task-definition-incomplete'),
        ).toBe(true)
      else {
        expect(result.summary.blocks).toEqual([])
        expect(result.summary.historyOnly[0]!.history!.missingFields).toContain('workflow_snapshot')
        expect(result.summary.historyOnly[0]!.history!.missingFields).toContain(
          'workgroup_config_json',
        )
      }
      if (status !== 'running') assertTaskProjection(result, 'incomplete')
      else expect(result.sink.rows('tasks')).toEqual([])
    })

  for (const status of ['running', 'failed', 'canceled', 'done'])
    test(`CORE-1 malformed workgroup config has a D4 decision for ${status}`, async () => {
      await h.install()
      await writeTaskFixture(
        h,
        taskRow('malformed', {
          workflow_id: TASK_DEFINITION_HOSTS.workgroup.id,
          workgroup_id: 'group',
          workgroup_config_json: '{broken',
          status,
        }),
      )
      const result = await convertTaskFixtures(h)
      expect(result.summary.blocks.some((row) => row.code === 'v2-task-config-undecodable')).toBe(
        status === 'running',
      )
      expect(
        result.summary.blocks.some(
          (row) => row.code === 'v2-source-codec' || row.code === 'v2-undecided-source-codec',
        ),
      ).toBe(false)
      if (status === 'running') expect(result.sink.rows('tasks')).toEqual([])
      else {
        expect(result.summary.blocks).toEqual([])
        expect(result.summary.historyOnly[0]!.codecColumns).toEqual(['workgroup_config_json'])
        expect(result.sink.rows('workgroup_task_state')[0]!.runtime_config_json).toBeNull()
        const evidence = Buffer.from(
          result.sink.rows('execution_legacy_evidence')[0]!.content_inline_bytes as Uint8Array,
        ).toString()
        expect(evidence).toContain('{broken')
        expect(evidence).not.toContain('sourceValues')
        assertTaskProjection(result, 'malformed')
      }
    })

  test('workflow decoder defaults omitted inputs, nodes and edges while retaining source bytes', async () => {
    await h.install()
    await writeTaskFixture(
      h,
      taskRow('defaults', { status: 'running', workflow_snapshot: '{"$schema_version":7}' }),
    )
    const result = await convertTaskFixtures(h)
    expect(result.summary.blocks).toEqual([])
    expect(result.sink.rows('task_definitions')[0]!.workflow_snapshot).toBe('{"$schema_version":7}')
  })

  test('all 70 task destinations and every task_repos column remain accounted for', async () => {
    await h.install()
    const task = taskRow('column-destinations', {
      status: 'done',
      working_branch: 'work',
      max_duration_ms: 100,
      max_total_tokens: 200,
      ref_closure_json: '{ "frozen": true }',
      trigger_context_json: '{ "event": "value" }',
      platform_input_paths_json: '["x"]',
      git_user_name: 'Name',
      git_user_email: 'mail',
      auto_commit_push: true,
      source_termination_launch_rev: 3,
    })
    await writeTaskFixture(h, task, { repos: [repoRow(task)] })
    const result = await convertTaskFixtures(h)
    expect(result.summary.blocks).toEqual([])
    expect(Object.keys(destinations.tasks)).toHaveLength(70)
    const source = result.sourceRows.get('tasks')![0]!.values
    const special = new Set([
      'workflow_id',
      'workgroup_id',
      'source_agent_id',
      'code_round_id',
      'source_agent_name',
      'workgroup_config_json',
      'repo_count',
    ])
    for (const [column, destination] of Object.entries(destinations.tasks)) {
      if (special.has(column)) continue
      const target = result.sink
        .rows(destination.table!)
        .find((row) => row.task_id === task.id || row.id === task.id)!
      expect(target[destination.column]).toEqual(source[column])
    }
    const repo = result.sourceRows.get('task_repos')![0]!.values
    const mount = result.sink.rows('task_repository_mounts')[0]!
    for (const [column, destination] of Object.entries(destinations.task_repos))
      if (!['worktree_path', 'worktree_dir_name'].includes(column))
        expect(mount[destination.column]).toEqual(repo[column])
    assertTaskProjection(result, 'column-destinations')
  })
})
