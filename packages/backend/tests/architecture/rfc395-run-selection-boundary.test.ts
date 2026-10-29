// RFC-395 II-a A3 item 9: business sites must consume run-selection ports so II-b can
// replace the oracle without leaving private pickers, SQL ranking, or cross-context row reads.
// Epoch-1 migration/display/owner-SQL exceptions are exact, two-way, and may only shrink.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { setDefaultTimeout, describe, expect, test } from 'bun:test'
import ts from 'typescript'
import ledger from '../fixtures/rfc395-run-selection-boundary-ledger.json'

// Slowest case took 3.15 s on CI run 40433510287 including hooks (2.31 s before RFC-395 II-b); allow 20 s.
setDefaultTimeout(20_000)

const backend = resolve(import.meta.dir, '../..')
const oracle = 'src/modules/task-execution/infrastructure/migration/oracle/'
// The target port implementation owns selection SQL; sibling business adapters do not.
const targetReader = 'src/modules/task-execution/infrastructure/runSelection/table/reader.ts'
const displayHelper = 'src/services/reviewRoundStart.ts'
const legacy = new Set([
  'compareNodeRunMintOrder',
  'isFresherNodeRun',
  'isNewerNodeRun',
  'newestNodeRun',
  'pickFreshestRun',
  'pickLatestSettledRun',
  'pickLatestRunInFrame',
  'pickFrameSourceRun',
  'pickReusableShardRun',
  'isStructurallySuperseded',
  'supersededPendingRows',
  'structurallySupersededCondition',
])
type Rule = 'legacy-selection' | 'sql-order' | 'display-order-call' | 'cross-context-read'
interface Hit {
  path: string
  rule: Rule
  source: string
}
const portable = (path: string) => path.replaceAll('\\', '/')
const key = (hit: Hit) => `${portable(hit.path)}|${hit.rule}|${hit.source}`
const digest = (hit: Hit) => createHash('sha256').update(key(hit)).digest('hex')
// RFC-395 II-b: exact successors of the reviewed owner/display sites plus frozen frame conversion.
// Eleven epoch-1 entries retire; five target entries remain. T18 P3B makes the two
// owner retry-order clauses explicitly NULLS LAST; only their exact hashes change.
// Private runtime pickers are not allowed. RFC-395 D4 (2026-10-29) moved the converter frame backfill
// (migration/run/frames.ts) to the oracle legacy comparator, retiring its entry; four remain.
const initialExceptions = new Set<string>([
  '3650a7d35c8bc5bc13c6e748caa16b17578eec2568f733bcfa2bafb593cb18a3',
  '4c1127f2284e9c1b61f3707b81b5a868cd1f34be90ddbcc9d5aa109dc2e0beeb',
  'b7d6313ee8991f72c72c417f3c33411ea417617f65d7254557dc7975f5c4a1a5',
  '481d640ee54d97c5ad353a00762d42a93f6ce065d805f71da43299fa99c6d5e7',
  'd56f405b8568571feca9eac4e2b0dfb42064a0cddd6a6f486fc176faa82ce0da',
])

function member(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    return node.argumentExpression.text
  return undefined
}
function unwrap(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node)
    ? unwrap(node.expression)
    : node
}
function nodes(node: ts.Node): ts.Node[] {
  const result = [node]
  ts.forEachChild(node, (child) => {
    result.push(...nodes(child))
  })
  return result
}

export function runSelectionBoundaryHits(path: string, text: string): Hit[] {
  path = portable(path)
  if (path.startsWith(oracle) || path === targetReader) return []
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const all = nodes(source)
  const aliases = new Map<string, string>()
  const tableAliases = new Set(['nodeRuns', 'node_runs'])
  const columnAliases = new Set<string>()
  for (const node of all) {
    if (ts.isImportSpecifier(node))
      aliases.set(node.name.text, node.propertyName?.text ?? node.name.text)
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const name = node.propertyName === undefined ? node.name.text : member(node.propertyName)
      if (name !== undefined) aliases.set(node.name.text, name)
      if (name === 'nodeRuns') tableAliases.add(node.name.text)
    }
  }
  const canonical = (node: ts.Node): string | undefined => {
    const name = member(node)
    return name === undefined ? undefined : (aliases.get(name) ?? name)
  }
  const isTable = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && tableAliases.has(node.text)) ||
    canonical(node) === 'nodeRuns' ||
    (ts.isStringLiteralLike(node) && node.text === 'node_runs')
  // Fixed-point propagation covers renamed imports, local aliases, destructured tables/columns.
  for (let pass = 0; pass < all.length; pass++) {
    let changed = false
    for (const node of all) {
      if (!ts.isVariableDeclaration(node) || !node.initializer) continue
      const init = unwrap(node.initializer)
      if (ts.isIdentifier(node.name)) {
        const name = canonical(init)
        if (name && legacy.has(name) && aliases.get(node.name.text) !== name) {
          aliases.set(node.name.text, name)
          changed = true
        }
        if (isTable(init) && !tableAliases.has(node.name.text)) {
          tableAliases.add(node.name.text)
          changed = true
        }
        if (
          (ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init)) &&
          isTable(init.expression) &&
          ['seq', 'id', 'startedAt', 'retryIndex'].includes(member(init) ?? '') &&
          !columnAliases.has(node.name.text)
        ) {
          columnAliases.add(node.name.text)
          changed = true
        }
      } else if (ts.isObjectBindingPattern(node.name) && isTable(init)) {
        for (const binding of node.name.elements) {
          const name = member(binding.propertyName ?? binding.name)
          if (
            name &&
            ['seq', 'id', 'startedAt', 'retryIndex'].includes(name) &&
            ts.isIdentifier(binding.name) &&
            !columnAliases.has(binding.name.text)
          ) {
            columnAliases.add(binding.name.text)
            changed = true
          }
        }
      }
    }
    if (!changed) break
  }
  const isRankColumn = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && columnAliases.has(node.text)) ||
    ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      isTable(node.expression) &&
      ['seq', 'id', 'startedAt', 'retryIndex'].includes(member(node) ?? ''))
  const crossContext =
    /^src\/modules\/(collaboration|memory)\//.test(path) ||
    (/^src\/modules\/resource-catalog\//.test(path) && /workgroup/i.test(path))
  const hits: Hit[] = []
  const add = (rule: Rule, node: ts.Node) =>
    hits.push({ path, rule, source: node.getText(source).replace(/\s+/g, ' ') })
  for (const node of all) {
    if (ts.isCallExpression(node)) {
      const call = unwrap(node.expression)
      const name = canonical(call)
      if (
        (name && legacy.has(name)) ||
        node.arguments.some((arg) => legacy.has(canonical(unwrap(arg)) ?? ''))
      ) {
        // Exactly one display tie-breaker; the rest of this file has no exemption.
        let owner: ts.Node | undefined = node.parent
        while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent
        if (
          !(
            path === displayHelper &&
            owner &&
            ts.isFunctionDeclaration(owner) &&
            owner.name?.text === 'compareNodeRunsForTimeline' &&
            node.getText(source) === 'compareNodeRunMintOrder(a, b)'
          )
        )
          add('legacy-selection', node)
      }
      if (name === 'runHistoryOrder') add('display-order-call', node)
      if (name === 'orderBy' && node.arguments.some((arg) => nodes(arg).some(isRankColumn)))
        add('sql-order', node)
      if (
        crossContext &&
        ((['from', 'leftJoin', 'rightJoin', 'innerJoin', 'fullJoin'].includes(name ?? '') &&
          node.arguments.some(isTable)) ||
          (['findFirst', 'findMany'].includes(name ?? '') && nodes(call).some(isTable)))
      )
        add('cross-context-read', node)
    }
    if (ts.isTaggedTemplateExpression(node) && canonical(node.tag) === 'sql') {
      const template = node.template
      let sql = ''
      if (ts.isNoSubstitutionTemplateLiteral(template)) sql = template.text
      else {
        sql = template.head.text
        for (const span of template.templateSpans) {
          sql +=
            (isTable(span.expression)
              ? ' node_runs '
              : isRankColumn(span.expression)
                ? ' node_runs.seq '
                : ' expression ') + span.literal.text
        }
      }
      if (/\b(?:from|join)\s+["`]?node_runs\b/i.test(sql) && crossContext)
        add('cross-context-read', node)
      if (/\border\s+by\b[\s\S]*\bnode_runs\.(?:seq|id|started_at|retry_index)\b/i.test(sql))
        add('sql-order', node)
    }
    // Literal SQL sent through query/execute is also a read, not just tagged templates.
    if (ts.isStringLiteralLike(node) && ts.isCallExpression(node.parent)) {
      if (crossContext && /\b(?:from|join)\s+["`]?node_runs\b/i.test(node.text))
        add('cross-context-read', node)
      if (/\border\s+by\b[\s\S]*\bnode_runs\.(?:seq|id|started_at|retry_index)\b/i.test(node.text))
        add('sql-order', node)
    }
  }
  return hits
}

export function boundaryViolations(actual: readonly Hit[], allowed: readonly Hit[]): string[] {
  const remaining = [...allowed]
  const errors: string[] = []
  for (const hit of actual) {
    const index = remaining.findIndex((entry) => key(entry) === key(hit))
    if (index < 0) errors.push(`unrecorded:${key(hit)}`)
    else remaining.splice(index, 1)
  }
  return [...errors, ...remaining.map((entry) => `stale:${key(entry)}`)].sort()
}
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : entry.name.endsWith('.ts') ? [path] : []
  })
}

describe('RFC-395 II-a A3 run-selection boundary', () => {
  test('business sources contain no unrecorded selection or cross-context NodeRun reads', () => {
    const corpus = files(join(backend, 'src'))
    expect(corpus.length).toBeGreaterThan(1000)
    const actual = corpus.flatMap((path) =>
      runSelectionBoundaryHits(relative(backend, path), readFileSync(path, 'utf8')),
    )
    expect(boundaryViolations(actual, ledger.entries as Hit[])).toEqual([])
    expect(ledger.entries.length).toBeLessThanOrEqual(initialExceptions.size)
    for (const entry of ledger.entries) {
      expect(initialExceptions.has(digest(entry as Hit))).toBe(true)
      expect(entry.removeBy).toBe(
        entry.path.includes('/migration/')
          ? 'epoch-1-conversion-retirement'
          : 'owner-query-retirement',
      )
      expect(entry.why.length).toBeGreaterThan(20)
    }
  })
  test('negative controls reject direct, renamed, namespace, bracket and callback legacy pickers', () => {
    for (const name of legacy) {
      for (const snippet of [
        `${name}(rows)`,
        `import { ${name} as alias } from 'picker'; alias(rows)`,
        `picker['${name}'](rows)`,
        `picker.${name}(rows)`,
        `rows.sort(${name})`,
        `const alias = ${name}; alias(rows)`,
      ]) {
        const hits = runSelectionBoundaryHits(
          'src/modules/task-execution/application/bad.ts',
          snippet,
        )
        expect(hits.some((hit) => hit.rule === 'legacy-selection')).toBe(true)
        expect(boundaryViolations(hits, [])).not.toEqual([])
      }
    }
  })
  test('negative controls reject ranking by every legacy SQL column, including aliases and raw SQL', () => {
    for (const field of ['seq', 'id', 'startedAt', 'retryIndex']) {
      for (const snippet of [
        `db.select().from(nodeRuns).orderBy(desc(nodeRuns.${field})).limit(1)`,
        `const { nodeRuns: runs } = tablesOf(db); const order = runs.${field}; q.orderBy(order)`,
        `const { ${field}: order } = nodeRuns; q['orderBy'](order)`,
        `db.get(sql\`SELECT * FROM node_runs ORDER BY node_runs.${field === 'startedAt' ? 'started_at' : field === 'retryIndex' ? 'retry_index' : field} DESC LIMIT 1\`)`,
      ]) {
        const hits = runSelectionBoundaryHits('src/services/bad.ts', snippet)
        expect(hits.some((hit) => hit.rule === 'sql-order')).toBe(true)
        expect(boundaryViolations(hits, [])).not.toEqual([])
      }
    }
    expect(
      boundaryViolations(
        runSelectionBoundaryHits(
          'src/services/bad.ts',
          'q.orderBy(...runHistoryOrder(db, nodeRuns))',
        ),
        [],
      ),
    ).not.toEqual([])
  })
  test('negative controls reject NodeRun reads in collaboration, memory and every workgroup layer', () => {
    for (const path of [
      'collaboration/infrastructure/bad.ts',
      'memory/application/bad.ts',
      'resource-catalog/application/workgroups/bad.ts',
      'resource-catalog/infrastructure/workgroupTaskRoom.ts',
    ]) {
      for (const snippet of [
        'db.select().from(nodeRuns)',
        'const { nodeRuns: rows } = tablesOf(db); db.select().from(rows)',
        "db.select().leftJoin(schema['nodeRuns'], on)",
        'db.query.nodeRuns.findMany()',
        'db.get(sql`SELECT 1 FROM ${nodeRuns} LIMIT 1`)',
        'db.execute("SELECT * FROM node_runs")',
      ]) {
        const hits = runSelectionBoundaryHits(`src/modules/${path}`, snippet)
        expect(hits.some((hit) => hit.rule === 'cross-context-read')).toBe(true)
        expect(boundaryViolations(hits, [])).not.toEqual([])
      }
    }
  })
  test('exceptions shrink, duplicate calls fail, and paths use portable separators', () => {
    const allowed = runSelectionBoundaryHits('src/example.ts', 'pickFreshestRun(rows)')
    expect(boundaryViolations(allowed, allowed)).toEqual([])
    expect(boundaryViolations([...allowed, ...allowed], allowed)).not.toEqual([])
    expect(boundaryViolations([], allowed)).not.toEqual([])
    expect(boundaryViolations([], [])).toEqual([])
    expect(runSelectionBoundaryHits('src\\example.ts', 'pickFreshestRun(rows)')).toEqual(allowed)
    expect(runSelectionBoundaryHits(`${oracle}fixture.ts`, 'pickFreshestRun(rows)')).toEqual([])
    expect(runSelectionBoundaryHits(targetReader, 'query.orderBy(asc(nodeRuns.seq))')).toEqual([])
    expect(
      runSelectionBoundaryHits(
        'src/modules/task-execution/infrastructure/runSelection/copied.ts',
        'pickFreshestRun(rows)',
      ),
    ).not.toEqual([])
    expect(
      runSelectionBoundaryHits(
        displayHelper,
        'function compareNodeRunsForTimeline(a, b) { return compareNodeRunMintOrder(a, b) }',
      ),
    ).toEqual([])
    expect(
      runSelectionBoundaryHits(
        displayHelper,
        'function selection(a, b) { return compareNodeRunMintOrder(a, b) }',
      ),
    ).not.toEqual([])
    expect(runSelectionBoundaryHits(displayHelper, 'pickFreshestRun(rows)')).not.toEqual([])
    expect(
      runSelectionBoundaryHits(
        'src/services/okay.ts',
        '// pickFreshestRun(rows)\nconst prose = "node_runs"',
      ),
    ).toEqual([])
    expect(
      runSelectionBoundaryHits(
        'src/modules/collaboration/infrastructure/write.ts',
        'db.update(nodeRuns).set(values).returning({ id: nodeRuns.id })',
      ),
    ).toEqual([])
  })
})

function failureSnapshotBeforeLoop(source: string): boolean {
  const start = source.indexOf('export async function loadTaskFailureCodes(')
  if (start < 0) return false
  const nextProjection = source.indexOf('function rowToTask(', start)
  const body = source.slice(start, nextProjection < 0 ? source.length : nextProjection)
  const snapshot = body.indexOf('createRunHistoryBatchSnapshot(')
  const loop = body.indexOf('for (const t of wanted)')
  return (
    snapshot >= 0 && loop > snapshot && !body.slice(loop).includes('createRunHistoryBatchSnapshot(')
  )
}

test('failure-code batching builds one snapshot outside the task loop, with a negative control', () => {
  expect(
    failureSnapshotBeforeLoop(readFileSync(resolve(backend, 'src/services/task.ts'), 'utf8')),
  ).toBe(true)
  expect(
    failureSnapshotBeforeLoop(
      'export async function loadTaskFailureCodes() { const snapshot = createRunHistoryBatchSnapshot(rows); for (const t of wanted) {} } function rowToTask(',
    ),
  ).toBe(true)
  expect(
    failureSnapshotBeforeLoop(
      'export async function loadTaskFailureCodes() { for (const t of wanted) { createRunHistoryBatchSnapshot(rows); } } function rowToTask(',
    ),
  ).toBe(false)
})
