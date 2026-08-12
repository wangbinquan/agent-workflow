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

describe('RFC-286 F1 — 死 class 灭绝', () => {
  test('error-text / checkbox-row 作为 className 在 src 归零；form-error 仅限 allowlist', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      // Windows 腿：relative() 产反斜杠，归一化成 POSIX 再比 allowlist
      // （83088a83 CI windows shard 实锤的假阳性）。
      const rel = relative(SRC, file).replaceAll('\\', '/')
      const text = readFileSync(file, 'utf8')
      for (const dead of ['error-text', 'checkbox-row']) {
        if (new RegExp(`className="[^"]*\\b${dead}\\b[^"]*"`).test(text)) {
          offenders.push(`${rel}: ${dead}`)
        }
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
