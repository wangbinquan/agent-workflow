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

// RFC-317 T60（findings G-06）—— 三条**全前端**规则。
//
// 改造前前端的设计系统约束是**逐文件迁移白名单**，不是棘轮：
//   · `dialog-grep.test.ts` 只断言三个点名文件用了 `<Dialog>`；
//   · `data-table-callsite.test.ts` 点名四个；`empty-loading-callsite.test.ts` 点名三个路由。
// 于是**新写一个自造的 overlay / 空状态 / 下拉框，一条都不会红**。
// 全前端扫描只有本文件这五条，而它们一条都没管：原生 `<select>`（CLAUDE.md
// §Frontend UI consistency 明令禁止，实测全仓零命中——因为压根没人拦）、
// 新的 `__overlay` / `__panel` class、以及手搓的 `.segmented`。

/**
 * 原生 `<select>` 的白名单——**空的**。
 *
 * 初版把 `Select.tsx` / `MultiSelect.tsx` 列了进去（想当然：公共下拉原语总得用原生
 * 元素吧），下面那条「白名单必须承重」的自证当场报出两条空豁免：这两个组件是**自绘
 * combobox**（div + role=listbox + 自管键盘），它们文件里那两处 `<select` 在注释里，
 * AST 判据正确地一个都没算。空豁免的唯一作用是让人以为「这里有正当特例」。
 */
const NATIVE_SELECT_ALLOWLIST = new Map<string, string>([])

/** 只有 Dialog 原语可以自带 modal chrome 的 class。 */
const MODAL_CHROME_ALLOWLIST = new Map([
  // 与 ROLE_DIALOG_ALLOWLIST 同一个理由：这是宽编辑器上**非模态**的锚定校验详情，
  // 它的 `__overlay` 是自己的定位层，不是 Dialog 那种会抢焦点的遮罩。
  ['components/workflow-editor/ValidationPanel.tsx', 'non-modal anchored validation detail'],
  // `Dialog.tsx` **不在这里**：同样是被自证抓出来的空豁免——它的 overlay 提及全在
  // 注释里（那段注释记的是它替换掉的三个自造实现），实际 className 不含这三个词。
])

/** `.segmented` 家族的 class 只能由公共 `<Segmented>` 渲染。 */
const SEGMENTED_ALLOWLIST = new Map([['components/Segmented.tsx', 'shared segmented primitive']])

// 只认真正表示 modal chrome 的三个词。**`__panel` 不在内**：第一版把它算进去后
// 实测报出 7 处，其中 6 处是布局面板（`agent-form__panel` / `split__detail-body` /
// `workflow-node-picker__panel`）——`panel` 在本仓是个通用词，把它算成 modal 会让
// 这条规则一上来就需要六条豁免，那就等于没规则。
const MODAL_CHROME_RE = /(?:^|[\s-])[\w-]*__(?:overlay|backdrop|modal)(?![\w-])/

/** 一个 JSX 元素的 className 静态字符串（含无插值模板 / 单引号）。 */
function classNameLiterals(node: ts.JsxOpeningLikeElement): string[] {
  const attr = jsxAttribute(node.attributes, 'className')
  const initializer = attr?.initializer
  if (initializer === undefined) return []
  if (ts.isStringLiteral(initializer)) return [initializer.text]
  if (!ts.isJsxExpression(initializer) || initializer.expression === undefined) return []
  const out: string[] = []
  walk(initializer.expression, (inner) => {
    if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) out.push(inner.text)
  })
  return out
}

describe('RFC-317 T60 —— 全前端设计系统规则（不是逐文件白名单）', () => {
  test('原生 <select> 只能出现在两个公共下拉原语里', () => {
    // CLAUDE.md §Frontend UI consistency：「禁止在弹窗内直接落原生 `<select>`，
    // 原生弹层无法和周围 UI 风格对齐」。此前**没有任何守卫**执行这条——
    // 全仓零命中不是因为大家守规矩，是因为没人拦，下一个人随手写一个就进来了。
    const violations: string[] = []
    for (const source of SOURCES) {
      if (NATIVE_SELECT_ALLOWLIST.has(source.file)) continue
      walk(source.ast, (node) => {
        if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return
        if (!isIntrinsic(node, 'select')) return
        violations.push(`${source.file}:${lineOf(source, node)} 原生 <select>`)
      })
    }
    expect(violations, '用 components/Select.tsx 或 MultiSelect.tsx').toEqual([])
  })

  test('modal chrome 的 class（__overlay / __panel / __backdrop / __modal）只归 Dialog', () => {
    const violations: string[] = []
    for (const source of SOURCES) {
      if (MODAL_CHROME_ALLOWLIST.has(source.file)) continue
      walk(source.ast, (node) => {
        if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return
        for (const literal of classNameLiterals(node)) {
          if (!MODAL_CHROME_RE.test(literal)) continue
          violations.push(`${source.file}:${lineOf(source, node)} 自造 modal chrome: ${literal}`)
        }
      })
    }
    expect(violations, '所有 modal / overlay 走 components/Dialog.tsx').toEqual([])
  })

  test('`.segmented` 家族只能由公共 <Segmented> 渲染', () => {
    // 实测反例（RFC-317 T63 同批修）：`JoinModeField` 手搓 `<div className="segmented">`
    // 加两个 `className={... ? 'is-active' : ''}` 的按钮——而 `.segmented .is-active`
    // 在 styles.css 里根本不存在，两个按钮在有样式的胶囊容器里完全没样式，
    // 还丢了 radio 语义与方向键导航。
    const violations: string[] = []
    for (const source of SOURCES) {
      if (SEGMENTED_ALLOWLIST.has(source.file)) continue
      walk(source.ast, (node) => {
        if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return
        const tag = node.tagName.getText(source.ast)
        if (tag === 'Segmented') return
        for (const literal of classNameLiterals(node)) {
          if (!/(?:^|\s)segmented(?:__[\w-]+)?(?:--[\w-]+)?(?:\s|$)/.test(literal)) continue
          violations.push(`${source.file}:${lineOf(source, node)} 手搓 segmented: ${literal}`)
        }
      })
    }
    expect(violations, '用 components/Segmented.tsx').toEqual([])
  })

  test('每条白名单都**承重**：撤掉它，那个文件立刻被报出来（否则该删）', () => {
    // 白名单条目一旦名不副实（文件改过了、模式已经没了），它就只剩「让人以为
    // 这里有特例」的作用。三个 allowlist 一起自证。
    const stale: string[] = []
    const check = (allowlist: Map<string, string>, probe: (source: ParsedSource) => boolean) => {
      for (const file of allowlist.keys()) {
        const source = SOURCES.find((candidate) => candidate.file === file)
        if (source === undefined) {
          stale.push(`${file}: 白名单指向了不存在的文件`)
          continue
        }
        if (!probe(source)) stale.push(`${file}: 已经不含该模式了，这条白名单该删`)
      }
    }
    check(NATIVE_SELECT_ALLOWLIST, (source) => {
      let found = false
      walk(source.ast, (node) => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          if (isIntrinsic(node, 'select')) found = true
        }
      })
      return found
    })
    check(MODAL_CHROME_ALLOWLIST, (source) => {
      let found = false
      walk(source.ast, (node) => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          if (classNameLiterals(node).some((literal) => MODAL_CHROME_RE.test(literal))) found = true
        }
      })
      return found
    })
    check(SEGMENTED_ALLOWLIST, (source) => source.body.includes('segmented__option'))
    expect(stale).toEqual([])
  })
})

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

/**
 * RFC-317 T62（R9.4）—— 公共 class 的选择器不得被**特性名**限定。
 *
 * 改造前 `.dialog__overlay` 这个共享原语必须逐一认识每个用它的业务面板：
 * `.dialog__overlay:has(> .workflow-editor-surface-dialog)`、`:has(> .workflow-validation-dialog)`、
 * `:has(.mobile-nav-dialog)`、`:has(> .script-code-editor-dialog)`。方向是反的——
 * 加第五个面板就要回来改 styles.css，而写新面板的人不会想到。四条已改为
 * 由调用方经 `overlayClassName` 声明的通用变体（`--flush` / `--sheet-start` /
 * `--sheet-end` / `--flush-narrow`）。
 */
const PUBLIC_HAS_FEATURE_RE = /\.dialog__[\w-]+:has\(/g

/** 仍被特性名限定的公共选择器——**只减不增**。 */
const PUBLIC_SELECTOR_FEATURE_DEBT: readonly string[] = [
  // 这四条不是布局，是**主题下把公共按钮改色**：
  // `.dialog__overlay:has(.agent-import) .btn--primary`（dark + 未表态主题各两条）。
  // 收口它需要判断这套配色是不是该进公共 `.btn--primary` 本身（对比度补丁？），
  // 那是一次设计决策，删掉会直接改变外观——不该混进一次「把选择器方向掰正」的改动。
  ":root[data-theme='dark'] .dialog__overlay:has(.agent-import) .btn--primary",
  ":root[data-theme='dark'] .dialog__overlay:has(.agent-import) .btn--primary:hover",
  ':root:not([data-theme]) .dialog__overlay:has(.agent-import) .btn--primary',
  ':root:not([data-theme]) .dialog__overlay:has(.agent-import) .btn--primary:hover',
]

describe('RFC-317 T62（R9.4）—— 公共 class 不得被特性名限定', () => {
  const css = readFileSync(path.resolve(SRC, 'styles.css'), 'utf8')

  test('语料非空：读到的确实是那份 styles.css（读空即假绿）', () => {
    expect(css.length).toBeGreaterThan(100_000)
    expect(css).toContain('.dialog__overlay {')
  })

  test('`.dialog__*:has(...)` 的出现处与债务账本逐条相等', () => {
    const found = [...css.matchAll(/^[^\n{}]*\.dialog__[\w-]+:has\([^\n{}]*/gm)]
      .map((m) =>
        m[0]
          .trim()
          .replace(/\s*\{$/, '')
          .replace(/,$/, ''),
      )
      .filter((line) => !line.startsWith('*') && !line.startsWith('/*'))
      .sort()
    expect(
      found,
      '又出现了「公共 class 被特性名限定」的选择器——方向反了：让特性经 overlayClassName / ' +
        'panelClassName 声明自己要哪种变体，共享 class 不该认识任何特性名。' +
        '反过来，还清一条却没销账也会红',
    ).toEqual([...PUBLIC_SELECTOR_FEATURE_DEBT].sort())
  })

  test('四条布局规则确实换成了通用变体（防回潮）', () => {
    for (const variant of ['flush', 'sheet-start', 'sheet-end', 'flush-narrow']) {
      // 选择器必须写成**双类**形式（特异度 0,2,0）——被替换掉的
      // `.dialog__overlay:has(> .<特性面板>)` 就是这个特异度，需要它压过后面
      // 媒体查询里的 `.dialog__overlay { padding: … }`。初版写成单类，窄屏下被压掉，
      // e2e 的画布几何断言当场变红。
      const selector = `.dialog__overlay.dialog__overlay--${variant} {`
      expect(css.includes(selector), `${selector} 的定义没了（或退回了单类写法）`).toBe(true)
    }
    for (const retired of [
      '.dialog__overlay:has(> .workflow-editor-surface-dialog)',
      '.dialog__overlay:has(> .workflow-validation-dialog)',
      '.dialog__overlay:has(.mobile-nav-dialog)',
      '.dialog__overlay:has(> .script-code-editor-dialog)',
    ]) {
      expect(css.includes(`${retired} {`), `${retired} 又回来了`).toBe(false)
    }
  })

  test('判据自证：伪造一条特性限定选择器必须被抓到', () => {
    const fabricated = '.dialog__overlay:has(> .brand-new-feature-dialog) {\n  padding: 0;\n}'
    expect(PUBLIC_HAS_FEATURE_RE.test(fabricated)).toBe(true)
    PUBLIC_HAS_FEATURE_RE.lastIndex = 0
    expect(PUBLIC_HAS_FEATURE_RE.test('.dialog__overlay--flush {\n  padding: 0;\n}')).toBe(false)
    PUBLIC_HAS_FEATURE_RE.lastIndex = 0
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
