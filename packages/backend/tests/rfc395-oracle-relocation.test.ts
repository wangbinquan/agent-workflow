import { expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dir, '../src')
test('oracle is converter/test evidence only and normal boot has no sequence compatibility', () => {
  expect(
    existsSync(resolve(root, 'modules/task-execution/infrastructure/runSelection/oracle')),
  ).toBe(false)
  expect(
    existsSync(resolve(root, 'modules/task-execution/infrastructure/migration/oracle/reader.ts')),
  ).toBe(true)
  const violations = readdirSync(root, { recursive: true })
    .filter((entry): entry is string => typeof entry === 'string')
    .filter((path) => path.endsWith('.ts') && !path.includes('/migration/'))
    .filter((path) =>
      /from\s+['"][^'"]*(?:migration\/oracle|runSelection\/oracle|nodeRunSeqBackfill|taskCheckpointCodec)['"]/.test(
        readFileSync(resolve(root, path), 'utf8'),
      ),
    )
  expect(violations).toEqual([])
  const boot = readFileSync(
    resolve(root, 'modules/task-execution/application/bootExecutionRecovery.ts'),
    'utf8',
  )
  expect(boot).not.toContain('backfill')
  expect(boot.indexOf('effects.prepare(')).toBeLessThan(boot.indexOf('effects.reap('))
  expect(boot.indexOf('effects.reap(')).toBeLessThan(boot.indexOf('effects.repair('))
  expect(boot.indexOf('effects.repair(')).toBeLessThan(boot.indexOf('effects.finalize('))
})
