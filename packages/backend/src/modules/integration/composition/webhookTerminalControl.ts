// RFC-303 composition seam. Transitional routes/services may request this
// command, while application/domain stay free of concrete SQLite imports.
import type { ProviderNeutralDatabase } from '@/db/query'
import { MrLaunchGuardCoordinator } from '@/modules/integration/application/mrLaunchGuard'
import { MrTerminalControlWorker } from '@/modules/integration/application/mrTerminalControlWorker'
import type { MrTerminalControl } from '@/modules/integration/public/mrTerminalControl'
import type {
  MrLaunchGuardPersistencePort,
  MrTerminalEffectPersistencePort,
} from '../application/ports/mrTerminalControlPersistence'
import {
  createMrLaunchGuardPersistence,
  createMrTerminalEffectPersistence,
} from '../infrastructure/mrTerminalControlPersistence'
import type { TaskSourceTerminationParticipant } from '@/modules/task-execution/public/participants'
import type { mintSourceTerminationEffectCapability } from '@/modules/task-execution/application/sourceTerminationCapability'
import { InMemoryWebhookLaunchSupervisor } from '../infrastructure/inMemoryWebhookLaunchSupervisor'

export interface MrTerminalControlPersistence {
  readonly launchGuards: MrLaunchGuardPersistencePort
  readonly terminalEffects: MrTerminalEffectPersistencePort
}

export interface MrTerminalControlTaskTermination {
  readonly participant: TaskSourceTerminationParticipant
  readonly mintCapability: typeof mintSourceTerminationEffectCapability
}

/** Provider-neutral bootstrap seam; no database client escapes this boundary. */
export function composeMrTerminalControlWithPorts(input: {
  readonly persistence: MrTerminalControlPersistence
  readonly taskTermination: MrTerminalControlTaskTermination
}): MrTerminalControl {
  const launchGuards = new MrLaunchGuardCoordinator(
    input.persistence.launchGuards,
    new InMemoryWebhookLaunchSupervisor(),
  )
  const worker = new MrTerminalControlWorker(
    input.persistence.terminalEffects,
    launchGuards,
    input.taskTermination.participant,
    input.taskTermination.mintCapability,
  )
  return {
    reserveLaunch: (input) => launchGuards.reserve(input),
    wake: (effectId) => worker.wake(effectId),
    reconcileOnBoot: () => worker.reconcileOnBoot(),
    stop: () => worker.stop(),
    resume: () => worker.resume(),
  }
}

/**
 * RFC-359 AC-1（plan §5fy）—— **两个 provider 唯一的一份**。
 *
 * 合一前这里是一对孪生，两份函数体逐行对应，差别只有一处：
 * **谁来提供 `taskTermination`**——SQLite 那份自己在体内 `composeTaskSourceTermination(db)`，
 * PostgreSQL 那份要求调用方注入。持久化那两个端口本来就是中立的（都只吃 `db`）。
 *
 * 「自己造」与「让人注入」不是引擎差异，是**装配责任放在了不同的地方**；按 §5fq 三条判据
 * 一条都不命中。处方是 AC-10 用过的那条「**装配者提供答案**」：两边都由调用方注入，
 * 这一层就只剩一份——而且**不必等下面的 `sourceTermination` 孪生先合**，
 * 因为这一层本来就只是把它转交给 worker。
 *
 * SQLite bootstrap 于是自己调一次 `composeTaskSourceTermination(db)` 再传进来，
 * 与 PostgreSQL bootstrap 现在是同一个姿势。
 */
export function composeMrTerminalControl(input: {
  readonly db: ProviderNeutralDatabase
  readonly taskTermination: MrTerminalControlTaskTermination
}): MrTerminalControl {
  return composeMrTerminalControlWithPorts({
    persistence: {
      launchGuards: createMrLaunchGuardPersistence(input.db),
      terminalEffects: createMrTerminalEffectPersistence(input.db),
    },
    taskTermination: input.taskTermination,
  })
}
