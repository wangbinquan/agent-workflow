// RFC-374: NodeRun mint order is seq-first; typed structural detection closes the site catalog.
import { describe, expect, test } from 'bun:test'
import ts from 'typescript'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { backendUnits, packageSrcUnits } from './census'

export interface NodeRunOrderViolation {
  readonly file: string
  readonly line: number
  readonly rule: 'R1' | 'R2' | 'R3' | 'R4'
  readonly text: string
  readonly allowance: string | null
}

const RUN_FIELDS = [
  'nodeId',
  'parentNodeRunId',
  'retryIndex',
  'rerunCause',
  'iteration',
  'shardKey',
  'wgRound',
  'containerRunId',
]
const RELATIONS = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
])

/** Pure AST/type query: no filesystem, compiler construction, or mutable global state. */
export function detectNodeRunIdOrder(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): NodeRunOrderViolation[] {
  const hits: NodeRunOrderViolation[] = []
  // Frontend source-text subrule also works when the backend program cannot resolve its NodeRun import.
  const frontendNodeRun =
    source.fileName.replaceAll('\\', '/').includes('/frontend/') &&
    /import\s+(?:type\s+)?[\s\S]*?\{[^}]*\bNodeRun\b[^}]*\}\s*from\s*['"]@agent-workflow\/shared['"]/.test(
      source.text,
    )
  const tables = new Set(['nodeRuns'])
  const visitAll = (node: ts.Node, fn: (node: ts.Node) => void): void => {
    fn(node)
    ts.forEachChild(node, (child) => visitAll(child, fn))
  }
  // Follow local alias(nodeRuns, ...) bindings, including aliases of aliases.
  let grew = true
  while (grew) {
    grew = false
    visitAll(source, (node) => {
      if (
        ts.isImportSpecifier(node) &&
        node.propertyName?.text === 'nodeRuns' &&
        !tables.has(node.name.text)
      ) {
        tables.add(node.name.text)
        grew = true
      }
      if (
        !ts.isVariableDeclaration(node) ||
        !ts.isIdentifier(node.name) ||
        !node.initializer ||
        !ts.isCallExpression(node.initializer)
      )
        return
      const init = node.initializer
      if (
        init.expression.getText(source) === 'alias' &&
        init.arguments[0] &&
        tables.has(init.arguments[0].getText(source)) &&
        !tables.has(node.name.text)
      ) {
        tables.add(node.name.text)
        grew = true
      }
    })
  }
  const tableRefs = (node: ts.Node, property: string): Set<string> => {
    const refs = new Set<string>()
    visitAll(node, (child) => {
      if (
        ts.isPropertyAccessExpression(child) &&
        child.name.text === property &&
        tables.has(child.expression.getText(source))
      )
        refs.add(child.expression.getText(source))
    })
    return refs
  }
  const runShape = (node: ts.Expression): boolean => {
    const type = checker.getNonNullableType(checker.getTypeAtLocation(node))
    const id = type.getProperty('id')
    if (!id) return false
    const idType = checker.getTypeOfSymbolAtLocation(id, node)
    if (!(idType.flags & ts.TypeFlags.StringLike)) return false
    return RUN_FIELDS.filter((field) => type.getProperty(field)).length >= 2
  }
  const inComparator = (node: ts.Node): boolean => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if (
        ts.isFunctionDeclaration(current) &&
        current.name &&
        /^(?:isFresherNodeRun|compareNodeRunMintOrder|compareLegacyNodeRunMintOrder|isNewerNodeRun)$/.test(
          current.name.text,
        )
      )
        return true
    }
    return false
  }
  const operand = (node: ts.Expression): boolean => {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAsExpression(node)
    )
      return operand(node.expression)
    if (ts.isIdentifier(node)) return /(?:^r|R)unId$/.test(node.text)
    if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === 'runId' || node.name.text === 'nodeRunId') return true
      return (
        node.name.text === 'id' &&
        (frontendNodeRun || runShape(node.expression) || inComparator(node))
      )
    }
    // Null-coalesced legacy message/run boundaries must also be registered.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    )
      return operand(node.left) || operand(node.right)
    return false
  }
  const report = (node: ts.Node, rule: NodeRunOrderViolation['rule']): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line
    const allowance =
      source.text
        .split('\n')
        .slice(Math.max(0, line - 5), line + 1)
        .map((text) => /\/\/\s*s1-allow-id-order:\s*(\S.*)/.exec(text)?.[1])
        .find(Boolean) ?? null
    hits.push({
      file: source.fileName.replaceAll('\\', '/'),
      line: line + 1,
      rule,
      text: node.getText(source),
      allowance,
    })
  }
  visitAll(source, (node) => {
    if (ts.isCallExpression(node)) {
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'orderBy'
      ) {
        const seen = new Set<string>()
        for (const arg of node.arguments) {
          if ([...tableRefs(arg, 'id')].some((table) => !seen.has(table))) report(arg, 'R1')
          for (const table of tableRefs(arg, 'seq')) seen.add(table)
        }
      }
      if (
        ts.isIdentifier(node.expression) &&
        /^(?:gt|gte|lt|lte)$/.test(node.expression.text) &&
        node.arguments.some((arg) => tableRefs(arg, 'id').size > 0)
      )
        report(node, 'R2')
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'localeCompare' &&
        (operand(node.expression.expression) || node.arguments.some(operand))
      )
        report(node, 'R4')
    }
    if (
      ts.isBinaryExpression(node) &&
      RELATIONS.has(node.operatorToken.kind) &&
      (operand(node.left) || operand(node.right))
    )
      report(node, 'R3')
  })
  return hits
}

export interface NodeRunOrderException {
  readonly count: number
  readonly reason: string
}

/** Both directions are checked: unregistered hits and stale exception entries fail. */
export function checkNodeRunOrderExceptions(
  hits: readonly NodeRunOrderViolation[],
  exceptions: Readonly<Record<string, NodeRunOrderException>>,
): string[] {
  const counts = new Map<string, number>()
  for (const hit of hits) {
    if (hit.allowance !== null) continue
    counts.set(hit.file, (counts.get(hit.file) ?? 0) + 1)
  }
  const errors: string[] = []
  for (const [file, count] of counts) {
    const allowed = exceptions[file]
    if (!allowed || count > allowed.count) errors.push(`unregistered: ${file}: ${count}`)
  }
  for (const [file, exception] of Object.entries(exceptions)) {
    if ((counts.get(file) ?? 0) < exception.count || !exception.reason.trim())
      errors.push(`stale: ${file}: ${counts.get(file) ?? 0}/${exception.count}`)
  }
  return errors
}

/** Virtual files give negative samples real types without touching the source tree. */
export function nodeRunOrderVirtualProgram(files: Readonly<Record<string, string>>): ts.Program {
  const options: ts.CompilerOptions = { noLib: true, strict: true, target: ts.ScriptTarget.ESNext }
  const host = ts.createCompilerHost(options)
  host.fileExists = (file) => file in files
  host.readFile = (file) => files[file]
  host.getSourceFile = (file, languageVersion) =>
    files[file] === undefined
      ? undefined
      : ts.createSourceFile(file, files[file], languageVersion, true)
  host.writeFile = () => undefined
  return ts.createProgram(Object.keys(files), options, host)
}

export const NODE_RUN_ORDER_EXCEPTIONS: Readonly<Record<string, NodeRunOrderException>> = {
  'packages/backend/src/modules/task-execution/domain/humanGateContinuation.ts': {
    count: 1,
    reason: 'Persisted continuation digest input order must remain byte-compatible.',
  },
  'packages/backend/src/modules/collaboration/infrastructure/clarify/autoDispatch.ts': {
    count: 1,
    reason: 'Canonical dispatch receipt order is independent of run freshness.',
  },
  'packages/backend/src/modules/resource-catalog/application/workgroups/workgroupRoomProjection.ts':
    { count: 1, reason: 'Legacy leader rounds compare message IDs with run IDs across entities.' },
  'packages/frontend/src/lib/workgroup-room.ts': {
    count: 1,
    reason: 'Message/run interleaving is a cross-entity legacy display boundary.',
  },
  'packages/backend/src/modules/task-execution/infrastructure/migration/oracle/legacyOrder.ts': {
    count: 2,
    reason:
      'RFC-395 D4: epoch-1 NULL/NULL order and theoretical seq ties, kept for the conversion oracle only.',
  },
}

// LIVE CORPUS
const ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const UNITS = [
  ...backendUnits(ROOT),
  ...packageSrcUnits(ROOT, 'shared'),
  ...packageSrcUnits(ROOT, 'frontend'),
]
const configPath = resolve(ROOT, 'packages/backend/tsconfig.json')
const config = ts.parseJsonConfigFileContent(
  ts.readConfigFile(configPath, ts.sys.readFile).config,
  ts.sys,
  resolve(ROOT, 'packages/backend'),
)
const PROGRAM = ts.createProgram(
  UNITS.map((unit) => resolve(ROOT, unit.path)),
  config.options,
)
const CHECKER = PROGRAM.getTypeChecker()
const HITS = UNITS.flatMap((unit) => {
  const source = PROGRAM.getSourceFile(resolve(ROOT, unit.path))!
  return detectNodeRunIdOrder(source, CHECKER).map((hit) => ({ ...hit, file: unit.path }))
})

function detectSample(source: string): NodeRunOrderViolation[] {
  const program = nodeRunOrderVirtualProgram({ '/virtual/sample.ts': source })
  return detectNodeRunIdOrder(
    program.getSourceFile('/virtual/sample.ts')!,
    program.getTypeChecker(),
  )
}

const RUN_SAMPLE =
  'type Run = { id: string; seq: number | null; nodeId: string; iteration: number }; declare const a: Run, b: Run; '

describe('RFC-374 NodeRun order hard guard', () => {
  test('corpus floor and exact exception ledger', () => {
    expect(UNITS.length).toBeGreaterThanOrEqual(2500)
    expect(checkNodeRunOrderExceptions(HITS, NODE_RUN_ORDER_EXCEPTIONS)).toEqual([])
  })
  test('each detection branch bites on virtual violations', () => {
    expect(detectSample('db.orderBy(asc(nodeRuns.id))')).toHaveLength(1)
    for (const sample of [
      'db.orderBy(desc(nodeRuns.id))',
      'import { nodeRuns as rows } from "schema"; const a = alias(rows, "a"); const b = alias(a, "b"); db.orderBy(desc(b.id))',
      RUN_SAMPLE + '(a.id as string) > b.id!',
      'const r = alias(nodeRuns, "r"); db.orderBy(asc(r.id), asc(r.seq))',
      'gt(nodeRuns.id, target.id)',
      'gte(nodeRuns.id, target.id)',
      'const r = alias(nodeRuns, "r"); lt(r.id, target.id)',
      'lte(nodeRuns.id, target.id)',
      RUN_SAMPLE + 'a.id > b.id',
      RUN_SAMPLE + 'a.id <= "id"',
      'declare const a: { nodeRunId: string }; a.nodeRunId < "id"',
      'declare const a: { runId: string }; a.runId >= "id"',
      'declare const sinceRunId: string; sinceRunId > "id"',
      RUN_SAMPLE + 'a.id.localeCompare(b.id)',
      'declare const runId: string; runId.localeCompare("id")',
      RUN_SAMPLE + '"id".localeCompare(a.id)',
      'function isFresherNodeRun(candidate: {id: string}, incumbent: {id: string}) { return candidate.id > incumbent.id }',
      'declare const a: { nodeRunId: string | null }; (a.nodeRunId ?? "") < "message"',
    ])
      expect(detectSample(sample).length).toBeGreaterThan(0)
  })
  test('frontend text branch detects an unresolved imported NodeRun comparison', () => {
    const file = '/packages/frontend/src/fixture.ts'
    const program = nodeRunOrderVirtualProgram({
      [file]:
        'import type { NodeRun } from "@agent-workflow/shared"; declare const a: NodeRun, b: NodeRun; a.id > b.id; a.id.localeCompare(b.id)',
    })
    expect(
      detectNodeRunIdOrder(program.getSourceFile(file)!, program.getTypeChecker()).map(
        (hit) => hit.rule,
      ),
    ).toEqual(['R3', 'R4'])
    const compliant = nodeRunOrderVirtualProgram({
      [file]:
        'import type { NodeRun } from "@agent-workflow/shared"; declare const a: NodeRun, b: NodeRun; compareNodeRunMintOrder(a, b)',
    })
    expect(
      detectNodeRunIdOrder(compliant.getSourceFile(file)!, compliant.getTypeChecker()),
    ).toEqual([])
  })
  test('compliant exemption boundaries remain accepted', () => {
    for (const sample of [
      'db.orderBy(descNullsLast(nodeRuns.seq), desc(nodeRuns.id))',
      'const r = alias(nodeRuns, "r"); db.orderBy(ascNullsFirst(r.seq), asc(r.id))',
      RUN_SAMPLE + 'compareNodeRunMintOrder(a, b)',
      'db.orderBy(asc(nodeRunEvents.id))',
      'declare const a: {id: string; round: number}, b: {id: string; round: number}; a.id > b.id',
      RUN_SAMPLE + 'a.id === b.id',
      RUN_SAMPLE + 'a.iteration > b.iteration',
      'eq(nodeRuns.id, "id")',
      'declare const a: {id: string; nodeId:string}; a.id > "id"',
      'declare const a: {id: number; nodeId:string; iteration:number}; a.id > 1',
    ])
      expect(detectSample(sample)).toEqual([])
    const escaped = detectSample(
      '// s1-allow-id-order: persisted receipt order\ndb.orderBy(asc(nodeRuns.id))',
    )
    expect(escaped).toHaveLength(1)
    expect(checkNodeRunOrderExceptions(escaped, {})).toEqual([])
    const expired = detectSample(
      '// s1-allow-id-order: too far away\n\n\n\n\n\n\ndb.orderBy(asc(nodeRuns.id))',
    )
    expect(checkNodeRunOrderExceptions(expired, {})).toHaveLength(1)
  })
  test('exception ledger mutations reject removed and added entries', () => {
    const [file] = Object.keys(NODE_RUN_ORDER_EXCEPTIONS)
    const removed = { ...NODE_RUN_ORDER_EXCEPTIONS }
    delete removed[file!]
    expect(
      checkNodeRunOrderExceptions(HITS, removed).some((error) => error.startsWith('unregistered:')),
    ).toBe(true)
    expect(
      checkNodeRunOrderExceptions(HITS, {
        ...NODE_RUN_ORDER_EXCEPTIONS,
        'never.ts': { count: 1, reason: 'stale negative fixture' },
      }).some((error) => error.startsWith('stale:')),
    ).toBe(true)
  })
  test('guard source is registered in the manifest', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(ROOT, 'architecture/guard-manifest.json'), 'utf8'),
    ) as { guards: { file: string }[] }
    expect(
      manifest.guards.some((guard) => guard.file.endsWith('/rfc374-node-run-order-guard.test.ts')),
    ).toBe(true)
  })
})
