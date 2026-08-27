// RFC-310 PR-4 T41/T43/T52 —— digital-employee host 执行链（真子进程）。
//
// 锁的合同：
//   1. launch = codeRound 同款漏斗（anchor 懒种 + synthesized snapshot +
//      StartTaskSchema + startTask），executionRef = taskId（durable，重启可查）；
//   2. separate-writer/disposable workspace：DA 物化的 action workspace 原样作
//      任务工作区（internalSource + preCreatedWorktree borrowed）——未提交
//      seed/evidence overlay 对子进程可见、任务终态不回收目录、无 worktree 拷贝；
//   3. 结果收取走 RFC-243 统一 outcome 投影：done → agent-result 端口原文；
//      envelope 缺失 → 任务 failed（protocol 归 DA parser，机制层只搬运）；
//   4. cancel/interrupted：既有任务机制原样生效（TERM→KILL、already-terminal
//      幂等、interrupted 行可查询映射）；
//   5. 终态 onTerminal 回调（DA 侧 wake hint 的注入缝）。
// 真子进程面 = mock-opencode（bun 子进程、真 spawn/env/cwd/stdout 链）。

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks } from '../src/db/schema'
import { AGENT_RESULT_PORT } from '../src/modules/development-automation/domain/agentEnvelope'
import {
  composeAgentActionExecution,
  type AgentActionExecutionRunner,
} from '../src/modules/task-execution/composition/agentActionExecution'
import {
  DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
  DIGITAL_EMPLOYEE_RESULT_PORT,
} from '../src/modules/task-execution/domain/digitalEmployeeHost'
import { createAgent } from '../src/services/agent'
import { nonInteractiveGitEnv } from '../src/util/git'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'
import { createTaskExecutionTestTopology } from './helpers/taskExecutionTestTopology'

setDefaultTimeout(120_000)

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

function git(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    env: { ...process.env, ...nonInteractiveGitEnv() } as Record<string, string>,
  })
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`)
  }
}

interface Harness {
  db: DbClient
  appHome: string
  /** exact baseline sha（workspace 由它 clone + detach）。 */
  baselineSha: string
  /** DA 侧物化形状的 action workspace：detached clone + 未提交 overlay。 */
  workspacePath: string
  agentId: string
  tmp: string
}

async function buildHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'rfc310-pr4-host-'))
  const appHome = join(tmp, 'home')
  mkdirSync(appHome, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  await seedTestDefaultOpencodeRuntime(db)

  const baseline = join(tmp, 'baseline')
  mkdirSync(baseline)
  git(baseline, 'init', '-q', '-b', 'main')
  writeFileSync(join(baseline, 'README.md'), '# baseline\n')
  git(baseline, 'add', 'README.md')
  git(baseline, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')
  const sha = Bun.spawnSync({ cmd: ['git', 'rev-parse', 'HEAD'], cwd: baseline })
    .stdout.toString()
    .trim()

  // DA materializeActionWorkspace 的形状（不 import DA infra——机制侧测试对
  // 「workspace 是什么」只依赖形状：git checkout + 未提交 overlay + exclude）。
  // 必须落 appHome 之下：RFC-308 exclude participant 拒绝平台家外的 worktree
  // （workspace-exclude-owner-mismatch）——这是对 DA 物化落点的真实集成约束。
  const workspacePath = join(appHome, 'de-workspaces', 'ws')
  mkdirSync(join(appHome, 'de-workspaces'), { recursive: true })
  git(appHome, 'clone', '--no-hardlinks', '-q', baseline, workspacePath)
  git(workspacePath, 'checkout', '-q', '--detach', sha)
  mkdirSync(join(workspacePath, '.git', 'info'), { recursive: true })
  writeFileSync(join(workspacePath, '.git', 'info', 'exclude'), '.agent-workflow/\n')
  writeFileSync(join(workspacePath, 'seed.md'), 'uncommitted seed overlay\n')
  const requirementMount = join(
    workspacePath,
    '.agent-workflow',
    'inputs',
    'requirements',
    'bundle-1',
  )
  mkdirSync(requirementMount, { recursive: true })
  writeFileSync(
    join(requirementMount, 'requirement-manifest.json'),
    '{"files":[{"fileId":"req-1"}]}\n',
  )

  const agent = await createAgent(db, {
    name: 'de-impl',
    description: 'digital employee impl agent',
    outputs: [DIGITAL_EMPLOYEE_RESULT_PORT],
    outputKinds: { [DIGITAL_EMPLOYEE_RESULT_PORT]: 'string' },
    syncOutputsOnIterate: false,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
  })
  return { db, appHome, baselineSha: sha, workspacePath, agentId: agent.id, tmp }
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      const p = prev[k]
      if (p === undefined) delete process.env[k]
      else process.env[k] = p
    }
  })
}

function runner(
  h: Harness,
  extra: { awaitScheduler?: boolean; onTerminal?: (ref: string) => void } = {},
): AgentActionExecutionRunner {
  return composeAgentActionExecution({
    db: h.db,
    startDeps: {
      db: h.db,
      schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
        .schedulerDriver,
      appHome: h.appHome,
      binaryOverride: ['bun', 'run', MOCK_OPENCODE],
      awaitScheduler: extra.awaitScheduler ?? true,
      defaultNodeRetries: 0,
      defaultPerNodeTimeoutMs: 60_000,
    },
    ...(extra.onTerminal !== undefined ? { onTerminal: extra.onTerminal } : {}),
    terminalPollMs: 25,
  })
}

function launchInput(h: Harness, actionRunId: string) {
  return {
    actionRunId,
    capabilityId: 'change.implement',
    agentId: h.agentId,
    prompt: 'implement the thing (protocol block goes here)',
    workspacePath: h.workspacePath,
    baselineSha: h.baselineSha,
    platformInputPaths: ['.agent-workflow/inputs/requirements/bundle-1'],
    wallTimeMs: null,
  }
}

let h: Harness
beforeEach(async () => {
  h = await buildHarness()
})
afterEach(() => rmSync(h.tmp, { recursive: true, force: true }))

describe('rfc310 pr4 — digital-employee host execution (real subprocess)', () => {
  test('结果端口常量与 development-automation envelope 域结构配对', () => {
    expect(DIGITAL_EMPLOYEE_RESULT_PORT).toBe(AGENT_RESULT_PORT)
  })

  test('launch → mock runtime 子进程 → done：outcome 端口原文 + workspace 语义 + 零 identity env', async () => {
    const envLog = join(h.tmp, 'env.log')
    const frame = '{"protocolVersion":1,"nonce":"n0"}'
    const r = runner(h)
    const launched = await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ [DIGITAL_EMPLOYEE_RESULT_PORT]: frame }),
        MOCK_OPENCODE_CAPTURE_ENV_TO: envLog,
        MOCK_OPENCODE_REQUIRE_FILES: JSON.stringify({
          '.agent-workflow/inputs/requirements/bundle-1/requirement-manifest.json':
            '{"files":[{"fileId":"req-1"}]}\n',
        }),
      },
      () => r.launch(launchInput(h, 'ar-done-1')),
    )
    expect(launched.ok).toBe(true)
    if (!launched.ok) return

    const snap = await r.fetchOutcome(launched.executionRef)
    expect(snap.kind).toBe('exited')
    if (snap.kind !== 'exited') return
    expect(snap.taskStatus).toBe('done')
    expect(snap.resultText).toBe(frame)

    // separate-writer/disposable：工作区就是传入目录（无 worktree 拷贝）、
    // space_kind='internal'、终态后目录健在（borrowed）、未提交 overlay 未损。
    const row = h.db.select().from(tasks).where(eq(tasks.id, launched.executionRef)).get()!
    expect(row.workflowId).toBe(DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID)
    expect(row.catalogVisibility).toBe('internal')
    expect(row.worktreePath).toBe(h.workspacePath)
    expect(row.spaceKind).toBe('internal')
    expect(JSON.parse(row.platformInputPathsJson!)).toEqual([
      '.agent-workflow/inputs/requirements/bundle-1',
    ])
    expect(row.gitUserName ?? null).toBeNull()
    expect(row.autoCommitPush).toBe(false)
    expect(existsSync(join(h.workspacePath, 'seed.md'))).toBe(true)
    expect(
      existsSync(
        join(
          h.workspacePath,
          '.agent-workflow',
          'inputs',
          'requirements',
          'bundle-1',
          'requirement-manifest.json',
        ),
      ),
    ).toBe(true)

    // 真子进程证词（T43）：RFC-130 给每个 agent 节点一个
    // 从 canonical 全量快照分支出的 iso worktree，agent 的 cwd 是
    // `<appHome>/iso/<taskId>/<nodeRunId>`——**不是** action workspace 本体；
    // 成功后业务 delta 由平台 merge-back 回 canonical，失败即 discard。
    // 这意味着 agent 从不直接触碰 action workspace 的 .git（比 §7.6 的检测+
    // 回退更强的一层）；launch-frozen platformInputPaths 则经真实快照把 Git
    // ignored evidence 带入该 cwd（上面的 REQUIRE_FILES 已按原文验证）。
    const captured = JSON.parse(readFileSync(envLog, 'utf8').trim().split('\n')[0]!) as Record<
      string,
      string | null
    >
    expect(captured.cwd).toContain(`/iso/${launched.executionRef}/`)
    expect(captured.cwd).not.toBe(h.workspacePath)
    expect(captured.GIT_AUTHOR_NAME).toBeNull()
    expect(captured.GIT_AUTHOR_EMAIL).toBeNull()
    expect(captured.GIT_COMMITTER_NAME).toBeNull()
    expect(captured.GIT_COMMITTER_EMAIL).toBeNull()
  })

  test('envelope 缺失 → 任务 failed、resultText null（protocol 判定归 DA parser）', async () => {
    const r = runner(h)
    const launched = await withEnv({ MOCK_OPENCODE_SKIP_ENVELOPE: '1' }, () =>
      r.launch(launchInput(h, 'ar-noenv-1')),
    )
    expect(launched.ok).toBe(true)
    if (!launched.ok) return
    const snap = await r.fetchOutcome(launched.executionRef)
    expect(snap.kind).toBe('exited')
    if (snap.kind !== 'exited') return
    expect(snap.taskStatus).toBe('failed')
    expect(snap.resultText).toBeNull()
    expect(snap.errorMessage).not.toBeNull()
  })

  test('Agent 子进程 commit 被 exact-window no-Git audit 拒绝且不 merge-back', async () => {
    const r = runner(h)
    const launched = await withEnv(
      {
        MOCK_OPENCODE_GIT_COMMIT: '1',
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({
          [DIGITAL_EMPLOYEE_RESULT_PORT]: '{"protocolVersion":1}',
        }),
      },
      () => r.launch(launchInput(h, 'ar-git-mutation-1')),
    )
    expect(launched.ok).toBe(true)
    if (!launched.ok) return

    const snap = await r.fetchOutcome(launched.executionRef)
    expect(snap.kind).toBe('exited')
    if (snap.kind !== 'exited') return
    expect(snap.taskStatus).toBe('failed')
    expect(snap.errorMessage).toContain('agent-git-mutation-forbidden')
    expect(existsSync(join(h.workspacePath, 'agent-git-mutation.txt'))).toBe(false)
  })

  test('launch 前置校验：agent 缺失 / 端口未声明 / workspace 缺失 / sha 非法 → typed failure', async () => {
    const r = runner(h)
    const bad1 = await r.launch({ ...launchInput(h, 'ar-v1'), agentId: 'no-such-agent' })
    expect(!bad1.ok && bad1.failure.code).toBe('de-agent-unavailable')

    const noPort = await createAgent(h.db, {
      name: 'de-noport',
      description: '',
      outputs: ['other'],
      outputKinds: { other: 'string' },
      syncOutputsOnIterate: false,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    const bad2 = await r.launch({ ...launchInput(h, 'ar-v2'), agentId: noPort.id })
    expect(!bad2.ok && bad2.failure.code).toBe('de-agent-result-port-missing')

    const bad3 = await r.launch({
      ...launchInput(h, 'ar-v3'),
      workspacePath: join(h.tmp, 'nowhere'),
    })
    expect(!bad3.ok && bad3.failure.code).toBe('de-workspace-unavailable')

    const bad4 = await r.launch({ ...launchInput(h, 'ar-v4'), baselineSha: 'nope' })
    expect(!bad4.ok && bad4.failure.code).toBe('de-baseline-invalid')

    const bad5 = await r.launch({
      ...launchInput(h, 'ar-v5'),
      platformInputPaths: ['README.md'],
    })
    expect(!bad5.ok && bad5.failure.code).toBe('de-input-mount-invalid')

    const bad6 = await r.launch({
      ...launchInput(h, 'ar-v6'),
      platformInputPaths: ['.agent-workflow/inputs/missing'],
    })
    expect(!bad6.ok && bad6.failure.code).toBe('de-input-mount-missing')
  })

  test('cancel：运行中 TERM→取消；重复 cancel = already-terminal；未知 ref = not-found', async () => {
    const r = runner(h, { awaitScheduler: false })
    const launched = await withEnv({ MOCK_OPENCODE_DELAY_MS: '30000' }, () =>
      r.launch(launchInput(h, 'ar-cancel-1')),
    )
    expect(launched.ok).toBe(true)
    if (!launched.ok) return

    // 等子进程真的跑起来（pending → running），再取消。
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const row = h.db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, launched.executionRef))
        .get()
      if (row?.status === 'running') break
      await Bun.sleep(25)
    }
    const first = await r.cancel(launched.executionRef)
    expect(first.settled).toBe('canceled')

    // 结算到终态后：fetchOutcome canceled、二次 cancel 幂等。
    const settleDeadline = Date.now() + 20_000
    let snap = await r.fetchOutcome(launched.executionRef)
    while (snap.kind !== 'exited' && Date.now() < settleDeadline) {
      await Bun.sleep(25)
      snap = await r.fetchOutcome(launched.executionRef)
    }
    expect(snap.kind).toBe('exited')
    if (snap.kind === 'exited') expect(snap.taskStatus).toBe('canceled')
    expect((await r.cancel(launched.executionRef)).settled).toBe('already-terminal')
    expect((await r.cancel('01NOSUCHTASKREF0000000000')).settled).toBe('not-found')
  })

  test('daemon 重启收敛面：interrupted 行经 fetchOutcome 如实映射（executionRef durable）', async () => {
    const r = runner(h)
    const launched = await withEnv(
      { MOCK_OPENCODE_OUTPUTS: JSON.stringify({ [DIGITAL_EMPLOYEE_RESULT_PORT]: 'x' }) },
      () => r.launch(launchInput(h, 'ar-int-1')),
    )
    expect(launched.ok).toBe(true)
    if (!launched.ok) return
    // 模拟 daemon 崩溃残留：行退回 running + 死 pid（重启后无 owner），
    // 然后跑**真实**的 boot 修复入口 reapOrphanRuns——DE host 行走的就是
    // 普通任务的 interrupted 收敛，没有专用逻辑。
    h.db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, launched.executionRef)).run()
    const { reapOrphanRuns } = await import('../src/services/orphans')
    await reapOrphanRuns(h.db)
    const snap = await r.fetchOutcome(launched.executionRef)
    expect(snap.kind).toBe('exited')
    if (snap.kind === 'exited') expect(snap.taskStatus).toBe('interrupted')

    expect((await r.fetchOutcome('01NOSUCHTASKREF0000000000')).kind).toBe('not-found')
  })

  test('onTerminal 回调在 attempt 终态触发（DA wake-hint 注入缝）', async () => {
    const fired: string[] = []
    const r = runner(h, { awaitScheduler: true, onTerminal: (ref) => fired.push(ref) })
    const launched = await withEnv(
      { MOCK_OPENCODE_OUTPUTS: JSON.stringify({ [DIGITAL_EMPLOYEE_RESULT_PORT]: 'y' }) },
      () => r.launch(launchInput(h, 'ar-wake-1')),
    )
    expect(launched.ok).toBe(true)
    if (!launched.ok) return
    const deadline = Date.now() + 20_000
    while (fired.length === 0 && Date.now() < deadline) await Bun.sleep(20)
    expect(fired).toEqual([launched.executionRef])
  })
})
