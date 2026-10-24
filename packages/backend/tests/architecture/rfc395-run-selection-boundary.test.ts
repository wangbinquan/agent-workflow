// RFC-395 II-a A3 item 9: business sites must consume run-selection ports so II-b can
// replace the oracle without leaving private pickers, SQL ranking, or cross-context row reads.
// Epoch-1 migration/display/owner-SQL exceptions are exact, two-way, and may only shrink.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import ts from 'typescript'
import ledger from '../fixtures/rfc395-run-selection-boundary-ledger.json'

const backend = resolve(import.meta.dir, '../..')
const oracle = 'src/modules/task-execution/infrastructure/runSelection/'
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
// Initial reviewed fingerprints. Removal is allowed; new exceptions require another approved stage.
const initialExceptions = new Set<string>([
  // RFC-395 II-a A3: reviewed unchanged boot replay and bounded wrapper prefilter from HEAD.
  'e6d6a63ab426eba3cc1a87af3f2f8ad3cb734cf385911346e8ddd4763fdb5391',
  '3efd68547d78c2525e9cf809945ba31a548d9ae269141ce87da740673e10ca26',

  'dc7e65bb3fb367df2f8e5143d3ae29c7942dc02ab96bfa23cb2744aa21397455',
  '530da06e7973f42c971711c49774b4e043de8f6857d326389f4406c2f675ea38',
  'ee35b3f1d3d2bc45c5b1fecb5b8db153a5318a0f8c3bb5884bf457dbd6f9ca5b',
  '3c50fe1a2bdc4efe6162ea03815a9ac220ebf1ef7b2bafb96f13418be3adafa5',
  'c757ba18c3558029bfedbab896c09f39b677d5b99403fef35d4406a0cc34b02f',
  'f753214d95cd281e980963a39912684ad3b23541504a96b631169bfda50a27ad',
  '60832c33c7975e63a9577ae87e210ccc4fadad1a007df43d259b0d91387cd9bb',
  'f5f84d7395607ab7c93a448c0cfe2e6a418aedaba8a0ebc1aa1149f39a88a589',
  'c86c83957d2fda3563f6ee8f07374a7aa0f8c329d5039ccf1386e715ee6dddc6',
  // RFC-395 II-b O3: unchanged timeline statement moved into Task; replace, do not grow the exception.
  '29eb898f100b67a03ef22ea44a0574c1afc71602bac4e2171773a52ff8620dc7',
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
  if (path.startsWith(oracle)) return []
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
      expect(entry.removeBy).toBe('II-b')
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
  const snapshot = body.indexOf('createRunSelectionOracleSnapshot(')
  const loop = body.indexOf('for (const t of wanted)')
  return (
    snapshot >= 0 &&
    loop > snapshot &&
    !body.slice(loop).includes('createRunSelectionOracleSnapshot(')
  )
}

test('failure-code batching builds one snapshot outside the task loop, with a negative control', () => {
  expect(
    failureSnapshotBeforeLoop(readFileSync(resolve(backend, 'src/services/task.ts'), 'utf8')),
  ).toBe(true)
  expect(
    failureSnapshotBeforeLoop(
      'export async function loadTaskFailureCodes() { const snapshot = createRunSelectionOracleSnapshot(rows); for (const t of wanted) {} } function rowToTask(',
    ),
  ).toBe(true)
  expect(
    failureSnapshotBeforeLoop(
      'export async function loadTaskFailureCodes() { for (const t of wanted) { createRunSelectionOracleSnapshot(rows); } } function rowToTask(',
    ),
  ).toBe(false)
})
