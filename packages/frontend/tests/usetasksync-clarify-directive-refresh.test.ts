// RFC-123 source-level lock — the canvas "继续/停止反问" toggle reads
// ['task-clarify-directives', taskId]. A 'stop' ANSWER (self-clarify or
// cross-clarify) now writes that per-(task, asking-node) directive (single
// source of truth), so useTaskSync must refresh the toggles on the ANSWER
// events too — not only on the follow-up node.status from the rerun, otherwise
// an already-mounted canvas in another tab keeps showing 继续反问 until the
// rerun lands (Codex impl-gate P2).
//
// JSDOM can't reasonably drive the WS hook end-to-end (it wraps useWebSocket +
// react-query), so this is the CLAUDE.md "source-level text assertion" fallback:
// a refactor that drops either invalidation goes red.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const HOOK = resolve(__dirname, '..', 'src', 'hooks', 'useTaskSync.ts')
const norm = (s: string) => s.replace(/\s+/g, ' ')
function src(): string {
  return norm(readFileSync(HOOK, 'utf8'))
}

const DIRECTIVE_KEY = "queryKey: ['task-clarify-directives', taskId]"

describe('RFC-123 useTaskSync — answer-side clarify-directive refresh', () => {
  test('clarify.answered branch invalidates the directive toggles', () => {
    const s = src()
    const idx = s.lastIndexOf("if (msg.type === 'clarify.answered')")
    expect(idx).toBeGreaterThan(-1)
    // the directive invalidation must sit inside that branch (window covers the
    // RFC-123 comment + the prior tasks/node-runs invalidations).
    expect(s.slice(idx, idx + 800)).toContain(DIRECTIVE_KEY)
  })

  test('cross-clarify answer/reject branch invalidates the directive toggles', () => {
    const s = src()
    const idx = s.indexOf(
      "msg.type === 'cross-clarify.answered' || msg.type === 'cross-clarify.rejected'",
    )
    expect(idx).toBeGreaterThan(-1)
    expect(s.slice(idx, idx + 220)).toContain(DIRECTIVE_KEY)
  })
})
