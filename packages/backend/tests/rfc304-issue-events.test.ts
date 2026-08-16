// RFC-304 T46a — the issue event surface, on both hosts.
//
// Before this the platform could not hear an issue at all: GitLab notes on an
// Issue were rejected as `unsupported-event`, and GitHub's `issues` hook was
// not routed. That is a hole with a specific shape — the `requirement`
// capability is ENTERED by labelling an issue and its clarifying questions are
// ANSWERED as issue comments, so both ends of that conversation were deaf.
//
// The two hosts differ in a way that matters, and it is the label case:
//
//   GitHub names the freshly-added label in a top-level `label` block, which is
//   why `labeled` is its own action.
//   GitLab has no such thing. It fires one `issue` hook for every edit and the
//   only way to know what was added is to diff `changes.labels.previous`
//   against `.current`. Reading `current` alone reports every existing label as
//   new — so an issue already carrying the trigger label would re-enter the
//   capability every time somebody fixed a typo in it.

import { describe, expect, test } from 'bun:test'
import { gitlabNormalize } from '../src/services/webhook/gitlabAdapter'
import { githubNormalize } from '../src/services/webhook/githubAdapter'

const project = {
  id: 41823,
  path_with_namespace: 'group/project',
  git_http_url: 'https://gitlab.example/group/project.git',
  git_ssh_url: 'git@gitlab.example:group/project.git',
  web_url: 'https://gitlab.example/group/project',
  default_branch: 'main',
}

const glHeaders = { 'x-gitlab-event': 'Note Hook' }
const ghHeaders = (event: string): Record<string, string> => ({ 'x-github-event': event })

const repository = {
  id: 99,
  full_name: 'octo/api',
  clone_url: 'https://github.com/octo/api.git',
  ssh_url: 'git@github.com:octo/api.git',
  html_url: 'https://github.com/octo/api',
  default_branch: 'main',
  owner: { login: 'octo' },
  name: 'api',
}

describe('RFC-304 T46a — GitLab issue events', () => {
  test('a comment on an issue becomes `issue_comment`', () => {
    const result = gitlabNormalize(glHeaders, {
      object_kind: 'note',
      project,
      user: { username: 'ann' },
      issue: {
        iid: 88,
        title: 'Retry logic drops the last attempt',
        description: 'When the third attempt fails…',
        url: 'https://gitlab.example/group/project/-/issues/88',
        labels: [{ title: 'bug' }, { title: 'aw:implement' }],
      },
      object_attributes: {
        id: 4001,
        note: 'Yes, exponential backoff is fine.',
        noteable_type: 'Issue',
        url: 'https://gitlab.example/group/project/-/issues/88#note_4001',
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.eventType).toBe('issue_comment')
    expect(result.event.issueIid).toBe('88')
    expect(result.event.issueTitle).toBe('Retry logic drops the last attempt')
    expect(result.event.issueBody).toBe('When the third attempt fails…')
    expect(result.event.issueLabels).toEqual(['bug', 'aw:implement'])
    expect(result.event.commentText).toBe('Yes, exponential backoff is fine.')
    // Not a merge request. Filling `mrIid` would send every downstream lookup
    // to a merge request that does not exist.
    expect(result.event.mrIid).toBeUndefined()
    // Issue notes are not threaded on GitLab; claiming a thread id would make a
    // reply attempt address a discussion that is not there.
    expect(result.event.commentThreadId).toBeUndefined()
  })

  test('a comment on a merge request is still `note`', () => {
    // The regression guard for the branch this change touched.
    const result = gitlabNormalize(glHeaders, {
      object_kind: 'note',
      project,
      user: { username: 'ann' },
      merge_request: { iid: 412, source_branch: 'feature/x', target_branch: 'main' },
      object_attributes: { id: 1, note: 'looks good', noteable_type: 'MergeRequest' },
    })

    expect(result.ok && result.event.eventType).toBe('note')
    expect(result.ok && result.event.mrIid).toBe('412')
  })

  test('a comment on a snippet is still unsupported', () => {
    const result = gitlabNormalize(glHeaders, {
      object_kind: 'note',
      project,
      user: { username: 'ann' },
      object_attributes: { id: 1, note: 'x', noteable_type: 'Snippet' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unsupported-event')
  })

  test('adding a label becomes `issue_labeled`, reporting only what was added', () => {
    const result = gitlabNormalize(
      { 'x-gitlab-event': 'Issue Hook' },
      {
        object_kind: 'issue',
        project,
        user: { username: 'ann' },
        labels: [{ title: 'bug' }, { title: 'aw:implement' }],
        object_attributes: {
          iid: 88,
          title: 'Retry logic drops the last attempt',
          description: 'When the third attempt fails…',
          url: 'https://gitlab.example/group/project/-/issues/88',
          action: 'update',
        },
        changes: {
          labels: {
            previous: [{ title: 'bug' }],
            current: [{ title: 'bug' }, { title: 'aw:implement' }],
          },
        },
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.eventType).toBe('issue_labeled')
    expect(result.event.issueIid).toBe('88')
    // The whole point: `bug` was already there, so only `aw:implement` is new.
    expect(result.event.addedLabels).toEqual(['aw:implement'])
    expect(result.event.issueLabels).toEqual(['bug', 'aw:implement'])
  })

  test('an issue edit that adds NO label is not an entry point', () => {
    // GitLab fires this hook on every edit — title, description, assignee,
    // milestone. Treating them all as an entry point would start work every
    // time somebody fixed a typo in a requirement already submitted.
    const result = gitlabNormalize(
      { 'x-gitlab-event': 'Issue Hook' },
      {
        object_kind: 'issue',
        project,
        user: { username: 'ann' },
        object_attributes: { iid: 88, title: 'Retry logic', action: 'update' },
        changes: { title: { previous: 'Retry', current: 'Retry logic' } },
      },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unsupported-event')
  })

  test('a label REMOVAL is not an entry point either', () => {
    const result = gitlabNormalize(
      { 'x-gitlab-event': 'Issue Hook' },
      {
        object_kind: 'issue',
        project,
        user: { username: 'ann' },
        object_attributes: { iid: 88, title: 'Retry logic', action: 'update' },
        changes: {
          labels: {
            previous: [{ title: 'bug' }, { title: 'aw:implement' }],
            current: [{ title: 'bug' }],
          },
        },
      },
    )

    expect(result.ok).toBe(false)
  })
})

describe('RFC-304 T46a — GitHub issue events', () => {
  test('a comment on an issue becomes `issue_comment`', () => {
    const result = githubNormalize(ghHeaders('issue_comment'), {
      action: 'created',
      repository,
      sender: { login: 'ann', id: 7 },
      issue: {
        number: 88,
        title: 'Retry logic drops the last attempt',
        body: 'When the third attempt fails…',
        html_url: 'https://github.com/octo/api/issues/88',
        labels: [{ name: 'bug' }, { name: 'aw:implement' }],
        // No `pull_request` key — this is what makes it a real issue.
      },
      comment: {
        id: 4001,
        body: 'Yes, exponential backoff is fine.',
        html_url: 'https://github.com/octo/api/issues/88#issuecomment-4001',
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.eventType).toBe('issue_comment')
    expect(result.event.issueIid).toBe('88')
    expect(result.event.issueLabels).toEqual(['bug', 'aw:implement'])
    expect(result.event.mrIid).toBeUndefined()
  })

  test('a comment on a pull request is still `note`', () => {
    const result = githubNormalize(ghHeaders('issue_comment'), {
      action: 'created',
      repository,
      sender: { login: 'ann' },
      issue: {
        number: 7,
        title: 'Fix login NPE',
        html_url: 'https://github.com/octo/api/pull/7',
        pull_request: { url: 'https://api.github.com/repos/octo/api/pulls/7' },
      },
      comment: { id: 1, body: 'looks good' },
    })

    expect(result.ok && result.event.eventType).toBe('note')
    expect(result.ok && result.event.mrIid).toBe('7')
  })

  test('labelling an issue becomes `issue_labeled` with the added label named', () => {
    const result = githubNormalize(ghHeaders('issues'), {
      action: 'labeled',
      repository,
      sender: { login: 'ann' },
      issue: {
        number: 88,
        title: 'Retry logic drops the last attempt',
        body: 'When the third attempt fails…',
        html_url: 'https://github.com/octo/api/issues/88',
        labels: [{ name: 'bug' }, { name: 'aw:implement' }],
      },
      label: { name: 'aw:implement' },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.eventType).toBe('issue_labeled')
    expect(result.event.issueIid).toBe('88')
    // GitHub tells us directly which label was added; no diffing needed.
    expect(result.event.addedLabels).toEqual(['aw:implement'])
    expect(result.event.issueLabels).toEqual(['bug', 'aw:implement'])
  })

  test('every other `issues` action is not an entry point', () => {
    for (const action of ['opened', 'edited', 'assigned', 'closed', 'unlabeled']) {
      const result = githubNormalize(ghHeaders('issues'), {
        action,
        repository,
        sender: { login: 'ann' },
        issue: { number: 88, title: 'x' },
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('unsupported-event')
    }
  })

  test('an `issues` event with no issue block is a parse failure, not a silent drop', () => {
    const result = githubNormalize(ghHeaders('issues'), {
      action: 'labeled',
      repository,
      sender: { login: 'ann' },
      label: { name: 'aw:implement' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('parse-failed')
  })
})
