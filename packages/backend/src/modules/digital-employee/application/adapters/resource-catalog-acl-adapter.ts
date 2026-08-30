import type { ResourceAclIdentityPersistence } from '@/modules/resource-catalog/public/operations'
import type {
  DigitalEmployeeAclIdentityPersistence,
  DigitalEmployeeAuthoringStore,
} from '../ports/authoringStore'

function adapt(
  type: ResourceAclIdentityPersistence['type'],
  persistence: DigitalEmployeeAclIdentityPersistence,
): ResourceAclIdentityPersistence {
  return {
    type,
    getRevision: (resourceId) => persistence.getRevision(resourceId),
    withMutation: (resourceId, run) =>
      persistence.withMutation(resourceId, (mutation) =>
        run({
          current: mutation.current,
          ownerNameIsUnique: mutation.ownerNameIsUnique,
          hasOwnerNameCollision: (nextOwnerUserId) =>
            mutation.hasOwnerNameCollision(nextOwnerUserId),
          update: (input) => mutation.update(input),
        }),
      ),
  }
}

export function createDigitalEmployeeResourceCatalogAclAdapters(
  store: Pick<DigitalEmployeeAuthoringStore, 'resourceAclIdentities'>,
) {
  return Object.freeze({
    employeeDefinition: adapt(
      'employee_definition',
      store.resourceAclIdentities.employeeDefinition,
    ),
    employeeTool: adapt('employee_tool', store.resourceAclIdentities.employeeTool),
    employeeJobTemplate: adapt(
      'employee_job_template',
      store.resourceAclIdentities.employeeJobTemplate,
    ),
  })
}
