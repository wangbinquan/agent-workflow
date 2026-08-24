// RFC-269 — 设置页「代码平台」分区的回归锁。
//
// 存在的理由是一个真 bug：`<ErrorBanner error={error} />` 被**无条件**渲染，
// 而 `error` 初始就是 `null`。ErrorBanner 在 `error == null` 且没有 `message`
// 时会落到 `message ?? t('common.unknownError')` 分支 —— 于是页面一打开就挂着
// 一条「未知错误」，用户报「代码平台的配置页面一直有个未知错误」。
//
// 这条锁断言的是**没有错误时不渲染错误横幅**，而不是某句文案，所以它对
// ErrorBanner 未来的文案改动免疫。

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from '../src/api/client'
import { CodeHostsSection } from '../src/components/settings/CodeHostsSection'

const listResponse = [
  {
    provider: 'gitlab',
    configured: true,
    baseUrl: 'https://gitlab.corp.example/api/v4',
    repositoryUrlPrefixes: ['https://mirror.example/platform'],
    transportMappings: [],
    connectionGeneration: 'gitlab-generation',
    endpointBindingDigest: 'a'.repeat(64),
    personalPushCredentialCount: 2,
    rejectUnauthorized: true,
    tokenHint: '9999',
    updatedAt: 1,
    updatedBy: null,
    lastTest: null,
  },
  {
    provider: 'github',
    configured: false,
    baseUrl: '',
    repositoryUrlPrefixes: [],
    transportMappings: [],
    connectionGeneration: null,
    endpointBindingDigest: null,
    personalPushCredentialCount: 0,
    rejectUnauthorized: true,
    tokenHint: '',
    updatedAt: null,
    updatedBy: null,
    lastTest: null,
  },
]

vi.mock('../src/api/client', () => ({
  api: {
    get: vi.fn(async () => listResponse),
    put: vi.fn(async () => listResponse[0]),
    post: vi.fn(async () => ({ ok: true, at: 1, login: 'aw-bot' })),
    deleteJson: vi.fn(async () => ({ ok: true })),
  },
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <CodeHostsSection />
    </QueryClientProvider>,
  )
}

describe('RFC-269 设置页 · 代码平台分区', () => {
  test('没有错误时不渲染任何错误横幅（回归：初始 null 曾被渲染成「未知错误」）', async () => {
    renderSection()
    await waitFor(() => {
      expect(screen.getByTestId('code-host-card-gitlab')).toBeTruthy()
    })
    // 两张卡片都渲染出来了，且页面上没有任何错误横幅。
    expect(screen.getByTestId('code-host-card-github')).toBeTruthy()
    expect(document.querySelectorAll('.notice-banner--error').length).toBe(0)
    expect(document.body.textContent ?? '').not.toContain('unknownError')
  })

  test('已配置的一家显示尾号掩码，未配置的一家不显示', async () => {
    renderSection()
    await waitFor(() => {
      expect(screen.getByTestId('code-host-card-gitlab')).toBeTruthy()
    })
    const gitlabToken = screen.getByTestId('code-host-token-gitlab') as HTMLInputElement
    // 明文永不回传：输入框是空的，占位符只透出尾 4 位。
    expect(gitlabToken.value).toBe('')
    expect(gitlabToken.getAttribute('placeholder')).toContain('9999')
    expect(gitlabToken.getAttribute('type')).toBe('password')
    const githubToken = screen.getByTestId('code-host-token-github') as HTMLInputElement
    expect(githubToken.getAttribute('placeholder') ?? '').toBe('')
  })

  test('未配置的一家不给删除按钮（没东西可删）', async () => {
    renderSection()
    await waitFor(() => {
      expect(screen.getByTestId('code-host-card-gitlab')).toBeTruthy()
    })
    expect(screen.getByTestId('code-host-remove-gitlab')).toBeTruthy()
    expect(screen.queryByTestId('code-host-remove-github')).toBeNull()
  })

  test('TLS 开关只属于 GitLab，默认开启并显示明确风险提示', async () => {
    renderSection()
    const tlsSwitch = (await screen.findByTestId(
      'code-host-reject-unauthorized-gitlab',
    )) as HTMLInputElement
    expect(tlsSwitch.checked).toBe(true)
    expect(screen.queryByTestId('code-host-reject-unauthorized-github')).toBeNull()
    expect(document.body.textContent).toContain('rejectUnauthorized: false')
  })

  test('仓库 URL 前缀集合只属于 GitLab，新增后随保存请求提交', async () => {
    renderSection()
    const input = (await screen.findByTestId(
      'code-host-repository-url-prefixes-gitlab-input',
    )) as HTMLInputElement
    expect(screen.queryByTestId('code-host-repository-url-prefixes-github-input')).toBeNull()
    expect(document.body.textContent).toContain('https://mirror.example/platform')

    fireEvent.change(input, { target: { value: 'HTTPS://Second.Example/team/' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByTestId('code-host-save-gitlab'))
    await waitFor(() => {
      expect(vi.mocked(api.put)).toHaveBeenCalledWith('/api/code-hosts/gitlab', {
        baseUrl: 'https://gitlab.corp.example/api/v4',
        repositoryUrlPrefixes: ['https://mirror.example/platform', 'https://second.example/team'],
        transportMappings: [],
        rejectUnauthorized: true,
        expectedConnectionGeneration: 'gitlab-generation',
      })
    })
  })

  test('关闭开关后保存与测试请求都精确携带 rejectUnauthorized:false', async () => {
    renderSection()
    const tlsSwitch = (await screen.findByTestId(
      'code-host-reject-unauthorized-gitlab',
    )) as HTMLInputElement
    fireEvent.click(tlsSwitch)
    expect(tlsSwitch.checked).toBe(false)

    fireEvent.click(screen.getByTestId('code-host-save-gitlab'))
    await waitFor(() => {
      expect(vi.mocked(api.put)).toHaveBeenCalledWith('/api/code-hosts/gitlab', {
        baseUrl: 'https://gitlab.corp.example/api/v4',
        repositoryUrlPrefixes: ['https://mirror.example/platform'],
        transportMappings: [],
        rejectUnauthorized: false,
        expectedConnectionGeneration: 'gitlab-generation',
      })
    })

    await waitFor(() => {
      expect((screen.getByTestId('code-host-test-gitlab') as HTMLButtonElement).disabled).toBe(
        false,
      )
    })
    fireEvent.click(screen.getByTestId('code-host-test-gitlab'))
    await waitFor(() => {
      expect(vi.mocked(api.post)).toHaveBeenCalledWith('/api/code-hosts/gitlab/test', {
        baseUrl: 'https://gitlab.corp.example/api/v4',
        rejectUnauthorized: false,
      })
    })
  })

  test('自建 SSH 克隆地址可配置为精确 HTTP(S) 推送映射，并在保存前规范化', async () => {
    renderSection()
    await screen.findByTestId('code-host-card-gitlab')

    fireEvent.click(screen.getByTestId('code-host-transport-add-gitlab'))
    fireEvent.change(screen.getByTestId('code-host-transport-ssh-host-gitlab-0'), {
      target: { value: 'SSH.GITLAB.CORP.EXAMPLE' },
    })
    fireEvent.change(screen.getByTestId('code-host-transport-ssh-path-gitlab-0'), {
      target: { value: '/platform/' },
    })
    fireEvent.change(screen.getByTestId('code-host-transport-http-base-gitlab-0'), {
      target: { value: 'https://gitlab.corp.example/scm/' },
    })
    expect(screen.getByTestId('code-host-transport-preview-gitlab-0').textContent).toContain(
      'git@ssh.gitlab.corp.example:platform/namespace/repository.git',
    )
    expect(screen.getByTestId('code-host-transport-preview-gitlab-0').textContent).toContain(
      'https://gitlab.corp.example/scm/namespace/repository.git',
    )
    fireEvent.click(screen.getByTestId('code-host-save-gitlab'))

    await waitFor(() => {
      expect(vi.mocked(api.put)).toHaveBeenCalledWith('/api/code-hosts/gitlab', {
        baseUrl: 'https://gitlab.corp.example/api/v4',
        repositoryUrlPrefixes: ['https://mirror.example/platform'],
        transportMappings: [
          {
            sshHost: 'ssh.gitlab.corp.example',
            sshPort: 22,
            sshPathPrefix: 'platform',
            httpBaseUrl: 'https://gitlab.corp.example/scm',
          },
        ],
        rejectUnauthorized: true,
        expectedConnectionGeneration: 'gitlab-generation',
      })
    })
  })

  test('同一 SSH 目标不能保存到两个不同 HTTP(S) 根地址', async () => {
    renderSection()
    await screen.findByTestId('code-host-card-gitlab')

    for (const index of [0, 1]) {
      fireEvent.click(screen.getByTestId('code-host-transport-add-gitlab'))
      fireEvent.change(screen.getByTestId(`code-host-transport-ssh-host-gitlab-${index}`), {
        target: { value: 'ssh.gitlab.corp.example' },
      })
      fireEvent.change(screen.getByTestId(`code-host-transport-ssh-path-gitlab-${index}`), {
        target: { value: 'platform' },
      })
      fireEvent.change(screen.getByTestId(`code-host-transport-http-base-gitlab-${index}`), {
        target: { value: `https://gitlab-${index}.corp.example/scm` },
      })
    }
    fireEvent.click(screen.getByTestId('code-host-save-gitlab'))

    await waitFor(() => {
      expect(document.querySelector('.notice-banner--error')?.textContent).toContain(
        'One SSH host, port and path prefix',
      )
    })
    expect(vi.mocked(api.put)).not.toHaveBeenCalled()
  })

  test('改变端点身份时明确确认会吊销个人凭据，并用服务端签发的摘要重试', async () => {
    const conflict = Object.assign(new Error('rebind confirmation required'), {
      code: 'code-host-transport-rebind-confirmation-required',
      details: {
        personalPushCredentialCount: 2,
        expectedConnectionGeneration: 'gitlab-generation',
        confirmCredentialRevocationDigest: 'b'.repeat(64),
      },
    })
    vi.mocked(api.put).mockRejectedValueOnce(conflict).mockResolvedValueOnce(listResponse[0]!)
    renderSection()
    await screen.findByTestId('code-host-card-gitlab')

    fireEvent.click(screen.getByTestId('code-host-save-gitlab'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('2')
    fireEvent.click(within(dialog).getByRole('button', { name: /save and revoke|保存并吊销/i }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(vi.mocked(api.put)).toHaveBeenLastCalledWith('/api/code-hosts/gitlab', {
      baseUrl: 'https://gitlab.corp.example/api/v4',
      repositoryUrlPrefixes: ['https://mirror.example/platform'],
      transportMappings: [],
      rejectUnauthorized: true,
      expectedConnectionGeneration: 'gitlab-generation',
      confirmCredentialRevocationDigest: 'b'.repeat(64),
    })
  })

  test('并发 writer 使确认摘要 stale 时刷新连接并要求重新预检', async () => {
    const firstImpact = Object.assign(new Error('rebind confirmation required'), {
      code: 'code-host-transport-rebind-confirmation-required',
      details: {
        personalPushCredentialCount: 2,
        expectedConnectionGeneration: 'gitlab-generation',
        confirmCredentialRevocationDigest: 'b'.repeat(64),
      },
    })
    const stale = Object.assign(new Error('connection impact changed'), {
      code: 'code-host-push-credential-stale',
    })
    const refreshedImpact = Object.assign(new Error('rebind confirmation required again'), {
      code: 'code-host-transport-rebind-confirmation-required',
      details: {
        personalPushCredentialCount: 1,
        expectedConnectionGeneration: 'gitlab-generation',
        confirmCredentialRevocationDigest: 'd'.repeat(64),
      },
    })
    vi.mocked(api.put)
      .mockRejectedValueOnce(firstImpact)
      .mockRejectedValueOnce(stale)
      .mockRejectedValueOnce(refreshedImpact)
    renderSection()
    await screen.findByTestId('code-host-card-gitlab')

    fireEvent.click(screen.getByTestId('code-host-save-gitlab'))
    let dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /save and revoke|保存并吊销/i }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(vi.mocked(api.get).mock.calls.length).toBeGreaterThanOrEqual(2))
    fireEvent.click(screen.getByTestId('code-host-save-gitlab'))
    dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('1')
    expect(vi.mocked(api.put)).toHaveBeenLastCalledWith(
      '/api/code-hosts/gitlab',
      expect.not.objectContaining({ confirmCredentialRevocationDigest: 'b'.repeat(64) }),
    )
  })

  test('删除连接先确认破坏性操作；存在个人凭据时复核服务端摘要后再次确认', async () => {
    const conflict = Object.assign(new Error('rebind confirmation required'), {
      code: 'code-host-transport-rebind-confirmation-required',
      details: {
        personalPushCredentialCount: 2,
        expectedConnectionGeneration: 'gitlab-generation',
        confirmCredentialRevocationDigest: 'c'.repeat(64),
      },
    })
    vi.mocked(api.deleteJson)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ ok: true } as never)
    renderSection()
    await screen.findByTestId('code-host-card-gitlab')

    fireEvent.click(screen.getByTestId('code-host-remove-gitlab'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('2')
    fireEvent.click(within(dialog).getByRole('button', { name: /delete|删除/i }))
    expect(await within(dialog).findByText(/choose Delete again|再次点击“删除”/i)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: /delete|删除/i }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(vi.mocked(api.deleteJson)).toHaveBeenNthCalledWith(1, '/api/code-hosts/gitlab', {
      expectedConnectionGeneration: 'gitlab-generation',
    })
    expect(vi.mocked(api.deleteJson)).toHaveBeenNthCalledWith(2, '/api/code-hosts/gitlab', {
      expectedConnectionGeneration: 'gitlab-generation',
      confirmCredentialRevocationDigest: 'c'.repeat(64),
    })
  })
})
