// RFC-062 PR-A T9 — grep guard: every scheduler-path consumer of
// `workflow.edges` / `definition.edges` must either filter via
// filterDataEdges / filterFeedbackEdges or explicitly annotate
// "// edges:include-system <reason>".
//
// This is the structural fence that keeps the feedback-edge contract
// alive after 2026-05-25. Without it, the next refactor that touches
// scheduler-v2 / fanout / etc. can silently re-introduce gating on
// feedback edges and re-deadlock every cross-clarify workflow.
//
// Whitelist (file-scope `// edges:include-system file-scope` marker):
//   - packages/backend/src/services/workflow.validator.ts
//       The structural validator iterates edges ~30 times and explicitly
//       needs to see EVERY edge (data + feedback) to validate port
//       existence, cycle detection on the relevant subgraphs, etc.
//
// Frontend canvas/ is excluded from the scan — editor code lives in a
// different topology (drag/drop/select), not gating.

import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')

/** Directories to scan. Tests are out of scope (test fixtures often need raw edges). */
const SCAN_ROOTS = [
  resolve(REPO_ROOT, 'packages', 'backend', 'src'),
  resolve(REPO_ROOT, 'packages', 'shared', 'src'),
]

/** Files whitelisted via file-scope marker (see header). */
const FILE_SCOPE_MARKER = '// edges:include-system file-scope'

/** Inline annotation marker the guard accepts within ~10 lines of an edges hit. */
const INLINE_MARKER_RE = /\/\/\s*edges:include-system\b/

/** Recognized "edges-aware" import / helper tokens that prove the file thinks about gating. */
const SAFE_HELPER_RE =
  /\bfilterDataEdges\b|\bfilterFeedbackEdges\b|\bisFeedbackEdge\b|\bSYSTEM_PORT_NAMES\b/

/** The risky iteration patterns. */
const EDGES_HIT_RE =
  /\b(?:workflow|workflowDef|defn|def|snap|definition|prev|prevDef|nextDef|draft|result|fixture|inner)\.edges\b/

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
    else if (e.isFile() && /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

describe('RFC-062 grep guard — workflow.edges consumers must filter or annotate', () => {
  test('every scheduler-path edges iteration is filtered or annotated', async () => {
    const violations: string[] = []
    for (const root of SCAN_ROOTS) {
      const files = await walk(root)
      for (const f of files) {
        const content = await readFile(f, 'utf-8')
        if (content.includes(FILE_SCOPE_MARKER)) continue

        // The shared/workflow-edges.ts file itself defines the helpers and
        // is permitted to mention `workflow.edges` in JSDoc / examples.
        if (f.endsWith('/workflow-edges.ts')) continue

        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          if (!EDGES_HIT_RE.test(line)) continue
          // Skip comment lines (// or *) — only flag actual code hits.
          const trimmed = line.trim()
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue

          // Look for a safe helper / annotation in a small window (this line
          // ± 6 lines covers the typical `const edges = ...` then
          // `filterDataEdges(...)` two lines down pattern).
          const windowStart = Math.max(0, i - 6)
          const windowEnd = Math.min(lines.length, i + 7)
          const window = lines.slice(windowStart, windowEnd).join('\n')
          const annotated = INLINE_MARKER_RE.test(window) || SAFE_HELPER_RE.test(window)
          if (!annotated) {
            violations.push(`${relative(REPO_ROOT, f)}:${i + 1}  ${line.trim()}`)
          }
        }
      }
    }
    if (violations.length > 0) {
      const msg =
        `RFC-062 §2 grep guard violation: ${violations.length} unannotated workflow.edges iteration(s).\n\n` +
        violations.join('\n') +
        `\n\nFix: either use filterDataEdges/filterFeedbackEdges from @agent-workflow/shared, ` +
        `or annotate the line with "// edges:include-system <reason>".`
      throw new Error(msg)
    }
  })
})
