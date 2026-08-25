// RFC-326 — `review-doc` mode: answers EVERY port the prompt declares with the
// same fixed, markup-rich markdown design document.
//
// The review-gate e2e (e2e/rfc326-mcp-review-tools.spec.ts) needs a document
// with a title, inline code, a repeated word, a fenced code block and an HTML
// comment — the exact shapes the simplified anchor resolver and the offset
// highlighter must get right — and it needs the SAME document every time the
// designer runs (iterate re-runs the designer; the gate must re-open on a
// pending review again). `basic` answers a fixed `answer` port with one line;
// this mode reads the declared port names off the protocol block's example
// (`<port name="design">…</port>`) and fills each with REVIEW_DOC_BODY, so the
// workflow's port names stay the fixture's business.

import {
  emitPromptForContractTest,
  emitTextEvent,
  envelope,
  parseInvocation,
  requireOutputOpen,
  writeInventoryIfRequested,
} from './skeleton'

const NAME = 'stub-opencode[review-doc]'

export const REVIEW_DOC_BODY = [
  '# Order status design',
  '',
  '## Summary',
  '',
  'The `order_status` enum should include partially_refunded.',
  '',
  '## Notes',
  '',
  'The export job reads the enum too.',
  '',
  '```ts',
  'const orderStatus = "partially_refunded"',
  '```',
  '',
  '<!-- reviewer note: not rendered -->',
  '',
].join('\n')

/**
 * Port names the protocol block declares (`  <port name="X">…</port>` examples).
 *
 * Scoped to the **nonce-bearing** `<workflow-output nonce="…">…</workflow-output>`
 * block that `buildProtocolBlock` (packages/shared/src/prompt.ts) appends. Scanning
 * the whole prompt was wrong twice over: a workgroup / clarify prompt mentions
 * `<port name="NAME" active="false">` and other control ports in its prose, and a
 * hyphenated port name (`design-doc`) did not match `[A-Za-z0-9_]+` at all, so the
 * stub answered a port the workflow never declared — or none.
 */
export function declaredPorts(prompt: string): string[] {
  const names = new Set<string>()
  const blocks = prompt.matchAll(
    /<workflow-output\s+nonce="[^"]*"\s*>([\s\S]*?)<\/workflow-output>/g,
  )
  for (const block of blocks) {
    for (const m of (block[1] ?? '').matchAll(/<port name="([A-Za-z0-9_-]+)"/g)) {
      if (m[1] !== undefined && m[1] !== 'NAME') names.add(m[1])
    }
  }
  return [...names]
}

export function run(argv: readonly string[]): void {
  const call = parseInvocation(argv, NAME)
  if (call.kind === 'version') {
    process.stdout.write('stub-opencode review-doc\n')
    process.exit(0)
  }
  emitPromptForContractTest(call.prompt)
  const open = requireOutputOpen(call.prompt, NAME)
  writeInventoryIfRequested(
    '{"schemaVersion":1,"capturedAt":1700000000000,"agents":[],"skills":[],"mcps":[],"plugins":[]}\n',
  )
  const ports = declaredPorts(call.prompt)
  const names = ports.length > 0 ? ports : ['answer']
  emitTextEvent(
    envelope(
      open,
      names.map((name) => [name, REVIEW_DOC_BODY]),
    ),
  )
  process.exit(0)
}
