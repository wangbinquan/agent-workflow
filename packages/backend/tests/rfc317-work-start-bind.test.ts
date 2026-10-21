import { readDaemonGraphSource } from './helpers/daemonGraphSource'
// RFC-317 / RFC-383: reverses RFC-359 W12's deliberate separate SQLite OS instance.
// HTTP, work-start and the OS worker use one initialized employee bundle per session.
import { DAEMON_BACKGROUND_JOBS } from '../src/cli/daemonLifecycleProgram'
import { propertyBodies } from './helpers/daemonProgramSource'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const source = (path: string) =>
  path === 'cli/start.ts'
    ? readDaemonGraphSource()
    : readFileSync(resolve(import.meta.dir, '..', 'src', path), 'utf8')
describe('RFC-383 single employee and lexical work-start forwarding', () => {
  test('the integration composer has no mutable bind holder', () => {
    const integration = source('modules/integration/composition.ts')
    expect(integration).not.toContain('DeferredDigitalEmployeeWorkStart')
    expect(integration).not.toContain('DigitalEmployeeWorkStartPort | null')
  })
  for (const path of ['cli/start.ts', 'bootstrap/daemonApplication.ts']) {
    test(`${path}: the integration forwarder resolves the one completed employee bundle`, () => {
      const root = source(path)
      const portAt = root.indexOf('const digitalEmployeeWorkStart = Object.freeze<')
      const integrationAt = root.indexOf(
        'const integrationModules = composeDaemonIntegrationModules(',
      )
      const employeeAt = root.indexOf(
        'const digitalEmployeeModules = composeDaemonDigitalEmployeeModules(',
      )
      const automationAt = root.indexOf(
        'const developmentAutomationModules = composeDaemonDevelopmentAutomationModules(',
      )
      expect(portAt).toBeGreaterThan(0)
      expect(integrationAt).toBeGreaterThan(portAt)
      expect(employeeAt).toBeGreaterThan(integrationAt)
      expect(automationAt).toBeGreaterThan(employeeAt)
      expect(root.slice(portAt, integrationAt)).toContain(
        'launch: (request) => digitalEmployeeModules.workStart.launch(request)',
      )
      expect(root).not.toContain('composeDigitalEmployee(')
      expect(root).not.toContain('digitalEmployeeWorkStart.bind(')
      expect(root).not.toContain('digitalEmployeeWorkStart.participant')
    })
  }
  test('application passes both bundles to HTTP and the session registers their OS worker', () => {
    const root = source('bootstrap/daemonApplication.ts')
    const session = source('bootstrap/daemonSession.ts')
    const bundleAt = root.indexOf(
      'const digitalEmployeeModules = composeDaemonDigitalEmployeeModules(',
    )
    const appAt = root.indexOf('const http = composeProviderAppComposition({')
    expect(appAt).toBeGreaterThan(bundleAt)
    expect(root.slice(appAt)).toContain('digitalEmployee: digitalEmployeeModules,')
    expect(root.slice(appAt)).toContain('developmentAutomation: developmentAutomationModules,')
    expect(
      session.indexOf('const employeeRuntime = runtime.digitalEmployee.runtime'),
    ).toBeGreaterThan(session.indexOf('const application = await composeDaemonApplication('))
    expect(session).toContain('runDigitalEmployeeOsCycle({ runtime: employeeRuntime.worker })')
    expect(DAEMON_BACKGROUND_JOBS.filter((j) => j.id === 'digital-employee-os')).toHaveLength(1)
    const records = propertyBodies(session, 'backgroundJobs')
    expect(records).toHaveLength(1)
    expect(records[0]).toContain("'digital-employee-os': digitalEmployeeRuntimeFactory")
  })
  test('HTTP and work-start consume the same module and its activity worker', () => {
    const server = source('server.ts'),
      http = source('bootstrap/daemonHttpComposition.ts'),
      graph = source('bootstrap/daemonApplication.ts'),
      bundle = source('cli/daemonModules/digitalEmployee.ts')
    expect(http).toContain('const digitalEmployee = digitalEmployeeModules.module')
    expect(graph).toContain('launch: (request) => digitalEmployeeModules.workStart.launch(request)')
    expect(http).toContain(
      'const developmentActivityOperations = digitalEmployeeModules.activityOperations',
    )
    expect(server).toMatch(
      /mountDigitalEmployeeRoutes\(\s*app,\s*input.digitalDevelopment.digitalEmployees.persistence,\s*input.digitalDevelopment.digitalEmployees.module,/,
    )
    expect(bundle).toContain('await module.runtime.commands.launchWork({')
    expect(bundle).toContain('eventOrigin: request.origin')
    expect(bundle).toContain('return { caseId: result.caseRef.id }')
    expect(bundle).toContain('composeDevelopmentActivityOperations(module.runtime.worker)')
    expect(http).not.toContain('trackReady(digitalEmployee.maintenance.ready())')
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
