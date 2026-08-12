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
//
// RFC-152 随迁：useTaskSync 从 if-链改为 useWsInvalidation 规则表——锁点从
// `if (msg.type === '…')` 分支迁至对应规则表条目（'clarify.answered' /
// 'cross-clarify.answered' / 'cross-clarify.rejected' 三个 key 的规则体必须
// 含 directive 键），锁的语义不变。

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const HOOK = resolve(__dirname, '..', 'src', 'hooks', 'useTaskSync.ts')
const norm = (s: string) => s.replace(/\s+/g, ' ')
function src(): string {
  return norm(readFileSync(HOOK, 'utf8'))
}

// RFC-286 F4 改锚：规则表零字面（工厂符号是新锁面，语义同旧字面）。
const DIRECTIVE_KEY = 'TASK_QUERY_KEYS.clarifyDirectives(taskId)'

describe('RFC-123 useTaskSync — answer-side clarify-directive refresh', () => {
  test('clarify.answered rule invalidates the directive toggles', () => {
    const s = src()
    const idx = s.lastIndexOf("'clarify.answered':")
    expect(idx).toBeGreaterThan(-1)
    // the directive key must sit inside that rule's returned key list (window
    // covers the RFC-123 comment + the prior tasks/node-runs keys).
    expect(s.slice(idx, idx + 800)).toContain(DIRECTIVE_KEY)
  })

  test('cross-clarify answer/reject rules invalidate the directive toggles', () => {
    const s = src()
    for (const ruleKey of ["'cross-clarify.answered':", "'cross-clarify.rejected':"]) {
      const idx = s.indexOf(ruleKey)
      expect(idx).toBeGreaterThan(-1)
      expect(s.slice(idx, idx + 220)).toContain(DIRECTIVE_KEY)
    }
  })
})
