// RFC-522 — the three selections `composeDigitalEmployee` used to build when a caller gave none, from the same factories with the
// same arguments: the input artifact store under `<appHome>/artifacts/employee-inputs`, the program artifact store under the app
// home and the writer cutover over the database without an installation port.
import { join } from 'node:path'
import {
  composeDigitalEmployeeWriterCutoverFor,
  createEmployeeInputArtifactStore,
  createProgramArtifactStore,
} from '../../src/modules/digital-employee/composition'
import type { PersistenceDb } from '../../src/platform/persistence/persistenceDb'

export function standaloneDigitalEmployeeSelections(input: {
  readonly db: PersistenceDb
  readonly appHome: string
}) {
  return {
    inputArtifacts: createEmployeeInputArtifactStore(
      join(input.appHome, 'artifacts', 'employee-inputs'),
    ),
    programArtifacts: createProgramArtifactStore(input.appHome),
    writerCutover: composeDigitalEmployeeWriterCutoverFor(input.db),
  }
}
