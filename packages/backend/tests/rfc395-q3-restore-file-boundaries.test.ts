// RFC-395 migration §7: every skills/config move, in both directions, is replayable.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createEpochRestoreFiles } from '@/modules/system-operations/infrastructure/epochSwitch/restoreFiles'

for (const direction of ['apply', 'rollback'] as const)
  for (const occurrence of [1, 2, 3, 4])
    test(`Q-3 restore ${direction}: restart after move ${occurrence}/4 preserves both trees`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'q3-restore-moves-'))
      const sourceRoot = join(root, 'backup')
      const operationRoot = join(root, 'database-migrations/dbm_e2_q3_restore')
      const oldBytes = Buffer.from([0, 255, 1, 13, 10])
      const newBytes = Buffer.from([0xef, 0xbb, 0xbf, 0, 254])
      mkdirSync(join(root, 'skills'), { recursive: true })
      mkdirSync(join(sourceRoot, 'skills/nested'), { recursive: true })
      writeFileSync(join(root, 'skills/old'), oldBytes)
      writeFileSync(join(root, 'config.json'), '{ "old": 1 }\r\n')
      writeFileSync(join(sourceRoot, 'skills/nested/new'), newBytes)
      writeFileSync(join(sourceRoot, 'config.json'), '{ "new": 2 }\n')
      try {
        const clean = () => createEpochRestoreFiles({ appHome: root })
        const changes = await clean().plan({ operationRoot, sourceRoot, restoreConfig: true })
        expect(changes.map((c) => c.kind)).toEqual(['skills', 'config'])
        expect(changes.every((c) => c.replacedPath !== null)).toBe(true)
        if (direction === 'rollback') await clean().apply(changes)
        let seen = 0
        const crash = createEpochRestoreFiles({
          appHome: root,
          faults: (point) => {
            expect(point).toBe('after-restore-file')
            if (++seen === occurrence) throw new Error('q3-move-crash')
          },
        })
        await expect(crash[direction](changes)).rejects.toThrow('q3-move-crash')
        expect(seen).toBe(occurrence)
        const restarted = clean()
        const recoveredPlan = await restarted.plan({
          operationRoot,
          sourceRoot,
          restoreConfig: true,
        })
        expect(recoveredPlan).toEqual(changes)
        await restarted[direction](recoveredPlan)
        await clean()[direction](recoveredPlan)
        if (direction === 'apply') {
          expect(readFileSync(join(root, 'skills/nested/new'))).toEqual(newBytes)
          expect(readFileSync(join(root, 'config.json'), 'utf8')).toBe('{ "new": 2 }\n')
          expect(readFileSync(join(operationRoot, 'replaced/skills/old'))).toEqual(oldBytes)
          await clean().rollback(recoveredPlan)
        }
        expect(readFileSync(join(root, 'skills/old'))).toEqual(oldBytes)
        expect(readFileSync(join(root, 'config.json'), 'utf8')).toBe('{ "old": 1 }\r\n')
        expect(existsSync(join(root, 'skills/nested/new'))).toBe(false)
        expect(readFileSync(join(sourceRoot, 'skills/nested/new'))).toEqual(newBytes)
        expect(readFileSync(join(sourceRoot, 'config.json'), 'utf8')).toBe('{ "new": 2 }\n')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
