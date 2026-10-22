import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { api, ApiError } from '@/api/client'
import { GraphDesignWorkspace } from '@/components/digital-employees/GraphDesignWorkspace'
import { GraphDesignEvidence } from '@/components/digital-employees/GraphDesignEvidence'
import type { GraphWorkspaceData } from '@/components/digital-employees/graphDesignModel'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
  }),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#fixture">{children}</a>,
}))
vi.mock('@/components/digital-employees/GraphModelView', () => ({
  GraphModelView: () => <div>diagram</div>,
}))
vi.mock('@/components/prose/Prose', () => ({
  Prose: ({ body }: { body: string }) => <div>{body}</div>,
}))

function fixture(): GraphWorkspaceData {
  return {
    document: {
      schemaVersion: 1,
      id: 'design',
      caseId: 'case',
      revision: 3,
      repositoryId: 'repo',
      repositoryBaseline: { kind: 'commit', commitSha: 'a'.repeat(40), treeOid: 'b'.repeat(40) },
      title: '预约设计',
      goals: ['避免重复预约'],
      concerns: [
        {
          id: 'c',
          revision: 1,
          statement: '预约并发',
          purpose: 'implement',
          priority: 'required',
          disposition: 'open',
          sourceIds: [],
          resolutionIds: ['booking'],
        },
      ],
      elements: [
        {
          id: 'booking',
          revision: 1,
          kind: 'decision',
          label: '预约规则',
          description: '不抢占',
          sourceIds: ['human'],
          decision: { status: 'provisional' },
        },
      ],
      relations: [],
      models: [],
      views: [
        {
          id: 'flow',
          revision: 1,
          title: '预约流程',
          purpose: '说明预约步骤',
          capabilityRef: { id: 'flow', version: 1 },
          modelIds: [],
          elementIds: ['booking'],
          relationIds: [],
          concernIds: ['c'],
          sourceIds: ['human'],
          status: 'current',
          pinned: false,
          explanation: '当前问题只需要一张图',
          limitations: [],
        },
      ],
      sources: [
        {
          id: 'human',
          kind: 'clarify',
          taskId: 'task',
          roundId: 'round',
          questionId: 'question',
          confirmedBasis: null,
          originalAnswer: '先不自动抢占，负责人和日期未定',
          decision: { status: 'provisional' },
        },
      ],
      obligations: [],
    },
    currentRevision: 3,
    presentationRevision: 1,
    presentation: {},
    host: {
      caseId: 'case',
      state: 'waiting',
      executionRef: null,
      workItemRef: null,
      editableClarify: null,
    },
    revisions: [{ revision: 3, createdAt: 10 }],
    proposals: [],
    requests: [],
    bases: [],
    executionLinks: [],
  }
}
let data: GraphWorkspaceData
const clients: QueryClient[] = []
beforeEach(() => {
  data = fixture()
  vi.spyOn(api, 'get').mockImplementation((async (path: string) => {
    if (path.endsWith('/case/design')) return { id: 'design' }
    if (path.endsWith('/verification-profiles')) return []
    if (path.endsWith('/evidence')) return { evidence: [], traces: [], obligations: [] }
    if (path.includes('/views/'))
      return {
        view: data.document.views[0],
        available: true,
        renderings: [],
        elements: data.document.elements,
        relations: [],
        scope: { total: 1, offset: 0, limit: 50, truncated: false },
      }
    if (path === '/api/development-designs/design') return data
    throw new Error(`unexpected fixture query:${path}`)
  }) as typeof api.get)
  vi.spyOn(api, 'post').mockResolvedValue({})
  vi.spyOn(api, 'put').mockResolvedValue({})
})
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.restoreAllMocks()
})
function open(canOperate = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <GraphDesignWorkspace caseId="case" canOperate={canOperate} executionAvailable />
    </QueryClientProvider>,
  )
}
test('raw command receipts and logs can be inspected and exported by a reader', async () => {
  vi.mocked(api.get).mockResolvedValue({
    files: [
      { path: 'execution.json', content: '{"exitCode":3}' },
      { path: 'logs/0-output-tail.txt', content: 'command failed at assertion' },
      {
        path: 'reports/0.json',
        content: JSON.stringify({
          kind: 'graph-retained-file',
          sourcePath: 'report.xml',
          text: '<failure>observed</failure>',
          base64: btoa('<failure>observed</failure>'),
        }),
      },
    ],
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <GraphDesignEvidence
        document={data.document}
        canEdit={false}
        busy={false}
        zh
        onVerify={() => {}}
        onAccept={async () => false}
        onLocate={() => {}}
        data={{
          obligations: [],
          traces: [],
          evidence: [
            {
              freshness: 'current',
              reasons: [],
              evidence: {
                id: 'execution:test',
                kind: 'execution',
                result: 'failed',
                summary: 'Execution failed',
                limitations: [],
                obligationIds: [],
                readSet: [],
                basisDigest: 'b',
                candidateTreeOid: 'c',
                commitSha: null,
                ci: null,
                profileRef: null,
                environmentDigest: 'e',
                executionRef: 'run',
                artifactRef: 'bundle',
                artifactDigest: 'digest',
                recordedAt: 1,
              },
            },
          ],
        }}
      />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: '查看原始证据与日志' }))
  const dialog = await screen.findByRole('dialog', { name: '原始验证证据' })
  expect(await within(dialog).findByText('command failed at assertion')).toBeTruthy()
  expect(within(dialog).getByText('{"exitCode":3}')).toBeTruthy()
  expect(within(dialog).getByText('<failure>observed</failure>')).toBeTruthy()
  expect(within(dialog).getByRole('button', { name: '下载报告' })).toBeTruthy()
  expect(
    within(dialog).getByRole('button', { name: '导出原始证据' }).hasAttribute('disabled'),
  ).toBe(false)
  expect(api.get).toHaveBeenCalledWith(
    '/api/development-designs/design/evidence/execution%3Atest/artifacts',
  )
})

test('dynamic views and a keyboard-operable semantic list preserve the original provisional answer and missing responsibility', async () => {
  open()
  expect(await screen.findByRole('button', { name: '预约流程', pressed: true })).toBeTruthy()
  fireEvent.click(await screen.findByRole('button', { name: '预约规则' }))
  expect(await screen.findByText('先不自动抢占，负责人和日期未定')).toBeTruthy()
  expect(screen.getByRole('button', { name: '✓ 预约规则' }).getAttribute('aria-pressed')).toBe(
    'true',
  )
  expect(screen.getByText('必须解决后才能形成实现依据')).toBeTruthy()
  expect(api.post).not.toHaveBeenCalled()
})

test('requesting an adaptive combination is explicit and does not apply a proposal or approve implementation', async () => {
  open()
  fireEvent.click(await screen.findByRole('button', { name: '调整图组合' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByRole('textbox'), {
    target: { value: '增加乱序和重试场景，重新选择最少图组合' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: '提交请求' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
  expect(vi.mocked(api.post).mock.calls[0]).toEqual([
    '/api/development-designs/design/actions',
    expect.objectContaining({
      action: 'replan',
      expectedRevision: 3,
      instruction: '增加乱序和重试场景，重新选择最少图组合',
    }),
  ])
})

test('semantic save requires a comparison and retains the draft visibly after a revision conflict', async () => {
  vi.mocked(api.post).mockRejectedValue(
    new ApiError(409, 'graph-design-revision-conflict', '当前版本为 4；已保留输入'),
  )
  open()
  fireEvent.click(await screen.findByRole('button', { name: '编辑设计与验证安排' }))
  let dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByDisplayValue('不抢占'), {
    target: { value: '保留我的新说明' },
  })
  expect(api.post).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: '预览修改' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '保存这些修改' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
  dialog = screen.getByRole('dialog')
  await waitFor(() =>
    expect(within(dialog).getAllByText(/保留我的新说明/).length).toBeGreaterThan(0),
  )
  fireEvent.click(within(dialog).getByRole('button', { name: '继续编辑' }))
  expect(within(dialog).getByDisplayValue('保留我的新说明')).toBeTruthy()
})

test('observers can read and locate but cannot start calls or save changes', async () => {
  open(false)
  expect(
    ((await screen.findByRole('button', { name: '调整图组合' })) as HTMLButtonElement).disabled,
  ).toBe(true)
  expect(
    (screen.getByRole('button', { name: '编辑设计与验证安排' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  fireEvent.click(await screen.findByRole('button', { name: '预约规则' }))
  expect(screen.getByText('先不自动抢占，负责人和日期未定')).toBeTruthy()
})

test('presentation zoom is saved independently without a semantic edit', async () => {
  open()
  fireEvent.click(await screen.findByRole('button', { name: '放大' }))
  await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1))
  expect(vi.mocked(api.put).mock.calls[0]).toEqual([
    '/api/development-designs/design/presentation',
    expect.objectContaining({
      expectedRevision: 1,
      views: { flow: expect.objectContaining({ viewport: { x: 0, y: 0, zoom: 1.25 } }) },
    }),
  ])
  expect(api.post).not.toHaveBeenCalled()
})

test('a failed intermediate import remains visible and is not retried as a model action', async () => {
  data.requests.push({
    id: 'import-error:x',
    kind: 'import',
    status: 'failed',
    payload: { error: 'invalid committed output' },
    updatedAt: 1,
  })
  open()
  expect(await screen.findByText('设计导入 1 · failed')).toBeTruthy()
  expect(screen.queryByText('import-error:x · failed')).toBeNull()
  expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
})

// A lost HTTP reply must replay the same business request instead of launching another action.
test('retry after a lost action reply retains its idempotency key', async () => {
  vi.mocked(api.post).mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({})
  open()
  fireEvent.click(await screen.findByRole('button', { name: '调整图组合' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '检查并发' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '提交请求' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
  await waitFor(() =>
    expect(
      (within(dialog).getByRole('button', { name: '提交请求' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  )
  fireEvent.click(within(dialog).getByRole('button', { name: '提交请求' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
  expect(vi.mocked(api.post).mock.calls[1]).toEqual(vi.mocked(api.post).mock.calls[0])
})
