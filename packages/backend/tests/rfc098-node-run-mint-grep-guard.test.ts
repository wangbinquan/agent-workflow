// RFC-098 WP-10 T-a (audit S-16) — source-grep guard against direct
// node_runs INSERTS outside the single mint factory.
//
// Before WP-10, 13 call sites across 6 files each hand-rolled their own
// `db.insert(nodeRuns).values({...})` with hand-copied inheritance subsets —
// the substrate the proxy-signal gating bugs (audit S-25) grew on. All
// minting now goes through `mintNodeRun()` (services/nodeRunMint.ts), which
// owns the single inheritance list, the born-running invariant and (T-b) the
// rerun_cause column write.
//
// Mechanism mirrors lifecycle-grep-guard.test.ts (RFC-053): production
// source files under packages/backend/src must contain ZERO direct inserts
// except the factory itself; a deliberate future exception can opt out with
// `// rfc098-allow-direct-node-run-insert` on (or within 5 lines above) the
// insert line — and must justify itself in review.

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')
const MINT_FACTORY = resolve(BACKEND_SRC, 'services', 'nodeRunMint.ts')

const PATTERN_INSERT_NODE_RUNS = /\.insert\s*\(\s*nodeRuns\s*\)/
const ALLOW_MARKER = /rfc098-allow-direct-node-run-insert/

function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*')
}

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) {
      out.push(...listTsFiles(p))
    } else if (s.isFile() && /\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      out.push(p)
    }
  }
  return out
}

interface Match {
  file: string
  line: number
  preview: string
}

function findDirectNodeRunInserts(): Match[] {
  const matches: Match[] = []
  for (const file of listTsFiles(BACKEND_SRC)) {
    const src = readFileSync(file, 'utf8')
    if (!src.includes('nodeRuns')) continue
    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (!PATTERN_INSERT_NODE_RUNS.test(line) || isCommentLine(line)) continue
      const lookbackStart = Math.max(0, i - 5)
      const preceding = lines.slice(lookbackStart, i + 1).join('\n')
      if (ALLOW_MARKER.test(preceding)) continue
      matches.push({
        file: file.split(sep).join('/').replace(`${BACKEND_SRC.split(sep).join('/')}/`, ''),
        line: i + 1,
        preview: `  ${i + 1}: ${line}`,
      })
    }
  }
  return matches
}

describe('RFC-098 WP-10 — no direct insert(nodeRuns) outside services/nodeRunMint.ts', () => {
  test('grep guard: zero direct node_runs inserts outside the mint factory', () => {
    const matches = findDirectNodeRunInserts()
    const offenders = matches.filter((m) => !m.file.endsWith('services/nodeRunMint.ts'))
    if (offenders.length > 0) {
      const msg = offenders.map((m) => `\n${m.file}:${m.line}\n${m.preview}\n`).join('\n---\n')
      throw new Error(
        `Found ${offenders.length} direct node_runs insert(s) outside services/nodeRunMint.ts:\n${msg}\n` +
          `Mint rows via mintNodeRun() from @/services/nodeRunMint (it owns the ` +
          `inheritance list, the born-running invariant and the rerun_cause write). ` +
          `If a direct insert is genuinely necessary, mark it with ` +
          `// rfc098-allow-direct-node-run-insert and justify it in review.`,
      )
    }
    expect(offenders.length).toBe(0)
  })

  test('the factory itself contains exactly ONE direct insert (regression guard)', () => {
    const src = readFileSync(MINT_FACTORY, 'utf8')
    const lines = src.split('\n')
    const direct = lines.filter((l) => PATTERN_INSERT_NODE_RUNS.test(l) && !isCommentLine(l)).length
    // If this fails the factory was refactored into multiple insert points —
    // re-establish the single-writer shape (or consciously update this pin).
    expect(direct).toBe(1)
  })
})
