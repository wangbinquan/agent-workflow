// CI-1: epoch-2 parity may normalize per-launch identities, never product facts.
import { expect, test } from 'bun:test'
import { comparableEpoch2TaskRow, normalizeEpoch2TaskFacts } from './fixtures/rfc395TaskRowParity'

function launch(id: string) {
  const config = {
    workgroupId: `wg-${id}`,
    workgroupName: `group-${id}`,
    leaderMemberId: `leader-${id}`,
    goal: 'ship',
    mode: 'leader_worker',
  }
  return {
    id,
    subjectKind: 'workgroup',
    sourceId: config.workgroupId,
    workgroupId: config.workgroupId,
    workgroupConfigJson: JSON.stringify(config),
    workgroupLaunchConfigJson: JSON.stringify(config),
    repoPath: `/scratch/${id}`,
    worktreePath: `/scratch/${id}`,
    workspaceRootRef: `/scratch/${id}`,
    baseCommit: `commit-${id}`,
    requestedSource: JSON.stringify({
      codec: 'requestedSource@v2',
      kind: 'scratch',
      repoPath: `/scratch/${id}`,
      legacyBaseCommit: `commit-${id}`,
      requestedRef: { value: 'main', provenance: 'resolved-base-branch' },
    }),
    repos: [{ taskId: id, repoKey: `${id}:mount:`, mountPath: '', readonly: false }],
  }
}
const volatile = ['workgroupId', 'workgroupConfigJson']

test('new destinations preserve the old per-launch exclusions and all remaining facts', () => {
  const a = launch('one'),
    b = launch('two')
  expect(comparableEpoch2TaskRow(a, volatile)).toEqual(comparableEpoch2TaskRow(b, volatile))
  for (const changed of [
    { ...b, newPersistedColumn: 'must compare' },
    { ...b, repos: [{ ...b.repos[0]!, readonly: true }] },
    {
      ...b,
      requestedSource: JSON.stringify({ ...JSON.parse(b.requestedSource), kind: 'repository' }),
    },
    {
      ...b,
      workgroupLaunchConfigJson: JSON.stringify({
        ...JSON.parse(b.workgroupLaunchConfigJson),
        goal: 'different',
      }),
    },
  ])
    expect(comparableEpoch2TaskRow(a, volatile)).not.toEqual(
      comparableEpoch2TaskRow(changed, volatile),
    )
})

test('a wrong persisted reference cannot be hidden as a volatile value', () => {
  const row = launch('one')
  for (const changed of [
    { ...row, sourceId: 'wrong-resource' },
    { ...row, workspaceRootRef: '/wrong-workspace' },
    { ...row, repos: [{ ...row.repos[0]!, repoKey: 'wrong-task:mount:' }] },
    {
      ...row,
      requestedSource: JSON.stringify({
        ...JSON.parse(row.requestedSource),
        legacyBaseCommit: 'wrong-commit',
      }),
    },
  ])
    expect(() => comparableEpoch2TaskRow(changed, volatile)).toThrow()
})

test('fixed child identities and non-excluded commits remain comparable', () => {
  const row = launch('child')
  const normalized = normalizeEpoch2TaskFacts(row, new Set(['repoPath', 'worktreePath', 'branch']))
  expect(normalized.sourceId).toBe(row.sourceId)
  expect(normalized.repos).toEqual(row.repos)
  expect(JSON.parse(String(normalized.requestedSource))).toMatchObject({
    legacyBaseCommit: row.baseCommit,
  })
  expect(normalized.workgroupLaunchConfigJson).toBe(row.workgroupLaunchConfigJson)
})
