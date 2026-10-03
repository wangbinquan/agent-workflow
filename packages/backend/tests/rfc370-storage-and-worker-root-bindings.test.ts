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
const fields = {
  resourcePackageSkillArtifacts: 'ResourcePackageSkillArtifactOwner',
  resourcePackagePluginArtifacts: 'ResourcePackagePluginArtifactOwner',
  resourcePackageSkillContent: 'SkillPackageContentReader',
  workspaceContent: 'WorkspaceContentEffectsFactory',
  employeeCaseWorkspaceEffects: 'EmployeeCaseWorkspaceEffectsFactory',
  repositoryBaselines: 'RepositoryBaselineEffectsFactory',
} as const

test('all eight actual baseline owners forward the selected factory from their lexical root parameter', () => {
  for (const [path, roots, receiver, owners] of [
    [
      'cli/start.ts',
      ['composeDevelopmentAutomation', 'composeDevelopmentEmployeePlatformWorkItems'],
      'input',
      ['composeSqliteProviderSession', 'composeSqliteProviderSession'],
    ],
    [
      'cli/postgresqlDaemonApplication.ts',
      [
        'composeDevelopmentAutomation',
        'composeDevelopmentEmployeePlatformWorkItems',
        'composeDevelopmentMissionOperations',
      ],
      'input',
      [
        'composePostgresqlApplication',
        'composePostgresqlApplication',
        'composePostgresqlApplication',
      ],
    ],
    [
      'server.ts',
      [
        'composeDevelopmentAutomation',
        'composeDevelopmentEmployeePlatformWorkItems',
        'composeDevelopmentMissionOperations',
      ],
      'deps',
      [
        'composeFallbackDevelopmentAutomation',
        'composeSqliteApiRouteMounts',
        'composeSqliteApplicationDeps',
      ],
    ],
  ] as const) {
    const source = load(path)
    for (const [index, root] of roots.entries()) {
      const calls = namedCalls(source, source, root)
      expect(calls).toHaveLength(1)
      const call = calls[0]!
      expect(compact(property(objectArgument(call), source, 'repositoryBaselines'), source)).toBe(
        `${receiver}.repositoryBaselines`,
      )
      let owner: ts.Node | undefined = call.parent
      while (owner !== undefined && !ts.isFunctionDeclaration(owner)) owner = owner.parent
      if (owner === undefined || !ts.isFunctionDeclaration(owner))
        throw new Error('baseline lexical root missing')
      expect(owner.name?.text).toBe(owners[index])
      expect(owner.parameters.some((param) => compact(param.name, source) === receiver)).toBe(true)
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

function forwarded(value: ts.ObjectLiteralExpression, source: ts.SourceFile, receiver: string) {
  for (const key of Object.keys(fields))
    expect(compact(property(value, source, key), source)).toBe(`${receiver}.${key}`)
}

test('CLI initial and replacement sessions forward the same selected storage objects and Worker descriptor', () => {
  const source = load('cli/start.ts')
  forwarded(oneRoot(source, 'composePostgresqlDaemonApplication'), source, 'input')
  forwarded(oneRoot(source, 'composeSqliteAppDeps'), source, 'input')
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

test('all six actual EmployeeCase binders receive the factory declared by their composition owner', () => {
  for (const [path, receiver, ownerName] of [
    ['cli/start.ts', 'input', 'composeSqliteProviderSession'],
    ['cli/postgresqlDaemonApplication.ts', 'input', 'composePostgresqlApplication'],
    ['server.ts', 'deps', 'composeSqliteApiRouteMounts'],
  ] as const) {
    const source = load(path)
    const calls = namedCalls(source, source, 'bindEmployeeCaseWorkspaceParticipant')
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(compact(property(objectArgument(call), source, 'effects'), source)).toBe(
        `${receiver}.employeeCaseWorkspaceEffects`,
      )
      let owner: ts.Node | undefined = call.parent
      while (owner !== undefined && !ts.isFunctionDeclaration(owner)) owner = owner.parent
      if (owner === undefined || !ts.isFunctionDeclaration(owner))
        throw new Error('EmployeeCase binder must have an actual composition owner')
      expect(owner.name?.text).toBe(ownerName)
      expect(owner.parameters.map((parameter) => compact(parameter.name, source))).toContain(
        receiver,
      )
    }
  }
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
