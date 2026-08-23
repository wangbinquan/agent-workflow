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
  // RFC-297: 四张同类叶子表合并为一张按 driver 表态选列的通用表。
  ['components/inventory/InventoryFaceTable.tsx', 'runtime inventory drawer leaf'],
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

// RFC-317 T13 —— 语料非空（守卫的守卫：architecture/rfc317-guard-corpus-floor.test.ts）。
//
// 上面每条断言的绿都可能来自两处：真的没有违规，或者**扫描根失效、语料被筛成空**。
// 两者在断言层面同形，后者是永久静默的假绿。这一条把「扫描器还活着」变成可断言事实；
// 下限同时两向钉进 architecture/guard-manifest.json，静默调低会红。
describe('RFC-317 T13 —— 语料非空', () => {
  test('扫描确实覆盖到源码语料（扫空即假绿）', () => {
    expect(SOURCES.length).toBeGreaterThanOrEqual(250)
  })
})

// RFC-317 T14 —— 负 fixture：把伪造的 JSX 喂给**扫描用的同一组 AST 判据**。
//
// 这几条 ratchet 的结论全部经过 `isIntrinsic` / `isNonTextInput` 这两道判据。它们
// 认不出的形态就不会进违规集合，而断言恰恰是「违规集合为空」——判据被收窄和源码
// 真的合规，在断言层面完全同形。
describe('RFC-317 T14 —— matcher 自证：JSX 判据的边界', () => {
  const parse = (text: string): ts.SourceFile =>
    ts.createSourceFile('probe.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

  const firstOpening = (text: string): ts.JsxOpeningLikeElement => {
    let found: ts.JsxOpeningLikeElement | undefined
    walk(parse(text), (node) => {
      if (
        found === undefined &&
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      ) {
        found = node
      }
    })
    if (found === undefined) throw new Error('fixture 里没有 JSX 开标签')
    return found
  }

  test('原生标签认得出，同名自定义组件不算原生（大小写是唯一区别，最容易写反）', () => {
    expect(isIntrinsic(firstOpening('<input type="text" />'), 'input')).toBe(true)
    expect(isIntrinsic(firstOpening('<Input type="text" />'), 'input')).toBe(false)
  })

  test('非文本 input 的四种 type 都豁免，文本类不豁免', () => {
    for (const type of ['hidden', 'file', 'checkbox', 'radio']) {
      const attribute = jsxAttribute(firstOpening(`<input type="${type}" />`).attributes, 'type')
      expect(isNonTextInput(attribute), `${type} 应豁免`).toBe(true)
    }
    const text = jsxAttribute(firstOpening('<input type="text" />').attributes, 'type')
    expect(isNonTextInput(text)).toBe(false)
  })

  test('表达式形态的 type 也解析（三元里全是非文本才豁免，混了文本就不豁免）', () => {
    const allNonText = jsxAttribute(
      firstOpening('<input type={a ? "checkbox" : "radio"} />').attributes,
      'type',
    )
    expect(isNonTextInput(allNonText)).toBe(true)
    const mixed = jsxAttribute(
      firstOpening('<input type={a ? "checkbox" : "text"} />').attributes,
      'type',
    )
    expect(isNonTextInput(mixed)).toBe(false)
  })

  test('没写 type 的 input 不豁免（默认就是文本框）', () => {
    expect(isNonTextInput(jsxAttribute(firstOpening('<input />').attributes, 'type'))).toBe(false)
  })
})
