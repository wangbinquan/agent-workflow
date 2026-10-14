// RFC-371: the producer lock repair is an append-only, exact clock transition;
// it must not rewrite any historical plan or accept unrelated function changes.
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { readExpectedMigrationChain } from '@/db/schemaAdmission'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import {
  postgresqlMigrationDigest,
  replayPostgresqlMigrationHistory,
  resolvePostgresqlIndexOnlyRowBridge,
  resolvePostgresqlAdditiveRowBridge,
} from '@/platform/persistence/postgresqlMigrationSequence'
import { buildPostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'
import {
  OBSERVATION_SOURCE_REVISION,
  OBSERVATION_SOURCE_REVISION_JOURNAL,
} from '@/platform/persistence/observationSourceRevisionSchema'

test('V5 replaces exactly the original 165 source clock functions and retains every other original statement', async () => {
  const history = await loadPostgresqlMigrationHistory(),
    at = history.steps.findIndex((step) => step.id === '0031_rfc371_committed_source_clocks'),
    step = history.steps[at]!,
    before = history.versions[at]!,
    after = history.versions[at + 1]!
  expect(at).toBeGreaterThanOrEqual(0)
  expect(step.version).toBe(5)
  expect(history.head.sqliteMigrations).toEqual(
    readExpectedMigrationChain(resolve(import.meta.dir, '..', 'db', 'migrations')),
  )
  expect(step.logicalSourceRevision).toEqual({
    tableId: 'observation_source_revisions',
    before: OBSERVATION_SOURCE_REVISION,
    after: OBSERVATION_SOURCE_REVISION_JOURNAL,
  })
  expect(step.sourceRevisionReplacements).toHaveLength(165)
  expect(after.contract.activeTableCount).toBe(before.contract.activeTableCount)
  expect(after.contract.archiveOnlyTableCount).toBe(before.contract.archiveOnlyTableCount)
  const changed = new Set(
    step.sourceRevisionReplacements!.map((pair) => 'function:' + pair.logicalId),
  )
  expect(changed.size).toBe(165)
  for (const original of before.plan.statements) {
    if (original.kind === 'metadata' && original.logicalId === 'contract-row') continue
    const current = after.plan.statements.find(
      (entry) => entry.kind === original.kind && entry.logicalId === original.logicalId,
    )
    if (changed.has(original.kind + ':' + original.logicalId)) {
      const pair = step.sourceRevisionReplacements!.find(
        (entry) => entry.logicalId === original.logicalId,
      )!
      expect(pair.before).toEqual(original)
      expect(pair.after).toEqual(current)
      expect(pair.before.sql).toContain('DO UPDATE SET')
      expect(pair.after.sql).not.toContain('DO UPDATE SET')
      expect(pair.after.sql).toContain('RETURN NULL')
    } else expect(current).toEqual(original)
  }
  expect(buildPostgresqlSchemaPlan(after.contract)).toEqual(after.plan)
  for (const resolve of [resolvePostgresqlIndexOnlyRowBridge, resolvePostgresqlAdditiveRowBridge]) {
    const bridge = resolve(history, {
      fromContractDigest: before.contract.digest,
      toContractDigest: after.contract.digest,
    })
    expect(bridge.source).toEqual(before.contract)
    expect(bridge.target).toEqual(after.contract)
    expect(bridge.steps).toEqual([step])
  }
  expect(step.executableStatements.filter((entry) => entry.kind === 'function')).toHaveLength(165)
  for (const statement of step.executableStatements.filter((entry) => entry.kind === 'function'))
    expect(statement.sql.startsWith('CREATE OR REPLACE FUNCTION ')).toBe(true)
}, 60_000)

test('V5 rejects incomplete, reversed and altered clock transitions even after their outer digest is recomputed', async () => {
  const history = await loadPostgresqlMigrationHistory(),
    at = history.steps.findIndex((step) => step.id === '0031_rfc371_committed_source_clocks')
  expect(at).toBeGreaterThanOrEqual(0)
  const original = history.steps[at]!
  for (const alter of [
    (step: typeof original) => Reflect.set(step, 'version', 4),
    (step: typeof original) => Reflect.set(step, 'logicalSourceRevision', undefined),
    (step: typeof original) => step.sourceRevisionReplacements!.slice(0, -1),
    (step: typeof original) => Reflect.set(step.logicalSourceRevision!, 'tableId', 'tasks'),
    (step: typeof original) =>
      Reflect.set(step.logicalSourceRevision!.after, 'changeJournal', 'other'),
    (step: typeof original) =>
      Reflect.set(step.sourceRevisionReplacements![0]!.after, 'sql', 'SELECT 1'),
  ]) {
    const changed: typeof original = JSON.parse(JSON.stringify(original)),
      result = alter(changed)
    if (Array.isArray(result)) Reflect.set(changed, 'sourceRevisionReplacements', result)
    const { digest: _digest, ...body } = changed
    Reflect.set(changed, 'digest', postgresqlMigrationDigest(body))
    expect(() =>
      replayPostgresqlMigrationHistory(history.root, [...history.steps.slice(0, at), changed]),
    ).toThrow()
  }
}, 60_000)
