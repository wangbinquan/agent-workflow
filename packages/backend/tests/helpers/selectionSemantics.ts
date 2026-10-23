// RFC-395 II-a A3：定位 familyHistory 消费点，使语义账本随代码变化失效而非静默漂移。
import ts from 'typescript'

export interface FamilyHistorySite {
  readonly site: string
  readonly path: string
  readonly symbol: string
  readonly ordinal: number
  readonly source: string
}

export function familyHistorySites(path: string, text: string): FamilyHistorySite[] {
  path = path.replaceAll('\\', '/')
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const ordinals = new Map<string, number>()
  const sites: FamilyHistorySite[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ((ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'familyHistory') ||
        (ts.isElementAccessExpression(node.expression) &&
          ts.isStringLiteral(node.expression.argumentExpression) &&
          node.expression.argumentExpression.text === 'familyHistory'))
    ) {
      let parent: ts.Node | undefined = node.parent
      let symbol = 'module'
      while (parent !== undefined) {
        if (ts.isFunctionDeclaration(parent) && parent.name !== undefined) {
          symbol = parent.name.text
          break
        }
        if (ts.isMethodDeclaration(parent)) {
          symbol = parent.name.getText(source)
          break
        }
        if (
          (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
          ts.isVariableDeclaration(parent.parent)
        ) {
          symbol = parent.parent.name.getText(source)
          break
        }
        parent = parent.parent
      }
      const ordinal = (ordinals.get(symbol) ?? 0) + 1
      ordinals.set(symbol, ordinal)
      sites.push({
        site: `${path}#${symbol}:${ordinal}`,
        path,
        symbol,
        ordinal,
        source: node.getText(source).replace(/\s+/g, ' '),
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return sites
}

/** Both the live guard and its negative controls use this two-way comparison. */
export function selectionSemanticsViolations(
  actual: readonly Pick<FamilyHistorySite, 'site' | 'source'>[],
  expected: readonly Pick<FamilyHistorySite, 'site' | 'source'>[],
): string[] {
  const errors: string[] = []
  for (const [label, sites] of [
    ['actual', actual],
    ['ledger', expected],
  ] as const) {
    const seen = new Set<string>()
    for (const entry of sites) {
      if (seen.has(entry.site)) errors.push(`${label}:duplicate:${entry.site}`)
      seen.add(entry.site)
    }
  }
  for (const entry of actual) {
    const recorded = expected.find((candidate) => candidate.site === entry.site)
    if (recorded === undefined) errors.push(`unrecorded:${entry.site}`)
    else if (recorded.source !== entry.source) errors.push(`changed:${entry.site}`)
  }
  for (const entry of expected) {
    if (!actual.some((candidate) => candidate.site === entry.site))
      errors.push(`missing:${entry.site}`)
  }
  return errors.sort()
}
