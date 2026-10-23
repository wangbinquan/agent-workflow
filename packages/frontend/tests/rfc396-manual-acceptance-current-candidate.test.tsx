import { afterEach, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { GraphDesignDocument } from '@agent-workflow/shared'
import { GraphDesignEvidence } from '@/features/development-automation/graph-development/GraphDesignEvidence'
import type { GraphEvidenceData } from '@/features/development-automation/graph-development/graphDesignModel'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
  }),
}))

const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
})

function design(): GraphDesignDocument {
  return {
    schemaVersion: 1,
    id: 'design',
    caseId: 'case',
    revision: 1,
    repositoryId: 'repo',
    repositoryBaseline: { kind: 'commit', commitSha: 'a'.repeat(40), treeOid: 'b'.repeat(40) },
    title: '预约',
    goals: ['避免重复预约'],
    concerns: [],
    models: [],
    views: [],
    sources: [],
    relations: [],
    elements: [
      {
        id: 'booking',
        revision: 1,
        kind: 'requirement',
        label: '预约',
        description: '重复提交只保留一笔',
        sourceIds: [],
        obligationIds: ['accept'],
      },
    ],
    obligations: [
      {
        id: 'accept',
        revision: 1,
        statement: '重复提交只保留一笔预约',
        elementIds: ['booking'],
        concernIds: [],
        verification: {
          kind: 'manual',
          instructions: '打开两个窗口同时提交，观察一个成功与一个冲突提示。',
          owner: null,
          when: null,
        },
      },
    ],
  }
}

function evidence(
  tree = 'tree-original',
  basis = 'basis-original',
  freshness: 'current' | 'stale' = 'current',
): GraphEvidenceData {
  return {
    candidate:
      freshness === 'current'
        ? {
            basisId: 'basis:current',
            basisDigest: basis,
            candidateTreeOid: tree,
            obligationIds: ['accept'],
          }
        : null,
    traces: [],
    obligations: [{ obligationId: 'accept', state: 'pending', evidenceIds: [] }],
    evidence: [
      {
        freshness,
        reasons: freshness === 'stale' ? ['different-candidate-content'] : [],
        evidence: {
          id: `execution:${tree}:${basis}`,
          kind: 'execution',
          result: 'passed',
          summary: 'Execution passed',
          limitations: [],
          obligationIds: ['accept'],
          readSet: [],
          basisDigest: basis,
          candidateTreeOid: tree,
          commitSha: null,
          ci: null,
          profileRef: null,
          environmentDigest: 'environment',
          executionRef: 'execution',
          artifactRef: null,
          artifactDigest: null,
          recordedAt: 1,
        },
      },
    ],
  }
}

function mount() {
  const document = design()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const onAccept = vi.fn(async () => true)
  const content = (data: GraphEvidenceData, currentDocument = document) => (
    <QueryClientProvider client={client}>
      <GraphDesignEvidence
        data={data}
        document={currentDocument}
        canEdit
        busy={false}
        zh
        onVerify={() => {}}
        onAccept={onAccept}
        onLocate={() => {}}
      />
    </QueryClientProvider>
  )
  const view = render(content(evidence()))
  return {
    document,
    onAccept,
    update: (data: GraphEvidenceData, currentDocument = document) =>
      view.rerender(content(data, currentDocument)),
  }
}

function fillAcceptance() {
  fireEvent.click(screen.getByRole('button', { name: '记录人工验收' }))
  const dialog = screen.getByRole('dialog', { name: '记录候选的人工验收' })
  fireEvent.change(within(dialog).getByRole('textbox', { name: '操作与观察结果' }), {
    target: { value: '两个窗口提交，一个成功，一个冲突。' },
  })
  return dialog
}

test.each([
  ['candidate tree', 'tree-new', 'basis-original', 'current'],
  ['approved basis', 'tree-original', 'basis-new', 'current'],
  ['current evidence availability', 'tree-original', 'basis-original', 'stale'],
] as const)(
  'polling changes to %s cannot retarget an open manual acceptance',
  (_kind, tree, basis, freshness) => {
    const f = mount()
    const dialog = fillAcceptance()
    f.update(evidence(tree, basis, freshness))
    expect(within(dialog).getByText('tree-original')).toBeTruthy()
    expect(within(dialog).getByText(/请关闭此窗口，重新打开并确认当前候选/)).toBeTruthy()
    const save = within(dialog).getByRole('button', { name: '保存验收结论' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(f.onAccept).not.toHaveBeenCalled()
  },
)

test('an updated manual obligation is held and its original instructions remain visible', () => {
  const f = mount()
  const dialog = fillAcceptance()
  const next = structuredClone(f.document)
  next.revision++
  next.obligations[0]!.statement = '现在允许两笔预约'
  f.update(evidence(), next)
  expect(within(dialog).getByText('重复提交只保留一笔预约')).toBeTruthy()
  expect(within(dialog).queryByText('现在允许两笔预约')).toBeNull()
  expect(
    (within(dialog).getByRole('button', { name: '保存验收结论' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  expect(f.onAccept).not.toHaveBeenCalled()
})

test('reopening after a candidate change requires fresh observations and binds the new candidate', async () => {
  const f = mount()
  const dialog = fillAcceptance()
  f.update(evidence('tree-new', 'basis-new'))
  fireEvent.click(within(dialog).getByRole('button', { name: 'common.close' }))
  fireEvent.click(screen.getByRole('button', { name: '记录人工验收' }))
  const reopened = screen.getByRole('dialog', { name: '记录候选的人工验收' })
  expect(
    (within(reopened).getByRole('textbox', { name: '操作与观察结果' }) as HTMLTextAreaElement)
      .value,
  ).toBe('')
  expect(
    (within(reopened).getByRole('button', { name: '保存验收结论' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  fireEvent.change(within(reopened).getByRole('textbox', { name: '操作与观察结果' }), {
    target: { value: '对新候选重新执行并确认。' },
  })
  fireEvent.click(within(reopened).getByRole('button', { name: '保存验收结论' }))
  await waitFor(() =>
    expect(f.onAccept).toHaveBeenCalledWith({
      obligationId: 'accept',
      basisDigest: 'basis-new',
      candidateTreeOid: 'tree-new',
      result: 'passed',
      comment: '对新候选重新执行并确认。',
    }),
  )
})

test('an unchanged candidate can save the observations without being invalidated by a refresh', async () => {
  const f = mount()
  const dialog = fillAcceptance()
  f.update(evidence())
  fireEvent.click(within(dialog).getByRole('button', { name: '保存验收结论' }))
  await waitFor(() =>
    expect(f.onAccept).toHaveBeenCalledWith({
      obligationId: 'accept',
      basisDigest: 'basis-original',
      candidateTreeOid: 'tree-original',
      result: 'passed',
      comment: '两个窗口提交，一个成功，一个冲突。',
    }),
  )
})

test('declared candidate scope excludes an unrelated manual obligation even when older evidence includes it', () => {
  const f = mount()
  const data = evidence()
  data.candidate!.obligationIds = ['another-obligation']
  f.update(data)
  const open = screen.getByRole('button', { name: '记录人工验收' }) as HTMLButtonElement
  expect(open.disabled).toBe(true)
  expect(screen.getByText(/当前实现依据未包含这项验收要求/)).toBeTruthy()
  fireEvent.click(open)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.onAccept).not.toHaveBeenCalled()
})

test('an explicit absent candidate cannot fall back to historical evidence', () => {
  const f = mount()
  f.update({ ...evidence(), candidate: null })
  expect((screen.getByRole('button', { name: '记录人工验收' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  expect(screen.getByText(/当前候选的验收范围无法确认/)).toBeTruthy()
  expect(f.onAccept).not.toHaveBeenCalled()
})

test('an older response only enables obligations explicitly covered by matching current evidence', async () => {
  const f = mount()
  const data = evidence()
  delete data.candidate
  data.evidence[0]!.evidence.obligationIds = []
  f.update(data)
  expect((screen.getByRole('button', { name: '记录人工验收' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  expect(screen.getByText(/当前候选的验收范围无法确认/)).toBeTruthy()
  data.evidence[0]!.evidence.obligationIds = ['accept']
  f.update(data)
  const dialog = fillAcceptance()
  fireEvent.click(within(dialog).getByRole('button', { name: '保存验收结论' }))
  await waitFor(() =>
    expect(f.onAccept).toHaveBeenCalledWith(
      expect.objectContaining({
        obligationId: 'accept',
        basisDigest: 'basis-original',
        candidateTreeOid: 'tree-original',
      }),
    ),
  )
})

test('the declared candidate takes precedence over older evidence when opening acceptance', async () => {
  const f = mount()
  f.update({
    ...evidence(),
    candidate: {
      basisId: 'new-basis',
      basisDigest: 'basis-new',
      candidateTreeOid: 'tree-new',
      obligationIds: ['accept'],
    },
  })
  const dialog = fillAcceptance()
  expect(within(dialog).getByText('tree-new')).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: '保存验收结论' }))
  await waitFor(() =>
    expect(f.onAccept).toHaveBeenCalledWith(
      expect.objectContaining({ basisDigest: 'basis-new', candidateTreeOid: 'tree-new' }),
    ),
  )
})

test('removing an obligation from the declared candidate scope blocks an already open acceptance', () => {
  const f = mount()
  const dialog = fillAcceptance()
  const data = evidence()
  data.candidate!.obligationIds = []
  f.update(data)
  expect(
    (within(dialog).getByRole('button', { name: '保存验收结论' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  expect(within(dialog).getByText(/请关闭此窗口，重新打开并确认当前候选/)).toBeTruthy()
  expect(f.onAccept).not.toHaveBeenCalled()
})
