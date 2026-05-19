// RFC-049 — renderEnvelopeFollowupPrompt with reason='port-validation' across
// the 6-row M1-M6 matrix from proposal §G3.
//
// Locked invariants:
//   * Section header swaps to "Port content validation — follow-up." (separate
//     from the legacy "Envelope missing — follow-up." anchor) so log / event
//     scanners can tell the two failure classes apart.
//   * perKindRepairBlocks is the ONLY source of kind-specific text in the
//     emitted prompt — shared/prompt.ts never embeds markdown_file-specific
//     phrasing inline. Backend computes the blocks via composePerKindRepairBlocks
//     and threads them through here pre-rendered.
//   * Order anchor: bi-modal preamble → perKindRepairBlocks → RFC-039 trailer.
//     Strong-bias trailer must always be at the very end so it doesn't get
//     wedged between repair blocks.

import { describe, expect, test } from 'bun:test'

import { renderEnvelopeFollowupPrompt } from '@agent-workflow/shared'

const MD_FILE_BLOCK =
  '\n\n**Port content validation — markdown_file.**\n- port `docpath`: file at the given path does not exist. ENOENT: ...\n\nFor ports declared `markdown_file` (`docpath`) you MUST follow the two-step protocol — write the file to disk first, then place ONLY the worktree-relative path inside the matching <port> tag. A path without a real file on disk fails the run.'

describe('RFC-049 renderEnvelopeFollowupPrompt reason=port-validation matrix', () => {
  // M1: hasClarifyChannel=off + no failing kinds — unreachable in production
  // (only port-validation can land here via a markdown_file failure), but the
  // renderer must not panic and must not surface any kind-specific text.
  test('M1: hasClarifyChannel=false + perKindRepairBlocks=[] → header only, no kind text', () => {
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: false,
      reason: 'port-validation',
      perKindRepairBlocks: [],
    })
    expect(out).toContain('Port content validation — follow-up.')
    expect(out).not.toContain('markdown_file')
    expect(out).not.toContain('two-step protocol')
    // RFC-039 strong-bias trailer ("Keep clarifying ...") only fires for
    // clarifyDirective='continue' — not reachable in clarify-off mode.
    expect(out).not.toContain('Keep clarifying')
  })

  // M2: hasClarifyChannel=off + markdown_file failing → repair block present,
  // bi-modal preamble absent (only single-envelope bullets), no RFC-039 trailer.
  test('M2: hasClarifyChannel=false + markdown_file failure → single-envelope bullets + repair block', () => {
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: false,
      reason: 'port-validation',
      perKindRepairBlocks: [MD_FILE_BLOCK],
    })
    expect(out).toContain('Port content validation — follow-up.')
    expect(out).toContain('Port content validation — markdown_file.')
    expect(out).toContain('two-step protocol')
    expect(out).toContain('end your NEXT reply with a `<workflow-output>` block')
    // No bi-modal phrasing in clarify-off branch.
    expect(out).not.toContain('(B) `<workflow-clarify>`')
    expect(out).not.toContain('Keep clarifying')
  })

  // M3: hasClarifyChannel=on + no failing kinds — unreachable, mirror of M1.
  test('M3: hasClarifyChannel=true + perKindRepairBlocks=[] → bi-modal bullets, no repair section', () => {
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: true,
      reason: 'port-validation',
      perKindRepairBlocks: [],
    })
    expect(out).toContain('Port content validation — follow-up.')
    expect(out).toContain('(B) `<workflow-clarify>`')
    expect(out).not.toContain('Port content validation — markdown_file.')
    expect(out).not.toContain('two-step protocol')
  })

  // M4: hasClarifyChannel=on + markdown_file failure + directive ∉ {continue}
  // → bi-modal preamble + repair block; no RFC-039 trailer.
  test('M4: hasClarifyChannel=true + markdown_file + directive undefined → bi-modal + repair, no trailer', () => {
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: true,
      reason: 'port-validation',
      perKindRepairBlocks: [MD_FILE_BLOCK],
    })
    expect(out).toContain('(B) `<workflow-clarify>`')
    expect(out).toContain('Port content validation — markdown_file.')
    // M4 specifically excludes the RFC-039 strong-bias trailer.
    expect(out).not.toContain('Keep clarifying')
  })

  // M5: directive=continue → trailer must be at the very end, AFTER the
  // repair block. (Order anchor; defends against future refactors that move
  // the trailer into the middle of the rendered output.)
  test('M5: hasClarifyChannel=true + markdown_file + directive=continue → repair block precedes RFC-039 trailer', () => {
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: true,
      reason: 'port-validation',
      clarifyDirective: 'continue',
      perKindRepairBlocks: [MD_FILE_BLOCK],
    })
    expect(out).toContain('(B) `<workflow-clarify>`')
    expect(out).toContain('Port content validation — markdown_file.')
    const idxRepair = out.indexOf('Port content validation — markdown_file.')
    const idxTrailer = out.indexOf('Keep clarifying')
    expect(idxRepair).toBeGreaterThan(-1)
    expect(idxTrailer).toBeGreaterThan(idxRepair)
  })

  // M6: directive=stop → no RFC-039 trailer (same as M4).
  test('M6: hasClarifyChannel=true + markdown_file + directive=stop → repair block, no trailer', () => {
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: true,
      reason: 'port-validation',
      clarifyDirective: 'stop',
      perKindRepairBlocks: [MD_FILE_BLOCK],
    })
    expect(out).toContain('Port content validation — markdown_file.')
    expect(out).not.toContain('Keep clarifying')
  })
})

describe('RFC-049 renderEnvelopeFollowupPrompt perKindRepairBlocks splicing', () => {
  test('multiple kinds → blocks concatenated in array order', () => {
    const blockA = '\n\n**Port content validation — markdown_file.**\n- port `a`: empty path.'
    const blockB = '\n\n**Port content validation — code_file.**\n- port `b`: lint failed.'
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: false,
      reason: 'port-validation',
      perKindRepairBlocks: [blockA, blockB],
    })
    const idxA = out.indexOf('markdown_file.')
    const idxB = out.indexOf('code_file.')
    expect(idxA).toBeGreaterThan(-1)
    expect(idxB).toBeGreaterThan(idxA)
  })

  test('reason=envelope-missing ignores perKindRepairBlocks even when non-empty', () => {
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: false,
      reason: 'envelope-missing',
      perKindRepairBlocks: [MD_FILE_BLOCK],
    })
    expect(out).toContain('Envelope missing — follow-up.')
    expect(out).not.toContain('Port content validation — markdown_file.')
    expect(out).not.toContain('two-step protocol')
  })

  test('reason=both-present ignores perKindRepairBlocks even when non-empty', () => {
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: true,
      reason: 'both-present',
      perKindRepairBlocks: [MD_FILE_BLOCK],
    })
    expect(out).toContain('Envelope missing — follow-up.')
    expect(out).toContain('contained BOTH')
    expect(out).not.toContain('Port content validation — markdown_file.')
  })

  test('hasClarifyChannel=false narrows non-port-validation reasons to envelope-missing', () => {
    // 'both-present' / 'clarify-malformed' both require a clarify channel; the
    // narrowing in renderEnvelopeFollowupPrompt forces the opening line back
    // to the envelope-missing variant when hasClarifyChannel is false.
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: false,
      reason: 'both-present',
    })
    expect(out).toContain('did not contain a `<workflow-output>` envelope')
    expect(out).not.toContain('contained BOTH')
  })

  test('port-validation preserves across clarify-on AND clarify-off (port content runs regardless of channel)', () => {
    const off = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: false,
      reason: 'port-validation',
      perKindRepairBlocks: [MD_FILE_BLOCK],
    })
    const on = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: true,
      reason: 'port-validation',
      perKindRepairBlocks: [MD_FILE_BLOCK],
    })
    expect(off).toContain('Port content validation — follow-up.')
    expect(on).toContain('Port content validation — follow-up.')
    expect(off).not.toContain('(B) `<workflow-clarify>`')
    expect(on).toContain('(B) `<workflow-clarify>`')
  })
})
