import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ResourceBundle } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { buildActor } from '../src/auth/actor'
import { createInMemoryDb, instrumentSlowStatements } from '../src/db/client'
import { resourceBundleApplies, skills } from '../src/db/schema'
import { applyResourceBundle, convergeResourceBundleApplies } from '../src/services/bundle/apply'
import type { BundleApplyProvider } from '../src/services/bundle/provider'
import { createManagedSkillWithFiles } from '../src/modules/resource-catalog/infrastructure/legacy/skill'
import {
  isSkillBootVerified,
  resetSkillBootVerifyForTest,
} from '../src/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import { commitSkillVersion } from '../src/modules/resource-catalog/infrastructure/legacy/skillVersion'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const FAKE_NPM = resolve(import.meta.dir, 'fixtures', 'fake-npm.ts')
const dirs: string[] = []
let reportRecoveryCleanup: (() => void) | undefined

afterEach(() => {
  const report = reportRecoveryCleanup
  reportRecoveryCleanup = undefined
  report?.()
  delete process.env.FAKE_NPM_MODE
  resetSkillBootVerifyForTest()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const actor = buildActor({
  user: { id: 'u1', username: 'u1', displayName: 'u1', role: 'admin', status: 'active' },
  source: 'daemon',
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function makeDeps() {
  return {
    db: createInMemoryDb(MIGRATIONS),
    appHome: tempDir('rfc271-recovery-app-'),
  }
}

function provider(key: string): BundleApplyProvider {
  return {
    idempotencyKey: { scope: 'package', key },
    serializationKey: key,
    actor,
    resolveExternal: async (ref) => ref.slice('external:'.length),
    readSkillFile: () => new Uint8Array(),
  }
}

const pluginBundle = (): ResourceBundle =>
  ({
    bundleVersion: 1,
    ops: [
      {
        opId: 'op-1',
        kind: 'plugin-create',
        slug: 'plugin-a',
        payload: {
          name: 'Plugin A',
          options: {},
          spec: 'left-pad@1.0.0',
          description: '',
          enabled: true,
          sourceKind: 'npm',
        },
      },
    ],
  }) as ResourceBundle

describe('plugin install failure uses the durable artifact as its compensation oracle', () => {
  test('installer throws before InstallResult: exact generation is removed before journal becomes failed', async () => {
    const deps = makeDeps()
    const pluginsDir = tempDir('rfc271-recovery-plugins-')
    process.env.FAKE_NPM_MODE = 'fail'

    await expect(
      applyResourceBundle(
        { ...deps, pluginInstallOpts: { pluginsDir, npmBin: FAKE_NPM } },
        { bundle: pluginBundle(), provider: provider(ulid()) },
      ),
    ).rejects.toBeDefined()

    const row = deps.db.select().from(resourceBundleApplies).get()!
    const artifact = JSON.parse(row.preparedArtifactsJson)[0] as { generationDir: string }
    expect(row.state).toBe('failed')
    expect(existsSync(artifact.generationDir)).toBe(false)
  })

  test('compensation failure leaves the journal retryable; stale convergence removes it then settles', async () => {
    const deps = makeDeps()
    const pluginsDir = tempDir('rfc271-recovery-plugins-')
    process.env.FAKE_NPM_MODE = 'fail'
    let compensationAttempts = 0

    await expect(
      applyResourceBundle(
        {
          ...deps,
          pluginInstallOpts: { pluginsDir, npmBin: FAKE_NPM },
          faults: {
            beforeArtifactCompensation: () => {
              compensationAttempts += 1
              throw new Error('cleanup is temporarily blocked')
            },
          },
        },
        { bundle: pluginBundle(), provider: provider(ulid()) },
      ),
    ).rejects.toBeDefined()

    const pending = deps.db.select().from(resourceBundleApplies).get()!
    const artifact = JSON.parse(pending.preparedArtifactsJson)[0] as { generationDir: string }
    expect(compensationAttempts).toBe(1)
    expect(pending.state).toBe('prepared')
    expect(existsSync(artifact.generationDir)).toBe(true)

    deps.db
      .update(resourceBundleApplies)
      .set({ updatedAt: Date.now() - 11 * 60 * 1000 })
      .where(eq(resourceBundleApplies.id, pending.id))
      .run()
    expect(await convergeResourceBundleApplies(deps.db, deps.appHome)).toEqual({
      failed: 1,
      rolledForward: 0,
    })
    expect(deps.db.select().from(resourceBundleApplies).get()?.state).toBe('failed')
    expect(existsSync(artifact.generationDir)).toBe(false)
  })
})

async function seedSkill(deps: ReturnType<typeof makeDeps>) {
  return createManagedSkillWithFiles(
    deps.db,
    { appHome: deps.appHome },
    { name: 'tail-skill', description: 'v1', ownerUserId: actor.user.id, actor },
    (filesDir) => {
      writeFileSync(
        join(filesDir, 'SKILL.md'),
        '---\nname: tail-skill\ndescription: v1\n---\n\nbody v1\n',
      )
    },
  )
}

function skillUpdateBundle(skill: typeof skills.$inferSelect): ResourceBundle {
  return {
    bundleVersion: 1,
    ops: [
      {
        opId: 'op-1',
        kind: 'skill-update',
        target: `external:${skill.id}`,
        expect: {
          expectedContentVersion: skill.contentVersion,
          expectedMetaRevision: skill.metaRevision,
          expectedAclRevision: skill.aclRevision,
        },
        payload: {
          name: skill.name,
          description: 'v2',
          frontmatterExtra: {},
          bodyMd: 'body v2',
          files: [],
        },
      },
    ],
  }
}

describe('committed skill-update tail is replay-safe', () => {
  test('hourly convergence cannot let an old completed journal unmark a later skill version', async () => {
    const deps = makeDeps()
    const created = await seedSkill(deps)
    const row = deps.db.select().from(skills).where(eq(skills.id, created.id)).get()!

    await applyResourceBundle(deps, {
      bundle: skillUpdateBundle(row),
      provider: provider(ulid()),
    })
    expect(isSkillBootVerified(created.id)).toBe(true)

    const imported = deps.db.select().from(skills).where(eq(skills.id, created.id)).get()!
    await commitSkillVersion(
      deps.db,
      { appHome: deps.appHome },
      created.id,
      (stagingDir) => {
        writeFileSync(
          join(stagingDir, 'SKILL.md'),
          '---\nname: tail-skill\ndescription: v3\n---\n\nbody v3\n',
        )
      },
      {
        source: 'editor',
        authorUserId: actor.user.id,
        expectedVersion: imported.contentVersion,
      },
    )
    expect(isSkillBootVerified(created.id)).toBe(true)

    expect((await convergeResourceBundleApplies(deps.db, deps.appHome)).rolledForward).toBe(1)
    expect(isSkillBootVerified(created.id)).toBe(true)
    expect(
      readFileSync(join(deps.appHome, 'skills', created.id, 'files', 'SKILL.md'), 'utf8'),
    ).toContain('body v3')
    expect((await convergeResourceBundleApplies(deps.db, deps.appHome)).rolledForward).toBe(1)
    expect(isSkillBootVerified(created.id)).toBe(true)
  })

  test('a committed but unfinished exact op still rolls forward, then later passes are no-ops', async () => {
    // ee82 / macOS job 101948393199 reached the intended pre-tail fault only
    // after 4.957s, then timed out and removed the fixture directory. Record the
    // actual phases and CPU next time; keep the original 5s budget and oracle.
    const startedAt = performance.now()
    const startedCpu = process.cpuUsage()
    const traceId = `committed-skill-tail:${process.pid}:${startedAt}`
    const sqlSamples: {
      sequence: number
      sql: string | undefined
      startedAtMs: number
      wallMs: number
      cpuMs: number | undefined
    }[] = []
    let sqlCount = 0
    let droppedSqlSamples = 0
    let lastPhase: string | undefined
    let cleanupStarted = false
    const phase = (name: string) => {
      const cpu = process.cpuUsage(startedCpu)
      console.warn(
        '[rfc359-recovery-phase]',
        JSON.stringify({
          traceId,
          phase: name,
          previousPhase: lastPhase,
          cleanupStarted,
          wallMs: performance.now() - startedAt,
          cpuMicros: cpu.user + cpu.system,
          sqlCount,
          droppedSqlSamples,
          sqlSamples: sqlSamples.splice(0),
        }),
      )
      lastPhase = name
    }
    reportRecoveryCleanup = () => {
      cleanupStarted = true
      phase('cleanup-start')
    }
    phase('start')
    const deps = makeDeps()
    phase('database-ready')
    const created = await seedSkill(deps)
    phase('skill-seeded')
    const row = deps.db.select().from(skills).where(eq(skills.id, created.id)).get()!

    // Observe this same connection only. Native execution excludes preparation,
    // filesystem work and lease/event-loop waits; timestamps expose those gaps.
    // Keep samples until a phase or cleanup, so a timed-out callback still has
    // the same trace ID and explicitly marks every subsequent phase as cleanup.
    const sqlite: unknown = Reflect.get(deps.db, '$client')
    if (!(sqlite instanceof Database)) throw new Error('expected the fixture SQLite connection')
    instrumentSlowStatements(sqlite, 0, undefined, (wallMs, sql, cpuMs) => {
      sqlCount += 1
      if (sqlSamples.length === 128) {
        sqlSamples.shift()
        droppedSqlSamples += 1
      }
      sqlSamples.push({
        sequence: sqlCount,
        sql,
        startedAtMs: performance.now() - startedAt - wallMs,
        wallMs,
        cpuMs,
      })
    })
    phase('before-apply')
    await expect(
      applyResourceBundle(
        {
          ...deps,
          faults: {
            afterSkillStage: () => phase('skill-stage-complete'),
            beforeTx: () => phase('before-atomic-transaction'),
            inTxAfterOps: () => phase('atomic-operations-complete'),
            afterTxBeforeRollForward: () => {
              phase('committed-before-tail')
              throw new Error('crash before tail')
            },
          },
        },
        { bundle: skillUpdateBundle(row), provider: provider(ulid()) },
      ),
    ).rejects.toThrow('crash before tail')
    phase('expected-crash-observed')
    expect(deps.db.select().from(resourceBundleApplies).get()?.state).toBe('committed')

    expect((await convergeResourceBundleApplies(deps.db, deps.appHome)).rolledForward).toBe(1)
    phase('first-convergence-complete')
    expect(isSkillBootVerified(created.id)).toBe(true)
    expect(
      readFileSync(join(deps.appHome, 'skills', created.id, 'files', 'SKILL.md'), 'utf8'),
    ).toContain('body v2')

    expect((await convergeResourceBundleApplies(deps.db, deps.appHome)).rolledForward).toBe(1)
    expect(isSkillBootVerified(created.id)).toBe(true)
    phase('replay-complete')
  })
})
