// RFC-310 T1 —— development-automation 架构锁（骨架期起就生效的棘轮）。
//
// 锁四类合同（design.md §1.2/§1.3）：
// 1. 模块顶层结构闭集：只允许 domain/application/engine/ports/infrastructure/
//    public/composition 七层目录 + composition.ts；public/ 下只允许 RFC-294 的
//    五个 exact 入口名（跨 context 深 import 由 rfc294-architecture-preflight 锁，
//    此处锁的是结构本身）。
// 2. composition.ts 与 composition/required-ports.ts 的全仓消费者精确账本
//    （toEqual）：增删一个消费者都必须显式修订本测试并说明批次归属。
// 3. 模块内分层禁边：domain 纯净（只许 shared 中性值对象 / zod / 本层相对
//    导入）；application/engine/public 不得触 infrastructure、Hono、路由等。
// 4. composition/required-ports 在模块内只允许 composition.ts 引用（模块外的
//    合法形态——provider `application/adapters/*-adapter.ts` type-only——由
//    rfc294-architecture-preflight 放行并记账）。
//
// 变异实证（2026-08-18，开发期手工做过一轮）：在 domain 下临时放一个
// `import { Hono } from 'hono'` 文件 → 第 3 条红；在 services/ 下临时 import
// composition.ts → 第 2 条红；public/ 下临时建 misc.ts → 第 1 条红。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const BACKEND_SRC = resolve(REPO_ROOT, 'packages', 'backend', 'src')
const MODULE_ROOT = join(BACKEND_SRC, 'modules', 'development-automation')
const MODULE_SPEC = '@/modules/development-automation'

const TOP_LEVEL_ALLOWED_DIRS = new Set([
  'domain',
  'application',
  'engine',
  'ports',
  'infrastructure',
  'public',
  'composition',
])
const TOP_LEVEL_ALLOWED_FILES = new Set(['composition.ts'])
const PUBLIC_ALLOWED = new Set([
  'commands.ts',
  'queries.ts',
  'participants.ts',
  'events.ts',
  'types.ts',
])

/** 消费者账本：import 这两个入口的仓内生产文件（相对 backend/src）。 */
const COMPOSITION_CONSUMERS: string[] = []
const REQUIRED_PORTS_CONSUMERS: string[] = []

function walk(dir: string, out: string[] = []): string[] {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names.sort()) {
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) {
      if (name === 'node_modules') continue
      walk(abs, out)
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      out.push(abs)
    }
  }
  return out
}

interface Edge {
  file: string
  specifier: string
  typeOnly: boolean
}

const FROM_RE = /(?:^|\n)\s*(import|export)\s+(type\s+)?[^'"\n]*?from\s*['"]([^'"]+)['"]/g
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
const DYNAMIC_RE = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function edgesOf(file: string): Edge[] {
  const text = readFileSync(file, 'utf8')
  const edges: Edge[] = []
  for (const m of text.matchAll(FROM_RE)) {
    edges.push({ file, specifier: m[3]!, typeOnly: m[2] !== undefined })
  }
  for (const m of text.matchAll(BARE_IMPORT_RE))
    edges.push({ file, specifier: m[1]!, typeOnly: false })
  for (const m of text.matchAll(DYNAMIC_RE)) edges.push({ file, specifier: m[1]!, typeOnly: false })
  return edges
}

function rel(file: string): string {
  return relative(BACKEND_SRC, file).replaceAll('\\', '/')
}

describe('rfc310 development-automation architecture lock', () => {
  test('module top-level structure stays the closed RFC-294 shape', () => {
    const offenders: string[] = []
    for (const name of readdirSync(MODULE_ROOT).sort()) {
      const st = statSync(join(MODULE_ROOT, name))
      if (st.isDirectory()) {
        if (!TOP_LEVEL_ALLOWED_DIRS.has(name)) offenders.push(`dir:${name}`)
      } else if (!TOP_LEVEL_ALLOWED_FILES.has(name)) {
        offenders.push(`file:${name}`)
      }
    }
    const publicDir = join(MODULE_ROOT, 'public')
    let publicNames: string[] = []
    try {
      publicNames = readdirSync(publicDir)
    } catch {
      publicNames = []
    }
    for (const name of publicNames.sort()) {
      if (!PUBLIC_ALLOWED.has(name)) offenders.push(`public:${name}`)
    }
    expect(offenders).toEqual([])
  }, 30_000)

  test('composition entrypoints have exactly the ledgered consumers', () => {
    const files = walk(BACKEND_SRC)
    const compositionConsumers: string[] = []
    const requiredPortConsumers: string[] = []
    for (const file of files) {
      if (file.startsWith(MODULE_ROOT)) continue
      for (const edge of edgesOf(file)) {
        if (
          edge.specifier === `${MODULE_SPEC}/composition` ||
          edge.specifier === `${MODULE_SPEC}/composition.ts`
        ) {
          compositionConsumers.push(rel(file))
        }
        if (edge.specifier === `${MODULE_SPEC}/composition/required-ports`) {
          requiredPortConsumers.push(rel(file))
        }
      }
    }
    expect(compositionConsumers.sort()).toEqual(COMPOSITION_CONSUMERS)
    expect(requiredPortConsumers.sort()).toEqual(REQUIRED_PORTS_CONSUMERS)
  }, 30_000)

  test('intra-module layering: domain pure; app/engine/public never touch infrastructure or transport', () => {
    const offenders: string[] = []
    for (const file of walk(MODULE_ROOT)) {
      const inside = relative(MODULE_ROOT, file).replaceAll('\\', '/')
      for (const edge of edgesOf(file)) {
        const s = edge.specifier
        const own = (layer: string): boolean =>
          s.startsWith(`${MODULE_SPEC}/${layer}`) ||
          s.includes(`../${layer}/`) ||
          s.includes(`./${layer}/`)
        const flag = (why: string): void => {
          offenders.push(`${inside} -> ${s} (${why})`)
        }
        if (inside.startsWith('domain/')) {
          const allowed =
            s === 'zod' ||
            s === '@/util/hash' || // 纯 hash 函数（RFC-284 单步 idiom 唯一源）；其余 @/util 仍禁止
            s.startsWith('@agent-workflow/shared') ||
            s.startsWith(`${MODULE_SPEC}/domain`) ||
            (s.startsWith('.') &&
              !['application', 'engine', 'infrastructure', 'ports', 'composition', 'public'].some(
                own,
              ))
          if (!allowed) flag('domain must stay pure')
          continue
        }
        const touchesInfra = own('infrastructure')
        const transport = /^(?:hono\b|@\/routes|@\/server|@\/ws|@\/mcp)/.test(s)
        if (inside.startsWith('application/') && (touchesInfra || transport)) {
          flag('application must not touch infrastructure/transport')
        }
        if (inside.startsWith('engine/') && (touchesInfra || transport || s.startsWith('@/db'))) {
          flag('engine must not touch infrastructure/transport/db')
        }
        if (inside.startsWith('public/') && (touchesInfra || transport || s.startsWith('@/db'))) {
          flag('public must not touch infrastructure/transport/db')
        }
        if (inside !== 'composition.ts' && s === `${MODULE_SPEC}/composition/required-ports`) {
          flag('required-ports is composition/adapter-only')
        }
        // T7：新路径不得消费被取代的 code-capability（含其 generic
        // `action: string` code-host port）；code-host 副作用只走本模块
        // required-ports 的 closed DevelopmentCodeHostEffect。
        if (s.startsWith('@/modules/code-capability')) {
          flag('development-automation must not consume legacy code-capability')
        }
      }
    }
    expect(offenders).toEqual([])
  }, 30_000)

  test('T7: no git identity injection tokens inside the digital-employee module', () => {
    // 2026-08-18 裁决：数字员工零 Git identity 注入（daemon env 继承保留，
    // 但平台不得在新模块里手搓 GIT_AUTHOR/COMMITTER 写入）。注释行不扫。
    const offenders: string[] = []
    for (const file of walk(MODULE_ROOT)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, index) => {
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return
        if (/GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)|gitUserName|gitUserEmail/.test(line)) {
          offenders.push(`${relative(MODULE_ROOT, file)}:${index + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  }, 30_000)

  test('required-ports DTOs stay opaque: no credentials/db/host handles in code lines', () => {
    // design.md §1.5：port DTO 只许 opaque ref/closed union/digest/revision/
    // budget/capability 票据。注释行（// 与 *）不参与扫描——RFC-072 教训。
    const text = readFileSync(join(MODULE_ROOT, 'composition', 'required-ports.ts'), 'utf8')
    const codeLines = text.split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    const banned: [RegExp, string][] = [
      [/DbClient/, 'DbClient'],
      [/AbortSignal/, 'AbortSignal'],
      [/Record<\s*string\s*,\s*unknown\s*>/, 'open Record<string, unknown>'],
      [/https?:\/\//, 'URL literal'],
      [/\bsessionId\b/, 'runtime session id'],
      [/\bcredential/i, 'credential'],
      [/\bsecret/i, 'secret material'],
      [/\babsolutePath\b|\bhostPath\b/, 'host path field'],
    ]
    const offenders: string[] = []
    codeLines.forEach((line) => {
      for (const [re, label] of banned) {
        if (re.test(line)) offenders.push(`${label}: ${line.trim()}`)
      }
    })
    expect(offenders).toEqual([])
  }, 30_000)

  test('composition entrypoint has no business branching and no db import', () => {
    // RFC-294 §2：composition 只实例化/注入——不查 DB、不做业务 if/switch。
    const text = readFileSync(join(MODULE_ROOT, 'composition.ts'), 'utf8')
    const codeLines = text.split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    const offenders: string[] = []
    codeLines.forEach((line) => {
      if (/^\s*(?:if|switch|for|while)\b/.test(line)) offenders.push(`branch: ${line.trim()}`)
      if (/@\/db\b/.test(line) && !/import\s+type/.test(line)) {
        offenders.push(`db value import: ${line.trim()}`)
      }
    })
    expect(offenders).toEqual([])
  }, 30_000)
})
