// RFC-298 — task detail renders a controlled text link immediately after the
// task ID. The URL is href-only (never visible/title text), copy follows the
// selected fallback kind, and separator+link remain one nowrap group.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { WebhookTaskSourceLink } from '@agent-workflow/shared'
import { TaskWebhookSourceLink } from '../src/components/tasks/TaskWebhookSourceLink'
import i18n from '../src/i18n'
import { enUS } from '../src/i18n/en-US'
import { zhCN } from '../src/i18n/zh-CN'

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
})

afterEach(() => {
  cleanup()
})

const URL = 'https://gitlab.example/group/repo/-/merge_requests/7#note_11'

describe('TaskWebhookSourceLink', () => {
  test.each([
    ['comment', enUS.tasks.webhookSource.comment],
    ['merge_request', enUS.tasks.webhookSource.mergeRequest],
    ['pipeline', enUS.tasks.webhookSource.pipeline],
    ['commit', enUS.tasks.webhookSource.commit],
    ['project', enUS.tasks.webhookSource.project],
  ] as const)('renders controlled English copy for %s', (kind, label) => {
    render(<TaskWebhookSourceLink source={{ kind, url: URL }} />)
    const link = screen.getByRole('link', { name: label })
    expect(link.getAttribute('href')).toBe(URL)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(link.getAttribute('title')).toBeNull()
    expect(link.textContent).not.toContain(URL)
    expect(link.querySelector('[aria-hidden="true"]')?.textContent).toBe('↗')
  })

  test.each([
    ['comment', zhCN.tasks.webhookSource.comment],
    ['merge_request', zhCN.tasks.webhookSource.mergeRequest],
    ['pipeline', zhCN.tasks.webhookSource.pipeline],
    ['commit', zhCN.tasks.webhookSource.commit],
    ['project', zhCN.tasks.webhookSource.project],
  ] as const)('renders controlled Chinese copy for %s', async (kind, label) => {
    await i18n.changeLanguage('zh-CN')
    render(<TaskWebhookSourceLink source={{ kind, url: URL } satisfies WebhookTaskSourceLink} />)
    expect(screen.getByRole('link', { name: label })).toBeTruthy()
  })
})

describe('task-detail RFC-298 wiring', () => {
  const read = (relativePath: string) =>
    readFileSync(resolve(import.meta.dirname, '..', relativePath), 'utf8')

  test('source group is conditionally rendered after the task ID code', () => {
    const route = read('src/routes/tasks.detail.tsx')
    const code = route.indexOf('<code>{tk.id}</code>')
    const condition = route.indexOf('tk.webhookSourceLink != null', code)
    const component = route.indexOf('<TaskWebhookSourceLink source={tk.webhookSourceLink} />', code)
    expect(code).toBeGreaterThan(-1)
    expect(condition).toBeGreaterThan(code)
    expect(component).toBeGreaterThan(condition)
    expect(route.slice(condition, component)).toContain('data-testid="task-webhook-source"')
    expect(route.slice(condition, component)).toContain('<span aria-hidden="true">·</span>')
  })

  test('separator and link are a nowrap group while the ID remains copyable', () => {
    const styles = read('src/styles.css')
    expect(styles).toMatch(
      /\.task-detail__id code,\n\.task-detail__source \{\n\s+white-space: nowrap;/,
    )
    expect(styles).not.toMatch(/\.task-detail__source\s*\{[^}]*overflow:\s*hidden/s)
    expect(styles).not.toMatch(/\.task-detail__source\s*\{[^}]*text-overflow:/s)
  })

  test('component uses shared link styling and never exposes URL through title', () => {
    const component = read('src/components/tasks/TaskWebhookSourceLink.tsx')
    expect(component).toContain('data-table__link task-detail__source-link')
    expect(component).toContain('href={source.url}')
    expect(component).not.toMatch(/\btitle=/)
  })
})
