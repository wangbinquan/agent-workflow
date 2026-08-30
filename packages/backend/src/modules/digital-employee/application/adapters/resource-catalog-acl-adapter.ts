import type {
  DigitalEmployeeAclIdentityMutation,
  DigitalEmployeeAclIdentityPersistence,
  DigitalEmployeeAuthoringStore,
} from '../ports/authoringStore'

export interface DigitalEmployeeResourceAclIdentityProvider {
  readonly type: 'employee_definition' | 'employee_tool' | 'employee_job_template'
  getRevision(resourceId: string): number
  withMutation<T>(
    resourceId: string,
    run: (mutation: DigitalEmployeeAclIdentityMutation) => T,
  ): T | undefined
}

function adapt(
  type: DigitalEmployeeResourceAclIdentityProvider['type'],
  persistence: DigitalEmployeeAclIdentityPersistence,
): DigitalEmployeeResourceAclIdentityProvider {
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
