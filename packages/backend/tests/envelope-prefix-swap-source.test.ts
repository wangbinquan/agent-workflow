// RFC-049 PR-A — source-level grep guard for the envelope errCode prefix
// swap from `markdown-file-*` to the kind-namespaced
// `port-validation-<kind>-<sub>` form.
//
// The hard invariants:
//   1. envelope.ts must NOT contain any of the three legacy literal codes
//      `markdown-file-empty-path` / `markdown-file-escapes-worktree` /
//      `markdown-file-read-failed` — those are dead aliases now.
//   2. envelope.ts must NOT contain non-namespaced `port-validation-<sub>`
//      bare-sub forms either (e.g. `port-validation-empty-path` without the
//      `markdown_file-` middle segment) — that would indicate the prefix
//      swap was applied half-way and the kind segment is missing.
//   3. envelope.ts MUST contain the three new namespaced literal codes:
//      `port-validation-markdown_file-empty-path` / `-escapes-worktree` /
//      `-missing-file` — proves the new dispatch is in place.
//
// These checks live at the source level (string scan of envelope.ts) rather
// than the behavior level because the actual error codes are now constructed
// at runtime via template literals (`port-validation-${kind}-${result.subReason}`)
// and the kind / subReason come from registered handlers — they don't appear
// as bare string literals anywhere in envelope.ts. The grep here proves the
// generated codes match the documented namespace by verifying:
//   - the template literal still uses `port-validation-${kind}-` (NOT
//     `port-validation-` bare nor the legacy `markdown-file-` form), AND
//   - the markdown_file handler produces the right subReasons (covered
//     separately in packages/shared/tests/output-kinds-markdown-file.test.ts).
// Together these two layers lock the final wire format.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ENVELOPE_SRC = readFileSync(join(import.meta.dir, '../src/services/envelope.ts'), 'utf8')

describe('RFC-049 envelope.ts source-level prefix swap guard', () => {
  test('legacy `markdown-file-*` errCode literals are gone', () => {
    for (const literal of [
      'markdown-file-empty-path',
      'markdown-file-escapes-worktree',
      'markdown-file-read-failed',
    ]) {
      expect(ENVELOPE_SRC).not.toContain(literal)
    }
  })

  test('the errCode is built via the shared formatPortValidationErrCode helper', () => {
    // RFC-080 (D2): the inline `port-validation-${kind}-...` template literal
    // was replaced by `formatPortValidationErrCode(handler.displayName, ...)`,
    // so the namespace is the parametric handler's displayName (e.g. `path`,
    // never `<>`). The errCode format now lives with the registry, not inline.
    expect(ENVELOPE_SRC).toContain(
      'formatPortValidationErrCode(handler.displayName, result.subReason)',
    )
    // The old inline template literal must be gone.
    expect(ENVELOPE_SRC).not.toContain('`port-validation-${kind}-${result.subReason}`')
  })

  test('non-namespaced `port-validation-<sub>` bare-sub forms are NOT present', () => {
    // These would only appear if the prefix swap was applied half-way; the
    // <kind> middle segment must be present for the registry / scheduler
    // routing to keep working.
    for (const bare of [
      'port-validation-empty-path',
      'port-validation-escapes-worktree',
      'port-validation-missing-file',
      'port-validation-wrong-extension',
      'port-validation-empty-file',
    ]) {
      // Bare 'port-validation-<sub>' should never appear as a string literal.
      // We can't use a regex against the template literal form because that
      // is `${kind}-` not `markdown_file-`; instead we check that none of
      // the bare-sub literals appear as standalone strings.
      expect(ENVELOPE_SRC).not.toContain(`'${bare}'`)
      expect(ENVELOPE_SRC).not.toContain(`"${bare}"`)
    }
  })

  test('forgiveness READ path is gone; realpath is containment-only (RFC-049 PR-B / RFC-103 T7)', () => {
    // RFC-049 PR-B removed the auto-promote helper + its caller; undeclared
    // kinds now return rawContent verbatim. The forgiveness READ/auto-promote
    // path must stay gone (if this grep flips to `.toContain`, it regressed).
    expect(ENVELOPE_SRC).not.toContain('tryReadInWorktreeMarkdownPath')
    // statSync (a forgiveness existence-probe) stays gone.
    expect(ENVELOPE_SRC).not.toContain('statSync')
    // RFC-103 T7 → RFC-284 T6 改判：realpath containment 不再由本文件手写——
    // 双查骨架收敛到 util/safePath.checkLexicalThenRealpath（containment-only
    // by construction），envelope 内直接 realpathSync 归零。锁的意图不变：
    // resolveWorktreePath 的 realpath 消费必须仍是 containment（经骨架），
    // 且绝不许回潮为 auto-read/promote 路径（上面两条 not.toContain 继续守）。
    // 象限级语义由 rfc284-containment-quadrants.test.ts 拍死。
    expect(ENVELOPE_SRC).not.toContain('realpathSync')
    expect(ENVELOPE_SRC).toMatch(/resolveWorktreePath[\s\S]*?checkLexicalThenRealpath/)
  })

  test('PortValidationError is exported with a structured failure payload field', () => {
    // PR-B introduces a ValidationError subclass that carries the structured
    // failure object the runner persists to port_validation_failures_json.
    expect(ENVELOPE_SRC).toContain('export class PortValidationError')
    expect(ENVELOPE_SRC).toContain('public readonly failure')
  })
})
