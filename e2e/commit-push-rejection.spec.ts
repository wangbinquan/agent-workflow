// RFC-319 B34 —— REPO-18：推送被拒之后的两条出路。
//
// 自动提交推送是一条**用户不在场**的链路：任务跑完、框架自己提交、自己推。
// 推被拒时只有两种可接受的结局，而两种都必须保住那次提交：
//
//   * 非快进（别人先推了）⇒ 取回、合并、再推。**绝不能用力推覆盖**——那会
//     悄无声息地删掉别人刚推上去的提交，而任务照样报成功；
//   * 认证被拒 ⇒ 不再重试，把改动**留在本地提交里**并如实报出降级结局。
//     这里最坏的失效不是「没推上去」，而是「改动连本地提交都没留下」：
//     那次任务的产出就此消失，工作树随后会被回收。
//
// 判据因此两边都读：node_run 上报的结局 + **远端仓库里真实的树**。
// 只断言 `pushOutcome` 是不够的——力推同样能让它显示 `pushed`。
//
// 判据取自源码单一事实源：
//   services/commitPush.ts:115-132              stderr → auth / non-fast-forward 分类
//   services/commitPushRunner.ts:563-579        auth ⇒ commit-local-auth，不重试
//   services/commitPushRunner.ts:592-625        非快进 ⇒ fetch + merge 后重推

import { expect, test } from '@playwright/test'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initBareGitRepo, initGitRepo, repoRemoteUrl, runGit } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

let daemon: DaemonHandle
let agentId: string
let workflowId: string
const cleanups: string[] = []

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

interface CommitRow {
  nodeId: string
  commitPush: {
    pushOutcome: string
    commitSha: string | null
    repoBranch: string
    repairAttempts?: number | null
  } | null
}

test.beforeAll(async () => {
  daemon = await startDaemon({ stubMode: 'commit' })
  agentId = (
    await api<{ id: string }>('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-repo18-writer',
        description: 'RFC-319 REPO-18 writer',
        outputs: ['answer'],
        readonly: false,
        bodyMd: '',
      }),
    })
  ).id
  workflowId = (
    await api<{ id: string }>('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-repo18-wf',
        description: 'RFC-319 REPO-18',
        definition: {
          $schema_version: 3,
          inputs: [],
          nodes: [
            {
              id: 'w',
              kind: 'agent-single',
              agentId,
              agentName: 'rfc319-repo18-writer',
              promptTemplate: 'Do the work.',
              position: { x: 0, y: 0 },
            },
          ],
          edges: [],
        },
      }),
    })
  ).id
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  for (const path of cleanups) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

/** 一个带 main 的裸远端 + 一份用来播种的工作副本。 */
function seedRemote(label: string): string {
  const remote = mkdtempSync(join(tmpdir(), `aw-rfc319-repo18-${label}-remote-`))
  const work = mkdtempSync(join(tmpdir(), `aw-rfc319-repo18-${label}-work-`))
  cleanups.push(remote, work)
  initBareGitRepo(remote)
  writeFileSync(join(work, 'README.md'), 'seed\n')
  initGitRepo(work, { email: 'e2e@test.local', message: 'init' })
  runGit(['remote', 'add', 'origin', remote], work)
  runGit(['push', '-q', '-u', 'origin', 'main'], work)
  return remote
}

async function launchTask(remote: string, workingBranch: string): Promise<string> {
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-repo18-${workingBranch}`,
      workflowId,
      repoUrl: repoRemoteUrl(remote),
      ref: 'main',
      workingBranch,
      autoCommitPush: true,
      inputs: {},
    }),
  })
  return task.id
}

async function awaitCommitRow(taskId: string): Promise<CommitRow> {
  await expect
    .poll(async () => (await api<{ status: string }>(`/api/tasks/${taskId}`)).status, {
      timeout: 180_000,
    })
    .toBe('done')
  const { runs } = await api<{ runs: CommitRow[] }>(`/api/tasks/${taskId}/node-runs`)
  const row = runs.find((run) => run.nodeId.startsWith('__commit_push__') && run.commitPush != null)
  expect(row, '没有生成 commit&push 的合成节点行 ⇒ 下面的判据无从谈起').toBeTruthy()
  return row as CommitRow
}

async function runTask(remote: string, workingBranch: string): Promise<CommitRow> {
  return awaitCommitRow(await launchTask(remote, workingBranch))
}

const filesOnBranch = (remote: string, branch: string): string[] =>
  runGit(['ls-tree', '-r', '--name-only', branch], remote)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .sort()

test('非快进：取回合并后重推成功，而且没把别人刚推上去的提交吞掉', async () => {
  const remote = seedRemote('nff')
  const branch = 'rfc319-nff'

  // 「别人」的提交先在一份独立克隆里备好，**此刻不推**——分支若在任务启动时就
  // 存在，任务会直接基于它建工作树，压根不会出现非快进（实测：先建好分支再跑，
  // `repairAttempts` 是 0、一次就推上去了）。
  const other = mkdtempSync(join(tmpdir(), 'aw-rfc319-repo18-other-'))
  cleanups.push(other)
  runGit(['clone', '-q', remote, other])
  runGit(['config', 'user.email', 'other@test.local'], other)
  runGit(['config', 'user.name', 'other'], other)
  writeFileSync(join(other, 'other.txt'), 'work from someone else\n')
  runGit(['add', 'other.txt'], other)
  runGit(['commit', '-q', '-m', 'other: prior work'], other)

  // 把「推之前别人先推了」这件事做成**确定性**的：服务端钩子在任务的第一次推送
  // 上阻塞，测试侧趁这个窗口把别人那笔真的推到分支上，然后放行钩子、由它以
  // 非快进回绝。于是后面的「取回 → 合并 → 重推」合的是**真的**别人的提交，
  // 而不是对着没动过的远端空跑一遍。
  //
  // 为什么不让 git 自己产生这条拒绝：那需要「克隆之后、推送之前」这个几秒宽的
  // 窗口，是竞态。也不能由钩子去 `update-ref` 把分支挪过去——pre-receive 跑在
  // quarantine 环境里，git 明确禁止改 ref（实测 `ref updates forbidden inside
  // quarantine environment`）。注入的只有**回绝文案**，而那正是
  // `classifyPushFailure` 唯一消费的输入。
  const hook = join(remote, 'hooks', 'pre-receive')
  writeFileSync(
    hook,
    [
      '#!/bin/sh',
      'd=$(git rev-parse --git-dir)',
      '# 放行标记一旦存在，之后的推送（含测试自己那次）一律直接通过。',
      'if [ -f "$d/rfc319-allow" ]; then exit 0; fi',
      ': > "$d/rfc319-arrived"',
      'i=0',
      'while [ ! -f "$d/rfc319-advanced" ] && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i+1)); done',
      'echo "! [rejected] Updates were rejected because the tip of your current branch is behind" >&2',
      'exit 1',
      '',
    ].join('\n'),
  )
  chmodSync(hook, 0o755)

  const taskId = await launchTask(remote, branch)

  // 等任务的第一次推送到达并被钩子扣住。
  await expect
    .poll(() => existsSync(join(remote, 'rfc319-arrived')), { timeout: 120_000 })
    .toBe(true)
  writeFileSync(join(remote, 'rfc319-allow'), '')
  runGit(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], other)
  writeFileSync(join(remote, 'rfc319-advanced'), '')

  const row = await awaitCommitRow(taskId)
  expect(
    row.commitPush?.pushOutcome,
    '非快进本该由「取回 + 合并 + 重推」修好——报成本地降级说明这条修复路径没走通',
  ).toBe('pushed')
  expect(
    row.commitPush?.repairAttempts ?? 0,
    '一次都没修就推上去了 ⇒ 这次运行根本没触发非快进，判据是空洞的',
  ).toBeGreaterThanOrEqual(1)

  const files = filesOnBranch(remote, branch)
  expect(
    files,
    '别人那笔提交的文件不见了 ⇒ 这次推送是把远端**覆盖**掉的，而任务报的是成功',
  ).toContain('other.txt')
  expect(files, '任务自己的改动没推上去').toContain('e2e-change.txt')
})

test('认证被拒：不重试、改动留在本地提交里，并如实报出降级结局', async () => {
  const remote = seedRemote('auth')
  const branch = 'rfc319-auth'
  // 服务端钩子拒收，stderr 落在 classifyPushFailure 的 auth 分支上。
  const hook = join(remote, 'hooks', 'pre-receive')
  writeFileSync(hook, '#!/bin/sh\necho "Permission denied (rfc319 fixture)" >&2\nexit 1\n')
  chmodSync(hook, 0o755)

  const row = await runTask(remote, branch)
  expect(row.commitPush?.pushOutcome, '认证被拒时反复重试只会把日志刷满，且每次都注定失败').toBe(
    'commit-local-auth',
  )
  expect(
    row.commitPush?.commitSha,
    '推不上去时连本地提交都没留下 ⇒ 那次任务的产出彻底消失，工作树随后会被回收',
  ).toMatch(/^[a-f0-9]{40}$/)

  const remoteBranches = runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], remote)
  expect(
    remoteBranches.split('\n').map((line) => line.trim()),
    '钩子拒收了却还是有分支落到远端 ⇒ 拒收没生效，这条用例是空洞的',
  ).not.toContain(branch)
})
