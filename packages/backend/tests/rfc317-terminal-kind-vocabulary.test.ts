// RFC-317 T44（DE-06）—— 终态种类只有一份词汇、一份分类表。
//
// 改造前 `terminalKind` 是一个无 schema 的自由字符串，在四处被铸出来，被**三张互不
// 一致的手写表**解读，其中两张已经是错的：
//   · 任务目录那张认 'closed-unmerged'（旧版 Mission 的词，OS 从不产出），而 OS 真正
//     铸的 'closed' 掉进兜底被报成 done——按 canceled 筛会漏掉它们；
//   · 协作 join 那张写 'cancelled'（双 L），于是以 'canceled' 终结的 Case 被判 satisfied。
// 三张表现在并成 `classifyTerminalKind`，词汇放在 shared（前端也要用）。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import ts from 'typescript'

import {
  classifyTerminalKind,
  EMPLOYEE_CASE_TERMINAL_KINDS,
  LEGACY_MISSION_TERMINAL_KINDS,
} from '@agent-workflow/shared'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const BACKEND_SRC = resolve(REPO_ROOT, 'packages', 'backend', 'src')

const KNOWN = new Set<string>([...EMPLOYEE_CASE_TERMINAL_KINDS, ...LEGACY_MISSION_TERMINAL_KINDS])

/**
 * 明确写着 `terminalKind: '<字面量>'` 的赋值点。
 *
 * 走 AST 而不是 grep：本文件与被扫文件的注释里都在讨论这些词。只看**属性赋值**，
 * 因为那是"往库里/往事件里铸一个终态"的形态；比较判断（`=== 'x'`）由 classify 收口，
 * 不在这条断言的范围内。
 */
function mintedTerminalKinds(rel: string, text: string): string[] {
  // 绝大多数源文件没有这个属性，无需为它们构造完整 AST。Unicode 转义也可组成
  // Identifier（例如 terminal\u004bind），必须继续交给原 AST 判据；文本命中本身不算铸值。
  if (!text.includes('terminalKind') && !text.includes('\\u')) return []
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'terminalKind' &&
      (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))
    ) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      out.push(`${rel}:${line} '${node.initializer.text}'`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sourceFiles(path, out)
    else if (/\.[cm]?ts$/.test(name)) out.push(path)
  }
  return out
}

describe('RFC-317 T44（DE-06）—— 终态种类词汇', () => {
  test('语料非空：两套词汇都读得到（读不到则下面几条零预言力）', () => {
    expect(EMPLOYEE_CASE_TERMINAL_KINDS.length).toBeGreaterThanOrEqual(5)
    expect(LEGACY_MISSION_TERMINAL_KINDS.length).toBeGreaterThanOrEqual(2)
    expect(sourceFiles(BACKEND_SRC).length).toBeGreaterThanOrEqual(300)
  })

  test('每一处铸出来的终态字面量都在词汇表里', () => {
    const unknown: string[] = []
    for (const file of sourceFiles(BACKEND_SRC)) {
      const rel = relative(REPO_ROOT, file).replaceAll('\\', '/')
      for (const hit of mintedTerminalKinds(rel, readFileSync(file, 'utf8'))) {
        const literal = hit.slice(hit.indexOf("'") + 1, -1)
        if (!KNOWN.has(literal)) unknown.push(hit)
      }
    }
    expect(
      unknown,
      '铸出了一个没有任何分类表认识的终态种类。它会掉进 classifyTerminalKind 的未知兜底：' +
        '任务目录报 done、协作 join 不判失败、前端归 otherFinished——三处都可能不是你想要的。' +
        '把它加进 EMPLOYEE_CASE_TERMINAL_KINDS 并在分类表里为三个维度各表一次态',
    ).toEqual([])
  })

  test('两个真 bug 的回归锁：`closed` 归 canceled、`canceled` 判失败', () => {
    expect(
      classifyTerminalKind('closed').catalog,
      "OS 铸的是 'closed'；旧表认的是 'closed-unmerged'，于是它掉兜底被报成 done",
    ).toBe('canceled')
    expect(
      classifyTerminalKind('canceled').failed,
      "旧表写的是 'cancelled'（双 L），于是以 canceled 终结的 Case 被判 satisfied",
    ).toBe(true)
  })

  test('旧版 Mission 词汇仍被认得（存量行不会掉进未知兜底）', () => {
    expect(classifyTerminalKind('closed-unmerged').catalog).toBe('canceled')
    expect(classifyTerminalKind('no-change-confirmed').bucket).toBe('noChange')
  })

  test('未知终态的兜底逐字保留改造前的语义', () => {
    expect(classifyTerminalKind('operator-invented').catalog).toBe('done')
    expect(classifyTerminalKind('operator-invented').failed).toBe(false)
    expect(classifyTerminalKind('operator-invented').bucket).toBe('otherFinished')
    // 前端旧规则：`*-failed` / 'failed' / 'blocked' 归失败桶。
    expect(classifyTerminalKind('some-custom-failed').bucket).toBe('failed')
    expect(classifyTerminalKind('blocked').bucket).toBe('failed')
    expect(classifyTerminalKind(null).bucket).toBe('otherFinished')
  })

  test('每个已知终态都对三个维度各表了一次态（穷尽 Record 的运行期复核）', () => {
    for (const kind of [...EMPLOYEE_CASE_TERMINAL_KINDS, ...LEGACY_MISSION_TERMINAL_KINDS]) {
      const c = classifyTerminalKind(kind)
      expect(['done', 'canceled'], `${kind}.catalog`).toContain(c.catalog)
      expect(typeof c.failed, `${kind}.failed`).toBe('boolean')
      expect(['merged', 'noChange', 'failed', 'otherFinished'], `${kind}.bucket`).toContain(
        c.bucket,
      )
    }
  })
})

describe('RFC-317 T44 自变异 —— AST 判据与预筛边界', () => {
  test('真的铸一个未知终态会被抓到', () => {
    expect(
      mintedTerminalKinds('probe.ts', `const x = { terminalKind: 'invented-kind' }\n`).length,
    ).toBe(1)
  })

  test('比较判断不算「铸」（那一支由 classify 收口，不在本断言范围）', () => {
    expect(
      mintedTerminalKinds('probe.ts', `if (row.terminalKind === 'merged') return 1\n`),
    ).toEqual([])
  })

  test.each([
    ['无终态属性的返回判别值', `return { ok: false, code: 'epoch-conflict' }`, []],
    [
      'quoted / computed 属性保留原 Identifier 判据',
      `const x = { 'terminalKind': 'invented-kind', ['terminalKind']: 'invented-kind' }`,
      [],
    ],
    [
      '转义 quoted / computed 属性仍不属于 Identifier',
      String.raw`const x = { 'terminal\u004bind': 'invented-kind', ['terminal\u004bind']: 'invented-kind' }`,
      [],
    ],
    [
      '注释和字符串里提到赋值不算铸值',
      `// const x = { terminalKind: 'invented-kind' }\nconst text = "{ terminalKind: 'invented-kind' }"`,
      [],
    ],
    [
      '属性简写不是带字面量的属性赋值',
      `const terminalKind = 'invented-kind'; const x = { terminalKind }`,
      [],
    ],
    [
      'Unicode 转义标识符仍铸值',
      String.raw`const x = { terminal\u004bind: 'invented-kind' }`,
      ["probe.ts:1 'invented-kind'"],
    ],
    [
      'Unicode code point 转义标识符仍铸值',
      String.raw`const x = { \u{74}erminalKind: 'invented-kind' }`,
      ["probe.ts:1 'invented-kind'"],
    ],
    [
      '完全转义的标识符仍铸值',
      String.raw`const x = { \u0074\u0065\u0072\u006d\u0069\u006e\u0061\u006c\u004b\u0069\u006e\u0064: 'invented-kind' }`,
      ["probe.ts:1 'invented-kind'"],
    ],
    [
      '字符串转义按 AST 解码且保留行号',
      String.raw`const x = {
  terminal\u004bind: '\u0069nvented-kind'
}`,
      ["probe.ts:2 'invented-kind'"],
    ],
    [
      '无插值模板字面量仍铸值',
      'const x = { terminalKind: `invented-kind` }',
      ["probe.ts:1 'invented-kind'"],
    ],
  ] as const)('%s', (_name, source, expected) => {
    expect(mintedTerminalKinds('probe.ts', source)).toEqual([...expected])
  })
})
