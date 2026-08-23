// RFC-222/RFC-305 — resource ACL administration is a permission, not a role
// identity. This guard prevents either retired role predicate from returning.

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')
const SHARED_SRC = resolve(import.meta.dir, '..', '..', 'shared', 'src')

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) out.push(...listTsFiles(p))
    else if (s.isFile() && /\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(p)
  }
  return out
}

function isCommentLine(line: string): boolean {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

interface Hit {
  file: string
  line: number
  text: string
}

describe('RFC-222/RFC-305 — resource ACL bypass single source of truth', () => {
  test('retired isAdminActor identifier appears nowhere in production', () => {
    const offenders: Hit[] = []
    for (const file of listTsFiles(BACKEND_SRC)) {
      // RFC-254: relativize via path.relative + normalize to '/' — a literal
      // `${SRC}/` replace fails on Windows (backslash paths), leaving `rel` as the
      // full path so `resourceAcl.ts` never matched the skip and was mis-flagged.
      const rel = relative(BACKEND_SRC, file).replace(/\\/g, '/')
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return
        if (/\bisAdminActor\b/.test(line)) {
          offenders.push({ file: rel, line: i + 1, text: line.trim() })
        }
      })
    }
    if (offenders.length > 0) {
      const msg = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n')
      throw new Error(
        `RFC-305: retired isAdminActor leaked into ${offenders.length} site(s):\n${msg}\n` +
          `Authorization must consume explicit permissions.`,
      )
    }
    expect(offenders.length).toBe(0)
  })

  test('no admin∨manager role disjunction or retired shared predicate remains', () => {
    // Matches a hand-rolled union in either order, tolerant of whitespace and
    // an optional actor/user prefix on the second comparison.
    const DISJUNCTION =
      /'admin'\s*\|\|[^\n]*'manager'|'manager'\s*\|\|[^\n]*'admin'|===\s*'manager'[^\n]*\|\|[^\n]*===\s*'admin'/
    const offenders: Hit[] = []
    for (const file of [...listTsFiles(BACKEND_SRC), ...listTsFiles(SHARED_SRC)]) {
      // RFC-254: separator-safe relativization (see note above).
      const inShared = !relative(SHARED_SRC, file).startsWith('..')
      const rel = inShared
        ? `shared/${relative(SHARED_SRC, file).replace(/\\/g, '/')}`
        : relative(BACKEND_SRC, file).replace(/\\/g, '/')
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return
        if (DISJUNCTION.test(line) || /\bisResourceAdminRole\b/.test(line)) {
          offenders.push({ file: rel, line: i + 1, text: line.trim() })
        }
      })
    }
    if (offenders.length > 0) {
      const msg = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n')
      throw new Error(
        `RFC-305: role-based ACL authorization in ${offenders.length} site(s):\n${msg}\n` +
          `Use Actor.permissions through hasResourceAclBypass.`,
      )
    }
    expect(offenders.length).toBe(0)
  })
})

// RFC-317 T13 —— 语料非空（守卫的守卫：architecture/rfc317-guard-corpus-floor.test.ts）。
//
// 上面每条断言的绿都可能来自两处：真的没有违规，或者**扫描根失效、语料被筛成空**。
// 两者在断言层面同形，后者是永久静默的假绿。这一条把「扫描器还活着」变成可断言事实；
// 下限同时两向钉进 architecture/guard-manifest.json，静默调低会红。
describe('RFC-317 T13 —— 语料非空', () => {
  test('扫描确实覆盖到源码语料（扫空即假绿）', () => {
    expect(listTsFiles(BACKEND_SRC).length + listTsFiles(SHARED_SRC).length).toBeGreaterThanOrEqual(
      350,
    )
  })
})
