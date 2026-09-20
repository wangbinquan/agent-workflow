// RFC-364: root bindings are explicit and retain W29's ordered lifecycle graph.
import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
const root = resolve(import.meta.dir, '../src')
function parse(path: string) {
  return ts.createSourceFile(
    path,
    readFileSync(resolve(root, path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
}
function nodes(source: ts.SourceFile, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const result: ts.Node[] = []
  const visit = (node: ts.Node) => {
    if (predicate(node)) result.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}
const compact = (node: ts.Node, source: ts.SourceFile) => node.getText(source).replace(/\s/g, '')
describe('RFC-364 production bindings', () => {
  test('module-private lease and registry inspection contracts are not offered publicly', () => {
    const participants = parse('modules/resource-catalog/public/participants.ts')
    expect(participants.text).not.toContain('McpRuntimeTestLeaseError')
    expect(participants.text).not.toContain('McpRuntimeTestLeaseOperations')
    expect(parse('modules/runtime-management/public/queries.ts').text).not.toContain(
      'RuntimeProfileInspectionQueries',
    )
    expect(parse('modules/resource-catalog/application/mcps/runtimeDiagnostics.ts').text).toContain(
      "from '../ports/mcpRuntimeTestLease'",
    )
  })

  for (const path of ['server.ts', 'cli/start.ts', 'cli/postgresqlDaemonApplication.ts']) {
    test(
      path + ' binds one cold diagnostics instance to the same coordinator and admitted catalog',
      () => {
        const source = parse(path)
        const calls = nodes(
          source,
          (node) =>
            ts.isCallExpression(node) &&
            compact(node.expression, source).includes('composeMcpDiagnostics'),
        )
        expect(calls).toHaveLength(1)
        const call = calls[0]!
        expect(ts.isCallExpression(call)).toBe(true)
        if (!ts.isCallExpression(call)) throw new Error('expected diagnostics call')
        const input = call.arguments[0]!
        expect(ts.isObjectLiteralExpression(input)).toBe(true)
        if (!ts.isObjectLiteralExpression(input)) throw new Error('expected diagnostics input')
        const property = (name: string) =>
          input.properties.find((p) => p.name?.getText(source) === name)
        expect(compact(property('coordinator')!, source)).toBe(
          'coordinator:mcpOperationCoordinator',
        )
        expect(compact(property('isRuntimeEligible')!, source)).toBe(
          'isRuntimeEligible:isRuntimeMcpTestEligible',
        )
        expect(compact(property('requestBinding')!, source)).toBe(
          'requestBinding:{contexts:identityAccess.contexts,directAuthority:identityAccess.directAuthority,' +
            'loadVisibleMcp:(authority,id)=>mcpCatalog.queries.get(authority,{id}),}',
        )
        expect(source.text).not.toContain('getMcpRuntimeTestService')
        if (path === 'server.ts')
          expect(compact(call, source)).toStartWith(
            '(unstarted?.createMcpRuntimeTests??composeMcpDiagnostics)(',
          )
        if (path === 'cli/postgresqlDaemonApplication.ts')
          expect(compact(call, source)).toStartWith(
            "(phase.kind==='daemon'?composeMcpDiagnostics:phase.scope.createMcpRuntimeTests)(",
          )
      },
    )
  }
  for (const path of ['server.ts', 'cli/postgresqlDaemonApplication.ts']) {
    test(
      path + ' shares the same commands, queries, contexts and narrow reconciliation object',
      () => {
        const source = parse(path)
        const bindings = nodes(
          source,
          (node) => ts.isPropertyAssignment(node) && node.name.getText(source) === 'runtimeTests',
        ).map((node) => compact(node, source))
        expect(bindings).toEqual([
          'runtimeTests:mcpRuntimeTests.reconciliation',
          'runtimeTests:mcpRuntimeTests.reconciliation',
          'runtimeTests:{commands:mcpRuntimeTests.commands,queries:mcpRuntimeTests.queries}',
        ])
        for (const [name, expected] of [
          ['runtimeTestCommandContextFor', 'command'],
          ['runtimeTestQueryContextFor', 'query'],
        ]) {
          const binding = nodes(
            source,
            (node) => ts.isPropertyAssignment(node) && node.name.getText(source) === name,
          )
          expect(binding.map((node) => compact(node, source))).toEqual([
            name + ':mcpRuntimeTests.contexts.' + expected,
          ])
        }
      },
    )
  }
  test('diagnostics HTTP handlers only decode, call and map; service facades are retired', () => {
    const source = parse('routes/mcps.ts')
    const calls = nodes(
      source,
      (node) => ts.isCallExpression(node) && compact(node.expression, source) === 'registerRoute',
    ).filter((node) => node.getText(source).includes("path: '/api/mcps/:id/runtime-test"))
    expect(calls).toHaveLength(7)
    for (const call of calls) {
      expect(call.getText(source)).not.toContain('runExclusive')
      expect(call.getText(source)).not.toContain('loadVisibleMcp')
      expect(call.getText(source)).toContain('runtimeTests.')
    }
    expect(existsSync(resolve(root, 'services/mcpRuntimeTest.ts'))).toBe(false)
    expect(existsSync(resolve(root, 'services/mcpRuntimeTestLease.ts'))).toBe(false)
    const composition = parse('modules/resource-catalog/composition/mcpDiagnostics.ts')
    expect(composition.text).not.toMatch(/WeakMap|SERVICE_INSTANCES/)
  })
})
