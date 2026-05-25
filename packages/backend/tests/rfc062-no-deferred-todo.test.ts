// RFC-062 PR-A T9 — grep guard: "未接通占位" must not land on main.
//
// daemonResume.ts shipped to production with Step 4 self-described as
// "caller's responsibility for now" + "unused in production". Nothing
// in production called it; every resumed task sat with a queued wake
// and no draining actor. This guard fails any future PR that
// reintroduces a stub-with-explicit-deferral pattern.
//
// Banned phrases (case-sensitive substring match in src/ files):
//   - "unused in production"
//   - "caller's responsibility for now"
//   - "TODO: wire up"
//   - "the daemon hard-cut commit wires this up"
//
// Exempt:
//   - this test file (we need to MENTION the strings to match them)
//   - any file that uses `// log-only: reason` (different category)

import { describe, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')

const SCAN_ROOTS = [
  resolve(REPO_ROOT, 'packages', 'backend', 'src'),
  resolve(REPO_ROOT, 'packages', 'shared', 'src'),
  resolve(REPO_ROOT, 'packages', 'frontend', 'src'),
]

const FORBIDDEN_PHRASES = [
  'unused in production',
  "caller's responsibility for now",
  'TODO: wire up',
  'the daemon hard-cut commit wires this up',
]

/** Files allowed to mention the phrases (because they DEFINE the guard). */
const WHITELIST_BASENAMES = new Set(['rfc062-no-deferred-todo.test.ts'])

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else if (e.isFile() && /\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

describe('RFC-062 grep guard — no deferred-TODO occupants in main', () => {
  test('source tree contains zero "unused in production" / "TODO: wire up" / similar dead-letter phrases', async () => {
    const violations: string[] = []
    for (const root of SCAN_ROOTS) {
      const files = await walk(root)
      for (const f of files) {
        const base = f.split('/').pop() ?? ''
        if (WHITELIST_BASENAMES.has(base)) continue
        const content = await readFile(f, 'utf-8')
        for (const phrase of FORBIDDEN_PHRASES) {
          if (content.includes(phrase)) {
            const lineIdx = content.split('\n').findIndex((l) => l.includes(phrase))
            violations.push(`${relative(REPO_ROOT, f)}:${lineIdx + 1}  "${phrase}"`)
          }
        }
      }
    }
    if (violations.length > 0) {
      const msg =
        `RFC-062 §2.5 grep guard violation: ${violations.length} deferred-TODO marker(s) found.\n\n` +
        violations.join('\n') +
        `\n\nFix: either FINISH the deferred work (the original incident was caused by ` +
        `daemonResume Step 4 shipping with "unused in production" — Step 4 never ran in ` +
        `prod and tasks deadlocked after every daemon restart), or rephrase the comment ` +
        `if the work is genuinely complete and the phrase is just historical.`
      throw new Error(msg)
    }
  })
})
