import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { api, ApiError } from '@/api/client'
import { GraphDesignWorkspace } from '@/features/development-automation/graph-development/GraphDesignWorkspace'
import { GraphDesignEvidence } from '@/features/development-automation/graph-development/GraphDesignEvidence'
import {
  graphDocumentChanges,
  rebaseGraphDraft,
  type GraphWorkspaceData,
  type GraphEvidenceData,
} from '@/features/development-automation/graph-development/graphDesignModel'
import { GraphDesignDelivery } from '@/features/development-automation/graph-development/GraphDesignDelivery'
import {
  graphDeliveryStatus,
  projectGraphDeliveryCare,
  type GraphDeliveryProgress,
  type GraphMergeRequestDelivery,
} from '@/features/development-automation/graph-development/graphDeliveryModel'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
  }),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#fixture">{children}</a>,
}))
vi.mock('@/features/development-automation/graph-development/GraphModelView', () => ({
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
function open(canOperate = true, deliveryProgress?: GraphDeliveryProgress) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <GraphDesignWorkspace
        caseId="case"
        canOperate={canOperate}
        executionAvailable
        deliveryProgress={deliveryProgress}
      />
    </QueryClientProvider>,
  )
}

test('a local proposal preview does not describe unread branches as deletions', () => {
  data.document.elements.push({
    ...data.document.elements[0]!,
    id: 'notifications',
    label: '独立通知',
  })
  const local = structuredClone(data.document)
  local.elements = [local.elements[0]!]
  local.elements[0]!.description = '预约新规则'
  const changes = graphDocumentChanges(data.document, local, [{ id: 'booking' }])
  expect(changes.map((change) => change.id)).toEqual(['elements:booking'])
  local.elements.push({ ...local.elements[0]!, id: 'cancel', label: '取消预约' })
  expect(
    graphDocumentChanges(data.document, local, [{ id: 'booking' }]).map((change) => change.id),
  ).toEqual(['elements:booking', 'elements:cancel'])
})

test('selection actions do not expand to the whole displayed view', async () => {
  open()
  fireEvent.click(await screen.findByRole('button', { name: '预约规则' }))
  fireEvent.click(screen.getByRole('button', { name: '解释所选内容' }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText(/booking（含关联依赖）/)).toBeTruthy()
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '解释预约唯一性' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '提交请求' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
  expect(vi.mocked(api.post).mock.calls[0]?.[1]).toMatchObject({
    action: 'explain',
    anchor: { elementIds: ['booking'] },
  })
  expect((vi.mocked(api.post).mock.calls[0]?.[1] as { anchor: unknown }).anchor).not.toHaveProperty(
    'viewId',
  )
})

test('switching JSON and form editing preserves changes and refuses to discard invalid JSON', async () => {
  open()
  fireEvent.click(await screen.findByRole('button', { name: '编辑设计与验证安排' }))
  const dialog = screen.getByRole('dialog')
  fireEvent.change(within(dialog).getByRole('textbox', { name: '设计标题' }), {
    target: { value: '表单中的标题' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: '编辑完整语义模型' }))
  expect(within(dialog).queryByRole('textbox', { name: '设计标题' })).toBeNull()
  const input = within(dialog).getByRole('textbox', {
    name: '语义模型（含关系和子模型）',
  }) as HTMLTextAreaElement
  expect(JSON.parse(input.value).title).toBe('表单中的标题')
  const next = { ...JSON.parse(input.value), title: 'JSON 中补充的标题' }
  fireEvent.change(input, { target: { value: '{ invalid' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '返回表单编辑' }))
  expect(within(dialog).getByDisplayValue('{ invalid')).toBeTruthy()
  expect(within(dialog).queryByRole('textbox', { name: '设计标题' })).toBeNull()
  fireEvent.change(input, { target: { value: JSON.stringify(next) } })
  fireEvent.click(within(dialog).getByRole('button', { name: '返回表单编辑' }))
  expect(within(dialog).getByDisplayValue('JSON 中补充的标题')).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: '预览修改' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '保存这些修改' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
  expect(vi.mocked(api.post).mock.calls[0]?.[1]).toMatchObject({
    document: { title: 'JSON 中补充的标题' },
  })
})

test('a large directory searches all relations and navigates beyond the element page count', async () => {
  const original = vi.mocked(api.get).getMockImplementation()!
  vi.mocked(api.get).mockImplementation((async (
    path: string,
    query?: { offset?: number; search?: string },
  ) => {
    if (path.includes('/views/'))
      return {
        view: data.document.views[0],
        available: true,
        renderings: [],
        elements: query?.offset ? [] : data.document.elements,
        relations: [
          {
            id: 'edge',
            from: 'booking',
            to: 'booking',
            label: '有空位时继续',
            condition: 'remaining > 0',
          },
        ],
        scope: {
          total: 1,
          completeTotal: 301,
          offset: query?.offset ?? 0,
          limit: 50,
          truncated: false,
        },
        relationScope: {
          total: query?.search ? 1 : 300,
          completeTotal: 300,
          offset: query?.offset ?? 0,
          limit: 50,
          truncated: true,
        },
      }
    return original(path, query)
  }) as typeof api.get)
  open()
  expect(await screen.findByText('当前视图较大，使用分页目录定位')).toBeTruthy()
  expect(screen.getByRole('button', { name: /remaining > 0/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  await waitFor(() =>
    expect(
      vi
        .mocked(api.get)
        .mock.calls.some(
          ([path, query]) =>
            path.includes('/views/') && (query as { offset?: number })?.offset === 50,
        ),
    ).toBe(true),
  )
  fireEvent.change(screen.getByRole('textbox', { name: '搜索当前视图的元素与关系' }), {
    target: { value: '有空位' },
  })
  await waitFor(() =>
    expect(
      vi
        .mocked(api.get)
        .mock.calls.some(
          ([path, query]) =>
            path.includes('/views/') &&
            (query as { search?: string; offset?: number })?.search === '有空位' &&
            (query as { offset?: number }).offset === 0,
        ),
    ).toBe(true),
  )
})
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
  expect(await screen.findByText('设计导入 1 · 失败')).toBeTruthy()
  expect(screen.queryByText('import-error:x · failed')).toBeNull()
  expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
})

// RFC-396 review R01: scope and provenance edits must never disappear from review.
test('design comparison includes title, goals and original sources', () => {
  const next = structuredClone(data.document)
  next.title = '新的预约方案'
  next.goals = ['允许同一时段重复预约']
  next.sources.push({
    id: 'material-2',
    kind: 'material',
    artifactRef: 'request',
    digest: 'f'.repeat(64),
    label: '新增约束',
  })
  const changes = graphDocumentChanges(data.document, next)
  expect(changes.map((item) => item.field)).toEqual(['title', 'goals', 'sources'])
  expect(changes.find((item) => item.field === 'goals')).toMatchObject({
    before: '避免重复预约',
    after: '允许同一时段重复预约',
  })
})

test('a title-only edit is previewed and can be saved without editing JSON', async () => {
  open()
  fireEvent.click(await screen.findByRole('button', { name: '编辑设计与验证安排' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByRole('textbox', { name: '设计标题' }), {
    target: { value: '预约与取消方案' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: '预览修改' }))
  expect(within(dialog).getByText('预约与取消方案')).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: '保存这些修改' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
  expect(vi.mocked(api.post).mock.calls[0]?.[1]).toMatchObject({
    expectedRevision: 3,
    document: { title: '预约与取消方案' },
  })
})

test('draft merging preserves disjoint edits and requires a decision for divergent fields', () => {
  const base = data.document
  const local = structuredClone(base)
  const remote = structuredClone(base)
  local.elements[0]!.description = '我补充的规则'
  remote.revision = 4
  remote.elements[0]!.revision = 2
  remote.elements[0]!.label = '同事修改的名称'
  remote.goals.push('允许取消预约')
  const merged = rebaseGraphDraft(base, local, remote)
  expect(merged.conflicts).toEqual([])
  expect(merged.document).toMatchObject({ revision: 4, goals: ['避免重复预约', '允许取消预约'] })
  expect(merged.document.elements[0]).toMatchObject({
    revision: 2,
    label: '同事修改的名称',
    description: '我补充的规则',
  })
  remote.elements[0]!.description = '同事修改的规则'
  expect(rebaseGraphDraft(base, local, remote).conflicts).toEqual([
    { path: 'elements.booking.description', local: '我补充的规则', remote: '同事修改的规则' },
  ])
  expect(
    rebaseGraphDraft(base, local, remote, { 'elements.booking.description': 'local' }).document
      .elements[0],
  ).toMatchObject({ label: '同事修改的名称', description: '我补充的规则' })
  local.elements = []
  expect(rebaseGraphDraft(base, local, remote).conflicts[0]?.path).toBe('elements.booking')
})

test('409 can be recovered by comparing, resolving, previewing and saving against the latest revision', async () => {
  vi.mocked(api.post)
    .mockImplementationOnce(async () => {
      data = structuredClone(data)
      data.currentRevision = 4
      data.document.revision = 4
      data.document.elements[0]!.revision = 2
      data.document.elements[0]!.label = '同事更新的名称'
      data.document.elements[0]!.description = '同事补充的规则'
      throw new ApiError(409, 'graph-design-revision-conflict', '当前版本为 4')
    })
    .mockResolvedValue({})
  open()
  fireEvent.click(await screen.findByRole('button', { name: '编辑设计与验证安排' }))
  let dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByDisplayValue('不抢占'), {
    target: { value: '保留我的规则' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: '预览修改' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '保存这些修改' }))
  fireEvent.click(await within(dialog).findByRole('button', { name: '读取最新版本并比较' }))
  expect(await within(dialog).findByText('同事补充的规则', { exact: false })).toBeTruthy()
  fireEvent.click(
    within(dialog).getByRole('combobox', { name: '保留哪个值：elements.booking.description' }),
  )
  fireEvent.mouseDown(await screen.findByRole('option', { name: '保留我的草稿' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '采用合并结果并重新预览' }))
  dialog = screen.getByRole('dialog')
  expect(await within(dialog).findByText(/草稿基于版本 4，当前版本 4/)).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: '保存这些修改' }))
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
  expect(vi.mocked(api.post).mock.calls[1]?.[1]).toMatchObject({
    expectedRevision: 4,
    document: {
      revision: 4,
      elements: [expect.objectContaining({ label: '同事更新的名称', description: '保留我的规则' })],
    },
  })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

test('terminal cases show artifacts as the next action and disable new design requests', async () => {
  data.host.state = 'terminal'
  open()
  expect(await screen.findByRole('link', { name: '查看交付产物' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '预览实现依据' })).toBeNull()
  expect((screen.getByRole('button', { name: '调整图组合' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  expect(
    (screen.getByRole('button', { name: '编辑设计与验证安排' }) as HTMLButtonElement).disabled,
  ).toBe(true)
})

test('terminal designs remain read-only while clarification creates an explicitly linked follow-on', async () => {
  data.host.state = 'terminal'
  vi.mocked(api.post).mockResolvedValue({ caseId: 'follow-on' })
  open()
  fireEvent.click(await screen.findByRole('button', { name: '新建后续工作' }))
  const dialog = screen.getByRole('dialog', { name: '新建后续工作' })
  fireEvent.change(within(dialog).getByRole('textbox'), {
    target: { value: '在已合入设计上补充取消规则' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: '提交请求' }))
  expect(await screen.findByRole('link', { name: '打开后续工作' })).toBeTruthy()
  expect(vi.mocked(api.post).mock.calls[0]).toEqual([
    '/api/development-designs/design/clarification-requests',
    expect.objectContaining({ instruction: '在已合入设计上补充取消规则', expectedRevision: 3 }),
  ])
  expect(
    (screen.getByRole('button', { name: '编辑设计与验证安排' }) as HTMLButtonElement).disabled,
  ).toBe(true)
})

test('an active MR can form a new reviewable basis after its graph design changes', async () => {
  data.host.state = 'blocked'
  data.host.workItemRef = 'publish-mr'
  const original = vi.mocked(api.get).getMockImplementation()!
  vi.mocked(api.get).mockImplementation((async (
    path: string,
    query?: Parameters<typeof api.get>[1],
    signal?: AbortSignal,
  ) => {
    if (path.endsWith('/bases/new-basis'))
      return {
        basis: { id: 'new-basis', digest: 'basis-digest', document: data.document, files: [] },
        staleIds: [],
      }
    return original(path, query, signal)
  }) as typeof api.get)
  vi.mocked(api.post).mockResolvedValue({ basis: { id: 'new-basis' } })
  open(true, deliveryProgress())
  fireEvent.click(await screen.findByRole('button', { name: '预览实现依据' }))
  const scope = screen.getByRole('dialog', { name: '选择本次实现范围' })
  fireEvent.click(within(scope).getByRole('button', { name: '生成可审核预览' }))
  await waitFor(() =>
    expect(vi.mocked(api.post).mock.calls[0]).toEqual([
      '/api/development-designs/design/baseline-previews',
      expect.objectContaining({ expectedRevision: 3, includedElementIds: ['booking'] }),
    ]),
  )
  expect(await screen.findByText('basis-digest')).toBeTruthy()
})

function deliveryFixture(): GraphMergeRequestDelivery {
  return {
    kind: 'merge-request',
    status: 'active',
    ref: 'repo!42',
    webUrl: 'https://example.test/repo/-/merge_requests/42',
    sourceBranch: 'work/42',
    targetBranch: 'main',
    headSha: 'a'.repeat(40),
    targetSha: 'b'.repeat(40),
    mergedCommitSha: null,
    draft: false,
    mergeableState: 'mergeable',
    readyToMerge: false,
    approvalHold: false,
    unresolvedReviewCount: 2,
  }
}

function deliveryProgress(
  delivery: GraphMergeRequestDelivery | null = deliveryFixture(),
): GraphDeliveryProgress {
  return {
    mode: 'merge-request',
    caseState: 'waiting',
    terminalKind: null,
    blockReason: null,
    workItemRef: 'observe-mr',
    nextAction: { tone: 'info', title: '等待关注对象发生变化', body: '收到仓库事件后继续。' },
    delivery,
    care: projectGraphDeliveryCare(delivery, []),
  }
}

test.each(['headSha', 'targetSha', 'mergeRequestRef'] as const)(
  'CI success is stale when %s differs from the current MR',
  (field) => {
    const delivery = deliveryFixture()
    const state = {
      status: 'passed',
      headSha: delivery.headSha,
      targetSha: delivery.targetSha,
      mergeRequestRef: delivery.ref,
      checks: [{ checkRef: 'unit', name: '单元测试', status: 'passed' }],
    }
    const current = projectGraphDeliveryCare(delivery, [
      { typeId: 'development.pipeline', state, updatedAt: 1 },
    ])
    expect(current.pipeline?.current).toBe(true)
    const stale = projectGraphDeliveryCare(delivery, [
      {
        typeId: 'development.pipeline',
        state: { ...state, [field]: field === 'mergeRequestRef' ? 'other!1' : 'c'.repeat(40) },
        updatedAt: 2,
      },
    ])
    expect(stale.pipeline?.current).toBe(false)
    render(<GraphDesignDelivery progress={{ ...deliveryProgress(delivery), care: stale }} zh />)
    const pipeline = screen.getByRole('region', { name: '流水线检查' })
    expect(within(pipeline).getByText('CI 流水线 · 尚未确认')).toBeTruthy()
    expect(within(pipeline).getByText(/旧版本记录，等待重新检查/)).toBeTruthy()
    expect(within(pipeline).queryByText('CI 流水线 · 通过')).toBeNull()
    fireEvent.click(screen.getByText('版本、检查、审批与评审记录'))
    const record = screen.getByRole('region', { name: '流水线记录' })
    expect(within(record).getByText('记录中的流水线状态 · 通过')).toBeTruthy()
    expect(within(record).getByText('单元测试 · 通过（旧版本）')).toBeTruthy()
  },
)

test.each(['missing', 'initial-pending'] as const)(
  '%s pipeline evidence keeps the CI configuration entry and frozen-job explanation visible',
  (kind) => {
    const delivery = deliveryFixture()
    const care = projectGraphDeliveryCare(
      delivery,
      kind === 'missing'
        ? []
        : [
            {
              typeId: 'development.pipeline',
              state: {
                status: 'pending',
                mergeRequestRef: delivery.ref,
                headSha: delivery.headSha,
                targetSha: delivery.targetSha,
                checks: [],
              },
              updatedAt: 1,
            },
          ],
    )
    render(<GraphDesignDelivery progress={{ ...deliveryProgress(delivery), care }} zh />)
    const pipeline = screen.getByRole('region', { name: '流水线检查' })
    expect(within(pipeline).getByText('CI 流水线 · 尚未确认')).toBeTruthy()
    expect(within(pipeline).getByText('尚无可读取的流水线检查结果，不能判为通过。')).toBeTruthy()
    expect(within(pipeline).getByText(/仅凭空记录无法判断是否配置或启动了 CI/)).toBeTruthy()
    expect(within(pipeline).getByText(/已有工作保持启动时的配置/)).toBeTruthy()
    const configure = within(pipeline).getByRole('link', { name: '配置 CI 看护岗位' })
    expect(configure.getAttribute('href')).toBe(
      '/digital-employees/graph-development%402?view=jobs&jobTemplateId=platform%3Agraph-development%3Ajob%3Amr-ci-v1&workItem=collect-pipeline',
    )
    expect(configure.closest('details')).toBeNull()
    expect(within(pipeline).queryByText('CI 流水线 · 等待结果')).toBeNull()
    expect((screen.getByTestId('graph-delivery-records') as HTMLDetailsElement).open).toBe(false)
  },
)

test.each([
  ['queued', '排队中'],
  ['running', '执行中'],
  ['passed', '通过'],
  ['failed', '失败'],
] as const)(
  'a current %s check is visible as actual CI activity, with inspectable results',
  (status, label) => {
    const delivery = deliveryFixture()
    const care = projectGraphDeliveryCare(delivery, [
      {
        typeId: 'development.pipeline',
        state: {
          status: status === 'passed' || status === 'failed' ? status : 'pending',
          mergeRequestRef: delivery.ref,
          headSha: delivery.headSha,
          targetSha: delivery.targetSha,
          checks: [{ checkRef: 'unit', name: '单元测试', status, summary: '精确提交的检查记录' }],
        },
        updatedAt: 1,
      },
    ])
    render(<GraphDesignDelivery progress={{ ...deliveryProgress(delivery), care }} zh />)
    const pipeline = screen.getByRole('region', { name: '流水线检查' })
    expect(within(pipeline).getByText(`CI 流水线 · ${label}`)).toBeTruthy()
    expect(within(pipeline).queryByRole('link', { name: '配置 CI 看护岗位' })).toBeNull()
    fireEvent.click(screen.getByText('版本、检查、审批与评审记录'))
    const record = screen.getByRole('region', { name: '流水线记录' })
    expect(within(record).getByText(`单元测试 · ${label}`)).toBeTruthy()
    expect(within(record).getByText('精确提交的检查记录')).toBeTruthy()
  },
)

test.each([
  ['canceled', '已取消'],
  ['skipped', '已跳过'],
] as const)(
  'a %s check does not turn a pending pipeline into successful evidence',
  (status, label) => {
    const delivery = deliveryFixture()
    const care = projectGraphDeliveryCare(delivery, [
      {
        typeId: 'development.pipeline',
        state: {
          status: 'pending',
          mergeRequestRef: delivery.ref,
          headSha: delivery.headSha,
          targetSha: delivery.targetSha,
          checks: [{ checkRef: 'unit', name: '单元测试', status }],
        },
        updatedAt: 1,
      },
    ])
    render(<GraphDesignDelivery progress={{ ...deliveryProgress(delivery), care }} zh />)
    const pipeline = screen.getByRole('region', { name: '流水线检查' })
    expect(within(pipeline).getByText('CI 流水线 · 等待结果')).toBeTruthy()
    expect(within(pipeline).queryByText('CI 流水线 · 通过')).toBeNull()
    expect(within(pipeline).queryByText(/尚无可读取的流水线检查结果/)).toBeNull()
    fireEvent.click(screen.getByText('版本、检查、审批与评审记录'))
    expect(
      within(screen.getByRole('region', { name: '流水线记录' })).getByText(`单元测试 · ${label}`),
    ).toBeTruthy()
  },
)

test('unknown context data does not become successful evidence, and approval/review receipts are version bound', () => {
  const delivery = deliveryFixture()
  const care = projectGraphDeliveryCare(delivery, [
    { typeId: 'development.pipeline', state: { status: 'passed' }, updatedAt: 1 },
    {
      typeId: 'development.approval',
      state: {
        status: 'approved',
        mergeRequestRef: delivery.ref,
        headSha: 'c'.repeat(40),
        deadlineAt: null,
      },
      updatedAt: 2,
    },
    {
      typeId: 'development.review-resolution',
      state: {
        status: 'replied',
        mergeRequestRef: delivery.ref,
        sourceHeadSha: 'c'.repeat(40),
        publishedHeadSha: delivery.headSha,
        threads: [],
      },
      updatedAt: 3,
    },
  ])
  expect(care.pipeline).toBeNull()
  expect(care.approval?.current).toBe(false)
  expect(care.reviews?.current).toBe(true)
})

test('MR care keeps its summary compact and reveals exact versions, approvals and feedback on demand', () => {
  const delivery = deliveryFixture()
  const care = projectGraphDeliveryCare(delivery, [
    {
      typeId: 'development.approval',
      state: {
        status: 'approved',
        mergeRequestRef: delivery.ref,
        headSha: delivery.headSha,
        deadlineAt: null,
      },
      updatedAt: 2,
    },
    {
      typeId: 'development.review-resolution',
      state: {
        status: 'replied',
        mergeRequestRef: delivery.ref,
        sourceHeadSha: delivery.headSha,
        publishedHeadSha: delivery.headSha,
        threads: [{ threadRef: 'thread-1', disposition: 'addressed', replyBody: '已保留取消规则' }],
      },
      updatedAt: 3,
    },
  ])
  render(<GraphDesignDelivery progress={{ ...deliveryProgress(delivery), care }} zh />)
  expect(screen.getByRole('link', { name: '打开 MR' }).getAttribute('href')).toBe(
    'https://example.test/repo/-/merge_requests/42',
  )
  expect(screen.getByText('work/42 → main').closest('details')).toBeNull()
  const details = screen.getByTestId('graph-delivery-records') as HTMLDetailsElement
  expect(details.open).toBe(false)
  expect(screen.getByText(delivery.headSha).closest('details')).toBe(details)
  expect(screen.getByText(delivery.targetSha!).closest('details')).toBe(details)
  fireEvent.click(screen.getByText('版本、检查、审批与评审记录'))
  expect(details.open).toBe(true)
  expect(within(details).getByText(delivery.headSha)).toBeTruthy()
  expect(within(details).getByText(delivery.targetSha!)).toBeTruthy()
  expect(within(details).getByText('未解决评审')).toBeTruthy()
  expect(within(details).getByText('2')).toBeTruthy()
  expect(within(details).getByRole('region', { name: '审批进度' }).textContent).toContain('已批准')
  expect(within(details).getByRole('region', { name: '评审反馈处理' }).textContent).toContain(
    '已保留取消规则',
  )
  fireEvent.click(screen.getByText('版本、检查、审批与评审记录'))
  expect(details.open).toBe(false)
})

test.each(['merged', 'closed', 'canceled'] as const)(
  '%s delivery presents historical records without waiting for CI or merge',
  (outcome) => {
    const delivery = {
      ...deliveryFixture(),
      status: outcome === 'canceled' ? ('active' as const) : outcome,
      readyToMerge: true,
      approvalHold: true,
      mergedCommitSha: outcome === 'merged' ? 'c'.repeat(40) : null,
    }
    const care = projectGraphDeliveryCare(delivery, [
      {
        typeId: 'development.pipeline',
        state: {
          status: 'pending',
          mergeRequestRef: delivery.ref,
          headSha: delivery.headSha,
          targetSha: delivery.targetSha,
          checks: [],
        },
        updatedAt: 1,
      },
    ])
    render(
      <GraphDesignDelivery
        progress={{
          ...deliveryProgress(delivery),
          caseState: 'terminal',
          terminalKind: outcome,
          nextAction: {
            tone: 'info',
            title: '工作已结束',
            body: '数字人已停止看护，历史仍可查阅。',
          },
          care,
        }}
        zh
      />,
    )
    expect(screen.getByText('交付记录')).toBeTruthy()
    expect(
      screen.getByText(
        outcome === 'merged'
          ? 'MR 已合入'
          : outcome === 'closed'
            ? 'MR 已关闭，未合入'
            : '工作已结束',
      ),
    ).toBeTruthy()
    expect(screen.getByText('CI 历史记录')).toBeTruthy()
    expect(screen.queryByText('交付与持续看护')).toBeNull()
    expect(screen.queryByText('CI 流水线 · 等待结果')).toBeNull()
    expect(screen.queryByText('是，等待仓库侧合入')).toBeNull()
    const details = screen.getByTestId('graph-delivery-records') as HTMLDetailsElement
    expect(details.open).toBe(false)
    fireEvent.click(screen.getByText('查看交付历史明细'))
    expect(details.open).toBe(true)
    expect(
      within(details).getByText('以下是工作结束时保留的记录，不再等待流水线、评审或审批。'),
    ).toBeTruthy()
    expect(within(details).getByText('合并条件（记录值）')).toBeTruthy()
    expect(within(details).getByText('已满足')).toBeTruthy()
    expect(within(details).getByText('记录时存在审批暂停')).toBeTruthy()
    expect(within(details).getByText(/^与本次交付版本一致/)).toBeTruthy()
    expect(within(details).getByRole('link', { name: '为后续工作配置 CI 看护岗位' })).toBeTruthy()
    if (delivery.mergedCommitSha)
      expect(within(details).getByText(delivery.mergedCommitSha)).toBeTruthy()
  },
)

test('an internal candidate is not MR completion and closed is distinct from merged', () => {
  const pending = graphDeliveryStatus(deliveryProgress(null), true)
  expect(pending.title).toBe('MR 尚未创建')
  expect(pending.tone).toBe('info')
  const progress = deliveryProgress()
  expect(
    graphDeliveryStatus(
      { ...progress, delivery: { ...progress.delivery!, status: 'merged' } },
      true,
    ),
  ).toMatchObject({ title: 'MR 已合入', tone: 'success' })
  expect(
    graphDeliveryStatus(
      { ...progress, delivery: { ...progress.delivery!, status: 'closed' } },
      true,
    ),
  ).toMatchObject({ title: 'MR 已关闭，未合入', tone: 'warning' })
  expect(
    graphDeliveryStatus({ ...deliveryProgress(null), mode: 'local-artifact' }, true).title,
  ).toBe('本地产物交付')
})

test('manual acceptance shows the expected outcome, steps and owner before recording a result', async () => {
  data.document.obligations = [
    {
      id: 'accept',
      revision: 1,
      statement: '重复提交时只保留一个预约',
      elementIds: ['booking'],
      concernIds: ['c'],
      verification: {
        kind: 'manual',
        instructions: '打开两个窗口同时提交预约。\n观察只有一个成功结果。',
        owner: '产品验收人',
        when: '发布前',
      },
    },
  ]
  const evidence: GraphEvidenceData = {
    candidate: {
      basisId: 'basis',
      basisDigest: 'b',
      candidateTreeOid: 'c',
      obligationIds: ['accept'],
    },
    obligations: [{ obligationId: 'accept', state: 'pending', evidenceIds: [] }],
    traces: [],
    evidence: [
      {
        freshness: 'current',
        reasons: [],
        evidence: {
          id: 'execution',
          kind: 'execution',
          result: 'passed',
          summary: 'passed',
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
          artifactRef: null,
          artifactDigest: null,
          recordedAt: 1,
        },
      },
    ],
  }
  const onAccept = vi.fn(async () => true)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <GraphDesignEvidence
        data={evidence}
        document={data.document}
        canEdit
        busy={false}
        zh
        onVerify={() => {}}
        onAccept={onAccept}
        onLocate={() => {}}
      />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: '记录人工验收' }))
  const dialog = await screen.findByRole('dialog', { name: '记录候选的人工验收' })
  expect(within(dialog).getByText('重复提交时只保留一个预约')).toBeTruthy()
  expect(within(dialog).getByText(/打开两个窗口同时提交预约/)).toBeTruthy()
  expect(within(dialog).getByText(/产品验收人/)).toBeTruthy()
  expect(onAccept).not.toHaveBeenCalled()
  fireEvent.change(within(dialog).getByRole('textbox', { name: '操作与观察结果' }), {
    target: { value: '两个窗口同时提交，一个成功，一个收到冲突提示。' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: '保存验收结论' }))
  await waitFor(() =>
    expect(onAccept).toHaveBeenCalledWith(
      expect.objectContaining({
        obligationId: 'accept',
        candidateTreeOid: 'c',
        comment: '两个窗口同时提交，一个成功，一个收到冲突提示。',
      }),
    ),
  )
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

// H5: real hosted acceptance 2026-10-28, Case 01M5ZZCVCM0S9Y9JNQRQRPVW1V.
function feedbackProposal(kind = 'code-feedback', status = 'proposed') {
  const proposal = {
    id: 'code-feedback:build',
    kind,
    status,
    invocationRef: 'build',
    readSet: [],
    plan: null,
    explanation: '实现报告限制',
    document: structuredClone(data.document),
  }
  proposal.document.concerns.push(
    ...['平台校验尚未执行', '明确排除的需求未实现'].map((statement, index) => ({
      id: `implementation-gap:build:${index}`,
      revision: 1,
      statement,
      purpose: 'implement' as const,
      priority: 'required' as const,
      disposition: 'open' as const,
      sourceIds: [],
      resolutionIds: [],
    })),
  )
  data.proposals = [{ id: proposal.id, status, createdAt: 1 }]
  const original = vi.mocked(api.get).getMockImplementation()!
  vi.mocked(api.get).mockImplementation((async (path: string, ...args: unknown[]) =>
    path.includes('/proposals/') ? proposal : original(path, ...(args as []))) as typeof api.get)
  return proposal
}

test('H5: the proposed code-feedback dialog requires a reason, sends one command and refreshes queries', async () => {
  feedbackProposal()
  open()
  fireEvent.click(await screen.findByRole('button', { name: /查看提案差异/ }))
  fireEvent.click(await screen.findByRole('button', { name: '判定不构成缺口' }))
  const dialog = screen.getByRole('dialog', { name: '判定不构成缺口' })
  expect(
    within(dialog)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual(['平台校验尚未执行', '明确排除的需求未实现'])
  const reason = within(dialog).getByRole('textbox', { name: /判定理由/ })
  const save = within(dialog).getByRole('button', { name: '保存判定' }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  fireEvent.change(reason, { target: { value: '  ' } })
  expect(save.disabled).toBe(true)
  fireEvent.change(reason, { target: { value: '这两项分别属于验证安排和明确排除范围。' } })
  const previousReads = vi
    .mocked(api.get)
    .mock.calls.filter(([path]) => path === '/api/development-designs/design').length
  let complete!: (value: unknown) => void
  vi.mocked(api.post).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  fireEvent.click(save)
  await waitFor(() => expect(save.disabled).toBe(true))
  expect((reason as HTMLTextAreaElement).disabled).toBe(true)
  expect(api.post).toHaveBeenCalledWith(
    '/api/development-designs/design/proposals/code-feedback%3Abuild/limitation-review',
    {
      requestId: expect.any(String),
      comment: '这两项分别属于验证安排和明确排除范围。',
    },
  )
  complete({ id: 'limitation-review:human' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() =>
    expect(
      vi.mocked(api.get).mock.calls.filter(([path]) => path === '/api/development-designs/design')
        .length,
    ).toBeGreaterThan(previousReads),
  )
})

for (const [kind, status] of [
  ['semantic-change', 'proposed'],
  ['code-feedback', 'rejected'],
  ['code-feedback', 'accepted'],
  ['code-feedback', 'stale'],
])
  test(`H5: ${kind}/${status} has no limitation judgment action`, async () => {
    feedbackProposal(kind, status)
    open()
    fireEvent.click(await screen.findByRole('button', { name: /查看提案差异/ }))
    await screen.findByText('实现报告限制')
    expect(screen.queryByRole('button', { name: '判定不构成缺口' })).toBeNull()
  })

test('H5: an observer sees the proposal but cannot record a judgment', async () => {
  feedbackProposal()
  open(false)
  fireEvent.click(await screen.findByRole('button', { name: /查看提案差异/ }))
  expect(
    ((await screen.findByRole('button', { name: '判定不构成缺口' })) as HTMLButtonElement).disabled,
  ).toBe(true)
})

test('H5: errors remain in the judgment dialog and retry preserves the requestId', async () => {
  feedbackProposal()
  vi.mocked(api.post)
    .mockRejectedValueOnce(new Error('judgment response lost'))
    .mockResolvedValueOnce({})
  open()
  fireEvent.click(await screen.findByRole('button', { name: /查看提案差异/ }))
  fireEvent.click(await screen.findByRole('button', { name: '判定不构成缺口' }))
  const dialog = screen.getByRole('dialog', { name: '判定不构成缺口' })
  fireEvent.change(within(dialog).getByRole('textbox', { name: /判定理由/ }), {
    target: { value: '人工确认这不是缺口。' },
  })
  const save = within(dialog).getByRole('button', { name: '保存判定' }) as HTMLButtonElement
  fireEvent.click(save)
  await within(dialog).findByText('judgment response lost')
  expect(save.disabled).toBe(false)
  fireEvent.click(save)
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
  expect(vi.mocked(api.post).mock.calls[1]).toEqual(vi.mocked(api.post).mock.calls[0])
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

test('H5: limitation review has its own evidence label', async () => {
  const original = vi.mocked(api.get).getMockImplementation()!
  vi.mocked(api.get).mockImplementation((async (path: string, ...args: unknown[]) =>
    path.endsWith('/evidence')
      ? {
          evidence: [
            {
              evidence: {
                id: 'limitation-review:human',
                kind: 'limitation-review',
                summary: '人工确认不构成缺口',
                result: 'passed',
                limitations: ['平台校验尚未执行'],
                obligationIds: [],
                artifactRef: null,
              },
              freshness: 'current',
              reasons: [],
            },
          ],
          traces: [],
          obligations: [],
        }
      : original(path, ...(args as []))) as typeof api.get)
  open()
  expect(await screen.findByRole('heading', { name: '实现限制人工判定' })).toBeTruthy()
  expect(await screen.findByText('人工确认不构成缺口')).toBeTruthy()
})
