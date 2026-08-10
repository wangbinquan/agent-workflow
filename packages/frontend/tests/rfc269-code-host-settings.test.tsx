// RFC-269 — 设置页「代码平台」分区的回归锁。
//
// 存在的理由是一个真 bug：`<ErrorBanner error={error} />` 被**无条件**渲染，
// 而 `error` 初始就是 `null`。ErrorBanner 在 `error == null` 且没有 `message`
// 时会落到 `message ?? t('common.unknownError')` 分支 —— 于是页面一打开就挂着
// 一条「未知错误」，用户报「代码平台的配置页面一直有个未知错误」。
//
// 这条锁断言的是**没有错误时不渲染错误横幅**，而不是某句文案，所以它对
// ErrorBanner 未来的文案改动免疫。

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from '../src/api/client'
import { CodeHostsSection } from '../src/components/settings/CodeHostsSection'

const listResponse = [
  {
    provider: 'gitlab',
    configured: true,
    baseUrl: 'https://gitlab.corp.example/api/v4',
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
    delete: vi.fn(async () => ({ ok: true })),
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
        rejectUnauthorized: false,
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
})
