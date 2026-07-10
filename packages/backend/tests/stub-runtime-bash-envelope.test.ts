/**
 * Regression guard for the `.sh` stub-opencode envelope JSON bug.
 *
 * The `.sh` stub (Linux/macOS CI) emits its workflow-output envelope via
 * `printf '{"type":"text","ts":%s,"text":"%s"}\n' "$TS" "$ENV"`. `printf %s`
 * substitutes ENV verbatim and does NOT JSON-escape, so every `"` in the
 * envelope (every `<port name="...">` attribute) used to close the JSON text
 * string early. parseEnvelope then reported `malformed (unclosed) ports` and
 * the task failed - which is exactly what made task-fetch BP-01/02/03 red on
 * ubuntu/macOS CI while passing locally on Windows (the `.js` stub uses
 * JSON.stringify and was always correct).
 *
 * buildBashEnvelope now escapes `"` -> `\"` before the value reaches printf.
 * These tests lock that invariant with pure-string assertions (no bash
 * execution) so they run identically on all three CI legs.
 *
 * Background: stub-runtime.ts is RFC-W001-only code (upstream has no
 * Windows-test helpers), so this bug was introduced by the RFC-W001 work
 * itself, not inherited.
 */
import { test, expect } from 'bun:test'
import { buildBashEnvelope } from './helpers/stub-runtime'

/**
 * Reproduce what `printf '...%s...' "$TS" "$ENV"` writes to stdout: the ENV
 * value (single-quoted in the generated bash) is substituted verbatim into the
 * JSON template's `%s` slot. We extract ENV from the generated code and splice
 * it into the template the same way printf does, then hand the result to
 * JSON.parse. If `"` is not escaped, JSON.parse throws "Unterminated string".
 */
function emitJson(outputs: Record<string, string>, ts = 1700000000000): string {
  const code = buildBashEnvelope(outputs)
  // ENV='...' is the first line; the envelope payload contains no single
  // quotes for the inputs used here (content is plain text), so a simple
  // single-quoted extraction is exact.
  const m = code.match(/^ENV='(.*)'$/m)
  if (!m) throw new Error('could not find ENV line in generated stub')
  const env = m[1]
  // printf format: {"type":"text","ts":%s,"text":"%s"}\n  (trailing \n dropped)
  return `{"type":"text","ts":${ts},"text":"${env}"}`
}

test('buildBashEnvelope emits valid JSON for a single port (the BP-01 case)', () => {
  const json = emitJson({ out: 'hello' })
  const parsed = JSON.parse(json) // throws if " not escaped
  expect(parsed.type).toBe('text')
  expect(parsed.text).toContain('<port name="out">hello</port>')
})

test('buildBashEnvelope escapes " in port attributes for multiple ports (BP-02/03)', () => {
  const json = emitJson({ out: 'hello', audit: 'clean', fix: 'patched' })
  const parsed = JSON.parse(json)
  expect(parsed.text).toContain('<port name="out">hello</port>')
  expect(parsed.text).toContain('<port name="audit">clean</port>')
  expect(parsed.text).toContain('<port name="fix">patched</port>')
})

test('buildBashEnvelope escapes " that appears inside port content', () => {
  // Content carrying a literal double-quote must not break the JSON either.
  const json = emitJson({ out: 'a"b' })
  const parsed = JSON.parse(json)
  expect(parsed.text).toContain('<port name="out">a"b</port>')
})

test('without the escape the same payload is invalid JSON (locks the regression)', () => {
  // Directly prove the failure mode the fix closes: the raw (unescaped) envelope
  // in the printf template is NOT valid JSON. If someone reverts the
  // `"` -> `\"` escape, this test stays green but the two tests above go red -
  // together they pin "escape is required AND sufficient".
  const envelope = `<workflow-output>\n  <port name="out">hello</port>\n</workflow-output>`
  const rawJson = `{"type":"text","ts":1,"text":"${envelope}"}`
  expect(() => JSON.parse(rawJson)).toThrow()
})
