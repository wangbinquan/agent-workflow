// RFC-370: check each real call argument rather than matching unrelated source text.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const load = (path: string) =>
  ts.createSourceFile(
    path,
    readFileSync(new URL('../src/' + path, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
const compact = (node: ts.Node, source: ts.SourceFile) => node.getText(source).replace(/\s/g, '')
function descendants<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T[] {
  const found: T[] = []
  const visit = (node: ts.Node) => {
    if (predicate(node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}
function namedCalls(root: ts.Node, source: ts.SourceFile, name: string) {
  return descendants(
    root,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) && compact(node.expression, source) === name,
  )
}
function objectArgument(call: ts.CallExpression): ts.ObjectLiteralExpression {
  expect(call.arguments).toHaveLength(1)
  const value = call.arguments[0]!
  if (!ts.isObjectLiteralExpression(value)) throw new Error('explicit root object required')
  const names = value.properties
    .filter((node) => ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))
    .map((node) => node.name!.getText())
  expect(new Set(names).size).toBe(names.length)
  return value
}
function property(value: ts.ObjectLiteralExpression, source: ts.SourceFile, key: string) {
  const properties = value.properties.filter(
    (node): node is ts.PropertyAssignment =>
      ts.isPropertyAssignment(node) && compact(node.name, source) === key,
  )
  expect(properties).toHaveLength(1)
  return properties[0]!.initializer
}
function oneRoot(source: ts.SourceFile, name: string) {
  const calls = namedCalls(source, source, name)
  expect(calls).toHaveLength(1)
  return objectArgument(calls[0]!)
}
function expectLexicalInput(node: ts.Node, source: ts.SourceFile, expected: string) {
  let owner: ts.Node | undefined = node.parent
  while (owner !== undefined && !ts.isFunctionDeclaration(owner)) owner = owner.parent
  if (owner === undefined || !ts.isFunctionDeclaration(owner))
    throw new Error('lexical composition owner missing')
  expect(owner.name?.text).toBe(expected)
  expect(owner.parameters.some((parameter) => compact(parameter.name, source) === 'input')).toBe(
    true,
  )
}
const fields = {
  resourcePackageSkillArtifacts: 'ResourcePackageSkillArtifactOwner',
  resourcePackagePluginArtifacts: 'ResourcePackagePluginArtifactOwner',
  resourcePackageSkillContent: 'SkillPackageContentReader',
  workspaceContent: 'WorkspaceContentEffectsFactory',
  employeeCaseWorkspaceEffects: 'EmployeeCaseWorkspaceEffectsFactory',
  repositoryBaselines: 'RepositoryBaselineEffectsFactory',
  automationWorkspaceEffects: 'AutomationWorkspaceEffectsFactory',
} as const

test('RFC-383 roots forward baselines and the three bundle consumers retain their lexical selection', () => {
  for (const [path, receiver] of [
    ['cli/start.ts', 'input'],
    ['cli/postgresqlDaemonApplication.ts', 'input'],
    ['server.ts', 'deps'],
  ] as const) {
    const source = load(path)
    for (const name of [
      'composeDaemonDigitalEmployeeModules',
      'composeDaemonDevelopmentAutomationModules',
    ]) {
      expect(compact(property(oneRoot(source, name), source, 'repositoryBaselines'), source)).toBe(
        receiver + '.repositoryBaselines',
      )
    }
  }
  for (const [path, factories, ownerName] of [
    [
      'cli/daemonModules/digitalEmployee.ts',
      ['composeDevelopmentEmployeePlatformWorkItems'],
      'composeDaemonDigitalEmployeeModules',
    ],
    [
      'cli/daemonModules/developmentAutomation.ts',
      ['composeDevelopmentAutomation', 'composeDevelopmentMissionOperations'],
      'composeDaemonDevelopmentAutomationModules',
    ],
  ] as const) {
    const source = load(path)
    for (const name of factories) {
      const calls = namedCalls(source, source, name)
      expect(calls).toHaveLength(1)
      expect(
        compact(property(objectArgument(calls[0]!), source, 'repositoryBaselines'), source),
      ).toBe('input.repositoryBaselines')
      let owner: ts.Node | undefined = calls[0]!.parent
      while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent
      expect(owner && ts.isFunctionDeclaration(owner) && owner.name?.text).toBe(ownerName)
      expectLexicalInput(calls[0]!, source, ownerName)
    }
  }
})

test('three original baseline policies receive the same selected factory at their actual call arguments', () => {
  for (const [path, name, expected] of [
    [
      'modules/development-automation/composition.ts',
      'createActionBaselineResolver',
      ['persistence.repositoryLocations', 'deps.repositoryBaselines'],
    ],
    [
      'modules/development-automation/composition/missionOperations.ts',
      'createRepositoryBaselineResolverFromLocations',
      ['persistence.repositories', 'deps.repositoryBaselines'],
    ],
    [
      'modules/development-automation/composition/digitalEmployeePlatformWorkItems.ts',
      'createGitBaselineReader',
      ['input.baselineRepoPath', 'input.baselineSha', 'input.repositoryBaselines'],
    ],
  ] as const) {
    const source = load(path)
    const calls = namedCalls(source, source, name)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.arguments.map((argument) => compact(argument, source))).toEqual([...expected])
  }
})

function forwarded(
  value: ts.ObjectLiteralExpression,
  source: ts.SourceFile,
  receiver: string,
  workspaceReceiver = receiver,
) {
  for (const key of Object.keys(fields))
    expect(compact(property(value, source, key), source)).toBe(
      `${key === 'automationWorkspaceEffects' ? workspaceReceiver : receiver}.${key}`,
    )
}

test('CLI initial and replacement sessions forward the same selected storage objects and Worker descriptor', () => {
  const source = load('cli/start.ts')
  forwarded(oneRoot(source, 'composePostgresqlDaemonApplication'), source, 'input')
  forwarded(oneRoot(source, 'composeSqliteAppDeps'), source, 'input', 'developmentWorkspaceEffects')
  const session = descendants(
    source,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && compact(node.name, source) === 'sessionInput',
  )
  expect(session).toHaveLength(1)
  const initializer = session[0]!.initializer
  if (!initializer || !ts.isCallExpression(initializer)) throw new Error('frozen session required')
  expect(compact(initializer.expression, source)).toBe('Object.freeze')
  const value = objectArgument(initializer)
  forwarded(value, source, 'opts')
  expect(compact(property(value, source, 'maintenanceEffectsBootstrap'), source)).toBe(
    'opts.maintenanceEffectsBootstrap',
  )
  const sessions = namedCalls(source, source, 'composeDaemonProviderSession')
  expect(sessions).toHaveLength(2)
  for (const call of sessions) {
    const argument = objectArgument(call)
    const spreads = argument.properties.filter(ts.isSpreadAssignment)
    expect(
      spreads.filter((node) => compact(node.expression, source) === 'sessionInput'),
    ).toHaveLength(1)
    expect(
      argument.properties.some(
        (node) => node.name && Object.hasOwn(fields, compact(node.name, source)),
      ),
    ).toBe(false)
  }
  const workers = namedCalls(source, source, 'startMaintenanceWorkerSupervisor')
  expect(workers).toHaveLength(2)
  for (const call of workers) {
    const argument = objectArgument(call)
    expect(compact(property(argument, source, 'effectsBootstrap'), source)).toBe(
      'input.maintenanceEffectsBootstrap',
    )
    expect(property(argument, source, 'databaseInit')).toBeDefined()
    expect(argument.properties.filter(ts.isSpreadAssignment)).toHaveLength(1)
  }
})

test('both actual HTTP composers select complete workspace and package owners with lazy native defaults', () => {
  for (const [path, receiver, workspaceReceiver] of [
    ['cli/postgresqlDaemonApplication.ts', 'input', 'input'],
    ['server.ts', 'effectiveDeps', 'deps'],
  ] as const) {
    const source = load(path)
    const workspace = oneRoot(source, 'composeTaskWorkspaceQueries')
    const scope = property(workspace, source, 'contentScope')
    if (!ts.isArrowFunction(scope)) throw new Error('selected scope must retain owner lifetime')
    expect(scope.parameters).toHaveLength(1)
    expect(scope.parameters[0]!.name.getText(source)).toBe('workspaceRef')
    const scopes = namedCalls(scope.body, source, 'createWorkspaceContentScope')
    expect(scopes).toHaveLength(1)
    expect(scopes[0]!.arguments.map((node) => compact(node, source))).toEqual([
      'workspaceRef',
      `${workspaceReceiver}.workspaceContent`,
    ])
    let owner: ts.Node | undefined = scopes[0]!.parent
    while (owner !== undefined && !ts.isFunctionDeclaration(owner)) owner = owner.parent
    if (owner === undefined || !ts.isFunctionDeclaration(owner))
      throw new Error('workspace binding must have an actual composition owner')
    expect(owner.parameters.map((parameter) => compact(parameter.name, source))).toContain(
      workspaceReceiver,
    )

    const packages = oneRoot(source, 'composePostgresqlResourcePackageProvider')
    expect(compact(property(packages, source, 'skillArtifacts'), source)).toBe(
      `${receiver}.resourcePackageSkillArtifacts`,
    )
    expect(compact(property(packages, source, 'skillPackageContent'), source)).toBe(
      `${receiver}.resourcePackageSkillContent`,
    )
    const spreads = packages.properties.filter(ts.isSpreadAssignment)
    expect(spreads).toHaveLength(1)
    const selection = spreads[0]!.expression
    if (
      !ts.isParenthesizedExpression(selection) ||
      !ts.isConditionalExpression(selection.expression)
    )
      throw new Error('native package construction must stay inside its lazy branch')
    const choice = selection.expression
    expect(compact(choice.condition, source)).toBe(
      `${receiver}.resourcePackagePluginArtifacts===undefined`,
    )
    if (
      !ts.isObjectLiteralExpression(choice.whenTrue) ||
      !ts.isObjectLiteralExpression(choice.whenFalse)
    )
      throw new Error('complete selected and native owner branches required')
    expect(choice.whenTrue.properties).toHaveLength(1)
    expect(choice.whenFalse.properties).toHaveLength(1)
    expect(property(choice.whenTrue, source, 'pluginInstaller')).toBeDefined()
    expect(compact(property(choice.whenFalse, source, 'pluginArtifacts'), source)).toBe(
      `${receiver}.resourcePackagePluginArtifacts`,
    )
    expect(
      namedCalls(choice.whenFalse, source, 'createResourcePackagePluginInstaller'),
    ).toHaveLength(0)
  }
})

test('RFC-383 one employee case participant supplies workspace and platform work items', () => {
  for (const [path, receiver] of [
    ['cli/start.ts', 'input'],
    ['cli/postgresqlDaemonApplication.ts', 'input'],
    ['server.ts', 'deps'],
  ] as const) {
    const source = load(path)
    const root = oneRoot(source, 'composeDaemonDigitalEmployeeModules')
    expect(compact(root, source)).toContain(
      `employeeCaseWorkspaceEffects:${receiver}.employeeCaseWorkspaceEffects`,
    )
    expect(namedCalls(source, source, 'bindEmployeeCaseWorkspaceParticipant')).toHaveLength(0)
  }
  const source = load('cli/daemonModules/digitalEmployee.ts')
  const calls = namedCalls(source, source, 'bindEmployeeCaseWorkspaceParticipant')
  expect(calls).toHaveLength(1)
  expectLexicalInput(calls[0]!, source, 'composeDaemonDigitalEmployeeModules')
  expect(compact(property(objectArgument(calls[0]!), source, 'effects'), source)).toBe(
    'input.adapters?.employeeCaseWorkspaceEffects',
  )
  expect(compact(oneRoot(source, 'composeDevelopmentEmployeeWorkspace'), source)).toContain(
    'sourceControl,',
  )
  expect(compact(oneRoot(source, 'composeDevelopmentEmployeePlatformWorkItems'), source)).toContain(
    '...sourceControl,',
  )
})

test('all three original checkpoint consumers await the selected receipt before their next owner statement', () => {
  for (const [path, expression, count] of [
    [
      'modules/development-automation/composition/digitalEmployeeWorkspace.ts',
      'sourceControl.checkpoint',
      2,
    ],
    [
      'modules/development-automation/composition/digitalEmployeePlatformWorkItems.ts',
      'workspaceOps.checkpoint',
      1,
    ],
  ] as const) {
    const source = load(path)
    const calls = namedCalls(source, source, expression)
    expect(calls).toHaveLength(count)
    for (const call of calls) {
      expect(ts.isAwaitExpression(call.parent)).toBe(true)
      expect(ts.isVariableDeclaration(call.parent.parent)).toBe(true)
      expect(compact((call.parent.parent as ts.VariableDeclaration).name, source)).toBe(
        'checkpoint',
      )
    }
  }
})

test('public root types expose existing complete contracts without adding partial callback ports', () => {
  for (const [path, names] of [
    ['cli/start.ts', ['StartOptions', 'DaemonProviderSessionComposeInput']],
    ['cli/postgresqlDaemonApplication.ts', ['PostgresqlDaemonApplicationInput']],
    ['server.ts', ['AppDeps']],
  ] as const) {
    const source = load(path)
    for (const name of names) {
      const interfaces = source.statements.filter(
        (node): node is ts.InterfaceDeclaration =>
          ts.isInterfaceDeclaration(node) && node.name.text === name,
      )
      expect(interfaces).toHaveLength(1)
      const expected =
        path === 'cli/start.ts'
          ? { ...fields, maintenanceEffectsBootstrap: 'MaintenanceWorkerEffectsDescriptor' }
          : fields
      for (const [key, type] of Object.entries(expected)) {
        const members = interfaces[0]!.members.filter((node) => node.name?.getText(source) === key)
        expect(members).toHaveLength(1)
        const member = members[0]!
        if (!ts.isPropertySignature(member)) throw new Error('complete optional port type required')
        expect(member.questionToken).toBeDefined()
        expect(member.type?.getText(source)).toBe(type)
      }
    }
  }
})

test('RFC-383 workspace selection reaches the three shared consumers and the HTTP fallback', () => {
  for (const [path, receiver] of [
    ['cli/start.ts', 'input'],
    ['cli/postgresqlDaemonApplication.ts', 'input'],
    ['server.ts', 'deps'],
  ] as const) {
    const source = load(path),
      selection = oneRoot(source, 'selectDevelopmentWorkspaceEffectBinding')
    expect(compact(property(selection, source, 'automationWorkspaceEffects'), source)).toBe(
      receiver + '.automationWorkspaceEffects',
    )
    expect(compact(property(selection, source, 'actionWorkspaceEffects'), source)).toBe(
      receiver + '.actionWorkspaceEffects',
    )
    expect(compact(property(selection, source, 'conflictWorkspaceSelected'), source)).toBe(
      receiver + '.conflictMergeWorkspaceEffects!==undefined',
    )
    for (const name of [
      'composeDaemonDigitalEmployeeModules',
      'composeDaemonDevelopmentAutomationModules',
    ]) {
      expect(compact(property(oneRoot(source, name), source, 'workspaceEffects'), source)).toBe(
        'developmentWorkspaceEffects',
      )
    }
    if (path === 'server.ts') {
      const variables = descendants(source, ts.isVariableDeclaration)
      const variable = (name: string) => {
        const found = variables.filter((n) => compact(n.name, source) === name)
        expect(found).toHaveLength(1)
        return found[0]!
      }
      expect(compact(variable('runtimeDeps').initializer!, source)).toContain(
        '...developmentWorkspaceEffects,',
      )
      expect(compact(variable('effectiveDeps').initializer!, source)).toContain('...runtimeDeps,')
      const mounts = namedCalls(source, source, 'composeSqliteApiRouteMounts')
      expect(mounts).toHaveLength(1)
      expect(compact(mounts[0]!.arguments[0]!, source)).toBe('effectiveDeps')
    }
  }
  for (const [path, names] of [
    [
      'cli/daemonModules/digitalEmployee.ts',
      ['composeDevelopmentEmployeeWorkspace', 'composeDevelopmentEmployeePlatformWorkItems'],
    ],
    ['cli/daemonModules/developmentAutomation.ts', ['composeDevelopmentAutomation']],
  ] as const) {
    const source = load(path)
    for (const name of names) {
      const call = oneRoot(source, name)
      expectLexicalInput(
        call,
        source,
        path.endsWith('/digitalEmployee.ts')
          ? 'composeDaemonDigitalEmployeeModules'
          : 'composeDaemonDevelopmentAutomationModules',
      )
      expect(compact(property(call, source, 'automationWorkspaceEffects'), source)).toBe(
        'input.workspaceEffects.automationWorkspaceEffects',
      )
    }
  }
})

test('both real maintenance Worker composers bind the selected recovery content without moving their database owner', () => {
  const source = load('platform/background/maintenanceWorker.ts')
  for (const name of [
    'composePostgresqlResourcePackageApplyMaintenance',
    'composeSqliteResourcePackageApplyMaintenance',
  ]) {
    const call = oneRoot(source, name)
    expect(compact(property(call, source, 'recoveryEffectsFactory'), source)).toBe(
      'workerEffects?.resourcePackageRecoveryContent',
    )
    expect(compact(property(call, source, 'artifacts'), source)).toBe(
      'workerEffects?.resourcePackageRecovery',
    )
    expect(property(call, source, 'db')).toBeDefined()
  }
})
