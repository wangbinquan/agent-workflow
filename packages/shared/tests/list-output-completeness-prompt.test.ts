// List-completeness prompt guidance — regression lock.
//
// WHY THIS EXISTS: agents driving a `list<T>` output port were frequently
// returning a SINGLE element instead of the full list. Root cause: the trailing
// `<workflow-output>` Format example rendered every list port as a one-line
// `<port name="x">...</port>` shape, which silently contradicted the "one item
// per line" prose and primed the model to emit just one value.
//
// The fix pushes the SAME "emit EVERY item / output the complete list" signal
// through all four list-handler surfaces (bullet + multi-line example + first-
// turn guidance + repair block) AND through the incremental envelope-followup
// prompt. These assertions lock that signal in. If they go red, the prompt has
// drifted back toward the single-element failure mode — re-confirm before
// relaxing.
//
// Companion byte-baseline anchors that must NOT be disturbed by this change live
// in: build-protocol-block-via-handlers.test.ts, rfc080-parametric-runtime-
// migration.test.ts, output-kinds-registry.test.ts, backend/protocol.test.ts,
// envelope-followup-prompt.test.ts.

import { describe, expect, test } from 'bun:test'

import {
  buildProtocolBlock,
  renderEnvelopeFollowupPrompt,
  getHandlerForParsedKind,
  parseKind,
} from '@agent-workflow/shared'

const DOC_BOUNDARY = '<!-- @@aw-doc-boundary@@ -->'

describe('list-completeness — first-turn protocol block', () => {
  test('list port bullet spells out "emit EVERY item / complete list"', () => {
    const block = buildProtocolBlock(['tags'], { tags: 'list<string>' })
    expect(block).toContain(
      '- tags (list — emit EVERY item, one per line; output the complete list, not a single example)',
    )
  })

  test('list<markdown> bullet uses document/boundary wording, never "one per line"', () => {
    // Regression for Codex P2: list<markdown> items are boundary-separated
    // multi-line documents; the bullet must NOT tell the agent "one per line"
    // (that contradicts the boundary example/guidance and corrupts docs).
    const block = buildProtocolBlock(['notes'], { notes: 'list<markdown>' })
    expect(block).toContain('- notes (list<markdown> — emit EVERY document')
    const bulletLine = block.split('\n').find((l) => l.startsWith('  - notes ')) ?? ''
    expect(bulletLine).not.toContain('one per line')
  })

  test('list<string> example is MULTI-LINE (not the misleading single-line `...`)', () => {
    const block = buildProtocolBlock(['tags'], { tags: 'list<string>' })
    // The exact failure mode we are guarding against: a lone single-line example.
    expect(block).not.toContain('<port name="tags">...</port>')
    // The example now shows ≥2 item lines + an explicit "list EVERY item" tail.
    expect(block).toContain('<port name="tags">\nfirst string item\nsecond string item')
    expect(block).toContain('...one item per line — list EVERY item, do not stop after the first')
  })

  test('list<path<md>> example reflects the inner item kind', () => {
    const block = buildProtocolBlock(['docs'], { docs: 'list<path<md>>' })
    expect(block).toContain('first path<md> item')
    expect(block).toContain('second path<md> item')
  })

  test('list<markdown> example shows multiple docs framed by the boundary line', () => {
    const block = buildProtocolBlock(['notes'], { notes: 'list<markdown>' })
    expect(block).toContain(DOC_BOUNDARY)
    expect(block).toContain('...one body per item — include EVERY item, do not stop after one')
    // Two doc placeholders separated by the boundary — proves it is not single.
    expect(block).toContain('<full markdown body of item 1')
    expect(block).toContain('<full markdown body of item 2>')
  })

  test('first-turn guidance demands the COMPLETE list and forbids truncation', () => {
    const block = buildProtocolBlock(['tags'], { tags: 'list<string>' })
    // Preserved legacy anchors (other tests assert these too).
    expect(block).toContain('For these list ports')
    expect(block).toContain('on its own line')
    // New completeness wording.
    expect(block).toContain('output the COMPLETE list')
    expect(block).toContain('Do NOT stop after the first item')
    expect(block).toContain('if there ')
    expect(block).toContain('emit 20 lines')
  })

  test('list<markdown> guidance demands EVERY document', () => {
    const block = buildProtocolBlock(['notes'], { notes: 'list<markdown>' })
    expect(block).toContain('Emit EVERY document — do not stop after one')
  })

  test('protocol block still ends with the envelope close tag when a list port is last', () => {
    const block = buildProtocolBlock(['summary', 'tags'], {
      summary: 'string',
      tags: 'list<string>',
    })
    expect(block.endsWith('</workflow-output>')).toBe(true)
  })

  test('sibling string/markdown ports keep their single-line `...` example (no collateral drift)', () => {
    const block = buildProtocolBlock(['summary', 'tags'], {
      summary: 'string',
      tags: 'list<string>',
    })
    expect(block).toContain('<port name="summary">...</port>')
  })
})

describe('list-completeness — repair block (port-validation followup)', () => {
  test('list repair block re-asserts the COMPLETE list, not just the first item', () => {
    const handler = getHandlerForParsedKind(parseKind('list<path<md>>'))
    const segment = handler.buildRepairBlock({
      failures: [
        {
          port: 'docs',
          kind: parseKind('list<path<md>>'),
          subReason: 'list-item-validate-failed',
          detail: '[1] path-wrong-extension',
        },
      ],
      ports: ['docs'],
    })
    expect(segment).not.toBeNull()
    expect(segment!).toContain('include EVERY item')
    expect(segment!).toContain('re-emit the COMPLETE list')
  })
})

describe('list-completeness — incremental envelope-followup prompt', () => {
  test('envelope-missing followup tells the agent to re-emit EVERY list item', () => {
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: false,
      reason: 'envelope-missing',
    })
    expect(out).toContain('For any list-typed port, re-emit EVERY item')
    expect(out).toContain('output the complete list')
    // Must cover list<markdown>'s boundary wire-form, not just line-per-item
    // (Codex P2): the followup defers to the session's per-item format.
    expect(out).toContain('boundary-separated block')
  })

  test('port-validation followup carries the list completeness bullet too', () => {
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: true,
      reason: 'port-validation',
    })
    expect(out).toContain('For any list-typed port, re-emit EVERY item')
  })

  test('clarify-only followup does NOT carry the output-side list bullet', () => {
    // While a clarify channel is active (and this is not a port-validation
    // failure), the agent must ask back — the output-oriented list bullet must
    // not leak into the clarify-only branch.
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: true,
      reason: 'envelope-missing',
    })
    expect(out).not.toContain('For any list-typed port, re-emit EVERY item')
  })
})
