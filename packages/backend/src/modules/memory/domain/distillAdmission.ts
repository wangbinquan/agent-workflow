// RFC-366 —— 「这个事件该不该进蒸馏队列」的**唯一**判据。纯函数、零 IO、零 Drizzle。
//
// 在此之前这个问题没有答案：四个调用点（两处 cli/start.ts 内联 consumer、clarify
// 的 autoDispatch、feedback 的 service）各自无条件入队，于是一个每小时跑一次的定时
// 任务，只要中途有人审一次就烧一次蒸馏。把判据收进一个纯函数、执行点收进
// `enqueueDistillJob` 一处，是本 RFC 承担的结构演进：新增的两类源不再多一个散点。
//
// 判定顺序本身是契约（由 rfc366-distill-admission.test.ts 钉死）——它决定审计日志
// 里记的是哪个 reason，而 reason 是管理员排查「为什么没提炼」的唯一线索。

import type { DistillPolicy, DistillSourceKind, TaskLaunchOrigin } from '@agent-workflow/shared'

export type DistillRejectReason =
  /** `config.memoryDistillSources[kind]` 为 false。 */
  | 'source-disabled'
  /** 任务来源不在 `config.memoryDistillLaunchOrigins` 白名单里。 */
  | 'launch-origin-not-allowed'
  /** 平台内部执行（数字员工 / 动作执行 / 融合），无配置可放行。 */
  | 'internal-task'

/**
 * 准入需要的三列，全部取自 `tasks`，全部**不可变且由子任务继承**：
 * - `launchOrigin`（RFC-301）—— 根任务派生一次，子任务逐字复制父值，所以一个
 *   定时任务拉起的子任务照样被当作 `scheduled` 判定；
 * - `catalogVisibility` —— 数字员工 / 动作执行写 'internal'，同样被子任务继承；
 * - `spaceKind` —— 融合等内部启动走 `internalSource`，落 'internal'。
 *
 * 两条 internal 判据都要看：它们由不同的启动路径写，漏掉任何一条都会让那类内部
 * 执行的会话流进人审队列（而用户在任务列表里根本看不到那些任务，无从核对）。
 */
export interface DistillTaskFacts {
  readonly launchOrigin: TaskLaunchOrigin
  readonly catalogVisibility: 'public' | 'internal'
  readonly spaceKind: 'local' | 'remote' | 'scratch' | 'internal' | 'inherited'
}

export type DistillAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: DistillRejectReason }

const ADMITTED: DistillAdmission = Object.freeze({ admitted: true })

export function distillAdmission(input: {
  readonly sourceKind: DistillSourceKind
  readonly task: DistillTaskFacts | null
  readonly policy: Pick<DistillPolicy, 'launchOrigins' | 'sources'>
}): DistillAdmission {
  // ① 源开关先判：它是管理员最直接的意图表达（「我就是不要 agent 过程沉淀」），
  //    理应盖过任务来源这条更间接的轴，审计里也该记成 source-disabled。
  if (input.policy.sources[input.sourceKind] === false) {
    return { admitted: false, reason: 'source-disabled' }
  }
  // ② 无任务的事件没有任务来源轴可判。今天没有生产调用方走这条（五类源都带
  //    taskId），保留它是因为 `memory_distill_jobs.task_id` 可空——把 schema 允许
  //    的形态变成一条隐式拒绝，是下一个人排查不出来的那种坑。
  if (input.task === null) return ADMITTED
  // ③ 内部执行硬拒，且**先于**白名单：内部任务对用户不可见，给它一个开关等于给
  //    一个无法验证结果的旋钮（RFC-366 proposal §6 C7，用户 2026-09-21 确认）。
  if (input.task.catalogVisibility === 'internal' || input.task.spaceKind === 'internal') {
    return { admitted: false, reason: 'internal-task' }
  }
  // ④ 任务来源白名单。默认只有 'manual'。
  if (!input.policy.launchOrigins.includes(input.task.launchOrigin)) {
    return { admitted: false, reason: 'launch-origin-not-allowed' }
  }
  return ADMITTED
}
