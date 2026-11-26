// RFC-496 (RFC-294 S10 step 3): the workspace use case lives in application/employeeWorkspace.ts. Composition only checks the
// workspace-effects selection, gives the default clock and binds persistence. RFC-599: the caller states the selection (the
// daemon gives the deployment's; tests give the local implementation), so the local fallback is never reached here.

import type { AutomationWorkspaceEffectsFactory } from '../application/ports/automationWorkspaceEffects'
import {
  createDevelopmentEmployeeWorkspace,
  createEmployeeCaseWorkspaceDetailReader,
  type DevelopmentEmployeeCaseWorkspaceDetailReader,
  type DevelopmentEmployeeWorkspaceInput,
  type DevelopmentEmployeeWorkspaceParticipant,
} from '../application/employeeWorkspace'
import { selectedAutomationWorkspaceEffects } from '../infrastructure/automationWorkspaceEffects'
import { createEmployeeWorkspacePersistence } from '../infrastructure/employeeWorkspacePersistence'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

/** 一份读侧，两个 provider 共用（RFC-359 W4-D13）。 */
export function createDevelopmentEmployeeCaseWorkspaceDetailReader(
  db: PersistenceDb,
): DevelopmentEmployeeCaseWorkspaceDetailReader {
  return createEmployeeCaseWorkspaceDetailReader(createEmployeeWorkspacePersistence(db))
}

export interface DevelopmentEmployeeWorkspaceCompositionInput extends Omit<
  DevelopmentEmployeeWorkspaceInput,
  'automationWorkspaceEffects' | 'now' | 'graphDelivery'
> {
  readonly automationWorkspaceEffects: AutomationWorkspaceEffectsFactory
  /**
   * RFC-601: required here (the daemon gives the graph delivery care); the use case keeps its own optional member and its
   * fallback for an input that lacks it.
   */
  readonly graphDelivery: NonNullable<DevelopmentEmployeeWorkspaceInput['graphDelivery']>
  readonly now?: () => number
}

function composeDevelopmentEmployeeWorkspaceFromPersistence(
  input: DevelopmentEmployeeWorkspaceCompositionInput,
): DevelopmentEmployeeWorkspaceParticipant {
  return createDevelopmentEmployeeWorkspace({
    ...input,
    automationWorkspaceEffects: selectedAutomationWorkspaceEffects(
      input.automationWorkspaceEffects,
    ),
    now: input.now ?? Date.now,
  })
}

type DevelopmentEmployeeWorkspaceBootstrapInput = Omit<
  DevelopmentEmployeeWorkspaceCompositionInput,
  'persistence'
>

/** 一份装配，两个 provider 共用（RFC-359 W4-D13）。 */
export function composeDevelopmentEmployeeWorkspace(
  input: DevelopmentEmployeeWorkspaceBootstrapInput & { readonly db: PersistenceDb },
): DevelopmentEmployeeWorkspaceParticipant {
  const { db, ...composition } = input
  return composeDevelopmentEmployeeWorkspaceFromPersistence({
    ...composition,
    persistence: createEmployeeWorkspacePersistence(db),
  })
}
