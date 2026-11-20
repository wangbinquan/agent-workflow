// RFC-517 — the Employee definition view (RFC-294 S10): the current revision, its work scope and the job revision must
// all exist; each exact adapter binding records whether the employee overrides it or inherits the job default.
import type { DigitalEmployeeAuthoringService } from './authoringService'
import type { DigitalEmployeeAuthoringPersistence } from './ports/authoringStore'
import type { EmployeeDefinitionView } from './ports/digitalEmployeeModule'

export function createEmployeeDefinitionViewProjection(store: DigitalEmployeeAuthoringPersistence) {
  return async (
    record: Awaited<ReturnType<DigitalEmployeeAuthoringService['getEmployeeDefinition']>>,
  ): Promise<EmployeeDefinitionView> => {
    if (record.currentRevision === null) {
      throw new Error(`employee has no current revision: ${record.id}`)
    }
    const revision = await store.getEmployeeDefinitionRevision({
      id: record.id,
      revision: record.currentRevision,
    })
    if (revision === null) throw new Error(`employee revision is missing: ${record.id}`)
    const workScope = await store.getWorkScopeRevision(revision.content.workScopeRef)
    if (workScope === null) throw new Error(`employee work scope is missing: ${record.id}`)
    const jobRevision = await store.getJobTemplateRevision(record.configuration.jobTemplateRef)
    if (jobRevision === null) throw new Error(`employee job revision is missing: ${record.id}`)
    const overrideKeys = new Set(
      record.configuration.adapterOverrides.map(
        (binding) => `${binding.laneId}\u0000${binding.slotRef}`,
      ),
    )
    return {
      id: record.id,
      name: record.name,
      typeRef: record.typeRef,
      configuration: record.configuration,
      revision: record.currentRevision,
      definition: revision.content,
      inheritedAdapterBindings: jobRevision.content.defaultAdapterBindings,
      adapterBindingSources: revision.content.exactAdapterBindings.map((binding) => ({
        ...binding,
        source: overrideKeys.has(`${binding.laneId}\u0000${binding.slotRef}`)
          ? 'employee-override'
          : 'job-default',
      })),
      workScope: workScope.encodedScope,
      ownerUserId: record.ownerUserId,
      visibility: record.visibility,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }
}
