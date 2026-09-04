// Compatibility facade for historical SQLite callers. Production composition
// injects the artifact lifecycle explicitly through modules/intent/composition;
// this facade asks that same composition for the concrete SQLite lifecycle so
// old tests and service consumers keep working without putting a legacy
// dependency back in the engine — and without assembling a provider here.
import {
  applyIntentChangeset as applyIntentChangesetWithLifecycle,
  convergeIntentApplyJournal as convergeIntentApplyJournalWithLifecycle,
  type ApplyIntentDeps as ApplyIntentDepsWithLifecycle,
} from '@/modules/intent/infrastructure/sqliteIntentApplyOperations'
import { composeSqliteIntentApplyArtifactLifecycle } from '@/modules/intent/composition/apply'

export type {
  ApplyIntentFaults,
  IntentApplyReceipt,
  IntentApplyResourceBinding,
  IntentApplyResourceSession,
} from '@/modules/intent/infrastructure/sqliteIntentApplyOperations'
export {
  __intentApplyLockCountForTests,
  __withSessionApplyLockForTests,
} from '@/modules/intent/infrastructure/sqliteIntentApplyOperations'

export type ApplyIntentDeps = Omit<ApplyIntentDepsWithLifecycle, 'artifacts'>

export function applyIntentChangeset(
  dependencies: ApplyIntentDeps,
  input: Parameters<typeof applyIntentChangesetWithLifecycle>[1],
) {
  return applyIntentChangesetWithLifecycle(
    {
      ...dependencies,
      artifacts: composeSqliteIntentApplyArtifactLifecycle({
        db: dependencies.db,
        appHome: dependencies.appHome,
      }),
    },
    input,
  )
}

export function convergeIntentApplyJournal(
  db: ApplyIntentDeps['db'],
  appHome: string,
  log?: Parameters<typeof convergeIntentApplyJournalWithLifecycle>[2],
  options?: Parameters<typeof convergeIntentApplyJournalWithLifecycle>[3],
) {
  return convergeIntentApplyJournalWithLifecycle(
    db,
    composeSqliteIntentApplyArtifactLifecycle({
      db,
      appHome,
    }),
    log,
    options,
  )
}
