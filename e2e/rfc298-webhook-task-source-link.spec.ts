// RFC-298 — real daemon/API/browser seam for webhook task source navigation.
// The fixture plants the same frozen context produced at webhook launch, then
// proves getTask derives the minimal wire value and the task header renders
// controlled copy after the ID for every selected target/fallback kind, plus
// the all-invalid no-link result, at desktop and 390px widths.

import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'

import { runSqlite } from './command'
import { startDaemon, type DaemonHandle } from './harness'

const GITLAB_PROJECT_URL = 'https://gitlab.example/platform/api'
const GITLAB_MR_URL = `${GITLAB_PROJECT_URL}/-/merge_requests/42`
const COMMENT_URL = `${GITLAB_MR_URL}#note_17`
const GITHUB_PROJECT_URL = 'https://github.example/acme/widgets'
const GITHUB_MR_URL = `${GITHUB_PROJECT_URL}/pull/7`
const GITHUB_PIPELINE_URL = `${GITHUB_PROJECT_URL}/actions/runs/101`
const GITHUB_COMMIT_SHA = 'e4703086b7261d17203b53ff08eb057e41a026b4'
const GITLAB_COMMIT_SHA = 'ABCDEF1'

type SourceKind = 'comment' | 'merge_request' | 'pipeline' | 'commit' | 'project'

interface SourceExpectation {
  readonly kind: SourceKind
  readonly url: string
  readonly label: string
}

interface SourceCase {
  readonly key: string
  readonly taskName: string
  readonly fields: Readonly<Record<string, string>>
  readonly expected: SourceExpectation | null
}

const SOURCE_CASES: readonly SourceCase[] = [
  {
    key: 'note-comment',
    taskName: 'RFC-298 note opens the original comment',
    fields: {
      event_type: 'note',
      provider: 'gitlab',
      project_web_url: GITLAB_PROJECT_URL,
      mr_url: GITLAB_MR_URL,
      comment_url: COMMENT_URL,
    },
    expected: { kind: 'comment', url: COMMENT_URL, label: 'Open original comment' },
  },
  {
    key: 'note-mr-fallback',
    taskName: 'RFC-298 note falls back to the merge request',
    fields: {
      event_type: 'note',
      provider: 'gitlab',
      project_web_url: GITLAB_PROJECT_URL,
      mr_url: GITLAB_MR_URL,
      comment_url: 'javascript:alert(1)',
    },
    expected: {
      kind: 'merge_request',
      url: GITLAB_MR_URL,
      label: 'Open original merge request/PR',
    },
  },
  {
    key: 'note-project-fallback',
    taskName: 'RFC-298 note falls back to the source project',
    fields: {
      event_type: 'note',
      provider: 'gitlab',
      project_web_url: GITLAB_PROJECT_URL,
      mr_url: 'data:text/plain,no',
      comment_url: '/relative/comment',
    },
    expected: { kind: 'project', url: GITLAB_PROJECT_URL, label: 'Open source project' },
  },
  {
    key: 'mr-direct',
    taskName: 'RFC-298 merge request opens the original MR',
    fields: {
      event_type: 'mr_opened',
      provider: 'github',
      project_web_url: GITHUB_PROJECT_URL,
      mr_url: GITHUB_MR_URL,
    },
    expected: {
      kind: 'merge_request',
      url: GITHUB_MR_URL,
      label: 'Open original merge request/PR',
    },
  },
  {
    key: 'mr-project-fallback',
    taskName: 'RFC-298 merge request falls back to the source project',
    fields: {
      event_type: 'mr_closed',
      provider: 'github',
      project_web_url: GITHUB_PROJECT_URL,
      mr_url: 'https://user:secret@github.example/acme/widgets/pull/7',
    },
    expected: { kind: 'project', url: GITHUB_PROJECT_URL, label: 'Open source project' },
  },
  {
    key: 'pipeline-direct',
    taskName: 'RFC-298 pipeline opens the original run without an MR URL',
    fields: {
      event_type: 'pipeline_failed',
      provider: 'github',
      project_web_url: GITHUB_PROJECT_URL,
      pipeline_url: GITHUB_PIPELINE_URL,
    },
    expected: {
      kind: 'pipeline',
      url: GITHUB_PIPELINE_URL,
      label: 'Open original pipeline',
    },
  },
  {
    key: 'pipeline-mr-fallback',
    taskName: 'RFC-298 pipeline falls back to the merge request',
    fields: {
      event_type: 'pipeline_succeeded',
      provider: 'github',
      project_web_url: GITHUB_PROJECT_URL,
      mr_url: GITHUB_MR_URL,
      pipeline_url: 'https://user:secret@github.example/acme/widgets/actions/runs/101',
    },
    expected: {
      kind: 'merge_request',
      url: GITHUB_MR_URL,
      label: 'Open original merge request/PR',
    },
  },
  {
    key: 'pipeline-project-fallback',
    taskName: 'RFC-298 pipeline falls back to the source project',
    fields: {
      event_type: 'pipeline_succeeded',
      provider: 'github',
      project_web_url: GITHUB_PROJECT_URL,
      mr_url: 'file:///tmp/merge-request',
      pipeline_url: 'not a URL',
    },
    expected: { kind: 'project', url: GITHUB_PROJECT_URL, label: 'Open source project' },
  },
  {
    key: 'github-push-commit',
    taskName: 'RFC-298 GitHub push opens the original commit',
    fields: {
      event_type: 'push',
      provider: 'github',
      project_web_url: `${GITHUB_PROJECT_URL}/?view=tree#readme`,
      commit_sha: GITHUB_COMMIT_SHA,
    },
    expected: {
      kind: 'commit',
      url: `${GITHUB_PROJECT_URL}/commit/${GITHUB_COMMIT_SHA}`,
      label: 'Open original commit',
    },
  },
  {
    key: 'gitlab-tag-commit',
    taskName: 'RFC-298 GitLab tag push opens the original commit',
    fields: {
      event_type: 'tag_push',
      provider: 'gitlab',
      project_web_url: `${GITLAB_PROJECT_URL}///?tab=files#top`,
      commit_sha: GITLAB_COMMIT_SHA,
    },
    expected: {
      kind: 'commit',
      url: `${GITLAB_PROJECT_URL}/-/commit/${GITLAB_COMMIT_SHA}`,
      label: 'Open original commit',
    },
  },
  {
    key: 'push-project-fallback',
    taskName: 'RFC-298 push falls back to the source project',
    fields: {
      event_type: 'push',
      provider: 'github',
      project_web_url: GITHUB_PROJECT_URL,
      commit_sha: '0000000000000000000000000000000000000000',
    },
    expected: { kind: 'project', url: GITHUB_PROJECT_URL, label: 'Open source project' },
  },
  {
    key: 'all-invalid',
    taskName: 'RFC-298 unsafe sources render no entry',
    fields: {
      event_type: 'note',
      provider: 'gitlab',
      project_web_url: 'file:///tmp/project',
      mr_url: 'https://user:secret@gitlab.example/merge-request',
      comment_url: 'javascript:alert(1)',
    },
    expected: null,
  },
]

let daemon: DaemonHandle
const webhookTaskIds = new Map<string, string>()
let ordinaryTaskId = ''

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`RFC-298 fixture ${path} failed (${response.status}): ${await response.text()}`)
  }
  return response.json() as Promise<T>
}

async function primeAuth(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

function sourceTaskId(key: string): string {
  const taskId = webhookTaskIds.get(key)
  if (taskId === undefined) throw new Error(`RFC-298 source fixture ${key} was not seeded`)
  return taskId
}

test.beforeAll(async () => {
  daemon = await startDaemon()
  const workflow = await postJson<{ id: string }>('/api/workflows', {
    name: 'RFC-298 source-link fixture',
    description: 'Empty deterministic workflow for task detail rendering',
    definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
  })
  for (const sourceCase of SOURCE_CASES) {
    const task = await postJson<{ id: string }>('/api/tasks', {
      workflowId: workflow.id,
      name: sourceCase.taskName,
      scratch: true,
      inputs: {},
    })
    webhookTaskIds.set(sourceCase.key, task.id)
  }
  const ordinaryTask = await postJson<{ id: string }>('/api/tasks', {
    workflowId: workflow.id,
    name: 'Ordinary task without source',
    scratch: true,
    inputs: {},
  })
  ordinaryTaskId = ordinaryTask.id

  const updates = SOURCE_CASES.map((sourceCase) => {
    const context = JSON.stringify({
      trigger: {
        webhook: {
          ...sourceCase.fields,
          comment_text: `raw fixture ${sourceCase.key} must never reach the browser`,
          event_json: JSON.stringify({ privateFixture: sourceCase.key }),
        },
      },
    })
    return `UPDATE tasks SET trigger_context_json=${sqlLiteral(context)} WHERE id=${sqlLiteral(sourceTaskId(sourceCase.key))};`
  })
  runSqlite(join(daemon.home, 'db.sqlite'), `BEGIN;\n${updates.join('\n')}\nCOMMIT;`)
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

for (const sourceCase of SOURCE_CASES) {
  test(`source matrix: ${sourceCase.key} projects and renders ${sourceCase.expected?.kind ?? 'no link'}`, async ({
    page,
  }) => {
    const taskId = sourceTaskId(sourceCase.key)
    const response = await fetch(`${daemon.baseUrl}/api/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    })
    expect(response.ok).toBe(true)
    const detail = (await response.json()) as Record<string, unknown>
    if (sourceCase.expected === null) {
      expect(detail.webhookSourceLink).toBeNull()
    } else {
      expect(detail.webhookSourceLink).toEqual({
        kind: sourceCase.expected.kind,
        url: sourceCase.expected.url,
      })
    }
    expect(detail).not.toHaveProperty('triggerContextJson')
    expect(detail).not.toHaveProperty('triggerContext')
    expect(JSON.stringify(detail)).not.toContain(`raw fixture ${sourceCase.key}`)
    expect(JSON.stringify(detail)).not.toContain('privateFixture')

    await primeAuth(page)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${daemon.baseUrl}/tasks/${taskId}`)
    await expect(page.getByRole('heading', { level: 1 })).toContainText(sourceCase.taskName)

    const source = page.getByTestId('task-webhook-source')
    const link = page.getByTestId('task-webhook-source-link')
    if (sourceCase.expected === null) {
      await expect(source).toHaveCount(0)
      await expect(link).toHaveCount(0)
      await expect(page.locator('.task-detail__id')).not.toContainText('·')
      return
    }

    await expect(source).toBeVisible()
    await expect(link).toHaveText(`${sourceCase.expected.label} ↗`)
    await expect(link).toHaveAccessibleName(sourceCase.expected.label)
    await expect(link).toHaveAttribute('href', sourceCase.expected.url)
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    await expect(link).not.toHaveAttribute('title', /.+/)
    await expect(source).not.toContainText('https://')

    expect(
      await page.evaluate(() => {
        const code = document.querySelector('.task-detail__id code')
        const sourceGroup = document.querySelector('[data-testid="task-webhook-source"]')
        if (code === null || sourceGroup === null) return false
        return Boolean(code.compareDocumentPosition(sourceGroup) & Node.DOCUMENT_POSITION_FOLLOWING)
      }),
    ).toBe(true)
    expect(await source.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe('nowrap')
  })
}

test('390px layout keeps the source group contained and ordinary tasks render no placeholder', async ({
  page,
}) => {
  await primeAuth(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${daemon.baseUrl}/tasks/${sourceTaskId('note-comment')}`)
  const source = page.getByTestId('task-webhook-source')
  await expect(source).toBeVisible()
  const box = await source.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)

  await page.goto(`${daemon.baseUrl}/tasks/${ordinaryTaskId}`)
  await expect(page.getByRole('heading', { name: /Ordinary task without source/ })).toBeVisible()
  await expect(page.getByTestId('task-webhook-source')).toHaveCount(0)
  await expect(page.getByTestId('task-webhook-source-link')).toHaveCount(0)
  await expect(page.locator('.task-detail__id')).not.toContainText('·')
})
