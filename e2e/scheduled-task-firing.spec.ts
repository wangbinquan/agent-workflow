// RFC-319 B18 —— 定时任务到点自动触发（EVENT-42）。
//
// 「到点自己开工」是这个域**唯一**真正被用户依赖的行为。它有一整条链：
//   轮询选出 due 行 → CAS 把 `next_run_at` 推到下一个槽（认领）→ 启动任务
//   → 把结果写回展示字段（lastStatus / lastRunAt / lastTaskId）。
// 链上任何一环断掉，症状都是**没有症状**：界面上那条规则还在、还写着「已启用」，
// 只是再也不会自己跑了。而没人会盯着一个本该无人值守的东西。
//
// 判据取自源码单一事实源：
//   `pollAndClaim`（services/scheduledTaskScheduler.ts:40）—— 认领是一次 CAS：
//     `WHERE id=? AND next_run_at=<读到的那个值> AND enabled=1`，被别的 tick
//     抢走就丢弃（多实例下不会重复开工）。
//   `recordSuccess`（同文件 :93）—— lastRunAt 写在 firedAt 守卫下。
//   tick 周期 `SCHEDULE_TICK_MS = 30_000`，interval 规格下限是 1 分钟，
//   所以这条用例必须**真等**，等待预算按最坏情况 = 60s 槽 + 30s tick。
//
// **为什么打 `@nightly`（风险是 P1，档位却在夜跑）**：实测墙钟 1.5 分钟，而它
// 慢在判据本身——「到点自己跑」这件事的观察窗口由真实 tick 周期与规格下限决定，
// 没有任何测试技巧能把它缩短，除非改生产代码给 tick 加旋钮，而本 RFC 是零生产
// 改动。把它放进 PR 腿等于给每次提交加 90 秒，且换不来更早的反馈（这条链一天
// 之内不会被改动多次）。分档设计存在的理由正是这种「高风险但慢」的用例。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

// 最坏情况 60s（interval 下限）+ 30s（tick）+ 启动与执行余量。
test.setTimeout(240_000)

let daemon: DaemonHandle
let repoDir: string

test.beforeAll(async () => {
  daemon = await startDaemon()
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-sched-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 scheduled fixture\n', 'utf-8')
  initGitRepo(repoDir)
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  try {
    rmSync(repoDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

async function req(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function jsonOf<T>(res: Response, what: string): Promise<T> {
  const body = await res.text()
  expect(res.ok, `${what}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

interface ScheduledTaskRow {
  id: string
  enabled: boolean
  nextRunAt: number | null
  lastRunAt: number | null
  lastStatus: string | null
  lastTaskId: string | null
  lastError: string | null
}

test('RFC-319 EVENT-42: an enabled schedule fires by itself — the claim advances the next slot and the launch is recorded on the row @nightly', async () => {
  const workflow = await jsonOf<{ id: string }>(
    await req('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-sched-wf-${Date.now().toString(36)}`,
        description: 'RFC-319 scheduled firing fixture',
        definition: {
          $schema_version: 3,
          inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
            {
              id: 'out_1',
              kind: 'output',
              ports: [{ name: 'echo', bind: { nodeId: 'in_1', portName: 'topic' } }],
              position: { x: 320, y: 0 },
            },
          ],
          edges: [
            {
              id: 'e_in_out',
              source: { nodeId: 'in_1', portName: 'topic' },
              target: { nodeId: 'out_1', portName: 'echo' },
            },
          ],
        },
      }),
    }),
    'seed workflow',
  )

  const created = await jsonOf<ScheduledTaskRow>(
    await req('/api/scheduled-tasks', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-sched-${Date.now().toString(36)}`,
        launchKind: 'workflow',
        scheduleSpec: { kind: 'interval', every: 1, unit: 'minutes', timezone: 'UTC' },
        enabled: true,
        launchPayload: {
          workflowId: workflow.id,
          name: 'rfc319-scheduled-run',
          repoUrl: repoRemoteUrl(repoDir),
          ref: 'main',
          inputs: { topic: 'scheduled' },
        },
      }),
    }),
    'create scheduled task',
  )
  expect(
    created.nextRunAt,
    '新建的定时任务没有排下一次运行时间 ⇒ 它永远不会被 pollAndClaim 选中',
  ).not.toBeNull()
  const firstSlot = created.nextRunAt!

  const read = async (): Promise<ScheduledTaskRow> =>
    jsonOf<ScheduledTaskRow>(await req(`/api/scheduled-tasks/${created.id}`), 'read scheduled task')

  // 等它自己跑。判据是 lastTaskId 被写上——那是「真的启动了一个任务」的唯一凭据，
  // 只看 lastStatus 会把「认领了但启动失败」也当成成功。
  const deadline = Date.now() + 170_000
  let row = created
  while (Date.now() < deadline) {
    row = await read()
    if (row.lastTaskId !== null) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  expect(
    row.lastTaskId,
    `到点了却没有自己开工（lastStatus=${row.lastStatus} lastError=${row.lastError}）⇒ ` +
      '界面上这条规则还写着「已启用」，只是再也不会跑了，而无人值守的东西没人会去盯',
  ).not.toBeNull()
  expect(row.lastStatus, `触发被记成 ${row.lastStatus}`).toBe('launched')
  expect(row.lastRunAt, 'lastRunAt 没写 ⇒ 界面上「上次运行」永远空着').not.toBeNull()

  // 认领必须把下一个槽**向前推**。不推的话同一行会被每个 tick 重复选中，
  // 变成一个每 30 秒开一次任务的循环——这正是 CAS 认领存在的理由。
  expect(
    row.nextRunAt,
    '触发之后下一次运行时间没有前移 ⇒ 同一行会被每个 tick 反复认领，无限开工',
  ).toBeGreaterThan(firstSlot)

  // 真的产生了一个任务，而且就是这个工作流的。
  const task = await jsonOf<{ id: string; workflowId?: string; status: string }>(
    await req(`/api/tasks/${row.lastTaskId}`),
    'read the launched task',
  )
  expect(task.id).toBe(row.lastTaskId)

  // 规则本身仍处于启用态：一次成功的触发不该把它关掉。
  expect(row.enabled, '触发一次之后规则被关掉了 ⇒ 定时变成了一次性').toBe(true)
})
