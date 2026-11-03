// RFC-431: every deployment states each selection. `DeploymentSelections` has three groups — required,
// required-nullable (hosted-only capabilities, standalone `null`) and optional (RFC-294 S2c steps 3–4) — and
// the standalone profile builds exactly the first two in `standaloneSelections`. Below the two profiles,
// bootstrap never substitutes a default for a stated selection: no `??`, no optional chaining, no comparison
// with `undefined` (and, for a required one, none with `null`). The helpers that existed only to default an
// absent selection stay retired. Reads the production sources without importing them.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'
import {
  NULLABLE_SELECTIONS,
  OPTIONAL_SELECTIONS,
  REQUIRED_SELECTIONS,
  SESSION_FACTORY_SELECTIONS,
} from '../helpers/deploymentSelectionPartition'

// Reads the whole backend corpus once (as the RFC-394 and RFC-428 locks do); allow the same budget.
setDefaultTimeout(20_000)

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const PROFILE = PREFIX + 'bootstrap/deploymentProfile.ts'
const STANDALONE = PREFIX + 'bootstrap/standalone.ts'
const BOOTSTRAP = PREFIX + 'bootstrap/'
/** The two deployment assembly roots state the values; every other bootstrap file only consumes them. */
const STATING_ROOTS = (path: string) =>
  path === STANDALONE || /^packages\/backend\/src\/bootstrap\/crewstation[A-Za-z]*\.ts$/.test(path)
/**
 * The maintenance Worker thread composes its own effect families from the hosted descriptor it is started with
 * (`workerEffects`; none for standalone, which keeps the Worker's local families). Those are not deployment
 * selections, and RFC-431 leaves the Worker's own local assembly as is (design §3 non-goals).
 */
const WORKER_ROOTS = (path: string) =>
  /^packages\/backend\/src\/bootstrap\/maintenanceWorker[A-Za-z]*\.ts$/.test(path)
const REQUIRED: readonly string[] = REQUIRED_SELECTIONS
const NULLABLE: readonly string[] = NULLABLE_SELECTIONS
const OPTIONAL: readonly string[] = OPTIONAL_SELECTIONS.presence
const STATED = [...REQUIRED, ...NULLABLE]
/** RFC-432: required selections stated as factories each session calls with its own graph. */
const SESSION_FACTORIES: readonly string[] = SESSION_FACTORY_SELECTIONS
const HOSTED = PREFIX + 'bootstrap/crewstation.ts'
const RETIRED = [
  'standaloneModuleAdapters',
  'DaemonModuleAdapters',
  'selectTaskRunRootSelection',
  'composeLocalTaskRunRootSelection',
  'selectLocalBootExecutionRecoveryFactory',
  'createGraphDevelopmentArtifactBinding',
  'createGraphDevelopmentVerificationBinding',
  'composeTaskRuntimeInventoryContent',
]
let corpus: SourceUnit[] | undefined
const real = () => (corpus ??= backendUnits(ROOT))

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}
const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)
    ? unwrap(node.expression)
    : node
const statedName = (node: ts.Expression): string | undefined => {
  const inner = unwrap(node)
  return ts.isPropertyAccessExpression(inner) && STATED.includes(inner.name.text)
    ? inner.name.text
    : undefined
}
const isUndefined = (node: ts.Expression) => {
  const inner = unwrap(node)
  return (ts.isIdentifier(inner) && inner.text === 'undefined') || ts.isVoidExpression(inner)
}
const isNull = (node: ts.Expression) => unwrap(node).kind === ts.SyntaxKind.NullKeyword
const EQUALITY = [
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]

function partitionViolations(profile: SourceUnit | undefined): string[] {
  if (profile === undefined) return ['missing source: ' + PROFILE]
  const errors: string[] = []
  const contract = profile.source.statements.filter(
    (node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) && node.name.text === 'DeploymentSelections',
  )
  if (contract.length !== 1) return ['single selections declaration']
  const seen = new Set<string>()
  for (const member of contract[0]!.members) {
    if (!ts.isPropertySignature(member)) continue
    const name = member.name.getText(profile.source)
    seen.add(name)
    const optional = member.questionToken !== undefined
    const nullable =
      member.type !== undefined &&
      ts.isUnionTypeNode(member.type) &&
      member.type.types.some(
        (type) => ts.isLiteralTypeNode(type) && type.literal.kind === ts.SyntaxKind.NullKeyword,
      )
    const group = optional ? 'optional' : nullable ? 'nullable' : 'required'
    const expected = REQUIRED.includes(name)
      ? 'required'
      : NULLABLE.includes(name)
        ? 'nullable'
        : OPTIONAL.includes(name)
          ? 'optional'
          : 'unlisted'
    if (group !== expected) errors.push(`partition:${name}:${group}!=${expected}`)
  }
  for (const name of [...STATED, ...OPTIONAL])
    if (!seen.has(name)) errors.push('partition:missing:' + name)
  return errors
}

function standaloneViolations(standalone: SourceUnit | undefined): string[] {
  if (standalone === undefined) return ['missing source: ' + STANDALONE]
  const errors: string[] = []
  const functions = standalone.source.statements.filter(ts.isFunctionDeclaration)
  const profile = functions.find((node) => node.name?.text === 'composeStandaloneProfile')
  let profileSelections: ts.Expression | undefined
  if (profile !== undefined)
    walk(profile, (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(standalone.source) === 'selections' &&
        profileSelections === undefined
      )
        profileSelections = node.initializer
    })
  if (
    profileSelections === undefined ||
    !ts.isCallExpression(profileSelections) ||
    profileSelections.expression.getText(standalone.source) !== 'standaloneSelections'
  )
    errors.push('standalone profile selections')
  const builder = functions.find((node) => node.name?.text === 'standaloneSelections')
  const returned: ts.ObjectLiteralExpression[] = []
  if (builder !== undefined)
    walk(builder, (node) => {
      if (
        ts.isReturnStatement(node) &&
        node.expression !== undefined &&
        ts.isObjectLiteralExpression(node.expression)
      )
        returned.push(node.expression)
    })
  if (returned.length !== 1) return [...errors, 'standalone selections literal']
  const keys = new Map<string, ts.Expression | undefined>()
  for (const property of returned[0]!.properties) {
    if (ts.isSpreadAssignment(property)) {
      errors.push('standalone selections spread')
      continue
    }
    const name = property.name?.getText(standalone.source)
    if (name === undefined) continue
    keys.set(
      name,
      ts.isPropertyAssignment(property)
        ? property.initializer
        : ts.isShorthandPropertyAssignment(property)
          ? property.name
          : undefined,
    )
  }
  for (const name of STATED) if (!keys.has(name)) errors.push('standalone missing:' + name)
  for (const name of keys.keys())
    if (!STATED.includes(name)) errors.push('standalone extra:' + name)
  for (const name of NULLABLE) {
    const value = keys.get(name)
    if (value !== undefined && value.kind !== ts.SyntaxKind.NullKeyword)
      errors.push('standalone hosted-only not null:' + name)
  }
  for (const name of REQUIRED) {
    const value = keys.get(name)
    if (value !== undefined && (value.kind === ts.SyntaxKind.NullKeyword || isUndefined(value)))
      errors.push('standalone required unset:' + name)
  }
  // RFC-432: a session-scoped selection is the constructor itself — the profile builds nothing before the lock.
  for (const name of SESSION_FACTORIES) {
    const value = keys.get(name)
    if (value !== undefined && ts.isCallExpression(value))
      errors.push('standalone session factory called:' + name)
  }
  return errors
}

/** RFC-432: the hosted profile states each session-scoped selection as a closure over the object it built. */
function hostedViolations(hosted: SourceUnit | undefined): string[] {
  if (hosted === undefined) return ['missing source: ' + HOSTED]
  const closures = new Set<string>()
  walk(hosted.source, (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(hosted.source) === 'selections' &&
      ts.isObjectLiteralExpression(node.initializer)
    )
      for (const property of node.initializer.properties)
        if (ts.isPropertyAssignment(property) && ts.isArrowFunction(property.initializer))
          closures.add(property.name.getText(hosted.source))
  })
  return SESSION_FACTORIES.filter((name) => !closures.has(name)).map(
    (name) => 'hosted session factory not a closure:' + name,
  )
}

function consumerViolations(units: readonly SourceUnit[]): string[] {
  const errors: string[] = []
  for (const unit of units) {
    if (!unit.path.startsWith(BOOTSTRAP) || STATING_ROOTS(unit.path) || WORKER_ROOTS(unit.path))
      continue
    walk(unit.source, (node) => {
      // `x?.stated`: the selection itself read as possibly absent.
      if (ts.isPropertyAccessExpression(node) && node.questionDotToken !== undefined) {
        const name = node.name.text
        if (STATED.includes(name)) errors.push(`optional chain:${unit.path}:${name}`)
      }
      // `x.stated?.member` / `x.stated?.[key]`: a member of a selection reached as if it could be absent.
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        node.questionDotToken !== undefined
      ) {
        const name = statedName(node.expression)
        if (name !== undefined) errors.push(`optional chain:${unit.path}:${name}`)
      }
      if (ts.isCallExpression(node) && node.questionDotToken !== undefined) {
        const name = statedName(node.expression)
        if (name !== undefined) errors.push(`optional call:${unit.path}:${name}`)
      }
      if (!ts.isBinaryExpression(node)) return
      if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
        const name = statedName(node.left)
        if (name !== undefined) errors.push(`default:${unit.path}:${name}`)
        return
      }
      if (!EQUALITY.includes(node.operatorToken.kind)) return
      for (const [side, other] of [
        [node.left, node.right],
        [node.right, node.left],
      ] as const) {
        const name = statedName(side)
        if (name === undefined) continue
        if (isUndefined(other)) errors.push(`undefined check:${unit.path}:${name}`)
        else if (isNull(other) && REQUIRED.includes(name))
          errors.push(`null check:${unit.path}:${name}`)
      }
    })
  }
  return errors
}

function retiredViolations(units: readonly SourceUnit[]): string[] {
  const errors = new Set<string>()
  for (const unit of units) {
    if (!unit.path.startsWith(PREFIX)) continue
    walk(unit.source, (node) => {
      if (ts.isIdentifier(node) && RETIRED.includes(node.text))
        errors.add(`retired:${unit.path}:${node.text}`)
    })
  }
  return [...errors]
}

export function standaloneSelectionViolations(units: readonly SourceUnit[]): string[] {
  const byPath = new Map(units.map((unit) => [unit.path, unit]))
  return [
    ...partitionViolations(byPath.get(PROFILE)),
    ...standaloneViolations(byPath.get(STANDALONE)),
    ...hostedViolations(byPath.get(HOSTED)),
    ...consumerViolations(units),
    ...retiredViolations(units),
  ].sort()
}

test('the partition lists are disjoint and cover the contract once', () => {
  const all = [...STATED, ...OPTIONAL]
  expect(new Set(all).size).toBe(all.length)
  // RFC-432: the ten session-scoped selections joined the required group (39 → 49; optional 17 → 7).
  expect(REQUIRED).toHaveLength(49)
  expect(NULLABLE).toHaveLength(6)
  expect(OPTIONAL).toHaveLength(7)
  expect(SESSION_FACTORIES).toHaveLength(10)
  for (const name of SESSION_FACTORIES) expect(REQUIRED).toContain(name)
})

test('live corpus: the selection contract, the standalone profile and its consumers hold', () => {
  const units = real()
  expect(units.length).toBeGreaterThanOrEqual(2000)
  expect(standaloneSelectionViolations(units)).toEqual([])
})

const replace = (path: string, edit: (text: string) => string) =>
  real().map((unit) => (unit.path === path ? sourceUnit(path, edit(unit.text)) : unit))
const APPLICATION = PREFIX + 'bootstrap/daemonApplication.ts'
const SESSION = PREFIX + 'bootstrap/daemonSession.ts'

const NEGATIVES: readonly [string, string, (text: string) => string, string][] = [
  [
    'a required selection made optional',
    PROFILE,
    (text) => text.replace('  workspaceUploads: Workspace', '  workspaceUploads?: Workspace'),
    'partition:workspaceUploads:optional!=required',
  ],
  [
    'a hosted-only capability made optional again',
    PROFILE,
    (text) =>
      text.replace('  taskInputFiles: TaskInputFiles | null', '  taskInputFiles?: TaskInputFiles'),
    'partition:taskInputFiles:optional!=nullable',
  ],
  [
    'a pending selection made required without a standalone value',
    PROFILE,
    (text) => text.replace('  secretBox?: SecretBox', '  secretBox: SecretBox'),
    'partition:secretBox:required!=optional',
  ],
  [
    'the standalone profile without its selections',
    STANDALONE,
    (text) =>
      text.replace(
        'selections: standaloneSelections({ appHome: Paths.root }),',
        'selections: {} as never,',
      ),
    'standalone profile selections',
  ],
  [
    'a standalone hosted-only capability that is not null',
    STANDALONE,
    (text) => text.replace('    taskRecovery: null,', '    taskRecovery: undefined as never,'),
    'standalone hosted-only not null:taskRecovery',
  ],
  [
    'a standalone selection left out',
    STANDALONE,
    (text) => text.replace('    hostedBackgroundOwners: [],\n', ''),
    'standalone missing:hostedBackgroundOwners',
  ],
  [
    'a bootstrap default for a stated selection',
    APPLICATION,
    (text) =>
      text.replace(
        'fusionWorkspaces: input.fusionWorkspaceEffects,',
        'fusionWorkspaces: input.fusionWorkspaceEffects ?? (undefined as never),',
      ),
    `default:${APPLICATION}:fusionWorkspaceEffects`,
  ],
  [
    'an absent check for a stated selection',
    SESSION,
    (text) =>
      text.replace(
        'profileJobs: input.hostedBackgroundOwners.map(',
        'profileJobs: (input.hostedBackgroundOwners === undefined ? [] : input.hostedBackgroundOwners).map(',
      ),
    `undefined check:${SESSION}:hostedBackgroundOwners`,
  ],
  [
    'an optional call on a stated selection',
    APPLICATION,
    (text) =>
      text.replace('input.recoveredExecutionTaskIds()', 'input.recoveredExecutionTaskIds?.()'),
    `optional call:${APPLICATION}:recoveredExecutionTaskIds`,
  ],
  [
    'a retired helper coming back',
    APPLICATION,
    (text) => text + '\nexport const standaloneModuleAdapters = 1\n',
    `retired:${APPLICATION}:standaloneModuleAdapters`,
  ],
  // RFC-432: session-scoped selections.
  [
    'a standalone session factory built at profile time',
    STANDALONE,
    (text) =>
      text.replace(
        '    reviewArtifacts: createLocalReviewArtifacts,',
        '    reviewArtifacts: (() => createLocalReviewArtifacts)(),',
      ),
    'standalone session factory called:reviewArtifacts',
  ],
  [
    'a hosted session selection that is not a closure',
    HOSTED,
    (text) => text.replace('reviewArtifacts: () => reviewArtifacts,', 'reviewArtifacts,'),
    'hosted session factory not a closure:reviewArtifacts',
  ],
  [
    'a bootstrap default for a session factory',
    APPLICATION,
    (text) =>
      text.replace(
        'const content = input.contentStore(session)',
        'const content = (input.contentStore ?? createLocalRuntimeContent)(session)',
      ),
    `default:${APPLICATION}:contentStore`,
  ],
]
for (const [name, path, edit, violation] of NEGATIVES)
  test('negative fixture over the corpus rejects ' + name, () => {
    const units = replace(path, edit)
    expect(units.find((unit) => unit.path === path)!.text).not.toBe(
      real().find((unit) => unit.path === path)!.text,
    )
    expect(standaloneSelectionViolations(units)).toContain(violation)
  })

test('negative fixtures over fabricated units alone: every matcher still bites', () => {
  const only = (path: string, text: string) =>
    standaloneSelectionViolations([sourceUnit(path, text)])
  expect(only(PROFILE, 'interface Other {}')).toContain('single selections declaration')
  expect(only(PREFIX + 'bootstrap/x.ts', 'const a = input.workspaceContent?.bind(ref)')).toContain(
    `optional chain:${PREFIX}bootstrap/x.ts:workspaceContent`,
  )
  expect(only(PREFIX + 'bootstrap/x.ts', 'const a = input.selections?.workspaceContent')).toContain(
    `optional chain:${PREFIX}bootstrap/x.ts:workspaceContent`,
  )
  // The maintenance Worker's own effect families are not deployment selections.
  expect(
    only(
      PREFIX + 'bootstrap/maintenanceWorkerGraph.ts',
      'const a = workerEffects?.taskArchive',
    ).filter((v) => v.startsWith('optional chain')),
  ).toEqual([])
  expect(only(PREFIX + 'bootstrap/x.ts', 'if (input.evidenceArtifacts !== null) run()')).toContain(
    `null check:${PREFIX}bootstrap/x.ts:evidenceArtifacts`,
  )
  // A hosted-only capability is switched off by `null`; the explicit check is the intended consumer.
  expect(
    only(PREFIX + 'bootstrap/x.ts', 'if (input.taskRecovery !== null) run()').filter((v) =>
      v.startsWith('null check'),
    ),
  ).toEqual([])
  // The hosted root states its values and is not a consumer.
  expect(
    only(PREFIX + 'bootstrap/crewstation.ts', 'const a = input.workspaceContent ?? b').filter((v) =>
      v.startsWith('default'),
    ),
  ).toEqual([])
  expect(only(PREFIX + 'modules/x.ts', 'selectTaskRunRootSelection()')).toContain(
    `retired:${PREFIX}modules/x.ts:selectTaskRunRootSelection`,
  )
})
