// RFC-394: lock the single deployment contract, its neutral consumers and exhaustive forwarding.
import { expect, test } from 'bun:test'
import ts from 'typescript'
import { resolve } from 'node:path'
import { backendUnits, sourceUnit, type SourceUnit } from './census'

const PREFIX = 'packages/backend/src/'
const PROFILE = PREFIX + 'bootstrap/deploymentProfile.ts'
const START = PREFIX + 'bootstrap/daemonStart.ts'
const SESSION = PREFIX + 'bootstrap/daemonSession.ts'
const APPLICATION = PREFIX + 'bootstrap/daemonApplication.ts'
const INPUT = PREFIX + 'bootstrap/daemonSessionInput.ts'
const KEYS = PREFIX + 'bootstrap/deploymentSelections.ts'
const MAIN = PREFIX + 'main.ts'
const RETIRED = [
  'StartOptions',
  'composeDeploymentStartOptions',
  'composeCrewStationStartOptions',
  'admitSelections',
  'standaloneSelectionsOf',
  'HOSTED_ONLY_SELECTIONS',
  'executionHost',
  'DaemonProviderSessionComposer',
]
// Only startup-derived values may strengthen a selection from optional to required.
const REQUIRED_OVERRIDES = {
  DaemonProviderSessionComposeInput: [
    'applicationConfiguration',
    'runtimeLegacyConfiguration',
    'workspaceUploads',
    'isolationWorkspaces',
    'repositoryGitWorkspaces',
    'workspaceReads',
    'secretBox',
  ],
  DaemonApplicationInput: ['applicationConfiguration', 'secretBox'],
} as const
function descendants<T extends ts.Node>(root: ts.Node, match: (node: ts.Node) => node is T): T[] {
  const found: T[] = []
  const visit = (node: ts.Node) => {
    if (match(node)) found.push(node)
    node.forEachChild(visit)
  }
  visit(root)
  return found
}
const compact = (node: ts.Node) => node.getText().replace(/\s/g, '')
const calls = (root: ts.Node, name: string) =>
  descendants(root, ts.isCallExpression).filter((node) => node.expression.getText() === name)
const declarations = (units: readonly SourceUnit[], name: string) =>
  units.flatMap((unit) =>
    descendants(unit.source, ts.isInterfaceDeclaration)
      .filter((node) => node.name.text === name)
      .map((node) => ({ unit, node })),
  )
export function deploymentProfileViolations(units: readonly SourceUnit[]): string[] {
  const errors: string[] = []
  const get = (path: string) => units.find((unit) => unit.path === path)?.source
  for (const path of [PROFILE, START, SESSION, APPLICATION, INPUT, KEYS, MAIN])
    if (!get(path)) errors.push('missing source: ' + path)
  for (const unit of units) {
    for (const identifier of descendants(unit.source, ts.isIdentifier))
      if (RETIRED.includes(identifier.text)) errors.push('retired: ' + identifier.text)
    if ([START, MAIN].includes(unit.path)) {
      for (const node of descendants(unit.source, ts.isBinaryExpression))
        if (
          [
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsEqualsToken,
            ts.SyntaxKind.EqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsToken,
          ].includes(node.operatorToken.kind) &&
          [node.left, node.right].some(
            (side) =>
              ts.isStringLiteral(side) &&
              ['standalone', 'crewstation', 'local', 'remote'].includes(side.text),
          )
        )
          errors.push('entry deployment branch')
      for (const node of descendants(unit.source, ts.isCaseClause))
        if (
          ts.isStringLiteral(node.expression) &&
          ['standalone', 'crewstation', 'local', 'remote'].includes(node.expression.text)
        )
          errors.push('entry deployment branch')
    }
  }
  const selections = declarations(units, 'DeploymentSelections')
  if (selections.length !== 1 || selections[0]?.unit.path !== PROFILE)
    errors.push('single selections declaration')
  const keys =
    selections[0]?.node.members
      .map((member) => member.name?.getText())
      .filter((name): name is string => name !== undefined) ?? []
  for (const [name, overrides] of Object.entries(REQUIRED_OVERRIDES)) {
    const definitions = declarations(units, name)
    const input = definitions[0]?.node
    if (
      definitions.length !== 1 ||
      input?.heritageClauses
        ?.flatMap((clause) => clause.types.map((type) => type.expression.getText()))
        .join(',') !== 'DeploymentSelections'
    )
      errors.push('inheritance: ' + name)
    const selected =
      input?.members.filter((member) => keys.includes(member.name?.getText() ?? '')) ?? []
    if (
      selected
        .map((member) => member.name!.getText())
        .sort()
        .join(',') !== [...overrides].sort().join(',') ||
      selected.some((member) => !ts.isPropertySignature(member) || member.questionToken)
    )
      errors.push('required overrides: ' + name)
    if (
      !input?.members.some(
        (member) =>
          ts.isPropertySignature(member) &&
          member.name.getText() === 'requiredProvider' &&
          !member.questionToken,
      )
    )
      errors.push('required provider: ' + name)
  }
  const profile = get(PROFILE)
  if (
    profile?.statements.some((statement) =>
      ts.isImportDeclaration(statement)
        ? !statement.importClause?.isTypeOnly
        : !ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement),
    )
  )
    errors.push('profile is types only')
  const kind = profile?.statements.find(
    (node) => ts.isTypeAliasDeclaration(node) && node.name.text === 'DeploymentKind',
  )
  const mode = get(PREFIX + 'bootstrap/deployment.ts')?.statements.find(
    (node) => ts.isTypeAliasDeclaration(node) && node.name.text === 'DeploymentMode',
  )
  if (
    !kind ||
    !mode ||
    !ts.isTypeAliasDeclaration(mode) ||
    mode.type.getText() !== 'DeploymentKind'
  )
    errors.push('shared deployment kind')
  const table =
    get(KEYS) &&
    descendants(get(KEYS)!, ts.isVariableDeclaration).find(
      (node) => node.name.getText() === 'DEPLOYMENT_SELECTION_KEYS',
    )
  const object =
    table?.initializer && descendants(table.initializer, ts.isObjectLiteralExpression)[0]
  if (
    object?.properties
      .map((property) => property.name?.getText())
      .sort()
      .join(',') !== [...keys].sort().join(',')
  )
    errors.push('exhaustive selection keys')
  if (
    !table?.initializer ||
    !ts.isSatisfiesExpression(table.initializer) ||
    compact(table.initializer.type) !== 'Record<keyofDeploymentSelections,true>'
  )
    errors.push('selection key type lock')
  const start = get(START)
  if (start) {
    const command = descendants(start, ts.isFunctionDeclaration).find(
      (node) => node.name?.text === 'startCommand',
    )
    if (
      command?.parameters.map((parameter) => parameter.name.getText()).join(',') !==
      'profile,launch,development'
    )
      errors.push('start signature')
    if (
      !start.statements
        .filter(ts.isImportDeclaration)
        .some(
          (node) =>
            node.moduleSpecifier.getText() === "'./daemonSession'" &&
            node.importClause?.namedBindings?.getText().includes('composeDaemonSession'),
        )
    )
      errors.push('direct session import')
    const value = descendants(start, ts.isVariableDeclaration).find(
      (node) => node.name.getText() === 'sessionInput',
    )
    const input =
      value?.initializer && descendants(value.initializer, ts.isObjectLiteralExpression)[0]
    if (
      input?.properties
        .filter(ts.isSpreadAssignment)
        .map((node) => compact(node.expression))
        .join(',') !== 'profile.selections'
    )
      errors.push('startup selection spread')
    if (
      input?.properties.some(
        (node) =>
          ts.isPropertyAssignment(node) && /^profile\.selections\./.test(compact(node.initializer)),
      )
    )
      errors.push('startup selection copies')
  }
  const session = get(SESSION)
  const applicationCall = session && calls(session, 'composeDaemonApplication')
  const applicationInput = applicationCall?.[0]?.arguments[0]
  if (
    applicationCall?.length !== 1 ||
    !applicationInput ||
    !ts.isObjectLiteralExpression(applicationInput) ||
    applicationInput.properties
      .filter(ts.isSpreadAssignment)
      .map((node) => compact(node.expression))
      .join(',') !== 'deploymentSelectionsOf(input)'
  )
    errors.push('application selection spread')
  if (
    applicationInput &&
    ts.isObjectLiteralExpression(applicationInput) &&
    applicationInput.properties.some((node) => node.name && keys.includes(node.name.getText()))
  )
    errors.push('application selection copies')
  const main = get(MAIN)
  const branch =
    main &&
    descendants(main, ts.isCaseClause).find(
      (node) => ts.isStringLiteral(node.expression) && node.expression.text === 'start',
    )
  if (
    !branch ||
    calls(branch, 'selectDeploymentProfile').length !== 1 ||
    calls(branch, 'startCommand').length !== 1
  )
    errors.push('single start selection')
  if (branch && descendants(branch, ts.isSpreadAssignment).length > 0)
    errors.push('main option merge')
  return errors
}
let corpus: SourceUnit[] | undefined
const real = () => (corpus ??= backendUnits(resolve(import.meta.dir, '../../../..')))
test('the full production corpus satisfies the typed deployment profile contract', () => {
  const units = real()
  expect(units.length).toBeGreaterThanOrEqual(2000)
  expect(deploymentProfileViolations(units)).toEqual([])
})
const mutations: readonly [string, string, (text: string) => string, string][] = [
  ...RETIRED.map((name): [string, string, (text: string) => string, string] => [
    name,
    START,
    (text) => text + `\nconst ${name} = 1`,
    'retired: ' + name,
  ]),
  [
    'duplicate contract',
    PROFILE,
    (text) => text + '\ninterface DeploymentSelections {}',
    'single selections declaration',
  ],
  ...Object.keys(REQUIRED_OVERRIDES).flatMap(
    (name): [string, string, (text: string) => string, string][] => {
      const path = name === 'DaemonApplicationInput' ? APPLICATION : INPUT
      return [
        [
          name + ' inheritance',
          path,
          (text) => text.replace('extends DeploymentSelections', ''),
          'inheritance: ' + name,
        ],
        [
          name + ' redeclaration',
          path,
          (text) =>
            text.replace(
              'extends DeploymentSelections {',
              'extends DeploymentSelections { taskArchive?: unknown;',
            ),
          'required overrides: ' + name,
        ],
        [
          name + ' optional derived',
          path,
          (text) => text.replace('readonly secretBox:', 'readonly secretBox?:'),
          'required overrides: ' + name,
        ],
        [
          name + ' missing provider',
          path,
          (text) => text.replace('readonly requiredProvider:', 'readonly requiredProvider?:'),
          'required provider: ' + name,
        ],
      ]
    },
  ),
  [
    'runtime profile code',
    PROFILE,
    (text) => text + '\nconst runtime = 1',
    'profile is types only',
  ],
  [
    'second kind union',
    PREFIX + 'bootstrap/deployment.ts',
    (text) =>
      text.replace(
        'DeploymentMode = DeploymentKind',
        "DeploymentMode = 'standalone' | 'crewstation'",
      ),
    'shared deployment kind',
  ],
  [
    'missing selection key',
    KEYS,
    (text) => text.replace('  startupLease: true,', ''),
    'exhaustive selection keys',
  ],
  [
    'extra selection key',
    KEYS,
    (text) => text.replace('  startupLease: true,', '  startupLease: true, extra: true,'),
    'exhaustive selection keys',
  ],
  [
    'unchecked key table',
    KEYS,
    (text) => text.replace('satisfies Record<keyof DeploymentSelections, true>', ''),
    'selection key type lock',
  ],
  ...[START, MAIN].map((path): [string, string, (text: string) => string, string] => [
    'branch ' + path,
    path,
    (text) => text + "\nif (mode === 'crewstation') boot()",
    'entry deployment branch',
  ]),
  [
    'injected composer',
    START,
    (text) =>
      text.replace(
        'development?: DevelopmentOverlay,',
        'development?: DevelopmentOverlay, composeSession?: unknown,',
      ),
    'start signature',
  ],
  [
    'missing direct import',
    START,
    (text) => text.replace("import { composeDaemonSession } from './daemonSession'", ''),
    'direct session import',
  ],
  [
    'missing start spread',
    START,
    (text) => text.replace('...profile.selections,', ''),
    'startup selection spread',
  ],
  [
    'start copy',
    START,
    (text) =>
      text.replace(
        '...profile.selections,',
        '...profile.selections, taskArchive: profile.selections.taskArchive,',
      ),
    'startup selection copies',
  ],
  [
    'missing graph spread',
    SESSION,
    (text) => text.replace('...deploymentSelectionsOf(input),', ''),
    'application selection spread',
  ],
  [
    'graph copy',
    SESSION,
    (text) =>
      text.replace(
        '...deploymentSelectionsOf(input),',
        '...deploymentSelectionsOf(input), taskArchive: input.taskArchive,',
      ),
    'application selection copies',
  ],
  [
    'missing selection',
    MAIN,
    (text) => text.replace('await selectDeploymentProfile(process.env)', 'profile'),
    'single start selection',
  ],
  [
    'duplicate start',
    MAIN,
    (text) => text.replace("case 'start': {", "case 'start': { startCommand(profile, launch);"),
    'single start selection',
  ],
  [
    'option merge',
    MAIN,
    (text) => text.replace("case 'start': {", "case 'start': { const merged = { ...profile };"),
    'main option merge',
  ],
]
for (const [name, path, mutate, violation] of mutations)
  test('negative fixture rejects ' + name, () => {
    const units = real().filter((unit) =>
      [
        PROFILE,
        START,
        SESSION,
        APPLICATION,
        INPUT,
        KEYS,
        MAIN,
        PREFIX + 'bootstrap/deployment.ts',
      ].includes(unit.path),
    )
    const changed = units.map((unit) =>
      unit.path === path ? sourceUnit(path, mutate(unit.text)) : unit,
    )
    expect(deploymentProfileViolations(changed)).toContain(violation)
  })
test('negative fixture rejects a missing contract source', () => {
  expect(deploymentProfileViolations([])).toContain('missing source: ' + PROFILE)
})

// Compile the actual table against a minimal contract: both omission and addition must be errors.
test('the key table type rejects missing and extra keys in both directions', () => {
  const units = real()
  const profile = units.find((unit) => unit.path === PROFILE)!
  const table = units.find((unit) => unit.path === KEYS)!
  const keys = declarations([profile], 'DeploymentSelections')[0]!.node.members.map((member) =>
    member.name!.getText(),
  )
  const declaration = descendants(table.source, ts.isVariableDeclaration).find(
    (node) => node.name.getText() === 'DEPLOYMENT_SELECTION_KEYS',
  )!
  const code =
    'interface DeploymentSelections {' +
    keys.map((key) => key + '?: unknown').join(';') +
    '}\nconst ' +
    declaration.getText()
  const diagnostics = (text: string) => {
    const filename = '/selection-table.ts'
    const options: ts.CompilerOptions = { noLib: true, strict: true, noEmit: true }
    const source = ts.createSourceFile(
      filename,
      'type Record<K extends keyof any, T> = { [P in K]: T };\n' + text,
      ts.ScriptTarget.Latest,
      true,
    )
    const host = ts.createCompilerHost(options)
    host.getSourceFile = (path) => (path === filename ? source : undefined)
    const program = ts.createProgram([filename], options, host)
    return program.getSemanticDiagnostics(source)
  }
  expect(diagnostics(code)).toEqual([])
  expect(diagnostics(code.replace('startupLease: true,', ''))).not.toEqual([])
  expect(
    diagnostics(code.replace('startupLease: true,', 'startupLease: true, extra: true,')),
  ).not.toEqual([])
})
