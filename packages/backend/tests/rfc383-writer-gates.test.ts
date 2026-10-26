// RFC-395 H retires the normal-boot draining phase and its writer-state table.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { composeDigitalEmployeeWriterCutoverFor } from '@/modules/digital-employee/composition'
import { describeEachProvider } from './helpers/eachProvider'
import { assertFixedWriterInstallation } from './helpers/model/writerInstallation'
describeEachProvider('RFC-383 installed writer gates', (h) => {
  test('installed generation exposes fixed OS writer status and an empty historical drain report', async () => {
    await assertFixedWriterInstallation(h.db)
  })
  test('unbound installation fails before any runtime status can be published', async () => {
    const writer = composeDigitalEmployeeWriterCutoverFor(h.db)
    await expect(writer.read()).rejects.toThrow('digital-employee-writer-installation-unbound')
    await expect(writer.analyze()).rejects.toThrow('digital-employee-writer-installation-unbound')
  })
})
test('removed application hooks cannot be reintroduced as a normal-boot compatibility path', () => {
  const root = resolve(import.meta.dir, '../src/modules')
  const gates = readFileSync(
    resolve(root, 'development-automation/application/writerCutoverGates.ts'),
    'utf8',
  )
  expect(gates).toContain('interface DevelopmentWriterCutover')
  expect(gates).not.toMatch(
    /export (?:async )?function|legacy-draining|sweepWakesWhileDraining|recoverWhileDraining/,
  )
  const source = readFileSync(
    resolve(root, 'digital-employee/infrastructure/writerCutoverPersistence.ts'),
    'utf8',
  )
  expect(source).not.toMatch(/tablesOf|legacy-draining|migrationSnapshot|refresh\(/)
  expect(source).toContain('digital-employee-writer-installation-unbound')
})
