// RFC-319 —— 记忆（MEM）与工作组（WG）两个域里「东西真的落库 / 真的被读出来」的那几条。
//
// 覆盖能力账本行：MEM-X9 / MEM-40 / MEM-X8 / MEM-44 / WG-46 / WG-X4 / WG-39 / WG-40 / WG-X3。
//
// 为什么这九条值得一条用例（每条断言红掉时用户会遭遇什么）：
//
//  MEM-X9  记忆是**会被塞进下一次 agent 运行**的内容。global 那一档已经被
//          e2e/runtime-scenario-matrix.spec.ts:524 走过真实 runtime 提示词了，但**另外四档
//          （agent 闭包 / workflow / repo / repo_group）在浏览器 e2e 里一条都没有**——它们只有
//          内存 DB 单测（packages/backend/tests/memory-inject.test.ts、
//          rfc248-memory-inject-repo-group.test.ts）。这四档任何一档静默失效，用户看到的
//          现象是「我给这个 agent / 这个仓 / 这个组挂的规矩，模型完全没照做」，而界面上
//          没有任何异常。反过来，多注入一档（例如把「只注入本任务的仓」放宽成「所有仓」）
//          就是把别的项目的规矩塞进这次运行——同样无声。
//  MEM-40  预算裁剪是**静默丢内容**的唯一一处：超预算的旧记忆被 clipByBudget 丢掉，模型
//          没看到，用户却在 /memory 里明明看得到它是 approved。节点会话页那张快照卡是
//          「这次到底看到了哪几条」的唯一读面；它要是照着 `/api/memories` 画（而不是照着
//          node_runs.injected_memories_json 画），裁剪就永远看不见。
//  MEM-X8  蒸馏队列的三个来源里，feedback 那一路已被 e2e/task-feedback-distill.spec.ts 锁住，
//          **clarify 与 review 两路没有任何 e2e**。它们断掉的形态是：人答了反问、人做了评审
//          决定，这两处最有价值的经验一条都不进蒸馏——队列看起来一直是空的，没有人会觉得
//          不对劲。
//  MEM-44  提交反馈失败时若不给横幅，用户点了「提交」什么都没发生；若失败还顺手清空草稿，
//          他刚写的那段话当场消失且服务端也没有。
//  WG-46   任务收场之后房间必须只读。composer 不禁用 ⇒ 用户对着一个已经结束的任务打字、
//          点发送、吃一个 409；服务端那道闸若也没了 ⇒ 消息真的写进了一个没有引擎会再读的
//          房间，复盘的人以为那条话被人看见过。
//  WG-X4  组名是**启动时冻结**的：任务列表显示的必须是启动那一刻的名字，而不是现在的组名。
//          改成实时 join 有两个后果——①改一次组名，历史任务的记录集体改写，事后无法对上；
//          ②把组的当前名字泄露给只是任务成员、并没有工作组可见性的人（RFC-099）。
//          另一半是韧性：冻结的 JSON 坏了要降级成 null，而不是让整张任务列表 5xx。
//  WG-39  awaiting_human 有两种完全不同的成因：等人回答，和 max-rounds 收尾停机。徽章统一
//          写「等待人工」之后，房间这张说明卡是唯一能区分它们的地方——不区分的话，触顶停机
//          会被读成「有问题等着我答」，用户在房间里干等一个永远不会来的问题。
//  WG-40  free_collab 的 max_rounds 计的是**成员 run 总数**、不再以「第 X 回合」出现在消息流里，
//          于是右栏那条预算读数是用户唯一能看到「还剩多少额度」的地方；共享任务列表卡同理，
//          是 fc 模式下「活儿被谁认走了、是不是一批跑的」的唯一读面。
//  WG-X3  工作组任务详情页的页签集合是**按模式换的**：回合引擎组没有画布（宿主图不是观测面）、
//          没有 outputs（RFC-184 起宿主 run 不落声明产出，页签点进去必然是空的）；动态工作流组
//          反过来没有聊天室、多一张编排页。搞反了 ⇒ 用户点进去看到的是永远空白的面板。
//
// 判据取自源码单一事实源（纯文本引用，勿改成外链）：
//   packages/backend/src/modules/memory/application/injection/injectMemory.ts（loadInjectableMemories）        loadInjectableMemories 五档各自的 WHERE
//   packages/backend/src/modules/memory/application/injection/injectMemory.ts（agent 档）        agent 档吃的是**闭包**（agentIds 复数）
//   packages/backend/src/modules/memory/application/injection/injectMemory.ts（repo_group 档）        repo_group 档：只有用组启动才查
//   packages/backend/src/modules/memory/domain/injectionRendering.ts（formatMemoryBlockWithSnapshot）        formatMemoryBlockWithSnapshot：逐档 clip
//   packages/backend/src/modules/memory/application/injection/injectMemory.ts:393-408        clipByBudget：首次溢出即截断
//   packages/backend/src/modules/memory/application/injection/injectMemory.ts:441-516        injectMemoryForRun：task_repos 取**全部**成员仓
//   packages/backend/src/modules/memory/application/injection/injectMemory.ts:496-500        单仓直启不注入组记忆
//   packages/backend/src/services/task.ts:6296                   node-runs 投影出 injectedMemories
//   packages/frontend/src/lib/injected-memories-card.ts:21-27    decideStatus 三支
//   packages/frontend/src/lib/injected-memories-card.ts:40-55    SCOPE_ORDER / groupByScope
//   packages/frontend/src/lib/injected-memories-card.ts:63-67    previewOf 的 200 字截断
//   packages/frontend/src/components/node-session/InjectedMemoriesCard.tsx:44-121  卡片三态与分档
//   packages/backend/src/services/clarify/autoDispatch.ts:342-350 反问整轮封存后 enqueue（仅 self 轮）
//   packages/backend/src/services/review.ts:3026-3032            评审决定提交后 enqueue
//   packages/backend/src/modules/memory/application/distill/schedule.ts:90-125 enqueueDistillJob 与 debounceKey
//   packages/frontend/src/components/tasks/TaskFeedbackList.tsx:75-79,175-183  失败横幅与「成功才清草稿」
//   packages/backend/src/services/workgroup/taskActions.ts:186-188 终态任务发消息 409 workgroup-task-terminal
//   packages/frontend/src/lib/workgroup-room.ts:461-463          canPostRoomMessage 的终态判据
//   packages/frontend/src/components/workgroup/room/RoomComposer.tsx:167-170,238-250 composer 禁用 / 两条互斥提示
//   packages/backend/src/services/task.ts:6782-6794              frozenWorkgroupName：读任务自己的冻结 JSON，坏了给 null
//   packages/frontend/src/components/TaskSubjectLink.tsx:105-118 冻结名 → /workgroups/$id；名字为空给破折号
//   packages/frontend/src/lib/workgroup-room.ts:94-109           pauseReasonCopyKey 五档 + 未知 → null
//   packages/frontend/src/components/workgroup/room/RoomSideCards.tsx:206-214 成因卡的渲染闸
//   packages/frontend/src/components/workgroup/room/RoomSideCards.tsx:320-333 fc 的预算读数
//   packages/frontend/src/components/workgroup/room/FcTaskListCard.tsx:20-77  三分组 + 同批 ×N 徽记
//   packages/frontend/src/lib/workgroup-room.ts:461-463          fc 卡片列表的 mode 闸（RoomSideCards.tsx:255-263）
//   packages/frontend/src/lib/task-detail-tabs.ts:206-232        两套页签顺序常量
//   packages/frontend/src/lib/task-detail-tabs.ts:262-291        capability 过滤
//   packages/frontend/src/lib/task-detail-route-tabs.ts:107-140  默认页签（chatroom / dw 相位驱动）
//
// **刻意不重复**（已被别处锁住，本文件只当夹具用）：
//   · MEM-43 / MEM-X10 / MEM-X4 的深链一格 —— e2e/task-feedback-distill.spec.ts（HUMAN-47/X6）
//     已经把「写下去真的排进蒸馏」「看不见 vs 不存在逐字节同形」「深链落到具体那一条」全锁了；
//     MEM-44 的 3 秒限流那半边也在那里。本文件的 MEM-44 只补它没做的那半边（失败横幅 + 草稿不丢）。
//   · MEM-21 / MEM-X2 / MEM-X3 —— e2e/fusion-review-surface.spec.ts:285/427/469/521 已覆盖
//     （融合分区列表 + 空/错态 + 徽章、带反馈驳回触发下一轮、两步确认取消）。
//   · MEM-49 的设置页那半边 —— e2e/rfc319-settings-config-sections.spec.ts 的 CFG-21 已覆盖
//     （Memory distill runtime + settings-memory-distill-lang-select 一次保存落库 + 回显）。
//   · WG-34 的「终态不许改配置 409」 —— e2e/rfc319-workgroup-launch-and-config.spec.ts:1306。
//     本文件 WG-46 走的是**另一条**闸（taskActions.ts 的 postRoomMessage）。
//   · 房间发言 / 派单 / 交付 / 完成门 —— e2e/rfc319-workgroup-room-and-delivery.spec.ts。
//
// **本文件不用 `test.describe.configure({ mode: 'serial' })`**（变异验证要按「红了几条」归因，
// serial 会让第一条红之后其余 did not run）；每条用例自带自己的任务夹具，只共享 daemon 与
// 资源（agent / workflow / 仓库组 / 工作组），共享的部分全部在 beforeAll 里一次建好。
//
// **已知缺陷，本文件如实绕开而不锁死**（RFC-319 起草时实测，另在交付说明里汇报）：
//   · **D1 —— 注入快照卡的 `repo_group` 分档没有 i18n 文案。**
//     `packages/frontend/src/lib/injected-memories-card.ts:40` 的 `SCOPE_ORDER` 自 RFC-248
//     起就是五档（含 `repo_group`），`InjectedMemoriesCard.tsx:66-72,100-106` 按
//     `nodeDrawer.injectedMemoriesGroup_${scope}` 取文案，但 `i18n/en-US.ts:6729-6732` 与
//     `i18n/zh-CN.ts:12855-12858` 都只有 agent / workflow / repo / global **四条**。于是
//     用仓库组启动的任务，那一档的 chip 与小标题直接把原始 key
//     `nodeDrawer.injectedMemoriesGroup_repo_group` 打在界面上。组件里那处 `as` 联合类型
//     也只列了四个字面量，正是漏掉这一档的同源证据。本文件因此只断言结构 class
//     （`.injected-memories-card__group--repo_group`），不断言文案。
//   · **D2 —— 「同批 ×N」徽记在 showcase 的自由协作场景下够不到。**
//     `FcTaskListCard.tsx:56` 要求两张卡共用同一个 `nodeRunId`，而实测这套夹具跑出来的
//     三张卡各自独占一个 run（每次批量认领都是 batch of 1）。WG-40 因此把判据写成
//     「徽记数 == 共用 run 的卡数」——它在这套夹具上锁住的是**反方向**（判据写成 `>= 1`
//     会给每一张卡挂上「同批 ×1」，当场变红，已实测），正向那一半如实登记为未覆盖。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'

import { seedShowcase, type ShowcaseSeedResult } from '../examples/workgroups/showcase/seed'
import { initGitRepo, querySqlite, repoRemoteUrl, runSqlite } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(300_000)

// 拆环境前先把在飞的 route handler 等完（docs/dev-gotchas.md §「e2e 里凡是 page.route 拦 API 的」）。
// 必须是 'wait'：'ignoreErrors' 只是把错吞掉，等于「重跑就过了」。
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' })
})

// ---------------------------------------------------------------------------
// 通用 HTTP / 断言小工具
// ---------------------------------------------------------------------------

interface TaskRow {
  id: string
  status: string
  workgroupId?: string | null
  workgroupName?: string | null
  errorMessage?: string | null
}

interface InjectedMemory {
  id: string
  version: number
  scopeType: string
  scopeId: string | null
  title: string
  bodyMd: string
  tags: string[]
  sourceKind: string
}

interface NodeRunRow {
  id: string
  nodeId: string
  status: string
  retryIndex: number
  injectedMemories: InjectedMemory[] | null
}

interface DistillJobRow {
  id: string
  debounceKey: string
  sourceKind: string
  sourceEventId: string
  taskId: string | null
  status: string
}

async function rawReq(d: DaemonHandle, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${d.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${d.token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
}

async function api<T>(
  d: DaemonHandle,
  path: string,
  init: RequestInit = {},
  what = path,
): Promise<T> {
  const res = await rawReq(d, path, init)
  const text = await res.text()
  expect(res.ok, `${what}: HTTP ${res.status} ${text}`).toBe(true)
  return (text === '' ? undefined : JSON.parse(text)) as T
}

/** 拒绝路径要的是状态码 + 错误码，所以单独一条不做 ok 断言的读法。 */
async function rejection(
  d: DaemonHandle,
  path: string,
  init: RequestInit,
): Promise<{ status: number; code: string | null; text: string }> {
  const res = await rawReq(d, path, init)
  const text = await res.text()
  let code: string | null = null
  try {
    code = (JSON.parse(text) as { code?: string }).code ?? null
  } catch {
    code = null
  }
  return { status: res.status, code, text }
}

async function primeAuth(page: Page, d: DaemonHandle): Promise<void> {
  await page.addInitScript(
    ([baseUrl, token]) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    [d.baseUrl, d.token] as const,
  )
}

async function waitTask(
  d: DaemonHandle,
  taskId: string,
  predicate: (t: TaskRow) => boolean,
  message: string,
  timeout = 120_000,
): Promise<TaskRow> {
  let last: TaskRow | null = null
  try {
    await expect
      .poll(
        async () => {
          last = await api<TaskRow>(d, `/api/tasks/${taskId}`)
          return predicate(last)
        },
        { message, timeout, intervals: [300] },
      )
      .toBe(true)
  } catch (error) {
    throw new Error(`${message}（最后一次读到 ${JSON.stringify(last)}）`, { cause: error })
  }
  return last as unknown as TaskRow
}

/** 26 位 Crockford base32、首字符 0-7 —— 工作组写操作的 clientMutationId 形状。 */
function mutationId(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let out = String(Math.floor(Math.random() * 8))
  for (let i = 1; i < 26; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
}

async function nodeRunsOf(d: DaemonHandle, taskId: string): Promise<NodeRunRow[]> {
  const data = await api<{ runs: NodeRunRow[] }>(d, `/api/tasks/${taskId}/node-runs`)
  return data.runs
}

function makeFixtureRepo(tag: string, scratch: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), `rfc319-memwg-${tag}-`))
  scratch.push(dir)
  writeFileSync(join(dir, 'README.md'), `# rfc319 ${tag} fixture\n`, 'utf-8')
  initGitRepo(dir)
  return dir
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

// ===========================================================================
// 记忆域 —— daemon A（basic stub；蒸馏 worker 关掉，让队列行停在 pending 可读）
// ===========================================================================

let memDaemon: DaemonHandle
const memScratch: string[] = []
/** 被 workflow 节点直接引用的主 agent。 */
let primaryAgentId = ''
/** 主 agent 的 dependsOn 闭包成员——记忆挂在**它**身上，用来锁闭包那一支。 */
let closureAgentId = ''
/** 与本次运行毫无关系的第三个 agent，用作诱饵。 */
let decoyAgentId = ''
let memWorkflowId = ''
/** 仅 MEM-40 用的一套（agent + workflow），避免与 MEM-X9 的记忆互相串档。 */
let cardAgentId = ''
let cardWorkflowId = ''
let repoGroupId = ''
/** 组内第一个成员仓（挂在根）。 */
let cachedRepoRootId = ''
/** 组内第二个成员仓（挂在 vendor/sdk）——记忆挂在**它**身上。 */
let cachedRepoNestedId = ''
/** 已进镜像池但**不在组里**的第三个仓，用作诱饵。 */
let cachedRepoOutsideId = ''

async function createAgent(name: string, dependsOn: string[]): Promise<string> {
  const created = await api<{ id: string }>(
    memDaemon,
    '/api/agents',
    {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: 'RFC-319 memory-inject fixture agent',
        outputs: ['answer'],
        outputKinds: { answer: 'string' },
        readonly: true,
        dependsOn,
        bodyMd: 'Fixture agent; the compiled stub produces the envelope.',
      }),
    },
    `create agent ${name}`,
  )
  return created.id
}

async function createLinearWorkflow(
  name: string,
  agentId: string,
  agentName: string,
): Promise<string> {
  const created = await api<{ id: string }>(
    memDaemon,
    '/api/workflows',
    {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: 'RFC-319 memory-inject fixture workflow',
        definition: {
          $schema_version: 2,
          inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
            {
              id: 'agent_1',
              kind: 'agent-single',
              agentId,
              agentName,
              promptTemplate: 'Work on {{topic}}.',
              position: { x: 320, y: 0 },
            },
            {
              id: 'out_1',
              kind: 'output',
              ports: [{ name: 'answer', bind: { nodeId: 'agent_1', portName: 'answer' } }],
              position: { x: 640, y: 0 },
            },
          ],
          edges: [
            {
              id: 'e_in_agent',
              source: { nodeId: 'in_1', portName: 'topic' },
              target: { nodeId: 'agent_1', portName: 'topic' },
            },
            {
              id: 'e_agent_out',
              source: { nodeId: 'agent_1', portName: 'answer' },
              target: { nodeId: 'out_1', portName: 'answer' },
            },
          ],
        },
      }),
    },
    `create workflow ${name}`,
  )
  return created.id
}

/**
 * 手工建的记忆恒为 candidate（services/memory.ts:152-200 没有跳过人审的捷径），
 * 所以每一条要进注入面的都要再走一次 promote。
 */
async function seedApprovedMemory(input: {
  scopeType: string
  scopeId: string | null
  title: string
  bodyMd: string
  approve?: boolean
}): Promise<string> {
  const created = await api<{ memory: { id: string; status: string } }>(
    memDaemon,
    '/api/memories',
    {
      method: 'POST',
      body: JSON.stringify({
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        title: input.title,
        bodyMd: input.bodyMd,
      }),
    },
    `create memory ${input.title}`,
  )
  if (input.approve !== false) {
    await api(
      memDaemon,
      `/api/memories/${created.memory.id}/promote`,
      { method: 'POST', body: JSON.stringify({ action: 'approve' }) },
      `approve memory ${input.title}`,
    )
  }
  return created.memory.id
}

test.beforeAll(async () => {
  memDaemon = await startDaemon({
    // 蒸馏 worker 关掉：本文件只关心「有没有排进队列」，让行停在 pending 才能逐字段对账，
    // 也免得 stub 跑蒸馏往库里塞候选，污染另外几条用例的记忆面。
    configOverrides: { memoryDistillerEnabled: false },
  })

  const primaryName = 'rfc319-memwg-primary'
  const closureName = 'rfc319-memwg-closure'
  const decoyName = 'rfc319-memwg-decoy'
  const cardName = 'rfc319-memwg-card'
  closureAgentId = await createAgent(closureName, [])
  primaryAgentId = await createAgent(primaryName, [closureAgentId])
  decoyAgentId = await createAgent(decoyName, [])
  cardAgentId = await createAgent(cardName, [])
  memWorkflowId = await createLinearWorkflow('rfc319-memwg-inject', primaryAgentId, primaryName)
  cardWorkflowId = await createLinearWorkflow('rfc319-memwg-card', cardAgentId, cardName)

  // 三个仓：两个进组（root / vendor-sdk），一个只进镜像池当诱饵。
  const rootRepo = makeFixtureRepo('root', memScratch)
  const nestedRepo = makeFixtureRepo('nested', memScratch)
  const outsideRepo = makeFixtureRepo('outside', memScratch)
  const urls = [rootRepo, nestedRepo, outsideRepo].map(repoRemoteUrl)
  const started = await api<{ batchId: string; state: string }>(
    memDaemon,
    '/api/cached-repos/batch-import',
    { method: 'POST', body: JSON.stringify({ urls }) },
    'batch import fixture repos',
  )
  await expect
    .poll(
      async () => {
        const snap = await api<{ state: string; rows: Array<{ status: string }> }>(
          memDaemon,
          `/api/cached-repos/imports/${started.batchId}`,
        )
        return snap.state === 'completed' && snap.rows.every((r) => r.status === 'done')
      },
      { message: '三个夹具仓没有全部导入镜像池', timeout: 60_000, intervals: [200] },
    )
    .toBe(true)

  const cached = await api<{ items: Array<{ id: string; urlRedacted: string }> }>(
    memDaemon,
    '/api/cached-repos',
  )
  const idFor = (repoDir: string): string => {
    const tail = repoDir.split('/').pop() ?? repoDir
    const row = cached.items.find((item) => item.urlRedacted.includes(tail))
    if (row === undefined) {
      throw new Error(
        `RFC-319 fixture: no cached mirror for ${repoDir} in ${JSON.stringify(cached.items)}`,
      )
    }
    return row.id
  }
  cachedRepoRootId = idFor(rootRepo)
  cachedRepoNestedId = idFor(nestedRepo)
  cachedRepoOutsideId = idFor(outsideRepo)

  const group = await api<{ id: string }>(
    memDaemon,
    '/api/repo-groups',
    {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-memwg-group',
        description: '',
        nodes: [
          { path: '', attachment: { kind: 'repo', repoUrl: repoRemoteUrl(rootRepo) } },
          { path: 'vendor', attachment: null },
          { path: 'vendor/sdk', attachment: { kind: 'repo', repoUrl: repoRemoteUrl(nestedRepo) } },
        ],
      }),
    },
    'create repo group',
  )
  repoGroupId = group.id
})

test.afterAll(async () => {
  if (memDaemon !== undefined) await memDaemon.stop()
  for (const dir of memScratch) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

// ---------------------------------------------------------------------------
// MEM-X9 —— 四个非 global 档
// ---------------------------------------------------------------------------

test('RFC-319 MEM-X9: agent 闭包 / workflow / repo / repo_group 四档记忆都进了这次运行的注入面，挨不着边的一条都不进 @nightly', async ({
  page,
}) => {
  const tag = `MEMX9-${Date.now()}`
  // ① 该进的四条。故意把 agent 档挂在**闭包成员**而不是节点自己的 agent 上，
  //    把 repo 档挂在组的**第二个**成员仓上——这两处一旦退回单数实现
  //    （只看 primaryAgent.id / 只看 tasks.cached_repo_id）就查不到。
  const want = [
    { key: 'agent', scopeType: 'agent', scopeId: closureAgentId, title: `${tag}-agent-closure` },
    { key: 'workflow', scopeType: 'workflow', scopeId: memWorkflowId, title: `${tag}-workflow` },
    { key: 'repo-root', scopeType: 'repo', scopeId: cachedRepoRootId, title: `${tag}-repo-root` },
    {
      key: 'repo-nested',
      scopeType: 'repo',
      scopeId: cachedRepoNestedId,
      title: `${tag}-repo-nested`,
    },
    {
      key: 'repo_group',
      scopeType: 'repo_group',
      scopeId: repoGroupId,
      title: `${tag}-repo-group`,
    },
  ] as const
  for (const row of want) {
    await seedApprovedMemory({
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      title: row.title,
      bodyMd: `${row.title}: this line must reach the run.`,
    })
  }

  // ② 一条都不该进的三条诱饵。
  const decoyOtherAgent = `${tag}-decoy-other-agent`
  const decoyOutsideRepo = `${tag}-decoy-outside-repo`
  const decoyCandidate = `${tag}-decoy-candidate`
  await seedApprovedMemory({
    scopeType: 'agent',
    scopeId: decoyAgentId,
    title: decoyOtherAgent,
    bodyMd: 'belongs to an agent that is not in the closure',
  })
  await seedApprovedMemory({
    scopeType: 'repo',
    scopeId: cachedRepoOutsideId,
    title: decoyOutsideRepo,
    bodyMd: 'belongs to a mirror that is not a member of the group',
  })
  await seedApprovedMemory({
    scopeType: 'workflow',
    scopeId: memWorkflowId,
    title: decoyCandidate,
    bodyMd: 'still awaiting human approval',
    approve: false,
  })

  // ③ 用**仓库组**启动——repo_group 档只有这条路径会查（memoryInject.ts:496-500）。
  const launched = await api<{ id: string }>(
    memDaemon,
    '/api/tasks',
    {
      method: 'POST',
      body: JSON.stringify({
        workflowId: memWorkflowId,
        name: `rfc319-memx9-${Date.now()}`,
        inputs: { topic: 'memory scopes' },
        repoGroupId,
      }),
    },
    'launch repo-group task',
  )
  const done = await waitTask(
    memDaemon,
    launched.id,
    (t) => t.status === 'done' || t.status === 'failed',
    'MEM-X9 的任务没有收场',
  )
  expect(done.status, `任务没跑成功 ⇒ 注入面无从谈起：${done.errorMessage ?? ''}`).toBe('done')

  const runs = await nodeRunsOf(memDaemon, launched.id)
  const agentRun = runs.find((r) => r.nodeId === 'agent_1')
  expect(agentRun, 'agent_1 没有 node_run ⇒ 这次运行根本没走 runner 的注入路径').toBeDefined()
  const snapshot = agentRun?.injectedMemories ?? null
  expect(
    snapshot,
    'injected_memories_json 为空 ⇒ 这次运行一条记忆都没注入（或者根本没落快照），' +
      '用户挂的每一条规矩都没生效而界面上毫无迹象',
  ).not.toBeNull()

  const byTitle = new Map((snapshot ?? []).map((m) => [m.title, m]))
  for (const row of want) {
    const hit = byTitle.get(row.title)
    expect(
      hit,
      `${row.scopeType} 档的记忆没有进这次运行 ⇒ 用户在这个 scope 上挂的规矩静默失效` +
        `（实际注入了：${[...byTitle.keys()].join(' | ')}）`,
    ).toBeDefined()
    expect(hit?.scopeType, `${row.title} 的 scopeType 串档了`).toBe(row.scopeType)
    expect(hit?.scopeId, `${row.title} 的 scopeId 串档了`).toBe(row.scopeId)
  }
  for (const title of [decoyOtherAgent, decoyOutsideRepo, decoyCandidate]) {
    expect(
      byTitle.has(title),
      `「${title}」不该进这次运行却进了 ⇒ 别处的规矩（或未经人审的候选）被塞进了模型提示词`,
    ).toBe(false)
  }

  // ④ 用户面：节点会话页那张卡把这几档都分出来了。
  //    这里只按 scope 的结构 class 断言，不断言分档标题的**文案**——见文件头「已知缺陷 D1」：
  //    `repo_group` 那一档的 i18n key 缺失，断言它的文案等于把 bug 锁进测试。
  await primeAuth(page, memDaemon)
  await page.goto(`${memDaemon.baseUrl}/tasks/${launched.id}`)
  await page.locator('.canvas-node--agent').first().click()
  const card = page.locator('details.injected-memories-card')
  await expect(
    card,
    '会话页没有渲染注入快照卡 ⇒ 「这次看到了哪几条」在界面上无从查证',
  ).toBeVisible()
  await card.locator('> summary').click()
  for (const row of want) {
    await expect(
      card.locator(`.injected-memories-card__group--${row.scopeType}`),
      `快照卡里没有 ${row.scopeType} 这一档 ⇒ 界面把某个 scope 的注入结果整段吞掉了`,
    ).toHaveCount(1)
  }
  await expect(
    card.getByText(want[0].title, { exact: true }),
    '闭包成员那条记忆没有出现在卡片里',
  ).toBeVisible()
})

// ---------------------------------------------------------------------------
// MEM-40 —— 会话页的注入快照卡（预算裁剪结果 + 分档）
// ---------------------------------------------------------------------------

function filler(sentences: number): string {
  return 'budget filler sentence. '.repeat(sentences)
}

test('RFC-319 MEM-40: 会话页的注入快照卡摆的是**裁剪之后**的真结果——超预算的那条不出现，条数与分档跟着走 @nightly', async ({
  page,
}) => {
  const tag = `MEM40-${Date.now()}`
  const droppedTitle = `${tag}-global-over-budget`
  const keptTitle = `${tag}-agent-scoped-kept`
  const keptTail = `${tag}-KEPT-TAIL-MARKER`

  // 两档预算不同（memoryInject.ts:42-49）：global 500 token / agent 1500 token，
  // 估算是 chars/4（estimateTokens）。故意造一条 global 记忆**单条就超预算**——
  // clipByBudget 首次溢出即截断，所以它无论排第几都进不来，判据与 createdAt 的
  // 先后无关（同一毫秒内建两条会让「谁新谁旧」失去意义，那种夹具本身就是 flaky 的）。
  await seedApprovedMemory({
    scopeType: 'global',
    scopeId: null,
    title: droppedTitle,
    // ~2500 字符 ⇒ ~625 token > 500。
    bodyMd: `${tag}-DROPPED-HEAD ${filler(104)}${tag}-DROPPED-TAIL-MARKER`,
  })
  await seedApprovedMemory({
    scopeType: 'agent',
    scopeId: cardAgentId,
    title: keptTitle,
    // ~1400 字符 ⇒ ~355 token ≤ 1500，留得下；同时够长，能锁住摘要截断那一支。
    bodyMd: `${tag}-KEPT-HEAD ${filler(56)}${keptTail}`,
  })

  const launched = await api<{ id: string }>(
    memDaemon,
    '/api/tasks',
    {
      method: 'POST',
      body: JSON.stringify({
        workflowId: cardWorkflowId,
        name: `rfc319-mem40-${Date.now()}`,
        inputs: { topic: 'budget clipping' },
        scratch: true,
      }),
    },
    'launch scratch task for the injection card',
  )
  const done = await waitTask(
    memDaemon,
    launched.id,
    (t) => t.status === 'done' || t.status === 'failed',
    'MEM-40 的任务没有收场',
  )
  expect(done.status, `任务没跑成功：${done.errorMessage ?? ''}`).toBe('done')

  const runs = await nodeRunsOf(memDaemon, launched.id)
  const snapshot = runs.find((r) => r.nodeId === 'agent_1')?.injectedMemories ?? null
  const titles = (snapshot ?? []).map((m) => m.title)
  expect(
    titles,
    '预算裁剪没有生效 ⇒ 超出本档预算的那条一起被塞进提示词（或者相反，连该留的那条也被丢了）',
  ).toEqual([keptTitle])

  // 用户面：卡片摆的是同一份被裁剪过的结果。
  await primeAuth(page, memDaemon)
  await page.goto(`${memDaemon.baseUrl}/tasks/${launched.id}`)
  await page.locator('.canvas-node--agent').first().click()
  const card = page.locator('details.injected-memories-card')
  await expect(card, '注入快照卡没渲染').toBeVisible()
  await expect(
    card.locator('.injected-memories-card__title'),
    '卡片标题上的条数不是被注入的条数 ⇒ 用户读到的是一个与真实注入面无关的数字',
  ).toHaveText('Injected memories (1)')
  await expect(
    card.locator('.injected-memories-card__chip'),
    '分档 chip 的档数不对 ⇒ 分组读的不是快照里的 scopeType',
  ).toHaveCount(1)
  await expect(
    card.locator('.injected-memories-card__chip'),
    'chip 上的档名/条数与快照对不上',
  ).toHaveText('Agent scope·1')

  await card.locator('> summary').click()
  await expect(
    card.getByText(keptTitle, { exact: true }),
    '预算之内的那条记忆没有出现在卡片里',
  ).toBeVisible()
  await expect(
    card.getByText(droppedTitle, { exact: true }),
    '被预算裁掉的记忆却出现在卡片里 ⇒ 卡片画的是 /api/memories 而不是这次运行真正看到的那份',
  ).toHaveCount(0)

  // previewOf 的 200 字截断：摘要里只有开头，正文展开后才有尾标记。
  const keptRow = card.locator('li.injected-memory-row', { hasText: keptTitle })
  const preview = keptRow.locator('.injected-memory-row__preview')
  await expect(preview, '长正文没有被截断成一行摘要').toContainText('…')
  await expect(
    preview,
    '摘要里出现了正文末尾 ⇒ previewOf 的截断没生效，一整段 markdown 会把这一行撑爆',
  ).not.toContainText(keptTail)
  await keptRow.locator('summary').click()
  await expect(
    keptRow.locator('pre.injected-memory-row__body'),
    '展开之后读不到完整正文 ⇒ 人无法核对模型到底看到了什么',
  ).toContainText(keptTail)
})

// ---------------------------------------------------------------------------
// MEM-44 —— 反馈提交失败的横幅与草稿保全
// ---------------------------------------------------------------------------

test('RFC-319 MEM-44: 反馈提交失败时把失败摆出来、草稿一个字都不丢，重试成功之后才清空并落库 @nightly', async ({
  page,
}) => {
  const launched = await api<{ id: string }>(
    memDaemon,
    '/api/tasks',
    {
      method: 'POST',
      body: JSON.stringify({
        workflowId: cardWorkflowId,
        name: `rfc319-mem44-${Date.now()}`,
        inputs: { topic: 'feedback failure' },
        scratch: true,
      }),
    },
    'launch scratch task for feedback',
  )
  await waitTask(
    memDaemon,
    launched.id,
    (t) => t.status === 'done' || t.status === 'failed',
    'MEM-44 的任务没有收场',
  )

  const note = `RFC-319 MEM-44: next time pin the runtime — ${Date.now()}`
  const feedbackPath = `/api/tasks/${launched.id}/feedback`
  let postAttempts = 0
  // URL 谓词精确到这一条 pathname（无关请求不进 handler），handler 里只有一次 fulfill，
  // 绝不 route.fetch()——docs/dev-gotchas.md 有整节说明为什么。
  await page.route(
    (url) => url.pathname === feedbackPath,
    async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback()
        return
      }
      postAttempts += 1
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'internal', message: 'rfc319 injected failure' }),
      })
    },
  )

  await primeAuth(page, memDaemon)
  await page.goto(`${memDaemon.baseUrl}/tasks/${launched.id}?tab=feedback`)
  const textarea = page.getByTestId('task-feedback-textarea')
  await expect(textarea, '反馈页签没有渲染 ⇒ 后面每一条断言都失去意义').toBeVisible()
  await textarea.fill(note)
  await page.getByTestId('task-feedback-submit').click()

  await expect(
    page.getByTestId('task-feedback-error'),
    '提交失败却没有任何提示 ⇒ 用户点了「提交」什么都没发生，只会再点一次、再点一次',
  ).toBeVisible()
  await expect(
    textarea,
    '提交失败还把草稿清空了 ⇒ 用户刚写的那段话当场消失，而服务端也没有',
  ).toHaveValue(note)
  expect(postAttempts, '注入的失败没有真的拦到那次提交').toBe(1)
  const afterFailure = await api<{ items: Array<{ id: string }> }>(memDaemon, feedbackPath)
  expect(afterFailure.items, '失败的那次提交竟然在服务端留下了行').toHaveLength(0)

  // 摘掉注入之前先把在飞的 handler 等完（unroute 不等，被摘掉的注入可能 fulfill 到新页面上）。
  await page.unrouteAll({ behavior: 'wait' })
  // 重新加载而不是接着点：3 秒客户端节流的窗口起点是**上一次被放行的点击**（失败那次也算），
  // 原地重试要么撞节流、要么变成「靠等」的同步手段。重新挂载让 lastSubmitAt 归零，
  // 这一次点击是确定性的。
  await page.reload()
  const retryTextarea = page.getByTestId('task-feedback-textarea')
  await expect(retryTextarea).toBeVisible()
  await retryTextarea.fill(note)
  await page.getByTestId('task-feedback-submit').click()

  const row = page.locator('[data-testid^="task-feedback-row-"]')
  await expect(
    row,
    '摘掉注入之后再提交一次仍然没有出现在列表里 ⇒ 失败之后这条路就再也走不通了',
  ).toHaveCount(1)
  await expect(
    retryTextarea,
    '提交成功之后草稿没有清空 ⇒ 下一次打开还会看到已经提交过的内容，很容易重复提交',
  ).toHaveValue('')
  const persisted = await api<{ items: Array<{ bodyMd: string }> }>(memDaemon, feedbackPath)
  expect(
    persisted.items.map((r) => r.bodyMd),
    '界面上出现了一行，服务端却没有 ⇒ 列表画的是本地乐观值，刷新之后那段话就没了',
  ).toEqual([note])
})

// ---------------------------------------------------------------------------
// MEM-X8 —— clarify / review 两类来源也要进蒸馏队列（自带 daemon）
// ---------------------------------------------------------------------------

test('RFC-319 MEM-X8: 反问答完与评审决定各自排进一条蒸馏任务，来源类别与来源事件都指得回去 @nightly', async () => {
  const stubState = mkdtempSync(join(tmpdir(), 'rfc319-memwg-clarify-state-'))
  const repoDir = mkdtempSync(join(tmpdir(), 'rfc319-memwg-clarify-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 clarify fixture\n', 'utf-8')
  initGitRepo(repoDir)
  const d = await startDaemon({
    stubMode: 'clarify',
    extraEnv: { CLARIFY_STUB_STATE: stubState },
    configOverrides: { memoryDistillerEnabled: false },
  })
  try {
    const agentName = 'rfc319-memwg-designer'
    const agent = await api<{ id: string }>(
      d,
      '/api/agents',
      {
        method: 'POST',
        body: JSON.stringify({
          name: agentName,
          description: 'RFC-319 clarify + review fixture designer',
          outputs: ['design'],
          outputKinds: { design: 'markdown' },
          readonly: true,
          bodyMd: 'Fixture designer driven by the compiled clarify stand-in.',
        }),
      },
      'create designer agent',
    )
    const workflow = await api<{ id: string }>(
      d,
      '/api/workflows',
      {
        method: 'POST',
        body: JSON.stringify({
          name: 'rfc319-memwg-clarify-review',
          description: 'RFC-319 MEM-X8 fixture: one task that produces both distill sources.',
          definition: {
            $schema_version: 3,
            inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
            nodes: [
              { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
              {
                id: 'designer',
                kind: 'agent-single',
                agentId: agent.id,
                agentName,
                promptTemplate: 'Design for {{topic}}.',
                position: { x: 320, y: 0 },
              },
              {
                id: 'clarify_1',
                kind: 'clarify',
                title: 'Clarify design',
                description: '',
                position: { x: 560, y: 160 },
              },
              {
                id: 'review_1',
                kind: 'review',
                title: 'Review design',
                description: '',
                inputSource: { nodeId: 'designer', portName: 'design' },
                rerunnableOnReject: [],
                rerunnableOnIterate: [],
                rollbackFilesOnReject: false,
                rollbackFilesOnIterate: false,
                position: { x: 640, y: 0 },
              },
              {
                id: 'out_1',
                kind: 'output',
                ports: [{ name: 'doc', bind: { nodeId: 'review_1', portName: 'approved_doc' } }],
                position: { x: 960, y: 0 },
              },
            ],
            edges: [
              {
                id: 'e_in_designer',
                source: { nodeId: 'in_1', portName: 'topic' },
                target: { nodeId: 'designer', portName: 'topic' },
              },
              {
                id: 'e_clarify_ask',
                source: { nodeId: 'designer', portName: '__clarify__' },
                target: { nodeId: 'clarify_1', portName: 'questions' },
              },
              {
                id: 'e_clarify_ans',
                source: { nodeId: 'clarify_1', portName: 'answers' },
                target: { nodeId: 'designer', portName: '__clarify_response__' },
              },
              {
                id: 'e_designer_review',
                source: { nodeId: 'designer', portName: 'design' },
                target: { nodeId: 'review_1', portName: '__review_input__' },
              },
              {
                id: 'e_review_out',
                source: { nodeId: 'review_1', portName: 'approved_doc' },
                target: { nodeId: 'out_1', portName: 'doc' },
              },
            ],
          },
        }),
      },
      'create clarify+review workflow',
    )

    const launched = await api<{ id: string }>(
      d,
      '/api/tasks',
      {
        method: 'POST',
        body: JSON.stringify({
          workflowId: workflow.id,
          name: `rfc319-memx8-${Date.now()}`,
          inputs: { topic: 'order_status enum' },
          repoUrl: repoRemoteUrl(repoDir),
          ref: 'main',
        }),
      },
      'launch clarify+review task',
    )
    const taskId = launched.id

    // ① 起点必须是空的，否则下面两条「多出来一条」的断言都是恒真的。
    expect(
      (await api<{ items: DistillJobRow[] }>(d, '/api/memory-distill-jobs')).items.filter(
        (j) => j.taskId === taskId,
      ),
      '任务刚起来就已经有蒸馏任务 ⇒ 后面「反问答完才多出来」的断言无从判定',
    ).toEqual([])

    await waitTask(d, taskId, (t) => t.status === 'awaiting_human', 'designer 没有停在反问上')
    const rounds = await api<
      Array<{ id: string; iteration: number; intermediaryNodeRunId: string }>
    >(d, `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`)
    expect(rounds, '反问轮没有出现在收件箱里').toHaveLength(1)
    const round = rounds[0]!

    // ② 答完整轮 —— autoDispatch 在整轮封存成功后 enqueue（sourceKind='clarify'）。
    await api(
      d,
      `/api/clarify/${round.intermediaryNodeRunId}/answers`,
      {
        method: 'POST',
        body: JSON.stringify({
          answers: [
            {
              questionId: 'q-db',
              selectedOptionIndices: [0],
              selectedOptionLabels: [],
              customText: '',
            },
            {
              questionId: 'q-lang',
              selectedOptionIndices: [0],
              selectedOptionLabels: [],
              customText: '',
            },
          ],
          // stop 把 designer 从「必须继续追问」里放出来，它的 rerun 才会真的产出 design。
          directive: 'stop',
          ifMatchIteration: round.iteration,
        }),
      },
      'submit clarify answers',
    )

    let clarifyJob: DistillJobRow | undefined
    await expect
      .poll(
        async () => {
          const jobs = await api<{ items: DistillJobRow[] }>(d, '/api/memory-distill-jobs')
          clarifyJob = jobs.items.find((j) => j.taskId === taskId && j.sourceKind === 'clarify')
          return clarifyJob !== undefined
        },
        {
          message:
            '反问答完之后没有排进蒸馏队列 ⇒ 用户在反问里给出的最有价值的那点信息一条都不会被沉淀',
          timeout: 30_000,
          intervals: [250],
        },
      )
      .toBe(true)
    expect(clarifyJob?.sourceEventId, 'clarify 蒸馏任务指不回那一轮反问 ⇒ 蒸馏时读不到语料').toBe(
      round.id,
    )
    expect(clarifyJob?.debounceKey, 'clarify 蒸馏任务的去重键没有按 任务:来源 组装').toBe(
      `${taskId}:clarify`,
    )
    expect(clarifyJob?.status, '蒸馏 worker 已关闭，这条应当停在 pending').toBe('pending')

    // ③ 评审决定之前，review 那一路必须还不存在（负向对照）。
    expect(
      (await api<{ items: DistillJobRow[] }>(d, '/api/memory-distill-jobs')).items.some(
        (j) => j.taskId === taskId && j.sourceKind === 'review',
      ),
      '还没有人做评审决定就已经有 review 蒸馏任务 ⇒ 下面那条断言是恒真的',
    ).toBe(false)

    let review: { nodeRunId: string; reviewIteration: number } | undefined
    await expect
      .poll(
        async () => {
          const pending = await api<
            Array<{
              nodeRunId: string
              taskId: string
              reviewIteration: number
              awaitingReview: boolean
            }>
          >(d, '/api/reviews?status=pending')
          review = pending.find((r) => r.taskId === taskId && r.awaitingReview)
          return review !== undefined
        },
        { message: 'designer 重跑之后评审节点没有待审', timeout: 60_000, intervals: [300] },
      )
      .toBe(true)

    await api(
      d,
      `/api/reviews/${review!.nodeRunId}/decision`,
      {
        method: 'POST',
        body: JSON.stringify({ decision: 'approved', reviewIteration: review!.reviewIteration }),
      },
      'approve review',
    )

    let reviewJob: DistillJobRow | undefined
    await expect
      .poll(
        async () => {
          const jobs = await api<{ items: DistillJobRow[] }>(d, '/api/memory-distill-jobs')
          reviewJob = jobs.items.find((j) => j.taskId === taskId && j.sourceKind === 'review')
          return reviewJob !== undefined
        },
        {
          message:
            '评审决定之后没有排进蒸馏队列 ⇒ 「这次为什么批 / 为什么驳」这类判断永远不会变成记忆',
          timeout: 30_000,
          intervals: [250],
        },
      )
      .toBe(true)
    expect(reviewJob?.debounceKey, 'review 蒸馏任务的去重键没有按 任务:来源 组装').toBe(
      `${taskId}:review`,
    )
    expect(reviewJob?.status, '蒸馏 worker 已关闭，这条应当停在 pending').toBe('pending')

    // ④ 两条来源各自成行，不会被去重键合并掉。
    const all = (await api<{ items: DistillJobRow[] }>(d, '/api/memory-distill-jobs')).items.filter(
      (j) => j.taskId === taskId,
    )
    expect(
      all.map((j) => j.sourceKind).sort(),
      '同一个任务的两类来源被并成了一条 ⇒ 两份语料里只有一份会被蒸馏',
    ).toEqual(['clarify', 'review'])
  } finally {
    await d.stop()
    for (const dir of [stubState, repoDir]) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  }
})

// ===========================================================================
// 工作组域 —— daemon B（workgroup-matrix stub）
// ===========================================================================

let wgDaemon: DaemonHandle
let wgStateDir = ''
let showcase: ShowcaseSeedResult
/** 自建的 leader_worker 组：clarifyBudget=2，goal 决定它是「一轮就宣布完成」还是「停在反问」。 */
let lwGroupId = ''

/** stub 的 requirePrompt 判据；charter / goal 少一个字它就 exit 10。 */
const WG_CHARTER = 'WG_MATRIX_CHARTER coordinate, verify, and revise after human feedback.'
const WG_GOAL_PREFIX = 'WG_MATRIX_GOAL literal {{do_not_expand}}.'
/** 三句完成标记同时出现 ⇒ leader 第一轮就宣布 done，任务落到完成门。 */
const WG_GOAL_DONE = `${WG_GOAL_PREFIX} research complete. implementation-code-v1 complete. implementation-tests-v1 complete.`
/** 没有完成标记 ⇒ leader 先发反问，任务停在 awaiting_human / leader-clarify。 */
const WG_GOAL_OPEN = `${WG_GOAL_PREFIX} Investigate the rollback path before shipping.`

interface RoomShape {
  taskStatus: string
  pauseReason: string | null
  budgetUsed: number
  config: {
    mode: string
    maxRounds: number
    members: Array<{ id: string; memberType: string; displayName: string }>
  }
  gate: { declaredDone: boolean; awaitingConfirmation: boolean }
  dw: null | { phase: string }
  messages: Array<{ id: string; kind: string }>
  assignments: Array<{ id: string; status: string; title: string; nodeRunId: string | null }>
}

function roomOf(taskId: string): Promise<RoomShape> {
  return api<RoomShape>(wgDaemon, `/api/workgroup-tasks/${encodeURIComponent(taskId)}/room`)
}

async function waitRoom(
  taskId: string,
  predicate: (room: RoomShape) => boolean,
  message: string,
  timeout = 180_000,
): Promise<RoomShape> {
  let last: RoomShape | null = null
  try {
    await expect
      .poll(
        async () => {
          last = await roomOf(taskId)
          return predicate(last)
        },
        { message, timeout, intervals: [400] },
      )
      .toBe(true)
  } catch (error) {
    const seen = last as RoomShape | null
    throw new Error(
      `${message}（最后一次读到 status=${seen?.taskStatus} pause=${seen?.pauseReason} ` +
        `gate=${JSON.stringify(seen?.gate)} dw=${JSON.stringify(seen?.dw)}）`,
      { cause: error },
    )
  }
  return last as unknown as RoomShape
}

async function launchGroupTask(groupId: string, name: string, goal: string): Promise<string> {
  const task = await api<{ id: string }>(
    wgDaemon,
    `/api/workgroups/${encodeURIComponent(groupId)}/tasks`,
    { method: 'POST', body: JSON.stringify({ name, goal, scratch: true }) },
    `launch workgroup task ${name}`,
  )
  return task.id
}

async function openRoom(page: Page, taskId: string): Promise<void> {
  await primeAuth(page, wgDaemon)
  await page.goto(`${wgDaemon.baseUrl}/tasks/${taskId}?tab=chatroom`)
  await expect(
    page.getByTestId('workgroup-room'),
    '聊天室没渲染 ⇒ 后面每一条断言都失去意义',
  ).toBeVisible({ timeout: 60_000 })
}

function wgDbPath(): string {
  return join(wgDaemon.home, 'db.sqlite')
}

test.beforeAll(async () => {
  wgStateDir = mkdtempSync(join(tmpdir(), 'rfc319-memwg-wg-state-'))
  wgDaemon = await startDaemon({
    stubMode: 'workgroup-matrix',
    extraEnv: { WORKGROUP_MATRIX_STATE_DIR: wgStateDir },
  })
  // 三个 showcase 工作组 + 七个成员 agent 一次建齐（launch:false —— 任务由各用例自己起，
  // 免得共享一个跑到一半的任务，那正是 docs/dev-gotchas.md 说的「后面的用例依赖前面留下的状态」）。
  showcase = await seedShowcase({
    baseUrl: wgDaemon.baseUrl,
    token: wgDaemon.token,
    launch: false,
  })

  const me = await api<{ user: { id: string } }>(wgDaemon, '/api/auth/me')
  const group = await api<{ id: string }>(
    wgDaemon,
    '/api/workgroups',
    {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-memwg-lw',
        description: 'RFC-319 workgroup ops fixture',
        instructions: WG_CHARTER,
        mode: 'leader_worker',
        leaderDisplayName: 'lead',
        switches: { shareOutputs: true, directMessages: true, blackboard: true },
        maxRounds: 20,
        completionGate: true,
        clarifyBudget: 2,
        fanOut: true,
        members: [
          {
            memberType: 'agent',
            agentId: showcase.agents.leader.id,
            displayName: 'lead',
            roleDesc: 'decompose and govern',
          },
          {
            memberType: 'agent',
            agentId: showcase.agents.researcher.id,
            displayName: 'researcher',
            roleDesc: 'read-only release research',
          },
          {
            memberType: 'agent',
            agentId: showcase.agents.builder.id,
            displayName: 'builder',
            roleDesc: 'parallel implementation shards',
          },
          {
            memberType: 'human',
            userId: me.user.id,
            displayName: 'owner',
            roleDesc: 'answer questions and approve completion',
          },
        ],
      }),
    },
    'create leader-worker fixture group',
  )
  lwGroupId = group.id
})

test.afterAll(async () => {
  if (wgDaemon !== undefined) await wgDaemon.stop()
  try {
    rmSync(wgStateDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

// ---------------------------------------------------------------------------
// WG-46 —— 终态任务的房间只读
// ---------------------------------------------------------------------------

test('RFC-319 WG-46: 任务收场之前房间可写、收场之后整块只读——composer 禁用换成终态说明，服务端同一条路径 409 workgroup-task-terminal @nightly', async ({
  page,
}) => {
  const taskId = await launchGroupTask(lwGroupId, `rfc319-wg46-${Date.now()}`, WG_GOAL_DONE)
  await waitRoom(taskId, (r) => r.gate.awaitingConfirmation, 'WG-46 的任务没有停在完成门上')

  // ① 正向对照：完成门待确认（awaiting_review）**不是**终态，房间此刻必须是可写的。
  //    没有这一半，下面「禁用」那一半对任何渲染结果都成立。
  await openRoom(page, taskId)
  const composer = page.getByTestId('workgroup-room-input')
  await expect(
    composer,
    '任务还没收场，composer 却已经禁用 ⇒ 人在完成门前连一句话都说不了',
  ).toBeEnabled()
  await expect(
    page.getByTestId('workgroup-room-terminal-notice'),
    '任务还没收场就摆出了终态说明',
  ).toHaveCount(0)
  await expect(
    page.getByTestId('workgroup-room-shortcut-hint'),
    '可写状态下没有发送快捷键提示 ⇒ 两条互斥提示同时缺席，说明 canPost 判据整个塌了',
  ).toBeVisible()

  // ② 收场。
  await api(
    wgDaemon,
    `/api/workgroup-tasks/${taskId}/confirm`,
    { method: 'POST', body: JSON.stringify({ decision: 'approve' }) },
    'approve completion gate',
  )
  await waitRoom(taskId, (r) => r.taskStatus === 'done', 'WG-46 的任务批准之后没有收场')

  // ③ 服务端那道闸：终态任务的 POST /messages 必须是 409 + 可辨的错误码，且**一个字都没写进去**。
  const before = await roomOf(taskId)
  const refused = await rejection(wgDaemon, `/api/workgroup-tasks/${taskId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ body: 'RFC-319 WG-46: talking to a finished task' }),
  })
  expect(
    { status: refused.status, code: refused.code },
    '终态任务还能收下消息 ⇒ 那条话写进了一个没有引擎会再读的房间，复盘的人以为它被人看见过',
  ).toEqual({ status: 409, code: 'workgroup-task-terminal' })
  expect(
    (await roomOf(taskId)).messages.length,
    '被拒的那次写仍然在房间里留下了一条消息 ⇒ 409 只是回执上的说法，落库照旧',
  ).toBe(before.messages.length)

  // ④ 界面那道闸：同一页刷新之后 composer 禁用、两条提示互换。
  await page.reload()
  await expect(page.getByTestId('workgroup-room')).toBeVisible({ timeout: 60_000 })
  await expect(
    page.getByTestId('workgroup-room-input'),
    '任务已经结束，输入框还能打字 ⇒ 用户写完一段话点发送才吃到 409',
  ).toBeDisabled()
  await expect(
    page.getByTestId('workgroup-room-send'),
    '任务已经结束，发送键还是可点的',
  ).toBeDisabled()
  await expect(
    page.getByTestId('workgroup-room-terminal-notice'),
    '终态房间没有告诉用户「为什么打不了字」',
  ).toBeVisible()
  await expect(
    page.getByTestId('workgroup-room-shortcut-hint'),
    '终态房间还挂着发送快捷键提示 ⇒ 界面同时在说「能发」和「不能发」',
  ).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// WG-X4 —— 冻结的工作组名
// ---------------------------------------------------------------------------

test('RFC-319 WG-X4: 任务显示的组名冻在启动那一刻——事后改组名不动它；冻结配置坏掉时降级成破折号而不是让整张列表 5xx @nightly', async ({
  page,
}) => {
  const launchName = `rfc319-frozen-${Date.now()}`
  const renamed = `${launchName}-RENAMED`
  const group = await api<{ id: string; version: number }>(
    wgDaemon,
    '/api/workgroups',
    {
      method: 'POST',
      body: JSON.stringify({
        name: launchName,
        description: 'RFC-319 WG-X4 fixture',
        instructions: WG_CHARTER,
        mode: 'leader_worker',
        leaderDisplayName: 'lead',
        switches: { shareOutputs: true, directMessages: true, blackboard: true },
        maxRounds: 20,
        completionGate: true,
        clarifyBudget: 2,
        fanOut: false,
        members: [
          {
            memberType: 'agent',
            agentId: showcase.agents.leader.id,
            displayName: 'lead',
            roleDesc: 'decompose and govern',
          },
          {
            memberType: 'agent',
            agentId: showcase.agents.researcher.id,
            displayName: 'researcher',
            roleDesc: 'read-only release research',
          },
          {
            memberType: 'agent',
            agentId: showcase.agents.builder.id,
            displayName: 'builder',
            roleDesc: 'parallel implementation shards',
          },
        ],
      }),
    },
    'create rename fixture group',
  )
  const taskId = await launchGroupTask(group.id, `rfc319-wgx4-${Date.now()}`, WG_GOAL_OPEN)
  const beforeRename = await api<TaskRow>(wgDaemon, `/api/tasks/${taskId}`)
  expect(
    beforeRename.workgroupName,
    '任务上根本没有冻结组名 ⇒ 列表那一列只能显示破折号，用户认不出这条任务属于哪个组',
  ).toBe(launchName)

  // 改组名。冻结值必须纹丝不动——若改成实时 join，这里当场就变了。
  const current = await api<{ version: number }>(wgDaemon, `/api/workgroups/${group.id}`)
  await api(
    wgDaemon,
    `/api/workgroups/${group.id}/rename`,
    {
      method: 'POST',
      body: JSON.stringify({
        newName: renamed,
        expectedVersion: current.version,
        clientMutationId: mutationId(),
      }),
    },
    'rename workgroup',
  )
  expect(
    (await api<{ name: string }>(wgDaemon, `/api/workgroups/${group.id}`)).name,
    '改名没生效 ⇒ 下面「冻结值没变」的断言是恒真的',
  ).toBe(renamed)
  expect(
    (await api<TaskRow>(wgDaemon, `/api/tasks/${taskId}`)).workgroupName,
    '改了组名，已启动任务显示的组名跟着变了 ⇒ 历史记录被一次改名集体改写，事后再也对不上',
  ).toBe(launchName)

  await primeAuth(page, wgDaemon)
  await page.goto(`${wgDaemon.baseUrl}/tasks`)
  const row = page.getByTestId(`task-row-${taskId}`)
  await expect(row, '任务列表里找不到这条任务').toBeVisible({ timeout: 60_000 })
  await expect(row, '任务列表显示的是当前组名而不是启动时冻结的那个').toContainText(launchName)
  await expect(
    row,
    '任务列表显示了改名后的组名 ⇒ 组的当前名字被泄露给了只是任务成员的人',
  ).not.toContainText(renamed)

  // 韧性那一半：先把任务收到终态（引擎不会再读它），再把冻结 JSON 弄坏。
  await api(wgDaemon, `/api/tasks/${taskId}/cancel`, { method: 'POST' }, 'cancel frozen-name task')
  await waitTask(
    wgDaemon,
    taskId,
    (t) => t.status === 'canceled' || t.status === 'failed' || t.status === 'done',
    'WG-X4 的任务没有被取消掉',
  )
  runSqlite(
    wgDbPath(),
    `UPDATE tasks SET workgroup_config_json = ${sqlLiteral('{not json at all')} WHERE id = ${sqlLiteral(taskId)};`,
  )
  const readback = querySqlite<{ workgroup_config_json: string | null }>(
    wgDbPath(),
    'SELECT workgroup_config_json FROM tasks WHERE id = ?',
    [taskId],
  )
  // runSqlite 的 exec 对约束错误不抛异常（docs/dev-gotchas.md 有最小复现），种完必须回读自证。
  expect(readback[0]?.workgroup_config_json, '把冻结配置弄坏这一步根本没落库').toBe(
    '{not json at all',
  )

  const degraded = await rawReq(wgDaemon, `/api/tasks/${taskId}`)
  expect(
    degraded.status,
    '冻结配置坏掉之后任务详情直接 5xx ⇒ 一行坏 JSON 就能让人再也打不开这条任务',
  ).toBe(200)
  expect(
    ((await degraded.json()) as TaskRow).workgroupName,
    '坏掉的冻结配置没有降级成 null',
  ).toBeNull()

  await page.reload()
  const degradedRow = page.getByTestId(`task-row-${taskId}`)
  await expect(
    degradedRow,
    '冻结配置坏掉之后这条任务从列表里整行消失了 ⇒ 一行坏 JSON 让整张列表少了一条',
  ).toBeVisible({ timeout: 60_000 })
  await expect(
    degradedRow,
    '冻结配置已经坏了，列表却还显示着组名 ⇒ 它其实是从别处（活的组资源）读的',
  ).not.toContainText(launchName)
})

// ---------------------------------------------------------------------------
// WG-39 —— awaiting_human 的停机成因说明卡
// ---------------------------------------------------------------------------

test('RFC-319 WG-39: awaiting_human 的成因卡把「等回答」和「触顶收尾」说成两件事，成因认不出来时整张卡不出现 @nightly', async ({
  page,
}) => {
  const taskId = await launchGroupTask(lwGroupId, `rfc319-wg39-${Date.now()}`, WG_GOAL_OPEN)
  const parked = await waitRoom(
    taskId,
    // RFC-333 的 TaskParkTx 会先原子提交 clarify + task awaiting_human；工作组引擎
    // 随后在对外发布稳定停机前补上精确成因。只等 status 会撞中这个短暂可读窗口，
    // 把一个最终完整的停机态误报成失败；成对等待仍会在 reason 永远不落库时超时变红。
    (r) => r.taskStatus === 'awaiting_human' && r.pauseReason === 'leader-clarify',
    'WG-39 的任务没有停在 awaiting_human / leader-clarify 稳定态',
  )
  expect(
    parked.pauseReason,
    '停机成因不是 leader-clarify ⇒ 下面「等回答」那句文案对不上，夹具需要重新校准',
  ).toBe('leader-clarify')

  await openRoom(page, taskId)
  const card = page.getByTestId('workgroup-room-pause-reason')
  await expect(
    card,
    '任务停在 awaiting_human 却没有成因说明 ⇒ 用户只看到中性的「等待人工」，不知道该做什么',
  ).toBeVisible()
  await expect(card, 'leader-clarify 的成因卡没有说「有问题在等你回答」').toContainText(
    'waiting for your answer',
  )

  // 触顶收尾停机走的是同一张卡、不同的文案。真实产生它需要把预算跑干（引擎侧语义已由
  // packages/backend/tests 覆盖），这里只锁**读面**：换一个成因，卡片必须换一套说法。
  const setPause = (reason: string | null): void => {
    runSqlite(
      wgDbPath(),
      reason === null
        ? `UPDATE workgroup_task_state SET pause_reason = NULL WHERE task_id = ${sqlLiteral(taskId)};`
        : `UPDATE workgroup_task_state SET pause_reason = ${sqlLiteral(reason)} WHERE task_id = ${sqlLiteral(taskId)};`,
    )
    const rows = querySqlite<{ pause_reason: string | null }>(
      wgDbPath(),
      'SELECT pause_reason FROM workgroup_task_state WHERE task_id = ?',
      [taskId],
    )
    expect(rows[0]?.pause_reason ?? null, `把停机成因改成 ${String(reason)} 这一步没落库`).toBe(
      reason,
    )
  }

  setPause('max-rounds-wrapup')
  await page.reload()
  await expect(page.getByTestId('workgroup-room')).toBeVisible({ timeout: 60_000 })
  const wrapCard = page.getByTestId('workgroup-room-pause-reason')
  await expect(
    wrapCard,
    '触顶收尾停机没有说明卡 ⇒ 它会被读成「有问题等着我答」，用户在房间里干等一个不会来的问题',
  ).toBeVisible()
  await expect(wrapCard, '触顶收尾停机没有说清「预算跑干了、没有人在等你回答」').toContainText(
    'The round budget is exhausted',
  )
  await expect(
    wrapCard,
    '触顶收尾停机与「等回答」用了同一句文案 ⇒ 两种完全不同的停机在界面上分不出来',
  ).not.toContainText('waiting for your answer')

  // 认不出来的成因不许硬凑一句话（pauseReasonCopyKey 返回 null ⇒ 整张卡不渲染）。
  setPause('rfc319-unknown-reason')
  await page.reload()
  await expect(page.getByTestId('workgroup-room')).toBeVisible({ timeout: 60_000 })
  await expect(
    page.getByTestId('workgroup-room-pause-reason'),
    '认不出来的停机成因也硬摆了一张卡 ⇒ 用户读到的多半是一条原始 i18n key 或一句错的解释',
  ).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// WG-40 —— free_collab 的预算读数与共享任务列表卡
// ---------------------------------------------------------------------------

test('RFC-319 WG-40: 自由协作房间给的是成员回合预算而不是「最大轮数」，共享任务列表按 open/进行中/已完成 分组并给同批徽记 @nightly', async ({
  page,
}) => {
  const fcTaskId = await launchGroupTask(
    showcase.workgroups.freeCollab.id,
    `rfc319-wg40-${Date.now()}`,
    'FC_MATRIX_GOAL literal {{fc_literal}}. Independently plan the work, deduplicate overlapping cards, exchange direct and public context, execute batches, and converge for human approval.',
  )
  const room = await waitRoom(
    fcTaskId,
    (r) => r.gate.awaitingConfirmation,
    'WG-40 的自由协作任务没有跑到完成门',
  )
  expect(room.config.mode, '夹具起的不是 free_collab 组').toBe('free_collab')
  expect(
    room.assignments.length,
    '共享任务列表是空的 ⇒ 下面每一条分组计数都是 0 对 0 的恒真断言',
  ).toBeGreaterThan(0)

  await openRoom(page, fcTaskId)

  // ① 预算读数读的是服务端的 budgetUsed / maxRounds，而不是「第 X 回合」。
  const budget = page.getByTestId('workgroup-room-turn-budget')
  await expect(budget, '自由协作房间没有预算读数 ⇒ 用户完全看不到任务什么时候会触顶').toBeVisible()
  await expect(
    budget,
    `预算读数与服务端对不上（服务端 budgetUsed=${room.budgetUsed} maxRounds=${room.config.maxRounds}）`,
  ).toContainText(new RegExp(`${room.budgetUsed}\\s*/\\s*${room.config.maxRounds}`))
  expect(
    room.budgetUsed,
    '成员回合数是 0 ⇒ 预算读数的分子是个恒定值，断言不到东西',
  ).toBeGreaterThan(0)

  // ② 三个分组的计数逐格与服务端的卡片状态对账。
  const expected = {
    open: room.assignments.filter((a) => a.status === 'open').length,
    active: room.assignments.filter((a) => a.status === 'dispatched' || a.status === 'delivered')
      .length,
    done: room.assignments.filter((a) => a.status === 'done').length,
  }
  await expect(
    page.getByTestId('workgroup-room-fc-list'),
    '自由协作房间没有共享任务列表卡 ⇒ 「活儿被谁认走了」在界面上无从查证',
  ).toBeVisible()
  for (const key of ['open', 'active', 'done'] as const) {
    await expect(
      page.getByTestId(`wg-fc-count-${key}`),
      `${key} 分组的计数与服务端的卡片状态对不上（服务端 ${JSON.stringify(expected)}）`,
    ).toHaveText(String(expected[key]))
  }
  expect(expected.done, '一张 done 卡都没有 ⇒ 上面那三条计数断言退化成 0=0').toBeGreaterThan(0)

  // ③ 每张卡都在自己的分组里出现一行——不是「卡片渲染了」而是「这几张、只有这几张」。
  for (const a of room.assignments) {
    await expect(
      page.getByTestId(`wg-fc-row-${a.id}`),
      `卡 ${a.title} 在共享任务列表里找不到 ⇒ 分组把一部分卡漏掉了`,
    ).toHaveCount(1)
  }
  await expect(
    page.locator('[data-testid^="wg-fc-row-"]'),
    '共享任务列表里的行数与服务端的卡数对不上 ⇒ 有卡被漏掉或被画重了',
  ).toHaveCount(room.assignments.length)

  // ④ 同批徽记只挂在「和别的卡共用同一个 run」的行上。徽记数的是**同 run 的卡数**，
  //    不是「有没有 run」——判据写成 >=1 的话每一行都会挂上一个「同批 ×1」。
  const byRun = new Map<string, string[]>()
  for (const a of room.assignments) {
    if (a.nodeRunId === null) continue
    byRun.set(a.nodeRunId, [...(byRun.get(a.nodeRunId) ?? []), a.id])
  }
  expect([...byRun.values()].flat().length, '一张卡都没有绑定 run ⇒ 下面的徽记断言没有语料').toBe(
    room.assignments.length,
  )
  const batched = [...byRun.values()].filter((ids) => ids.length > 1).flat()
  for (const id of batched) {
    await expect(
      page.getByTestId(`wg-fc-batch-${id}`),
      '批量认领的卡没有「同批 ×N」徽记 ⇒ 用户看不出这几张是一个成员一次跑掉的',
    ).toBeVisible()
  }
  await expect(
    page.locator('[data-testid^="wg-fc-batch-"]'),
    `同批徽记的数量与「共用 run 的卡数」对不上（共用 run 的卡：${batched.length} 张）⇒ ` +
      '徽记要么少挂、要么给每一张独占 run 的卡也挂了一个「同批 ×1」',
  ).toHaveCount(batched.length)
})

// ---------------------------------------------------------------------------
// WG-X3 —— 工作组任务详情页的页签集合
// ---------------------------------------------------------------------------

/**
 * 面板是页签集合的**精确**读面：`tasks.detail.tsx` 里每一块都写成
 * `{capability && <section data-task-detail-section=… hidden={tab !== …}>}`，
 * 所以「存在与否」= 这条页签在不在这个模式的集合里，「可见与否」= 它是不是当前页签。
 * 唯一的例外是 outputs——它的面板闸是 hasOutputs 而不是页签集合，所以那一条改看导航项。
 */
function pane(page: Page, key: string): Locator {
  return page.locator(`[data-task-detail-section="${key}"]`)
}

function tabLink(page: Page, key: string): Locator {
  return page.locator(`[data-task-detail-section-link="${key}"]`)
}

test('RFC-319 WG-X3: 回合引擎组的页签以聊天室为默认、没有宿主画布也没有 outputs；动态工作流组反过来——多一张编排页、没有聊天室 @nightly', async ({
  page,
}) => {
  // ① 回合引擎组（leader_worker）。
  const turnTaskId = await launchGroupTask(lwGroupId, `rfc319-wgx3-lw-${Date.now()}`, WG_GOAL_OPEN)
  await waitRoom(
    turnTaskId,
    (r) => r.taskStatus === 'awaiting_human',
    'WG-X3 的回合引擎任务没有停下来',
  )
  await primeAuth(page, wgDaemon)
  await page.goto(`${wgDaemon.baseUrl}/tasks/${turnTaskId}`)
  await expect(
    pane(page, 'chatroom'),
    '不带 ?tab 直达回合引擎组时，默认落地的不是聊天室 ⇒ 群任务的主视图被换成了别的东西',
  ).toBeVisible({ timeout: 60_000 })
  await expect(
    page.getByTestId('workgroup-room'),
    '默认页签虽然是聊天室，房间内容却没有挂载',
  ).toBeVisible()
  await expect(
    pane(page, 'workflow-status'),
    '回合引擎组挂上了宿主画布 ⇒ 用户点进去看到的是一张不是任何人编排过的内建图',
  ).toHaveCount(0)
  await expect(
    pane(page, 'dw-orchestration'),
    '回合引擎组挂上了动态编排面板 ⇒ 它没有图可编排',
  ).toHaveCount(0)
  // 导航里必须有聊天室这一项——这同时也是下一条「outputs 不在导航里」的语料非空前提：
  // 导航若整块塌成 compact 下拉，那条断言会退化成恒真。
  await expect(
    tabLink(page, 'chatroom'),
    '导航里根本没有聊天室这一项 ⇒ 下面「outputs 不在导航里」是恒真的',
  ).toHaveCount(1)
  await expect(
    tabLink(page, 'outputs'),
    '回合引擎组的导航里挂着 outputs ⇒ 宿主 run 不落声明产出，点进去必然是空的',
  ).toHaveCount(0)

  // ② 动态工作流组。
  const dwTaskId = await launchGroupTask(
    showcase.workgroups.dynamicWorkflow.id,
    `rfc319-wgx3-dw-${Date.now()}`,
    'DW_MATRIX_GOAL literal {{dw_goal_literal}}. Generate a source-to-reviewer DAG, let the human reject and regenerate the first graph, then execute the approved typed handoff.',
  )
  await waitRoom(
    dwTaskId,
    (r) => r.dw?.phase === 'awaiting_confirm',
    'WG-X3 的动态工作流任务没有生成出待确认的图',
  )
  await page.goto(`${wgDaemon.baseUrl}/tasks/${dwTaskId}`)
  await expect(
    pane(page, 'dw-orchestration'),
    '待确认相位下默认落地的不是编排页 ⇒ 用户进来先看到一张还没生成完的画布',
  ).toBeVisible({ timeout: 60_000 })
  await expect(
    pane(page, 'chatroom'),
    '动态工作流组挂上了聊天室 ⇒ 这个模式没有回合、房间是空的',
  ).toHaveCount(0)
  await expect(
    pane(page, 'workflow-status'),
    '动态工作流组没有真实 DAG 的画布 ⇒ 确认之后没有任何地方能看执行进度',
  ).toHaveCount(1)
  await expect(
    tabLink(page, 'dw-orchestration'),
    '导航里根本没有编排页这一项 ⇒ 下面「outputs 不在导航里」是恒真的',
  ).toHaveCount(1)
  await expect(
    tabLink(page, 'outputs'),
    '动态工作流组的导航里挂着 outputs ⇒ 与回合引擎组同病，点进去必然是空的',
  ).toHaveCount(0)
})
