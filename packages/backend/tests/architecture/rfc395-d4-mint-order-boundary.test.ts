// RFC-395 D4: epoch-2 reads never see a NULL seq, so nothing outside the conversion oracle may keep
// the epoch-1 mint order: no NULL-first / ID fallback, no ID-only lineage anchor, no nullable seq in
// a NodeRun view and no `seq === null` branch. The run-selection boundary guard only scans backend
// business code; this one also covers the shared package and the frontend, where the fallback
// survived until 2026-10-29 (packages/shared/src/nodeRunOrder.ts, task-questions.ts resolveHandlerRun).
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { packageSrcUnits, sourceUnit, type SourceUnit } from './census'

// Walks every backend, shared and frontend AST; full-source guards here took up to 5.5 s on
// backend-macos-nightly (run 40859820668), so allow 30 s.
setDefaultTimeout(30_000)

const root = resolve(import.meta.dir, '../../../..')
/** The conversion oracle and the converter keep the epoch-1 order on purpose. */
const migration = 'packages/backend/src/modules/task-execution/infrastructure/migration/'
const legacyNames = new Set([
  'compareLegacyNodeRunMintOrder',
  'isNewerLegacyNodeRun',
  'legacyNodeRunOrderAnchor',
  'nodeRunOrderAnchor',
])
// Exact `path|text` exceptions, each with its reason. They may only shrink.
const exceptions = new Map<string, string>([
  [
    'packages/backend/src/modules/task-execution/domain/runSelection/legacyFacts.ts|readonly seq?: number | null',
    'frozen epoch-1 row facts the converter reads before it numbers the rows; missing ≠ NULL',
  ],
])

type Rule = 'legacy-order-name' | 'nullable-seq' | 'seq-null-check'

export function mintOrderHits(unit: SourceUnit): string[] {
  const hits: string[] = []
  const add = (rule: Rule, node: ts.Node) =>
    hits.push(`${rule}:${unit.path}|${node.getText(unit.source).replace(/\s+/g, ' ')}`)
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && legacyNames.has(node.text)) add('legacy-order-name', node)
    if (
      (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'seq' &&
      node.type !== undefined &&
      ts.isUnionTypeNode(node.type) &&
      node.type.types.some(
        (member) =>
          ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword,
      )
    )
      add('nullable-seq', node)
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(node.operatorToken.kind)
    ) {
      const [left, right] = [node.left, node.right]
      const isSeq = (side: ts.Expression) =>
        (ts.isPropertyAccessExpression(side) && side.name.text === 'seq') ||
        (ts.isIdentifier(side) && side.text === 'seq')
      const isNull = (side: ts.Expression) => side.kind === ts.SyntaxKind.NullKeyword
      if ((isSeq(left) && isNull(right)) || (isNull(left) && isSeq(right)))
        add('seq-null-check', node)
    }
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  return hits
}

const UNITS: readonly SourceUnit[] = [
  ...packageSrcUnits(root, 'backend').filter((unit) => !unit.path.startsWith(migration)),
  ...packageSrcUnits(root, 'shared'),
  ...packageSrcUnits(root, 'frontend'),
]

describe('RFC-395 D4 mint order boundary', () => {
  test('backend, shared and frontend sources keep no epoch-1 mint order outside the oracle', () => {
    expect(UNITS.length).toBeGreaterThanOrEqual(3000)
    const hits = UNITS.flatMap(mintOrderHits)
    const unexplained = hits.filter((hit) => !exceptions.has(hit.slice(hit.indexOf(':') + 1)))
    expect(unexplained).toEqual([])
    // Every exception still matches: a fixed site must leave the list.
    const matched = new Set(hits.map((hit) => hit.slice(hit.indexOf(':') + 1)))
    expect([...exceptions.keys()].filter((key) => !matched.has(key))).toEqual([])
  })

  test('negative controls flag each epoch-1 shape and leave allocated seq alone', () => {
    const rules = (text: string, path = 'packages/frontend/src/sample.tsx') =>
      mintOrderHits(sourceUnit(path, text)).map((hit) => hit.slice(0, hit.indexOf(':')))
    expect(rules("import { nodeRunOrderAnchor } from '@agent-workflow/shared'")).toEqual([
      'legacy-order-name',
    ])
    expect(rules('const a = compareLegacyNodeRunMintOrder(x, y)')).toEqual(['legacy-order-name'])
    expect(rules('interface Row { readonly seq: number | null }')).toEqual(['nullable-seq'])
    expect(rules('type Row = { seq?: null | number }')).toEqual(['nullable-seq'])
    expect(rules('if (row.seq === null) return')).toEqual(['seq-null-check'])
    expect(rules('const fresh = null != anchor.seq')).toEqual(['seq-null-check'])
    expect(rules('interface Row { readonly seq: number }')).toEqual([])
    expect(rules('const next = (last?.seq ?? 0) + 1')).toEqual([])
    expect(rules('if (row.seq > latest.seq) pick(row)')).toEqual([])
  })
})
