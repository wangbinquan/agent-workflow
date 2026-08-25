// RFC-319 —— 意图构建器域里**融合链路与各类前置拒绝**这一片：
// 记忆页发起融合时的**目标技能选择**、融合的**乐观锁**、发起前的**三条拒绝**、
// 技能详情页融合入口的**权限收放**，以及意图会话的**两条预算耗尽**与
// **工作上下文刷新失败**的告警 / 重试 / 丢弃。
// 覆盖 INTENT-49 / INTENT-59 / INTENT-60 / INTENT-X2 / INTENT-20 / INTENT-25 / INTENT-X10。
//
// **刻意不重复**（已被别处锁住，本文件只把它们当夹具用，不再断言）：
//   * MEM-22「已批准库里勾几条就融合几条、重开弹窗跟得上改过的选择、提交后落在
//     这次融合自己的详情页」—— e2e/rfc319-memory-fusion-and-badges.spec.ts。
//     INTENT-49 补的是那条**没做的另一半**：勾完之后**选哪个技能**——尤其是
//     两个同名技能靠什么分辨。
//   * INTENT-50 发起前的本地校验（未选记忆 / 未选技能）、INTENT-51/52/55/56/57
//     的评审面四态 —— e2e/fusion-review-surface.spec.ts。
//   * INTENT-48 从技能详情页选记忆发起、INTENT-53/54 批准后的落地
//     —— e2e/fusion-lifecycle.spec.ts；INTENT-58 / INTENT-X3 的读面隔离与跨用户
//     决策拒绝 —— e2e/fusion-access.spec.ts。
//   * INTENT-X1「没有 intent:write 时六类资源页的 AI 入口整体不挂载」
//     —— e2e/rfc319-intent-access-boundaries.spec.ts。INTENT-X2 管的是**另一个**
//     入口（融合按钮）与**另一组**权限点（skills:update + tasks:execute）。
//
// 这七条坏掉时都不会报错，只会安静地改错东西或安静地卡住：
//
//   * 同名技能不消歧 ⇒ 下拉里两行**一模一样**，用户只能猜。融合会**改写托管技能
//     的正文并递增版本**，而技能正文是此后每次任务都要读的东西——猜错的那一次，
//     被改写的是另一个人的技能，且没有任何提示。
//   * 融合 OCC 失守 ⇒ 待审期间技能被别人改过，批准仍然把**基于旧版本**算出来的
//     整棵工作树覆盖上去：别人刚写的那一版**当场消失**，版本历史里只留下一条
//     「fusion」摘要，没有任何冲突提示。
//   * 三条前置拒绝混成一句话 ⇒ 用户拿到「不能融合」四个字，既不知道是自己没批准
//     那条记忆、还是技能少了快照、还是压根没写权限；三条的修法完全不同。
//   * 融合按钮对没权限的人还在 ⇒ 他点了才吃 403，而这条路径要先跑一次
//     `GET /api/memories`、开一个弹窗、填完意图，最后一步才被拒。
//   * 生成预算耗尽不点名旋钮 ⇒ 会话从此发不出任何消息，界面只说「冲突」，
//     管理员不知道该去调哪一项，也不知道「归档重开」是另一条出路。
//   * 追问预算耗尽没有截停 ⇒ 模型可以无限追问，每一轮都真的起一次子进程，
//     预算旋钮形同虚设。
//   * 工作上下文刷新失败没有告警 ⇒ 会话顶部的「可用资源」看起来一切正常，
//     用户以为新挂的资源已经在了，下一轮生成其实完全没看到它。
//
// 判据取自源码单一事实源（纯文本引用，勿改成外链——外链会被 CI 的 markdown
// link check 逐条请求，见 CLAUDE.md §opencode 源码自取规则）：
//   packages/frontend/src/components/fusion/FuseDialog.tsx:78-86    duplicateSkillNames 集合
//   packages/frontend/src/components/fusion/FuseDialog.tsx:160-187  目标技能下拉（label = 名字 · owner [· 短 id]）
//   packages/frontend/src/routes/skills.detail.tsx:103-106          canUpdate / canExecuteTasks 的来源
//   packages/frontend/src/routes/skills.detail.tsx:957-965          融合按钮的挂载条件
//   packages/frontend/src/routes/skills.detail.tsx:1100-1106        FuseDialog 的挂载条件
//   packages/frontend/src/routes/fusions.detail.tsx:144             approve 失败的错误横幅
//   packages/frontend/src/routes/fusions.detail.tsx:255             reject 失败的错误横幅（在弹窗里）
//   packages/backend/src/routes/fusions.ts:58                       POST /api/fusions 的权限点
//   packages/backend/src/services/fusion.ts:560-571                 技能：存在 / 可见 / managed / 可写
//   packages/backend/src/services/fusion.ts:588-605                 记忆：必须 approved 且本人可管
//   packages/backend/src/services/fusion.ts:1402-1407               fusion-skill-unversioned
//   packages/backend/src/services/fusion.ts:1264-1299               claimFusionDecision 的 token CAS
//   packages/backend/src/services/fusion.ts:1445-1453               approve：先 requireCurrentSkillWritable 再 claim
//   packages/backend/src/services/fusion.ts:1547-1558               reject：同一把 claim，在任何副作用之前
//   packages/backend/src/services/intent/session.ts:429-444         assertGenerationBudget
//   packages/backend/src/services/intent/turnEngine.ts:793-800      intent-question-budget-exhausted
//   packages/backend/src/services/intent/workingSet.ts:163-178      validateAdditionsInTx（看不见 = not found）
//   packages/backend/src/services/intent/workingSet.ts:441-445      活化失败 → state='failed'
//   packages/backend/src/services/intent/workingSet.ts:619-651      retry：只有 failed 能重试
//   packages/backend/src/services/intent/journey.ts:40-41           workingSetChange.failed → 'working-set-failed'
//   packages/frontend/src/routes/intent.detail.tsx:387-407          失败徽标 + 重试按钮
//   packages/frontend/src/components/IntentMountDialog.tsx:145-154  「丢弃待处理更新」
//   packages/backend/src/routes/config.ts:47-53                     PUT /api/config（提高预算的那条出路）
//   packages/system-mocks/src/runtime/skeleton.ts:136-140,173-177   nonce 提取与 stdout 事件格式（X10 的替身照它写）
//
// **覆盖边界（如实记，免得后人看到「改了没红」误以为已经覆盖）**：
//   * `FuseDialog.tsx:162-163` 的 `fusion.noManagedSkills` 空技能列表分支未覆盖：
//     本文件的 daemon 里始终有托管技能，要造这一格得先把全部技能删光，
//     而那会连带毁掉同一个 daemon 里其余用例的夹具。
//   * `fusion.ts:1204-1215` 的 `fusion-provenance-quarantined` /
//     `fusion-precondition-legacy` 两条只在**升级迁移**留下的行上成立，
//     e2e 无法在不直接改库的情况下造出来（改库造出来的是 migration 的问题，
//     不是用户面的问题）。
//   * `workingSet.ts:599-601` 的 `intent-working-set-applying`（applying 中不许丢弃）
//     未覆盖：applying 只在一次活化事务的窗口里存在，e2e 停不住那一格。
//   * INTENT-X10 的替身运行时是一个 `#!/usr/bin/env node` 脚本，**只在 POSIX 上可执行**。
//     本用例带 `@nightly`，而 nightly 腿（.github/workflows/e2e-full-nightly.yml）
//     只跑 ubuntu-latest，所以这不影响任何一条 CI 腿；在 Windows 上本机跑全量时
//     它会以「spawn 失败」收场，而不是假绿。

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

// serial：本文件是一条有状态的直线——INTENT-49 发起的那次融合正是 INTENT-59 要
// 拿来做乐观锁实验的对象；INTENT-20 会把生成预算调到 1，之后任何依赖预算的用例
// 都不成立。顺序是这个文件的一部分，别改成 parallel，也别调换用例次序。
test.describe.configure({ mode: 'serial' })
// 融合要真的跑一轮 agent（含一次强制反问的往返），180 秒的等待预算要放得下。
test.setTimeout(300_000)

const PASSWORD = 'Rfc319IntentFusionPass!1'
/** 两个同名技能共用的名字——INTENT-49 的消歧就是围着它转的。 */
const DUP_SKILL_NAME = 'rfc319-ifg-target'
const SOLO_SKILL_NAME = 'rfc319-ifg-solo'
const NO_SNAPSHOT_SKILL_NAME = 'rfc319-ifg-no-snapshot'

interface SeededUser {
  username: string
  displayName: string
  userId: string
  token: string
}

interface SkillRow {
  id: string
  name: string
  contentVersion: number
  sourceKind?: string
  ownerUserId?: string | null
}

interface SkillContentRow {
  description: string
  bodyMd: string
  token: string
  contentVersion: number
}

interface FusionWire {
  id: string
  status: string
  skillId: string
  skillName: string
  iteration: number
  memoryIds: string[]
  currentTaskId: string | null
  error: string | null
}

interface ErrorBody {
  code?: string
  message?: string
}

interface WorkingSetChangeWire {
  id: string
  state: string
  error: string | null
}

interface IntentSessionDetailWire {
  session: { turnSeq: number; contextRevision: number; inFlight: boolean }
  mounts: Array<{ handle: string; resourceType: string; resourceId: string }>
  workingSetChange: WorkingSetChangeWire | null
  turns: Array<{ id: string; role: string; kind: string; content: Record<string, unknown> }>
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

let fusionDaemon: DaemonHandle
let intentDaemon: DaemonHandle
/** INTENT-X10 专用：它的 opencode 是一个会**追问**的替身，不是编译进 dist 的 stub。 */
let questionsDaemon: DaemonHandle | undefined
let shimDir: string | undefined

let ownerUser: SeededUser
let guestUser: SeededUser
let intentUser: SeededUser

let adminDupSkill: SkillRow
let ownerDupSkill: SkillRow
let soloSkill: SkillRow
let noSnapshotSkill: SkillRow
let approvedMemoryIds: string[] = []
let spareMemoryId = ''
let candidateMemoryId = ''
let launchedFusionId = ''

async function req(
  daemon: DaemonHandle,
  path: string,
  init?: RequestInit,
  token?: string,
): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token ?? daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function api<T>(
  daemon: DaemonHandle,
  path: string,
  init?: RequestInit,
  token?: string,
): Promise<T> {
  const res = await req(daemon, path, init, token)
  const body = await res.text()
  expect(res.ok, `${init?.method ?? 'GET'} ${path}: ${res.status} ${body}`).toBe(true)
  return body === '' ? (null as T) : (JSON.parse(body) as T)
}

/** 期望一次拒绝，并把状态码 + code 一起取回来（只断状态码等于把原因留在服务端）。 */
async function refusal(
  daemon: DaemonHandle,
  path: string,
  init: RequestInit,
  token?: string,
): Promise<{ status: number; code: string; message: string }> {
  const res = await req(daemon, path, init, token)
  const text = await res.text()
  let parsed: ErrorBody = {}
  try {
    parsed = JSON.parse(text) as ErrorBody
  } catch {
    parsed = {}
  }
  return { status: res.status, code: parsed.code ?? '', message: parsed.message ?? text }
}

async function seedUser(
  daemon: DaemonHandle,
  slug: string,
  role: 'user' | 'manager' | 'guest',
): Promise<SeededUser> {
  const username = `rfc319-ifg-${slug}`
  const displayName = `RFC319 IFG ${slug}`
  const created = await api<{ id: string }>(daemon, '/api/users', {
    method: 'POST',
    body: JSON.stringify({ username, displayName, role, password: PASSWORD }),
  })
  const login = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  })
  expect(login.ok, `login ${username}: ${login.status}`).toBe(true)
  const { sessionToken } = (await login.json()) as { sessionToken: string }
  return { username, displayName, userId: created.id, token: sessionToken }
}

async function seedSkill(
  daemon: DaemonHandle,
  name: string,
  bodyMd: string,
  token?: string,
): Promise<SkillRow> {
  return api<SkillRow>(
    daemon,
    '/api/skills',
    {
      method: 'POST',
      body: JSON.stringify({ name, description: 'RFC-319 intent/fusion fixture', bodyMd }),
    },
    token,
  )
}

async function skillContent(
  daemon: DaemonHandle,
  id: string,
  token?: string,
): Promise<SkillContentRow> {
  return api<SkillContentRow>(daemon, `/api/skills/${id}/content`, undefined, token)
}

/** 手工建的记忆初始恒为 candidate；approve 时再走一次 promote。 */
async function seedMemory(
  daemon: DaemonHandle,
  title: string,
  bodyMd: string,
  approve: boolean,
): Promise<string> {
  const created = await api<{ memory: { id: string } }>(daemon, '/api/memories', {
    method: 'POST',
    body: JSON.stringify({ scopeType: 'global', scopeId: null, title, bodyMd }),
  })
  if (approve) {
    await api(daemon, `/api/memories/${created.memory.id}/promote`, {
      method: 'POST',
      body: JSON.stringify({ action: 'approve' }),
    })
  }
  return created.memory.id
}

async function setSkillAcl(
  daemon: DaemonHandle,
  skillId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const current = await api<{ aclRevision: number }>(daemon, `/api/skills/${skillId}/acl`)
  await api(daemon, `/api/skills/${skillId}/acl`, {
    method: 'PUT',
    body: JSON.stringify({
      ...patch,
      expectedResourceId: skillId,
      expectedAclRevision: current.aclRevision,
    }),
  })
}

/** 技能在盘上的全部文件（相对路径 → 内容）。「一个字节都没动」按这个比。 */
function snapshotSkillFiles(daemon: DaemonHandle, skillId: string): Record<string, string> {
  const root = join(daemon.home, 'skills', skillId, 'files')
  const out: Record<string, string> = {}
  if (!existsSync(root)) return out
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else out[relative(root, full)] = readFileSync(full, 'utf8')
    }
  }
  walk(root)
  return out
}

function fusionOf(id: string): Promise<FusionWire> {
  return api<FusionWire>(fusionDaemon, `/api/fusions/${id}`)
}

async function listFusionIds(): Promise<string[]> {
  return (await api<FusionWire[]>(fusionDaemon, '/api/fusions')).map((f) => f.id)
}

async function listTaskIds(): Promise<string[]> {
  return (await api<Array<{ id: string }>>(fusionDaemon, '/api/tasks')).map((t) => t.id)
}

/**
 * 回答融合那一轮**强制**反问。
 *
 * 反问本身不是这条 spec 要覆盖的能力（e2e/clarify.spec.ts 已经锁住它），但它是
 * 产品的硬契约：merger 节点跑在强制 ask-back 模式下，第一轮直接出
 * `<workflow-output>` 会被以 `clarify-required-output-emitted` 当场判失败
 * （packages/system-mocks/src/runtime/mode-fusion.ts:43-52）。所以必须真答一次，
 * 融合才走得到待审批——`directive: 'stop'` 是把节点从强制反问里放出来的开关。
 */
async function answerFusionClarify(id: string): Promise<void> {
  let taskId: string | null = null
  await expect
    .poll(
      async () => {
        taskId = (await fusionOf(id)).currentTaskId
        return taskId !== null
      },
      { timeout: 120_000, message: `融合 ${id} 一直没有关联的引擎任务` },
    )
    .toBe(true)

  let session: { intermediaryNodeRunId: string; iteration: number } | null = null
  await expect
    .poll(
      async () => {
        const rows = await api<Array<{ intermediaryNodeRunId: string; iteration: number }>>(
          fusionDaemon,
          `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(String(taskId))}`,
        )
        session = rows[0] ?? null
        return session !== null
      },
      { timeout: 120_000, message: `融合 ${id} 的任务没有停在反问上` },
    )
    .toBe(true)

  const round = session as unknown as { intermediaryNodeRunId: string; iteration: number }
  await api(fusionDaemon, `/api/clarify/${round.intermediaryNodeRunId}/answers`, {
    method: 'POST',
    body: JSON.stringify({
      answers: [
        {
          questionId: 'q-merge',
          selectedOptionIndices: [0],
          selectedOptionLabels: [],
          customText: '',
        },
      ],
      directive: 'stop',
      ifMatchIteration: round.iteration,
    }),
  })
}

/** 等融合到某个状态。**连 error 一起报**，否则真正的原因只留在服务端。 */
async function waitForFusionStatus(id: string, expected: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const row = await fusionOf(id)
        return row.status === expected
          ? expected
          : `${row.status}: ${row.error ?? '(no error recorded)'}`
      },
      { timeout: 240_000 },
    )
    .toBe(expected)
}

async function openAs(
  browser: Browser,
  daemon: DaemonHandle,
  token: string,
): Promise<BrowserContext> {
  const context = await browser.newContext()
  await context.addInitScript(
    ([baseUrl, tok]) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', tok)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    [daemon.baseUrl, token] as const,
  )
  return context
}

async function openApp(
  page: Page,
  daemon: DaemonHandle,
  path: string,
  token?: string,
): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, tok }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', tok)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    { baseUrl: daemon.baseUrl, tok: token ?? daemon.token },
  )
  await page.goto(`${daemon.baseUrl}${path}`)
}

// ── 意图会话侧的夹具 ───────────────────────────────────────────────────────

function intentDetail(sessionId: string, token: string): Promise<IntentSessionDetailWire> {
  return api<IntentSessionDetailWire>(
    intentDaemon,
    `/api/intent-sessions/${sessionId}`,
    undefined,
    token,
  )
}

async function createIntentSession(message: string, token: string): Promise<string> {
  const created = await api<{ id: string }>(
    intentDaemon,
    '/api/intent-sessions',
    { method: 'POST', body: JSON.stringify({ message }) },
    token,
  )
  await expect
    .poll(async () => (await intentDetail(created.id, token)).session.inFlight, {
      timeout: 120_000,
      message: `会话 ${created.id} 的首轮生成一直没有收敛`,
    })
    .toBe(false)
  return created.id
}

/** 排一条**注定失败**的工作上下文变更：加一个本人看不见的私有代理。 */
async function stageDoomedWorkingSetChange(
  sessionId: string,
  hiddenAgentId: string,
  token: string,
): Promise<WorkingSetChangeWire> {
  const detail = await intentDetail(sessionId, token)
  return api<WorkingSetChangeWire>(
    intentDaemon,
    `/api/intent-sessions/${sessionId}/working-set`,
    {
      method: 'POST',
      body: JSON.stringify({
        clientMutationId: `rfc319ifg${Date.now()}${Math.floor(Math.random() * 1e6)}`,
        expectedTurnSeq: detail.session.turnSeq,
        expectedContextRevision: detail.session.contextRevision,
        mode: 'after-current',
        delta: { additions: [{ resourceType: 'agent', resourceId: hiddenAgentId }], removals: [] },
      }),
    },
    token,
  )
}

async function setAgentPublic(agentId: string): Promise<void> {
  const current = await api<{ aclRevision: number }>(intentDaemon, `/api/agents/${agentId}/acl`)
  await api(intentDaemon, `/api/agents/${agentId}/acl`, {
    method: 'PUT',
    body: JSON.stringify({
      visibility: 'public',
      expectedResourceId: agentId,
      expectedAclRevision: current.aclRevision,
    }),
  })
}

async function setIntentConfig(patch: Record<string, unknown>): Promise<void> {
  await api(intentDaemon, '/api/config', { method: 'PUT', body: JSON.stringify(patch) })
}

test.beforeAll(async () => {
  // `fusion` 是唯一能把一次融合推过 `running` 的 stub 模式：只有它会留下改过的
  // 技能文件 + `.agent-workflow/fusion/result.json` 清单。
  fusionDaemon = await startDaemon({ stubMode: 'fusion' })
  ownerUser = await seedUser(fusionDaemon, 'owner', 'user')
  guestUser = await seedUser(fusionDaemon, 'guest', 'guest')

  // 两个**同名**技能，属于两个不同的人。名字唯一索引是 (owner, name) 的，所以
  // 这在产品里是合法状态——正因为合法，下拉里才必须分得开。
  adminDupSkill = await seedSkill(
    fusionDaemon,
    DUP_SKILL_NAME,
    '# admin copy\n\nThe administrator-owned skill body.\n',
  )
  ownerDupSkill = await seedSkill(
    fusionDaemon,
    DUP_SKILL_NAME,
    '# owner copy\n\nThe owner-owned skill body.\n',
    ownerUser.token,
  )
  soloSkill = await seedSkill(fusionDaemon, SOLO_SKILL_NAME, '# solo\n\nUnique-named skill.\n')
  noSnapshotSkill = await seedSkill(
    fusionDaemon,
    NO_SNAPSHOT_SKILL_NAME,
    '# no snapshot\n\nSnapshot will be removed by the test.\n',
  )

  approvedMemoryIds = [
    await seedMemory(fusionDaemon, 'rfc319-ifg-approved-1', 'Always use two spaces.', true),
    await seedMemory(fusionDaemon, 'rfc319-ifg-approved-2', 'Prefer trailing commas.', true),
  ]
  spareMemoryId = await seedMemory(
    fusionDaemon,
    'rfc319-ifg-approved-3',
    'Group imports by origin.',
    true,
  )
  candidateMemoryId = await seedMemory(
    fusionDaemon,
    'rfc319-ifg-candidate',
    'Never reviewed by a human.',
    false,
  )

  // `intent` stub：确定性地产出一份 changeset。生成预算给足，INTENT-20 会自己
  // 把它调下来。
  intentDaemon = await startDaemon({
    stubMode: 'intent',
    configOverrides: { intentBuilderMaxGenerateRounds: 20 },
  })
  intentUser = await seedUser(intentDaemon, 'intent', 'user')
})

test.afterAll(async () => {
  if (fusionDaemon !== undefined) await fusionDaemon.stop()
  if (intentDaemon !== undefined) await intentDaemon.stop()
  if (questionsDaemon !== undefined) await questionsDaemon.stop()
  if (shimDir !== undefined) rmSync(shimDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// INTENT-49 —— 从记忆页批量勾选之后，选**哪个**技能
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-49: 从记忆页批量勾选后选目标技能——同名技能靠 owner 与短 id 消歧，融进去的是选中的那一个 @nightly', async ({
  page,
}) => {
  const launches: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/fusions') {
      launches.push(request.url())
    }
  })

  await openApp(page, fusionDaemon, '/memory?tab=all')
  await expect(page.getByTestId('memory-all-list')).toBeVisible({ timeout: 30_000 })

  const [first, second] = approvedMemoryIds
  await page.getByTestId(`memory-row-${first}-select`).check()
  await page.getByTestId(`memory-row-${second}-select`).check()
  await page.getByTestId('memory-fuse-button').click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('combobox').first().click()
  const listbox = page.getByRole('listbox')
  await expect(listbox).toBeVisible()

  // ① 两个同名技能都在列表里，而且**两行文字不一样**。
  // 这才是这条能力的核心：`FuseDialog.tsx:78-86` 只有在名字重复时才追加短 id，
  // 少了那一段，两行会渲染成逐字相同的字符串——用户面对两行一模一样的选项，
  // 选中哪一个纯属运气，而选错的后果是**改写了另一个人的技能正文**。
  const dupOptions = listbox.getByRole('option', { name: new RegExp(DUP_SKILL_NAME) })
  await expect(
    dupOptions,
    '同名的两个技能没有都出现在下拉里 ⇒ 有一个技能永远选不到，或者两个被合并成了一行',
  ).toHaveCount(2)
  const dupLabels = (await dupOptions.allInnerTexts()).map((s) => s.trim())
  expect(
    new Set(dupLabels).size,
    `同名技能的两行渲染成了逐字相同的文字（${JSON.stringify(dupLabels)}）⇒ ` +
      '用户只能靠猜，而猜错的那一次会把别人的技能正文改掉，界面全程不说一个字',
  ).toBe(2)

  const adminLabel = dupLabels.find((l) => l.includes('E2E Administrator'))
  const ownerLabel = dupLabels.find((l) => l.includes(ownerUser.displayName))
  expect(
    adminLabel,
    `同名行里认不出管理员那一份（${JSON.stringify(dupLabels)}）⇒ owner 没有被写进标签，` +
      '「按 owner 消歧」这件事根本没发生',
  ).toBeDefined()
  expect(
    ownerLabel,
    `同名行里认不出 ${ownerUser.displayName} 那一份（${JSON.stringify(dupLabels)}）⇒ 同上`,
  ).toBeDefined()
  // 重名时还会追加一段短 id 兜底（owner 的显示名本身也可能重复，或者 owner
  // 解析不出来时退化成 id 片段）。⚠️ 这一段**只**证明「重名分支触发了」，不能
  // 用它来分辨两行：`shortId` 取的是 ULID 的前 8 个字符，而 ULID 前 10 个字符
  // 是毫秒时间戳——同一批种出来的两个 id 在这 8 个字符上是**相同**的（实测）。
  // 真正把两行分开的是上面的 owner 名字。
  expect(
    ownerLabel,
    '重名时没有追加短 id ⇒ 一旦两个 owner 的显示名也一样（或解析不出来），' +
      '两行就又退回到「一模一样」',
  ).toContain(ownerDupSkill.id.slice(0, 8))
  expect(adminLabel).toContain(adminDupSkill.id.slice(0, 8))

  // ② 负向对照：名字**不重复**的技能不带短 id。
  // 少了这一条，上面的断言也可能只是「每一行都无条件缀了一个 id」——那不是消歧，
  // 是给所有人多看一串没意义的字符。
  const soloLabel = (
    await listbox.getByRole('option', { name: new RegExp(SOLO_SKILL_NAME) }).innerText()
  ).trim()
  expect(
    soloLabel,
    '名字唯一的技能也被缀上短 id ⇒ 短 id 是无条件加的，它并不表示「这里有重名」',
  ).not.toContain(soloSkill.id.slice(0, 8))
  expect(soloLabel, '唯一命名的技能连 owner 都没写 ⇒ 标签的组成规则不成立').toContain(
    'E2E Administrator',
  )

  // ③ 真的选**owner 那一份**并发起。按 owner 的显示名点——这正是用户在这一屏上
  // 唯一能用来分辨两行的信息。
  await listbox.getByRole('option', { name: new RegExp(ownerUser.displayName) }).click()
  await expect(listbox).toHaveCount(0)
  await dialog.getByTestId('fusion-intent').fill('RFC-319 INTENT-49: consolidate the two rules')
  await dialog.getByRole('button', { name: 'Start fusion', exact: true }).click()

  await page.waitForURL(/\/fusions\/[^/]+$/, { timeout: 60_000 })
  launchedFusionId = new URL(page.url()).pathname.split('/').pop() ?? ''
  expect(launchedFusionId, '发起之后没有落到这次融合自己的详情页').not.toBe('')
  expect(launches.length, '一次提交发了不止一个 POST /api/fusions ⇒ 同一批记忆被融了两遍').toBe(1)

  // ④ 服务端可核对的事实：融进去的是**选中的那个 id**，不是同名的另一个。
  // 这是整条用例的落点——标签分得开、发出去的 id 却是另一个，是最难被发现的错。
  const launched = await fusionOf(launchedFusionId)
  expect(
    launched.skillId,
    `选的是 ${ownerUser.displayName} 的那一份，融进去的却是另一个同名技能 ⇒ ` +
      '被改写的是一个用户从未选择过的技能正文，而它此后每次任务都会被读到',
  ).toBe(ownerDupSkill.id)
  expect(
    [...launched.memoryIds].sort(),
    '发起的融合带的记忆清单与勾选不符 ⇒ 技能正文会被一份用户没有选过的内容改写',
  ).toEqual([...approvedMemoryIds].sort())
})

// ---------------------------------------------------------------------------
// INTENT-X2 —— 技能详情页的融合入口按权限收放
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-X2: 没有 skills:update + tasks:execute 的账号，技能详情页既没有融合按钮也开不出 FuseDialog，服务端同口径拒绝 @nightly', async ({
  browser,
}) => {
  // guest 预设里既没有 skills:update 也没有 tasks:execute
  // （packages/shared/src/schemas/permission.ts 的 GUEST_BASELINE），但有
  // skills:read——把技能设成 public 之后他**看得见**这一页。这一点很关键：
  // 如果他连页面都打不开，「按钮不在」就退化成「什么都不在」，用例会假绿。
  await setSkillAcl(fusionDaemon, adminDupSkill.id, { visibility: 'public' })

  const guestCtx = await openAs(browser, fusionDaemon, guestUser.token)
  try {
    const guestPage = await guestCtx.newPage()
    await guestPage.goto(`${fusionDaemon.baseUrl}/skills/${adminDupSkill.id}`)

    // 「这一页真的加载出来了」的正向证据：标题就是这个技能的名字。
    await expect(
      guestPage.getByRole('heading', { name: DUP_SKILL_NAME }),
      'guest 连技能详情页都打不开 ⇒ 下面「按钮不在」证明不了任何事',
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      guestPage.getByTestId('skill-panel-edit'),
      '技能内容面板没渲染 ⇒ 同上，这一页并没有真的进到有内容的状态',
    ).toBeVisible()

    await expect(
      guestPage.getByRole('button', { name: 'Fuse memories', exact: true }),
      '没有 skills:update + tasks:execute 的人也看得到融合按钮 ⇒ 他点下去要先拉一次' +
        '记忆列表、开一个弹窗、填完意图，最后一步才吃 403；而这条路径会改写技能正文',
    ).toHaveCount(0)
    // FuseDialog 挂载与否唯一的用户面痕迹就是这个按钮（Dialog 在 open=false 时
    // 返回 null，见 components/Dialog.tsx:384）。所以这里再确认一次：整页都没有
    // 任何融合弹窗的躯干。
    await expect(
      guestPage.getByTestId('fusion-memory-picker'),
      'FuseDialog 的记忆选择器出现在没有权限的页面上 ⇒ 弹窗被挂上来了，' + '只差一个开关就能打开',
    ).toHaveCount(0)
    await expect(guestPage.getByRole('dialog')).toHaveCount(0)

    // 服务端那一半：按钮藏起来不是防线，端点自己也得拒。
    const refused = await refusal(
      fusionDaemon,
      '/api/fusions',
      {
        method: 'POST',
        body: JSON.stringify({
          skillId: adminDupSkill.id,
          memoryIds: [spareMemoryId],
          intent: 'RFC-319 INTENT-X2 probe',
        }),
      },
      guestUser.token,
    )
    expect(
      refused.status,
      'guest 直接打 POST /api/fusions 也能过 ⇒ 隐藏按钮只是化妆，任何人都能起一次' +
        '会改写托管技能正文的 agent 任务',
    ).toBe(403)
    expect(
      refused.code,
      `拒是拒了，却没说是因为权限（code=${refused.code}）⇒ 排查的人会先去怀疑技能 id`,
    ).toBe('forbidden')
    expect(
      refused.message,
      '拒绝里不点名缺的是哪一个权限点 ⇒ 管理员不知道该给这个账号加什么才能让他用起来',
    ).toContain('tasks:execute')
  } finally {
    await guestCtx.close()
  }

  // 正向对照：同一个页面、同一个技能，有权限的管理员看得到按钮，也真的打得开弹窗。
  // 少了这一步，上面三条 toHaveCount(0) 也可能只是因为按钮 / 选择器在**任何**
  // 情况下都不存在（改名、被删、testid 打错都会让它们恒为 0）。
  const adminCtx = await openAs(browser, fusionDaemon, fusionDaemon.token)
  try {
    const adminPage = await adminCtx.newPage()
    await adminPage.goto(`${fusionDaemon.baseUrl}/skills/${adminDupSkill.id}`)
    const button = adminPage.getByRole('button', { name: 'Fuse memories', exact: true })
    await expect(
      button,
      '有权限的账号也看不到融合按钮 ⇒ 这个入口对所有人都消失了，上面的「不挂载」' +
        '就不是权限的功劳',
    ).toBeVisible({ timeout: 30_000 })
    await button.click()
    await expect(
      adminPage.getByTestId('fusion-memory-picker'),
      '有权限的账号点了按钮也开不出弹窗 ⇒ FuseDialog 对谁都没挂上',
    ).toBeVisible()
  } finally {
    await adminCtx.close()
  }
})

// ---------------------------------------------------------------------------
// INTENT-60 —— 发起融合的三条前置拒绝
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-60: 发起融合的三条前置拒绝各说各的原因——记忆未批准 / 技能无版本快照 / 无写权限，且一条都没落库 @nightly', async () => {
  const fusionsBefore = await listFusionIds()
  // ③ 要的是「看得见但写不动」，所以先确保 ownerUser 看得见这个技能。写在本条
  // 用例里（而不是靠上一条留下的状态）：跨用例的隐式前提在 `-g` 单跑时会静默塌掉。
  await setSkillAcl(fusionDaemon, adminDupSkill.id, { visibility: 'public' })

  // ── ① 记忆未批准 ─────────────────────────────────────────────────────────
  // 未经人审的候选不该被融进技能正文（services/fusion.ts:593-595）。
  const notApproved = await refusal(fusionDaemon, '/api/fusions', {
    method: 'POST',
    body: JSON.stringify({
      skillId: soloSkill.id,
      memoryIds: [candidateMemoryId],
      intent: 'RFC-319 INTENT-60: unapproved memory',
    }),
  })
  expect(notApproved.status).toBe(409)
  expect(
    notApproved.code,
    '未经人审的候选也能被融进技能 ⇒ 一条没人看过的模型产出从此对所有任务生效',
  ).toBe('fusion-memory-not-approved')
  expect(
    notApproved.message,
    '拒绝里不点名是哪一条记忆 ⇒ 用户勾了十条时无从知道该去批准哪一条',
  ).toContain(candidateMemoryId)

  // ── ② 技能没有版本快照 ───────────────────────────────────────────────────
  // 融合的工作树是从**不可变版本快照**播种的（fusion.ts:1401-1407）；快照不在，
  // 只能拒——退回去读「当前文件」等于让 agent 基于一份没有版本身份的内容改写。
  const snapshotDir = join(
    fusionDaemon.home,
    'skills',
    noSnapshotSkill.id,
    'versions',
    `v${noSnapshotSkill.contentVersion}`,
    'files',
  )
  expect(
    existsSync(snapshotDir),
    `前提：新建技能应当带着 v${noSnapshotSkill.contentVersion} 快照，` +
      '否则下面「把它挪走」这一步没有意义',
  ).toBe(true)
  const stashed = `${snapshotDir}.rfc319-stashed`
  renameSync(snapshotDir, stashed)
  const unversioned = await refusal(fusionDaemon, '/api/fusions', {
    method: 'POST',
    body: JSON.stringify({
      skillId: noSnapshotSkill.id,
      memoryIds: [spareMemoryId],
      intent: 'RFC-319 INTENT-60: unversioned skill',
    }),
  })
  expect(unversioned.status).toBe(409)
  expect(
    unversioned.code,
    '技能没有版本快照也照样发起 ⇒ agent 基于一份来历不明的内容改写，' +
      '批准时的 OCC 也就没有可比对的基准',
  ).toBe('fusion-skill-unversioned')
  expect(
    unversioned.message,
    '拒绝里不说「缺哪一版、该怎么补」 ⇒ 用户只知道不能融，不知道存一次就能修好',
  ).toContain(`v${noSnapshotSkill.contentVersion}`)
  expect(unversioned.message).toContain('re-save')

  // ── ③ 没有写权限 ─────────────────────────────────────────────────────────
  // ownerUser 是普通用户：他**看得见**这个 public 技能（上一条用例把它设成了
  // public），但不是 owner、也没有 write 授权档 ⇒ 不能写它（fusion.ts:569-571）。
  const forbidden = await refusal(
    fusionDaemon,
    '/api/fusions',
    {
      method: 'POST',
      body: JSON.stringify({
        skillId: adminDupSkill.id,
        memoryIds: [spareMemoryId],
        intent: 'RFC-319 INTENT-60: no write access',
      }),
    },
    ownerUser.token,
  )
  expect(forbidden.status).toBe(409)
  expect(
    forbidden.code,
    '看得见就融得动 ⇒ 任何能读到某个 public 技能的人都可以起一次会改写它正文的' +
      'agent 任务，而技能的 owner 不会收到任何提示',
  ).toBe('fusion-skill-forbidden')

  // ③ 的对照：把 write 授权档发给同一个人，同一个请求就**换了一条拒绝理由**
  // （改为卡在全局作用域记忆的管理权上，services/memory.ts:806-813）。
  // 少了这一步，上面的 409 也可能只是「这个账号发起任何融合都会失败」。
  await setSkillAcl(fusionDaemon, adminDupSkill.id, {
    grants: [{ userId: ownerUser.userId, level: 'write' }],
  })
  const afterGrant = await refusal(
    fusionDaemon,
    '/api/fusions',
    {
      method: 'POST',
      body: JSON.stringify({
        skillId: adminDupSkill.id,
        memoryIds: [spareMemoryId],
        intent: 'RFC-319 INTENT-60: granted write access',
      }),
    },
    ownerUser.token,
  )
  expect(
    afterGrant.code,
    '拿到 write 授权档之后仍然报「不能写这个技能」 ⇒ 上一条 409 不是技能写权判出来的，' +
      '授权档在这条路径上根本没被读',
  ).toBe('fusion-memory-forbidden')

  // ── 零副作用 ─────────────────────────────────────────────────────────────
  // 四次拒绝之后，融合表里一条新行都不该有。发起会 mkdir 一个临时工作树、
  // 起一个引擎任务，任何一条拒绝漏到那之后都会留下垃圾目录与孤儿任务。
  expect(
    await listFusionIds(),
    '被拒的发起仍然落了库 ⇒ 融合列表里躺着一条永远跑不起来的行，' +
      '而它还会被待审计数与徽标算进去',
  ).toEqual(fusionsBefore)

  // ── 正向对照：把 ② 的快照放回去，同一个请求就通了 ─────────────────────────
  // 少了它，上面三条拒绝也可能只是「这个 daemon 里发起融合从来就不成功」。
  renameSync(stashed, snapshotDir)
  const accepted = await api<FusionWire>(fusionDaemon, '/api/fusions', {
    method: 'POST',
    body: JSON.stringify({
      skillId: noSnapshotSkill.id,
      memoryIds: [spareMemoryId],
      intent: 'RFC-319 INTENT-60: control launch',
    }),
  })
  expect(
    accepted.skillId,
    '快照放回去之后同一个请求还是发不起来 ⇒ 上面那条 fusion-skill-unversioned ' +
      '拒的不是「没有快照」这件事',
  ).toBe(noSnapshotSkill.id)
  // 立刻取消：这条对照只为证明「同样的请求本来是能过的」，它跑完整轮没有价值。
  await api(fusionDaemon, `/api/fusions/${accepted.id}/cancel`, { method: 'POST' })
})

// ---------------------------------------------------------------------------
// INTENT-59 —— 待审期间技能被别人改过
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-59: 融合待审期间技能被别人改过——批准与重跑双双 409，技能正文与版本号一个字节都没动 @nightly', async ({
  page,
}) => {
  // 前提写在最前面：这条用例拿的是 INTENT-49 发起的那次融合。上一条挂了的话，
  // 这里必须在它自己的第一行就说清「我红是因为上游没跑成」，而不是在下游某条
  // 断言上给出一个看不懂的 404。
  expect(
    launchedFusionId,
    '前提：INTENT-49 必须先成功发起一次融合，本条才有对象可做乐观锁实验',
  ).not.toBe('')
  await answerFusionClarify(launchedFusionId)
  await waitForFusionStatus(launchedFusionId, 'awaiting_approval')

  // 「别人」= 这个技能真正的 owner。他在自己的技能页上存了一版——这是产品里
  // 每天都会发生的事，而那一版必须活下来。
  const before = await skillContent(fusionDaemon, ownerDupSkill.id, ownerUser.token)
  const rivalBody = '# owner copy\n\nRewritten by the owner while the fusion was pending.\n'
  await api(
    fusionDaemon,
    `/api/skills/${ownerDupSkill.id}/save`,
    { method: 'POST', body: JSON.stringify({ bodyMd: rivalBody, expectedToken: before.token }) },
    ownerUser.token,
  )
  const rival = await skillContent(fusionDaemon, ownerDupSkill.id, ownerUser.token)
  expect(rival.contentVersion, '前提：owner 的这次保存应当把版本推到 2').toBe(
    before.contentVersion + 1,
  )
  const rivalFiles = snapshotSkillFiles(fusionDaemon, ownerDupSkill.id)
  const tasksBefore = await listTaskIds()
  const fusionBefore = await fusionOf(launchedFusionId)

  // ── ① 批准 ───────────────────────────────────────────────────────────────
  const approveStatuses: number[] = []
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.pathname === `/api/fusions/${launchedFusionId}/approve`) {
      approveStatuses.push(response.status())
    }
  })
  await openApp(page, fusionDaemon, `/fusions/${launchedFusionId}`)
  const approveButton = page.getByRole('button', { name: 'Approve & apply', exact: true })
  await expect(approveButton).toBeVisible({ timeout: 60_000 })
  await approveButton.click()

  // 页面上先有一条**看得见**的失败横幅。`fusion-precondition-stale` 在 i18n 里
  // 没有逐条条目，于是落在域级标题上（i18n/errors.ts 的三级查表 → errorDomains.fusion），
  // 具体原因收在可展开的「Raw error message」里——所以两处都要断：只断标题会
  // 放过「原因整段丢失」，只断原因会放过「横幅根本没渲染」。
  const approveBanner = page.locator('.error-box').first()
  await expect(
    approveBanner.getByText('Fusion action failed', { exact: false }),
    '批准被拒了，页面却什么都不说 ⇒ 用户以为自己没点中，会反复点；' +
      '真正的原因（技能被别人改过）只留在服务端日志里',
  ).toBeVisible({ timeout: 30_000 })
  await approveBanner.getByText('Raw error message', { exact: true }).click()
  await expect(
    approveBanner.getByText(
      'the target skill changed since this fusion started; re-initiate the fusion',
      { exact: false },
    ),
    '横幅展开之后仍然找不到具体原因 ⇒ 用户只看到「Fusion action failed」，' +
      '不知道是自己没权限、还是技能被人改过、还是这条融合早就作废了——三者的修法完全不同',
  ).toBeVisible()
  expect(
    approveStatuses,
    '待审期间技能被改过，批准却不是 409 ⇒ 一份基于旧版本算出来的整棵工作树会被' +
      '覆盖上去，owner 刚写的那一版当场消失',
  ).toEqual([409])

  // ── ② 零副作用：技能一个字节都没动 ────────────────────────────────────────
  const afterApprove = await skillContent(fusionDaemon, ownerDupSkill.id, ownerUser.token)
  expect(
    afterApprove.bodyMd,
    '被拒的批准仍然改了技能正文 ⇒ 409 只是回给调用方看的，写入其实已经发生',
  ).toBe(rivalBody)
  expect(
    afterApprove.contentVersion,
    '被拒的批准仍然推高了版本号 ⇒ 版本线上多出一格没有内容变化的「fusion」，' +
      '而 owner 的下一次保存会因为 token 变了而莫名 409',
  ).toBe(rival.contentVersion)
  expect(
    afterApprove.token,
    '复合 token 变了 ⇒ 说明 contentVersion / metaRevision 至少有一个被动过',
  ).toBe(rival.token)
  expect(
    snapshotSkillFiles(fusionDaemon, ownerDupSkill.id),
    '盘上的技能文件变了 ⇒ 「零副作用」不成立；下一次任务读到的就是这份被偷偷' + '覆盖过的内容',
  ).toEqual(rivalFiles)

  const afterApproveRow = await fusionOf(launchedFusionId)
  expect(
    afterApproveRow.status,
    '批准失败之后融合被推到了别的状态 ⇒ 用户失去了「改完再来一次」的机会，' + '只能重新发起一整轮',
  ).toBe('awaiting_approval')
  const stillApproved = await api<{ items: Array<{ id: string }> }>(
    fusionDaemon,
    '/api/memories?status=approved',
  )
  expect(
    stillApproved.items.map((m) => m.id),
    '记忆已经被标成 fused ⇒ 它们从此不再进任何 prompt，而那次融合根本没有落地',
  ).toEqual(expect.arrayContaining(approvedMemoryIds))

  // ── ③ 重跑（驳回）也必须在**任何副作用之前**被拦住 ────────────────────────
  // fusion.ts:1554-1558 的 claim 排在建工作树 / 起任务之前——排在之后就会留下
  // 一个跑起来的任务和一棵没人回收的工作树。
  const rejectStatuses: number[] = []
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.pathname === `/api/fusions/${launchedFusionId}/reject`) {
      rejectStatuses.push(response.status())
    }
  })
  await page.getByRole('button', { name: 'Request changes', exact: true }).click()
  await page
    .getByPlaceholder('What should the agent change?')
    .fill('RFC-319 INTENT-59: try to re-run against a changed skill.')
  await page.getByRole('button', { name: 'Send & re-run', exact: true }).click()

  const rejectBanner = page.getByRole('dialog').locator('.error-box').first()
  await expect(
    rejectBanner.getByText('Fusion action failed', { exact: false }),
    '重跑被拒了，弹窗里却什么都不说 ⇒ 用户会以为反馈已经发出去了，' +
      '然后一直等一轮永远不会开始的重跑',
  ).toBeVisible({ timeout: 30_000 })
  await rejectBanner.getByText('Raw error message', { exact: true }).click()
  await expect(
    rejectBanner.getByText(
      'the target skill changed since this fusion started; re-initiate the fusion',
      { exact: false },
    ),
    '弹窗里的报错展开之后也没有具体原因 ⇒ 用户只能反复点「Send & re-run」，' +
      '而每一次都会以同一条 409 收场',
  ).toBeVisible()
  expect(
    rejectStatuses,
    '待审期间技能被改过，重跑却不是 409 ⇒ 新一轮会以一份过期的基线开跑',
  ).toEqual([409])

  const afterReject = await fusionOf(launchedFusionId)
  expect(
    afterReject.iteration,
    '被拒的重跑仍然把迭代号推进了 ⇒ 页面上显示 Iteration 2，实际没有第二轮',
  ).toBe(fusionBefore.iteration)
  expect(
    afterReject.currentTaskId,
    '被拒的重跑改了当前任务指针 ⇒ 详情页会指向一个不存在 / 不相干的任务',
  ).toBe(fusionBefore.currentTaskId)
  expect(
    afterReject.status,
    '被拒的重跑把融合推去了 running ⇒ 它会一直「运行中」，而没有任何任务在跑',
  ).toBe('awaiting_approval')
  expect(
    await listTaskIds(),
    '被拒的重跑仍然起了一个引擎任务 ⇒ 一棵没人回收的工作树 + 一个跑完也无人认领' +
      '的任务，而 UI 上这次重跑「失败了」',
  ).toEqual(tasksBefore)
  expect(
    snapshotSkillFiles(fusionDaemon, ownerDupSkill.id),
    '重跑被拒之后技能文件仍然变了 ⇒ 播种工作树那一步跑到了 claim 前面',
  ).toEqual(rivalFiles)
})

// ---------------------------------------------------------------------------
// INTENT-25 —— 工作上下文刷新失败：告警 + 重试 / 丢弃
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-25: 工作上下文刷新失败后给告警与两条出路——重试能救回来，丢弃能把待处理的那条清掉 @nightly', async ({
  browser,
}) => {
  // 管理员建两个**私有**代理（RFC-231：创建路径恒为 creator-owner + private）。
  // 对 intentUser 来说它们不存在，于是把它们排进工作上下文注定失败
  // （services/intent/workingSet.ts:163-178 的 canViewResourceInTx）。
  const hidden: string[] = []
  for (const suffix of ['retry', 'discard']) {
    const agent = await api<{ id: string }>(intentDaemon, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-ifg-hidden-${suffix}`,
        description: 'RFC-319 hidden-scope fixture',
        outputs: ['answer'],
        readonly: true,
        bodyMd: 'fixture body',
      }),
    })
    hidden.push(agent.id)
  }
  const [hiddenForRetry, hiddenForDiscard] = hidden

  const sessionId = await createIntentSession(
    'rfc319-ifg: build an auditor agent for the working-context test',
    intentUser.token,
  )
  const failed = await stageDoomedWorkingSetChange(sessionId, hiddenForRetry!, intentUser.token)
  expect(
    failed.state,
    '一条引用了不可见资源的工作上下文变更竟然活化成功了 ⇒ 会话拿到了它本不该看到' +
      '的资源，这已经是一次越权读',
  ).toBe('failed')

  const context = await openAs(browser, intentDaemon, intentUser.token)
  try {
    const page = await context.newPage()
    await page.goto(`${intentDaemon.baseUrl}/intent/${sessionId}`)
    await expect(page.getByTestId('intent-build-workspace')).toBeVisible({ timeout: 30_000 })

    // ① 告警：状态徽标 + 旅程进度上的原因，两处都要说话。
    await expect(
      page.getByText('Refresh failed', { exact: true }),
      '刷新失败却不挂任何标记 ⇒ 顶部的「可用资源」看起来一切正常，' +
        '用户以为新挂的资源已经在了，下一轮生成其实完全没看到它',
    ).toBeVisible()
    await expect(
      page.getByTestId('intent-journey-state'),
      '旅程进度不把失败说出来 ⇒ 会话停在第二步不动，而进度条上写着「正在生成」',
    ).toContainText('The working-context refresh failed; adjust or retry it')

    // ② 出路之一：重试。先把资源变成他看得见的，再点重试——修好了就应该能救回来。
    const retryButton = page.getByRole('button', { name: 'Retry update', exact: true })
    await expect(
      retryButton,
      '失败了却不给重试入口 ⇒ 用户只能把整条变更删掉重排一遍，' +
        '而失败往往只是一次可修复的可见性问题',
    ).toBeVisible()

    await setAgentPublic(hiddenForRetry!)
    await retryButton.click()

    await expect
      .poll(async () => (await intentDetail(sessionId, intentUser.token)).workingSetChange?.state, {
        timeout: 120_000,
        message: '重试之后这条变更一直没有被活化',
      })
      .toBe('applied')
    const mountedAfterRetry = await intentDetail(sessionId, intentUser.token)
    expect(
      mountedAfterRetry.mounts.map((m) => m.resourceId),
      '重试报了成功，资源却没有真的挂进工作上下文 ⇒ 界面上的告警消失了，' +
        '下一轮生成依然看不到它',
    ).toContain(hiddenForRetry)
    await expect(
      page.getByRole('button', { name: 'Retry update', exact: true }),
      '救回来之后重试按钮还赖着不走 ⇒ 用户无从判断当前到底修好没有',
    ).toHaveCount(0, { timeout: 30_000 })
    await expect(page.getByText('Refresh failed', { exact: true })).toHaveCount(0)

    // ③ 出路之二：丢弃。再排一条注定失败的，这次不修，直接扔掉。
    await expect
      .poll(async () => (await intentDetail(sessionId, intentUser.token)).session.inFlight, {
        timeout: 120_000,
        message: '重试触发的那一轮生成一直没有收敛',
      })
      .toBe(false)
    const second = await stageDoomedWorkingSetChange(sessionId, hiddenForDiscard!, intentUser.token)
    expect(second.state, '前提：第二条变更也应当失败').toBe('failed')

    await expect(page.getByText('Refresh failed', { exact: true })).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('intent-add-mount').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(
      dialog.getByText('agent not found', { exact: false }),
      '弹窗里不写失败原因 ⇒ 用户不知道该改什么，只能把整条删掉重来',
    ).toBeVisible()
    const discard = dialog.getByRole('button', { name: 'Discard pending update', exact: true })
    await expect(
      discard,
      '待处理的变更没有丢弃入口 ⇒ 一条修不好的变更会永久卡在会话顶部，' +
        '而它同时挡住了下一条变更（services/intent/workingSet.ts:505-512）',
    ).toBeVisible()
    await discard.click()

    await expect
      .poll(async () => (await intentDetail(sessionId, intentUser.token)).workingSetChange?.state, {
        timeout: 60_000,
        message: '丢弃之后这条变更没有落到 canceled',
      })
      .toBe('canceled')
    await expect(
      page.getByText('Refresh failed', { exact: true }),
      '丢弃之后告警还在 ⇒ 用户以为还有东西没处理完',
    ).toHaveCount(0, { timeout: 30_000 })
    expect(
      (await intentDetail(sessionId, intentUser.token)).mounts.map((m) => m.resourceId),
      '被丢弃的那条变更竟然把资源挂上去了 ⇒ 「丢弃」把要删的东西加了进来',
    ).not.toContain(hiddenForDiscard)
  } finally {
    await context.close()
  }
})

// ---------------------------------------------------------------------------
// INTENT-20 —— 生成轮次预算耗尽
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-20: 生成轮次预算耗尽 → 409 点名 intentBuilderMaxGenerateRounds 或归档，把预算提上去之后同一条消息就发得出去 @nightly', async ({
  browser,
}) => {
  // 预算压到 1：新会话的首轮照跑（0 < 1），跑完就到顶。这是产品里真会有的配置
  // ——管理员为了控制成本把每个会话的轮数卡死。
  await setIntentConfig({ intentBuilderMaxGenerateRounds: 1 })
  const sessionId = await createIntentSession(
    'rfc319-ifg: build an auditor agent for the budget test',
    intentUser.token,
  )
  const before = await intentDetail(sessionId, intentUser.token)

  const context = await openAs(browser, intentDaemon, intentUser.token)
  try {
    const page = await context.newPage()
    // composer 的提交端点随「当前有没有草稿」在 /messages 与 /iterations 之间切换
    // （routes/intent.detail.tsx:104-129）。首轮已经产出了草稿，所以走的是
    // /iterations；两条都收进来，用例才不会因为这个分支静默漏记。
    const statuses: number[] = []
    const submitPaths = new Set([
      `/api/intent-sessions/${sessionId}/messages`,
      `/api/intent-sessions/${sessionId}/iterations`,
    ])
    page.on('response', (response) => {
      const url = new URL(response.url())
      if (response.request().method() === 'POST' && submitPaths.has(url.pathname)) {
        statuses.push(response.status())
      }
    })
    await page.goto(`${intentDaemon.baseUrl}/intent/${sessionId}`)
    await expect(page.getByTestId('intent-composer')).toBeVisible({ timeout: 30_000 })

    const composer = page.getByTestId('intent-composer')
    await composer.fill('rfc319-ifg: one more round please')
    await page.getByTestId('intent-composer-submit').click()

    // ① 报错要**点名旋钮**。只说「请求失败」等于让管理员在几十项设置里自己找。
    // `intent-*` 这一族在 i18n/errors.ts 的 DOMAIN_PREFIXES 里没有条目，于是标题
    // 落在 `errorDomains.misc`（"Request failed"），真正的话收在可展开的
    // 「Raw error message」里——两处都要断：只断标题会放过「原因整段丢失」，
    // 只断原因会放过「横幅根本没渲染」。
    const banner = page.locator('.intent-session__composer .error-box').first()
    await expect(
      banner,
      '预算耗尽了，composer 旁边却没有任何报错 ⇒ 用户点了发送、界面纹丝不动，' +
        '他只会以为是网络慢，然后一直点',
    ).toBeVisible({ timeout: 30_000 })
    await banner.getByText('Raw error message', { exact: true }).click()
    await expect(
      banner.getByText('raise intentBuilderMaxGenerateRounds or archive', { exact: false }),
      '预算耗尽的报错不点名该调哪一项 ⇒ 会话从此发不出任何消息，' +
        '管理员只看到「Request failed」，既不知道调哪一项，也不知道归档是另一条出路',
    ).toBeVisible()
    await expect(
      banner.getByText('session reached its generation budget (1)', { exact: false }),
      '报错里不写当前预算值 ⇒ 用户不知道自己现在卡在几轮上，也就无从判断该调到多少',
    ).toBeVisible()
    expect(
      statuses,
      `预算耗尽时 POST /messages 不是 409（实得 ${JSON.stringify(statuses)}）⇒ ` +
        '要么预算根本没生效、要么这条消息真的又起了一轮子进程',
    ).toEqual([409])

    // ② 零副作用：被拒的那一条消息不该在时间线上留下任何轮次。
    const afterRefusal = await intentDetail(sessionId, intentUser.token)
    expect(
      afterRefusal.turns.length,
      '被拒的消息仍然在时间线上留了一轮 ⇒ 用户看到自己的话已经发出去了，' + '却永远等不到回应',
    ).toBe(before.turns.length)
    expect(
      afterRefusal.session.inFlight,
      '被拒之后会话被标成「生成中」 ⇒ 它会永远转圈，连归档按钮都点不动' +
        '（归档在 inFlight 时是禁用的）',
    ).toBe(false)

    // ③ 报错给的那条出路必须真的管用：把预算提上去，同一条消息就发得出去。
    // 少了这一步，上面的文案断言只是在核对一句话，没有核对这句话是不是真的。
    await setIntentConfig({ intentBuilderMaxGenerateRounds: 20 })
    await page.getByTestId('intent-composer-submit').click()
    await expect
      .poll(() => statuses.length, { timeout: 30_000, message: '第二次提交没有发出请求' })
      .toBe(2)
    expect(
      statuses[1],
      '按报错说的把 intentBuilderMaxGenerateRounds 调高之后还是被拒 ⇒ ' +
        '那句提示指的不是这个旋钮，用户照做也走不出去',
    ).toBe(202)
    await expect
      .poll(async () => (await intentDetail(sessionId, intentUser.token)).turns.length, {
        timeout: 120_000,
        message: '提高预算之后这条消息仍然没有变成一轮真实的对话',
      })
      .toBeGreaterThan(before.turns.length)
  } finally {
    await context.close()
  }
})

// ---------------------------------------------------------------------------
// INTENT-X10 —— 追问轮次预算耗尽
// ---------------------------------------------------------------------------

// 一个**会追问**的 opencode 替身。
//
// 为什么必须自己写：`AW_STUB_MODE=intent` 的编译替身只会产出 changeset
// （packages/system-mocks/src/runtime/mode-intent.ts:214-216），仓内**没有任何**
// 模式会在意图信封里发 `<port name="questions">`，于是
// `services/intent/turnEngine.ts:770-805` 的整条追问分支在 e2e 里不可达。
// RFC-319 明令不改生产代码（packages 下的 src 树，含 system-mocks），所以这里在
// 临时目录里现写一个只服务这条用例的替身。
//
// 它的 CLI 契约照 `packages/system-mocks/src/runtime/skeleton.ts` 抄：
//   * `--version` 退出 0（探测只要求这一点，见 services/runtime/opencode/util.ts:76-86）；
//   * 提示词是 `--` 之后的那一个位置参数（skeleton.ts:63-70）；
//   * nonce 取提示词里**最后**一次 `nonce="…"`（skeleton.ts:136-140）；
//   * stdout 是一行 `{"type":"text",…}` 事件（skeleton.ts:173-177）。
function writeQuestionsShim(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rfc319-ifg-shim-'))
  shimDir = dir
  const shim = join(dir, 'opencode-questions.mjs')
  writeFileSync(
    shim,
    `#!/usr/bin/env node
const argv = process.argv.slice(2)
const head = argv[0] ?? ''
if (head === '--version' || head === '-v' || head === 'version') {
  process.stdout.write('stub-opencode rfc319-questions\\n')
  process.exit(0)
}
let seenSeparator = false
let prompt = ''
for (const arg of argv) {
  if (seenSeparator) { prompt = arg; break }
  if (arg === '--') seenSeparator = true
}
const matches = [...prompt.matchAll(/nonce="([^"]*)"/g)]
const nonce = matches.length === 0 ? '' : (matches[matches.length - 1][1] ?? '')
if (nonce === '') {
  process.stderr.write('rfc319-questions: prompt is missing the RFC-200 envelope nonce\\n')
  process.exit(3)
}
const questions = JSON.stringify([
  {
    id: 'q1',
    question: 'Which runtime should the auditor agent target?',
    options: ['opencode', 'claude-code'],
    multiSelect: false,
  },
])
const text =
  '<workflow-output nonce="' + nonce + '">\\n' +
  '  <port name="summary">rfc319 questions stub: blocked on one decision</port>\\n' +
  '  <port name="questions">' + questions + '</port>\\n' +
  '</workflow-output>'
process.stdout.write(
  JSON.stringify({ type: 'text', timestamp: 0, part: { type: 'text', text } }) + '\\n',
)
process.exit(0)
`,
    'utf8',
  )
  chmodSync(shim, 0o755)
  return shim
}

test('RFC-319 INTENT-X10: 追问轮次预算耗尽——AI 再追问一次就被 intent-question-budget-exhausted 截停，预算够时同一轮追问照常落地 @nightly', async ({
  browser,
}) => {
  const shim = writeQuestionsShim()
  // 只有这条用例换运行时：其余用例仍然跑编译好的 stub。
  questionsDaemon = await startDaemon({
    runtimeMode: 'live',
    runtimeBinaries: { opencode: shim, claudeCode: shim },
    runtimeModels: { opencode: 'test/model' },
    configOverrides: {
      intentBuilderMaxGenerateRounds: 20,
      // 0 = 一次追问都不许：模型第一次追问就该被截停。
      intentBuilderMaxQuestionRounds: 0,
    },
  })
  const daemon = questionsDaemon

  const cutOff = await api<{ id: string }>(daemon, '/api/intent-sessions', {
    method: 'POST',
    body: JSON.stringify({ message: 'rfc319-ifg: the model will keep asking questions' }),
  })
  await expect
    .poll(
      async () =>
        (await api<IntentSessionDetailWire>(daemon, `/api/intent-sessions/${cutOff.id}`)).session
          .inFlight,
      { timeout: 120_000, message: '被截停的那一轮一直没有收敛' },
    )
    .toBe(false)

  const cutOffDetail = await api<IntentSessionDetailWire>(
    daemon,
    `/api/intent-sessions/${cutOff.id}`,
  )
  const lastTurn = [...cutOffDetail.turns].reverse().find((turn) => turn.role === 'agent')
  expect(
    lastTurn?.kind,
    '追问预算是 0，这一轮却仍然以「问题」收场 ⇒ 预算旋钮形同虚设，' +
      '模型可以无限追问，每一轮都真的起一次子进程',
  ).toBe('error')
  expect(
    lastTurn?.content.code,
    '截停了却不说是因为追问预算 ⇒ 用户看到的是一个没有原因的失败轮次，' +
      '既不知道该调哪一项，也会以为是模型崩了',
  ).toBe('intent-question-budget-exhausted')

  const context = await openAs(browser, daemon, daemon.token)
  try {
    const page = await context.newPage()
    await page.goto(`${daemon.baseUrl}/intent/${cutOff.id}`)
    await expect(page.getByTestId('intent-build-workspace')).toBeVisible({ timeout: 30_000 })
    // 截停原因在这一轮的卡片上出现两处：可见的状态徽标（intent.detail.tsx:1226）
    // 与诊断块里的 <strong>。这里断徽标——它是用户不用展开任何东西就看得到的那一份。
    await expect(
      page.getByTestId('intent-turn-error').locator('.status-chip--danger'),
      '被截停的轮次在页面上不写出截停原因 ⇒ 用户对着一个空白的失败轮次，' + '只能重试到再次失败',
    ).toHaveText('intent-question-budget-exhausted')
    await expect(
      page.getByTestId('intent-current-action'),
      '被截停的那一轮仍然把问题摆出来让人回答 ⇒ 用户答完之后才发现这一轮早就作废了',
    ).toHaveCount(0)
  } finally {
    await context.close()
  }

  // 正向对照：同一个替身、同一段提示词，把追问预算放到 1，这一轮就是真的追问。
  // 少了这一条，上面的 error 也可能只是「这个替身产出的信封本来就不合法」。
  await api(daemon, '/api/config', {
    method: 'PUT',
    body: JSON.stringify({ intentBuilderMaxQuestionRounds: 1 }),
  })
  const allowed = await api<{ id: string }>(daemon, '/api/intent-sessions', {
    method: 'POST',
    body: JSON.stringify({ message: 'rfc319-ifg: one question is within budget' }),
  })
  await expect
    .poll(
      async () =>
        (await api<IntentSessionDetailWire>(daemon, `/api/intent-sessions/${allowed.id}`)).session
          .inFlight,
      { timeout: 120_000, message: '对照会话的那一轮一直没有收敛' },
    )
    .toBe(false)
  const allowedDetail = await api<IntentSessionDetailWire>(
    daemon,
    `/api/intent-sessions/${allowed.id}`,
  )
  const allowedTurn = [...allowedDetail.turns].reverse().find((turn) => turn.role === 'agent')
  expect(
    allowedTurn?.kind,
    '把追问预算放到 1 之后同一轮仍然被判 error ⇒ 上面那次截停不是预算判出来的，' +
      '这个替身的信封根本就没被当成追问',
  ).toBe('questions')
})
