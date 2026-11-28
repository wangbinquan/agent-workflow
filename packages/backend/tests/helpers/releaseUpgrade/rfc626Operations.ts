// RFC-626 T14 (design §7「升级后可启动」, proposal §6 items 1-3a): the representative operation a
// user does on each upgraded seed through the current source's daemon, over real HTTP.
import { DAEMON_RESTART_ERROR_SUMMARY } from '@agent-workflow/shared'
import { equal, invariant, type Row } from './data'
import { approveUntilDone, items, requestRefused, type ResolutionCase } from './rfc626'

const ENDED_SUMMARY = 'ended by upgrade'
const CASCADE_SUMMARY = 'canceled by parent task'

async function task(input: ResolutionCase, id: string): Promise<Row> {
  return (await input.daemon.request(`/api/tasks/${id}`)) as Row
}

/** Ended tasks open as canceled with their reason; their history stays readable. */
async function openEndedTasks(input: ResolutionCase): Promise<void> {
  const scenario = input.oracle.scenarios[input.seed.scenario]!
  for (const settlement of scenario.settlements) {
    const opened = await task(input, settlement.taskId)
    equal(
      [opened.status, opened.errorSummary],
      ['canceled', settlement.cause === 'parent-cascade' ? CASCADE_SUMMARY : ENDED_SUMMARY],
      `ended task ${settlement.taskId} opens as canceled with its reason (§3.2.4)`,
    )
    items(await input.daemon.request(`/api/tasks/${settlement.taskId}/node-runs`))
  }
}

export async function settledTasksOperation(input: ResolutionCase): Promise<void> {
  await openEndedTasks(input)
  const restart = await task(input, '01K3986260ST00000000000012')
  equal(
    [restart.status, restart.errorSummary],
    ['interrupted', DAEMON_RESTART_ERROR_SUMMARY],
    'a complete interrupted task is still an auto-resume candidate (§3.2.4)',
  )
  const reviews = items(await input.daemon.request('/api/reviews')).filter(
    (review) => review.awaitingReview,
  )
  invariant(
    !reviews.some((review) => review.taskId === '01K3986260ST00000000000004'),
    'the ended review is no longer waiting (proposal §6 item 1)',
  )
  invariant(
    reviews.some((review) => review.taskId === '01K3986260ST00000000000011'),
    `the complete review still waits after the upgrade: ${JSON.stringify(reviews)}`,
  )
  // proposal §6 item 1: a review that was waiting before the upgrade can be approved and finished.
  await approveUntilDone(input.daemon, '01K3986260ST00000000000011')
}

export async function contentOperation(input: ResolutionCase): Promise<void> {
  await openEndedTasks(input)
  equal(
    (await task(input, '01K3986260CN00000000000002')).status,
    'done',
    'the finished task whose document file is gone still opens',
  )
  equal(
    (await task(input, '01K3986260CN00000000000003')).status,
    'done',
    'the finished task whose document was edited on disk still opens',
  )
}

export async function skillsOperation(input: ResolutionCase): Promise<void> {
  const listed = async () =>
    items(await input.daemon.request('/api/skills')).map((skill) => skill.id)
  // Its version snapshot is gone: nothing can restore it, so it stays quarantined.
  const quarantined = '01K3986260SK00000000000002'
  invariant(
    !(await listed()).includes(quarantined),
    `quarantined skill ${quarantined} is not listed (proposal §5 A3)`,
  )
  const refused = await requestRefused(input.daemon, `/api/skills/${quarantined}`)
  invariant(
    refused.includes(': 404 '),
    `quarantined skill ${quarantined} reads as absent: ${refused}`,
  )
  // Only its live directory was gone. The upgrade quarantines it (oracle, §3.4 row 3a); the new
  // version's own start copies the live files back from the version snapshot and verifies it
  // again after it is ready — "restored once its directory is complete" (proposal §5 A3).
  const restored = '01K3986260SK00000000000001'
  const restoredBy = Date.now() + 60_000
  while (!(await listed()).includes(restored)) {
    invariant(Date.now() < restoredBy, `skill ${restored} was not restored from its snapshot`)
    await new Promise((settle) => setTimeout(settle, 500))
  }
  await input.daemon.request(`/api/skills/${restored}`)
  const workflow = (await input.daemon.request('/api/workflows/01K3986260SK00000000000021')) as Row
  const body = {
    workflowId: workflow.id,
    expectedWorkflowVersion: workflow.version,
    name: 'RFC-626 launch with a quarantined skill',
    scratch: true,
    inputs: {},
  }
  // proposal §5 A3: launching the agent reports the quarantined skill. The launch either refuses
  // the request or creates a task that fails for that reason; both name the skill.
  let created: Row | undefined
  let refusal = ''
  try {
    created = (await input.daemon.request('/api/tasks', 'POST', body)) as Row
  } catch (error) {
    refusal = String(error)
  }
  if (!created) {
    invariant(refusal.includes('skill-quarantined'), `launch refusal names the skill: ${refusal}`)
    return
  }
  const deadline = Date.now() + 60_000
  for (;;) {
    const current = await task(input, String(created.id))
    if (current.status === 'failed') {
      invariant(
        JSON.stringify(current).includes('quarantined'),
        `launched task fails for the quarantined skill: ${JSON.stringify(current)}`,
      )
      return
    }
    invariant(current.status !== 'done', 'a task with a quarantined skill must not run to done')
    invariant(
      Date.now() < deadline,
      `quarantined-skill task did not fail: ${JSON.stringify(current)}`,
    )
    await new Promise((settle) => setTimeout(settle, 500))
  }
}

export async function setAsideOperation(input: ResolutionCase): Promise<void> {
  const user = (await input.daemon.request('/api/users/01K3986260SA00000000000002')) as Row
  equal(user.id, '01K3986260SA00000000000002', 'the user with a removed creator is kept')
  equal(
    (await task(input, '01K3980000085154084C742759')).status,
    'done',
    'the task whose collaborator was added by a removed user still opens',
  )
}

export async function scheduleOperation(input: ResolutionCase): Promise<void> {
  const listed = items(await input.daemon.request('/api/scheduled-tasks')).find(
    (schedule) => schedule.id === '01K3986260SC00000000000001',
  )
  invariant(listed, 'the schedule with a truncated payload is listed (proposal §5 A8)')
  const schedule = (await input.daemon.request(
    '/api/scheduled-tasks/01K3986260SC00000000000001',
  )) as Row
  equal([schedule.enabled, schedule.nextRunAt], [false, null], 'the schedule is disabled')
  invariant(
    typeof schedule.lastError === 'string' && schedule.lastError.length > 0,
    `the schedule shows why it was disabled: ${JSON.stringify(schedule)}`,
  )
}

export async function cachedReposOperation(input: ResolutionCase): Promise<void> {
  const listed = items(await input.daemon.request('/api/cached-repos')).map((repo) => repo.id)
  for (const id of ['01K3986260CR00000000000001', '01K3986260CR00000000000002'])
    invariant(listed.includes(id), `repository ${id} with an unreadable address is listed`)
  // §3.3「升级后的服务必须能启动」(备份准备): the cleared escrow no longer fails every backup.
  await input.daemon.request('/api/backup', 'POST')
}

export async function codeHistoryOperation(input: ResolutionCase): Promise<void> {
  // The daemon became ready, so the code-history query index initialized from the packages
  // (design §9.8 T0-7); the base workflow still reads.
  await input.daemon.request('/api/workflows/01K398000045B34F16DB605A06')
}

export async function multiRepoMountOperation(input: ResolutionCase): Promise<void> {
  equal(
    (await task(input, '01K3986260MM00000000000001')).status,
    'done',
    'the finished two-repository task opens',
  )
}
