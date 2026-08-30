import type { AclResourceType } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { createDigitalEmployeeResourceCatalogAclProviders } from '@/modules/digital-employee/public/commands'
import { createDevelopmentAdapterResourceCatalogAclProvider } from '@/modules/integration/public/participants'
import type {
  ForeignResourceAclType,
  ResourceAclIdentityPersistence,
} from '@/modules/resource-catalog/public/operations'

const providersByDb = new WeakMap<
  object,
  ReadonlyMap<ForeignResourceAclType, ResourceAclIdentityPersistence>
>()

function providersFor(db: DbClient) {
  const key = db as object
  const existing = providersByDb.get(key)
  if (existing !== undefined) return existing

  const digitalEmployee = createDigitalEmployeeResourceCatalogAclProviders(db)
  const providers = new Map<ForeignResourceAclType, ResourceAclIdentityPersistence>([
    ['development_adapter', createDevelopmentAdapterResourceCatalogAclProvider(db)],
    ['employee_definition', digitalEmployee.employeeDefinition],
    ['employee_tool', digitalEmployee.employeeTool],
    ['employee_job_template', digitalEmployee.employeeJobTemplate],
  ])
  providersByDb.set(key, providers)
  return providers
}

export function resolveLegacyResourceAclIdentityPersistence(
  db: DbClient,
  type: AclResourceType,
): ResourceAclIdentityPersistence | undefined {
  switch (type) {
    case 'development_adapter':
    case 'employee_definition':
    case 'employee_tool':
    case 'employee_job_template':
      return providersFor(db).get(type)
    default:
      return undefined
  }
}
