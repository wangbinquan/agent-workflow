// RFC-370: real roots must select every actual owner exactly once; embedded
// keeps its own request-driven inventory rather than manufacturing a daemon.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = (name: string) =>
  ts.createSourceFile(
    name,
    readFileSync(new URL('../src/' + name, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
function declared(file: ts.SourceFile, name: string) {
  const declaration = file.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  )
  if (!declaration?.body) throw new Error('real root declaration missing: ' + name)
  return declaration
}
function calls(file: ts.SourceFile, root: ts.Node, name: string) {
  const result: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === name) result.push(node)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return result
}

// RFC-371 v2 retired the observation report owner; eighteen owners remain.
test('the full daemon roster contains eighteen concrete owner selections, with no duplicate or omission', () => {
  const file = source('cli/daemonHostExecutionOwners.ts'),
    root = declared(file, 'bindDaemonHostOwners')
  const selected = calls(file, root, 'Object.freeze')[0]?.arguments[0]
  if (!selected || !ts.isArrayLiteralExpression(selected))
    throw new Error('actual owner roster missing')
  const actual = selected.elements.map((node) =>
    ts.isCallExpression(node)
      ? [node.expression.getText(file), node.arguments[0]?.getText(file)]
      : ['not-owner', ''],
  )
  expect(actual).toEqual([
    ['bindIntentQueuedHostOwner', 'input.intent'],
    ['bindTaskExecutionHostOwner', 'input.task'],
    ['bindMaintenanceHostOwner', 'input.maintenance'],
    ['bindMcpDiagnosticsHostOwner', 'input.mcp'],
    ['bindWebhookTerminalHostOwner', 'input.webhook'],
    ['bindAfterCommitHostOwner', 'input.afterCommit'],
    ['bindResourceLimitsHostOwner', 'input.limits'],
    ['bindTaskIdleTimeoutHostOwner', 'input.idle'],
    ['bindScheduledBackupHostOwner', 'input.backup'],
    ['bindSubmoduleRefreshHostOwner', 'input.submodules'],
    ['bindBatchImportGcHostOwner', 'input.importGc'],
    ['bindHumanGateContinuationHostOwner', 'input.humanGate'],
    ['bindCommittedEventHostOwner', 'input.committed'],
    ['bindMemoryDistillHostOwner', 'input.memory'],
    ['bindDevelopmentWakeHostOwner', 'input.development'],
    ['bindDigitalEmployeeHostOwner', 'input.employee'],
    ['bindEventCenterHostOwner', 'input.events'],
    ['bindFusionReconcileHostOwner', 'input.fusion'],
  ])
})

test('both daemon provider roots install that same selected roster on the actual session', () => {
  const file = source('cli/start.ts')
  for (const name of ['composeSqliteProviderSession', 'composePostgresqlProviderSession']) {
    const root = declared(file, name)
    expect(calls(file, root, 'bindDaemonHostOwners')).toHaveLength(1)
    expect(calls(file, root, '_createComposedDaemonProviderRuntimeSession')).toHaveLength(1)
    const session = calls(file, root, '_createComposedDaemonProviderRuntimeSession')[0]!
      .arguments[0]!.getText(file)
      .replace(/\s/g, '')
    expect(session).toContain('hostExecutionRuntime:{handles:hostOwners}')
    expect(calls(file, root, 'installDaemonHostExecutionSession')).toHaveLength(1)
  }
})

test('the actual embedded root selects its Task/Intent/MCP and supplied webhook owners', () => {
  const file = source('cli/embeddedHostExecutionApplication.ts'),
    root = declared(file, 'composeEmbeddedHostExecutionApplication')
  expect(calls(file, root, 'bindDaemonHostOwners')).toHaveLength(0)
  for (const name of [
    'bindEmbeddedTaskHostOwner',
    'bindEmbeddedIntentHostOwner',
    'bindMcpDiagnosticsHostOwner',
    'bindWebhookTerminalHostOwner',
  ])
    expect(calls(file, root, name)).toHaveLength(1)
  expect(calls(file, root, 'bindObservationReportsHostOwner')).toHaveLength(0)
  expect(calls(file, root, 'createDaemonProviderRuntimeSession')).toHaveLength(1)
  expect(calls(file, root, 'installDaemonHostExecutionSession')).toHaveLength(1)
  expect(calls(file, root, 'resumeDaemonResourcesForServing')).toHaveLength(1)
})
