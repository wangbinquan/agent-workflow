// RFC-349 回归防护 —— HTTP 授权面必须和 OS 运行时读同一份平台工具目录。
//
// 为什么这条测试存在：RFC-349 把内置工具目录的组装改成 provider-bound 且异步，
// 于是 `server.ts` 里原本自己 `composeDigitalEmployeeBuiltinToolCatalog({ db })`
// 的那段变成了一个**可选注入**（`deps.digitalEmployeePlatformTools`）——而
// `cli/start.ts` 只把目录交给了自己那份 `employeeOs`，从没交给 `createComposedApp`。
// 结果：SQLite daemon 的 `/work-items/:ref/tools` 恒返回 `{"items":[]}`，岗位模版
// 编辑器里「选择默认工具」下拉根本不存在（占位符退化成「请先在该节点增加工具」），
// 零配置上手流程整条断掉。e2e `rfc310-zero-config-onboarding` 就死在这里。
//
// 这里锁两端：①注入到位时 HTTP 面确实能列出平台工具；②`cli/start.ts` 确实把
// 同一个目录交给了 app 组装（否则第 ① 条在生产里永远走不到）。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSession } from './helpers/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createUser } from '../src/services/users'
import { composeSqliteAppDeps, createComposedApp, type SqliteAppComposition } from '../src/server'
import type { DigitalEmployeeWorkStartPort } from '../src/modules/integration/public/participants'
import { composeDigitalEmployeeAgentTemplateCatalogParticipant } from '../src/modules/digital-employee/composition'
import { composeDigitalEmployeeAgentTemplateCatalogFor } from '../src/modules/resource-catalog/composition/digitalEmployeeAgentTemplateCatalog'
import { composeDigitalEmployeeBuiltinToolCatalog } from '../src/modules/task-execution/composition/digitalEmployeeBuiltinToolCatalog'
import { developmentEmployeeTypePackage } from '../src/modules/development-automation/composition/employeeTypePackage'
import { ensureDigitalEmployeeAgentTemplates } from '../src/services/digitalEmployeeAgentTemplates'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const backendRoot = resolve(import.meta.dir, '..')

describe('RFC-349 digital employee platform tool wiring', () => {
  let db: DbClient
  let appHome: string
  let composition: SqliteAppComposition
  let app: ReturnType<typeof createComposedApp>
  let token: string
  let actorUserId: string
  let typeRef: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc349-platform-tools-'))
    process.env.AGENT_WORKFLOW_HOME = appHome
    const templates = composeDigitalEmployeeAgentTemplateCatalogFor(
      db,
      composeDigitalEmployeeAgentTemplateCatalogParticipant,
    )
    await ensureDigitalEmployeeAgentTemplates(templates)
    const descriptor = JSON.parse(developmentEmployeeTypePackage.descriptorJson) as {
      typeRef: { typeId: string; revision: number }
    }
    typeRef = `${descriptor.typeRef.typeId}@${descriptor.typeRef.revision}`
    composition = composeSqliteAppDeps({
      token: 'd'.repeat(64),
      configPath: join(appHome, 'config.json'),
      opencodeVersion: null,
      dbVersion: 1,
      db,
      appHome,
      digitalEmployeePlatformTools: await composeDigitalEmployeeBuiltinToolCatalog({
        agentTemplates: templates,
        typePackageDescriptorJsons: [developmentEmployeeTypePackage.descriptorJson],
      }),
    })
    app = createComposedApp(composition)
    const admin = await createUser(db, {
      username: 'platform_tools_admin',
      email: 'platform-tools@example.test',
      displayName: 'platform tools admin',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    token = (await createSession({ db, userId: admin.id })).token
    actorUserId = admin.id
  })

  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  test('the HTTP tool listing surfaces the built-in platform tools for a business-tool work item', async () => {
    const response = await app.request(
      `/api/digital-employee-types/${encodeURIComponent(typeRef)}/work-items/analyze-implement/tools`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    expect(response.status, await response.clone().text()).toBe(200)
    const body = (await response.json()) as {
      items: Array<{ id: string; origin: string; state: string; selection: string }>
    }
    const platform = body.items.filter((item) => item.origin === 'platform')
    expect(
      platform.length,
      '授权面看不到任何平台工具 ⇒ 岗位模版编辑器没有可绑定的默认工具',
    ).toBeGreaterThan(0)
    // 编辑器只把 published + selectable 的行当候选；少了这一档，下拉依然是空的。
    expect(
      platform.filter((item) => item.state === 'published' && item.selection !== 'unavailable')
        .length,
    ).toBeGreaterThan(0)
  })

  test('the SQLite daemon hands its one catalog to the app composition, not only to the OS runtime', () => {
    const source = readFileSync(resolve(backendRoot, 'src/cli/start.ts'), 'utf8')
    // 目录必须先于 app 组装建好，并**同时**交给 app 与 employeeOs。
    expect(source).toMatch(
      /const digitalEmployeePlatformTools = await composeDigitalEmployeeBuiltinToolCatalog\(/,
    )
    expect(source).toMatch(/composeSqliteAppDeps\(\{[\s\S]{0,600}digitalEmployeePlatformTools,/)
    expect(source).toContain('platformTools: digitalEmployeePlatformTools,')
    // 单一实例：不允许再出现第二次组装（两份目录 = 两种真值）。
    expect(source.split('composeDigitalEmployeeBuiltinToolCatalog(').length - 1).toBe(1)
  })

  test('the completed HTTP composition exposes a required WorkStart port without a bind phase', async () => {
    const port: DigitalEmployeeWorkStartPort = composition.digitalEmployeeWorkStart
    expect(Object.isFrozen(composition)).toBe(true)
    expect(Object.isFrozen(port)).toBe(true)
    // @ts-expect-error A completed WorkStart port has no mutable binding phase.
    expect(port.bind).toBeUndefined()
    expect('digitalEmployeeWorkStart' in composition.apiRoutes).toBe(false)
    await expect(
      port.launch({
        employeeId: 'missing-employee',
        intake: {
          kind: 'body',
          target: { repositoryId: 'repository-1' },
          body: 'repair the pipeline',
          externalId: null,
          uploads: [],
          idempotencyKey: 'event-delivery:missing-employee',
        },
        actorUserId,
        origin: {
          eventSubscriptionId: 'subscription-1',
          eventDeliveryId: 'missing-employee',
        },
      }),
    ).rejects.toMatchObject({ code: 'employee-definition-not-found' })
  })

  test('WorkStart uses the HTTP employee and stays usable after the same routes mount again', async () => {
    async function requestJson<T>(path: string, body?: unknown): Promise<T> {
      const response = await app.request(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const text = await response.text()
      expect(response.ok, text).toBe(true)
      return JSON.parse(text) as T
    }
    const base = `/api/digital-employee-types/${encodeURIComponent(typeRef)}`
    const tools = await requestJson<{
      items: Array<{
        id: string
        origin: string
        publishedRevision: number | null
        state: string
        selection: string
      }>
    }>(`${base}/work-items/analyze-implement/tools`)
    const tool = tools.items.find(
      (item) =>
        item.origin === 'platform' &&
        item.state === 'published' &&
        item.selection !== 'unavailable',
    )
    if (tool?.publishedRevision == null) throw new Error('fixture needs a published platform tool')
    const job = await requestJson<{ id: string }>(`${base}/job-templates`, {
      name: 'HTTP WorkStart role',
      description: 'Run body intake through the completed application.',
      defaultToolBindings: [
        {
          workItemRef: 'analyze-implement',
          slotRef: 'default',
          registrationRef: { id: tool.id, revision: tool.publishedRevision },
        },
      ],
    })
    const published = await requestJson<{ ref: { id: string; revision: number } }>(
      `/api/digital-employee-job-templates/${job.id}/publish`,
      {},
    )
    const employee = await requestJson<{ id: string }>(`${base}/employees`, {
      name: 'HTTP WorkStart employee',
      jobTemplateRef: published.ref,
      workScope: { kind: 'repository', repositoryId: 'repository-1' },
    })
    const port = composition.digitalEmployeeWorkStart
    const request: Parameters<DigitalEmployeeWorkStartPort['launch']>[0] = {
      employeeId: employee.id,
      intake: {
        kind: 'body',
        target: { repositoryId: 'repository-1' },
        body: 'repair the pipeline through the HTTP employee',
        externalId: null,
        uploads: [],
        idempotencyKey: 'event-delivery:delivery-1',
      },
      actorUserId,
      origin: { eventSubscriptionId: 'subscription-1', eventDeliveryId: 'delivery-1' },
    }
    const first = await port.launch(request)
    expect(first.caseId).toBeString()
    app = createComposedApp(composition)
    expect(composition.digitalEmployeeWorkStart).toBe(port)
    expect(await port.launch(request)).toEqual(first)
    const detail = await requestJson<{ case: Record<string, unknown> }>(
      `/api/employee-cases/${first.caseId}`,
    )
    expect(detail.case).toMatchObject({
      id: first.caseId,
      employeeRef: { id: employee.id, revision: 1 },
      ownerUserId: actorUserId,
      launchOrigin: 'event',
      name: request.intake.body,
      state: 'active',
      currentWorkItemRef: 'prepare-materials',
    })
  })
})
