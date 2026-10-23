// RFC-359 AC-1 launch parity (tests/helpers/taskRowParity.ts). The scheduler takes
// a launched task over asynchronously, so a row read right after launch may be
// pending (revision 1, no running stretch) on one engine and already running
// (revision 2, running since T) on the other. CI 38608703903 shard 8 compared
// exactly that pair and failed; the takeover cells leave the equality surface
// together with `status`, and each lane must still be self-consistent.
import { expect, test } from 'bun:test'
import { comparableTaskRow, earlyLifecycleViolation } from './helpers/taskRowParity'

const base = { id: 't1', name: 'scheduled', mode: 'standard', runningMs: 0 }
const pending = { ...base, status: 'pending', runningSince: null, lifecycleEventRevision: 1 }
const running = {
  ...base,
  id: 't2',
  status: 'running',
  runningSince: 1_792_000_871_108,
  lifecycleEventRevision: 2,
}

test('a pending lane and a lane the scheduler already took over compare equal', () => {
  expect(comparableTaskRow(running)).toEqual(comparableTaskRow(pending))
  expect(earlyLifecycleViolation(pending)).toBeNull()
  expect(earlyLifecycleViolation(running)).toBeNull()
  // A launch that already finished is consistent too: no running stretch, revision moved on.
  expect(
    earlyLifecycleViolation({
      ...base,
      status: 'done',
      runningSince: null,
      lifecycleEventRevision: 3,
    }),
  ).toBeNull()
})

test('the removed lifecycle cells are still checked for consistency', () => {
  expect(earlyLifecycleViolation({ ...running, runningSince: null })).toContain(
    '只有 running 段才有起点',
  )
  expect(earlyLifecycleViolation({ ...pending, runningSince: 1 })).toContain(
    '只有 running 段才有起点',
  )
  expect(earlyLifecycleViolation({ ...pending, lifecycleEventRevision: 2 })).toContain(
    'pending 尚未发生转移',
  )
  expect(
    earlyLifecycleViolation({
      ...base,
      status: 'failed',
      runningSince: null,
      lifecycleEventRevision: 1,
    }),
  ).toContain('离开 pending 必有转移')
  // Everything else on the row stays on the equality surface.
  expect(comparableTaskRow({ ...running, mode: 'scratch' })).not.toEqual(comparableTaskRow(pending))
})

// RFC-395 II-a：目标模型投影内嵌的逐仓 `repos` 只摘逐次必然不同的工作区格，其余逐仓字段仍比较。
test('nested repos drop only per-run workspace cells', () => {
  const repo = { mountPath: '', readonly: false, repoIndex: 0, baseBranch: 'main' }
  const laneA = {
    ...pending,
    repos: [
      { ...repo, taskId: 'a', repoPath: '/a', worktreePath: '/a', baseCommit: '1', branch: 'x' },
    ],
  }
  const laneB = {
    ...pending,
    repos: [
      { ...repo, taskId: 'b', repoPath: '/b', worktreePath: '/b', baseCommit: '2', branch: 'y' },
    ],
  }
  expect(comparableTaskRow(laneA)).toEqual(comparableTaskRow(laneB))
  expect(
    comparableTaskRow({ ...laneA, repos: [{ ...laneA.repos[0], readonly: true }] }),
  ).not.toEqual(comparableTaskRow(laneB))
})
