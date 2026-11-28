// RFC-626 (design/RFC-626-upgrade-no-refusal-minimal-time/design.md §3.2.2, §3.3, §3.4 rows 4
// and 18, §3.6) — the pure decisions the task rule, its lookups and its validators share:
//
//   - which tasks a task-rule row can end (`taskRuleTasksOf`: a still-running child that is set
//     aside also ends the parent waiting on it, fk-probes §4.2 G1), and which task a workspace
//     preparation row points at (it has no `task_id` column);
//   - the one predicate the task lookups skip by and the `v2-task-row-unusable` validator blocks
//     by, so a row whose values used to throw in TASK_FACTS/TASK_MOUNTS (blocks.md table 3 X1–X6,
//     X10) can never reach the rule without facts;
//   - keeping a task whose cache URL cannot be restored by linking the cache by URL hash;
//   - mount ordinal 0 (fk-probes §2.4 A): when ordinal 0 cannot be carried, no mount is;
//   - generation 0 moving to the task rule with exactly the values the run rule wrote.
import { describe, expect, test } from 'bun:test'
import { legacyGenerationZero } from '@/modules/task-execution/infrastructure/migration/task/generation'
import {
  keepUnreadableRepositoryUrl,
  REPOSITORY_URL_KEPT,
} from '@/modules/task-execution/infrastructure/migration/task/repositoryUrls'
import { taskRuleTasksOf } from '@/modules/task-execution/infrastructure/migration/task/settles'
import {
  TASK_ROW_UNUSABLE,
  taskExecutionOf,
  taskRowUsable,
  unusableTaskSourceValue,
} from '@/modules/task-execution/infrastructure/migration/task/usability'
import { preparationTasks } from '@/modules/task-execution/infrastructure/migration/task/validators'
import { assignTaskRepositoryMounts } from '@/modules/task-execution/infrastructure/migration/task/workspace'
import {
  LINKABLE_UNREADABLE_URL_REASONS,
  repositoryUrlFactKey,
  type RepositoryUrlFact,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { deterministicChildId } from '@/platform/persistence/migration/conversion/ids'
import type { LookupReader } from '@/platform/persistence/migration/conversion/lookups'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'
import { sourceRow, taskFacts } from './helpers/rfc395V2/runFixtures'
import { frozenValues } from './helpers/rfc395V2/contentFixtures'

function task(id: string, values: DecodedSourceRow = {}): SourceRow {
  return sourceRow('tasks', frozenValues('tasks', { id, status: 'running', ...values }))
}
function member(table: string, values: DecodedSourceRow): SourceRow {
  return sourceRow(table, frozenValues(table, values))
}
function failed(row: SourceRow, columns: readonly string[]): SourceRow {
  return { ...row, codecFailure: { message: 'fixture', columns } }
}

describe('RFC-626 §3.2.2 tasksOf of the task rule', () => {
  test('a task row is its own task', () => {
    expect(taskRuleTasksOf(task('task'))).toEqual(['task'])
  })

  for (const status of ['pending', 'running', 'awaiting_review', 'awaiting_human', 'interrupted'])
    test(`an unfinished (${status}) child also names its parent`, () => {
      expect(taskRuleTasksOf(task('child', { status, parent_task_id: 'parent' }))).toEqual([
        'child',
        'parent',
      ])
    })

  for (const status of ['done', 'failed', 'canceled'])
    test(`a finished (${status}) child takes nothing with it`, () => {
      expect(taskRuleTasksOf(task('child', { status, parent_task_id: 'parent' }))).toEqual([
        'child',
      ])
    })

  test('an unreadable or unknown status counts as unfinished', () => {
    expect(
      taskRuleTasksOf(
        failed(task('child', { status: 'done', parent_task_id: 'parent' }), ['status']),
      ),
    ).toEqual(['child', 'parent'])
    expect(taskRuleTasksOf(task('child', { status: 'paused', parent_task_id: 'parent' }))).toEqual([
      'child',
      'parent',
    ])
  })

  test('a self-parent, an unreadable parent column and a non-text id name no extra task', () => {
    expect(taskRuleTasksOf(task('cycle', { parent_task_id: 'cycle' }))).toEqual(['cycle'])
    expect(
      taskRuleTasksOf(failed(task('child', { parent_task_id: 'parent' }), ['parent_task_id'])),
    ).toEqual(['child'])
    expect(taskRuleTasksOf({ ...task('x'), values: { ...task('x').values, id: 7 } })).toEqual([])
  })

  test('member rows belong to their task', () => {
    for (const table of ['task_repos', 'task_space_nodes', 'workgroup_task_state'])
      expect(
        taskRuleTasksOf(
          member(table, { task_id: 'task', repo_index: 0, node_path: '', updated_at: 1 }),
        ),
      ).toEqual(['task'])
  })

  test('a workspace preparation points at its admitted task, or at none', () => {
    const preparation = (admitted: string | null) =>
      member('task_workspace_preparations', { id: 'journal', admitted_task_id: admitted })
    expect(preparationTasks(preparation('task'))).toEqual(['task'])
    expect(preparationTasks(preparation(null))).toEqual([])
  })
})

describe('RFC-626 §3.6 unusable task rows (one predicate for lookups and validator)', () => {
  test('a release-shaped row is usable', () => {
    expect(unusableTaskSourceValue(task('task'))).toBeNull()
    expect(taskRowUsable(task('task'))).toBe(true)
    expect(unusableTaskSourceValue(task('task', { workflow_version: 7 }))).toBeNull()
  })

  for (const [column, value] of [
    ['status', 'paused'],
    ['status', null],
    ['space_kind', 'cloud'],
    ['started_at', 9007199254740993n],
    ['started_at', 1.5],
    ['workflow_version', 9007199254740993n],
    ['repo_count', 9007199254740993n],
  ] as const)
    test(`tasks.${column} = ${String(value)} is unusable`, () => {
      const row = task('task', { [column]: value })
      expect(unusableTaskSourceValue(row)).toEqual({ table: 'tasks', column, value })
      expect(taskRowUsable(row)).toBe(false)
    })

  test('task_repos.repo_index above 2^53 is unusable; a negative index is a mount conflict instead', () => {
    expect(
      unusableTaskSourceValue(
        member('task_repos', { task_id: 'task', repo_index: 9007199254740993n }),
      ),
    ).toEqual({ table: 'task_repos', column: 'repo_index', value: 9007199254740993n })
    expect(
      unusableTaskSourceValue(member('task_repos', { task_id: 'task', repo_index: -1 })),
    ).toBeNull()
  })

  test('an undecodable row is not usable either, and other tables are never judged', () => {
    expect(taskRowUsable(failed(task('task'), ['inputs']))).toBe(false)
    expect(unusableTaskSourceValue(member('node_runs', { id: 'run', status: 'weird' }))).toBeNull()
  })

  test('the status classification is the converter one', () => {
    expect(taskExecutionOf('interrupted')).toBe('executable')
    expect(taskExecutionOf('canceled')).toBe('retryable-history')
    expect(taskExecutionOf('done')).toBe('terminal-history')
    expect(taskExecutionOf('paused')).toBeNull()
    expect(TASK_ROW_UNUSABLE).toBe('v2-task-row-unusable')
  })
})

/** A repository URL lookup over fixed facts. */
function urlFacts(
  entries: readonly (readonly [string, RepositoryUrlFact])[],
): LookupReader<RepositoryUrlFact> {
  const facts = new Map(entries)
  return {
    get: (key) => facts.get(key),
    sourceStatus: () => undefined,
    require(key) {
      const value = facts.get(key)
      if (!value) throw new Error(`missing ${key}`)
      return value
    },
    *entries() {
      yield* facts.entries()
    },
    version: { id: 'boot/repository-urls', version: 2, digest: 'fixture' },
  }
}

describe('RFC-626 §3.4 row 4: unreadable cache URL keeps the task', () => {
  const url = 'https://example.test/group/repo.git'
  const blocked = (cachedRepoId: string | null, reason: string | null): RepositoryUrlFact => ({
    state: 'blocked',
    cachedRepoId,
    repoUrl: null,
    rawUrlDigest: 'sha256:raw',
    factIds: ['repository-url:cache'],
    reason,
  })

  test('a blocked fact is linked to the cache with the same URL hash', () => {
    const lookup = urlFacts([
      [
        repositoryUrlFactKey(url),
        {
          state: 'blocked',
          cachedRepoId: 'cache',
          repoUrl: 'https://example.test/group/repo.git',
          rawUrlDigest: 'sha256:raw',
          factIds: ['repository-url:cache'],
          reason: 'v2-boot-url-key-missing',
        },
      ],
    ])
    expect(
      keepUnreadableRepositoryUrl(lookup, blocked(null, 'v2-boot-url-key-missing'), url),
    ).toEqual({
      fact: {
        state: 'proven',
        cachedRepoId: 'cache',
        repoUrl: 'https://example.test/group/repo.git',
        rawUrlDigest: 'sha256:raw',
        factIds: ['repository-url:cache'],
        reason: null,
      },
      unreadable: 'v2-boot-url-key-missing',
    })
    expect(REPOSITORY_URL_KEPT).toBe('v2-boot-url-kept-unreadable')
  })

  // Implementation gate G2-3: only the reasons the cache repository itself is kept for link by
  // hash (the one shared list). A cache row that could not be decoded is set aside, so linking
  // to it would write a `cached_repo_id` that names no row of the new database.
  test('a reason the cache is not kept for keeps the task without linking it', () => {
    for (const reason of ['v2-boot-url-source-codec', 'v2-boot-url-unproven']) {
      const lookup = urlFacts([
        [
          repositoryUrlFactKey(url),
          {
            state: 'blocked',
            cachedRepoId: 'cache',
            repoUrl: 'https://example.test/group/repo.git',
            rawUrlDigest: 'sha256:raw',
            factIds: ['repository-url:cache'],
            reason,
          },
        ],
      ])
      expect(LINKABLE_UNREADABLE_URL_REASONS).not.toContain(reason)
      expect(keepUnreadableRepositoryUrl(lookup, blocked(null, reason), url)).toEqual({
        fact: {
          state: 'proven',
          cachedRepoId: null,
          repoUrl: 'https://example.test/group/repo.git',
          rawUrlDigest: 'sha256:raw',
          factIds: ['repository-url:cache'],
          reason: null,
        },
        unreadable: reason,
      })
    }
    // Every reason of the shared list still links.
    for (const reason of LINKABLE_UNREADABLE_URL_REASONS) {
      const lookup = urlFacts([
        [repositoryUrlFactKey(url), { ...blocked('cache', reason), repoUrl: url }],
      ])
      expect(
        keepUnreadableRepositoryUrl(lookup, blocked(null, reason), url).fact.cachedRepoId,
      ).toBe('cache')
    }
  })

  test('with no single cache for the hash the column stays empty', () => {
    const lookup = urlFacts([
      [
        repositoryUrlFactKey(url),
        { ...blocked(null, 'v2-boot-url-reference-conflict'), repoUrl: url },
      ],
    ])
    const kept = keepUnreadableRepositoryUrl(lookup, blocked(null, null), url)
    expect(kept.fact).toMatchObject({ state: 'proven', cachedRepoId: null, repoUrl: url })
    expect(kept.unreadable).toBe('v2-boot-url-unproven')
  })

  test('a fact that is not blocked passes through unchanged', () => {
    const proven: RepositoryUrlFact = { ...blocked('cache', null), state: 'proven' }
    expect(keepUnreadableRepositoryUrl(urlFacts([]), proven, url)).toEqual({
      fact: proven,
      unreadable: null,
    })
  })
})

describe('RFC-626 mount ordinal 0 (fk-probes §2.4 A)', () => {
  const root = '/work/multi'
  const multi = task('multi', {
    status: 'done',
    worktree_path: root,
    repo_count: 2,
    space_kind: 'remote',
    branch: 'task/multi',
    base_branch: 'main',
    base_commit: 'sha',
    repo_path: '/cache/repository',
    repo_url: null,
    cached_repo_id: null,
  })
  const repo = (index: number, values: DecodedSourceRow = {}) =>
    member('task_repos', {
      task_id: 'multi',
      repo_index: index,
      repo_path: '/cache/repository',
      repo_url: null,
      cached_repo_id: null,
      base_branch: 'main',
      branch: 'task/multi',
      base_commit: 'sha',
      working_branch: null,
      mount_path: `pkg-${index}`,
      worktree_dir_name: `pkg-${index}`,
      worktree_path: `${root}/pkg-${index}`,
      ...values,
    })
  const assign = (repos: readonly SourceRow[]) =>
    assignTaskRepositoryMounts(multi, repos, taskFacts('multi', 'done', { spaceKind: 'remote' }), {
      child: deterministicChildId,
    })

  test('both mounts are carried when ordinal 0 is', () => {
    const assigned = assign([repo(0), repo(1)])
    expect(assigned.mounts.map((mount) => mount.ordinal)).toEqual([0, 1])
    expect(assigned.layout).toBe('mounts')
  })

  test('when ordinal 0 conflicts, the other mounts are dropped too and each says why', () => {
    const assigned = assign([repo(0, { worktree_path: 'wrong' }), repo(1), repo(2)])
    expect(assigned.mounts).toEqual([])
    expect(assigned.repoKeys.size).toBe(0)
    expect(assigned.layout).toBe('none')
    expect(
      assigned.decisions
        .filter((decision) => decision.scenario === 'first-mount-unavailable')
        .map((decision) => [decision.code, decision.ordinal, decision.blocking]),
    ).toEqual([
      ['v2-task-mount-first-mount-unavailable', 1, false],
      ['v2-task-mount-first-mount-unavailable', 2, false],
    ])
    // The conflict on ordinal 0 itself is still the task issue it always was.
    expect(
      assigned.decisions.some(
        (decision) => decision.scenario === 'unexplained-conflict' && decision.ordinal === 0,
      ),
    ).toBe(true)
  })

  test('without any ordinal 0 no mount is carried', () => {
    const assigned = assign([repo(1), repo(2)])
    expect(assigned.mounts).toEqual([])
    expect(
      assigned.decisions.filter((decision) => decision.scenario === 'first-mount-unavailable'),
    ).toHaveLength(1)
  })
})

describe('RFC-626 §3.3 generation 0 from the task rule', () => {
  // The run rule wrote exactly these columns (run/generations.ts before RFC-626; the expectation
  // in rfc395-v2-run-sequence.test.ts:139-147 spells the same row).
  test('the values are the ones the run rule wrote, field for field', () => {
    expect(legacyGenerationZero(taskFacts('c', 'failed', { startedAt: 42 }))).toEqual({
      task_id: 'c',
      generation_seq: 0,
      cause: 'legacy-epoch1',
      previous_generation_seq: null,
      operation_ref: null,
      created_at: 42,
    })
  })
})
