// RFC-298 — webhook-created task details link back to the most precise safe
// source object. These tests are the closed event/fallback oracle shared by the
// backend projection and frontend copy; adding an event must update this table.

import { describe, expect, test } from 'bun:test'
import {
  CODE_HOST_EVENT_TYPES,
  SafeWebhookTaskSourceUrlSchema,
  TaskSchema,
  WEBHOOK_TASK_SOURCE_URL_MAX,
  WebhookTaskSourceLinkSchema,
  safeWebhookTaskSourceUrl,
  webhookTaskSourceLinkOf,
  type CodeHostEventType,
  type TriggerContext,
  type WebhookTriggerFields,
} from '../src'

const PROJECT = 'https://gitlab.example/platform/api'
const MR = `${PROJECT}/-/merge_requests/42`
const COMMENT = `${MR}#note_17`
const PIPELINE = `${PROJECT}/-/pipelines/99`
const ISSUE = `${PROJECT}/-/issues/88`

function context(
  eventType: CodeHostEventType,
  fields: Partial<Omit<WebhookTriggerFields, 'event_type'>> = {},
): TriggerContext {
  return {
    trigger: {
      webhook: {
        event_type: eventType,
        provider: 'gitlab',
        project_web_url: PROJECT,
        ...fields,
      },
    },
  }
}

describe('RFC-298 webhookTaskSourceLinkOf', () => {
  test('covers every event type and selects their most precise target', () => {
    const sha = 'a'.repeat(40)
    const cases: ReadonlyArray<{
      eventType: CodeHostEventType
      fields: Partial<Omit<WebhookTriggerFields, 'event_type'>>
      expected: { kind: string; url: string }
    }> = [
      {
        eventType: 'push',
        fields: { provider: 'github', project_web_url: 'https://github.com/o/r', commit_sha: sha },
        expected: { kind: 'commit', url: `https://github.com/o/r/commit/${sha}` },
      },
      {
        eventType: 'tag_push',
        fields: { commit_sha: sha },
        expected: { kind: 'commit', url: `${PROJECT}/-/commit/${sha}` },
      },
      ...(['mr_opened', 'mr_updated', 'mr_merged', 'mr_closed'] as const).map((eventType) => ({
        eventType,
        fields: { mr_url: MR },
        expected: { kind: 'merge_request', url: MR },
      })),
      {
        eventType: 'note',
        fields: { comment_url: COMMENT, mr_url: MR },
        expected: { kind: 'comment', url: COMMENT },
      },
      ...(['pipeline_failed', 'pipeline_succeeded'] as const).map((eventType) => ({
        eventType,
        fields: { pipeline_url: PIPELINE, mr_url: MR },
        expected: { kind: 'pipeline', url: PIPELINE },
      })),
      // RFC-304 T46a. The comment wins over the issue for the same reason it
      // wins over the merge request on `note`: the task was started by
      // something someone SAID, and that sentence is what a reader needs.
      {
        eventType: 'issue_comment',
        fields: { comment_url: COMMENT, issue_url: ISSUE },
        expected: { kind: 'comment', url: COMMENT },
      },
      {
        eventType: 'issue_labeled',
        fields: { issue_url: ISSUE },
        expected: { kind: 'issue', url: ISSUE },
      },
    ]

    expect(cases.map((entry) => entry.eventType).sort()).toEqual([...CODE_HOST_EVENT_TYPES].sort())
    for (const entry of cases) {
      expect(webhookTaskSourceLinkOf(context(entry.eventType, entry.fields))).toEqual(
        entry.expected,
      )
    }
  })

  test('applies the complete fallback hierarchy and labels the actual target', () => {
    expect(
      webhookTaskSourceLinkOf(context('note', { comment_url: 'javascript:alert(1)', mr_url: MR })),
    ).toEqual({ kind: 'merge_request', url: MR })
    expect(
      webhookTaskSourceLinkOf(
        context('note', { comment_url: '/relative', mr_url: 'data:text/plain,no' }),
      ),
    ).toEqual({ kind: 'project', url: PROJECT })
    expect(webhookTaskSourceLinkOf(context('mr_closed', { mr_url: 'ftp://host/mr' }))).toEqual({
      kind: 'project',
      url: PROJECT,
    })
    expect(
      webhookTaskSourceLinkOf(
        context('pipeline_failed', { pipeline_url: 'https://u:p@host/run', mr_url: MR }),
      ),
    ).toEqual({ kind: 'merge_request', url: MR })
    expect(
      webhookTaskSourceLinkOf(
        context('pipeline_succeeded', { pipeline_url: 'not a url', mr_url: 'file:///tmp/mr' }),
      ),
    ).toEqual({ kind: 'project', url: PROJECT })
  })

  test('builds provider-specific commit pages and strips project query/hash only for construction', () => {
    const sha = 'abcdef1'
    expect(
      webhookTaskSourceLinkOf(
        context('push', {
          provider: 'github',
          project_web_url: 'https://github.example/o/r/?view=tree#readme',
          commit_sha: sha,
        }),
      ),
    ).toEqual({ kind: 'commit', url: `https://github.example/o/r/commit/${sha}` })
    expect(
      webhookTaskSourceLinkOf(
        context('tag_push', {
          provider: 'gitlab',
          project_web_url: 'https://gitlab.example/group/project///?tab=files#top',
          commit_sha: sha.toUpperCase(),
        }),
      ),
    ).toEqual({
      kind: 'commit',
      url: `https://gitlab.example/group/project/-/commit/${sha.toUpperCase()}`,
    })
  })

  test.each([
    ['missing', undefined],
    ['too short', 'abcdef'],
    ['non-hex', 'xyzxyz1'],
    ['all-zero deletion sentinel', '0'.repeat(40)],
    ['too long', 'a'.repeat(65)],
  ])('falls back to the project for %s commit SHA', (_name, commitSha) => {
    expect(webhookTaskSourceLinkOf(context('push', { commit_sha: commitSha }))).toEqual({
      kind: 'project',
      url: PROJECT,
    })
  })

  test('falls back when provider/project data cannot produce a commit page', () => {
    expect(
      webhookTaskSourceLinkOf(context('push', { provider: 'unknown', commit_sha: 'a'.repeat(40) })),
    ).toEqual({ kind: 'project', url: PROJECT })
    expect(
      webhookTaskSourceLinkOf(
        context('push', {
          provider: 'github',
          project_web_url: 'javascript:alert(1)',
          commit_sha: 'a'.repeat(40),
        }),
      ),
    ).toBeNull()
  })

  test('returns null when every candidate is absent or unsafe', () => {
    expect(
      webhookTaskSourceLinkOf(
        context('note', {
          comment_url: 'javascript:alert(1)',
          mr_url: 'https://user:secret@gitlab.example/mr',
          project_web_url: 'file:///tmp/project',
        }),
      ),
    ).toBeNull()
  })
})

describe('RFC-298 source URL boundary and wire schemas', () => {
  test('preserves a legal URL including its query and comment anchor', () => {
    const value = 'https://gitlab.example/group/repo/-/merge_requests/1?view=parallel#note_12'
    expect(safeWebhookTaskSourceUrl(value)).toBe(value)
    expect(SafeWebhookTaskSourceUrlSchema.parse(value)).toBe(value)
  })

  test.each([
    '',
    '   ',
    '/relative/path',
    'javascript:alert(1)',
    'data:text/html,no',
    'file:///tmp/repo',
    'ftp://gitlab.example/repo',
    'https://user@gitlab.example/repo',
    'https://user:secret@gitlab.example/repo',
    `https://gitlab.example/${'a'.repeat(WEBHOOK_TASK_SOURCE_URL_MAX)}`,
  ])('rejects unsafe source URL %j', (value) => {
    expect(safeWebhookTaskSourceUrl(value)).toBeNull()
    expect(SafeWebhookTaskSourceUrlSchema.safeParse(value).success).toBe(false)
  })

  test('Task detail wire accepts absent/null/safe values but rejects an unsafe link', () => {
    const field = TaskSchema.shape.webhookSourceLink
    expect(field.safeParse(undefined).success).toBe(true)
    expect(field.safeParse(null).success).toBe(true)
    expect(field.safeParse({ kind: 'comment', url: COMMENT }).success).toBe(true)
    expect(field.safeParse({ kind: 'comment', url: 'javascript:alert(1)' }).success).toBe(false)
    expect(
      WebhookTaskSourceLinkSchema.safeParse({ kind: 'comment', url: COMMENT, raw: {} }).success,
    ).toBe(false)
  })
})
