// RFC-317 T40（CC-02）—— 谁产出提示词，谁就得用**那一套**围栏内核。
//
// RFC-200 的接线守卫是一张**正向白名单**：它逐个 read 具名文件（runner / prompt /
// clarify / scheduler / memoryInject / turnExecution / …）并断言它们仍然串着 nonce。
// 白名单能挡住「已有的产出点悄悄不串 nonce 了」，但对「**新来一个产出点，压根没有
// 围栏**」这一类**结构性失明**——新文件不匹配它任何一条 read，永远不会红。
//
// CC-02 就是这样发生的：RFC-310 在 modules/ 下开了第二套围栏，只做两次 replaceAll，
// 比共享内核少四项语义（\r/U+2028/U+2029 归一、行首锚点中和、闭合标签中和、nonce 绑定），
// 而两条既有守卫一条都看不到它。
//
// 这条棘轮是**负向**的：全域扫，凡是代码里落了框架结构标记的文件，要么用共享内核，
// 要么在这张表里登记并说清它为什么不是产出侧。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const SCAN_ROOTS = ['packages/backend/src', 'packages/frontend/src'] as const

/**
 * 「这段代码在拼提示词的框架结构」的标记。
 *
 * 刻意**不含** `<workflow-output`：那是 agent **输出信封**的标记，属于解析侧关心的
 * 东西，全仓有 20 多个文件在读它。把它放进来，违规集会被解析侧淹没，最后所有人都去
 * 加豁免——判据要窄到每一条命中都值得看一眼。
 */
const STRUCTURE_MARKERS = [
  '<aw-input',
  '# Output protocol',
  '### User directive',
  '===== BEGIN',
] as const

/** 共享围栏内核的入口名。 */
const SHARED_FENCING_EXPORTS = [
  'fenceUntrusted',
  'sanitizeInlineField',
  'neutralizeLineStartAnchors',
  'hasAwInputFence',
  'toSingleLine',
] as const

/**
 * 该文件是否**从共享包 import** 了围栏入口。
 *
 * 判的是 import，不是「出现过这个名字」。第一版只匹配符号名，变异实证当场打脸：
 * 把 `import { fenceUntrusted } from '@agent-workflow/shared'` 换成就地
 * `const fenceUntrusted = (n, c) => c`——一个**什么都不做**的同名假货——判据照样绿。
 * 而「就地再造一个同名的、更弱的实现」恰恰就是 CC-02 的形态本身。
 */
function importsSharedFencing(text: string): boolean {
  const imports = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)]
  return imports.some(
    ([, names, from]) =>
      (from === '@agent-workflow/shared' || (from ?? '').includes('shared/promptFencing')) &&
      SHARED_FENCING_EXPORTS.some((name) => new RegExp(`\\b${name}\\b`).test(names ?? '')),
  )
}

/**
 * 落了结构标记但**不是产出侧**的文件。每条都要说清它在做什么。
 *
 * 这不是豁免表，是分类表：产出侧必须用共享内核，消费/校验侧不需要。
 */
const NON_PRODUCERS: Readonly<Record<string, string>> = {
  'packages/backend/src/services/runner.ts':
    '消费/校验侧：`injectedMemoryBlock?.includes(\'<aw-input \')` 是在断言注入块**确实带上了**围栏（配合 envelopeNonce 长度判断），不是在产出围栏。真正的产出走 memoryInject 的共享内核路径。',
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir).sort()
  } catch {
    return out
  }
  for (const name of entries) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sourceFiles(path, out)
    else if (/\.[cm]?tsx?$/.test(name)) out.push(path)
  }
  return out
}

/**
 * 去掉块注释与行注释后的源码。
 *
 * 必须去注释：本仓三处命中里有两处（clarify/rounds.ts、opencode/spawn.ts）
 * 是**注释里在解释这些标记**。文本判据不去注释，它们会被判成产出侧，于是这张表里
 * 立刻多两条毫无意义的登记——而登记多了，表本身就不再有人读。
 */
function strippedSource(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

function markerHits(text: string): string[] {
  const code = strippedSource(text)
  return STRUCTURE_MARKERS.filter((marker) => code.includes(marker))
}

describe('RFC-317 T40（CC-02）—— 提示词围栏内核的采用率棘轮', () => {
  const scanned = SCAN_ROOTS.flatMap((root) => sourceFiles(resolve(REPO_ROOT, root)))

  test('语料非空：两个 src 树都扫得到（扫成空则下面那条必然绿）', () => {
    expect(scanned.length).toBeGreaterThanOrEqual(500)
  })

  test('落了框架结构标记的文件，要么用共享围栏，要么已登记为非产出侧', () => {
    const offenders: string[] = []
    for (const file of scanned) {
      const rel = relative(REPO_ROOT, file).replaceAll('\\', '/')
      const text = readFileSync(file, 'utf8')
      const hits = markerHits(text)
      if (hits.length === 0) continue
      if (importsSharedFencing(text)) continue
      if (NON_PRODUCERS[rel] !== undefined) continue
      offenders.push(`${rel} → ${hits.join(', ')}`)
    }
    expect(
      offenders,
      '这个文件在拼提示词的框架结构，却没有用 shared/promptFencing。' +
        '第二套围栏内核必然比共享的那套弱——RFC-310 那份就少了 \\r/U+2028/U+2029 归一、' +
        '行首锚点中和、闭合标签中和与 nonce 绑定四项，而每一项都是被真实攻击面逼出来的。' +
        '确实不是产出侧就登记进 NON_PRODUCERS 并写清在做什么',
    ).toEqual([])
  })

  test('分类表无死条目（文件没了 / 已改用共享内核 / 已不含标记 ⇒ 删掉这一行）', () => {
    const stale: string[] = []
    for (const [rel, why] of Object.entries(NON_PRODUCERS)) {
      expect(why.trim().length, `${rel} 的理由写得太短`).toBeGreaterThanOrEqual(30)
      let text: string
      try {
        text = readFileSync(resolve(REPO_ROOT, rel), 'utf8')
      } catch {
        stale.push(`${rel}（文件已不存在）`)
        continue
      }
      if (markerHits(text).length === 0) stale.push(`${rel}（已不含结构标记，登记应删）`)
      else if (importsSharedFencing(text)) stale.push(`${rel}（已改用共享内核，登记应删）`)
    }
    expect(stale, '死登记是一张空白许可证').toEqual([])
  })
})

describe('RFC-317 T40 自变异 —— 判据的三条边界', () => {
  test('真的落一个结构标记会被抓到', () => {
    expect(markerHits(`const s = '<aw-input name="x">'\n`)).toEqual(['<aw-input'])
  })

  test('注释里提到标记**不算**（否则本仓立刻多两条毫无意义的登记）', () => {
    expect(
      markerHits(`// 这里会拼出一个 <aw-input> 块，见 RFC-200\nconst x = 1\n`),
      '两处真实命中（clarify/rounds.ts、opencode/spawn.ts）就是注释',
    ).toEqual([])
  })

  test('就地定义同名函数**不算**用了共享内核（判 import，不判名字）', () => {
    const fake = `const fenceUntrusted = (n: string, c: string) => c\nconst s = '<aw-input'\n`
    expect(
      importsSharedFencing(fake),
      '只匹配符号名的话，一个什么都不做的同名假货就能让判据变绿——而「就地再造一个' +
        '同名的、更弱的实现」正是 CC-02 的形态本身',
    ).toBe(false)
    expect(
      importsSharedFencing(`import { fenceUntrusted } from '@agent-workflow/shared'\n`),
    ).toBe(true)
  })

  test('`<workflow-output` 刻意不在标记集里（它是解析侧的词，会淹没违规集）', () => {
    expect(markerHits(`const s = '<workflow-output>'\n`)).toEqual([])
  })
})
