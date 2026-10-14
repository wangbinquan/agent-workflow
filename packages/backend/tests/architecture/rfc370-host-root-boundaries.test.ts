// RFC-370 / CI 38483477606: actual host assembly selects Task adapters
// through composition. It must not grow direct imports of module internals.
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { backendUnits, BOOTSTRAP_FILES, inboundBoundaryEdges, sourceUnit } from './census'

const root = resolve(import.meta.dir, '../../../..')
// Parsing the whole backend corpus takes 2.5 s on Ubuntu and up to 6.2 s on the macOS
// runners (CI 38601555205 shard 9 timed out at the 5 s default), so it is read once
// at load time like rfc317-module-boundary's UNITS, outside any single test's budget.
const CORPUS = backendUnits(root)
const selected = [
  'packages/backend/src/cli/dev.ts',
  'packages/backend/src/cli/daemonHostExecutionBootstrap.ts',
  'packages/backend/src/cli/daemonHostExecutionOwners.ts',
  'packages/backend/src/cli/daemonHostExecutionRecovery.ts',
  'packages/backend/src/cli/embeddedHostExecutionApplication.ts',
]

test('all actual host roots assemble module composition without reaching into module internals', () => {
  expect(CORPUS.length).toBeGreaterThanOrEqual(2000)
  expect(selected).toHaveLength(5)
  const units = CORPUS.filter((unit) => selected.includes(unit.path))
  expect(units.map((unit) => unit.path).sort()).toEqual([...selected].sort())
  const registeredRoots = new Set<string>(BOOTSTRAP_FILES)
  for (const path of selected) expect(registeredRoots.has(path)).toBe(true)
  expect(inboundBoundaryEdges(units)).toEqual([])
})

test('the host adapter composition remains unavailable to ordinary business consumers', () => {
  const caller = sourceUnit(
    'packages/backend/src/services/ordinary-business-consumer.ts',
    "import { createTaskHostWriteContextAdapter } from '@/modules/task-execution/composition/hostExecutionAdmission'\n",
  )
  expect(inboundBoundaryEdges([caller])).toHaveLength(1)
})
