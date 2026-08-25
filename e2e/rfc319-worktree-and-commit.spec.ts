// RFC-319 —— 任务工作树、变更浏览与自动提交。
//
// 这一域的共同点是「产出物在磁盘上」：任务工作树是 agent 真正写字的地方，
// 变更浏览把那棵树读回给人看，自动提交再把它推到远端。三条链路的失效形态
// 都不体面——凭据被原样渲染出来、取消之后工作树被顺手删掉、恢复时没有回滚到
// 记录的基线、排除规则形同虚设——而且**全部**只有内存 DB 单测守着。
//
// 判据取自源码单一事实源（读的时候按 file:line 复核，勿凭记忆）：
//   packages/shared/src/git-url.ts:redactGitUrl              userinfo → `***@`
//   packages/backend/src/services/task.ts:6700               rowToTask 投影脱敏
//   packages/frontend/src/routes/tasks.detail.tsx:1121       详情页再脱敏一次
//   packages/backend/src/services/nodeRollback.ts:99-190     pre_snapshot 回滚
//   packages/backend/src/util/git.ts:2434-2456               rollbackToSnapshot
//   packages/backend/src/services/scheduler.ts:2201-2203     `status --porcelain` 空 ⇒ 不生成 commit&push 行
//   packages/backend/src/services/commitPushRunner.ts:346-353 排除后为空 ⇒ skipped-excluded
//   packages/backend/src/modules/source-control/application/repositoryCommit.ts:105-133
//                                                           被排除的路径从 index 里 reset 掉
//   packages/backend/src/routes/worktree-files.ts:60-160     成员 ACL / 越界 / MIME
//   packages/backend/src/services/worktreeFiles.ts:82-216    目录列举 + 2 MiB 上限
//
// 两条与账本措辞不符、按源码实际写的地方（详见交付报告 ⑤）：
//   * REPO-19「skipped-empty」在守护进程里**不可达**：scheduler.ts:2201 先用
//     `git status --porcelain` 判空并 `continue`，根本不会生成 commit&push 行。
//     用例锁的是这条真实可观察语义（不生成行 + 远端不多分支）。
//   * REPO-38c 的 `pre_snapshot` 今天**没有任何生产写点**（RFC-130 把 stash
//     快照删了，`gitStashSnapshot` 零生产调用方），但回滚代码仍在 resume 路径上
//     执行（design.md D10 保留为纵深防御）。用例把快照按真实形态种进去，再走
//     公共 resume 接口，验证那段防御真的把工作树带回快照那一刻。

import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  initBareGitRepo,
  initGitRepo,
  querySqlite,
  repoRemoteUrl,
  runGit,
  runSqlite,
} from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(300_000)

// ---------------------------------------------------------------------------
// 三个守护进程，因为三种 stub 行为互斥（都是 daemon 级 env）：
//   commitDaemon —— `commit` 模式：agent 真的往工作树写文件，自动提交才有内容；
//   runDaemon    —— `slow` 模式、退出码 0：任务正常收尾且**不写任何文件**；
//   failDaemon   —— `slow` 模式、退出码 1：任务必然 failed，才有可 resume 的行。
// ---------------------------------------------------------------------------

let commitDaemon: DaemonHandle
let runDaemon: DaemonHandle
let failDaemon: DaemonHandle

/** `slow` stub 的 hold 文件（存在即挂住这一回合）；只有取消那条用例会创建它。 */
let holdDir = ''
let holdFile = ''

const cleanupPaths: string[] = []

const SEED_README = '# rfc-319 worktree fixture\n'

interface AgentWorkflow {
  agentId: string
  workflowId: string
}

let commitFixtures: AgentWorkflow
let runFixtures: AgentWorkflow
let failFixtures: AgentWorkflow

test.beforeAll(async () => {
  holdDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-wt-hold-'))
  holdFile = join(holdDir, 'turn-hold')
  cleanupPaths.push(holdDir)

  commitDaemon = await startDaemon({ stubMode: 'commit' })
  runDaemon = await startDaemon({
    stubMode: 'slow',
    extraEnv: { STUB_OPENCODE_SLEEP_MS: '0', STUB_OPENCODE_HOLD_FILE: holdFile },
  })
  failDaemon = await startDaemon({
    stubMode: 'slow',
    extraEnv: { STUB_OPENCODE_SLEEP_MS: '0', STUB_OPENCODE_EXIT_CODE: '1' },
  })

  commitFixtures = await seedAgentAndWorkflow(commitDaemon, 'rfc319wt-commit')
  runFixtures = await seedAgentAndWorkflow(runDaemon, 'rfc319wt-run')
  failFixtures = await seedAgentAndWorkflow(failDaemon, 'rfc319wt-fail')
})

test.afterAll(async () => {
  for (const daemon of [commitDaemon, runDaemon, failDaemon]) {
    if (daemon !== undefined) await daemon.stop()
  }
  for (const path of cleanupPaths) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

// 本文件不用 `page.route` 注入任何响应（判据一律取真实链路）。这条收尾仍然留着：
// 一旦以后有人加了注入，`docs/dev-gotchas.md` 的「两把锁」里的锁 B 已经就位。
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' })
})

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function authHeaders(daemon: DaemonHandle, token?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token ?? daemon.token}`,
    'Content-Type': 'application/json',
  }
}

async function req(
  daemon: DaemonHandle,
  path: string,
  init?: RequestInit & { token?: string },
): Promise<Response> {
  const { token, ...rest } = init ?? {}
  return fetch(`${daemon.baseUrl}${path}`, {
    ...rest,
    headers: { ...authHeaders(daemon, token), ...(rest.headers ?? {}) },
  })
}

async function api<T>(
  daemon: DaemonHandle,
  path: string,
  init?: RequestInit & { token?: string },
): Promise<T> {
  const res = await req(daemon, path, init)
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

interface TaskDto {
  id: string
  status: string
  worktreePath: string
  repoUrl: string | null
  branch: string
  baseCommit: string | null
  workspaceState: string
  gitUserName: string | null
}

interface NodeRunLite {
  id: string
  nodeId: string
  status: string
  retryIndex: number
  parentNodeRunId: string | null
  commitPush: {
    pushOutcome: string
    commitSha: string | null
    repoBranch: string
    messageSource: string
    filesChanged: number
    insertions: number
    exclusions?: { count: number; paths: string[] }
  } | null
}

async function seedAgentAndWorkflow(daemon: DaemonHandle, prefix: string): Promise<AgentWorkflow> {
  const agent = await api<{ id: string }>(daemon, '/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: `${prefix}-writer`,
      description: 'RFC-319 worktree/commit fixture',
      outputs: ['answer'],
      readonly: false,
      bodyMd: '',
    }),
  })
  const workflow = await api<{ id: string }>(daemon, '/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: `${prefix}-wf`,
      description: 'RFC-319 worktree/commit fixture',
      definition: {
        $schema_version: 3,
        inputs: [],
        nodes: [
          {
            id: 'w',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: `${prefix}-writer`,
            promptTemplate: 'Do the work.',
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
      },
    }),
  })
  return { agentId: agent.id, workflowId: workflow.id }
}

/** 一个带 main 的普通夹具仓（只需要被克隆，不接收推送）。 */
function seedPlainRepo(label: string): string {
  const repo = mkdtempSync(join(tmpdir(), `aw-rfc319-wt-${label}-`))
  cleanupPaths.push(repo)
  writeFileSync(join(repo, 'README.md'), SEED_README, 'utf-8')
  initGitRepo(repo, { email: 'e2e@test.local', message: 'rfc-319 seed' })
  return repo
}

/** 一个裸远端 + 一份用来播种的工作副本；推送真的会落在这个裸仓上。 */
function seedBareRemote(label: string): string {
  const remote = mkdtempSync(join(tmpdir(), `aw-rfc319-wt-${label}-remote-`))
  const work = mkdtempSync(join(tmpdir(), `aw-rfc319-wt-${label}-work-`))
  cleanupPaths.push(remote, work)
  initBareGitRepo(remote)
  writeFileSync(join(work, 'README.md'), SEED_README, 'utf-8')
  initGitRepo(work, { email: 'e2e@test.local', message: 'rfc-319 seed' })
  runGit(['remote', 'add', 'origin', remote], work)
  runGit(['push', '-q', '-u', 'origin', 'main'], work)
  return remote
}

async function launchTask(
  daemon: DaemonHandle,
  fixtures: AgentWorkflow,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await req(daemon, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ workflowId: fixtures.workflowId, ref: 'main', inputs: {}, ...body }),
  })
  const text = await res.text()
  expect(res.status, `POST /api/tasks: ${res.status} ${text}`).toBe(201)
  return (JSON.parse(text) as { id: string }).id
}

async function getTask(daemon: DaemonHandle, taskId: string): Promise<TaskDto> {
  return api<TaskDto>(daemon, `/api/tasks/${taskId}`)
}

async function waitForStatus(
  daemon: DaemonHandle,
  taskId: string,
  expected: string,
  message: string,
): Promise<void> {
  await expect
    .poll(async () => (await getTask(daemon, taskId)).status, { timeout: 180_000, message })
    .toBe(expected)
}

async function nodeRuns(daemon: DaemonHandle, taskId: string): Promise<NodeRunLite[]> {
  return (await api<{ runs: NodeRunLite[] }>(daemon, `/api/tasks/${taskId}/node-runs`)).runs
}

function branchesOf(remote: string): string[] {
  return runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], remote)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .sort()
}

/** 浏览器会话：与 daemon 同源，token 走 localStorage（前端 api 客户端读它）。 */
async function primePage(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

function writeIntoWorktree(worktreePath: string, rel: string, contents: string | Buffer): void {
  const target = join(worktreePath, rel)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

// ---------------------------------------------------------------------------
// REPO-14b [P1] —— 含凭据的远端 URL 只以脱敏形态出现
// ---------------------------------------------------------------------------

test('RFC-319 REPO-14b: 带凭据的远端 URL 在接口与任务详情页都只剩脱敏形态，原始凭据在整个 DOM 里一次都不出现', async ({
  page,
}) => {
  // 这个串既是「用户名」也是「口令」的位置上的秘密。挑成人类词组而不是随机高熵串，
  // 是为了不踩 gitleaks 的 generic-api-key（见 docs/dev-gotchas.md 那条）；
  // 判据只需要它**足够独特**，能在整页 HTML 里搜。
  const CRED_USER = 'rfc319-bot'
  const CRED_SECRET = 'rfc319-credential-must-not-render'

  const repo = seedPlainRepo('cred')
  const plainUrl = repoRemoteUrl(repo)
  const credentialUrl = plainUrl.replace(/^http:\/\//, `http://${CRED_USER}:${CRED_SECRET}@`)
  const redactedUrl = plainUrl.replace(/^http:\/\//, 'http://***@')

  // 夹具自证：不做这两条，「脱敏成功」在一个本来就没凭据的 URL 上恒成立——
  // 那正是账本点名的既有空洞（现有 fixture 的本地 URL 无凭据，脱敏是 no-op）。
  expect(credentialUrl, '夹具 URL 里根本没有凭据 ⇒ 下面所有断言都是恒真的').toContain(CRED_SECRET)
  expect(redactedUrl, '脱敏形态与原串相同 ⇒ 这条链路上脱敏是 no-op，判据无效').not.toBe(
    credentialUrl,
  )

  const taskId = await launchTask(runDaemon, runFixtures, {
    name: 'rfc319-repo14b',
    repoUrl: credentialUrl,
  })
  await waitForStatus(runDaemon, taskId, 'done', '带凭据的 URL 没能启动任务 ⇒ 判据无从谈起')

  const dbFile = join(runDaemon.home, 'db.sqlite')

  // ① 夹具自证（第二层）：镜像行的 `url_redacted` 带 `***@`，只有**真的含 userinfo**
  //    的 URL 才会长成这样。没有这一条，下面所有「脱敏成功」的断言都可能是在一个
  //    压根没有凭据的 URL 上恒成立——那正是账本点名的既有空洞。
  const cached = querySqlite<{ url_redacted: string | null; url_enc: string | null }>(
    dbFile,
    'SELECT url_redacted, url_enc FROM cached_repos ORDER BY created_at DESC LIMIT 5',
  )
  const mirror = cached.find((row) => row.url_redacted === redactedUrl)
  expect(
    mirror,
    `镜像行的 url_redacted 里没有 \`***@\` ⇒ 这次启动用的不是一个真的带凭据的 URL（实际：${cached
      .map((row) => row.url_redacted)
      .join(' / ')}）`,
  ).toBeTruthy()
  expect(
    mirror?.url_enc ?? '',
    '凭据以明文躺在 cached_repos.url_enc 里 ⇒ 「唯一密封处」并没有密封',
  ).not.toContain(CRED_SECRET)

  // ② 任务行本身也绝不许留下凭据（services/task.ts:3037 在 insert 处就脱敏，
  //    RFC-054 W3-4 的既有修复）。这一层塌了，拿到库文件就等于拿到凭据。
  const stored = querySqlite<{ repo_url: string }>(
    dbFile,
    'SELECT repo_url FROM tasks WHERE id = ?',
    [taskId],
  )
  expect(stored.length, '任务行没查到 ⇒ 播种/启动出了问题').toBe(1)
  expect(stored[0]?.repo_url, '带凭据的原串被原样落进了 tasks.repo_url').toBe(redactedUrl)

  // ③ 详情投影与列表投影都必须脱敏。少任何一处，凭据就从那条通道漏给每个能读任务的人。
  const detail = await getTask(runDaemon, taskId)
  expect(detail.repoUrl, '任务详情接口把凭据原样发回来了').toBe(redactedUrl)
  const list = await api<Array<{ id: string; repoUrl: string | null }>>(
    runDaemon,
    '/api/tasks?limit=50',
  )
  const listed = list.find((item) => item.id === taskId)
  expect(listed, '任务列表里找不到刚建的任务').toBeTruthy()
  expect(listed?.repoUrl, '任务列表投影把凭据原样发回来了').toBe(redactedUrl)

  // ④ 界面：详情页那一行渲染的就是脱敏形态。
  await primePage(page, runDaemon)
  await page.goto(`${runDaemon.baseUrl}/tasks/${taskId}?tab=details`)
  const repoUrlCell = page.getByTestId('task-detail-repo-url')
  await expect(repoUrlCell, '详情页没有渲染远端 URL 那一行').toBeVisible({ timeout: 30_000 })
  await expect(repoUrlCell, '详情页渲染的不是脱敏形态').toHaveText(redactedUrl)

  // ⑤ 整页 HTML 一次都不许出现凭据——包括用户名。脱敏抹的是整个 userinfo，
  //    只挡口令、放过用户名同样是泄露（GitHub 细粒度 PAT 就把 token 放在用户名位）。
  const html = await page.content()
  expect(html, '凭据的口令部分出现在了页面 DOM 里').not.toContain(CRED_SECRET)
  expect(html, '凭据的用户名部分出现在了页面 DOM 里（token-as-username 也是凭据）').not.toContain(
    CRED_USER,
  )
})

// ---------------------------------------------------------------------------
// REPO-38b [P1] —— 取消之后工作树留在盘上
// ---------------------------------------------------------------------------

test('RFC-319 REPO-38b: 取消任务之后工作树连同内容仍在 worktrees/{repo-slug}/{task-id} 上，产品自己也还读得到它', async () => {
  const repo = seedPlainRepo('cancel')

  // hold 文件把「这一回合还在飞」做成确定性的：stub 起来后落 `<hold>.started`，
  // 并在文件被删掉之前一直不返回（packages/system-mocks/src/runtime/mode-slow.ts:62-77）。
  //
  // `.started` **每次调用都会写**（那段逻辑不看 hold 文件在不在），所以本文件里
  // 同一个 daemon 上先跑过的用例已经留下过一枚——不先删掉，这里会立刻读到陈旧标记，
  // 在工作树还没物化出来（RFC-287 G7：准备窗口内 worktreePath 是空串）时就往下走。
  const startedMarker = `${holdFile}.started`
  rmSync(startedMarker, { force: true })
  writeFileSync(holdFile, '')
  let taskId = ''
  try {
    taskId = await launchTask(runDaemon, runFixtures, {
      name: 'rfc319-repo38b',
      repoUrl: repoRemoteUrl(repo),
    })
    await expect
      .poll(() => existsSync(startedMarker), {
        timeout: 120_000,
        message: 'stub 一直没起来 ⇒ 任务没有真的进入「在跑」，取消的就不是一个活任务',
      })
      .toBe(true)
    await expect
      .poll(async () => (await getTask(runDaemon, taskId)).worktreePath !== '', {
        timeout: 120_000,
        message: '仓库准备阶段还没结束 ⇒ 此刻还没有工作树可谈',
      })
      .toBe(true)

    const running = await getTask(runDaemon, taskId)
    const worktreePath = running.worktreePath
    expect(
      worktreePath.startsWith(join(runDaemon.home, 'worktrees')),
      `工作树不在 <home>/worktrees 下（实际 ${worktreePath}）⇒ 任务隔离目录的约定被改了`,
    ).toBe(true)
    expect(
      worktreePath.endsWith(join('', taskId)) || worktreePath.endsWith(taskId),
      `工作树目录名不是 task id（实际 ${worktreePath}）`,
    ).toBe(true)
    expect(existsSync(worktreePath), '取消之前工作树就不在盘上 ⇒ 下面的判据是空洞的').toBe(true)

    const cancel = await req(runDaemon, `/api/tasks/${taskId}/cancel`, { method: 'POST' })
    expect(cancel.ok, `取消失败：${cancel.status} ${await cancel.text()}`).toBe(true)
    await waitForStatus(runDaemon, taskId, 'canceled', '取消之后任务没有走到 canceled')

    // ① 目录还在，而且**内容**还在——「留下一个空壳目录」不叫保留工作树。
    expect(
      existsSync(worktreePath),
      '取消把工作树删掉了 ⇒ 用户失去了这次运行的全部现场，无法再看它改了什么',
    ).toBe(true)
    expect(
      readFileSync(join(worktreePath, 'README.md'), 'utf-8'),
      '工作树目录还在但内容没了 ⇒ 现场同样丢失',
    ).toBe(SEED_README)

    // ② 它仍然是一棵**活的 git worktree**，不是被摘除注册后残留的普通目录：
    //    摘除之后 `rev-parse` 会直接失败，后续的 diff / 恢复也就无从谈起。
    const head = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath).trim()
    expect(head, '取消后工作树不再是一棵可用的 git worktree').toBe(running.branch)

    // ③ 产品自己的读面也还认它：没打回收墓碑，目录树接口照常列得出来。
    const canceled = await getTask(runDaemon, taskId)
    expect(
      canceled.workspaceState,
      '取消给工作区打了回收墓碑 ⇒ 之后任何复活路径都会被 410 挡住',
    ).toBe('available')
    const tree = await api<{ entries: Array<{ name: string; kind: string }> }>(
      runDaemon,
      `/api/tasks/${taskId}/worktree-tree`,
    )
    expect(
      tree.entries.map((entry) => entry.name),
      '取消后「工作目录」页签读不到任何文件 ⇒ 保留下来的工作树对用户不可用',
    ).toContain('README.md')
  } finally {
    // 放行 stub：即便上面断言炸了也不要把一个挂住的子进程留给后面的用例。
    rmSync(holdFile, { force: true })
    rmSync(startedMarker, { force: true })
  }
})

// ---------------------------------------------------------------------------
// REPO-38c [P1] —— 恢复时把重试节点回滚到 pre_snapshot
// ---------------------------------------------------------------------------

test('RFC-319 REPO-38c: 恢复失败任务时，重试节点的工作树被 pre_snapshot 带回快照那一刻——快照后的改动与新文件一并消失', async () => {
  const repo = seedPlainRepo('resume')
  const taskId = await launchTask(failDaemon, failFixtures, {
    name: 'rfc319-repo38c',
    repoUrl: repoRemoteUrl(repo),
  })
  await waitForStatus(failDaemon, taskId, 'failed', '任务没有落到 failed ⇒ 没有可恢复的行')

  const task = await getTask(failDaemon, taskId)
  const worktreePath = task.worktreePath
  expect(existsSync(worktreePath), '失败任务的工作树不在盘上 ⇒ 无从回滚').toBe(true)

  // 1) 造一个「节点开跑前」的真实基线：改一个**被跟踪**的文件后 `git stash create`。
  //    （`stash create` 只捕获跟踪文件，这与生产里 gitStashSnapshot 的语义一致。）
  const SNAPSHOT_README = '# rfc-319 state at the pre-snapshot moment\n'
  writeFileSync(join(worktreePath, 'README.md'), SNAPSHOT_README, 'utf-8')
  const snapshotSha = runGit(['stash', 'create'], worktreePath).trim()
  expect(snapshotSha, 'git stash create 没产出快照对象 ⇒ 后面种进去的就是个空值').toMatch(
    /^[0-9a-f]{40}$/,
  )

  // 2) 让工作树**离开**那一刻：改坏被跟踪文件 + 落一个快照里没有的新文件。
  const DRIFTED_README = '# rfc-319 drifted AFTER the snapshot\n'
  writeFileSync(join(worktreePath, 'README.md'), DRIFTED_README, 'utf-8')
  writeIntoWorktree(worktreePath, 'after-snapshot.txt', 'written after the snapshot\n')

  // 3) 把快照种到那条失败行的 pre_snapshot 上。
  //    RFC-130 之后调度器不再写这一列（`gitStashSnapshot` 零生产调用方），
  //    但 resume 仍然会读它并回滚（services/nodeRollback.ts:170-190）——
  //    这条用例守的就是那段被保留下来的纵深防御。
  const runs = await nodeRuns(failDaemon, taskId)
  const failedRun = runs
    .filter((run) => run.nodeId === 'w' && run.status === 'failed' && run.parentNodeRunId === null)
    .sort((a, b) => (a.id < b.id ? 1 : -1))[0]
  expect(failedRun, '找不到节点 w 的失败行 ⇒ resume 不会把它选进回滚集合').toBeTruthy()

  const dbFile = join(failDaemon.home, 'db.sqlite')
  runSqlite(
    dbFile,
    `UPDATE node_runs SET pre_snapshot = '${snapshotSha}' WHERE id = '${failedRun!.id}';`,
  )
  // 回读自证：`db.exec()` 对多语句脚本里的约束错误不抛异常，回执不可信
  // （docs/dev-gotchas.md / 协议 §5.3）。
  const seeded = querySqlite<{ pre_snapshot: string | null }>(
    dbFile,
    'SELECT pre_snapshot FROM node_runs WHERE id = ?',
    [failedRun!.id],
  )
  expect(seeded[0]?.pre_snapshot, '快照没真的写进 node_runs ⇒ 这次 resume 无从回滚').toBe(
    snapshotSha,
  )

  // 4) 走**公共 resume 接口**，不是直接调服务。
  const resume = await req(failDaemon, `/api/tasks/${taskId}/resume`, { method: 'POST' })
  expect(resume.ok, `恢复失败：${resume.status} ${await resume.text()}`).toBe(true)

  // 5) 工作树回到快照那一刻：被跟踪文件的内容是快照里的那份，
  //    快照之后新增的未跟踪文件被 `clean -fd` 清掉。
  await expect
    .poll(() => readFileSync(join(worktreePath, 'README.md'), 'utf-8'), {
      timeout: 60_000,
      message: '恢复没有把被跟踪文件带回 pre_snapshot ⇒ 重试是在上一次失败留下的半截状态上继续跑',
    })
    .toBe(SNAPSHOT_README)
  await expect
    .poll(() => existsSync(join(worktreePath, 'after-snapshot.txt')), {
      timeout: 60_000,
      message: '快照之后新增的文件在恢复后还在 ⇒ 回滚只做了一半，基线并没有真的复原',
    })
    .toBe(false)

  // 6) 恢复确实**重新派发**了这个节点（不是一次什么都没做的 200）：
  //    节点 w 多出一条比原失败行更新的顶层行。
  await expect
    .poll(
      async () =>
        (await nodeRuns(failDaemon, taskId)).filter(
          (run) => run.nodeId === 'w' && run.parentNodeRunId === null && run.id > failedRun!.id,
        ).length,
      { timeout: 120_000, message: '恢复之后节点 w 没有新的运行行 ⇒ 只是把状态翻了一下' },
    )
    .toBeGreaterThan(0)
})

// ---------------------------------------------------------------------------
// REPO-17 [P2] —— 自动 commit & push 的成功路径：推上去的那笔提交本身
// ---------------------------------------------------------------------------

test('RFC-319 REPO-17: 自动提交推送落在远端的那笔提交——内容、LLM 生成的信息、提交人身份逐项对得上 @nightly', async () => {
  const remote = seedBareRemote('push')
  const branch = 'rfc319-repo17'
  const taskId = await launchTask(commitDaemon, commitFixtures, {
    name: 'rfc319-repo17',
    repoUrl: repoRemoteUrl(remote),
    workingBranch: branch,
    autoCommitPush: true,
  })
  await waitForStatus(commitDaemon, taskId, 'done', '自动提交任务没有跑完')

  const runs = await nodeRuns(commitDaemon, taskId)
  const commitRow = runs.find(
    (run) => run.nodeId.startsWith('__commit_push__') && run.commitPush !== null,
  )
  expect(commitRow, '没有生成 commit&push 的合成节点行').toBeTruthy()
  const meta = commitRow!.commitPush!
  expect(meta.pushOutcome, '推送没成功').toBe('pushed')
  expect(meta.commitSha, '没有落下提交 sha').toMatch(/^[0-9a-f]{40}$/)
  // 提交信息由内置 commit agent（真子进程）产出。降级成模板说明那条会话根本没跑通，
  // 而 pushOutcome 仍会是 pushed —— 只看结局的判据看不出这件事。
  expect(meta.messageSource, '提交信息退回了模板 ⇒ 内置 commit agent 这条链没跑通').toBe('llm')
  expect(meta.filesChanged, '统计到的改动文件数为 0，却报告推送成功').toBeGreaterThan(0)

  // 远端上那笔提交的**真实内容**：文件在、字节对。
  const sha = meta.commitSha as string
  const files = runGit(['ls-tree', '-r', '--name-only', sha], remote)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  expect(files, 'agent 写的文件没有出现在推上去的那棵树里').toContain('e2e-change.txt')
  expect(files, '基线文件在提交里消失了 ⇒ 这次推送把远端内容改坏了').toContain('README.md')
  expect(
    runGit(['show', `${sha}:e2e-change.txt`], remote),
    '远端拿到的文件内容不是 agent 写的那份',
  ).toContain('e2e change')

  // 提交信息与提交人：信息来自 stub 的 commit agent 回合；身份来自任务冻结的 Git 身份，
  // 不是运行 daemon 那台机器的 git 全局配置。
  const subject = runGit(['show', '-s', '--format=%s', sha], remote).trim()
  expect(subject, '远端提交的信息不是 commit agent 给的那句').toBe('feat: e2e stub commit')
  const task = await getTask(commitDaemon, taskId)
  const authorName = runGit(['show', '-s', '--format=%an', sha], remote).trim()
  expect(
    authorName,
    '提交人不是任务冻结的那个身份 ⇒ 远端历史把这次改动记在了别人（或机器）名下',
  ).toBe(task.gitUserName)

  // 分支：推到的就是启动时指定的工作分支，而不是别的什么地方。
  expect(meta.repoBranch, '提交落在了别的分支上').toBe(branch)
  expect(branchesOf(remote), '远端没有出现这次任务的工作分支').toContain(branch)
  expect(
    runGit(['rev-parse', '--verify', `refs/heads/${branch}`], remote).trim(),
    '远端分支指向的不是这次推上去的提交',
  ).toBe(sha)
})

// ---------------------------------------------------------------------------
// REPO-19 [P3] —— 没有净改动时的空跑
// ---------------------------------------------------------------------------

test('RFC-319 REPO-19: 任务没有产生任何净改动时，既不生成 commit&push 行，也不往远端推出任何分支 @nightly', async () => {
  const remote = seedBareRemote('empty')
  const before = branchesOf(remote)
  expect(before, '夹具远端一开始就不止 main ⇒ 下面的「没多出分支」判据是空洞的').toEqual(['main'])

  const taskId = await launchTask(runDaemon, runFixtures, {
    name: 'rfc319-repo19',
    repoUrl: repoRemoteUrl(remote),
    workingBranch: 'rfc319-repo19',
    autoCommitPush: true,
  })
  await waitForStatus(runDaemon, taskId, 'done', '空跑任务没有跑完')

  // 前提自证：这次运行确实**什么都没改**。不成立的话下面两条断言测的是别的东西。
  const task = await getTask(runDaemon, taskId)
  expect(
    runGit(['status', '--porcelain'], task.worktreePath).trim(),
    '工作树其实是脏的 ⇒ 这条用例根本没在测「无净变更」',
  ).toBe('')

  // 判据一：连合成节点行都不该出现。
  // 账本把这条写成「skipped-empty 空跑」，但 scheduler.ts:2201 先用
  // `git status --porcelain` 判空并 `continue`——守护进程这条唯一的生产调用路径上
  // 压根不会生成行，`skipped-empty` 不可达（详见交付报告 ⑤）。
  const runs = await nodeRuns(runDaemon, taskId)
  const commitRows = runs.filter((run) => run.nodeId.startsWith('__commit_push__'))
  expect(
    commitRows.map((run) => `${run.nodeId}:${run.commitPush?.pushOutcome ?? 'null'}`),
    '没有任何改动却生成了 commit&push 行 ⇒ 每个只读任务都会白跑一次 commit agent 会话',
  ).toEqual([])

  // 判据二：远端一根分支都不许多。空跑推一个空分支上去，等于给每个只读任务
  // 在共享仓库里留一条垃圾引用。
  expect(branchesOf(remote), '没有改动却往远端推了分支').toEqual(before)
})

// ---------------------------------------------------------------------------
// REPO-X3 [P3] —— 排除模式真的把文件挡在提交之外
// ---------------------------------------------------------------------------

test('RFC-319 REPO-X3: 配置了排除模式之后，被排除的文件真的进不了提交——同一份改动在开关两侧结局相反 @nightly', async () => {
  const dbPatterns = async (patterns: string[]): Promise<void> => {
    const res = await req(commitDaemon, '/api/config', {
      method: 'PUT',
      body: JSON.stringify({ taskCommitExcludePatterns: patterns }),
    })
    expect(res.ok, `写配置失败：${res.status} ${await res.text()}`).toBe(true)
    const readBack = await api<Record<string, unknown>>(commitDaemon, '/api/config')
    expect(readBack['taskCommitExcludePatterns'], '排除规则没落进配置').toEqual(patterns)
  }

  // ── A 组：规则**不**命中 agent 写的那个文件 ⇒ 照常提交并推送。
  await dbPatterns(['*.trace'])
  const remoteA = seedBareRemote('excl-a')
  const branchA = 'rfc319-x3-a'
  const taskA = await launchTask(commitDaemon, commitFixtures, {
    name: 'rfc319-x3-a',
    repoUrl: repoRemoteUrl(remoteA),
    workingBranch: branchA,
    autoCommitPush: true,
  })
  await waitForStatus(commitDaemon, taskA, 'done', '对照组任务没有跑完')
  const rowA = (await nodeRuns(commitDaemon, taskA)).find((run) => run.commitPush !== null)
  expect(rowA?.commitPush?.pushOutcome, '规则没命中却没推上去 ⇒ 对照组不成立').toBe('pushed')
  expect(
    runGit(['ls-tree', '-r', '--name-only', branchA], remoteA)
      .split('\n')
      .map((line) => line.trim()),
    '对照组里 agent 写的文件没进提交 ⇒ 下面的对比失去意义',
  ).toContain('e2e-change.txt')

  // ── B 组：只把规则改成命中那个文件，其余一切不变 ⇒ 它必须被挡在提交之外。
  await dbPatterns(['*.txt'])
  const remoteB = seedBareRemote('excl-b')
  const branchB = 'rfc319-x3-b'
  const taskB = await launchTask(commitDaemon, commitFixtures, {
    name: 'rfc319-x3-b',
    repoUrl: repoRemoteUrl(remoteB),
    workingBranch: branchB,
    autoCommitPush: true,
  })
  await waitForStatus(commitDaemon, taskB, 'done', '排除组任务没有跑完')
  const rowB = (await nodeRuns(commitDaemon, taskB)).find((run) => run.commitPush !== null)
  expect(rowB?.commitPush, '排除组没有生成 commit&push 行 ⇒ 无从判断规则是否生效').toBeTruthy()
  expect(
    rowB!.commitPush!.pushOutcome,
    '被排除之后仍然报「推送成功」⇒ 规则没有作用到真实提交内容上',
  ).toBe('skipped-excluded')
  expect(rowB!.commitPush!.commitSha, '什么都不该提交，却落了一个提交 sha').toBeNull()
  expect(
    rowB!.commitPush!.exclusions?.paths ?? [],
    '回执里没有点名被排除的路径 ⇒ 用户无从知道自己的产出去哪了',
  ).toContain('e2e-change.txt')

  // 最硬的一条：远端上根本没有这条分支——被排除的文件既没进提交，也没被推走。
  expect(
    branchesOf(remoteB),
    '被排除的改动还是被推到了远端 ⇒ 排除规则只是回执上的装饰',
  ).not.toContain(branchB)

  // 收尾：把配置还原，免得同一个 daemon 上后面的用例继承一条排除规则。
  await dbPatterns([])
})

// ---------------------------------------------------------------------------
// REPO-37 [P2] —— 工作树文件字节代理
// ---------------------------------------------------------------------------

// 1×1 的真 PNG（不是随便几个字节）：MIME 是按扩展名给的，但字节必须原样过去，
// 判据才能同时覆盖「类型对」和「内容对」两件事。
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('RFC-319 REPO-37: 工作树字节代理只把工作树内的文件按真实类型交出来——越界与非成员各自被挡在门外 @nightly', async ({
  page,
}) => {
  const repo = seedPlainRepo('proxy')
  const taskId = await launchTask(runDaemon, runFixtures, {
    name: 'rfc319-repo37',
    repoUrl: repoRemoteUrl(repo),
  })
  await waitForStatus(runDaemon, taskId, 'done', '代理用例的任务没有跑完')
  const task = await getTask(runDaemon, taskId)

  writeIntoWorktree(task.worktreePath, 'docs/img/x.png', PNG_BYTES)
  writeIntoWorktree(task.worktreePath, 'docs/a.md', '# design\n\n![diagram](./img/x.png)\n')

  // ① 图片：状态、类型、长度、字节四项都要对。少了类型这一项，浏览器会把它
  //    当 application/octet-stream 处理，评审文档里的图就永远是一个破图标。
  const pngRes = await req(runDaemon, `/api/worktree-files/${taskId}/docs/img/x.png`)
  expect(pngRes.status, '工作树里的图片取不到').toBe(200)
  expect(pngRes.headers.get('content-type'), '图片的 content-type 不对，浏览器渲染不出来').toBe(
    'image/png',
  )
  expect(pngRes.headers.get('content-length'), 'content-length 与真实字节数对不上').toBe(
    String(PNG_BYTES.length),
  )
  expect(
    Buffer.from(await pngRes.arrayBuffer()).equals(PNG_BYTES),
    '取回来的字节和工作树里的不是同一份',
  ).toBe(true)

  // ② markdown 走的是另一条 MIME 分支。
  const mdRes = await req(runDaemon, `/api/worktree-files/${taskId}/docs/a.md`)
  expect(mdRes.status, '工作树里的 markdown 取不到').toBe(200)
  expect(mdRes.headers.get('content-type'), 'markdown 的 content-type 不对').toBe(
    'text/markdown; charset=utf-8',
  )

  // ③ 越界：`..` 必须以编码形态送过去，否则 URL 规范化会在客户端就把它折叠掉，
  //    这道守卫根本不会被执行到。
  const escapeRes = await req(runDaemon, `/api/worktree-files/${taskId}/..%2F..%2FREADME.md`)
  expect(
    escapeRes.status,
    '相对路径逃出工作树之后仍被放行 ⇒ 这个端点成了读 daemon 主机文件的入口',
  ).toBe(422)
  expect((await escapeRes.json()).code, '越界被挡住了，但报的不是越界').toBe(
    'worktree-file-escapes-worktree',
  )

  // ④ 成员 ACL：非成员看不见，且与「任务不存在」**同形**——能区分就等于泄露了
  //    「这个任务存在」这件事。
  const outsider = await createUserAndLogin(runDaemon, 'rfc319-wt-outsider')
  const forbidden = await req(runDaemon, `/api/worktree-files/${taskId}/docs/a.md`, {
    token: outsider.token,
  })
  expect(forbidden.status, '任务的非成员也能读它的工作树文件').toBe(404)
  const forbiddenBody = (await forbidden.json()) as { code: string }
  const missing = await req(runDaemon, `/api/worktree-files/01JZZZZZZZZZZZZZZZZZZZZZZZ/docs/a.md`)
  expect(missing.status, '不存在的任务没有返回 404').toBe(404)
  expect(
    forbiddenBody.code,
    '「无权限」和「不存在」返回了不同的错误码 ⇒ 外人可以拿它探测任务是否存在',
  ).toBe((await missing.json()).code)

  // ⑤ 浏览器通道：界面上的「下载原始字节」按钮走的就是这个端点。
  //    （评审 markdown 里的 `<img src>` 走的也是它，但那条通道今天带不上
  //    Authorization 头，见交付报告 ⑤ 的产品缺陷条目。）
  await primePage(page, runDaemon)
  await page.goto(`${runDaemon.baseUrl}/tasks/${taskId}?tab=worktree-files`)
  await expect(page.getByTestId('worktree-files-panel')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('worktree-tree-dir-docs').click()
  await page.getByTestId('worktree-tree-dir-docs/img').click()
  await page.getByTestId('worktree-tree-file-docs/img/x.png').click()
  const [proxyResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/worktree-files/${taskId}/docs/img/x.png`,
    ),
    page.getByTestId('worktree-files-download').click(),
  ])
  expect(proxyResponse.status(), '浏览器经代理下载图片没有拿到 200').toBe(200)
  expect(
    proxyResponse.headers()['content-type'],
    '浏览器拿到的类型不是 image/png ⇒ 评审文档里的图会被当成二进制附件',
  ).toBe('image/png')
})

// ---------------------------------------------------------------------------
// REPO-X1 [P2] —— 「工作目录」页签
// ---------------------------------------------------------------------------

const OVERSIZED_BYTES = 3 * 1024 * 1024 + 7

test('RFC-319 REPO-X1: 工作目录页签逐层懒加载、预览真实内容、超过 2 MiB 只给提示但仍可下载原始字节 @nightly', async ({
  page,
}) => {
  const repo = seedPlainRepo('files')
  const taskId = await launchTask(runDaemon, runFixtures, {
    name: 'rfc319-repox1',
    repoUrl: repoRemoteUrl(repo),
  })
  await waitForStatus(runDaemon, taskId, 'done', '工作目录用例的任务没有跑完')
  const task = await getTask(runDaemon, taskId)

  const HELLO = "export const hello = 'rfc-319 worktree preview'\n"
  writeIntoWorktree(task.worktreePath, 'src/hello.ts', HELLO)
  writeIntoWorktree(task.worktreePath, 'big.bin', Buffer.alloc(OVERSIZED_BYTES, 0x41))

  const treeRequests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === `/api/tasks/${taskId}/worktree-tree`) {
      treeRequests.push(url.searchParams.get('path') ?? '')
    }
  })

  await primePage(page, runDaemon)
  await page.goto(`${runDaemon.baseUrl}/tasks/${taskId}?tab=worktree-files`)
  await expect(page.getByTestId('worktree-files-panel')).toBeVisible({ timeout: 30_000 })
  const srcDir = page.getByTestId('worktree-tree-dir-src')
  await expect(srcDir, '根层没有列出 src 目录').toBeVisible()

  // ① 懒加载：展开之前一次子目录都没有请求过。不成立的话，一棵大工作树会在
  //    打开页签的瞬间被整棵拉下来。
  expect(
    treeRequests.filter((path) => path !== ''),
    '还没展开任何目录就已经请求了子层 ⇒ 目录树不是懒加载的',
  ).toEqual([])

  // ② 展开才请求那一层，并出现子节点。
  await srcDir.click()
  await expect
    .poll(() => treeRequests.filter((path) => path === 'src').length, {
      message: '展开 src 之后没有发出对应的子层请求',
    })
    .toBeGreaterThan(0)
  const helloFile = page.getByTestId('worktree-tree-file-src/hello.ts')
  await expect(helloFile, '展开后没有出现 src 下的文件').toBeVisible()

  // ③ 预览的是磁盘上的真实内容。
  await helloFile.click()
  const body = page.getByTestId('worktree-files-preview-body')
  await expect(body, '选中文件后没有渲染预览').toBeVisible()
  await expect(body.locator('pre'), '预览里的不是文件的真实内容').toHaveText(HELLO)

  // ④ 超限文件：给的是带**真实字节数**的提示，而不是把 3 MiB 灌进 <pre>。
  await page.getByTestId('worktree-tree-file-big.bin').click()
  const oversized = page.getByTestId('worktree-files-preview-oversized')
  await expect(oversized, '超过 2 MiB 的文件没有走超限提示分支').toBeVisible()
  await expect(
    oversized,
    '超限提示里没有真实大小 ⇒ 用户看不出它到底多大、该不该下载',
  ).toContainText('3.0 MiB')
  await expect(page.getByTestId('worktree-files-preview-body')).toHaveCount(0)

  // ⑤ 超限不等于不可下载（RFC-071）：原始字节要一个不少地拿到。
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    oversized.getByTestId('worktree-files-download').click(),
  ])
  expect(download.suggestedFilename(), '下载下来的文件名不对').toBe('big.bin')
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  expect(
    Buffer.concat(chunks).length,
    '超限文件下载下来的字节数不完整 ⇒ 预览看不了、下载也拿不全，这个文件对用户等于不存在',
  ).toBe(OVERSIZED_BYTES)
})

// ---------------------------------------------------------------------------
// REPO-X2 [P2] —— 「变更」页签渲染真实 git diff
// ---------------------------------------------------------------------------

test('RFC-319 REPO-X2: 变更页签渲染的是真工作树算出来的 git diff——改动、新增、未跟踪三类文件都在，正文是真实新增行 @nightly', async ({
  page,
}) => {
  const repo = seedPlainRepo('diff')
  const taskId = await launchTask(runDaemon, runFixtures, {
    name: 'rfc319-repox2',
    repoUrl: repoRemoteUrl(repo),
  })
  await waitForStatus(runDaemon, taskId, 'done', '变更用例的任务没有跑完')
  const task = await getTask(runDaemon, taskId)
  expect(task.baseCommit, '任务没有基线提交 ⇒ 变更页签本来就不会渲染').toMatch(/^[0-9a-f]{40}$/)

  const ADDED_LINE = 'export const rfc319Marker = 42'
  writeIntoWorktree(task.worktreePath, 'README.md', `${SEED_README}changed by rfc-319\n`)
  writeIntoWorktree(task.worktreePath, 'src/added.ts', `${ADDED_LINE}\n`)
  writeIntoWorktree(task.worktreePath, 'notes/scratch.md', '# scratch\n')

  // 服务端先自证：这三条路径确实进了 /api/tasks/:id/diff 的真实输出。
  const diff = await api<{ diff: string; baseCommit: string }>(
    runDaemon,
    `/api/tasks/${taskId}/diff`,
  )
  for (const path of ['README.md', 'src/added.ts', 'notes/scratch.md']) {
    expect(diff.diff, `真实 diff 里没有 ${path} ⇒ 未跟踪 / 已改动没有被一起算进去`).toContain(path)
  }

  await primePage(page, runDaemon)
  await page.goto(`${runDaemon.baseUrl}/tasks/${taskId}?tab=changes`)
  const panel = page.getByTestId('change-review')
  await expect(panel, '变更页签没有渲染出面板').toBeVisible({ timeout: 30_000 })

  // ① 三个真实路径各有一个文件条目。既有 e2e 全部用 page.route 灌假 diff，
  //    这条是「真工作树 → 接口 → 面板」唯一的端到端证据。
  for (const path of ['README.md', 'src/added.ts', 'notes/scratch.md']) {
    await expect(
      panel.locator(`.changes__file-tab[title="${path}"]`),
      `面板里没有 ${path} 这一条 ⇒ 真实 diff 没有被渲染出来`,
    ).toHaveCount(1)
  }

  // ② 点开其中一个，正文里是真实的新增行——只断言条目存在，等于没验正文那一半。
  await panel.locator('.changes__file-tab[title="src/added.ts"]').click()
  await expect(panel.getByTestId('change-file-detail'), '点开文件之后没有渲染详情').toBeVisible()
  await expect(
    panel.getByTestId('change-file-detail'),
    '详情里没有工作树里那一行真实内容',
  ).toContainText(ADDED_LINE)
})

// ---------------------------------------------------------------------------

async function createUserAndLogin(
  daemon: DaemonHandle,
  username: string,
): Promise<{ id: string; token: string }> {
  const password = 'Rfc319-Worktree-2026!'
  const created = await api<{ id: string }>(daemon, '/api/users', {
    method: 'POST',
    body: JSON.stringify({
      username,
      email: `${username}@example.com`,
      displayName: username,
      role: 'user',
      password,
    }),
  })
  const login = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  expect(login.ok, `login ${username}: ${login.status}`).toBe(true)
  return { id: created.id, token: ((await login.json()) as { sessionToken: string }).sessionToken }
}
