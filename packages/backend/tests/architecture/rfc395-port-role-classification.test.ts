import { expect, test } from 'bun:test'
import { sourceUnit } from './census'
import { BACKEND_PREFIX, capabilityForgeViolations } from './rfc294Gates'
import { buildTaskExecutionAuthorityEntries } from './rfc328TaskExecutionLedger'

test('reviewed transaction ports do not exempt same-name capabilities or forged identities', () => {
  const path = BACKEND_PREFIX + 'modules/task-execution/application/ports/runSelection.ts'
  const declaration =
    'export interface RunSelectionParticipantInTx<Tx> { apply(tx: Tx): Promise<void> }'
  const factory = sourceUnit(
    BACKEND_PREFIX + 'modules/task-execution/infrastructure/probe.ts',
    `
    import type { RunSelectionParticipantInTx } from '../application/ports/runSelection'
    export function createProbe(): RunSelectionParticipantInTx<object> {
      return { async apply(tx) {} }
    }
  `,
  )
  expect(capabilityForgeViolations([sourceUnit(path, declaration), factory])).toEqual([])
  expect(
    capabilityForgeViolations([
      sourceUnit(
        path,
        declaration.replace('apply(tx:', 'readonly brand: unique symbol; apply(tx:'),
      ),
      factory,
    ]).length,
  ).toBeGreaterThan(0)
  expect(
    capabilityForgeViolations([
      sourceUnit(path, declaration.replace('apply(tx: Tx)', 'apply()')),
      factory,
    ]).length,
  ).toBeGreaterThan(0)
  expect(
    capabilityForgeViolations([
      sourceUnit(path.replace('runSelection.ts', 'copied.ts'), declaration),
      factory,
    ]).length,
  ).toBeGreaterThan(0)
})

test('shared NodeRun writes inherit worker, control and recovery callers; unknown callers remain red', () => {
  const file = BACKEND_PREFIX + 'modules/task-execution/infrastructure/nodeRunWriteProtocol.ts'
  const protocol = sourceUnit(
    file,
    `
    function replaceInputs(tx) { tx.update(nodeRuns).set({inputsRecorded: true}) }
    export function compareAndWriteNodeRunInTx(tx) { tx.update(nodeRuns).set({status: 'done'}) }
  `,
  )
  const caller = (path: string) =>
    sourceUnit(
      BACKEND_PREFIX + path,
      `
    import { compareAndWriteNodeRunInTx as write } from './nodeRunWriteProtocol'
    export function mutate(tx) { write(tx) }
  `,
    )
  const known = [
    protocol,
    caller('modules/task-execution/infrastructure/nodeExecutionPersistence.ts'),
    caller('modules/task-execution/infrastructure/childTaskLifecycleParticipant.ts'),
    caller('modules/task-execution/infrastructure/crewstation/bootRecovery.ts'),
  ]
  const census = buildTaskExecutionAuthorityEntries(known)
  expect(census.unknown).toEqual([])
  expect(census.entries).toHaveLength(6)
  expect([...new Set(census.entries.map((entry) => entry.authorityKind))].sort()).toEqual([
    'control-revision',
    'recovery-proof',
    'worker-epoch',
  ])
  expect(census.entries.every((entry) => entry.consumer.includes('#mutate'))).toBe(true)
  expect(buildTaskExecutionAuthorityEntries([protocol]).unknown).toHaveLength(2)
  expect(
    buildTaskExecutionAuthorityEntries([
      ...known,
      caller('modules/task-execution/infrastructure/unreviewed.ts'),
    ]).unknown,
  ).toHaveLength(2)
  expect(
    buildTaskExecutionAuthorityEntries([
      ...known,
      sourceUnit(file, 'function uncheckedWriter(tx) { tx.update(nodeRuns).set({}) }'),
    ]).unknown,
  ).toHaveLength(1)
})
