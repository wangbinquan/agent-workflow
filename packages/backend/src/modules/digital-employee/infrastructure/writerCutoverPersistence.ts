import type {
  DigitalEmployeeWriterCutoverPersistence,
  DigitalEmployeeWriterInstallation,
  DigitalEmployeeWriterState,
} from '../application/ports/writerCutoverPersistence'

export function createDigitalEmployeeWriterCutoverPersistence(
  installation?: DigitalEmployeeWriterInstallation,
): DigitalEmployeeWriterCutoverPersistence {
  const facts = installation === undefined ? undefined : Object.freeze({ ...installation })
  return {
    async read(): Promise<DigitalEmployeeWriterState> {
      if (facts === undefined) throw new Error('digital-employee-writer-installation-unbound')
      if (
        !Number.isSafeInteger(facts.activeGeneration) ||
        facts.activeGeneration < 1 ||
        !Number.isSafeInteger(facts.updatedAt) ||
        facts.updatedAt < 0
      )
        throw new Error('digital-employee-writer-installation-invalid')
      return {
        ...facts,
        mode: 'os-active',
        legacyAdmissionsEnabled: false,
        legacyOpenMissionCount: 0,
      }
    },
  }
}
