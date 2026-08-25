import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  LaneAdapterBindingDialog,
  LaneAdapterResourceDialog,
} from '../src/components/digital-employees/LaneAdapterBindingDialog'
import type { LaneAdapterBinding, LaneAdapterSlot } from '../src/components/digital-employees/types'
import { clearToken, setBaseUrl, setToken } from '../src/stores/auth'

const permissionState = vi.hoisted(() => ({ permissions: [] as string[] }))

vi.mock('@/hooks/useActor', () => ({
  usePermission: (permission: string) => permissionState.permissions.includes(permission),
  useActor: () => ({
    status: 'success',
    fetchStatus: 'idle',
    data: {
      user: { id: 'owner', username: 'owner', displayName: 'Owner', status: 'active' },
      source: 'session',
      permissions: permissionState.permissions,
    },
  }),
  useAuthSessionRevision: () => 1,
  meQueryOptions: () => ({ queryKey: ['auth', 'me', 'test'] as const }),
}))

vi.mock('@/components/AclPanel', () => ({
  AclPanel: ({ onCancel }: { onCancel?: () => void }) => (
    <div data-testid="adapter-acl-panel">
      <button type="button" onClick={onCancel}>
        Return from ACL
      </button>
    </div>
  ),
}))

const slot: LaneAdapterSlot = {
  slotRef: 'primary',
  purpose: 'pipeline-gate',
  label: { 'zh-CN': '企业流水线连接', 'en-US': 'Enterprise pipeline connection' },
  description: { 'zh-CN': '采集企业流水线证据', 'en-US': 'Collect pipeline evidence' },
  requiredWhenLaneEnabled: true,
}

const inherited: LaneAdapterBinding = {
  laneId: 'care-pipeline',
  slotRef: 'primary',
  adapterRef: { id: 'pipeline-a', revision: 2 },
}

const overridden: LaneAdapterBinding = {
  laneId: 'care-pipeline',
  slotRef: 'primary',
  adapterRef: { id: 'pipeline-b', revision: 3 },
}

const baseChoices = [
  {
    id: 'pipeline-a',
    name: 'Pipeline A',
    purpose: 'pipeline-gate',
    publishedRevision: 2,
    archivedAt: null,
    ownerUserId: 'owner',
  },
  {
    id: 'pipeline-b',
    name: 'Pipeline B',
    purpose: 'pipeline-gate',
    publishedRevision: 3,
    archivedAt: null,
    ownerUserId: 'owner',
  },
  {
    id: 'approval-only',
    name: 'Approval only',
    purpose: 'approval-gateway',
    publishedRevision: 4,
    archivedAt: null,
    ownerUserId: 'owner',
  },
  {
    id: 'pipeline-draft',
    name: 'Pipeline draft',
    purpose: 'pipeline-gate',
    publishedRevision: null,
    archivedAt: null,
    ownerUserId: 'owner',
  },
  {
    id: 'pipeline-archived',
    name: 'Pipeline archived',
    purpose: 'pipeline-gate',
    publishedRevision: 1,
    archivedAt: 1,
    ownerUserId: 'owner',
  },
]

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function mount(props: Partial<React.ComponentProps<typeof LaneAdapterBindingDialog>> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const onChange = vi.fn<(binding: LaneAdapterBinding | null) => void>()
  const onClose = vi.fn()
  const outerSubmit = vi.fn()
  const utils = render(
    <QueryClientProvider client={qc}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          outerSubmit()
        }}
      >
        <LaneAdapterBindingDialog
          open
          onClose={onClose}
          language="zh-CN"
          laneId="care-pipeline"
          slot={slot}
          mode="employee-override"
          value={null}
          inherited={inherited}
          onChange={onChange}
          {...props}
        />
      </form>
    </QueryClientProvider>,
  )
  return { ...utils, onChange, onClose, outerSubmit, qc }
}

function mountResourceLibrary() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const onClose = vi.fn()
  const utils = render(
    <QueryClientProvider client={qc}>
      <LaneAdapterResourceDialog open onClose={onClose} language="zh-CN" slot={slot} />
    </QueryClientProvider>,
  )
  return { ...utils, onClose, qc }
}

function choose(label: string): void {
  fireEvent.click(screen.getByRole('combobox'))
  const list = screen.getByRole('listbox')
  const option = within(list).getByRole('option', { name: new RegExp(label) })
  fireEvent.mouseDown(option)
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('rfc323-dialog-token')
  permissionState.permissions = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
    const url = new URL(String(request))
    if (url.pathname === '/api/integrations/development-adapters') {
      return json({ items: baseChoices })
    }
    throw new Error(`unexpected request: ${url.pathname}`)
  })
})

afterEach(() => {
  cleanup()
  clearToken()
  vi.restoreAllMocks()
})

describe('RFC-323 lane Adapter binding dialog', () => {
  test('toolbox cards manage purpose-scoped Adapter resources without choosing an employee or job', async () => {
    permissionState.permissions = [
      'adapter-definitions:create',
      'adapter-definitions:update',
      'scripts:author',
    ]
    mountResourceLibrary()

    expect(await screen.findByTestId('lane-adapter-resource-library')).not.toBeNull()
    expect(await screen.findByText('Pipeline A')).not.toBeNull()
    expect(screen.getByText('Pipeline B')).not.toBeNull()
    expect(screen.getByText('Pipeline draft')).not.toBeNull()
    expect(screen.queryByText('Approval only')).toBeNull()
    expect(screen.queryByText('Pipeline archived')).toBeNull()
    expect(screen.queryByRole('radio', { name: '具体员工' })).toBeNull()
    expect(screen.queryByRole('radio', { name: '岗位默认' })).toBeNull()
    expect(screen.queryByRole('button', { name: '保存连接' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '新建连接' }))
    expect(screen.getByLabelText('名称 *')).not.toBeNull()
    const executableInput = screen.getByLabelText(/^可执行文件 \/ 脚本路径/)
    expect(executableInput.getAttribute('placeholder')).toBe(
      '/opt/company-adapters/pipeline-gate.ts',
    )
    expect(screen.getByText(/这里不填写代码，也不支持带参数的 Shell 命令/)).not.toBeNull()
  })

  test('keeps the primary surface minimal, purpose-filtered and overlay-stable', async () => {
    const { onClose } = mount({ mode: 'job-default', value: inherited, inherited: null })

    await screen.findByText('Pipeline A')
    expect(screen.queryByText('新建连接')).toBeNull()
    expect(screen.queryByText('管理连接')).toBeNull()
    expect(screen.queryByText('可执行文件 / 脚本路径')).toBeNull()
    expect(screen.queryByText('允许投影的环境变量名')).toBeNull()

    fireEvent.click(screen.getByRole('combobox'))
    const list = screen.getByRole('listbox')
    expect(within(list).getByText(/Pipeline A/)).not.toBeNull()
    expect(within(list).getByText(/Pipeline B/)).not.toBeNull()
    expect(within(list).queryByText(/Approval only/)).toBeNull()
    expect(within(list).queryByText(/Pipeline draft/)).toBeNull()
    expect(within(list).queryByText(/Pipeline archived/)).toBeNull()

    fireEvent.mouseDown(screen.getByTestId('lane-adapter-dialog'))
    expect(onClose).not.toHaveBeenCalled()
  })

  test('restores inheritance without persisting a copied override', async () => {
    const { onChange, onClose } = mount({ value: overridden })
    await screen.findByText('Pipeline B')

    fireEvent.click(screen.getByRole('radio', { name: '继承岗位模板' }))
    fireEvent.click(screen.getByRole('button', { name: '恢复继承' }))

    expect(onChange).toHaveBeenCalledWith(null)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('freezes the selected published revision as an employee override', async () => {
    const { onChange } = mount()
    await screen.findByText('Pipeline A')

    fireEvent.click(screen.getByRole('radio', { name: '员工覆盖' }))
    choose('Pipeline B')
    fireEvent.click(screen.getByRole('button', { name: '保存连接' }))

    expect(onChange).toHaveBeenCalledWith(overridden)
  })

  test('keeps the previous employee override when inheritance is previewed and canceled', async () => {
    const { onChange } = mount({ value: overridden })
    await screen.findByText('Pipeline B')

    fireEvent.click(screen.getByRole('radio', { name: '继承岗位模板' }))
    fireEvent.click(screen.getByRole('radio', { name: '员工覆盖' }))
    fireEvent.click(screen.getByRole('button', { name: '保存连接' }))

    expect(onChange).toHaveBeenCalledWith(overridden)
  })

  test('requires scripts:author for resource actions and exposes create as a guided flow', async () => {
    permissionState.permissions = ['adapter-definitions:create']
    const first = mount()
    await screen.findByText('Pipeline A')
    expect(screen.queryByText('新建连接')).toBeNull()
    first.unmount()

    permissionState.permissions = [
      'adapter-definitions:create',
      'adapter-definitions:update',
      'scripts:author',
    ]
    let created = false
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockImplementation(async (request, init) => {
      const url = new URL(String(request))
      if (url.pathname === '/api/integrations/development-adapters' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        expect(body).toMatchObject({
          name: 'Pipeline C',
          purpose: 'pipeline-gate',
          draft: {
            purpose: 'pipeline-gate',
            operations: ['collect'],
            executableRef: '/opt/company-adapters/pipeline-c.ts',
          },
        })
        created = true
        return json({ id: 'pipeline-c' }, 201)
      }
      if (
        url.pathname === '/api/integrations/development-adapters/pipeline-c/publish' &&
        init?.method === 'POST'
      ) {
        return json({ revision: 7, contentDigest: 'digest-c' })
      }
      if (url.pathname === '/api/integrations/development-adapters') {
        return json({
          items: created
            ? [
                ...baseChoices,
                {
                  id: 'pipeline-c',
                  name: 'Pipeline C',
                  purpose: 'pipeline-gate',
                  publishedRevision: 7,
                  archivedAt: null,
                  ownerUserId: 'owner',
                },
              ]
            : baseChoices,
        })
      }
      throw new Error(`unexpected request: ${url.pathname}`)
    })

    const { onChange, outerSubmit } = mount()
    await screen.findByText('新建连接')
    fireEvent.click(screen.getByRole('button', { name: '新建连接' }))

    const details = document.querySelector('details.lane-adapter-dialog__advanced')
    expect(details?.hasAttribute('open')).toBe(false)
    fireEvent.change(screen.getByLabelText('名称 *'), { target: { value: 'Pipeline C' } })
    fireEvent.change(screen.getByLabelText(/^可执行文件 \/ 脚本路径/), {
      target: { value: '/opt/company-adapters/pipeline-c.ts' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存并发布' }))

    await screen.findByText('Pipeline C')
    expect(outerSubmit).not.toHaveBeenCalled()
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '保存连接' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: '保存连接' }))
    expect(onChange).toHaveBeenCalledWith({
      laneId: 'care-pipeline',
      slotRef: 'primary',
      adapterRef: { id: 'pipeline-c', revision: 7 },
    })
  })

  test('does not offer management for a visible Adapter owned by another user', async () => {
    permissionState.permissions = ['adapter-definitions:update', 'scripts:author']
    vi.mocked(globalThis.fetch).mockImplementation(async (request) => {
      const url = new URL(String(request))
      if (url.pathname === '/api/integrations/development-adapters') {
        return json({
          items: baseChoices.map((choice) =>
            choice.id === 'pipeline-a' ? { ...choice, ownerUserId: 'another-owner' } : choice,
          ),
        })
      }
      throw new Error(`unexpected request: ${url.pathname}`)
    })

    mount({ mode: 'job-default', value: inherited, inherited: null })
    await screen.findByText('Pipeline A')
    expect(screen.queryByRole('button', { name: '管理连接' })).toBeNull()
  })

  test('keeps a successfully created draft manageable when its first publish attempt fails', async () => {
    permissionState.permissions = [
      'adapter-definitions:create',
      'adapter-definitions:update',
      'scripts:author',
    ]
    let createCalls = 0
    let publishCalls = 0
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockImplementation(async (request, init) => {
      const url = new URL(String(request))
      const method = init?.method ?? 'GET'
      if (url.pathname === '/api/integrations/development-adapters' && method === 'GET') {
        return json({ items: baseChoices })
      }
      if (url.pathname === '/api/integrations/development-adapters' && method === 'POST') {
        createCalls += 1
        return json({ id: 'pipeline-retry' }, 201)
      }
      if (
        url.pathname === '/api/integrations/development-adapters/pipeline-retry' &&
        method === 'GET'
      ) {
        return json({
          id: 'pipeline-retry',
          name: 'Pipeline retry',
          purpose: 'pipeline-gate',
          publishedRevision: null,
          archivedAt: null,
          draft: {
            schemaVersion: 1,
            purpose: 'pipeline-gate',
            operations: ['collect'],
            contractVersion: 1,
            executableRef: '/opt/company-adapters/pipeline-retry.ts',
            parameterSchemaRef: null,
            connectionRef: null,
            secretProjection: [],
            outputBudget: { maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 4096 },
            timeoutMs: 5000,
          },
        })
      }
      if (
        url.pathname === '/api/integrations/development-adapters/pipeline-retry' &&
        method === 'PUT'
      ) {
        return json({ ok: true })
      }
      if (
        url.pathname === '/api/integrations/development-adapters/pipeline-retry/publish' &&
        method === 'POST'
      ) {
        publishCalls += 1
        return publishCalls === 1
          ? json({ error: 'adapter-validation-failed' }, 422)
          : json({ revision: 8, contentDigest: 'digest-retry' })
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`)
    })

    mount({ mode: 'job-default', value: null, inherited: null })
    await screen.findByText('新建连接')
    fireEvent.click(screen.getByRole('button', { name: '新建连接' }))
    fireEvent.change(screen.getByLabelText('名称 *'), {
      target: { value: 'Pipeline retry' },
    })
    fireEvent.change(screen.getByLabelText(/^可执行文件 \/ 脚本路径/), {
      target: { value: '/opt/company-adapters/pipeline-retry.ts' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存并发布' }))

    await waitFor(() => expect(publishCalls).toBe(1))
    expect(await screen.findByRole('button', { name: '可见范围与授权' })).not.toBeNull()
    expect(screen.getByDisplayValue('Pipeline retry')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '保存并发布' }))
    await waitFor(() => expect(publishCalls).toBe(2))
    expect(createCalls).toBe(1)
    expect(await screen.findByText('pipeline-retry')).not.toBeNull()
  })

  test('keeps edit, archive and ACL lifecycle reachable only to authorized owners', async () => {
    permissionState.permissions = [
      'adapter-definitions:update',
      'adapter-definitions:archive',
      'scripts:author',
    ]
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockImplementation(async (request, init) => {
      const url = new URL(String(request))
      if (url.pathname === '/api/integrations/development-adapters') {
        return json({ items: baseChoices })
      }
      if (
        url.pathname === '/api/integrations/development-adapters/pipeline-a' &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return json({
          ...baseChoices[0],
          draft: {
            schemaVersion: 1,
            purpose: 'pipeline-gate',
            operations: ['collect'],
            contractVersion: 1,
            executableRef: '/opt/company-adapters/pipeline-a.ts',
            parameterSchemaRef: null,
            connectionRef: 'enterprise/pipeline-a',
            secretProjection: ['PIPELINE_TOKEN'],
            outputBudget: { maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 4096 },
            timeoutMs: 5000,
          },
        })
      }
      if (
        url.pathname === '/api/integrations/development-adapters/pipeline-a/archive' &&
        init?.method === 'POST'
      ) {
        return json({ ok: true })
      }
      throw new Error(`unexpected request: ${url.pathname}`)
    })

    mount({ mode: 'job-default', value: inherited, inherited: null })
    await screen.findByText('管理连接')
    fireEvent.click(screen.getByRole('button', { name: '管理连接' }))
    await screen.findByDisplayValue('/opt/company-adapters/pipeline-a.ts')
    expect(screen.getByRole('button', { name: '可见范围与授权' })).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '可见范围与授权' }))
    expect(screen.getByTestId('adapter-acl-panel')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Return from ACL' }))

    fireEvent.click(screen.getByRole('button', { name: '归档' }))
    fireEvent.click(screen.getByRole('button', { name: '确认归档' }))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        'http://daemon.test/api/integrations/development-adapters/pipeline-a/archive',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
  })
})
