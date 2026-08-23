// RFC-317 T61 · findings FE-02 —— 死 class 的**不变量**（取代 RFC-286 F1 的三名单）。
//
// F1 修的是三个具体名字（`error-text` / `checkbox-row` / `form-error`），守卫也就
// 硬编码了那三个名字。于是**同一类 bug 在别处继续存在，而 F1 看不见**：
//
//   · `page__subtitle`        5 处调用，styles.css 零定义
//   · `form-section__hint`    9 处（而同族的 `__title` / `__body` 都在——不是命名错觉）
//   · `inspector-hint`        7 处
//   · `inspector__readonly`  12 处（本次查出的最大一族，比 finding 点名的任何一个都大；
//                                 两个修饰符还负责表达「这条只读值处于错误/警告状态」）
//   · `dep-tree__empty` / `dep-tree__error`  6 处，而同族有十一条规则；
//                            `dep-tree__error` 带着 `role="alert"`——一条错误提示
//                            被渲染成完全无样式的裸文本
//
// 上面这些已在 T61 同批补齐 CSS。本文件把判据从「这三个名字」换成**规则本身**：
// 每个静态 className token 都必须在 CSS 里有定义，否则进快照；快照**只能缩**。
//
// ⚠️ 判据的两个已知边界，明写而不是假装覆盖：
//   ① **带插值的 className 整条跳过**（`` `chip--${tone}` ``）。拆开会得到 `chip--`
//      这种半截 token，产出一堆假违规——第一版实测多出七十几个。代价是插值形态的
//      死 class 抓不到，收益是这条规则不会被噪音糊住。
//   ② 只看**静态**字符串。`clsx(cond && 'x')` 里的 token 抓得到（它也是引号字符串），
//      但变量拼出来的抓不到。

import { describe, expect, test } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SRC = resolve(import.meta.dirname, '..', 'src')

/** 第三方库自己的 class：xyflow 用它们控制画布交互，CSS 由库提供。 */
const LIBRARY_TOKENS = new Set(['nodrag', 'nopan', 'nowheel'])

/**
 * 开账当天（RFC-317 T61）仍未定义的 token 快照：160 个。
 *
 * **只减不增**：新增一个 ⇒ 红（新 UI 必须要么用公共 class、要么把规则写进 CSS）；
 * 修掉一个却不销账 ⇒ 也红（差额会变成下一个人的免费槽位）。
 *
 * 这份名单里绝大多数是「BEM 块根名」——`.review-detail__x` 定义了而 `.review-detail`
 * 本身没有规则。那种形态无害但也无用；真正危险的是本次修掉的那五族：**有视觉职责
 * 却没有样式**。两者判据相同，代价不同，所以一起入账、一起只减不增。
 */
const UNDEFINED_CLASS_SNAPSHOT: readonly string[] = [
  'account-identities-card',
  'account-table',
  'account-table__ua',
  'account-tokens-card',
  'agent-port-validation__item--error',
  'api-docs-prose',
  'auth-login-policy',
  'auth-login-policy__row--readonly',
  'btn-ghost',
  'btn-sm',
  'callchain__children',
  'callchain__label',
  'callchain__node',
  'callchain__root-label',
  'callchain__tag--external',
  'canvas-node__code-round-capability',
  'canvas-node__code-round-meta',
  'canvas-node__code-round-seq',
  'canvas-node__description',
  'canvas-node__handle--clarify-input',
  'canvas-node__handle--clarify-output',
  'canvas-node__handle--cross-clarify-input',
  'canvas-node__handle--cross-clarify-to-designer',
  'canvas-node__handle--cross-clarify-to-questioner',
  'canvas-node__handle--review-input',
  'canvas-node__port-rows--wrapper-fanout',
  'canvas-node__review-source',
  'canvas-node--agent',
  'canvas-node--code-round',
  'canvas-node--input',
  'canvas-node--io',
  'canvas-node--output',
  'canvas-node--script',
  'capability-card__port-name',
  'changes__drill-focus',
  'changes__group',
  'changes__group-magnitude',
  'changes__hunk',
  'changes__outline-dock-label',
  'child-task-link',
  'chip--warn',
  'chips-input',
  'clarify-detail__keyboard-hint',
  'clarify-resume-failed',
  'clarify-round-sealed',
  'code-assignments-page',
  'code-mission-detail',
  'code-page',
  'comment-bubble__attribution',
  'dep-tree__loading',
  'diff-view',
  'diff-view__label',
  'digital-employee-type-page',
  'digital-employees-page',
  'distill-job-detail__candidate-status',
  'distill-source-events__id',
  'employee-case-detail-page',
  'employee-dispatch-node-editor',
  'employee-execution-history',
  'employee-playbook-editor',
  'employee-playbook-step',
  'employee-step-join',
  'enum-picker',
  'event-center-page',
  'event-source-row',
  'event-source-section',
  'execution-contract-guide__primary-heading',
  'executor-library-page',
  'field__hint',
  'form-checkbox__label',
  'form-hint',
  'form-section__summary',
  'form-section--collapsible',
  'home-cap',
  'injected-memory-row__summary',
  'inspector__port-refs--missing',
  'inspector-section__body',
  'intent-session__checkpoint-continue',
  'json-field',
  'kind-select__advanced-toggle',
  'launch-collapsible',
  'launch-collapsible__body',
  'md-editor__pane--preview',
  'md-preview__truncated',
  'memory-all',
  'memory-all__filter',
  'memory-compare__preview',
  'memory-row__approved-at',
  'memory-row__id',
  'memory-row__version',
  'memory-section-layout',
  'mission-upload-card',
  'mono',
  'multi-select__listbox',
  'muted--warn',
  'node-runs__clarify-link',
  'node-runs__review-link',
  'notice-banner__body',
  'oidc-form__test-endpoint',
  'page__description',
  'page__meta-item',
  'page--md-preview',
  'page--repo-operations',
  'page--scheduled-operations',
  'page-section-nav__group-trigger-item',
  'page-section-nav__leaf-item',
  'pipeline-hero__io',
  'policy-builder',
  'policy-builder__predicate',
  'policy-simulator',
  'prior-comments__title',
  'prose__code',
  'prose__code-fallback',
  'prose__diagram--mermaid',
  'prose__diagram--plantuml',
  'react-flow__connection-path',
  'repair-confirm__failure-detail',
  'repo-layout-tree__ref',
  'repo-operations',
  'repo-tree-editor__item',
  'resource-package-import-flow__secrets',
  'review-decision-info',
  'review-detail',
  'review-detail__breadcrumbs',
  'review-detail__description',
  'review-resume-failed',
  'reviews-group__workflow',
  'scheduled-run-now-action',
  'scheduled-run-now-action__stack',
  'select__listbox--portal',
  'select__option-label',
  'session-role-badge__label',
  'settings-section-layout',
  'skill-detail',
  'stack-top--xs',
  'stepper__title',
  'structure__dep-name',
  'structure__sigdiff-row--after',
  'structure-graph__level',
  'symbol-menu__group',
  'table',
  'task-detail__commit-exclusions',
  'task-feed',
  'task-output-card',
  'task-output-card__body',
  'task-output-card__header',
  'task-output-card__name',
  'task-questions__batch',
  'task-recovery__kind',
  'webhook-card__body',
  'webhook-event-source',
  'webhooks-page',
  'workflow-node-picker__group',
  'workflow-node-picker__row',
  'workgroup-form',
  'workgroup-panel__add',
  'workgroup-panel__body',
  'workgroup-panel__member',
  'worktree-files-preview__body',
  'worktree-files-tree__row--dir',
]

function walk(dir: string, acc: string[] = [], ext: readonly string[] = ['.tsx']): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, acc, ext)
    else if (ext.some((e) => full.endsWith(e))) acc.push(full)
  }
  return acc
}

/** styles.css + prose.css 里出现过的全部 class 选择器名。 */
export function definedClassNames(cssSources: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const css of cssSources) {
    for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([A-Za-z][\w-]*)/g)) {
      out.add(m[1]!)
    }
  }
  return out
}

/** 一份源码里所有**静态** className token（带插值的整条跳过，见头注释①）。 */
export function staticClassTokens(source: string): string[] {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
  const out: string[] = []
  for (const m of stripped.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? ''
    if (raw.includes('${')) continue
    for (const token of raw.split(/\s+/)) {
      if (token !== '' && /^[A-Za-z][\w-]*$/.test(token)) out.push(token)
    }
  }
  return out
}

describe('RFC-317 T61 —— 每个静态 className 都必须在 CSS 里有定义', () => {
  const cssFiles = walk(SRC, [], ['.css'])
  const defined = definedClassNames(cssFiles.map((f) => readFileSync(f, 'utf8')))
  const tsxFiles = walk(SRC)

  test('语料非空：CSS 与源码都扫得到（扫空即假绿）', () => {
    expect(cssFiles.length).toBeGreaterThanOrEqual(1)
    expect(defined.size).toBeGreaterThan(1000)
    expect(tsxFiles.length).toBeGreaterThanOrEqual(250)
  })

  test('未定义 token 与快照**逐条相等**（新增一个 ⇒ 红；修掉一个不销账 ⇒ 也红）', () => {
    const undefinedTokens = new Set<string>()
    for (const file of tsxFiles) {
      for (const token of staticClassTokens(readFileSync(file, 'utf8'))) {
        if (defined.has(token) || LIBRARY_TOKENS.has(token)) continue
        undefinedTokens.add(token)
      }
    }
    expect(
      [...undefinedTokens].sort(),
      '出现了新的「有调用、无定义」class——它渲染出来是无样式裸文本。' +
        '要么改用公共 class / 公共组件，要么把规则写进 styles.css；' +
        '反过来，修掉一个却没把快照一起改小也会红',
    ).toEqual([...UNDEFINED_CLASS_SNAPSHOT].sort())
  })

  test('T61 修掉的五族确实不在快照里了（防回潮）', () => {
    // 这五个是 finding 逐条点名、且**有视觉职责**的那批。它们回到快照里
    // 就意味着有人把 CSS 又删了。
    for (const fixed of [
      'page__subtitle',
      'form-section__hint',
      'inspector-hint',
      'inspector__readonly',
      'dep-tree__error',
    ]) {
      expect(defined.has(fixed), `${fixed} 的 CSS 规则又没了`).toBe(true)
      expect([...UNDEFINED_CLASS_SNAPSHOT]).not.toContain(fixed)
    }
  })
})

describe('RFC-317 T61 负向 fixture —— 扫描判据的两个边界', () => {
  test('静态 className 与单引号 / 模板（无插值）三种形态都抓到', () => {
    expect(staticClassTokens('<p className="a b" />')).toEqual(['a', 'b'])
    expect(staticClassTokens("<p className={'solo'} />")).toEqual(['solo'])
    expect(staticClassTokens('<p className={`tpl one`} />')).toEqual(['tpl', 'one'])
  })

  test('**带插值的整条跳过**——拆开会产出 `chip--` 这种半截 token（第一版实测多出七十几个假违规）', () => {
    expect(staticClassTokens('<p className={`chip chip--${tone}`} />')).toEqual([])
  })

  test('注释里的 className 不算（行注释与块注释都剥）', () => {
    expect(staticClassTokens('// <p className="ghost" />\nconst x = 1')).toEqual([])
    expect(staticClassTokens('/* <p className="ghost" /> */\nconst x = 1')).toEqual([])
  })

  test('CSS 侧只认 class 选择器（元素 / 变量不算定义）', () => {
    const defined = definedClassNames(['div { color: red } :root { --x: 1 } .real { color: blue }'])
    expect(defined.has('real')).toBe(true)
    expect(defined.has('div')).toBe(false)
    expect(defined.has('x')).toBe(false)
  })
})
