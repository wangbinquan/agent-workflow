import { expect } from 'bun:test'
import { composeDigitalEmployeeWriterCutoverFor } from '@/modules/digital-employee/composition'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
export async function assertFixedWriterInstallation(db: PersistenceDb, updatedAt = 1000) {
  const writer = composeDigitalEmployeeWriterCutoverFor(db, { activeGeneration: 3, updatedAt })
  expect(Object.keys(writer).sort()).toEqual(['analyze', 'read'])
  expect(await writer.read()).toEqual({
    activeGeneration: 3,
    updatedAt,
    mode: 'os-active',
    legacyAdmissionsEnabled: false,
    legacyOpenMissionCount: 0,
  })
  const report = await writer.analyze()
  expect(report).toEqual({
    schemaVersion: 1,
    writer: await writer.read(),
    mechanicallyAdoptable: [],
    drainingTotal: 0,
    drainingTruncated: false,
    draining: [],
    blockedReason: null,
  })
  return { report }
}
