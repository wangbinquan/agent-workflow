import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

import { plugins } from '@/db/schema'
import type { PluginInstallerPort } from '@/modules/resource-catalog/composition/pluginOperations'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'

const load = (path: string) =>
  ts.createSourceFile(
    path,
    readFileSync(new URL('../src/' + path, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
function calls(source: ts.SourceFile, expression: string) {
  const result: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === expression)
      result.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

test('the complete plugin installer receiver reaches the real startup and HTTP catalogs', () => {
  for (const [path, receiver] of [
    ['cli/start.ts', 'input'],
    ['cli/postgresqlDaemonApplication.ts', 'input'],
    ['server.ts', 'effectiveDeps'],
  ] as const) {
    const source = load(path)
    const catalogs = calls(source, 'composePluginCatalog')
    expect(catalogs).toHaveLength(1)
    const argument = catalogs[0]!.arguments[0]!
    expect(ts.isObjectLiteralExpression(argument)).toBe(true)
    if (!ts.isObjectLiteralExpression(argument)) throw new Error('catalog root is missing')
    const bindings = argument.properties.filter(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) && p.name.getText(source) === 'installer',
    )
    expect(bindings).toHaveLength(1)
    expect(bindings[0]!.initializer.getText(source)).toBe(`${receiver}.pluginInstaller`)
  }
  const composition = load('modules/resource-catalog/composition/pluginOperations.ts')
  const defaults = calls(composition, 'createLocalPluginInstaller')
  expect(defaults).toHaveLength(1)
  const selection = defaults[0]!.parent
  expect(ts.isBinaryExpression(selection)).toBe(true)
  if (!ts.isBinaryExpression(selection)) throw new Error('installer selection is missing')
  expect(selection.left.getText(composition)).toBe('input.installer')
  expect(selection.operatorToken.kind).toBe(ts.SyntaxKind.QuestionQuestionToken)
  const start = load('cli/start.ts')
  expect(start.text).toContain('pluginInstaller: opts.pluginInstaller,')
  for (const expression of ['composePostgresqlDaemonApplication', 'composeSqliteAppDeps']) {
    const roots = calls(start, expression)
    expect(roots).toHaveLength(1)
    const argument = roots[0]!.arguments[0]!
    expect(ts.isObjectLiteralExpression(argument)).toBe(true)
    if (!ts.isObjectLiteralExpression(argument)) throw new Error('provider root is missing')
    const bindings = argument.properties.filter(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) && property.name.getText(start) === 'pluginInstaller',
    )
    expect(bindings).toHaveLength(1)
    expect(bindings[0]!.initializer.getText(start)).toBe('input.pluginInstaller')
  }
  expect(start.text).toContain('readonly pluginInstaller?: PluginInstallerPort')
  expect(start.text).toContain('...sessionInput,')
})

class SelectedInstaller implements PluginInstallerPort {
  #installs = 0
  readonly entered = Promise.withResolvers<void>()
  readonly ready = Promise.withResolvers<void>()
  readonly checkEntered = Promise.withResolvers<void>()
  readonly checkReady = Promise.withResolvers<void>()
  readonly installed: Array<{ id: string; spec: string }> = []
  readonly checked: Array<{ id: string; spec: string; cachedPath: string }> = []
  cleanups = 0
  constructor(readonly outcome: 'installed' | 'failure') {}
  get installs() {
    return this.#installs
  }
  async install(pluginId: string, spec: string) {
    this.#installs += 1
    this.installed.push({ id: pluginId, spec })
    this.entered.resolve()
    await this.ready.promise
    if (this.outcome === 'failure') throw new Error('selected-plugin-install-unavailable')
    return {
      sourceKind: 'npm' as const,
      cachedPath: `artifact:plugin/${pluginId}/g1`,
      resolvedVersion: '9.1.0',
      cleanup: async () => {
        this.cleanups += 1
      },
    }
  }
  async checkForUpdate(pluginId: string, spec: string, currentCachedPath: string) {
    this.checked.push({ id: pluginId, spec, cachedPath: currentCachedPath })
    this.checkEntered.resolve()
    await this.checkReady.promise
    return { available: false, latest: '9.1.0', identityStatus: 'known' as const }
  }
}

describeEachProviderHttpApplication(
  'RFC-370 selected plugin installer at actual HTTP roots',
  {
    token: 'f'.repeat(64),
    dbVersion: 17,
    opencodeVersion: null,
    tempPrefix: 'aw-rfc370-plugin-root-',
  },
  (scope) => {
    for (const outcome of ['installed', 'failure'] as const) {
      test(`catalog waits for selected prototype install ACK and preserves ${outcome} publication`, async () => {
        const selected = new SelectedInstaller(outcome)
        expect(Object.hasOwn(selected, 'install')).toBe(false)
        expect(Object.hasOwn(selected, 'checkForUpdate')).toBe(false)
        const { app, appHome } = await scope.open({ pluginInstaller: selected })
        const before = await scope.harness.db.select().from(plugins)
        const headers = {
          Authorization: `Bearer ${'f'.repeat(64)}`,
          'content-type': 'application/json',
        }
        let settled = false
        const pending = Promise.resolve(
          app.request('/api/plugins', {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: `selected-${outcome}`, spec: 'pkg@9.1.0' }),
          }),
        ).finally(() => {
          settled = true
        })
        try {
          await Promise.race([
            selected.entered.promise,
            pending.then(async (response) => {
              throw new Error(
                `selected install ACK missed: ${response.status} ${await response.clone().text()}`,
              )
            }),
          ])
          expect(settled).toBe(false)
          expect(selected.installs).toBe(1)
          expect(await scope.harness.db.select().from(plugins)).toEqual(before)
          selected.ready.resolve()
          const response = await pending
          if (outcome === 'installed') {
            expect(response.status).toBe(201)
            const created = (await response.json()) as {
              id: string
              operationConfigHash: string
              name: string
              resolvedVersion: string | null
            }
            expect(created).toMatchObject({ name: 'selected-installed', resolvedVersion: '9.1.0' })
            const rows = await scope.harness.db.select().from(plugins)
            const published = rows.filter((row) => !before.some((old) => old.id === row.id))
            expect(published).toHaveLength(1)
            const cachedPath = `artifact:plugin/${created.id}/g1`
            expect(published[0]).toMatchObject({
              id: created.id,
              spec: 'pkg@9.1.0',
              cachedPath,
              sourceKind: 'npm',
              resolvedVersion: '9.1.0',
            })
            expect(selected.installed).toEqual([{ id: created.id, spec: 'pkg@9.1.0' }])
            let checked = false
            const checking = Promise.resolve(
              app.request(`/api/plugins/${created.id}/check-update`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ expectedConfigHash: created.operationConfigHash }),
              }),
            ).finally(() => {
              checked = true
            })
            try {
              await Promise.race([
                selected.checkEntered.promise,
                checking.then(async (result) => {
                  throw new Error(
                    `selected update ACK missed: ${result.status} ${await result.clone().text()}`,
                  )
                }),
              ])
              expect(checked).toBe(false)
              expect(selected.checked).toEqual([{ id: created.id, spec: 'pkg@9.1.0', cachedPath }])
              selected.checkReady.resolve()
              const result = await checking
              expect(result.status).toBe(200)
              expect(await result.json()).toMatchObject({
                available: false,
                current: '9.1.0',
                latest: '9.1.0',
                identityStatus: 'known',
                configHashUsed: created.operationConfigHash,
              })
            } finally {
              selected.checkReady.resolve()
              await checking
            }
          } else {
            expect(response.status).toBe(500)
            expect(await scope.harness.db.select().from(plugins)).toEqual(before)
          }
          expect(selected.cleanups).toBe(0)
          expect(existsSync(join(appHome, 'plugins'))).toBe(false)
        } finally {
          selected.ready.resolve()
          selected.checkReady.resolve()
          await pending
        }
      }, 20_000)
    }
  },
)
