// RFC-050 — DetailHeader surfaces the per-job output language as a chip in
// the meta row. Locks:
//   - explicit job.outputLang='zh-CN' / 'en-US' → matching i18n label
//   - undefined / null on the job → "Default (English)" fallback
//   - chip carries the data-testid for stable selection in higher-level
//     tests/spec

import { afterEach, describe, expect, test } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import type { MemoryDistillJob } from '@agent-workflow/shared'
import { DetailHeader } from '../src/components/memory/distill-job-detail/DetailHeader'
import i18n from '../src/i18n'
import { enUS } from '../src/i18n/en-US'

afterEach(() => {
  document.body.innerHTML = ''
})

async function renderWithRouter(node: React.ReactNode): Promise<void> {
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <>{node}</>,
  })
  const memoryRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/memory',
    component: () => <div>memory</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, memoryRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(<RouterProvider router={router} />)
  await waitFor(() => {
    expect(
      document.body.querySelector('[data-testid="distill-job-detail-output-lang"]'),
    ).not.toBeNull()
  })
}

function mkJob(overrides: Partial<MemoryDistillJob>): MemoryDistillJob {
  return {
    id: 'job-1',
    debounceKey: 'k',
    sourceKind: 'feedback',
    sourceEventId: 'evt-1',
    taskId: null,
    scopeResolved: { agentIds: [], workflowId: null, repoId: null, includeGlobal: true },
    status: 'done',
    attempts: 1,
    nextRunAt: Date.now(),
    lastError: null,
    createdAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: Date.now(),
    opencodeSessionId: null,
    userPromptMd: null,
    exitCode: 0,
    stderrExcerpt: null,
    outputLang: null,
    ...overrides,
  }
}

describe('RFC-050 DetailHeader — output language chip', () => {
  test('zh-CN job renders the Chinese label', async () => {
    await i18n.changeLanguage('en-US')
    await renderWithRouter(<DetailHeader job={mkJob({ outputLang: 'zh-CN' })} />)
    const chip = screen.getByTestId('distill-job-detail-output-lang')
    expect(chip.textContent).toContain('Output language')
    expect(chip.textContent).toContain('简体中文')
    expect(screen.getByRole('heading', { level: 1, name: 'job-1' })).toBeTruthy()
    expect(screen.getByRole('link', { name: enUS.memory.title }).getAttribute('href')).toBe(
      '/memory?tab=distill-jobs',
    )
  })

  test('en-US job renders English', async () => {
    await i18n.changeLanguage('en-US')
    await renderWithRouter(<DetailHeader job={mkJob({ outputLang: 'en-US' })} />)
    const chip = screen.getByTestId('distill-job-detail-output-lang')
    expect(chip.textContent).toContain('English')
    expect(chip.textContent).not.toContain('简体中文')
  })

  test('null outputLang renders the Default (English) fallback', async () => {
    await i18n.changeLanguage('en-US')
    await renderWithRouter(<DetailHeader job={mkJob({ outputLang: null })} />)
    const chip = screen.getByTestId('distill-job-detail-output-lang')
    expect(chip.textContent).toContain('Default (English)')
  })

  test('Chinese UI locale renders the Chinese-side i18n labels', async () => {
    await i18n.changeLanguage('zh-CN')
    await renderWithRouter(<DetailHeader job={mkJob({ outputLang: 'zh-CN' })} />)
    const chip = screen.getByTestId('distill-job-detail-output-lang')
    expect(chip.textContent).toContain('输出语言')
    expect(chip.textContent).toContain('简体中文')
  })
})
