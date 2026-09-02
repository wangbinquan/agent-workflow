// RFC-317 T39（CC-13）—— 记忆正文的围栏模式必须**被说出来**，不能是默认值。
//
// 改造前 `formatMemoryBlock` / `formatMemoryBlockWithSnapshot` /
// `formatMemoryBlockFromSnapshot` 三个函数都带 `envelopeNonce = ''`，而空 nonce 走的是
// 「原样拼接、不加围栏」的分支（`fenceUntrusted` 遇到空 nonce 也原样返回）。也就是说
// **安全路径是你得记得去要的那一条**。当时唯一的生产调用点确实传了真 nonce、还被
// RFC-200 的源码锁钉着；但默认值意味着任何新调用点都会静默继承不加围栏——把「历史
// 字节兼容」编码成默认值而不是显式的 legacy 模式，这是把逃生门装在了安全边界上。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import ts from 'typescript'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const BACKEND_SRC = resolve(REPO_ROOT, 'packages', 'backend', 'src')
const KERNEL = 'packages/backend/src/modules/memory/domain/injectionRendering.ts'

/**
 * 允许使用 `memoryFencingForNonce`（「空 nonce ⇒ 不加围栏」的显式转换器）的地方。
 *
 * 它存在的唯一理由是**重建历史 node_run 的 persona 片段**：pre-RFC-200 的行没有 nonce，
 * 必须逐字复刻当年的拼法。新代码一律直接传 `{ kind: 'fenced', nonce }`。
 */
const LEGACY_NONCE_CALLERS: Readonly<Record<string, string>> = {
  'modules/memory/application/injection/injectMemory.ts':
    'buildMemoryBlock 入口——deps.envelopeNonce 可能来自历史调用方（RFC-352 从 services/memoryInject.ts 平移过来）。',
  'services/runner.ts':
    'RFC-042 同会话追问会重建首轮的注入片段；首轮若是 pre-RFC-200 的行则没有 nonce。',
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sourceFiles(path, out)
    else if (/\.[cm]?ts$/.test(name)) out.push(path)
  }
  return out
}

/** 该文件里是否**调用**了这个名字（AST，不是文本——注释里提到不算）。 */
function callsFunction(rel: string, text: string, name: string): boolean {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true)
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** 这个导出函数的某个形参有没有默认值。 */
function parametersWithDefaults(text: string, functionName: string): string[] {
  const source = ts.createSourceFile(KERNEL, text, ts.ScriptTarget.ES2022, true)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      for (const parameter of node.parameters) {
        if (parameter.initializer !== undefined && ts.isIdentifier(parameter.name)) {
          out.push(`${functionName}(${parameter.name.text} = …)`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

const FENCED_FORMATTERS = [
  'formatMemoryBlock',
  'formatMemoryBlockWithSnapshot',
  'formatMemoryBlockFromSnapshot',
] as const

describe('RFC-317 T39（CC-13）—— 记忆围栏模式必传', () => {
  const kernelText = readFileSync(resolve(REPO_ROOT, KERNEL), 'utf8')

  test('语料非空：内核读得到（读不到则下面两条零预言力）', () => {
    expect(kernelText.length).toBeGreaterThan(5_000)
    for (const name of FENCED_FORMATTERS) expect(kernelText).toContain(`export function ${name}(`)
  })

  test('三个格式化函数的 fencing 形参都没有默认值', () => {
    const offenders = FENCED_FORMATTERS.flatMap((name) =>
      parametersWithDefaults(kernelText, name).filter((entry) =>
        /fencing|envelopeNonce/.test(entry),
      ),
    )
    expect(
      offenders,
      '围栏模式又变回默认值了。默认值意味着新调用点会**静默**落进不加围栏的分支——' +
        '安全路径不能是「你得记得去要」的那一条',
    ).toEqual([])
  })

  test('legacy 转换器只出现在登记过的历史入口', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(BACKEND_SRC)) {
      const rel = relative(BACKEND_SRC, file).replaceAll('\\', '/')
      if (!callsFunction(rel, readFileSync(file, 'utf8'), 'memoryFencingForNonce')) continue
      if (LEGACY_NONCE_CALLERS[rel] === undefined) offenders.push(rel)
    }
    expect(
      offenders,
      '新代码用了「空 nonce ⇒ 不加围栏」的转换器。它只为重建 pre-RFC-200 的历史行而存在；' +
        "新调用点一律直接传 { kind: 'fenced', nonce }。确有历史入口就登记进 " +
        'LEGACY_NONCE_CALLERS 并写清理由',
    ).toEqual([])
  })

  test('登记表无死条目（文件没了 / 已不再调用 ⇒ 删掉这一行）', () => {
    const stale: string[] = []
    for (const [rel, why] of Object.entries(LEGACY_NONCE_CALLERS)) {
      expect(why.trim().length, `${rel} 的理由写得太短`).toBeGreaterThanOrEqual(20)
      const path = resolve(BACKEND_SRC, rel)
      let text: string
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        stale.push(`${rel}（文件已不存在）`)
        continue
      }
      if (!callsFunction(rel, text, 'memoryFencingForNonce')) {
        stale.push(`${rel}（已不再调用转换器，登记应删）`)
      }
    }
    expect(stale, '死登记是一张空白许可证').toEqual([])
  })
})
