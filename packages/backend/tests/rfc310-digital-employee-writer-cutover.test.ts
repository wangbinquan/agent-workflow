import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { describeEachProvider } from './helpers/eachProvider'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { developmentMissions, developmentMrClaims } from '@/db/schema'
import { composeDigitalEmployeeWriterCutoverFor } from '@/modules/digital-employee/composition'

// RFC-317 T41 / RFC-349 —— provider adapter owns the writer state and the
// bounded legacy-mission drain projection as one atomic aggregate.
// RFC-359 AC-6：两个 provider 的适配器各跑一遍，同事务不变量在两边都被验到
// （此前只有 SQLite 那一侧真的跑过）。app home 与临时目录都归共用作用域，
// 原来那套自建 roots / afterEach 清理随之删掉。

describeEachProvider('RFC-310 Digital Employee OS single-writer cutover', (harness) => {
  test('boot atomically retires legacy admission and activates generation one', async () => {
    const db = harness.db
    const writer = composeDigitalEmployeeWriterCutoverFor(db)
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
    const db = harness.db
    await db.insert(developmentMissions).values({
      id: 'legacy-mission-1',
      status: 'running',
      repositoryId: 'repo-1',
      sourceKind: 'direct',
      deliveryKind: 'merge-request',
      createdAt: 1,
      updatedAt: 1,
    })
    await db.insert(developmentMrClaims).values({
      id: 'legacy-claim-1',
      codeHostEndpointRef: 'endpoint-1',
      stableProjectRef: 'project-1',
      mrIid: '42',
      missionId: 'legacy-mission-1',
      epoch: 1,
      state: 'active',
      createdAt: 2,
    })

    const writer = composeDigitalEmployeeWriterCutoverFor(db)
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

    await db
      .update(developmentMissions)
      .set({ status: 'completed', terminalAt: 30_000, updatedAt: 30_000 })
      .where(eq(developmentMissions.id, 'legacy-mission-1'))
    await expect(writer.refresh(30_001)).resolves.toMatchObject({
      mode: 'os-active',
      legacyOpenMissionCount: 0,
      legacyAdmissionsEnabled: false,
    })
  })

  test('migration reporting stays bounded while preserving the exact drain total', async () => {
    const db = harness.db
    await db.insert(developmentMissions).values(
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

    const writer = composeDigitalEmployeeWriterCutoverFor(db)
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
})

// RFC-359 AC-6：这一条原来**只跑 SQLite**（自建内存库 + 自建应用 + 自建 app home），
// 而同文件上半段的服务层用例早已双引擎。库 / 应用 / app home 全部改取作用域现建的那一份；
// 切换器要在装配**之前**激活（路由读的是已激活的状态）。
describeEachProviderHttpApplication(
  'RFC-310 Digital Employee OS single-writer cutover',
  {
    token: 'a'.repeat(64),
    opencodeVersion: null,
    dbVersion: 1,
    tempPrefix: 'rfc310-writer-route-',
  },
  (scope) => {
    test('HTTP refuses new legacy Missions after cutover while exposing the drain report', async () => {
      const [{ createSession }, { createUser }] = await Promise.all([
        import('./helpers/auth/sessionStore'),
        import('@/services/users'),
      ])
      const db = scope.harness.db
      await composeDigitalEmployeeWriterCutoverFor(db).activate({
        now: 40_000,
        legacyAdmissionsEnabled: false,
      })
      const app = (await scope.open()).app
      const admin = await createUser(db, {
        username: 'writer-admin',
        displayName: 'Writer Admin',
        role: 'admin',
        password: 'longEnoughPassword',
      })
      const session = await createSession({ db, userId: admin.id })
      const headers = {
        Authorization: `Bearer ${session.token}`,
        'content-type': 'application/json',
      }

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
  },
)
