// RFC-395 II-a A6 — 旧旅程测试依次调用生产 turn 恢复与 journal 机制；这里不构造 worker graph。
// RFC-523: the compositions now take the scratch store and the artifact lifecycle from their caller; this helper keeps the old
// test-facing input and states the same standalone selections they used to pick when none was given.
import { join } from 'node:path'
import { createAtomicApplyRecovery } from '@/platform/atomic-apply/convergence'
import type { AtomicApplyRecoveryScene } from '@/platform/contracts/atomicApply'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { Logger } from '@/util/log'
import {
  composeIntentMaintenanceCommandsForDatabase as composeIntentMaintenance,
  composeLocalIntentScratch,
} from '@/modules/intent/composition/maintenance'
import { composeIntentApplyRecoveryScene } from '@/modules/intent/composition/applyMaintenance'
import {
  composeIntentApplyArtifactLifecycle,
  composeLocalIntentArtifactContent,
} from '@/modules/intent/composition/apply'
import type { IntentArtifactContentPort } from '@/modules/intent/application/ports/intentArtifactContent'
import type { IntentScratchStore } from '@/modules/intent/application/ports/intentScratchStore'
import type { IntentApplyArtifactLifecycle } from '@/modules/intent/infrastructure/intentApplyEngine'
import { composeLegacyIntentSkillArtifactCompat } from '@/modules/resource-catalog/composition/intentApply'

type Input = {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly pluginsDir?: string
  readonly scratchDirectoryName?: string
  readonly scratch?: IntentScratchStore
  readonly content?: IntentArtifactContentPort
  readonly artifacts?: IntentApplyArtifactLifecycle
  readonly now?: () => number
  readonly log?: Logger
  readonly resourcePackages?: AtomicApplyRecoveryScene<'resource-package'>
}
export function composeIntentMaintenanceCommandsForDatabase(input: Input) {
  const pluginsDir = input.pluginsDir ?? join(input.appHome, 'plugins')
  const intent = composeIntentMaintenance({
    db: input.db,
    scratch:
      input.scratch ??
      composeLocalIntentScratch({
        appHome: input.appHome,
        ...(input.scratchDirectoryName === undefined
          ? {}
          : { directoryName: input.scratchDirectoryName }),
      }),
    ...(input.log === undefined ? {} : { log: input.log }),
  })
  const applies = createAtomicApplyRecovery(
    [
      composeIntentApplyRecoveryScene({
        db: input.db,
        artifacts:
          input.artifacts ??
          composeIntentApplyArtifactLifecycle({
            db: input.db,
            appHome: input.appHome,
            pluginsDir,
            content:
              input.content ??
              composeLocalIntentArtifactContent({ appHome: input.appHome, pluginsDir }),
            legacySkillArtifacts: composeLegacyIntentSkillArtifactCompat(),
          }),
        ...(input.now === undefined ? {} : { now: input.now }),
        ...(input.log === undefined ? {} : { log: input.log }),
      }),
      ...(input.resourcePackages === undefined ? [] : [input.resourcePackages]),
    ],
    input.now,
  )
  return {
    scratch: intent.scratch,
    recovery: {
      bootTurnIds: intent.recovery.bootTurnIds,
      async recover(command: {
        readonly recoverTurnIds: readonly string[]
        readonly activeIntentApplyJournalIds: readonly string[]
        readonly activeBundleApplyIds: readonly string[]
        readonly now?: number
      }) {
        const turns = await intent.recovery.recover({
          recoverTurnIds: command.recoverTurnIds,
          ...(command.now === undefined ? {} : { now: command.now }),
        })
        const journals = await applies.converge({
          intent: command.activeIntentApplyJournalIds,
          ...(input.resourcePackages === undefined
            ? {}
            : { 'resource-package': command.activeBundleApplyIds }),
        } as Parameters<typeof applies.converge>[0])
        return { ...turns, ...journals }
      },
    },
  }
}
