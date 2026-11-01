// RFC-398 L1 found that a released, committed delete can retain a legacy name
// receipt after conversion. Roll-forward must retain all deletion-authority
// proofs while disposing only the operation's trash and releasing its lock.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { createSkillCatalogBootAdapter } from '@/modules/resource-catalog/infrastructure/skillCatalogBootAdapter'
import {
  advancePhase,
  beginOperation,
} from '@/modules/resource-catalog/infrastructure/legacy/skillOperations'
import { describeEachProvider } from './helpers/eachProvider'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describeEachProvider('RFC-398 released skill deletion recovery', (harness) => {
  for (const variant of [
    'committed',
    'uncommitted',
    'legacy-root',
    'canonical-root',
    'wrong-trash',
  ] as const) {
    test(`${variant}: legacy receipt preserves the deletion authority boundary`, async () => {
      const appHome = mkdtempSync(join(tmpdir(), 'rfc398-skill-delete-'))
      roots.push(appHome)
      const skillId = ulid()
      const name = 'deleted-legacy-skill'
      const opId = await harness.session.transaction(async (tx) => {
        const id = await beginOperation(tx, {
          skillId,
          kind: 'delete',
          preconditionJson: JSON.stringify({ name }),
        })
        await advancePhase(tx, id, 'fs-staged', {
          backupPath: join(
            appHome,
            'skills',
            '.trash',
            `${skillId}-${variant === 'wrong-trash' ? ulid() : id}`,
          ),
        })
        if (variant !== 'uncommitted') await advancePhase(tx, id, 'db-committed')
        return id
      })
      const trash = join(appHome, 'skills', '.trash', `${skillId}-${opId}`)
      mkdirSync(trash, { recursive: true })
      writeFileSync(join(trash, 'SKILL.md'), 'Historical deleted content')
      if (variant === 'legacy-root' || variant === 'canonical-root')
        mkdirSync(join(appHome, 'skills', variant === 'legacy-root' ? name : skillId), {
          recursive: true,
        })
      const boot = createSkillCatalogBootAdapter({ db: harness.db, appHome })
      const { skillOperations, skillOperationLocks } = tablesOf(harness.db)
      if (variant === 'committed') {
        expect(await boot.recoverOperations()).toMatchObject({ rolledForward: 1 })
        expect(existsSync(trash)).toBe(false)
        expect(
          await harness.db
            .select()
            .from(skillOperationLocks)
            .where(eq(skillOperationLocks.opId, opId)),
        ).toEqual([])
        expect(
          await harness.db.select().from(skillOperations).where(eq(skillOperations.opId, opId)),
        ).toMatchObject([{ active: 0, phase: 'done' }])
        expect(await boot.recoverOperations()).toMatchObject({ total: 0 })
      } else {
        await expect(boot.recoverOperations()).rejects.toThrow(
          variant === 'uncommitted'
            ? 'skill-legacy-upgrade-requires-conversion'
            : /delete operation/,
        )
        expect(existsSync(trash)).toBe(true)
        expect(
          await harness.db
            .select()
            .from(skillOperationLocks)
            .where(eq(skillOperationLocks.opId, opId)),
        ).toHaveLength(1)
      }
    })
  }
})
