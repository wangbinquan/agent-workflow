// RFC-053 PR-B P-1 — source-grep guard against direct node_runs.status writes.
//
// Forbids any future code from doing `db.update(nodeRuns).set({ status: ... })`
// outside the single allowlisted writer (`services/lifecycle.ts` itself).
// Forces consumers through `transitionNodeRunStatus()` or `setNodeRunStatus()`,
// which enforce the state machine and CAS predicate.
//
// Tests:
//   - production source files (packages/backend/src) must contain ZERO direct
//     writes (except inside the helper)
//   - the helper itself MUST contain exactly the documented direct writes
//     (regression guard for refactor of the helper)

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')
const LIFECYCLE_HELPER = resolve(BACKEND_SRC, 'services', 'lifecycle.ts')

/**
 * Match anything that looks like `.update(nodeRuns)` followed (eventually)
 * by `.set({ ... status: ... })`. The regex is intentionally permissive on
 * whitespace and chained-call line breaks; refinements only need to catch
 * the COMMON shape — false positives are surfaced as comments / are easy
 * to whitelist with `// rfc053-allow-direct-status-write`
 * style markers (the test scans for an inline allow marker on the line
 * above the match).
 */
const PATTERN_HAS_UPDATE_NODE_RUNS = /\.update\s*\(\s*nodeRuns\s*\)/
const PATTERN_HAS_SET_STATUS = /\.set\s*\(\s*\{[^}]*\bstatus\s*:/

/** Skip lines that look like comments (// or * leading). False positives in
 *  doc comments mentioning `db.update(nodeRuns).set({ status: ... })` are
 *  expected — the helper file's header documents exactly this string. */
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

function findDirectStatusWrites(): Match[] {
  const matches: Match[] = []
  for (const file of listTsFiles(BACKEND_SRC)) {
    const src = readFileSync(file, 'utf8')
    // Cheap pre-filter: only scan files that mention nodeRuns at all.
    if (!src.includes('nodeRuns')) continue
    const lines = src.split('\n')
    // Stateful scan: when we see `.update(nodeRuns)` we set a "look for
    // .set({...status...}) within the next N lines" window. This catches
    // multi-line chains where the .set lives on a separate line.
    let lookahead = 0
    let upstreamLine = -1
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (PATTERN_HAS_UPDATE_NODE_RUNS.test(line) && !isCommentLine(line)) {
        lookahead = 6 // 6 lines should cover any reasonable drizzle chain
        upstreamLine = i
        continue
      }
      if (lookahead > 0) {
        if (PATTERN_HAS_SET_STATUS.test(line)) {
          // Skip if opt-out marker present in the 5 preceding source lines
          // (covers multi-line drizzle chains where the marker sits above
          // the await/const but the actual .update(nodeRuns) is a few lines
          // further down).
          const lookbackStart = Math.max(0, upstreamLine - 5)
          const preceding = lines.slice(lookbackStart, i + 1).join('\n')
          if (/rfc053-allow-direct-status-write/.test(preceding)) {
            lookahead = 0
            continue
          }
          matches.push({
            file: file.split(sep).join("/").replace(`${BACKEND_SRC.split(sep).join("/")}/`, ""),
            line: i + 1,
            preview: lines
              .slice(Math.max(0, upstreamLine), Math.min(lines.length, i + 2))
              .map((l, idx) => `  ${upstreamLine + idx + 1}: ${l}`)
              .join('\n'),
          })
          lookahead = 0
        } else {
          lookahead -= 1
        }
      }
    }
    // Also catch single-line forms like
    // `db.update(nodeRuns).set({ status: 'foo' }).where(...)`.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (
        PATTERN_HAS_UPDATE_NODE_RUNS.test(line) &&
        PATTERN_HAS_SET_STATUS.test(line) &&
        !isCommentLine(line)
      ) {
        const lookbackStart = Math.max(0, i - 5)
        const preceding = lines.slice(lookbackStart, i + 1).join('\n')
        if (/rfc053-allow-direct-status-write/.test(preceding)) continue
        // Avoid duplicate of multi-line catch above — only add if not already
        // captured at this line.
        if (
          !matches.some(
            (m) => m.file.endsWith(file.split(sep).join("/").replace(`${BACKEND_SRC.split(sep).join("/")}/`, "")) && m.line === i + 1,
          )
        ) {
          matches.push({
            file: file.split(sep).join("/").replace(`${BACKEND_SRC.split(sep).join("/")}/`, ""),
            line: i + 1,
            preview: `  ${i + 1}: ${line}`,
          })
        }
      }
    }
  }
  return matches
}

describe('RFC-053 PR-B — no direct node_runs.status writes outside lifecycle.ts', () => {
  test('grep guard: zero direct status writes in services/ and routes/', () => {
    const matches = findDirectStatusWrites()
    // The lifecycle helper file itself is allowed to contain direct writes
    // (it's THE single writer). Filter it out.
    const offenders = matches.filter((m) => !m.file.endsWith('services/lifecycle.ts'))
    if (offenders.length > 0) {
      const msg = offenders.map((m) => `\n${m.file}:${m.line}\n${m.preview}\n`).join('\n---\n')
      // Embed offending sites in the error so the dev sees exactly what to fix.
      throw new Error(
        `Found ${offenders.length} direct node_runs.status write(s) outside services/lifecycle.ts:\n${msg}\n` +
          `Use transitionNodeRunStatus() or setNodeRunStatus() from @/services/lifecycle.`,
      )
    }
    expect(offenders.length).toBe(0)
  })

  test('the helper itself contains its expected direct writes (regression guard)', () => {
    const src = readFileSync(LIFECYCLE_HELPER, 'utf8')
    const lines = src.split('\n')
    let direct = 0
    // Scan for any `.update(nodeRuns)` and find the following `.set({status:...})`
    // within 6 lines. Each match must have the marker within 5 lines before
    // the .update line.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (!PATTERN_HAS_UPDATE_NODE_RUNS.test(line)) continue
      if (isCommentLine(line)) continue
      let found = PATTERN_HAS_SET_STATUS.test(line)
      if (!found) {
        for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
          if (PATTERN_HAS_SET_STATUS.test(lines[j]!)) {
            found = true
            break
          }
        }
      }
      if (!found) continue
      direct += 1
      const lookbackStart = Math.max(0, i - 5)
      const preceding = lines.slice(lookbackStart, i + 1).join('\n')
      expect(preceding).toContain('rfc053-allow-direct-status-write')
    }
    // Both transitionNodeRunStatus + setNodeRunStatus contain one direct write.
    expect(direct).toBeGreaterThanOrEqual(2)
  })
})
