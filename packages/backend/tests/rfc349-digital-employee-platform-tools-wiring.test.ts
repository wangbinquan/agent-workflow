// RFC-395 II-pre：用户夹具改接生产 identity-access 运行时，保留原用例意图。
// RFC-349 / RFC-392: HTTP and WorkStart consume the application graph's single platform-tool catalog on both engines.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { createSession } from './helpers/auth/sessionStore'
import { createUser } from './helpers/userFixture'
import { describeEachProvider } from './helpers/eachProvider'
import {
  createProviderHttpApplication,
  type ProviderHttpApplication,
} from './helpers/providerHttpApplication'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { Hono } from 'hono'
import { readDaemonGraphSource } from './helpers/daemonGraphSource'
import { bootImplementation, expectBootOrder } from './helpers/daemonProgramSource'
import type { DigitalEmployeeWorkStartPort } from '../src/modules/integration/public/participants'
import { composeDigitalEmployeeAgentTemplateCatalogParticipant } from '../src/modules/digital-employee/composition'
import { composeDigitalEmployeeAgentTemplateCatalogFor } from '../src/modules/resource-catalog/composition/digitalEmployeeAgentTemplateCatalog'
import { developmentEmployeeTypePackage } from '../src/modules/development-automation/composition/employeeTypePackage'
import { ensureDigitalEmployeeAgentTemplates } from '../src/services/digitalEmployeeAgentTemplates'

const backendRoot = resolve(import.meta.dir, '..')

describeEachProvider('RFC-349 digital employee platform tool wiring', (harness) => {
  let db: ProviderNeutralDatabase
  let appHome: string
  let composition: ProviderHttpApplication
  let app: Hono
  let token: string
  let actorUserId: string
  let typeRef: string

  beforeEach(async () => {
    db = harness.db
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
    composition = await createProviderHttpApplication(harness, {
      token: 'd'.repeat(64),
      appHome,
      configPath: join(appHome, 'config.json'),
      dbVersion: 1,
      opencodeVersion: null,
    })
    app = composition.app
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

  afterEach(async () => {
    await composition?.dispose()
    rmSync(appHome, { recursive: true, force: true })
  })

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

  test('the daemon hands its one catalog to the app composition, not only to the OS runtime', () => {
    const source = readDaemonGraphSource()
    // RFC-383: the session bundle builds and owns the catalog before HTTP assembly.
    const bundle = readFileSync(
      resolve(backendRoot, 'src/bootstrap/daemonModules/digitalEmployee.ts'),
      'utf8',
    )
    expect(source).toMatch(
      /const digitalEmployeePlatformTools = digitalEmployeeModules\.platformTools/,
    )
    // RFC-370 adds required composition fields before this catalog. Bind the
    // exact argument member instead of relying on its character distance.
    const parsed = ts.createSourceFile('start.ts', source, ts.ScriptTarget.Latest, true)
    const calls: ts.CallExpression[] = []
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'composeProviderAppComposition'
      ) {
        calls.push(node)
      }
      ts.forEachChild(node, visit)
    }
    visit(parsed)
    expect(calls).toHaveLength(1)
    const argument = calls[0]!.arguments[0]!
    expect(ts.isObjectLiteralExpression(argument)).toBe(true)
    if (!ts.isObjectLiteralExpression(argument)) throw new Error('expected app dependency object')
    const modules = argument.properties.find(
      (member) => ts.isPropertyAssignment(member) && member.name.getText(parsed) === 'modules',
    )
    if (
      !modules ||
      !ts.isPropertyAssignment(modules) ||
      !ts.isObjectLiteralExpression(modules.initializer)
    )
      throw new Error('HTTP bundles missing')
    const catalogMembers = modules.initializer.properties.filter(
      (member) =>
        ts.isPropertyAssignment(member) && member.name.getText(parsed) === 'digitalEmployee',
    )
    expect(catalogMembers).toHaveLength(1)
    expect(catalogMembers[0]!.getText(parsed)).toBe('digitalEmployee: digitalEmployeeModules')
    expect(bundle).toContain('composeDigitalEmployeeBuiltinToolCatalog({')
    expect(bundle).toContain('platformTools,')
    expect(source).toContain('const digitalEmployee = digitalEmployeeModules.module')
    expect(bootImplementation(source, 'employee-tool-catalog')).toContain(
      'await digitalEmployeePlatformTools.load()',
    )
    expectBootOrder(['employee-agent-templates', 'employee-tool-catalog'])
    // 单一实例：不允许再出现第二次组装（两份目录 = 两种真值）。
    expect(source.split('composeDigitalEmployeeBuiltinToolCatalog(').length - 1).toBe(0)
    expect(bundle.split('composeDigitalEmployeeBuiltinToolCatalog(').length - 1).toBe(1)
  })

  test('the completed HTTP composition exposes a required WorkStart port without a bind phase', async () => {
    const port: DigitalEmployeeWorkStartPort = composition.runtime.digitalEmployeeModules.workStart
    expect(Object.isFrozen(composition)).toBe(true)
    expect(Object.isFrozen(port)).toBe(true)
    // @ts-expect-error A completed WorkStart port has no mutable binding phase.
    expect(port.bind).toBeUndefined()
    expect(composition.modules.digitalEmployee.workStart).toBe(port)
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

  test('WorkStart uses the HTTP employee and repeated intake preserves the graph participant', async () => {
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
    const port = composition.runtime.digitalEmployeeModules.workStart
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
    expect(composition.modules.digitalEmployee).toBe(composition.runtime.digitalEmployeeModules)
    expect(composition.runtime.digitalEmployeeModules.workStart).toBe(port)
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
