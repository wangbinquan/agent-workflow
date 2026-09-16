import type { SecretBox } from '@/auth/secretBox'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { WebhookDispatchDeps } from '@/services/webhook/webhookDispatch'
import type { WebhookTriggerServiceDeps } from '@/services/webhookTriggers'
import type { ScheduledTaskOperations } from '@/services/scheduledTasks'
import type { WebhookDispatchPersistencePort } from '../application/ports/webhookDispatchPersistence'
import { createWebhookDeliveryPersistence } from '../infrastructure/webhookDeliveryPersistence'
import { createWebhookDispatchPersistence } from '../infrastructure/webhookDispatchPersistence'
import { createWebhookTriggerAdministration } from '../infrastructure/webhookTriggerAdministration'
import { createWebhookLaunchAdmission } from '../infrastructure/webhookDispatchRuntime'
import { createWebhookRepositoryResolver } from '../infrastructure/webhookRepositoryResolver'

export type { WebhookTaskExecutionParticipant } from '../application/ports/webhookExecution'
// RFC-359 W4-B4：执行运行时只有一份；两个 bootstrap 仍经各自的具名绑定装配。
export {
  createWebhookDispatchExecutionRuntime,
  createWebhookDispatchOrchestrationRuntime,
  createWebhookDispatchExecutionRuntime as createSqliteWebhookExecutionRuntime,
  createWebhookDispatchOrchestrationRuntime as createSqliteWebhookOrchestrationRuntime,
  createWebhookDispatchExecutionRuntime as createPostgresqlWebhookExecutionRuntime,
  createWebhookDispatchOrchestrationRuntime as createPostgresqlWebhookOrchestrationRuntime,
} from '../infrastructure/webhookDispatchRuntime'

export function composeWebhookDispatchPersistence(
  persistence: WebhookDispatchPersistencePort,
): WebhookDispatchPersistencePort {
  return persistence
}

/**
 * RFC-359 AC-1（plan §5gb）—— 从 `db` 造出 dispatch 持久化端口的那一份，两个 provider 共用。
 * 旁边的 `composeWebhookDispatchPersistence` 是**恒等函数**（收端口、原样返回），
 * 两者本来就不是一对「provider 实现」，只是同一族的两层。
 */
export function composeWebhookDispatchPersistenceFor(
  db: ProviderNeutralDatabase,
): WebhookDispatchPersistencePort {
  return composeWebhookDispatchPersistence(createWebhookDispatchPersistence(db))
}

export function composeWebhookTriggerServiceDependencies(
  dependencies: WebhookTriggerServiceDeps,
): WebhookTriggerServiceDeps {
  return dependencies
}

/**
 * RFC-359 AC-1（plan §5gb）—— **两个 provider 唯一的一份**。
 *
 * 合一前一对孪生，两份的 `administration` / `dispatchPersistence` 用的是**同两个中立构造器**，
 * 差别只有一处：**谁提供 `validateSaveable`**——SQLite 那份自己
 * `composeWebhookTriggerValidation(scheduledTasks, configPath)`，PostgreSQL 那份要求注入。
 *
 * 与 §5fy 的 MR 终端控制是同一个形状：「自己造」与「让人注入」不是引擎差异，
 * 是**装配责任放在了不同的地方**。按「装配者提供答案」收成一份，
 * SQLite bootstrap 自己先造一次再传进来。
 */
export function composeWebhookTriggerServiceDependenciesFor(
  db: ProviderNeutralDatabase,
  validateSaveable: WebhookTriggerServiceDeps['validateSaveable'],
): WebhookTriggerServiceDeps {
  return composeWebhookTriggerServiceDependencies({
    administration: createWebhookTriggerAdministration(db),
    dispatchPersistence: createWebhookDispatchPersistence(db),
    validateSaveable,
  })
}

// RFC-359 AC-6：形参放宽到中立客户端——它转交的四件（dispatch/delivery 持久化、仓库解析、
// 启动准入）形参都已中立，其中仓库解析这一对本轮刚合一（见 `webhookRepositoryResolver.ts`）。
//
// RFC-359 AC-1（plan §5gs）：连带把 `composeSqlite` 前缀也去掉了。上面那句注释说的是**形参**放宽，
// 而名字一直没跟上——它**没有 PostgreSQL 孪生**，从来就是这件事的唯一实现，前缀纯属历史。
// 这正是 `proposal.md` AC-1 第三款点名的「命名债」：provider 命名、却根本没有孪生实现，处方是改名。
// 留着的实际代价不是不好看：全仓有好几处判据按 `composeSqlite*` 这个形状找「provider 专属实现」，
// 一个没有孪生的中立函数顶着这个前缀，会让那些判据把它数成「还有一份 SQLite 专属实现」。
export function composeWebhookDispatchCore(
  db: ProviderNeutralDatabase,
  secretBox: SecretBox,
  scheduledTasks: ScheduledTaskOperations,
): Pick<
  WebhookDispatchDeps,
  'persistence' | 'deliveryPersistence' | 'resolveRepo' | 'admitLaunch'
> {
  return {
    persistence: createWebhookDispatchPersistence(db),
    deliveryPersistence: createWebhookDeliveryPersistence(db),
    resolveRepo: createWebhookRepositoryResolver(db, secretBox),
    admitLaunch: createWebhookLaunchAdmission(scheduledTasks),
  }
}
