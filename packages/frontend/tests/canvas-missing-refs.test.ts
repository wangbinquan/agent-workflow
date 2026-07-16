// extractMissingRefs — RFC-003 NodeInspector self-debug helper.
//
// Mirrors the P-2-01 backend "{{x}} references missing input port" rule
// at edit time. Pure helper, no DOM needed.

import { describe, expect, test } from 'vitest'
import { extractMissingRefs } from '../src/components/canvas/NodeInspector'

describe('extractMissingRefs', () => {
  test('lists template tokens that have no matching input port', () => {
    const out = extractMissingRefs('Implement {{a}} given {{b}}', [])
    expect(new Set(out)).toEqual(new Set(['a', 'b']))
  })

  test('ignores builtin __meta__ tokens (always available at runtime)', () => {
    const out = extractMissingRefs('Repo at {{__repo_path__}} for {{__task_id__}}', [])
    expect(out).toEqual([])
  })

  test('returns empty when every token has a matching input port', () => {
    const out = extractMissingRefs('Handle {{requirement}}', ['requirement'])
    expect(out).toEqual([])
  })

  test('returns empty when template has no {{x}} placeholders', () => {
    expect(extractMissingRefs('plain text', [])).toEqual([])
    expect(extractMissingRefs('', ['anything'])).toEqual([])
  })

  test('de-duplicates repeated tokens', () => {
    const out = extractMissingRefs('{{a}} and {{a}} again', [])
    expect(out).toEqual(['a'])
  })

  // Regression: `{{ port }}` with surrounding whitespace is accepted by the
  // launch-time validator AND (after the renderer fix) substitutes at runtime,
  // so the editor's missing-ref hint must treat it as a ref too — otherwise a
  // real missing ref written as `{{ port }}` shows no warning in the canvas.
  test('detects refs with surrounding whitespace: {{ a }} / {{  b  }}', () => {
    const out = extractMissingRefs('Implement {{ a }} given {{  b  }}', [])
    expect(new Set(out)).toEqual(new Set(['a', 'b']))
  })

  test('spaced builtin {{ __repo_path__ }} is still treated as always-available', () => {
    expect(extractMissingRefs('Repo at {{ __repo_path__ }}', [])).toEqual([])
  })
})
