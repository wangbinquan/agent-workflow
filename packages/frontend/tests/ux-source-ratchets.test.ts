// RFC-198 — whole-frontend source ratchets for the UX contracts that are easy
// to regress outside an individual route test. Findings include path:line so a
// newly added surface cannot hide behind a broad directory exception.

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, test } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '../src')

interface ParsedSource {
  file: string
  body: string
  ast: ts.SourceFile
}

function sourceFiles(directory = SRC): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) return sourceFiles(absolute)
      return /\.(?:ts|tsx)$/.test(entry.name) ? [absolute] : []
    })
    .sort((a, b) => a.localeCompare(b))
}

const SOURCES: ParsedSource[] = sourceFiles().map((absolute) => {
  const file = path.relative(SRC, absolute).split(path.sep).join('/')
  const body = readFileSync(absolute, 'utf8')
  return {
    file,
    body,
    ast: ts.createSourceFile(
      file,
      body,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  }
})

function lineOf(source: ParsedSource, node: ts.Node): number {
  return source.ast.getLineAndCharacterOfPosition(node.getStart(source.ast)).line + 1
}

function walk(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node)
  ts.forEachChild(node, (child) => walk(child, visitor))
}

function jsxAttribute(attributes: ts.JsxAttributes, name: string): ts.JsxAttribute | undefined {
  return attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === name,
  )
}

function isIntrinsic(node: ts.JsxOpeningLikeElement, tagName: string): boolean {
  return ts.isIdentifier(node.tagName) && node.tagName.text === tagName
}

function hasJsxElementAncestor(node: ts.Node, componentName: string): boolean {
  let ancestor = node.parent
  while (ancestor !== undefined) {
    if (
      ts.isJsxElement(ancestor) &&
      ts.isIdentifier(ancestor.openingElement.tagName) &&
      ancestor.openingElement.tagName.text === componentName
    ) {
      return true
    }
    ancestor = ancestor.parent
  }
  return false
}

const NATIVE_DIALOG_CALLS = new Set(['alert', 'prompt', 'confirm'])
const NATIVE_GLOBALS = new Set(['window', 'globalThis', 'self'])

const ROLE_DIALOG_ALLOWLIST = new Map([
  ['components/Dialog.tsx', 'shared modal primitive'],
  ['components/review/ReviewDocPane.tsx', 'non-modal selection popover'],
  [
    'components/workflow-editor/ValidationPanel.tsx',
    'non-modal anchored validation detail on wide editor surfaces',
  ],
  // RFC-211 §12: the spotlight-tour bubble is a non-modal coach-mark anchored to
  // a real page element — the page under it stays interactive by design (you
  // click the highlighted control), so it must NOT be a focus-trapping Dialog.
  ['components/tour/SpotlightTour.tsx', 'non-modal spotlight-tour coach-mark'],
])

const INPUT_IMPLEMENTATION_ALLOWLIST = new Map([
  ['components/Form.tsx', 'shared TextInput and NumberInput implementation'],
  ['components/Select.tsx', 'shared searchable combobox implementation'],
  ['components/MultiSelect.tsx', 'shared multi-select combobox implementation'],
  ['components/ChipsInput.tsx', 'shared token input implementation'],
  ['components/UserPicker.tsx', 'shared user combobox implementation'],
  ['components/canvas/EdgeInspector.tsx', 'commit-on-blur canvas edge editor'],
  ['components/canvas/EditorSidebar.tsx', 'canvas palette search field'],
  ['components/canvas/inspector/InputEdit.tsx', 'typed canvas number editors'],
  ['components/canvas/inspector/OutputEdit.tsx', 'indexed canvas binding editor'],
  ['components/canvas/inspector/WrapperGitLoopEdit.tsx', 'indexed wrapper binding editor'],
])

const NON_TEXT_INPUT_TYPES = new Set(['hidden', 'file', 'checkbox', 'radio'])

function isNonTextInput(attribute: ts.JsxAttribute | undefined): boolean {
  const initializer = attribute?.initializer
  if (initializer === undefined) return false
  if (ts.isStringLiteral(initializer)) return NON_TEXT_INPUT_TYPES.has(initializer.text)
  if (!ts.isJsxExpression(initializer) || initializer.expression === undefined) return false
  const literals: string[] = []
  walk(initializer.expression, (node) => {
    if (ts.isStringLiteral(node)) literals.push(node.text)
  })
  return literals.length > 0 && literals.every((value) => NON_TEXT_INPUT_TYPES.has(value))
}

// These are leaf table renderers embedded in RuntimeInventorySection's drawer;
// the drawer is the scroll viewport and these are not standalone page tables.
const EMBEDDED_TABLE_ALLOWLIST = new Map([
  ['components/inventory/AgentsTable.tsx', 'runtime inventory drawer leaf'],
  ['components/inventory/McpsTable.tsx', 'runtime inventory drawer leaf'],
  ['components/inventory/PluginsTable.tsx', 'runtime inventory drawer leaf'],
  ['components/inventory/SkillsTable.tsx', 'runtime inventory drawer leaf'],
])

describe('RFC-198 global UX source ratchets', () => {
  test('production has no native alert/prompt/confirm call', () => {
    const violations: string[] = []
    for (const source of SOURCES) {
      walk(source.ast, (node) => {
        if (!ts.isCallExpression(node)) return
        const expression = node.expression
        const isBare = ts.isIdentifier(expression) && NATIVE_DIALOG_CALLS.has(expression.text)
        const isGlobalProperty =
          ts.isPropertyAccessExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          NATIVE_GLOBALS.has(expression.expression.text) &&
          NATIVE_DIALOG_CALLS.has(expression.name.text)
        if (isBare || isGlobalProperty) {
          violations.push(
            `${source.file}:${lineOf(source, node)} ${expression.getText(source.ast)}`,
          )
        }
      })
    }
    expect(violations).toEqual([])
  })

  test('modal dialog semantics are owned by Dialog, with documented non-modal exceptions', () => {
    const violations: string[] = []
    for (const source of SOURCES) {
      walk(source.ast, (node) => {
        if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return
        const role = jsxAttribute(node.attributes, 'role')?.initializer
        if (role === undefined || !ts.isStringLiteral(role) || role.text !== 'dialog') return
        if (!ROLE_DIALOG_ALLOWLIST.has(source.file)) {
          violations.push(`${source.file}:${lineOf(source, node)} role="dialog"`)
        }
      })
    }
    expect(violations).toEqual([])
  })

  test('ordinary text inputs use shared form controls outside explicit editor implementations', () => {
    const violations: string[] = []
    for (const source of SOURCES) {
      walk(source.ast, (node) => {
        if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return
        if (!isIntrinsic(node, 'input')) return
        if (isNonTextInput(jsxAttribute(node.attributes, 'type'))) return
        if (INPUT_IMPLEMENTATION_ALLOWLIST.has(source.file)) return
        violations.push(`${source.file}:${lineOf(source, node)} bare text-like <input>`)
      })
    }
    expect(violations).toEqual([])
  })

  test('all textareas are rendered by the shared TextArea primitive', () => {
    const violations: string[] = []
    for (const source of SOURCES) {
      walk(source.ast, (node) => {
        if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return
        if (!isIntrinsic(node, 'textarea') || source.file === 'components/Form.tsx') return
        violations.push(`${source.file}:${lineOf(source, node)} bare <textarea>`)
      })
    }
    expect(violations).toEqual([])
  })

  test('standalone native tables opt into TableViewport', () => {
    const violations: string[] = []
    for (const source of SOURCES) {
      walk(source.ast, (node) => {
        if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return
        if (!isIntrinsic(node, 'table') || EMBEDDED_TABLE_ALLOWLIST.has(source.file)) return
        if (!hasJsxElementAncestor(node, 'TableViewport')) {
          violations.push(
            `${source.file}:${lineOf(source, node)} native table has no TableViewport owner`,
          )
        }
      })
    }
    expect(violations).toEqual([])
  })

  test('retired local chrome and theme patches do not return', () => {
    const css = readFileSync(path.resolve(SRC, 'styles.css'), 'utf8')
    expect(css.match(/\.form-field__label\s*\{/g)).toHaveLength(1)
    expect(css).not.toMatch(/\.skill-import\s+\.btn--primary/)
    expect(css).not.toMatch(/\.users-create-form\s+(?:input|select)/)
    expect(css).not.toMatch(/\.account-card\s*\{/)
    expect(css).not.toContain('.account-form__field')
    expect(css).not.toMatch(/\.account-form\s+input/)
    expect(css).not.toMatch(/\.oidc-form__(?:field|label|hint|toggle|error)\b/)
    expect(css).not.toMatch(/\.oidc-form\s+input/)
    expect(css).not.toMatch(/\.auth-tabs(?:__|\s*\{)/)
    expect(css).not.toMatch(/\.auth-form\s+(?:label|input)/)
    expect(css).not.toContain('.auth-form__error')
    for (const selector of [
      'review-decision-dialog__overlay',
      'review-decision-dialog__panel',
      'review-decision-dialog__header',
      'review-decision-dialog__close',
      'review-decision-dialog__body',
      'review-decision-dialog__actions',
    ]) {
      expect(css, selector).not.toContain(`.${selector}`)
    }
  })
})
