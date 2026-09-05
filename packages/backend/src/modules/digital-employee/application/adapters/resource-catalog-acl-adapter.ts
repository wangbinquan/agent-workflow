import type {
  DigitalEmployeeAclIdentityPersistence,
  DigitalEmployeeAuthoringAdapter,
} from '../ports/authoringStore'

/** digital-employee 交给 resource-catalog 的 employee_* identity 面（两个 provider 同一份，RFC-359 W4-D6c）。 */
export type DigitalEmployeeResourceAclIdentityProvider = DigitalEmployeeAclIdentityPersistence

export function createDigitalEmployeeResourceCatalogAclAdapters(
  store: Pick<DigitalEmployeeAuthoringAdapter, 'resourceAclIdentities'>,
) {
  return Object.freeze({
    employeeDefinition: store.resourceAclIdentities.employeeDefinition,
    employeeTool: store.resourceAclIdentities.employeeTool,
    employeeJobTemplate: store.resourceAclIdentities.employeeJobTemplate,
  })
}
