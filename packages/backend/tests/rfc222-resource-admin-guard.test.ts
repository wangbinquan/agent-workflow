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
