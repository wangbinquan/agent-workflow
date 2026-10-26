import { expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import {
  taskRow,
  repoRow,
  writeTaskFixture,
  convertTaskFixtures,
  assertTaskProjection,
  assertTaskHistoryProjection,
} from './helpers/rfc395V2/taskFixtures'
import { decodeRequestedSourceJson } from '@/modules/task-execution/domain/requestedSourceCodec'

describeV2Providers('RFC-395 V2-T workspace', (h) => {
  test('equal mirrors, deterministic repo keys and all frozen mount columns survive', async () => {
    await h.install()
    const task = taskRow('equal')
    await writeTaskFixture(h, task, {
      repos: [
        repoRow(task, {
          readonly: true,
          readonly_dirty_count: 4,
          workspace_profile_version: 2,
          workspace_profile_digest: 'profile-digest',
          has_submodules: true,
          submodule_init_ok: false,
          submodule_init_error: 'original error',
          schema_version: 7,
        }),
      ],
    })
    const result = await convertTaskFixtures(h)
    expect(result.summary.blocks).toEqual([])
    expect(result.sink.rows('task_repository_mounts')[0]).toMatchObject({
      ordinal: 0,
      readonly: true,
      schema_version: 7,
      branch_state: 'branch',
      workspace_profile_version: 2,
      submodule_init_error: 'original error',
    })
    expect(result.mounts.get('equal')!.mounts[0]!.repoKey).toBe(
      result.sink.rows('task_repository_mounts')[0]!.repo_key as string,
    )
    expect(result.summary.records).toBeDefined()
    expect(
      [...result.sink.units.values()]
        .flatMap((unit) => unit.dispositions)
        .some((row) => row.decision?.code === 'v2-task-mount-merge'),
    ).toBe(true)
    assertTaskProjection(result, 'equal')
  })

  test('legacy root-only rows produce ordinal zero and record the admitted source version', async () => {
    await h.install()
    await writeTaskFixture(h, taskRow('legacy-root'))
    const result = await convertTaskFixtures(h)
    expect(result.summary.status).toBe('converted')
    expect(result.sink.rows('task_repository_mounts')).toHaveLength(1)
    expect(result.mounts.get('legacy-root')!.layout).toBe('single-root')
    const evidence = result.sink.rows('execution_legacy_evidence')[0]!
    expect(evidence.provenance_quality).toBe('legacy-derived')
    expect(Buffer.from(evidence.content_inline_bytes as Uint8Array).toString()).toContain(
      'sourceVersion',
    )
    assertTaskProjection(result, 'legacy-root')
  })

  test('the exact 227 shape keeps task branch and detached baseline SHA separately', async () => {
    await h.install()
    const task = taskRow('sample-227', {
      space_kind: 'internal',
      branch: 'publish/task-227',
      base_branch: 'sha-227',
      base_commit: 'sha-227',
      status: 'running',
    })
    await writeTaskFixture(h, task, { repos: [repoRow(task, { branch: '' })] })
    const result = await convertTaskFixtures(h)
    expect(result.summary.blocks).toEqual([])
    expect(result.sink.rows('task_workspaces')[0]!.task_branch).toBe('publish/task-227')
    expect(result.sink.rows('task_repository_mounts')[0]).toMatchObject({
      branch: null,
      branch_state: 'detached',
      base_branch: 'sha-227',
      base_commit: 'sha-227',
    })
    expect(
      Buffer.from(
        result.sink.rows('execution_legacy_evidence')[0]!.content_inline_bytes as Uint8Array,
      ).toString(),
    ).toContain('internal-branch-split')
    assertTaskProjection(result, 'sample-227')
  })

  test('D8 maps empty refs to NULL, no git state to none, and never invents unborn', async () => {
    await h.install()
    for (const [id, baseCommit] of [
      ['detached', 'sha'],
      ['no-git', null],
    ] as const) {
      const task = taskRow(id, {
        space_kind: 'inherited',
        base_branch: '',
        branch: '',
        base_commit: baseCommit,
      })
      await writeTaskFixture(h, task, { repos: [repoRow(task)] })
    }
    const result = await convertTaskFixtures(h)
    expect(result.summary.blocks).toEqual([])
    expect(
      result.sink
        .rows('task_repository_mounts')
        .map((row) => row.branch_state)
        .sort(),
    ).toEqual(['detached', 'none'])
    for (const id of ['detached', 'no-git']) assertTaskProjection(result, id)
  })

  test('local deferred and failed materialization requests retain paths and synthesize the exact DTO', async () => {
    await h.install()
    for (const status of ['pending', 'failed'])
      await writeTaskFixture(
        h,
        taskRow(status, {
          status,
          space_kind: 'local',
          worktree_path: '',
          repo_path: `/local/${status}`,
          base_commit: null,
          branch: `stored/${status}`,
          working_branch: 'different-request-branch',
        }),
      )
    const result = await convertTaskFixtures(h)
    expect(result.summary.blocks).toEqual([])
    expect(result.sink.rows('task_repository_mounts')).toHaveLength(0)
    for (const status of ['pending', 'failed']) {
      const row = result.sink.rows('task_workspaces').find((row) => row.task_id === status)!
      expect(decodeRequestedSourceJson(row.requested_source as string)).toMatchObject({
        kind: 'local',
        repoPath: `/local/${status}`,
        requestedRef: { value: 'main', provenance: 'resolved-base-branch' },
      })
      expect(
        result.sink.rows('tasks').find((row) => row.id === status)!.workspace_root_ref,
      ).toBeNull()
      assertTaskProjection(result, status)
    }
  })

  test('single non-root and multiple repositories preserve ordinals and materialize ancestor closure', async () => {
    await h.install()
    for (const count of [1, 2]) {
      const task = taskRow(`group-${count}`, {
        repo_count: count,
        repo_group_id: 'group',
        repo_group_name: 'Original group',
      })
      await writeTaskFixture(h, task, {
        repos: Array.from({ length: count }, (_, index) =>
          repoRow(task, {
            repo_index: index,
            mount_path: `apps/member-${index}`,
            worktree_dir_name: `apps/member-${index}`,
            worktree_path: `/work/group-${count}/apps/member-${index}`,
          }),
        ),
      })
    }
    const result = await convertTaskFixtures(h)
    expect(result.summary.blocks).toEqual([])
    expect(result.mounts.get('group-1')!.layout).toBe('mounts')
    expect(
      result.sink
        .rows('task_space_nodes')
        .filter((row) => row.task_id === 'group-1')
        .map((row) => row.node_path)
        .sort(),
    ).toEqual(['', 'apps', 'apps/member-0'])
    for (const count of [1, 2]) assertTaskProjection(result, `group-${count}`)
  })

  test('explicit empty directory facts and schema versions survive closure', async () => {
    await h.install()
    const task = taskRow('directories')
    await writeTaskFixture(h, task, {
      repos: [repoRow(task)],
      nodes: ['', 'Empty', 'Empty/Nested'],
    })
    const result = await convertTaskFixtures(h)
    expect(result.summary.blocks).toEqual([])
    expect(
      result.sink
        .rows('task_space_nodes')
        .map((row) => row.node_path)
        .sort(),
    ).toEqual(['', 'Empty', 'Empty/Nested'])
    assertTaskProjection(result, 'directories')
  })

  for (const status of ['running', 'failed', 'canceled', 'done'])
    test(`unexplained mirror conflicts use D4 for ${status} and retain both values`, async () => {
      await h.install()
      const task = taskRow(`conflict-${status}`, { status })
      await writeTaskFixture(h, task, {
        repos: [repoRow(task, { base_branch: 'different', branch: 'other' })],
      })
      const result = await convertTaskFixtures(h)
      if (status === 'running')
        expect(result.summary.blocks.some((block) => block.code === 'v2-task-mount-conflict')).toBe(
          true,
        )
      else {
        expect(result.summary.blocks).toEqual([])
        expect(result.summary.historyOnly.map((row) => row.sourceTable).sort()).toEqual([
          'task_repos',
          'tasks',
        ])
      }
      expect(result.sink.rows('task_repository_mounts')).toHaveLength(0)
      expect(result.mounts.get(`conflict-${status}`)!.mounts).toEqual([])
      expect(
        result.sink
          .rows('execution_legacy_evidence')
          .every((row) => row.provenance_quality === 'unknown'),
      ).toBe(true)
      if (status !== 'running') assertTaskHistoryProjection(result, `conflict-${status}`)
      else expect(result.sink.rows('tasks')).toEqual([])
    })

  for (const field of ['worktree_dir_name', 'worktree_path'])
    test(`in-flight isolation task blocks a ${field} mismatch without replacing its path facts`, async () => {
      await h.install()
      const task = taskRow(`path-${field}`, { status: 'interrupted' })
      await writeTaskFixture(h, task, { repos: [repoRow(task, { [field]: 'wrong-path' })] })
      await h.write('node_runs', [
        {
          id: 'isolating-run',
          task_id: task.id!,
          node_id: 'node',
          status: 'running',
          merge_state: 'isolating',
        },
      ])
      const result = await convertTaskFixtures(h)
      expect(
        result.summary.blocks.some(
          (block) => block.code === 'v2-task-mount-path' && block.missingFields.includes(field),
        ),
      ).toBe(true)
      expect(result.sink.rows('tasks')).toEqual([])
      expect(result.sink.rows('task_repository_mounts')).toEqual([])
    })

  test('unexplained detached base branch is history-only; source repo count drift also remains explicit', async () => {
    await h.install()
    const task = taskRow('bad-base', {
      space_kind: 'internal',
      branch: '',
      base_branch: 'main',
      base_commit: 'sha',
      repo_count: 7,
    })
    await writeTaskFixture(h, task, { repos: [repoRow(task)] })
    const result = await convertTaskFixtures(h)
    expect(result.summary.blocks).toEqual([])
    expect(
      [
        ...result.summary.historyOnly.find((row) => row.sourceTable === 'tasks')!.history!
          .missingFields,
      ].sort(),
    ).toEqual(['base_branch', 'repo_count'])
    assertTaskHistoryProjection(result, 'bad-base')
  })
})
