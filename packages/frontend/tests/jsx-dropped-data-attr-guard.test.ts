// 为什么有这条测试：`tasks.new.tsx` 的三个测试锚点从未进入 DOM——
// `wizard-draft-warning` / `wizard-draft-reentry` / `wizard-outcome-unknown`
// 都以 **`data-testid=`** 传给 `<NoticeBanner>`，而该组件只声明 `testid`
// （`components/NoticeBanner.tsx`）且不 spread 未声明属性，于是属性被静默丢弃。
//
// 这类 bug TypeScript **抓不到**：JSX 里**带连字符**的属性名不参与 props 校验，
// 写错既不报错也不生效，只有等到有人写 `getByTestId(...)` 恒 0 命中才会发现。
// 既有的 `e2e/rfc250-task-wizard-recovery.spec.ts` 早就改用 `getByRole('status')`
// 绕开它——说明这个坑踩过一次、没修，正是需要机器判据的形态。
//
// 判据：任何自研组件（首字母大写的 JSX 标签）收到 `data-*` / `aria-*` 属性时，
// 该组件必须**确实接得住**——要么在定义里显式声明了同名属性，要么 spread 了
// props / 继承了 HTMLAttributes。接不住就是死锚点。
//
// 诚实的覆盖边界（不假装它是完备的）：
//   * 组件名 → 定义文件是**按名字全仓匹配**的，同名组件会取先扫到的那个；
//     本仓当前无同名冲突，真出现时这条测试会给出偏保守（可能漏报）的结论。
//   * 只认**顶格**（列 0）的定义。函数体内 `const Tag = props.as ?? 'div'` 这类
//     动态标签变量装的是原生标签名，天然接得住 data-*，不能算自研组件——
//     `VirtualList.tsx` 的 `RowTag`、`ClampedText.tsx` 的 `Tag` 即此形态。
//   * 归属靠**从属性往回扫**找外层开标签（跨过成对的兄弟元素、`=>` 箭头不计），
//     因此 `footer={<div>…</div>}` 这种嵌套 JSX 之后的属性也能正确归到外层组件；
//     纯正则按 `<Tag …>` 整段匹配做不到这点（`tasks.new.tsx:2072` 就是这么漏掉的）。
//   * 只看**直接**属性字面量，不追 `{...spreadObj}` 里藏的 data-*。
//   * 「接得住」的判定对 rest-spread 取**最宽松**的一档：组件文件里出现任何
//     `...foo` 就认为它转发得下去。这是刻意偏保守——`PageSectionNav.tsx` 的
//     `PageSectionAnchor` 用的是 `...anchorProps`（不是 `...props` / `...rest`），
//     写死名字会把它误判成死锚点，而 e2e 里 `[data-task-detail-section-link=…]`
//     的点击全绿，证明它确实转发了。宁可漏报也绝不误报。
//   * 原生小写标签（`<div data-testid>`）天然接得住，不在判据内。
import { describe, expect, test } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.tsx')) out.push(p)
  }
  return out
}

const FILES = walk(SRC)
const TEXT = new Map(FILES.map((f) => [f, readFileSync(f, 'utf8')]))

/** 组件名 → 定义文件。只认顶格定义，避开函数体内的动态标签变量。 */
const DEFS = new Map<string, string>()
for (const [file, text] of TEXT) {
  for (const m of text.matchAll(/^(?:export\s+)?function\s+([A-Z][A-Za-z0-9]*)\s*\(/gm)) {
    if (!DEFS.has(m[1]!)) DEFS.set(m[1]!, file)
  }
  for (const m of text.matchAll(/^(?:export\s+)?const\s+([A-Z][A-Za-z0-9]*)\s*[:=]/gm)) {
    if (!DEFS.has(m[1]!)) DEFS.set(m[1]!, file)
  }
}

/**
 * 从属性位置往回扫，找出它挂在哪个开标签上。
 * 反向遇到 `>` 视为一个兄弟元素/标签的收尾（`=>` 箭头除外），记一层；遇到 `<`
 * 时若还有欠账就抵消，否则就是我们要找的那个开标签。
 */
function enclosingTag(text: string, at: number): string | null {
  let skip = 0
  for (let i = at - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === '>') {
      if (text[i - 1] === '=') continue
      skip++
    } else if (ch === '<') {
      if (skip > 0) skip--
      else return /^<\/?([A-Za-z][A-Za-z0-9]*)/.exec(text.slice(i, i + 40))?.[1] ?? null
    }
  }
  return null
}

/** 该组件是否接得住任意 data-* / aria-* 属性。 */
function accepts(componentFile: string, attr: string): boolean {
  const body = TEXT.get(componentFile) ?? ''
  return (
    body.includes(`'${attr}'`) ||
    body.includes(`"${attr}"`) ||
    body.includes(`${attr}?:`) ||
    /\.\.\.[A-Za-z_$][\w$]*/.test(body) ||
    body.includes('HTMLAttributes')
  )
}

/**
 * 扫描判据（**纯函数**）：给定一份源码，报出其中所有「传给接不住它的自研组件」的
 * 连字符属性。真实语料与负 fixture 走的是**同一个**函数——各留一份拷贝的话，
 * fixture 证明的只是拷贝还活着（RFC-317 T14 的原话）。
 */
export function findDroppedAttrs(
  file: string,
  text: string,
  resolve: (tag: string) => string | undefined,
  acceptsAttr: (definitionFile: string, attr: string) => boolean,
): string[] {
  const dead: string[] = []
  for (const a of text.matchAll(/\b((?:data|aria)-[a-z-]+)=/g)) {
    const attr = a[1]!
    const tag = enclosingTag(text, a.index!)
    if (tag === null || !/^[A-Z]/.test(tag)) continue
    const def = resolve(tag)
    if (def === undefined || acceptsAttr(def, attr)) continue
    const line = text.slice(0, a.index).split('\n').length
    dead.push(`${file}:${line} <${tag} ${attr}=…> —— ${def} 接不住它，属性会被静默丢弃`)
  }
  return dead
}

describe('JSX 连字符属性不得传给接不住它的自研组件', () => {
  test('语料非空：确实扫得到一批 .tsx（扫成 0 说明扫描根失效，此刻零预言力）', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(300)
  })

  test('每一处 <Component data-*|aria-*> 都必须真的落进 DOM', () => {
    const dead: string[] = []
    for (const [file, text] of TEXT) {
      dead.push(
        ...findDroppedAttrs(
          file.slice(file.indexOf('src/')),
          text,
          (tag) => {
            const d = DEFS.get(tag)
            return d === undefined ? undefined : d.slice(d.indexOf('src/'))
          },
          (def, attr) => accepts(join(SRC, '..', def), attr),
        ),
      )
    }
    expect(dead).toEqual([])
  })

  test('负 fixture：把伪造的违规喂给同一份判据，它必须报（matcher 停止工作就红）', () => {
    const fabricated = [
      'export function Demo(): ReactElement {',
      '  return (',
      '    <NoticeBanner tone="warning" data-testid="fabricated-dead-anchor">',
      '      <button data-testid="native-tag-is-fine">ok</button>',
      '    </NoticeBanner>',
      '  )',
      '}',
    ].join('\n')
    const reported = findDroppedAttrs(
      'src/fabricated.tsx',
      fabricated,
      () => 'src/components/Fabricated.tsx',
      () => false,
    )
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain('<NoticeBanner data-testid=…>')

    // 反向一半：同一份判据在「组件接得住」时必须闭嘴，否则它只是恒报。
    expect(
      findDroppedAttrs(
        'src/fabricated.tsx',
        fabricated,
        () => 'src/x.tsx',
        () => true,
      ),
    ).toEqual([])
  })
})
