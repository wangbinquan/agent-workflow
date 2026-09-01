import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb } from '@/db/client'
import { developmentMissions, developmentMrClaims } from '@/db/schema'
import { composeSqliteDigitalEmployeeWriterCutover } from '@/modules/digital-employee/composition'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// RFC-317 T41 / RFC-349 —— provider adapter owns the writer state and the
// bounded legacy-mission drain projection as one atomic aggregate. Exercising
// the real SQLite adapter here preserves the same-transaction invariant.
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-310 Digital Employee OS single-writer cutover', () => {
  test('boot atomically retires legacy admission and activates generation one', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const writer = composeSqliteDigitalEmployeeWriterCutover(db)
    await expect(writer.read()).resolves.toMatchObject({
      activeGeneration: 0,
      mode: 'pre-cutover',
      legacyAdmissionsEnabled: true,
    })

    await expect(
      writer.activate({
        now: 10_000,
        legacyAdmissionsEnabled: false,
      }),
    ).resolves.toEqual({
      activeGeneration: 1,
      mode: 'os-active',
      legacyAdmissionsEnabled: false,
      legacyOpenMissionCount: 0,
      updatedAt: 10_000,
    })
  })

  test('existing Missions retain their claims until terminal and are never mechanically adopted', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    db.insert(developmentMissions)
      .values({
        id: 'legacy-mission-1',
        status: 'running',
        repositoryId: 'repo-1',
        sourceKind: 'direct',
        deliveryKind: 'merge-request',
        createdAt: 1,
        updatedAt: 1,
      })
      .run()
    db.insert(developmentMrClaims)
      .values({
        id: 'legacy-claim-1',
        codeHostEndpointRef: 'endpoint-1',
        stableProjectRef: 'project-1',
        mrIid: '42',
        missionId: 'legacy-mission-1',
        epoch: 1,
        state: 'active',
        createdAt: 2,
      })
      .run()

    const writer = composeSqliteDigitalEmployeeWriterCutover(db)
    await expect(
      writer.activate({
        now: 20_000,
        legacyAdmissionsEnabled: false,
      }),
    ).resolves.toMatchObject({
      mode: 'legacy-draining',
      legacyAdmissionsEnabled: false,
      legacyOpenMissionCount: 1,
    })
    await expect(writer.analyze()).resolves.toMatchObject({
      mechanicallyAdoptable: [],
      blockedReason: expect.stringContaining('never concurrently adopted'),
      draining: [
        {
          missionId: 'legacy-mission-1',
          status: 'running',
          activeMrClaimCount: 1,
          childLinkCount: 0,
          pendingApprovalCount: 0,
        },
      ],
    })

    db.update(developmentMissions)
      .set({ status: 'completed', terminalAt: 30_000, updatedAt: 30_000 })
      .where(eq(developmentMissions.id, 'legacy-mission-1'))
      .run()
    await expect(writer.refresh(30_001)).resolves.toMatchObject({
      mode: 'os-active',
      legacyOpenMissionCount: 0,
      legacyAdmissionsEnabled: false,
    })
  })

  test('migration reporting stays bounded while preserving the exact drain total', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    db.insert(developmentMissions)
      .values(
        Array.from({ length: 101 }, (_, index) => ({
          id: `legacy-mission-${String(index).padStart(3, '0')}`,
          status: 'running' as const,
          repositoryId: 'repo-1',
          sourceKind: 'direct' as const,
          deliveryKind: 'merge-request' as const,
          createdAt: index,
          updatedAt: index,
        })),
      )
      .run()

    const writer = composeSqliteDigitalEmployeeWriterCutover(db)
    await writer.activate({
      now: 35_000,
      legacyAdmissionsEnabled: false,
    })
    const report = await writer.analyze()

    expect(report.drainingTotal).toBe(101)
    expect(report.drainingTruncated).toBe(true)
    expect(report.draining).toHaveLength(100)
    expect(report.draining[0]?.missionId).toBe('legacy-mission-000')
    expect(report.draining.at(-1)?.missionId).toBe('legacy-mission-099')
  })

  test('HTTP refuses new legacy Missions after cutover while exposing the drain report', async () => {
    const [{ createSession }, { createApp }, { createUser }] = await Promise.all([
      import('@/auth/sessionStore'),
      import('@/server'),
      import('@/services/users'),
    ])
    const db = createInMemoryDb(MIGRATIONS)
    await composeSqliteDigitalEmployeeWriterCutover(db).activate({
      now: 40_000,
      legacyAdmissionsEnabled: false,
    })
    const appHome = mkdtempSync(join(tmpdir(), 'rfc310-writer-route-'))
    roots.push(appHome)
    const app = createApp({
      token: 'a'.repeat(64),
      configPath: join(appHome, 'config.json'),
      appHome,
      opencodeVersion: null,
      dbVersion: 1,
      db,
    })
    const admin = await createUser(db, {
      username: 'writer-admin',
      displayName: 'Writer Admin',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    const session = await createSession({ db, userId: admin.id })
    const headers = { Authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }

    const launch = await app.request('/api/code/missions', {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    })
    expect(launch.status).toBe(409)
    expect(await launch.json()).toMatchObject({ code: 'legacy-mission-admission-retired' })

    const status = await app.request('/api/digital-employees/migration-status', { headers })
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({
      writer: { mode: 'os-active', legacyAdmissionsEnabled: false },
      draining: [],
    })
  })
})
