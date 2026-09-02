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
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createUser } from '../src/services/users'
import { createApp } from '../src/server'
import { composeDigitalEmployeeAgentTemplateCatalogParticipant } from '../src/modules/digital-employee/composition'
import { composeSqliteDigitalEmployeeAgentTemplateCatalogParticipant } from '../src/modules/resource-catalog/composition/digitalEmployeeAgentTemplateCatalog'
import { composeDigitalEmployeeBuiltinToolCatalog } from '../src/modules/task-execution/composition/digitalEmployeeBuiltinToolCatalog'
import { developmentEmployeeTypePackage } from '../src/modules/development-automation/composition/employeeTypePackage'
import { ensureDigitalEmployeeAgentTemplates } from '../src/services/digitalEmployeeAgentTemplates'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const backendRoot = resolve(import.meta.dir, '..')

describe('RFC-349 digital employee platform tool wiring', () => {
  let db: DbClient
  let appHome: string
  let app: ReturnType<typeof createApp>
  let token: string
  let typeRef: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc349-platform-tools-'))
    process.env.AGENT_WORKFLOW_HOME = appHome
    const templates = composeSqliteDigitalEmployeeAgentTemplateCatalogParticipant(
      db,
      composeDigitalEmployeeAgentTemplateCatalogParticipant,
    )
    await ensureDigitalEmployeeAgentTemplates(templates)
    const descriptor = JSON.parse(developmentEmployeeTypePackage.descriptorJson) as {
      typeRef: { typeId: string; revision: number }
    }
    typeRef = `${descriptor.typeRef.typeId}@${descriptor.typeRef.revision}`
    app = createApp({
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
    const admin = await createUser(db, {
      username: 'platform_tools_admin',
      email: 'platform-tools@example.test',
      displayName: 'platform tools admin',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    token = (await createSession({ db, userId: admin.id })).token
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
})
