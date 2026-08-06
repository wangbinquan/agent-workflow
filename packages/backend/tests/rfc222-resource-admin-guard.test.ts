// RFC-222 (G-1) — resource-domain identity single-source guard.
//
// The resource-domain admin bypass (admin ∪ manager) must funnel through ONE
// predicate: shared `isResourceAdminRole` → services/resourceAcl.ts
// `isResourceAdminActor` → the route gate's `identity: 'resource-admin'` door
// (routes/registry.ts `routeMetaGate`; the old `requireResourceAdmin`
// middleware died with the legacy auth/permissions.ts layer). Two drifts this
// pins:
//
//   1. `isAdminActor` (the SYSTEM-admin predicate) must not reappear in a
//      resource-domain path — every resource caller was switched to
//      isResourceAdminActor. Its only home is services/resourceAcl.ts (the
//      definition, still exported for genuine system-domain use).
//
//   2. Nobody hand-writes the admin∨manager role disjunction — that logic lives
//      only in shared `isResourceAdminRole`. A hand-rolled
//      `role === 'admin' || role === 'manager'` elsewhere is exactly the
//      duplicated source of truth this RFC set out to avoid.
//
// Mutation proof: swap any resource-file `isResourceAdminActor` back to
// `isAdminActor`, or inline an admin∨manager check, and one of these reds.

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

describe('RFC-222 G-1 — resource-admin identity single source of truth', () => {
  test('isAdminActor identifier appears only in services/resourceAcl.ts', () => {
    const offenders: Hit[] = []
    for (const file of listTsFiles(BACKEND_SRC)) {
      // RFC-254: relativize via path.relative + normalize to '/' — a literal
      // `${SRC}/` replace fails on Windows (backslash paths), leaving `rel` as the
      // full path so `resourceAcl.ts` never matched the skip and was mis-flagged.
      const rel = relative(BACKEND_SRC, file).replace(/\\/g, '/')
      if (rel === 'services/resourceAcl.ts') continue // the definition lives here
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
        `RFC-222: isAdminActor (system-admin predicate) leaked into ${offenders.length} ` +
          `resource-domain site(s):\n${msg}\n` +
          `Resource-domain checks must use isResourceAdminActor (admin ∪ manager).`,
      )
    }
    expect(offenders.length).toBe(0)
  })

  test('the admin∨manager role disjunction lives only in shared isResourceAdminRole', () => {
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
      // The single legal home of the predicate.
      if (rel === 'shared/schemas/permission.ts') continue
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return
        if (DISJUNCTION.test(line)) offenders.push({ file: rel, line: i + 1, text: line.trim() })
      })
    }
    if (offenders.length > 0) {
      const msg = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n')
      throw new Error(
        `RFC-222: hand-written admin∨manager role union in ${offenders.length} site(s):\n${msg}\n` +
          `Use isResourceAdminRole / isResourceAdminActor instead.`,
      )
    }
    expect(offenders.length).toBe(0)
  })
})
