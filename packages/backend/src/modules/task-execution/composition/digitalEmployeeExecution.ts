import type { HumanGateOpenParticipantFactory } from '../application/ports/humanGateOpenFactory'
import type { HistoryRestrictionPort } from '@/platform/contracts/historyRestriction'
import type { Actor } from '@/auth/actor'
import {
  inspectDigitalEmployeeHumanReviewSnapshot,
  readDigitalEmployeeExecutionMetadata,
} from '../infrastructure/digitalEmployeeExecutionReads'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { projectExecutionOutcome } from '../infrastructure/executionOutcome'
import { getTask } from '@/services/task'
import { NotFoundError } from '@/util/errors'

import { composeReactionExecutionAdmissionParticipantInTx } from '../application/adapters/reaction-admission-adapter'
import { composeReactionExecutionPortV1 } from '../application/adapters/reaction-execution-adapter'
import { createDigitalEmployeeExecutionCore } from '../application/digitalEmployeeExecution'
import type { DigitalEmployeeExecutionCore } from '../application/ports/digitalEmployeeExecutionCore'
import type { DigitalEmployeeExecutionPorts } from '../application/ports/digitalEmployeeExecution'
import type { ProgramToolSource } from '../application/ports/scriptFixture'
import { readTaskResourceUsage } from '../application/taskResourceUsage'
import { createFileProgramToolSource } from '../infrastructure/local/fileProgramToolSource'
import { createReactionAdmissionStore } from '../infrastructure/reactionExecutionAdmissions'
import { createTaskExecutionReadModels } from '../infrastructure/taskExecutionReadModels'
import { createTaskResourceLimitFacts } from '../infrastructure/taskResourceLimitFacts'
import type { RootTaskLaunchKernel } from '../infrastructure/taskRouteLaunchOperations'
import { launchDigitalEmployeeHost } from '../infrastructure/hostTaskLaunch'
import { composeTaskCancellation } from './taskCancellation'

// RFC-415: the execution core and its pure helpers are task-execution application; these exports keep their callers.
export {
  buildDigitalEmployeeFixedPrompt,
  buildDigitalEmployeePlanPrompt,
  digitalEmployeeExecutionIsLive,
} from '../application/digitalEmployeeExecution'

/**
 * What the composition roots hand the digital employee execution: the core's read ports, plus the provider's root
 * launch kernel and the lazily resolved launch actor the binding turns into the core's `launchHost`.
 */
export interface DigitalEmployeeExecutionDependencies extends Omit<
  DigitalEmployeeExecutionPorts,
  'programs' | 'launchHost' | 'projectOutcome'
> {
  readonly appHome: string
  /** RFC-370 §10 V19: the selected program artifact store; standalone reads
   * the application home when omitted. */
  readonly programs?: ProgramToolSource
  /**
   * **惰性**取 actor：只有 `launch` 用得到它，而 SQLite 那个组合根
   * （`server.ts` 的 `composeSqliteApiRouteMounts`）是**同步**函数，
   * 取不到 `await admitDaemonIdentity(...)`。惰性是两个组合根都成立的那半
   * （同 `actionExecutionEnvironment.ts` 的 `resolveActor`，plan §5hi）。
   */
  readonly resolveActor: () => Promise<Actor>
  readonly resourceAuthorityFor: (
    actor: Actor,
  ) => Parameters<RootTaskLaunchKernel['launch']>[0]['resourceAuthority']
  readonly launch: RootTaskLaunchKernel
}

/** RFC-415 — the core's ports from the composition dependencies: reads pass through, the program source is selected. */
function digitalEmployeeExecutionPorts(
  deps: DigitalEmployeeExecutionDependencies,
): DigitalEmployeeExecutionPorts {
  const { appHome, programs, resolveActor, resourceAuthorityFor, launch, ...reads } = deps
  return {
    ...reads,
    programs: programs ?? createFileProgramToolSource(appHome),
    projectOutcome: projectExecutionOutcome,
    launchHost: (request) =>
      launchDigitalEmployeeHost({ resolveActor, resourceAuthorityFor, launch }, request),
  }
}

/** RFC-368 T7 —— typed 核心，供 `ReactionExecutionPortV1` 适配器经端口注入。 */
export function composeDigitalEmployeeExecutionCore(
  deps: DigitalEmployeeExecutionDependencies,
): DigitalEmployeeExecutionCore {
  return createDigitalEmployeeExecutionCore(digitalEmployeeExecutionPorts(deps))
}

type ReactionExecutionPortDependencies = Parameters<typeof composeReactionExecutionPortV1>[0]

/**
 * RFC-368 T17 —— 三个组合根装配数字员工 Reaction 执行时用的**唯一**入口。
 *
 * 数字员工的 runtime 需要两样东西，且都要来自 TaskExecution：
 *   · `admission(tx)`：绑定到**数字员工 claim 事务**的 admission 参与者（`InTx` 定式，
 *     数字员工 store 在自己的 `session.transaction` 里取用）；
 *   · `port(artifacts)`：执行 port。它要消费数字员工持有的反馈 reader 与诊断 sink，而那两样
 *     由数字员工的 composition 产出——所以交出一个工厂，由数字员工把自己的产物视图交进来，
 *     根上不必先后拼两次、也不形成装配环。
 */
export function composeReactionExecutionProvider(
  deps: DigitalEmployeeExecutionDependencies & {
    readonly db: PersistenceDb
    readonly now?: () => number
  },
) {
  const now = deps.now ?? Date.now
  const core = createDigitalEmployeeExecutionCore(digitalEmployeeExecutionPorts(deps))
  return Object.freeze({
    admission: (tx: PersistenceDb) =>
      composeReactionExecutionAdmissionParticipantInTx(createReactionAdmissionStore(tx), { now }),
    port: (artifacts: {
      readonly retryFeedback: ReactionExecutionPortDependencies['retryFeedback']
      readonly diagnosticsSink: ReactionExecutionPortDependencies['diagnostics']
    }) =>
      composeReactionExecutionPortV1({
        core,
        admissions: createReactionAdmissionStore(deps.db),
        retryFeedback: artifacts.retryFeedback,
        diagnostics: artifacts.diagnosticsSink,
        now,
      }),
  })
}

/**
 * RFC-359 AC-1（plan §5hl）—— 三个端口的**库内缺省实现**。
 *
 * 合一前 SQLite 那份 composer 在函数体里直接读库（`deps.db.select(...).get()`），
 * PostgreSQL 那份把同样三件事收成端口。合一取端口那半——它是两个引擎都成立的那种形状
 * （`.get()` 在 PG 上返回 Promise，在 SQLite 上返回值，直接读库的写法按定义只服务一个引擎）。
 * 但端口化不该让每个组合根各抄一遍同样的三段库读，所以缺省实现放在这里，
 * 装配方只在确有更好来源时（例如 PG daemon 的 `resourceLimitOperations`）覆盖它。
 */
export function composeDatabaseDigitalEmployeeExecutionPorts(
  db: PersistenceDb,
  historyRestrictions: HistoryRestrictionPort,
  humanGateOpen: HumanGateOpenParticipantFactory,
): Pick<
  DigitalEmployeeExecutionDependencies,
  'tasks' | 'readModels' | 'resourceUsage' | 'executionMetadata' | 'humanReview'
> {
  return Object.freeze({
    tasks: {
      get: (taskId: string) => getTask(db, taskId),
      async cancel(taskId: string) {
        await composeTaskCancellation(db, historyRestrictions, humanGateOpen).cancel(taskId)
        const task = await getTask(db, taskId)
        if (task === null) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
        return task
      },
    },
    readModels: createTaskExecutionReadModels(db),
    resourceUsage: {
      read: (taskId: string) => readTaskResourceUsage(createTaskResourceLimitFacts(db), taskId),
    },
    executionMetadata: {
      load: (taskId: string) => readDigitalEmployeeExecutionMetadata(db, taskId),
    },
    humanReview: {
      inspect: (executionRef: string) =>
        inspectDigitalEmployeeHumanReviewSnapshot(db, executionRef),
    },
  })
}
