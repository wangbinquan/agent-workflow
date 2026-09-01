// RFC-317 T57 · findings NK-01 —— `list<T>` 的线格 codec 由 T 决定，且只有一份。
//
// 改造前 `ListHandler.validate` 无条件用一行一条的 `splitListItems`，而
// `splitListItems` **trim 每一行、丢掉所有空行**。于是 `list<markdown>` 的文档正文
// 在落库前就被改写：段落间距没了、缩进没了、代码块的相对缩进也没了。
//
// 同一个文件里的 `bulletSuffix` / `examplePlaceholder` / `buildPromptGuidance`
// **是**按 item kind 分支的，还明确告诉 agent「你的文档是多行的、用边界行分隔」
// ——协议这一半知道，校验那一半不知道。而 `envelope.ts` 原样返回 `result.body`、
// `runner.ts` 把它写进 `node_run_outputs`：**被改写的内容就是落库的内容**。
//
// 更糟的是同一份内容在下游是按边界行切的（scheduler 的分片、review 的多文档），
// 于是「落库时切成几条」与「分片时切成几条」对不上。
//
// T57 把 codec 下沉进 handler（`splitItems` / `joinItems`），四个调用点统一走
// `splitPortItems` / `joinPortItems`。本文件锁两件事：往返性质，与「codec 只有一处」。

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseKind } from '../src/kindParser'
import { joinPortItems, splitPortItems } from '../src/outputKinds/registry'
import { MARKDOWN_DOC_BOUNDARY } from '../src/listWire'

describe('RFC-317 T57 —— codec 往返性质', () => {
  const MULTILINE_DOC = ['# 标题', '', '一段正文。', '', '```ts', '  const x = 1', '```'].join('\n')

  test('list<markdown>：多行文档往返后**逐字节相同**（改造前这里会掉空行与缩进）', () => {
    const kind = parseKind('list<markdown>')
    const docs = [MULTILINE_DOC, '第二篇\n\n还有第二段']
    const wire = joinPortItems(kind, docs)
    expect(splitPortItems(kind, wire)).toEqual(docs)
  })

  test('list<markdown>：一行一条的 codec 会破坏它（这就是改造前的行为）', () => {
    // 明确把「旧行为错在哪」钉成一条断言，免得有人把 codec 又改回按行切。
    const naive = MULTILINE_DOC.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join('\n')
    expect(naive).not.toBe(MULTILINE_DOC)
    expect(naive.includes('  const x = 1')).toBe(false)
  })

  test('list<string> / list<path<md>>：仍是一行一条（默认 codec 没被改动）', () => {
    for (const spec of ['list<string>', 'list<path<md>>']) {
      const kind = parseKind(spec)
      const items = ['a.md', 'b.md']
      expect(splitPortItems(kind, joinPortItems(kind, items))).toEqual(items)
      // 且确实是换行连接，不是边界行。
      expect(joinPortItems(kind, items)).not.toContain(MARKDOWN_DOC_BOUNDARY)
    }
  })

  test('每个 list<T> 的往返都用 T **自己**声明的 codec（注册表级性质）', () => {
    for (const spec of ['list<string>', 'list<markdown>', 'list<path<md>>', 'list<path<*>>']) {
      const kind = parseKind(spec)
      const items = ['item-one', 'item-two']
      const roundTripped = splitPortItems(kind, joinPortItems(kind, items))
      expect(roundTripped, `${spec} 的 codec 不自洽`).toEqual(items)
    }
  })
})

// ---------------------------------------------------------------------------
// 棘轮：codec 只能住在这几处
// ---------------------------------------------------------------------------

interface CodecSiteException {
  readonly file: string
  readonly why: string
  readonly removeWhen: string
}

/**
 * 允许直接调用 `splitListItems(` / `splitMarkdownDocs(` 的文件。
 *
 * codec 的**定义处**与**统一入口**当然可以；剩下的每一处都是一份独立判据，
 * 而独立判据正是本条 finding 的成因——四处里有两处忘了分支。
 */
const CODEC_SITE_EXCEPTIONS: readonly CodecSiteException[] = [
  {
    file: 'packages/backend/src/modules/collaboration/infrastructure/legacySqliteReview.ts',
    why: 'SQLite 评审适配器的分支不只是「怎么切」，还要区分**切出来的是文档正文还是工作区路径**（inlineBodies vs itemPaths，后者随后要去读文件）。它按字符串形态的 upstreamKind 判断，手上没有 ParsedKind，收进统一入口需要先把评审输入的 kind 解析面一起改。',
    removeWhen:
      'RFC-317 B10 或评审域的下一个 RFC：把 review 的 upstreamKind 从字符串换成 ParsedKind，届时这里改走 splitPortItems 并把「正文/路径」的判断交给 handler 的 isReviewableBody。',
  },
  {
    file: 'packages/backend/src/modules/collaboration/infrastructure/postgresqlCollaborationRuntimeMechanics.ts',
    why: 'PostgreSQL 评审适配器与 SQLite 适配器保持同一正文/路径分流语义；当前 closed persistence contract 仍只携带字符串 upstreamKind，尚不能无损改走 ParsedKind handler。',
    removeWhen:
      '评审输入 contract 将 upstreamKind 收窄为 ParsedKind，并把正文/路径判定下沉到共享 handler 时，两套 provider adapter 同步移除此例外。',
  },
]

const ROOTS = [
  ['shared', resolve(import.meta.dir, '..', 'src')],
  ['backend', resolve(import.meta.dir, '..', '..', 'backend', 'src')],
  ['frontend', resolve(import.meta.dir, '..', '..', 'frontend', 'src')],
] as const

const CODEC_HOMES = ['packages/shared/src/listWire.ts', 'packages/shared/src/outputKinds/'] as const

export function directCodecCallSites(): string[] {
  const hits: string[] = []
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full, `${rel}/${entry}`)
        continue
      }
      if (!/\.tsx?$/.test(entry)) continue
      const path = `${rel}/${entry}`
      if (CODEC_HOMES.some((home) => path.includes(home))) continue
      const code = readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n')
      if (/\bsplitListItems\s*\(|\bsplitMarkdownDocs\s*\(/.test(code)) hits.push(path)
    }
  }
  for (const [name, root] of ROOTS) walk(root, `packages/${name}/src`.replace('/src', '/src'))
  return [...new Set(hits)].sort()
}

describe('RFC-317 T57 棘轮 —— codec 只住在它自己的家里', () => {
  test('直接调用点与豁免账本逐条相等', () => {
    expect(
      directCodecCallSites(),
      '又有人直接调 splitListItems / splitMarkdownDocs——改走 splitPortItems / joinPortItems，' +
        'codec 该由 item kind 的 handler 决定',
    ).toEqual([...CODEC_SITE_EXCEPTIONS].map((entry) => entry.file).sort())
  })

  test('每条豁免都写清了 why 与 removeWhen', () => {
    for (const entry of CODEC_SITE_EXCEPTIONS) {
      expect(entry.why.length, `${entry.file}.why`).toBeGreaterThan(30)
      expect(entry.removeWhen.length, `${entry.file}.removeWhen`).toBeGreaterThan(10)
    }
  })
})
