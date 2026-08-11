// RFC-099 T10 — prompt isolation: attribution (user ids, display names, role
// snapshots) is record/UI-only and must NEVER reach agent-facing surfaces.
// Two layers of defense:
//   1. runtime — build the real prompt artifacts from rows saturated with
//      attribution and assert no identity string leaks;
//   2. source-level — the rendering functions must not reference the
//      attribution columns at all.
//
// If layer 2 goes red, someone wired an attribution column into a prompt
// builder; do NOT "fix" the test — re-read RFC-099 proposal 目标 #6.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { renderCommentsForPrompt } from '../src/services/review'
import type { ReviewComment } from '@agent-workflow/shared'

const USER_ID = '01HUSERIDLEAKCANARY0000000'
const DISPLAY_NAME = 'Leaky McLeakface'

describe('RFC-099 prompt isolation — runtime', () => {
  test('renderCommentsForPrompt never emits author / authorRole', () => {
    const comment: ReviewComment = {
      id: ulid(),
      docVersionId: ulid(),
      anchor: {
        sectionPath: 'Heading',
        paragraphIdx: 0,
        offsetStart: 0,
        offsetEnd: 4,
        selectedText: 'body',
        contextBefore: '',
        contextAfter: ' text',
        occurrenceIndex: 1,
      },
      commentText: 'please tighten this',
      author: USER_ID,
      authorRole: 'owner',
      createdAt: Date.now(),
    }
    const rendered = renderCommentsForPrompt([comment])
    expect(rendered).toContain('please tighten this')
    expect(rendered).not.toContain(USER_ID)
    expect(rendered).not.toContain('authorRole')
    expect(rendered).not.toContain(DISPLAY_NAME)
  })
})

describe('RFC-099 prompt isolation — opencode injection', () => {
  test('buildInlineAgentEntry never serializes ownerUserId / visibility into OPENCODE_CONFIG_CONTENT', async () => {
    const { buildInlineAgentEntry } = await import('../src/services/runtime/opencode/inlineConfig')
    const entry = buildInlineAgentEntry({
      id: 'a1',
      name: 'leaky',
      description: 'd',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: 'prompt body',
      ownerUserId: USER_ID,
      visibility: 'private',
      schemaVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    })
    const serialized = JSON.stringify(entry)
    expect(serialized).toContain('prompt body')
    expect(serialized).not.toContain(USER_ID)
    expect(serialized).not.toContain('ownerUserId')
    expect(serialized).not.toContain('visibility')
  })
})

describe('RFC-099 prompt isolation — source level', () => {
  const backendSrc = (p: string) => readFileSync(resolve(import.meta.dir, '..', 'src', p), 'utf8')

  /** Extract one top-level function's text (declaration → next top-level brace close). */
  function sliceFunction(source: string, marker: string): string {
    const start = source.indexOf(marker)
    expect(start).toBeGreaterThan(-1)
    const tail = source.slice(start)
    const end = tail.indexOf('\n}\n')
    expect(end).toBeGreaterThan(-1)
    return tail.slice(0, end)
  }

  test('renderCommentsForPrompt body references neither author nor authorRole', () => {
    const review = backendSrc('services/review.ts')
    const fn = sliceFunction(review, 'export function renderCommentsForPrompt(')
    expect(fn).not.toContain('author')
    expect(fn).not.toContain('decidedBy')
  })

  test('shared clarify prompt renderers reference no attribution identifiers', () => {
    const sharedClarify = readFileSync(
      resolve(import.meta.dir, '..', '..', 'shared', 'src', 'clarify.ts'),
      'utf8',
    )
    expect(sharedClarify).not.toContain('answeredBy')
    expect(sharedClarify).not.toContain('submittedByRole')
    expect(sharedClarify).not.toContain('answerAttributions')
    expect(sharedClarify).not.toContain('displayName')
  })
})
