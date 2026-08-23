// RFC-286 F1 —— 死 class 灭绝锁。
//
// 三个 class 在 styles.css 无（顶层）定义却在 src 里当真实样式使用——渲染出来
// 是无样式裸文本（真实 bug）：`error-text`（零定义，6 处）/ `checkbox-row`
// （零定义）/ `form-error`（顶层无定义；唯一生效处是 `.script-env-table__row
// .form-error` 嵌套定义——ScriptEdit 语境合法保留）。修复后本锁保证不回潮：
// 新增一处未定义 class 的错误 UI 必须过公共组件（ErrorBanner/NoticeBanner/
// Field error），不是再手搓一个 div。

import { describe, expect, test } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const SRC = resolve(import.meta.dirname, '..', 'src')

/** form-error 仅允许出现在嵌套定义真实生效的 ScriptEdit 语境。 */
const FORM_ERROR_ALLOWLIST = new Set(['components/canvas/inspector/ScriptEdit.tsx'])

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (p.endsWith('.tsx') || p.endsWith('.ts')) acc.push(p)
  }
  return acc
}

/**
 * 剥掉注释后，某个死 class 是否仍出现在**任意引号字符串**里。**纯函数**——扫描与
 * RFC-317 T14 的「matcher 自证」共用它。
 *
 * 双形态扫描（实现门路 1 P3-1 加固）：静态 `className="…"` 与模板字面量 / clsx /
 * 三元拼接里的逃逸面都要覆盖；`(?<![\w-])` / `(?![\w-])` 两侧边界防的是
 * `error-text` 命中 `error-text-strong` 这类误报。
 */
function mentionsDeadClass(text: string, dead: string): boolean {
  // 注释行剥掉——MemoryDialogShell 有一处历史注释提及。
  const stripped = text
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  return new RegExp(`['"\`][^'"\`\\n]*(?<![\\w-])${dead}(?![\\w-])[^'"\`\\n]*['"\`]`).test(stripped)
}

describe('RFC-286 F1 — 死 class 灭绝', () => {
  test('error-text / checkbox-row 作为 className 在 src 归零；form-error 仅限 allowlist', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      // Windows 腿：relative() 产反斜杠，归一化成 POSIX 再比 allowlist
      // （83088a83 CI windows shard 实锤的假阳性）。
      const rel = relative(SRC, file).replaceAll('\\', '/')
      const text = readFileSync(file, 'utf8')
      for (const dead of ['error-text', 'checkbox-row']) {
        // 双形态扫描（实现门路 1 P3-1 加固）：① 静态 className="…"；② 任意
        // 引号字符串里携带该 class（模板字面量 / clsx / 三元拼接的逃逸面）。
        // 注释行剥掉——MemoryDialogShell 有一处历史注释提及。
        if (mentionsDeadClass(text, dead)) offenders.push(`${rel}: ${dead}`)
      }
      if (
        new RegExp('className="[^"]*\\bform-error\\b[^"]*"').test(text) &&
        !FORM_ERROR_ALLOWLIST.has(rel)
      ) {
        offenders.push(`${rel}: form-error`)
      }
    }
    expect(offenders).toEqual([])
  })
})

// RFC-317 T13 —— 语料非空（守卫的守卫：architecture/rfc317-guard-corpus-floor.test.ts）。
//
// 上面每条断言的绿都可能来自两处：真的没有违规，或者**扫描根失效、语料被筛成空**。
// 两者在断言层面同形，后者是永久静默的假绿。这一条把「扫描器还活着」变成可断言事实；
// 下限同时两向钉进 architecture/guard-manifest.json，静默调低会红。
describe('RFC-317 T13 —— 语料非空', () => {
  test('扫描确实覆盖到源码语料（扫空即假绿）', () => {
    expect(walk(SRC).length).toBeGreaterThanOrEqual(250)
  })
})

// RFC-317 T14 —— 负 fixture：把伪造的复活写法喂给**扫描用的同一份判据**。
//
// 这条判据有两个容易被改坏的部件：注释剥离（剥少了会误报、剥多了会漏报）与两侧的
// `(?<![\w-])` / `(?![\w-])` 边界（少了会把 `error-text-strong` 误当成 `error-text`）。
// 两个方向都得钉住——只钉一边的话，另一边坏掉时守卫仍然报零。
describe('RFC-317 T14 —— matcher 自证：死 class 扫描的两个边界', () => {
  test('静态 className 与模板 / clsx 两种逃逸面都命中', () => {
    for (const fabricated of [
      '<span className="error-text">{msg}</span>',
      'const cls = `error-text ${tone}`',
      'const cls = clsx("checkbox-row", dense && "is-dense")',
    ]) {
      const dead = fabricated.includes('checkbox-row') ? 'checkbox-row' : 'error-text'
      expect(mentionsDeadClass(fabricated, dead), `没抓到：${fabricated}`).toBe(true)
    }
  })

  test('前后缀相似的 class 不误报（边界断言的存在理由）', () => {
    expect(mentionsDeadClass('<span className="error-text-strong" />', 'error-text')).toBe(false)
    expect(mentionsDeadClass('<span className="form-error-text" />', 'error-text')).toBe(false)
  })

  test('注释里提及不算（行注释与块注释两种都要剥掉）', () => {
    expect(mentionsDeadClass('// 历史上这里是 "error-text"\nconst x = 1\n', 'error-text')).toBe(
      false,
    )
    expect(mentionsDeadClass('/* className="checkbox-row" */\nconst x = 1\n', 'checkbox-row')).toBe(
      false,
    )
  })
})
