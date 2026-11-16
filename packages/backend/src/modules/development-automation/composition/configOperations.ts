// RFC-497 (RFC-294 S10 step 4): the development configuration use case lives in application/configOperationHandlers.ts.
// Composition only binds persistence and gives the default clock; the ACL participant type is forwarded for bootstrap.
// RFC-344/RFC-349 — provider-neutral development configuration composition.

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createDevelopmentConfigOperations,
  type DevelopmentConfigOperationsInput,
  type DevelopmentConfigResourceAccess,
} from '../application/configOperationHandlers'
import {
  createActionTemplatePersistence,
  createVerificationProfilePersistence,
} from '../infrastructure/configResourceStore'
import { createDevelopmentConfigPersistence } from '../infrastructure/developmentConfigPersistence'
import type {
  DevelopmentConfigOperations,
  DevelopmentConfigResourceOperations,
} from '../public/operations'

/** Resource Catalog binds this closed participant at bootstrap. */
export type { DevelopmentConfigResourceAccess }

export interface DevelopmentConfigCompositionDependencies extends Omit<
  DevelopmentConfigOperationsInput,
  'now'
> {
  readonly now?: () => number
}

export function composeDevelopmentConfigOperationsFromPersistence(
  deps: DevelopmentConfigCompositionDependencies,
): DevelopmentConfigOperations {
  return createDevelopmentConfigOperations({ ...deps, now: deps.now ?? Date.now })
}

/** 两个 provider 共用的装配入口：persistence 全部走 provider-中立实现，ACL 参与者由 Resource Catalog 交来。 */
export function composeDevelopmentConfigOperationsFor(input: {
  readonly db: PersistenceDb
  readonly developmentAdapter: DevelopmentConfigResourceOperations
  readonly access: DevelopmentConfigResourceAccess
  readonly now?: () => number
}): DevelopmentConfigOperations {
  return composeDevelopmentConfigOperationsFromPersistence({
    actionTemplates: createActionTemplatePersistence(input.db),
    verificationProfiles: createVerificationProfilePersistence(input.db),
    persistence: createDevelopmentConfigPersistence(input.db),
    developmentAdapter: input.developmentAdapter,
    access: input.access,
    ...(input.now === undefined ? {} : { now: input.now }),
  })
}

/** 位置参数形态的装配入口（server / cli bootstrap 沿用），语义同 composeDevelopmentConfigOperationsFor。 */
export function composeDevelopmentConfigOperations(
  db: PersistenceDb,
  developmentAdapter: DevelopmentConfigResourceOperations,
  access: DevelopmentConfigResourceAccess,
): DevelopmentConfigOperations {
  return composeDevelopmentConfigOperationsFor({ db, developmentAdapter, access })
}
