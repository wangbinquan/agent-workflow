// RFC-317 T54 / RFC-359 W12 —— WorkStart keeps the HTTP employee instance for
// the lifetime of the daemon. RFC-359 removes the deferred bind object entirely;
// bootstrap passes complete ports whose closures resolve the completed owner.
// SQLite deliberately retains its separate OS worker; PostgreSQL has one module.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = (path: string) => readFileSync(resolve(import.meta.dir, '..', 'src', path), 'utf8')

describe('RFC-359 W12 —— WorkStart is complete at construction', () => {
  test('the integration composer no longer exports a mutable bind holder', () => {
    const integration = source('modules/integration/composition.ts')
    expect(integration).not.toContain('DeferredDigitalEmployeeWorkStart')
    expect(integration).not.toContain('DigitalEmployeeWorkStartPort | null')
  })

  test('SQLite WorkStart resolves the completed HTTP owner while OS lifecycle keeps its instance', () => {
    const sqlite = source('cli/start.ts')
    const portAt = sqlite.indexOf('const digitalEmployeeWorkStart = Object.freeze<')
    const dispatcherAt = sqlite.indexOf('const webhookDispatcher = createWebhookDispatcher(')
    const appAt = sqlite.indexOf('const appComposition: SqliteAppComposition<')
    const osAt = sqlite.indexOf('const employeeOs = composeDigitalEmployee(')
    const workerAt = sqlite.indexOf('const employeeOsRuntimeFactory =')
    expect(portAt).toBeGreaterThan(0)
    expect(dispatcherAt).toBeGreaterThan(portAt)
    expect(appAt).toBeGreaterThan(dispatcherAt)
    expect(osAt).toBeGreaterThan(appAt)
    expect(workerAt).toBeGreaterThan(osAt)
    expect(sqlite.slice(portAt, dispatcherAt)).toContain(
      'launch: (request) => appComposition.digitalEmployeeWorkStart.launch(request)',
    )
    expect(sqlite.slice(portAt, dispatcherAt)).not.toContain('employeeOs')
    expect(sqlite).toContain('const app = createComposedApp(appComposition)')
    expect(sqlite).toContain('runDigitalEmployeeOsCycle({ runtime: employeeOs.runtime.worker })')
    expect(sqlite).toContain('    employeeOsRuntimeFactory,')
    expect(sqlite).not.toContain('digitalEmployeeWorkStart.bind(')
    expect(sqlite).not.toContain('digitalEmployeeWorkStart.participant')
  })

  test('the HTTP composition exports the same employee used by its routes', () => {
    const server = source('server.ts')
    const ownerAt = server.indexOf('const digitalEmployee = composeDigitalEmployee(')
    const portAt = server.indexOf('const digitalEmployeeWorkStart = Object.freeze<', ownerAt)
    expect(ownerAt).toBeGreaterThan(0)
    expect(portAt).toBeGreaterThan(ownerAt)
    expect(server.slice(portAt, server.indexOf('const taskCatalog =', portAt))).toContain(
      'digitalEmployee.runtime.commands.launchWork({',
    )
    expect(server).toContain('digitalEmployeeWorkStart: apiComposition.digitalEmployeeWorkStart')
    expect(server).toContain('return Object.freeze({ apiRoutes, digitalEmployeeWorkStart })')
    expect(server.slice(portAt)).toMatch(
      /mountDigitalEmployeeRoutes\(\s*app,\s*digitalEmployeePersistence,\s*digitalEmployee,/,
    )
    expect(server).not.toContain('deps.digitalEmployeeWorkStart')
  })

  test('PostgreSQL resolves its one completed employee directly without a binding step', () => {
    const postgresql = source('cli/postgresqlDaemonApplication.ts')
    const portAt = postgresql.indexOf('const digitalEmployeeWorkStart = Object.freeze<')
    const ownerAt = postgresql.indexOf('const digitalEmployee = composePostgresqlDigitalEmployee(')
    expect(portAt).toBeGreaterThan(0)
    expect(ownerAt).toBeGreaterThan(portAt)
    const port = postgresql.slice(
      portAt,
      postgresql.indexOf('const webhookDeliveryRuntime', portAt),
    )
    expect(port).toContain('await digitalEmployee.runtime.commands.launchWork({')
    expect(port).toContain('eventOrigin: request.origin')
    expect(port).toContain('return { caseId: result.caseRef.id }')
    expect(postgresql).toContain('    digitalEmployee.runtime.worker,')
    expect(postgresql).not.toContain('digitalEmployeeWorkStart.bind(')
    expect(postgresql).not.toContain('digitalEmployeeWorkStart.participant')
  })
})

describe('RFC-344 —— MCP 不再拥有第二个进程级绑定入口', () => {
  test('旧 dispatch root 消失，server 只创建 direct bound operation invoker', async () => {
    const { existsSync, readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    expect(existsSync(resolve(import.meta.dir, '..', 'src', 'mcp', 'dispatch.ts'))).toBe(false)
    const server = readFileSync(resolve(import.meta.dir, '..', 'src', 'server.ts'), 'utf8')
    expect(server).toContain(
      'directMcpOperationAuthority(deps.core.identityAccess.directAuthority, actor)',
    )
    expect(server).not.toContain('app.request(')
  })
})
