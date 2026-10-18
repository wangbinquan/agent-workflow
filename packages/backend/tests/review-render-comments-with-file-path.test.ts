// Locks in renderCommentsForPrompt's `**File**: \`<path>\`` header — the
// part of the iterate-prompt comments block that tells the agent which file
// to modify. Without this header the agent had no reliable way to know what
// to edit (the upstream port content was already resolved to body text by
// the time the iterate prompt was built).
//
// If this goes red, see packages/backend/src/services/review.ts:
// renderCommentsForPrompt. The end-to-end iterate flow is locked separately
// by review-iterate-comments-in-prompt.test.ts; this file pins the renderer
// in isolation so a refactor flipping the header format / position fails
// here first.

import { describe, expect, test } from 'bun:test'
import type { ReviewComment } from '@agent-workflow/shared'
import { renderCommentsForPrompt } from '@/modules/collaboration/infrastructure/review'

const SAMPLE: ReviewComment = {
  id: 'cmt_1',
  docVersionId: 'dv_1',
  anchor: {
    sectionPath: '## Architecture',
    paragraphIdx: 3,
    offsetStart: 4,
    offsetEnd: 16,
    selectedText: 'order_status',
    contextBefore: 'The `',
    contextAfter: '` enum should',
    occurrenceIndex: 1,
  },
  commentText: 'include pending_payment',
  author: 'local',
  createdAt: 1,
}

describe('renderCommentsForPrompt — sourceFilePath header', () => {
  test('empty comments → empty string regardless of sourceFilePath', () => {
    expect(renderCommentsForPrompt([])).toBe('')
    expect(renderCommentsForPrompt([], { sourceFilePath: 'design/spec.md' })).toBe('')
  })

  test('with sourceFilePath set → output starts with **File**: line', () => {
    const out = renderCommentsForPrompt([SAMPLE], { sourceFilePath: 'design/spec.md' })
    expect(out.startsWith('**File**: `design/spec.md`\n')).toBe(true)
    // Header sits above the comment block, separated by a blank line.
    expect(out).toContain('**File**: `design/spec.md`\n\n### Comment 1')
    // Existing comment fields still render.
    expect(out).toContain('**Location**: ## Architecture, paragraph 3')
    expect(out).toContain('**Comment**: include pending_payment')
  })

  test('without sourceFilePath → output identical to legacy renderer (no header line)', () => {
    const out = renderCommentsForPrompt([SAMPLE])
    expect(out.startsWith('### Comment 1\n')).toBe(true)
    expect(out).not.toContain('**File**:')
  })

  test('whitespace-only sourceFilePath → no header (trim defeats accidental empty paths)', () => {
    const out = renderCommentsForPrompt([SAMPLE], { sourceFilePath: '   ' })
    expect(out.startsWith('### Comment 1\n')).toBe(true)
    expect(out).not.toContain('**File**:')
  })

  test('two comments + sourceFilePath → header emitted exactly once', () => {
    const second: ReviewComment = {
      ...SAMPLE,
      id: 'cmt_2',
      commentText: 'add a unit test for the new branch',
      anchor: { ...SAMPLE.anchor, paragraphIdx: 5 },
    }
    const out = renderCommentsForPrompt([SAMPLE, second], { sourceFilePath: 'design/spec.md' })
    const headerHits = out.match(/\*\*File\*\*: `design\/spec\.md`/g) ?? []
    expect(headerHits.length).toBe(1)
    expect(out).toContain('### Comment 1')
    expect(out).toContain('### Comment 2')
  })
})
