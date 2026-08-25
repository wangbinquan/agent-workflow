// RFC-319 —— 蒸馏任务队列的用户面（MEM-25/26/27/28/29/30/32/33/47）。
//
// 蒸馏队列是记忆体系里**唯一一段没有人盯着的自动流程**：任务反馈 / 评审 / 反问
// 落库之后，后台 1Hz worker 悄悄拉起一个模型进程去提炼候选记忆，成了就往审批队列里
// 塞一条，败了就自己退避重试三次然后彻底躺平。管理员对这段流程的全部感知，就是
// `/memory?tab=distill-jobs` 这一张表和它背后的详情页。表坏了，这段流程就变成黑箱。
//
// 这个文件锁的是「黑箱化」的几种具体形态，每一种都不响亮：
//
//   ① **状态列写死 / 尝试次数不动** —— 一屋子 job 全显示同一个状态，管理员看不出
//      哪条卡住了。真实后果：一条永久 failed 的蒸馏躺在队列里几周，那条任务反馈
//      再也不会变成记忆，而没有任何告警。
//   ② **Retry 只是把界面上的字改了** —— 按钮点得动、状态变成 Pending，但 worker
//      从没被重新唤起。管理员以为救回来了，实际那条永远不会再跑。所以本文件不断
//      「按钮可点」，断的是**服务端事实**：attempts 归零、lastError 清空、
//      WS 上真的走了 queued → started → done、`exit_code` 从旧的 9 变成新的 0、
//      `user_prompt_md` 从 NULL 被重新写出来（只有 attempts===0 的新一轮才写）。
//   ③ **Cancel 打在了不该打的行上** —— pending 之外的行也给按钮，点下去要么 409
//      要么把已完成的历史改脏。
//   ④ **整行点击与行内按钮抢事件** —— 点 Retry 顺带跳走，管理员在详情页上一脸
//      茫然；或者行根本点不动，详情页只能靠手敲 URL。
//   ⑤ **一个子查询挂了整页白屏** —— 会话（第六段）依赖一份独立的 session 视图，
//      它 500 的时候前五段（含失败诊断、stderr 摘录）必须照常可读——那五段恰恰是
//      排查「为什么会话拿不到」的材料。整页 ErrorBanner 会把材料一起吃掉。
//   ⑥ **daemon 重启把 running 的 job 弄丢或弄坏** —— 丢了 ⇒ 那条永远停在 running，
//      再也不会被 worker 选中（tick 只 select pending）；attempts 被顺手清零 ⇒
//      一条本该在第三次失败后躺平的 job 获得了无限次重试，每次都真的花钱拉模型。
//
// 判据一律取自源码（纯文本引用，禁 GitHub 外链）：
//   packages/frontend/src/components/memory/MemoryDistillJobsTable.tsx:71-83
//       空态：`No distill jobs queued` + 说明文案，且不渲染表格
//   packages/frontend/src/components/memory/MemoryDistillJobsTable.tsx:88-129
//       六列：Job ID / Status / Source / Attempts / Created / Error
//   packages/frontend/src/components/memory/MemoryDistillJobsTable.tsx:102-117
//       整行 onClick → /memory/distill-jobs/$jobId
//   packages/frontend/src/components/memory/MemoryDistillJobsTable.tsx:131-158
//       Retry 只挂 failed、Cancel 只挂 pending，两者都 stopPropagation
//   packages/backend/src/services/memoryDistillScheduler.ts:501-523
//       retryFailedJob：仅 failed 可重试；attempts→0、lastError→NULL、
//       nextRunAt→now（下一 tick 必被 worker 选中）、发 distill.queued
//   packages/backend/src/services/memoryDistillScheduler.ts:526-540
//       cancelPendingJob：仅 pending 可取消 → canceled + finishedAt
//   packages/backend/src/services/memoryDistillScheduler.ts:421-431,473-490
//       startMemoryDistillLoop 开机即 recoverRunning；running→pending，
//       **attempts 原样不动**、startedAt 清空、nextRunAt 不动
//   packages/backend/src/services/memoryDistiller.ts:1092-1107
//       只有 attempts===0 的那一轮才写 user_prompt_md / dedup_snapshot
//   packages/backend/src/services/memoryDistiller.ts:1132-1151
//       每次 spawn 之后无条件把 exit_code / stderr_excerpt / session id 落库
//   packages/frontend/src/routes/memory.distill-jobs.$jobId.tsx:124-190
//       详情页六段的固定结构
//   packages/frontend/src/routes/memory.distill-jobs.$jobId.tsx:172-186
//       session 查询的错误只落在第六段里，前五段照常渲染
//   packages/frontend/src/lib/distill-job-detail.ts:78-89
//       shouldShowFailureDiagnostics：failed / exitCode≠0 / lastError / attempts>0
//   packages/frontend/src/components/memory/distill-job-detail/CandidatesList.tsx:53-60
//       候选行的「Open in Approval Queue」深链 = /memory?focus=<memoryId>
//   packages/frontend/src/routes/memory.tsx:54-61,107-114
//       validateMemorySearch 透传 focus；未知 tab 被改写回 all
//
// 与既有覆盖的分工（避免重复）：
//   * `e2e/memory-distill-gating.spec.ts` 只管**权限门**（MEM-24/31：没有
//     `memory-distill-jobs:manage` 时导航不出现 / 深链回落 / 不发请求）。本文件
//     全程用**有权限的管理员**，一个字都不碰权限。
//   * `e2e/memory-access.spec.ts` 是纯 API 的记忆 ACL（MEM-34/35/36/37/48…），
//     与蒸馏任务表无交集。
//   * `e2e/task-feedback-distill.spec.ts` 锁的是**上游那一跳**（写反馈 → 真的
//     enqueue 出 distill job）。本文件因此**不**再走一遍反馈接口去造 job——那会
//     把同一条链测两遍，还会额外拉起一个不受控的真实蒸馏跑。这里的 job 行由夹具
//     直接落库（`e2e/command.ts:132` runSqlite），source_event 指向真实的
//     task_feedback 行，让详情页的「源事件」段有真东西可解析。
//
// 未覆盖 / 已知空档见文件末尾的说明块。

import { expect, test, type Page } from '@playwright/test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { runSqlite } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
// 其中一条用例要真的把模型进程重新拉起来（stub runtime 子进程 + 落库），
// 另一条要杀掉 daemon 再起一个；两者都远慢于普通页面断言。
test.setTimeout(240_000)

// ---------------------------------------------------------------------------
// 夹具 id 与常量
// ---------------------------------------------------------------------------

/**
 * 26 字符、ULID 形状的夹具 id（真实行带的就是 ULID）。刻意避开 I/L/O/U，
 * 与 Crockford base32 一致——万一将来哪一层给 job id 加了格式校验，夹具不会
 * 因为「长得不像真的」而先红。
 */
function fixtureId(tag: string): string {
  return `01RFC319${tag}`.padEnd(26, '0')
}

/** done + 尝试过两次：详情页六段的主角（attempts>0 ⇒ 诊断卡也在）。 */
const JOB_DONE = fixtureId('JBDNE')
/** 与 JOB_DONE 同 debounce_key 的兄弟行：它的源事件是**已删除**的那一条。 */
const JOB_DONE_SIBLING = fixtureId('JBDNESB')
/** 永久失败：诊断卡的内容（attempts / exitCode / lastError / stderr）。 */
const JOB_FAILED = fixtureId('JBFAED')
/** 永久失败：专供「重试真的把模型进程拉起来」用，跑完会变。 */
const JOB_RETRY = fixtureId('JBRETRY')
/** 永久失败：专供「点 Retry 不许跳转」用，点完也会变。 */
const JOB_RETRY_GUARD = fixtureId('JBRETRYGD')
/** 待执行：专供「取消」用。 */
const JOB_PENDING = fixtureId('JBPENDNG')
/** 待执行：专供「点 Cancel 不许跳转」用。 */
const JOB_PENDING_GUARD = fixtureId('JBPENDGD')
/** 待执行、零尝试、无错误：**任何用例都不动它**，当负向对照（无诊断卡 / 错误列空）。 */
const JOB_CLEAN = fixtureId('JBCLEAN')

/** 真实的 task_feedback 行 id / 任务 id（详情页「源事件」段要解析出它们）。 */
const FEEDBACK_ID = fixtureId('FBREAL')
const FEEDBACK_TASK_ID = fixtureId('TASKREF')
/** 库里不存在的源事件 id：源事件段的负向对照（渲染成 source deleted、无链接）。 */
const FEEDBACK_GONE_ID = fixtureId('FBGNE')

const FEEDBACK_BODY =
  'RFC-319 fixture note: prefer the batch importer over the per-repo form for >20 repos.'

const FAILED_LAST_ERROR =
  'distiller subprocess exited with code 9: model gateway refused the request'
const FAILED_STDERR = [
  'aw-memory-distiller: connecting to model gateway…',
  'aw-memory-distiller: gateway responded 503 (attempt 3/3)',
  'aw-memory-distiller: giving up',
].join('\n')
/** JOB_DONE 上留着的历史失败：它就是「诊断卡在 done 行上也会出现」的原因。 */
const DONE_LAST_ERROR = 'distiller timeout after 120000ms (recovered on the third attempt)'

const DISTILL_SESSION_ID = 'ses_rfc319_distill'
const ATTEMPT0_TEXT = 'RFC-319 attempt 0: gateway timed out before any candidate was emitted.'
const ATTEMPT1_TEXT = 'RFC-319 attempt 1: extracted two candidates from the feedback batch.'
/** 与 services/runtime/opencode/distillSessionCapture.ts:23 的 DISTILL_CAPTURE_FAILED_KIND 一致。 */
const CAPTURE_FAILED_KIND = 'rfc043/distill-capture-failed'

let daemon: DaemonHandle
/** 由 `POST /api/memories` 真实创建的三条记忆：两条候选产出 + 一条去重快照。 */
let candidateMemoryId = ''
let approvedCandidateMemoryId = ''
let dedupMemoryId = ''
/** 夹具行的 createdAt（列表按 createdAt 升序排，用于锁定行顺序与时间列渲染）。 */
const createdAtOf = new Map<string, number>()

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function dbPath(handle: DaemonHandle): string {
  return join(handle.home, 'db.sqlite')
}

/** SQL 字面量转义：夹具文本里有引号和换行，拼进 SQL 前必须转义。 */
function sqlText(value: string | null): string {
  if (value === null) return 'NULL'
  return `'${value.replace(/'/g, "''")}'`
}

function sqlNum(value: number | null): string {
  return value === null ? 'NULL' : String(value)
}

async function apiFetch(
  path: string,
  init: RequestInit = {},
  handle: DaemonHandle = daemon,
): Promise<Response> {
  return fetch(`${handle.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${handle.token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  })
}

async function api<T>(
  path: string,
  init: RequestInit = {},
  handle: DaemonHandle = daemon,
): Promise<T> {
  const res = await apiFetch(path, init, handle)
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return body === '' ? (null as T) : (JSON.parse(body) as T)
}

interface JobRow {
  id: string
  status: string
  attempts: number
  lastError: string | null
  startedAt: number | null
  finishedAt: number | null
  createdAt: number
  sourceKind: string
  exitCode?: number | null
  userPromptMd?: string | null
}

/** 列表接口（不含 RFC-043 采集列）。 */
async function listJobs(handle: DaemonHandle = daemon): Promise<JobRow[]> {
  return (await api<{ items: JobRow[] }>('/api/memory-distill-jobs', {}, handle)).items
}

async function jobFromList(id: string, handle: DaemonHandle = daemon): Promise<JobRow> {
  const row = (await listJobs(handle)).find((j) => j.id === id)
  expect(row, `job ${id} 不在列表里`).toBeDefined()
  return row!
}

/** 详情接口（含 exitCode / userPromptMd / stderrExcerpt 等采集列）。 */
async function jobDetail(id: string, handle: DaemonHandle = daemon): Promise<{ job: JobRow }> {
  return api<{ job: JobRow }>(`/api/memory-distill-jobs/${encodeURIComponent(id)}`, {}, handle)
}

function seedAuth(page: Page, handle: DaemonHandle = daemon): Promise<void> {
  return page.addInitScript(
    ({ baseUrl, token }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    { baseUrl: handle.baseUrl, token: handle.token },
  )
}

async function openDistillList(page: Page, handle: DaemonHandle = daemon): Promise<void> {
  await page.goto(`${handle.baseUrl}/memory?tab=distill-jobs`)
  await expect(page.getByTestId('memory-section-panel')).toBeVisible({ timeout: 30_000 })
}

async function openJobDetail(page: Page, jobId: string): Promise<void> {
  await page.goto(`${daemon.baseUrl}/memory/distill-jobs/${jobId}`)
}

interface SeedJobInput {
  id: string
  debounceKey: string
  sourceKind: 'clarify' | 'review' | 'feedback'
  sourceEventId: string
  taskId?: string | null
  status: 'pending' | 'running' | 'done' | 'failed' | 'canceled'
  attempts: number
  /** 相对 now 的毫秒偏移；pending 行一律给一个远期值，让 1Hz worker 选不中它。 */
  nextRunAt: number
  createdAt: number
  lastError?: string | null
  startedAt?: number | null
  finishedAt?: number | null
  exitCode?: number | null
  stderrExcerpt?: string | null
  userPromptMd?: string | null
  dedupSnapshotIdsJson?: string | null
  outputLang?: string | null
}

function insertJobSql(job: SeedJobInput): string {
  const scope = JSON.stringify({
    agentIds: [],
    workflowId: null,
    repoId: null,
    includeGlobal: true,
  })
  return `INSERT INTO memory_distill_jobs (
      id, debounce_key, source_kind, source_event_id, task_id, scope_resolved_json,
      status, attempts, next_run_at, last_error, created_at, started_at, finished_at,
      opencode_session_id, user_prompt_md, exit_code, stderr_excerpt,
      dedup_snapshot_ids_json, output_lang
    ) VALUES (
      ${sqlText(job.id)}, ${sqlText(job.debounceKey)}, ${sqlText(job.sourceKind)},
      ${sqlText(job.sourceEventId)}, ${sqlText(job.taskId ?? null)}, ${sqlText(scope)},
      ${sqlText(job.status)}, ${job.attempts}, ${job.nextRunAt}, ${sqlText(job.lastError ?? null)},
      ${job.createdAt}, ${sqlNum(job.startedAt ?? null)}, ${sqlNum(job.finishedAt ?? null)},
      NULL, ${sqlText(job.userPromptMd ?? null)}, ${sqlNum(job.exitCode ?? null)},
      ${sqlText(job.stderrExcerpt ?? null)}, ${sqlText(job.dedupSnapshotIdsJson ?? null)},
      ${sqlText(job.outputLang ?? null)}
    );`
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  // 蒸馏 worker 保持**默认开启**（config.memoryDistillerEnabled 未设 ⇒ enabled）。
  // 它是「重试真的重新拉起模型进程」那条用例的被测对象；其余夹具行靠远期
  // next_run_at 或非 pending 状态把自己挡在 tick 的 SELECT 之外，所以队列不会
  // 在用例脚下自己动。
  daemon = await startDaemon({ stubMode: 'basic' })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

/** 三条真实记忆 + 一条真实反馈 + 八条夹具 job。只在第二个 describe 前跑一次。 */
async function seedFixtures(): Promise<void> {
  const created = async (title: string, body: string): Promise<string> => {
    const res = await api<{ memory: { id: string } }>('/api/memories', {
      method: 'POST',
      body: JSON.stringify({ scopeType: 'global', scopeId: null, title, bodyMd: body }),
    })
    return res.memory.id
  }
  candidateMemoryId = await created(
    '[category:convention] RFC-319 fixture — batch import over per-repo forms',
    'When onboarding more than 20 repositories, use the batch importer.',
  )
  approvedCandidateMemoryId = await created(
    '[category:invariant] RFC-319 fixture — distill retries are capped at three',
    'A distill job that fails three times stops retrying and waits for a human.',
  )
  dedupMemoryId = await created(
    '[category:process] RFC-319 fixture — approved memory visible to the distiller',
    'Approved memories in scope are handed to the distiller as dedup context.',
  )
  // 第二条推成 approved：候选段里要同时出现「还没审的」和「已审过的」两种当前状态，
  // 否则 `current: …` 这一行是不是真的读了行状态就分辨不出来。
  await api(`/api/memories/${encodeURIComponent(approvedCandidateMemoryId)}/promote`, {
    method: 'POST',
    body: JSON.stringify({ action: 'approve' }),
  })
  // 去重快照那条也推成 approved——快照记录的本来就是「运行时可见的已批准记忆」。
  await api(`/api/memories/${encodeURIComponent(dedupMemoryId)}/promote`, {
    method: 'POST',
    body: JSON.stringify({ action: 'approve' }),
  })

  const now = Date.now()
  const base = now - 60 * 60 * 1000
  const at = (i: number): number => base + i * 60_000
  // pending 行的 next_run_at 推到一小时后：1Hz worker 的 SELECT 条件是
  // `status='pending' AND next_run_at <= now`（memoryDistillScheduler.ts:287-292），
  // 远期值让这些行在整个用例期间原地不动。
  const far = now + 60 * 60 * 1000

  const dedupSnapshot = JSON.stringify({
    snapshot: [
      {
        memoryId: dedupMemoryId,
        scopeType: 'global',
        scopeId: null,
        title: '[category:process] RFC-319 fixture — approved memory visible to the distiller',
      },
    ],
  })

  const jobs: SeedJobInput[] = [
    {
      id: JOB_CLEAN,
      debounceKey: `rfc319:clean`,
      sourceKind: 'clarify',
      sourceEventId: fixtureId('CLARFY'),
      taskId: FEEDBACK_TASK_ID,
      status: 'pending',
      attempts: 0,
      nextRunAt: far,
      createdAt: at(1),
    },
    {
      id: JOB_DONE,
      debounceKey: `rfc319:done`,
      sourceKind: 'feedback',
      sourceEventId: FEEDBACK_ID,
      taskId: FEEDBACK_TASK_ID,
      status: 'done',
      attempts: 2,
      nextRunAt: at(2),
      createdAt: at(2),
      lastError: DONE_LAST_ERROR,
      startedAt: at(2) + 1_000,
      finishedAt: at(2) + 9_000,
      exitCode: 0,
      userPromptMd: '# RFC-319 fixture prompt\n\nFeedback batch of 1.',
      dedupSnapshotIdsJson: dedupSnapshot,
      outputLang: 'en-US',
    },
    {
      id: JOB_DONE_SIBLING,
      debounceKey: `rfc319:done`,
      sourceKind: 'feedback',
      sourceEventId: FEEDBACK_GONE_ID,
      taskId: FEEDBACK_TASK_ID,
      status: 'done',
      attempts: 2,
      nextRunAt: at(3),
      createdAt: at(3),
      finishedAt: at(3) + 9_000,
      exitCode: 0,
    },
    {
      id: JOB_FAILED,
      debounceKey: `rfc319:failed`,
      sourceKind: 'review',
      sourceEventId: fixtureId('REVEW'),
      taskId: FEEDBACK_TASK_ID,
      status: 'failed',
      attempts: 3,
      nextRunAt: at(4),
      createdAt: at(4),
      lastError: FAILED_LAST_ERROR,
      startedAt: at(4) + 1_000,
      finishedAt: at(4) + 4_000,
      exitCode: 9,
      stderrExcerpt: FAILED_STDERR,
    },
    {
      id: JOB_RETRY,
      debounceKey: `rfc319:retry`,
      sourceKind: 'feedback',
      sourceEventId: FEEDBACK_ID,
      taskId: FEEDBACK_TASK_ID,
      status: 'failed',
      attempts: 3,
      nextRunAt: at(5),
      createdAt: at(5),
      lastError: FAILED_LAST_ERROR,
      startedAt: at(5) + 1_000,
      finishedAt: at(5) + 4_000,
      exitCode: 9,
      stderrExcerpt: FAILED_STDERR,
      // user_prompt_md 刻意留 NULL：重试之后它被重新写出来，就是
      // 「runDistill 真的从头跑了一轮」的服务端凭据（memoryDistiller.ts:1092-1107）。
      userPromptMd: null,
    },
    {
      id: JOB_RETRY_GUARD,
      debounceKey: `rfc319:retry-guard`,
      sourceKind: 'feedback',
      sourceEventId: FEEDBACK_ID,
      taskId: FEEDBACK_TASK_ID,
      status: 'failed',
      attempts: 3,
      nextRunAt: at(6),
      createdAt: at(6),
      lastError: FAILED_LAST_ERROR,
      finishedAt: at(6) + 4_000,
      exitCode: 9,
    },
    {
      id: JOB_PENDING,
      debounceKey: `rfc319:pending`,
      sourceKind: 'feedback',
      sourceEventId: FEEDBACK_ID,
      taskId: FEEDBACK_TASK_ID,
      status: 'pending',
      attempts: 0,
      nextRunAt: far,
      createdAt: at(7),
    },
    {
      id: JOB_PENDING_GUARD,
      debounceKey: `rfc319:pending-guard`,
      sourceKind: 'feedback',
      sourceEventId: FEEDBACK_ID,
      taskId: FEEDBACK_TASK_ID,
      status: 'pending',
      attempts: 0,
      nextRunAt: far,
      createdAt: at(8),
    },
  ]
  for (const job of jobs) createdAtOf.set(job.id, job.createdAt)

  const statements = [
    // 真实的反馈行：详情页「源事件」段要把它解析成带摘要 + 深链的一条。
    `INSERT INTO task_feedback (id, task_id, author_user_id, body_md, created_at, distilled, distill_job_id)
       VALUES (${sqlText(FEEDBACK_ID)}, ${sqlText(FEEDBACK_TASK_ID)}, NULL,
               ${sqlText(FEEDBACK_BODY)}, ${at(0)}, 1, ${sqlText(JOB_DONE)});`,
    ...jobs.map(insertJobSql),
    // JOB_DONE 的两轮会话：第 0 轮采集失败（负向），第 1 轮有正常对话（正向）。
    `INSERT INTO memory_distill_events (distill_job_id, attempt_index, session_id, parent_session_id, ts, kind, payload)
       VALUES (${sqlText(JOB_DONE)}, 0, ${sqlText(DISTILL_SESSION_ID)}, NULL, ${at(2) + 2_000}, 'text',
               ${sqlText(
                 JSON.stringify({
                   type: 'text',
                   sessionID: DISTILL_SESSION_ID,
                   messageID: 'm-a0',
                   part: { id: 'p-a0', type: 'text', text: ATTEMPT0_TEXT },
                   timestamp: at(2) + 2_000,
                 }),
               )});`,
    `INSERT INTO memory_distill_events (distill_job_id, attempt_index, session_id, parent_session_id, ts, kind, payload)
       VALUES (${sqlText(JOB_DONE)}, 0, ${sqlText(DISTILL_SESSION_ID)}, NULL, ${at(2) + 3_000},
               ${sqlText(CAPTURE_FAILED_KIND)}, '{"reason":"opencode-db-not-found"}');`,
    `INSERT INTO memory_distill_events (distill_job_id, attempt_index, session_id, parent_session_id, ts, kind, payload)
       VALUES (${sqlText(JOB_DONE)}, 1, ${sqlText(`${DISTILL_SESSION_ID}_r1`)}, NULL, ${at(2) + 8_000}, 'text',
               ${sqlText(
                 JSON.stringify({
                   type: 'text',
                   sessionID: `${DISTILL_SESSION_ID}_r1`,
                   messageID: 'm-a1',
                   part: { id: 'p-a1', type: 'text', text: ATTEMPT1_TEXT },
                   timestamp: at(2) + 8_000,
                 }),
               )});`,
    // 把两条记忆挂到 JOB_DONE 上，让「产出候选」段有内容（真实链路由 distiller
    // 的 persistCandidate 写这两列；stub runtime 不会吐 candidates 端口，所以夹具直连）。
    `UPDATE memories SET distill_job_id = ${sqlText(JOB_DONE)}, distill_action = 'new',
        source_kind = 'feedback', source_event_id = ${sqlText(FEEDBACK_ID)},
        source_task_id = ${sqlText(FEEDBACK_TASK_ID)}
      WHERE id = ${sqlText(candidateMemoryId)};`,
    `UPDATE memories SET distill_job_id = ${sqlText(JOB_DONE)}, distill_action = 'update_of',
        supersedes_id = ${sqlText(dedupMemoryId)},
        source_kind = 'feedback', source_event_id = ${sqlText(FEEDBACK_ID)},
        source_task_id = ${sqlText(FEEDBACK_TASK_ID)}
      WHERE id = ${sqlText(approvedCandidateMemoryId)};`,
  ]
  runSqlite(dbPath(daemon), statements.join('\n'))
}

// ---------------------------------------------------------------------------
// MEM-25（空态）—— 必须跑在任何夹具落库之前
// ---------------------------------------------------------------------------

test('MEM-25 空队列：给的是「没有蒸馏任务」的说明，不是一张空表格', async ({ page }) => {
  await seedAuth(page)
  await page.goto(`${daemon.baseUrl}/memory`)

  // 走导航进这一格（而不是直接敲 URL）——管理员的真实路径就是点这个入口。
  const navLink = page.getByTestId('memory-section-distill-jobs')
  await expect(
    navLink,
    '管理员在记忆页导航里找不到蒸馏任务入口 ⇒ 这段自动流程只能靠手敲 URL 才看得见',
  ).toBeVisible({
    timeout: 30_000,
  })
  await navLink.click()

  await expect(page.getByTestId('memory-section-panel')).toHaveClass(
    /memory-section-panel--distill-jobs/,
  )
  // 空态必须自带「这里将来会出现什么」的说明。只留一行冷冰冰的 "empty"，
  // 管理员分不清是「没有任务」还是「加载失败/权限不足」。
  await expect(page.getByText('No distill jobs queued')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Feedback and review events create jobs automatically')).toBeVisible()
  await expect(
    page.getByTestId('memory-distill-jobs'),
    '一条 job 都没有却渲染了表格 ⇒ 管理员看到的是一张只有表头的空壳，读不出「本来就没有」',
  ).toHaveCount(0)

  // 服务端对账：此刻确实一条都没有。少了这一句，上面的空态可能只是没加载出来。
  expect(await listJobs(), '空态是真的空，不是没加载').toEqual([])
})

// ---------------------------------------------------------------------------
// 有数据之后
// ---------------------------------------------------------------------------

test.describe('队列里有任务之后', () => {
  test.beforeAll(seedFixtures)

  test('MEM-25 列表六列：状态 / 来源 / 尝试次数 / 创建时间 / 最后错误各自读的是行上的真值', async ({
    page,
  }) => {
    await seedAuth(page)
    await openDistillList(page)

    const table = page.getByTestId('memory-distill-jobs')
    await expect(table).toBeVisible({ timeout: 20_000 })
    // 正向 ↔ 负向对照：上一条用例断言过「没有行就没有表格」，这里断言
    // 「有行就没有空态」。两句合起来才排除「空态与表格同时/都不渲染」。
    await expect(
      page.getByText('No distill jobs queued'),
      '有 8 条 job 却仍然显示空态 ⇒ 管理员会以为队列是空的，永远不会去救那条 failed',
    ).toHaveCount(0)

    for (const header of ['Job ID', 'Status', 'Source', 'Attempts', 'Created', 'Error']) {
      await expect(
        table.getByRole('columnheader', { name: header, exact: true }),
        `列头缺了「${header}」⇒ 这一列的值失去了含义，管理员只能靠猜`,
      ).toBeVisible()
    }

    // ---- 状态列：三种状态必须各自不同，不能是写死的一个字 ----
    const cellsOf = (id: string) => table.getByTestId(`distill-job-row-${id}`).locator('td')
    await expect(cellsOf(JOB_FAILED).nth(1)).toHaveText('Failed')
    await expect(cellsOf(JOB_DONE).nth(1)).toHaveText('Done')
    await expect(
      cellsOf(JOB_CLEAN).nth(1),
      '三种不同 status 的行显示了同一个词 ⇒ 队列里哪条卡住了完全看不出来',
    ).toHaveText('Pending')

    // ---- 来源列：同样三种，证明它读的是 sourceKind 而不是常量 ----
    await expect(cellsOf(JOB_DONE).nth(2)).toHaveText('Feedback')
    await expect(cellsOf(JOB_FAILED).nth(2)).toHaveText('Review')
    await expect(
      cellsOf(JOB_CLEAN).nth(2),
      '来源列印的是同一个词 ⇒ 「这条记忆是从哪来的」这条追溯链在第一跳就断了',
    ).toHaveText('Clarify')

    // ---- 尝试次数：0 与 3 必须分得开 ----
    await expect(cellsOf(JOB_FAILED).nth(3)).toHaveText('3')
    await expect(
      cellsOf(JOB_CLEAN).nth(3),
      '尝试次数不随行变化 ⇒ 分不出「还没跑过」和「已经跑挂三次」，退避是否耗尽无从判断',
    ).toHaveText('0')

    // ---- 创建时间：与浏览器自己的 toLocaleString 逐字节相同 ----
    // 直接比字符串会被跑测机器的 locale / 时区左右；拿页面自己的 Date 去算，
    // 断的才是「这一格渲染的是这一行的 createdAt」，与环境无关。
    const doneCreatedAt = createdAtOf.get(JOB_DONE)!
    const expectedCreated = await page.evaluate(
      (ms) => new Date(ms).toLocaleString(),
      doneCreatedAt,
    )
    await expect(
      cellsOf(JOB_DONE).nth(4),
      '创建时间渲染的不是这一行的 createdAt ⇒ 「这条卡了多久」判断错，救援优先级全乱',
    ).toHaveText(expectedCreated)

    // 顺序也由 createdAt 决定（listDistillJobs 按 createdAt 升序）。乱序的表
    // 会让管理员误以为最新的那条在最上面。
    const domIds = await table
      .locator('tbody tr')
      .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-testid') ?? ''))
    const seededOrder = [...createdAtOf.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => `distill-job-row-${id}`)
    expect(
      domIds.filter((id) => seededOrder.includes(id)),
      '行顺序与 createdAt 升序不一致 ⇒ 表格看起来像随机排列，找不到「最近排进来的那条」',
    ).toEqual(seededOrder)

    // ---- 最后错误：有错的显示全文，没错的必须是**空**而不是 "null"/"undefined" ----
    await expect(cellsOf(JOB_FAILED).nth(5)).toHaveText(FAILED_LAST_ERROR)
    await expect(
      cellsOf(JOB_CLEAN).nth(5),
      'lastError 为 NULL 的行把 "null" 印进了错误列 ⇒ 管理员会去排查一个不存在的故障',
    ).toHaveText('')

    // ---- 行内操作只挂在能操作的状态上 ----
    await expect(page.getByTestId(`distill-job-row-${JOB_FAILED}-retry`)).toBeVisible()
    await expect(
      page.getByTestId(`distill-job-row-${JOB_FAILED}-cancel`),
      'failed 行给了 Cancel ⇒ 点下去必然 409（cancelPendingJob 只收 pending），是一颗纯粹的坑',
    ).toHaveCount(0)
    await expect(page.getByTestId(`distill-job-row-${JOB_CLEAN}-cancel`)).toBeVisible()
    await expect(
      page.getByTestId(`distill-job-row-${JOB_CLEAN}-retry`),
      'pending 行给了 Retry ⇒ 同上，retryFailedJob 只收 failed',
    ).toHaveCount(0)
    await expect(
      page.getByTestId(`distill-job-row-${JOB_DONE}-retry`),
      'done 行给了 Retry ⇒ 会把一条已完成的历史重新拉起来跑，白花一次模型调用',
    ).toHaveCount(0)
    await expect(page.getByTestId(`distill-job-row-${JOB_DONE}-cancel`)).toHaveCount(0)
  })

  test('MEM-28 整行点击进详情，而 Retry / Cancel 是行内操作、不许顺带把人跳走', async ({
    page,
  }) => {
    await seedAuth(page)
    await openDistillList(page)

    // ① 整行点击（点在 Job ID 那一格上）→ 详情页。
    await page.getByTestId(`distill-job-row-${JOB_DONE}`).locator('td').first().click()
    await expect(
      page,
      '整行点不动 ⇒ 想看某条 job 的诊断只能手拼 /memory/distill-jobs/<id>，等于这张表没有出口',
    ).toHaveURL(new RegExp(`/memory/distill-jobs/${JOB_DONE}$`), { timeout: 20_000 })
    await expect(page.getByTestId('distill-source-events-section')).toBeVisible({ timeout: 20_000 })

    // ② 回列表，点 Cancel：动作要生效，但**不能**跳转。
    await openDistillList(page)
    await page.getByTestId(`distill-job-row-${JOB_PENDING_GUARD}-cancel`).click()
    await expect
      .poll(async () => (await jobFromList(JOB_PENDING_GUARD)).status, { timeout: 15_000 })
      .toBe('canceled')
    expect(
      new URL(page.url()).pathname,
      '点 Cancel 顺带跳进了详情页 ⇒ 管理员的下一次点击会落在完全不同的页面上，最常见的后果是误操作另一条 job',
    ).toBe('/memory')

    // ③ 同样地点 Retry：状态要动，人要留在列表上。
    await page.getByTestId(`distill-job-row-${JOB_RETRY_GUARD}-retry`).click()
    await expect
      .poll(async () => (await jobFromList(JOB_RETRY_GUARD)).status, { timeout: 15_000 })
      .not.toBe('failed')
    expect(new URL(page.url()).pathname, '点 Retry 顺带跳进了详情页 ⇒ 同上').toBe('/memory')
  })

  test('MEM-27 取消待执行的蒸馏任务：pending → canceled，且取消后不再提供任何操作', async ({
    page,
  }) => {
    await seedAuth(page)
    await openDistillList(page)

    const before = await jobFromList(JOB_PENDING)
    expect(before.status, '前置条件：这条必须还是 pending').toBe('pending')
    expect(before.finishedAt, 'pending 行不该有 finishedAt').toBeNull()

    await page.getByTestId(`distill-job-row-${JOB_PENDING}-cancel`).click()

    // 界面上要立刻反映出来（mutation onSuccess 会 invalidate 列表）。
    await expect(
      page.getByTestId(`distill-job-row-${JOB_PENDING}`).locator('td').nth(1),
      '取消了但表上还写着 Pending ⇒ 管理员会以为没点上，再点一次，然后收到一个 409 弹窗',
    ).toHaveText('Canceled', { timeout: 20_000 })

    // 服务端对账：状态真的落了库，并且盖上了结束时间。只断界面的话，
    // 一个纯前端的乐观更新就能骗过这条用例。
    const after = await jobFromList(JOB_PENDING)
    expect(after.status, '界面说取消了，库里还是 pending ⇒ worker 到点照跑，白花一次模型调用').toBe(
      'canceled',
    )
    expect(
      after.finishedAt,
      'canceled 却没有 finishedAt ⇒ 这条 job 在报表里永远算作「还没结束」',
    ).not.toBeNull()
    expect(after.attempts, '取消不该改动尝试次数——它记录的是历史，不是当前意图').toBe(0)

    // 取消是终态：不许再出现 Retry / Cancel。
    await expect(
      page.getByTestId(`distill-job-row-${JOB_PENDING}-cancel`),
      'canceled 行还留着 Cancel ⇒ 再点必然 409',
    ).toHaveCount(0)
    await expect(
      page.getByTestId(`distill-job-row-${JOB_PENDING}-retry`),
      'canceled 行冒出了 Retry ⇒ retryFailedJob 只收 failed，同样是必然失败的按钮',
    ).toHaveCount(0)
  })

  test('MEM-29 蒸馏任务详情页：六段各自有内容，且每一段读的是这条 job 自己的数据', async ({
    page,
  }) => {
    await seedAuth(page)
    await openJobDetail(page, JOB_DONE)

    // ── 第一段：头部元信息 ───────────────────────────────────────────────
    await expect(
      page.locator('code', { hasText: JOB_DONE }).first(),
      '详情页标题里没有 job id ⇒ 两个标签页开着两条 job 时分不出谁是谁',
    ).toBeVisible({ timeout: 30_000 })
    // 元信息一律限定在头部那一条里读——不限定的话，页面别处任何一个 "Done"
    // 都能让这几句变成空断言。
    const meta = page.locator('.distill-job-detail__meta')
    await expect(
      meta.locator('.status-chip'),
      '头部不给状态 ⇒ 打开一条 job 看不出它是跑完了还是还卡着',
    ).toHaveText('Done')
    await expect(
      meta,
      '头部不报来源 ⇒ 「这条 job 是哪个事件触发的」要翻到第三段才知道',
    ).toContainText('Feedback')
    await expect(
      meta,
      '头部不报尝试次数 ⇒ 「这条是一次过还是救了三次」在第一屏就看不见',
    ).toContainText('attempts: 2')
    await expect(page.getByTestId('distill-job-detail-output-lang')).toContainText('English')
    // 面包屑要能回到**蒸馏任务那一格**——回到默认分区等于把人扔回起点，
    // 详情页就成了单程票。
    await expect(
      page.locator('.distill-job-detail__crumbs').getByRole('link'),
      '面包屑没有回到蒸馏任务分区 ⇒ 看完一条 job 想看下一条，得从记忆页首屏重新点进来',
    ).toHaveAttribute('href', '/memory?tab=distill-jobs')

    // ── 第二段：失败诊断（这条 status=done 但 attempts=2，按判据依然要出现）──
    await expect(
      page.getByTestId('distill-failure-diagnostics'),
      'done 但重试过的 job 不给诊断卡 ⇒ 「为什么跑了三次」这条线索被丢掉，反复失败的模式无从发现',
    ).toBeVisible()
    await expect(page.getByTestId('distill-failure-diagnostics')).toContainText(DONE_LAST_ERROR)

    // ── 第三段：源事件（正向：真实反馈行 / 负向：已删除的兄弟行）─────────
    const events = page.getByTestId('distill-source-events-section')
    await expect(events).toBeVisible()
    await expect(
      page.getByTestId('distill-source-events-feedback'),
      '源事件没有按类型分组 ⇒ 一条合并了多个来源的 job 里，谁是谁完全分不清',
    ).toContainText('Feedback · 2')
    const liveEvent = page.getByTestId(`distill-source-event-row-${FEEDBACK_ID}`)
    await expect(liveEvent).toContainText(FEEDBACK_BODY.slice(0, 40))
    // 深链要能回到那条反馈本身——这是「这条记忆凭什么产生」的唯一回溯路径。
    await expect(page.getByTestId(`distill-source-event-link-${FEEDBACK_ID}`)).toHaveAttribute(
      'href',
      `/tasks/${FEEDBACK_TASK_ID}?tab=feedback#${encodeURIComponent(`feedback-${FEEDBACK_ID}`)}`,
    )
    // 负向对照：源已被删除的那条要明说「删了」，且**不给链接**——给了就是一个必 404 的入口。
    const goneEvent = page.getByTestId(`distill-source-event-row-${FEEDBACK_GONE_ID}`)
    await expect(goneEvent).toContainText('source deleted')
    await expect(
      page.getByTestId(`distill-source-event-link-${FEEDBACK_GONE_ID}`),
      '源事件已删除却仍然给了链接 ⇒ 点进去是一个 404，管理员会以为是权限问题',
    ).toHaveCount(0)

    // ── 第四段：scope + 去重快照 ─────────────────────────────────────────
    const scope = page.getByTestId('distill-scope-and-dedup')
    await expect(scope).toBeVisible()
    await expect(
      scope,
      'scope 段不说明蒸馏器看到的是哪一层 ⇒ 「为什么它没看见那条记忆」无从判断',
    ).toContainText('global')
    await expect(
      page.getByTestId(`distill-dedup-row-${dedupMemoryId}`),
      '去重快照丢了 ⇒ 「它当时到底看没看到那条已批准的记忆」无法回答，重复候选的成因永远查不清',
    ).toBeVisible()

    // ── 第五段：产出候选（一条待审 + 一条已批准，当前状态必须各读各的）────
    await expect(page.getByTestId('distill-candidates')).toBeVisible()
    const pendingCandidate = page.getByTestId(`distill-candidate-row-${candidateMemoryId}`)
    const approvedCandidate = page.getByTestId(`distill-candidate-row-${approvedCandidateMemoryId}`)
    await expect(pendingCandidate).toContainText('current: Candidate')
    await expect(
      approvedCandidate,
      '两条状态不同的候选显示了同一个 current ⇒ 分不出哪条还等着人审，审批队列的负担被低估',
    ).toContainText('current: Approved')
    await expect(pendingCandidate).toContainText('New')
    await expect(
      approvedCandidate,
      'distillAction 没读行上的值 ⇒ 「这条是新增还是覆盖了旧记忆」看不出来，覆盖会被当成新增批准',
    ).toContainText(`Updates ${dedupMemoryId}`)

    // ── 第六段：模型会话（两轮，含一轮采集失败）──────────────────────────
    await expect(page.getByTestId('distill-conversation')).toBeVisible()
    await expect(page.getByTestId('distill-attempt-0')).toBeVisible()
    await expect(
      page.getByTestId('distill-attempt-1'),
      '多轮重试只留下一轮会话 ⇒ 「上一次它是怎么答的」永远看不到，回归对比做不了',
    ).toBeVisible()
    // 默认停在最新一轮——管理员先关心的是「最近这次它干了什么」。
    await expect(page.getByText(ATTEMPT1_TEXT)).toBeVisible()
    // 切到第 0 轮：要能看到那一轮的正文，并且明确告知这一轮的采集是坏的。
    await page.getByTestId('distill-attempt-0').click()
    await expect(page.getByText(ATTEMPT0_TEXT)).toBeVisible()
    await expect(
      page.getByTestId('distill-conversation-capture-failed'),
      '采集失败的那一轮不作声明 ⇒ 管理员会把「没抓到」当成「模型什么都没说」',
    ).toBeVisible()
  })

  test('MEM-30 失败诊断卡：attempts / exitCode / lastError / stderr 摘录四样齐全，且不该出现时不出现', async ({
    page,
  }) => {
    await seedAuth(page)
    await openJobDetail(page, JOB_FAILED)

    const card = page.getByTestId('distill-failure-diagnostics')
    await expect(
      card,
      'failed 的 job 不给诊断卡 ⇒ 管理员只能看到「Failed」两个字，排查要从翻服务端日志开始',
    ).toBeVisible({ timeout: 30_000 })

    await expect(card.getByText('Attempts')).toBeVisible()
    await expect(
      card.locator('dd').filter({ hasText: /^3$/ }),
      '诊断卡不报尝试次数 ⇒ 分不清是「刚挂第一次、还会自动重试」还是「三次耗尽、必须人工介入」',
    ).toBeVisible()
    await expect(card.getByText('Exit code')).toBeVisible()
    await expect(
      card.locator('code', { hasText: '9' }),
      '退出码丢失 ⇒ 「进程根本没起来」和「起来了但报错退出」这两类完全不同的故障被混为一谈',
    ).toBeVisible()
    await expect(card).toContainText(FAILED_LAST_ERROR)
    await expect(card.getByText('Subprocess stderr (truncated)')).toBeVisible()
    await expect(
      card.locator('pre'),
      'stderr 摘录不显示 ⇒ 唯一一段来自模型进程自己的原始证据被吞掉',
    ).toContainText('gateway responded 503')

    // 负向对照：没什么可诊断的行（pending / 零尝试 / 无错误 / 无退出码）
    // 不许挂一张空诊断卡——空卡会被读成「有故障但细节丢了」。
    await openJobDetail(page, JOB_CLEAN)
    await expect(page.getByTestId('distill-scope-section')).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByTestId('distill-failure-diagnostics'),
      '从没跑过的 job 也挂诊断卡 ⇒ 每条 job 看起来都出过事，真正出事的那条被淹没',
    ).toHaveCount(0)
  })

  test('MEM-33 候选行的「在审批队列中打开」深链：带着 memoryId 落到记忆页且参数不被吃掉', async ({
    page,
  }) => {
    await seedAuth(page)
    await openJobDetail(page, JOB_DONE)

    const link = page.getByTestId(`distill-candidate-link-${candidateMemoryId}`)
    await expect(link).toBeVisible({ timeout: 30_000 })
    await expect(
      link,
      '候选行的深链没带上 memoryId ⇒ 从蒸馏结果跳回审批面时丢掉了「是哪一条」，人得自己在队列里翻',
    ).toHaveAttribute('href', `/memory?focus=${candidateMemoryId}`)

    await link.click()
    await expect(page).toHaveURL(new RegExp(`/memory\\?focus=${candidateMemoryId}$`), {
      timeout: 20_000,
    })
    // 落地页必须真的渲染出来。深链最常见的坏法不是跳错，而是跳过去白屏。
    await expect(
      page.getByTestId('memory-section-panel'),
      '深链落地后记忆页没渲染 ⇒ 从详情页点出去就是一堵白墙',
    ).toBeVisible({ timeout: 20_000 })

    // 负向对照：把 tab 写坏（书签老化 / 手改 URL 的常见形态）。
    // 未知 tab 要被改写回 all，而 focus 这个「不属于本路由校验范围」的参数
    // 必须原样透传——validateMemorySearch 把无关键透传给相邻路由用，
    // 顺手吃掉它就等于把深链的载荷丢了。
    await page.goto(`${daemon.baseUrl}/memory?tab=distill-jobz&focus=${candidateMemoryId}`)
    await expect(page.getByTestId('memory-section-panel')).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(() => new URL(page.url()).searchParams.get('tab'), { timeout: 15_000 })
      .toBe('all')
    expect(
      new URL(page.url()).searchParams.get('focus'),
      '纠正非法 tab 的时候把 focus 一起清掉了 ⇒ 一个过期书签会顺手毁掉深链载荷',
    ).toBe(candidateMemoryId)
  })

  test('MEM-32 会话查询挂掉时：错误只落在第六段，前五段照常可读，并且能就地重试', async ({
    page,
  }) => {
    await seedAuth(page)

    // 只截会话那一条请求；详情那条 (`/api/memory-distill-jobs/<id>`) 不在这个
    // 模式里，保持真实响应——这正是本条要验证的「两个查询彼此独立」。
    const sessionRoute = '**/api/memory-distill-jobs/*/session'
    await page.route(sessionRoute, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'internal', message: 'session store unavailable' } }),
      }),
    )

    await openJobDetail(page, JOB_DONE)

    await expect(
      page.getByTestId('distill-session-load-error'),
      '会话拿不到却不作声 ⇒ 管理员会以为这次运行本来就没有对话，然后去查一个不存在的问题',
    ).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('distill-session-load-error')).toContainText(
      'Failed to load conversation',
    )

    // 前五段必须完好。它们恰恰是排查「会话为什么拿不到」的材料，
    // 整页 ErrorBanner 会把材料连同故障一起端走。
    await expect(page.locator('code', { hasText: JOB_DONE }).first()).toBeVisible()
    await expect(
      page.getByTestId('distill-failure-diagnostics'),
      '第六段挂掉带走了失败诊断 ⇒ 排查所需的 exitCode / stderr 一起消失',
    ).toBeVisible()
    await expect(page.getByTestId('distill-source-events-section')).toBeVisible()
    await expect(page.getByTestId('distill-scope-and-dedup')).toBeVisible()
    await expect(
      page.getByTestId('distill-candidates'),
      '第六段挂掉带走了候选列表 ⇒ 这次运行到底产出了什么也看不到了',
    ).toBeVisible()

    // 段内重试：把拦截撤掉，点这一段自己的 Retry，只有这一段需要恢复——
    // 没有段内重试的话，管理员唯一的手段是整页刷新，前五段的滚动位置和展开状态一起丢。
    await page.unroute(sessionRoute)
    await page
      .getByTestId('distill-session-load-error')
      .getByRole('button', { name: 'Retry' })
      .click()
    await expect(
      page.getByTestId('distill-conversation'),
      '段内重试点了没反应 ⇒ 一次瞬时故障要靠整页刷新才能恢复',
    ).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('distill-session-load-error')).toHaveCount(0)
  })

  test('MEM-26 重试失败的蒸馏任务：attempts 归零、状态真的流转，并且模型进程被重新拉起来了', async ({
    page,
  }) => {
    await seedAuth(page)

    // 前置事实（服务端）：这条是彻底失败的，且从没写过 user_prompt_md。
    const before = (await jobDetail(JOB_RETRY)).job
    expect(before.status).toBe('failed')
    expect(before.attempts).toBe(3)
    expect(before.exitCode, '前置：上一轮进程以 9 退出').toBe(9)
    expect(before.userPromptMd, '前置：这条从没跑过完整的一轮').toBeNull()

    // WS 是「状态流转」唯一不受轮询时机影响的证据面：queued / started / done
    // 三条消息各自对应 retryFailedJob 的入队、worker 的认领（pending→running）、
    // 以及本轮跑完（→done）。只靠轮询会在 1Hz 的 tick 之间漏掉中间态。
    const frames: string[] = []
    let socketOpened = false
    page.on('websocket', (ws) => {
      if (!ws.url().includes('memory-distill-jobs')) return
      socketOpened = true
      ws.on('framereceived', (frame) => frames.push(String(frame.payload)))
    })

    await openDistillList(page)
    await expect(page.getByTestId(`distill-job-row-${JOB_RETRY}`).locator('td').nth(1)).toHaveText(
      'Failed',
    )
    // 先确认订阅真的建起来了再点。没有这一步，「没收到 distill.queued」既可能是
    // 产品没广播，也可能只是我们晚了一步连上——两种原因指向完全不同的修法。
    await expect.poll(() => socketOpened, { timeout: 20_000 }).toBe(true)
    await page.getByTestId(`distill-job-row-${JOB_RETRY}-retry`).click()

    // ① 服务端事实：尝试次数归零、上一轮的错误被清掉，且不再是 failed。
    //    （不断言「此刻正好是 pending」——1Hz 的 worker 会在一秒内把它认领走，
    //     断某一瞬间的状态就是在赌 tick 的时机；状态流转由下面的 WS 序列锁定。）
    await expect
      .poll(async () => (await jobFromList(JOB_RETRY)).status, { timeout: 20_000 })
      .not.toBe('failed')
    const afterRetry = await jobFromList(JOB_RETRY)
    expect(
      afterRetry.attempts,
      '重试没把 attempts 归零 ⇒ 这条还剩 0 次预算，下一次失败立刻又永久躺平，管理员的这次救援等于没做',
    ).toBe(0)
    expect(
      afterRetry.lastError,
      '重试没清掉上一轮的错误 ⇒ 表格上永远挂着一条已经过期的报错，真正的新故障被它盖住',
    ).toBeNull()

    // ② 真的跑完了一轮：状态流转到 done。
    await expect
      .poll(async () => (await jobFromList(JOB_RETRY)).status, { timeout: 120_000 })
      .toBe('done')

    // ③ 模型进程真的被重新拉起来：这两列只有在 spawn 之后 / 新一轮开头才会被写。
    const after = (await jobDetail(JOB_RETRY)).job
    expect(
      after.exitCode,
      'exit_code 还停在上一轮的 9 ⇒ 没有任何新进程被拉起来，Retry 只是改了库里的状态字段',
    ).toBe(0)
    expect(
      after.userPromptMd,
      'user_prompt_md 仍为空 ⇒ runDistill 从没进入新的一轮（它只在 attempts===0 的那一轮开头写这一列）',
    ).not.toBeNull()

    // ④ WS 上的状态流转序列：入队 → 被 worker 认领 → 跑完。
    const mine = frames.filter((f) => f.includes(JOB_RETRY))
    expect(
      mine.some((f) => f.includes('distill.queued')),
      'retry 没有广播 distill.queued ⇒ 别的标签页 / 徽标不会知道这条被救回来了',
    ).toBe(true)
    expect(
      mine.some((f) => f.includes('distill.started')),
      '没有 distill.started ⇒ worker 从没认领过这条（pending→running 这一跳没发生），说明它根本没被重新调度',
    ).toBe(true)
    expect(
      mine.some((f) => f.includes('distill.done')),
      '没有 distill.done ⇒ 这一轮没有跑到底',
    ).toBe(true)

    // ⑤ 界面上也要收敛到 Done（WS 会把列表 invalidate 掉）。
    await expect(
      page.getByTestId(`distill-job-row-${JOB_RETRY}`).locator('td').nth(1),
      '库里已经 done，表上还写着 Failed ⇒ 管理员会重复点 Retry，每点一次都真的花一次模型调用',
    ).toHaveText('Done', { timeout: 30_000 })
  })
})

// ---------------------------------------------------------------------------
// MEM-47 —— daemon 重启后的中断回收（自带一对 daemon，和上面的队列互不干扰）
// ---------------------------------------------------------------------------

test('MEM-47 daemon 重启：中断在 running 的蒸馏任务被重排回 pending，且 attempts 不许被清零', async ({
  page,
}) => {
  const interrupted = fixtureId('JBRUNNNG')
  const untouchedPending = fixtureId('JBKEEPPD')
  const untouchedDone = fixtureId('JBKEEPDN')

  // 崩溃前的那个 daemon。蒸馏 worker 保持默认开启——回收逻辑就挂在它的启动路径上。
  const daemonA = await startDaemon({ stubMode: 'basic' })
  const home = daemonA.home
  let daemonB: DaemonHandle | undefined
  try {
    const now = Date.now()
    const far = now + 60 * 60 * 1000
    runSqlite(
      dbPath(daemonA),
      [
        // 正在跑、已经失败过两次的那一条：崩溃现场。
        insertJobSql({
          id: interrupted,
          debounceKey: 'rfc319:interrupted',
          sourceKind: 'feedback',
          sourceEventId: fixtureId('FBRUN'),
          taskId: fixtureId('TASKRUN'),
          status: 'running',
          attempts: 2,
          // 远期 next_run_at：回收只改 status/startedAt，不动它。这样回收之后
          // 那条会稳稳停在 pending 上供断言，而不是马上被下一 tick 抢走。
          nextRunAt: far,
          createdAt: now - 120_000,
          startedAt: now - 5_000,
          lastError: 'gateway timeout on attempt 2',
          exitCode: 9,
        }),
        // 负向对照 A：本来就在 pending 的行，回收不该碰它（包括 attempts）。
        insertJobSql({
          id: untouchedPending,
          debounceKey: 'rfc319:keep-pending',
          sourceKind: 'feedback',
          sourceEventId: fixtureId('FBKEEP'),
          taskId: null,
          status: 'pending',
          attempts: 1,
          nextRunAt: far,
          createdAt: now - 110_000,
          lastError: 'transient failure on attempt 1',
        }),
        // 负向对照 B：已经结束的行，回收绝不能把它复活。
        insertJobSql({
          id: untouchedDone,
          debounceKey: 'rfc319:keep-done',
          sourceKind: 'feedback',
          sourceEventId: fixtureId('FBDNE'),
          taskId: null,
          status: 'done',
          attempts: 3,
          nextRunAt: now - 100_000,
          createdAt: now - 100_000,
          finishedAt: now - 90_000,
          exitCode: 0,
        }),
      ].join('\n'),
    )

    // 崩溃前：界面上它就是 Running。少了这一句，下面的 "Pending" 可能从一开始就是 Pending。
    await seedAuth(page, daemonA)
    await openDistillList(page, daemonA)
    await expect(
      page.getByTestId(`distill-job-row-${interrupted}`).locator('td').nth(1),
    ).toHaveText('Running', { timeout: 20_000 })

    // 硬杀。SIGKILL 而不是优雅停机：优雅路径上 loop.stop() 自己也会跑一次
    // recoverRunning，那样测到的是「停机时顺手收拾」，不是「重启后回收」。
    await daemonA.killChild('SIGKILL')

    daemonB = await startDaemon({ home, stubMode: 'basic' })

    // ① 中断的那条被重排回 pending —— 否则它永远停在 running，
    //    而 tick 的 SELECT 只认 pending，等于这条任务被静默丢弃。
    await expect
      .poll(async () => (await jobFromList(interrupted, daemonB!)).status, { timeout: 30_000 })
      .toBe('pending')
    const recovered = await jobFromList(interrupted, daemonB)
    expect(
      recovered.attempts,
      'attempts 被顺手清零 ⇒ 一条本该在第三次失败后躺平的 job 拿到了无限重试预算，每次重启都真的多花一次模型调用',
    ).toBe(2)
    expect(
      recovered.startedAt,
      '回收没清掉 startedAt ⇒ 下一轮的耗时统计会从上一次崩溃前算起',
    ).toBeNull()
    expect(recovered.lastError, '回收顺手清掉了 lastError ⇒ 崩溃前那次失败的线索没了').toBe(
      'gateway timeout on attempt 2',
    )

    // ② 两条负向对照：回收只应该动 running 的行。
    const keptPending = await jobFromList(untouchedPending, daemonB)
    expect(keptPending.status).toBe('pending')
    expect(
      keptPending.attempts,
      '回收把本来就在排队的行的 attempts 也动了 ⇒ 重试预算被重启次数稀释',
    ).toBe(1)
    const keptDone = await jobFromList(untouchedDone, daemonB)
    expect(
      keptDone.status,
      '回收把已完成的行拉回了队列 ⇒ 每次重启都会重跑一遍历史，重复候选灌进审批队列',
    ).toBe('done')

    // ③ 用户面：重启后管理员在表上看到的是 Pending + 尝试次数 2。
    await seedAuth(page, daemonB)
    await openDistillList(page, daemonB)
    const cells = page.getByTestId(`distill-job-row-${interrupted}`).locator('td')
    await expect(cells.nth(1)).toHaveText('Pending', { timeout: 20_000 })
    await expect(
      cells.nth(3),
      '界面上尝试次数回到 0 ⇒ 管理员会以为这条还没跑过，实际它已经烧掉两次预算',
    ).toHaveText('2')
  } finally {
    if (daemonB !== undefined) await daemonB.stop()
    // daemonA 已被 SIGKILL；两个 handle 共用这个 home，daemonB 是外部传入的
    // home（keepHome=true）不会删，这里显式收掉。
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

// ---------------------------------------------------------------------------
// 覆盖边界（如实记，免得后人误以为这里已经锁住）
// ---------------------------------------------------------------------------
//
// * **`?focus=` 目前是空载的**。`routes/memory.tsx:54-61` 只负责把它透传，
//   仓内没有任何组件消费 `search.focus`（`components/memory/**` 全域无
//   `search.focus` 读点），所以「Open in Approval Queue」实际落在 **All Approved**
//   分区（`search={{ focus }}` 整体替换了 search，tab 因而回落到默认值），
//   也不会滚动 / 高亮那条候选。本用例因此只锁「链接带对了 memoryId、点开不白屏、
//   参数不被 validateSearch 吃掉」——把它写成「落在审批队列并高亮」会当场红，
//   那是产品缺口不是测试缺口。
// * **重试后的那一瞬 `pending`** 没有被断言。retryFailedJob 把 next_run_at 设成
//   now，1Hz 的 worker 会在一秒内认领走；断某一瞬间的状态是在赌 tick 时机。
//   状态流转改由 WS 的 queued → started → done 序列锁定，那条序列不受轮询时机影响。
// * **蒸馏候选不是模型真吐出来的**。e2e 的 stub runtime（`packages/system-mocks/`）
//   没有任何模式会发 `<port name="candidates">`，所以 `memories.distill_job_id`
//   这条关联由夹具直连落库。真正锁「模型输出 → 候选行」的是后端单测
//   （`packages/backend/tests/memory-distiller*.test.ts` 一族）。这里锁的是
//   **候选段的渲染与深链**，不是 distiller 的解析。
// * **stderr 的 4000 字符截断**（`lib/distill-job-detail.ts:65-71` 的
//   `stderrClipped`）没有覆盖：夹具 stderr 只有三行。后端本来就把它裁到 2KB，
//   要触发前端这道防线得先绕过后端的裁剪，成本高于收益。
// * **429 / 409 等操作失败路径**（对着已经不是 failed 的行点 Retry）没有覆盖：
//   界面按状态隐藏按钮，用户面根本点不到；那条分支的守卫在
//   `packages/backend/tests/` 的路由单测里。
