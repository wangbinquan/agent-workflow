// RFC-198 PR4 — source ratchet for the semantic split between true tabs and
// filters/view-mode pickers (design.md §6.1).
//
// A new <TabBar> callsite must be deliberately classified below. Page-section
// links such as Settings deliberately stay out of this list. True tabs
// carry a stable, page-unique idPrefix and expose a matching tabpanel through
// either <TabPanels> or tabDomIds(). Filters stay on <Segmented> radio
// semantics. The two vertical diff file selectors are separately classified
// manual true tabs: they keep their tree-shaped keyboard model, but still must
// expose stable tab/control/panel associations.

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, test } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '../src')

interface SourceUnit {
  file: string
  source: string
  ast: ts.SourceFile
  constants: Map<string, string>
}

interface JsxCallsite {
  unit: SourceUnit
  node: ts.JsxOpeningLikeElement
}

function listTsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return listTsxFiles(full)
      return entry.name.endsWith('.tsx') ? [full] : []
    })
    .sort()
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    return unwrapExpression(expression.expression)
  }
  if (ts.isParenthesizedExpression(expression)) return unwrapExpression(expression.expression)
  return expression
}

function stringConstants(ast: ts.SourceFile): Map<string, string> {
  const constants = new Map<string, string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const initializer = unwrapExpression(node.initializer)
      if (ts.isStringLiteralLike(initializer)) constants.set(node.name.text, initializer.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return constants
}

const units: SourceUnit[] = listTsxFiles(SRC).map((absoluteFile) => {
  const source = readFileSync(absoluteFile, 'utf8')
  const ast = ts.createSourceFile(
    absoluteFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  return {
    file: path.relative(SRC, absoluteFile),
    source,
    ast,
    constants: stringConstants(ast),
  }
})

function jsxCallsites(unit: SourceUnit, tagName?: string): JsxCallsite[] {
  const matches: JsxCallsite[] = []
  const visit = (node: ts.Node): void => {
    const opening = ts.isJsxSelfClosingElement(node)
      ? node
      : ts.isJsxElement(node)
        ? node.openingElement
        : undefined
    if (
      opening !== undefined &&
      (tagName === undefined || opening.tagName.getText(unit.ast) === tagName)
    ) {
      matches.push({ unit, node: opening })
    }
    ts.forEachChild(node, visit)
  }
  visit(unit.ast)
  return matches
}

function attribute(callsite: JsxCallsite, name: string): ts.JsxAttribute | undefined {
  return callsite.node.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText(callsite.unit.ast) === name,
  )
}

function attributeExpression(callsite: JsxCallsite, name: string): ts.Expression | undefined {
  const initializer = attribute(callsite, name)?.initializer
  if (initializer === undefined) return undefined
  if (ts.isStringLiteral(initializer)) return initializer
  if (ts.isJsxExpression(initializer)) return initializer.expression
  return undefined
}

function resolveStaticString(unit: SourceUnit, expression: ts.Expression): string | undefined {
  const value = unwrapExpression(expression)
  if (ts.isStringLiteralLike(value)) return value.text
  if (ts.isIdentifier(value)) return unit.constants.get(value.text)
  return undefined
}

function staticAttribute(callsite: JsxCallsite, name: string): string | undefined {
  const expression = attributeExpression(callsite, name)
  return expression === undefined ? undefined : resolveStaticString(callsite.unit, expression)
}

function rawAttribute(callsite: JsxCallsite, name: string): string | undefined {
  const expression = attributeExpression(callsite, name)
  return expression?.getText(callsite.unit.ast)
}

function location(callsite: JsxCallsite): string {
  const line = callsite.unit.ast.getLineAndCharacterOfPosition(callsite.node.getStart()).line + 1
  return `${callsite.unit.file}:${line}`
}

function callsNamed(unit: SourceUnit, functionName: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === functionName
    ) {
      calls.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(unit.ast)
  return calls
}

// This is intentionally exact. Adding TabBar to a filter should not silently
// pass just because it also supplied ids; a reviewer must classify a new true
// tab surface here. AgentForm is a reusable owner whose concrete prefixes are
// checked at every production <AgentForm> callsite below.
const TRUE_TAB_CALLSITES = [
  'components/AgentForm.tsx::{idPrefix}',
  'components/AgentImportDialog.tsx::agent-import-source',
  'components/NodeDetailDrawer.tsx::node-detail-drawer',
  'components/canvas/NodeInspector.tsx::workflow-node-inspector',
  'routes/auth.tsx::auth-method',
  'routes/mcps.detail.tsx::mcps-detail',
  'routes/plugins.detail.tsx::plugins-detail',
  'routes/skills.detail.tsx::skills-detail',
  'routes/skills.new.tsx::skills-new',
] as const

const FILTER_SEGMENTED_CALLSITES = [
  'components/memory/MemoryAllList.tsx',
  'routes/clarify.tsx',
  'routes/reviews.detail.tsx',
  'routes/reviews.tsx',
] as const

const VERTICAL_TRUE_TAB_CALLSITES = {
  'components/TaskOutputPanel.tsx': { tablist: 1, tab: 1 },
  'components/WorktreeDiffPanel.tsx': { tablist: 1, tab: 1 },
  'components/structure/StructuralDiffView.tsx': { tablist: 1, tab: 1 },
} as const

describe('RFC-198 true-tab callsite contract', () => {
  test('every TabBar is classified and carries a stable idPrefix', () => {
    const tabBars = units.flatMap((unit) => jsxCallsites(unit, 'TabBar'))
    const missingPrefix = tabBars.filter(
      (callsite) => attribute(callsite, 'idPrefix') === undefined,
    )
    expect(missingPrefix.map(location), 'TabBar callsites missing idPrefix').toEqual([])

    const actual = tabBars
      .map((callsite) => {
        const prefix =
          staticAttribute(callsite, 'idPrefix') ??
          `{${rawAttribute(callsite, 'idPrefix') ?? 'unknown'}}`
        return `${callsite.unit.file}::${prefix}`
      })
      .sort()
    expect(actual).toEqual([...TRUE_TAB_CALLSITES].sort())
  })

  test('every TabBar has exactly one accessible-name mechanism', () => {
    const tabBars = units.flatMap((unit) => jsxCallsites(unit, 'TabBar'))
    const missingName = tabBars.filter(
      (callsite) =>
        attribute(callsite, 'ariaLabel') === undefined &&
        attribute(callsite, 'ariaLabelledBy') === undefined,
    )
    const duplicateName = tabBars.filter(
      (callsite) =>
        attribute(callsite, 'ariaLabel') !== undefined &&
        attribute(callsite, 'ariaLabelledBy') !== undefined,
    )

    expect(missingName.map(location), 'TabBar callsites missing an accessible name').toEqual([])
    expect(duplicateName.map(location), 'TabBar callsites must not supply both names').toEqual([])
  })

  test('every TabBar prefix is associated with a matching tabpanel', () => {
    const failures: string[] = []
    for (const unit of units) {
      const tabBars = jsxCallsites(unit, 'TabBar')
      const tabPanels = jsxCallsites(unit, 'TabPanels')
      const helperPrefixes = callsNamed(unit, 'tabDomIds').flatMap((call) => {
        const firstArgument = call.arguments[0]
        if (firstArgument === undefined) return []
        const prefix = resolveStaticString(unit, firstArgument)
        return prefix === undefined ? [] : [prefix]
      })

      for (const tabBar of tabBars) {
        const resolvedPrefix = staticAttribute(tabBar, 'idPrefix')
        const rawPrefix = rawAttribute(tabBar, 'idPrefix')
        const hasMatchingTabPanels = tabPanels.some((panels) => {
          const panelPrefix = staticAttribute(panels, 'idPrefix')
          if (resolvedPrefix !== undefined) return panelPrefix === resolvedPrefix
          return rawAttribute(panels, 'idPrefix') === rawPrefix
        })
        const hasManualPanel =
          resolvedPrefix !== undefined &&
          helperPrefixes.includes(resolvedPrefix) &&
          /(?:role\s*=\s*["']tabpanel["']|role\s*:\s*["']tabpanel["'])/.test(unit.source)
        if (!hasMatchingTabPanels && !hasManualPanel) failures.push(location(tabBar))
      }
    }
    expect(failures, 'TabBar callsites without a same-prefix TabPanels/tabDomIds panel').toEqual([])
  })

  test('all concrete AgentForm owners provide unique stable prefixes', () => {
    const agentForms = units.flatMap((unit) => jsxCallsites(unit, 'AgentForm'))
    const missingOrDynamic = agentForms.filter(
      (callsite) => staticAttribute(callsite, 'idPrefix') === undefined,
    )
    expect(
      missingOrDynamic.map(location),
      'AgentForm owners need a literal stable idPrefix',
    ).toEqual([])

    const directPrefixes = units
      .flatMap((unit) => jsxCallsites(unit, 'TabBar'))
      .filter((callsite) => callsite.unit.file !== 'components/AgentForm.tsx')
      .map((callsite) => staticAttribute(callsite, 'idPrefix'))
      .filter((prefix): prefix is string => prefix !== undefined)
    const ownerPrefixes = agentForms
      .map((callsite) => staticAttribute(callsite, 'idPrefix'))
      .filter((prefix): prefix is string => prefix !== undefined)
    const allPrefixes = [...directPrefixes, ...ownerPrefixes]
    expect(new Set(allPrefixes).size, `duplicate tab idPrefix: ${allPrefixes.join(', ')}`).toBe(
      allPrefixes.length,
    )
  })
})

describe('RFC-198 filters are not tabs', () => {
  test('the named filters/view modes use Segmented without tab semantics', () => {
    for (const file of FILTER_SEGMENTED_CALLSITES) {
      const unit = units.find((candidate) => candidate.file === file)
      expect(unit, `${file} is missing`).toBeDefined()
      if (unit === undefined) continue
      expect(
        jsxCallsites(unit, 'Segmented').length,
        `${file} must render Segmented`,
      ).toBeGreaterThan(0)
      expect(jsxCallsites(unit, 'TabBar').map(location), `${file} must not render TabBar`).toEqual(
        [],
      )
      const tabRoles = jsxCallsites(unit).filter((callsite) => {
        const role = staticAttribute(callsite, 'role')
        return role === 'tab' || role === 'tablist' || role === 'tabpanel'
      })
      expect(tabRoles.map(location), `${file} must not expose tab/tabpanel roles`).toEqual([])
    }
  })

  test('hand-rolled tab roles are classified and vertical selectors link real panels', () => {
    const tabBarImplementation = 'components/TabBar.tsx'
    const actual = new Map<string, { tablist: number; tab: number }>()
    for (const unit of units) {
      if (unit.file === tabBarImplementation) continue
      for (const callsite of jsxCallsites(unit)) {
        const role = staticAttribute(callsite, 'role')
        if (role !== 'tablist' && role !== 'tab') continue
        const counts = actual.get(unit.file) ?? { tablist: 0, tab: 0 }
        counts[role] += 1
        actual.set(unit.file, counts)
      }
    }

    const expected = new Map(Object.entries(VERTICAL_TRUE_TAB_CALLSITES))

    expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(expected))
    for (const file of Object.keys(VERTICAL_TRUE_TAB_CALLSITES)) {
      const unit = units.find((candidate) => candidate.file === file)
      expect(unit?.source).toContain('aria-orientation="vertical"')
      expect(unit === undefined ? [] : jsxCallsites(unit, 'TabBar')).toEqual([])
      const tabs =
        unit === undefined
          ? []
          : jsxCallsites(unit).filter((c) => staticAttribute(c, 'role') === 'tab')
      expect(tabs.every((tab) => attribute(tab, 'id') !== undefined)).toBe(true)
      expect(tabs.every((tab) => attribute(tab, 'aria-controls') !== undefined)).toBe(true)
      const panels =
        unit === undefined
          ? []
          : jsxCallsites(unit).filter((c) => staticAttribute(c, 'role') === 'tabpanel')
      expect(panels).toHaveLength(1)
      expect(attribute(panels[0]!, 'id')).toBeDefined()
      expect(attribute(panels[0]!, 'aria-labelledby')).toBeDefined()
    }
  })

  test('Segmented itself exposes radio, never tab, semantics', () => {
    const unit = units.find((candidate) => candidate.file === 'components/Segmented.tsx')
    expect(unit).toBeDefined()
    if (unit === undefined) return
    const roles = jsxCallsites(unit)
      .map((callsite) => staticAttribute(callsite, 'role'))
      .filter((role): role is string => role !== undefined)
    expect(roles).toEqual(expect.arrayContaining(['radiogroup', 'radio']))
    expect(roles).not.toEqual(expect.arrayContaining(['tablist', 'tab', 'tabpanel']))
  })
})
