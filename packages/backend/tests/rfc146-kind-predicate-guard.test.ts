// RFC-146 T1 — kind 谓词单源守卫（源码守卫）。
//
// 为什么这条测试存在：「kind 是不是 agent / 是不是免行落地 / 调度器认不认」这
// 三份知识曾散射为 5+2+1 处手写拷贝（backend inventory.isAgentRunKind +
// PROMPT_CAPABLE_KINDS×2、frontend isPromptCapableKind + isAgentKind、
// scheduler 私有 SETTLES_WITHOUT_ROW 字面量、runTask 6 连 `!==` 负枚举）。
// RFC-146 把它们全部收敛到 shared NODE_KIND_BEHAVIORS（值锁见
// node-kind-behavior-table.test.ts）。本守卫防回潮：
//   1. 被删除的谓词/集合标识符不得在任何生产源码中再现（重新 fork 一份
//      本地拷贝 = 回归）。
//   2. scheduler 的三处表接线保持表驱动形态（正向白名单 / SETTLES 派生 /
//      runOneNode fall-through 守卫）——这三处没有可观察的运行时公共 API
//      面（zod 在更早层拦掉未知 kind），源码文本锁是唯一诚实断言。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const ROOTS = [
  { name: 'backend', dir: resolve(import.meta.dir, '..', 'src') },
  { name: 'frontend', dir: resolve(import.meta.dir, '..', '..', 'frontend', 'src') },
  { name: 'shared', dir: resolve(import.meta.dir, '..', '..', 'shared', 'src') },
]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p)
  }
  return out
}

function stripCommentLines(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
        ? ''
        : line
    })
    .join('\n')
}

// 被 RFC-146 删除的谓词/集合标识符。注释里可以提（历史脉络），代码里不行。
const BANNED_IDENTIFIERS = [
  'isAgentRunKind',
  'PROMPT_CAPABLE_KINDS',
  'isPromptCapableKind',
  'isAgentKind',
] as const

describe('RFC-146 ratchet: kind 谓词单源 — 不得再 fork 本地拷贝', () => {
  test('backend + frontend + shared src：被删标识符零再现', () => {
    const violations: string[] = []
    for (const root of ROOTS) {
      for (const file of walk(root.dir)) {
        const rel = `${root.name}/${relative(root.dir, file).split(sep).join('/')}`
        const lines = stripCommentLines(readFileSync(file, 'utf8')).split('\n')
        lines.forEach((line, i) => {
          for (const banned of BANNED_IDENTIFIERS) {
            // \b 两侧界定：isAgentKind 不应误命中 isAgentNodeKind。
            if (new RegExp(`\\b${banned}\\b`).test(line)) {
              violations.push(`${rel}:${i + 1}  [${banned}]  ${line.trim()}`)
            }
          }
        })
      }
    }
    expect(violations).toEqual([])
  })
})

describe('RFC-146: task engine 三处表接线形态锁', () => {
  const schedulerSrc = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
    'utf8',
  )
  const applicationSrc = readFileSync(
    resolve(
      import.meta.dir,
      '..',
      'src',
      'modules',
      'task-execution',
      'composition',
      'taskEngineApplication.ts',
    ),
    'utf8',
  )
  const frontierSrc = readFileSync(
    resolve(
      import.meta.dir,
      '..',
      'src',
      'modules',
      'task-execution',
      'composition',
      'dagFrontier.ts',
    ),
    'utf8',
  )

  test('task engine kind 白名单 = 行为表正向成员判定（负枚举不得回潮）', () => {
    expect(applicationSrc).toMatch(/!Object\.hasOwn\(NODE_KIND_BEHAVIORS, node\.kind\)/)
    // 负枚举的指纹：白名单里对具体 kind 的 !== 长链。
    expect(applicationSrc).not.toMatch(
      /node\.kind !== 'input' &&\s*\n\s*node\.kind !== 'agent-single'/,
    )
  })

  test('SETTLES_WITHOUT_ROW_KINDS 从行为表派生（字面量孪生不得回潮）', () => {
    expect(frontierSrc).toMatch(
      /SETTLES_WITHOUT_ROW_KINDS = new Set<NodeKind>\(\s*\n\s*NODE_KIND\.filter\(\(k\) => NODE_KIND_BEHAVIORS\[k\]\.settlesWithoutRow\)/,
    )
  })

  test('runOneNode agent 分派前有 fall-through 穷举守卫', () => {
    // 守卫必须出现在 agentName 解析之前：表里新增而 runOneNode 未接分支的
    // kind 要 fail-loud（'unhandled-node-kind'），不能被当 agent 静默驱动。
    const guardAt = schedulerSrc.indexOf("message: 'unhandled-node-kind'")
    const agentNameAt = schedulerSrc.indexOf("const agentName = pickString(node, 'agentName')")
    expect(guardAt).toBeGreaterThan(0)
    expect(agentNameAt).toBeGreaterThan(0)
    expect(guardAt).toBeLessThan(agentNameAt)
  })
})

// RFC-317 T13 —— 语料非空（守卫的守卫：architecture/rfc317-guard-corpus-floor.test.ts）。
//
// 上面每条断言的绿都可能来自两处：真的没有违规，或者**扫描根失效、语料被筛成空**。
// 两者在断言层面同形，后者是永久静默的假绿。这一条把「扫描器还活着」变成可断言事实；
// 下限同时两向钉进 architecture/guard-manifest.json，静默调低会红。
describe('RFC-317 T13 —— 语料非空', () => {
  test('扫描确实覆盖到源码语料（扫空即假绿）', () => {
    expect(ROOTS.flatMap((root) => walk(root.dir)).length).toBeGreaterThanOrEqual(700)
  })
})

// RFC-317 T14 —— 负 fixture：把伪造的违规喂给**本文件自己的 matcher**。
//
// 这条守卫的判据是「被删标识符零再现」，最容易的静默失效是有人改 `BANNED_IDENTIFIERS`
// 时把某一项拼错——扫描照跑、永远零命中。
describe('RFC-317 T14 —— matcher 自证：伪造的 fork 拷贝必须被抓到', () => {
  test('伪造的本地拷贝逐个命中', () => {
    for (const banned of BANNED_IDENTIFIERS) {
      const fabricated = `export function ${banned}(kind: NodeKind): boolean {\n  return kind === 'agent'\n}\n`
      expect(fabricated.includes(banned), `${banned} 的伪造样本没命中`).toBe(true)
      expect(stripCommentLines(fabricated).includes(banned)).toBe(true)
    }
  })

  test('注释里提到被删标识符不算违规', () => {
    const fabricated = `// 历史上这里有 ${BANNED_IDENTIFIERS[0]}(kind)，已随 RFC-146 删除\nconst x = 1\n`
    expect(stripCommentLines(fabricated).includes(BANNED_IDENTIFIERS[0])).toBe(false)
  })
})
