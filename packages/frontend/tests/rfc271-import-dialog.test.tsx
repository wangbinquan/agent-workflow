// RFC-271 T39 —— 导入对话框。
//
// 两组断言：
//  ① **零自写 chrome**（CLAUDE.md 前台风格强制原则）。这条用源码层文本断言兜住——
//     新写一套 `.xxx__overlay` / 原生 `<select>` 是 code review 一律打回的回归，
//     但它不会让任何行为测试变红，所以必须显式锁。
//  ② 交互契约：预检默认「能复用就复用」，切到 `new` 才出改名框；**别人的候选会被
//     标出来**（可复用但不可覆盖）；提交回传的是**原样的** previewToken。

//
// 覆盖验收条款：AC-13（各列表页与统一入口都能上传；rootRef 类型与当前页不符时的处理）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）

import { describe, expect, test, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as TanStackRouter from '@tanstack/react-router'
import {
  ResourcePackageImportDialog,
  ResourcePackageImportPanel,
} from '../src/components/ResourcePackageImportDialog'
import { api, ApiError } from '../src/api/client'
import * as pkgApi from '../src/api/resourcePackages'

const { navigateSpy } = vi.hoisted(() => ({ navigateSpy: vi.fn() }))
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof TanStackRouter>()
  return { ...actual, useNavigate: () => navigateSpy }
})

/** ⚠️ 先剥注释再扫：本组件的注释里就写着「不该出现 `.xxx__overlay`」，裸文本扫描
 *  会自己撞上自己（同一个坑在 RFC-217 守卫与 RFC-271 的 ref 契约测试上都踩过）。 */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n')

const SRC = stripComments(
  readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'components', 'ResourcePackageImportDialog.tsx'),
    'utf8',
  ),
)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  navigateSpy.mockReset()
})

const preview: pkgApi.PackagePreview = {
  importId: 'imp-1',
  previewToken: 'TOKEN-AS-ISSUED',
  expiresAt: Date.now() + 30 * 60_000,
  root: { slug: 'mcp-tools', type: 'mcp', name: 'tools' },
  humanMembers: [],
  secrets: [{ resourceType: 'mcp', resourceName: 'tools', field: 'config.headers.Authorization' }],
  requirements: {
    runtimes: [],
    codeHosts: [],
    executables: [],
    pluginSources: [],
    projectSkills: [],
    mcpKinds: [],
    humanMembers: [],
  },
  entries: [
    {
      localSlug: 'mcp-tools',
      type: 'mcp',
      name: 'tools',
      suggestedName: 'tools-2',
      allowedActions: ['new', 'reuse'],
      defaultAction: 'reuse',
      missingPermissions: [],
      secretFields: [
        { resourceType: 'mcp', resourceName: 'tools', field: 'config.headers.Authorization' },
      ],
      candidates: [
        { id: 'M-mine', name: 'tools', expect: { expectedConfigHash: 'H' }, owned: true },
        { id: 'M-theirs', name: 'tools', expect: { expectedConfigHash: 'H2' }, owned: false },
      ],
    },
  ],
}

async function openWithPreview(
  nextPreview: pkgApi.PackagePreview = preview,
  expectedRootType?: pkgApi.ResourcePackageType,
  onClose: () => void = () => {},
): Promise<void> {
  vi.spyOn(pkgApi, 'previewResourcePackage').mockResolvedValue(nextPreview)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <ResourcePackageImportDialog open onClose={onClose} expectedRootType={expectedRootType} />
    </QueryClientProvider>,
  )
  const input = await screen.findByTestId('package-import-file')
  const file = new File([new Uint8Array([1, 2, 3])], 'pkg.zip', { type: 'application/zip' })
  fireEvent.change(input, { target: { files: [file] } })
  expect(pkgApi.previewResourcePackage).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('package-import-preview'))
}

describe('① 零自写 chrome —— 全部走公共组件', () => {
  test('不新写 modal chrome / 原生下拉 / 自写错误盒', () => {
    expect(SRC).not.toMatch(/__overlay/)
    expect(SRC).not.toMatch(/__panel/)
    // 原生 `<select>` 的弹层无法与周围 UI 对齐，公共 `<Select>` 才有键盘与 a11y。
    expect(SRC).not.toMatch(/<select[\s>]/)
    expect(SRC).not.toMatch(/className="error-box"/)
  })

  test('用的是 Dialog / FileDropzone / Segmented / Select 与公共状态组件', () => {
    for (const name of [
      'Dialog',
      'FileDropzone',
      'Segmented',
      'Select',
      'Field',
      'TextInput',
      'StatusChip',
      'ErrorBanner',
      'EmptyState',
      'LoadingState',
    ]) {
      expect(SRC).toContain(
        `components/${name === 'Field' || name === 'TextInput' ? 'Form' : name}'`,
      )
    }
    expect(SRC).not.toContain('type="file"')
  })
})

describe('② 交互契约', () => {
  test('合法 builtin root 即使 entries=[] 也以 decisions=[] 提交并处理 receipt/open root', async () => {
    const builtinPreview: pkgApi.PackagePreview = {
      ...preview,
      root: { slug: 'builtin-code-reviewer', type: 'agent', name: 'builtin:code-reviewer' },
      entries: [],
      humanMembers: [],
      secrets: [],
    }
    const commit = vi.spyOn(pkgApi, 'commitResourcePackage').mockResolvedValue({
      journalId: 'J-builtin-root',
      applied: [],
      root: {
        resourceType: 'agent',
        resourceId: 'builtin:code-reviewer',
        name: 'builtin:code-reviewer',
        action: 'reuse',
      },
    })
    await openWithPreview(builtinPreview, 'agent')

    const submit = await screen.findByTestId('package-import-commit')
    expect((submit as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(submit)

    expect(await screen.findByTestId('package-import-report')).toBeTruthy()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]?.[2]).toEqual([])
    expect(commit.mock.calls[0]?.[3]).toEqual([])
    expect(commit.mock.calls[0]?.[4]).toEqual([])
    fireEvent.click(screen.getByTestId('package-import-open-root'))
    expect(navigateSpy).toHaveBeenCalledWith({
      to: '/agents/$id',
      params: { id: 'builtin:code-reviewer' },
    })
  })

  test('多候选默认复用方式，但必须显式选择目标', async () => {
    await openWithPreview()
    const target = await screen.findByTestId('package-target-mcp-tools')
    expect(screen.queryByTestId('package-name-mcp-tools')).toBeNull()
    expect(screen.queryByTestId('package-import-secrets')).toBeNull()
    expect(target.textContent).toContain('Choose a resource')
    expect((screen.getByTestId('package-import-commit') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(target)
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })

  test('切到「新建」才出改名框，且预填建议名', async () => {
    await openWithPreview()
    fireEvent.click(await screen.findByTestId('package-action-mcp-tools-new'))
    const input = (await screen.findByTestId('package-name-mcp-tools')) as HTMLInputElement
    expect(input.value).toBe('tools-2')
  })

  test('来回比较导入方式不会丢掉已输入名字或已选目标', async () => {
    await openWithPreview()
    fireEvent.click(await screen.findByTestId('package-action-mcp-tools-new'))
    fireEvent.change(screen.getByTestId('package-name-mcp-tools'), {
      target: { value: 'my-tools-copy' },
    })
    fireEvent.click(screen.getByTestId('package-action-mcp-tools-reuse'))
    fireEvent.click(screen.getByTestId('package-target-mcp-tools'))
    fireEvent.mouseDown(await screen.findByRole('option', { name: /tools · M-mine/ }))

    fireEvent.click(screen.getByTestId('package-action-mcp-tools-new'))
    expect((screen.getByTestId('package-name-mcp-tools') as HTMLInputElement).value).toBe(
      'my-tools-copy',
    )
    fireEvent.click(screen.getByTestId('package-action-mcp-tools-reuse'))
    expect(screen.getByTestId('package-target-mcp-tools').textContent).toContain('M-mine')
  })

  test('预检后的换包或移除必须先确认，不会误清空全部选择', async () => {
    await openWithPreview()
    fireEvent.click(await screen.findByTestId('package-action-mcp-tools-new'))
    fireEvent.change(screen.getByTestId('package-name-mcp-tools'), {
      target: { value: 'keep-this-name' },
    })

    fireEvent.click(screen.getByTestId('package-import-file-remove'))
    expect(await screen.findByText('Discard these import choices?')).toBeTruthy()
    expect(screen.getByText(/Removing this package clears/)).toBeTruthy()
    expect((screen.getByTestId('package-name-mcp-tools') as HTMLInputElement).value).toBe(
      'keep-this-name',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect((screen.getByTestId('package-name-mcp-tools') as HTMLInputElement).value).toBe(
      'keep-this-name',
    )

    fireEvent.click(screen.getByTestId('package-import-file-remove'))
    fireEvent.click(screen.getByRole('button', { name: 'Discard choices' }))
    await waitFor(() => expect(screen.queryByTestId('package-name-mcp-tools')).toBeNull())
    expect((screen.getByTestId('package-import-preview') as HTMLButtonElement).disabled).toBe(true)
  })

  test('脱敏提示会告诉用户「导入后要重新填」', async () => {
    await openWithPreview()
    fireEvent.click(await screen.findByTestId('package-action-mcp-tools-new'))
    expect((await screen.findByTestId('package-import-secrets')).textContent).toContain('1')
    expect(screen.getByTestId('package-secret-0').getAttribute('type')).toBe('password')
  })

  test('必填凭据会阻止提交；可选留空会按字段进入导入报告', async () => {
    const commit = vi.spyOn(pkgApi, 'commitResourcePackage').mockResolvedValue({
      journalId: 'J-secret',
      applied: [],
      skippedSecrets: [
        { resourceType: 'mcp', resourceName: 'tools', field: 'config.headers.Authorization' },
      ],
    })
    await openWithPreview()
    fireEvent.click(await screen.findByTestId('package-action-mcp-tools-new'))
    fireEvent.click(screen.getByTestId('package-import-commit'))
    expect((await screen.findByTestId('package-import-skipped-secrets')).textContent).toContain(
      'config.headers.Authorization',
    )
    expect(commit.mock.calls[0]?.[4]).toEqual([
      {
        resourceType: 'mcp',
        resourceName: 'tools',
        field: 'config.headers.Authorization',
        value: '',
      },
    ])

    cleanup()
    vi.mocked(pkgApi.previewResourcePackage).mockClear()
    await openWithPreview({
      ...preview,
      secrets: [{ resourceType: 'mcp', resourceName: 'tools', field: 'config.url' }],
      entries: [
        {
          ...preview.entries[0]!,
          secretFields: [{ resourceType: 'mcp', resourceName: 'tools', field: 'config.url' }],
        },
      ],
    })
    fireEvent.click(await screen.findByTestId('package-action-mcp-tools-new'))
    const submit = screen.getByTestId('package-import-commit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('package-secret-0'), {
      target: { value: 'https://token@example.test/mcp' },
    })
    expect(submit.disabled).toBe(false)
  })

  test('无可用动作时显示权限缺口，且不会激活该资源的凭据或 human 映射', async () => {
    const blockedSecret: pkgApi.PackageSecretRef = {
      resourceType: 'workgroup',
      resourceName: 'Review team',
      field: 'spec',
    }
    await openWithPreview({
      ...preview,
      root: { slug: 'review-team', type: 'workgroup', name: 'Review team' },
      secrets: [blockedSecret],
      humanMembers: [
        {
          workgroupSlug: 'review-team',
          username: 'alice',
          displayName: 'reviewer',
          suggestedUserId: null,
          required: true,
        },
      ],
      entries: [
        {
          ...preview.entries[0]!,
          localSlug: 'review-team',
          type: 'workgroup',
          name: 'Review team',
          suggestedName: 'Review team',
          allowedActions: [],
          defaultAction: null,
          missingPermissions: ['workgroups:create'],
          secretFields: [blockedSecret],
        },
      ],
    })
    expect(
      (await screen.findByTestId('package-permission-blocked-review-team')).textContent,
    ).toContain('workgroups:create')
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.queryByTestId('package-import-secrets')).toBeNull()
    expect(screen.queryByText('Map human members')).toBeNull()
    expect((screen.getByTestId('package-import-commit') as HTMLButtonElement).disabled).toBe(true)
  })

  test('配置包根类型与当前创建页不符时明确说明后续去向', async () => {
    await openWithPreview(
      {
        ...preview,
        root: { slug: 'review-team', type: 'workgroup', name: 'Review team' },
        secrets: [],
        entries: [
          {
            ...preview.entries[0]!,
            localSlug: 'review-team',
            type: 'workgroup',
            name: 'Review team',
            suggestedName: 'Review team',
            candidates: [],
            allowedActions: ['new'],
            defaultAction: 'new',
            secretFields: [],
          },
        ],
      },
      'agent',
    )
    expect((await screen.findByTestId('package-import-root-mismatch')).textContent).toContain(
      'Workgroup',
    )
    expect(screen.getByTestId('package-import-root-mismatch').textContent).toContain('Agent')
  })

  test('预检会展示包未携带的运行前提，而不是等运行时才暴露', async () => {
    await openWithPreview({
      ...preview,
      requirements: {
        runtimes: ['opencode'],
        codeHosts: ['gitlab'],
        executables: ['acme-tool'],
        pluginSources: [{ name: 'lint', spec: '@acme/lint', sourceKind: 'npm' }],
        projectSkills: [],
        mcpKinds: [],
        humanMembers: [],
      },
    })
    expect(await screen.findByText('Required on this instance')).toBeTruthy()
    expect(screen.getByText('opencode')).toBeTruthy()
    expect(screen.getByText('gitlab')).toBeTruthy()
    expect(screen.getByText('acme-tool')).toBeTruthy()
    expect(screen.getByText(/lint · npm · @acme\/lint/)).toBeTruthy()
  })

  test('提交时 previewToken **原样回传**，decisions 是当前选择', async () => {
    const commit = vi
      .spyOn(pkgApi, 'commitResourcePackage')
      .mockResolvedValue({ journalId: 'J', applied: [] })
    await openWithPreview()
    fireEvent.click(await screen.findByTestId('package-target-mcp-tools'))
    fireEvent.mouseDown(await screen.findByRole('option', { name: /tools · M-mine/ }))
    fireEvent.click(await screen.findByTestId('package-import-commit'))
    await screen.findByTestId('package-import-report')

    expect(commit).toHaveBeenCalledTimes(1)
    const [, passedPreview, decisions] = commit.mock.calls[0]!
    // 前端不解读、不重算 token —— 改了任何一项都会在服务端对不上。
    expect(passedPreview.previewToken).toBe('TOKEN-AS-ISSUED')
    expect(decisions).toEqual([{ localSlug: 'mcp-tools', action: 'reuse', targetId: 'M-mine' }])
  })

  test('同一来源账号的多个成员名称只映射一次；可选成员可明确不导入', async () => {
    const lookupMock = vi.spyOn(api, 'post').mockResolvedValue([
      {
        id: 'U-alice',
        username: 'alice',
        displayName: 'Alice Wang',
        role: 'user',
        status: 'active',
      },
    ] as never)
    const commit = vi
      .spyOn(pkgApi, 'commitResourcePackage')
      .mockResolvedValue({ journalId: 'J-human', applied: [] })
    await openWithPreview({
      ...preview,
      entries: [
        {
          ...preview.entries[0]!,
          localSlug: 'review-team',
          type: 'workgroup',
          name: 'Review team',
          suggestedName: 'Review team',
          allowedActions: ['new'],
          defaultAction: 'new',
          missingPermissions: [],
          secretFields: [],
          candidates: [],
        },
      ],
      humanMembers: [
        {
          workgroupSlug: 'review-team',
          username: 'alice',
          displayName: 'lead',
          suggestedUserId: 'U-alice',
          required: false,
        },
        {
          workgroupSlug: 'review-team',
          username: 'alice',
          displayName: 'reviewer',
          suggestedUserId: 'U-alice',
          required: false,
        },
        {
          workgroupSlug: 'review-team',
          username: 'bob',
          displayName: 'observer',
          suggestedUserId: null,
          required: false,
        },
      ],
    })

    expect(await screen.findByText('Alice Wang · @alice')).toBeTruthy()
    expect(screen.getByText(/member names lead, reviewer/)).toBeTruthy()
    expect(screen.getAllByText(/Workgroup Review team/)).toHaveLength(2)
    expect(screen.getByTestId('package-human-action-0-skip')).toBeTruthy()
    expect(lookupMock).toHaveBeenCalledTimes(1)
    expect(lookupMock.mock.calls[0]?.[0]).toBe('/api/users/lookup')
    const submit = screen.getByTestId('package-import-commit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.click(screen.getByTestId('package-human-action-1-skip'))
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    await screen.findByTestId('package-import-report')

    expect(commit.mock.calls[0]?.[3]).toEqual([
      { workgroupSlug: 'review-team', username: 'alice', userId: 'U-alice' },
      { workgroupSlug: 'review-team', username: 'bob', userId: null },
    ])
  })

  test('晚到的建议用户不阻塞预览，也不会覆盖用户明确清空的映射', async () => {
    let resolveLookup!: (users: unknown[]) => void
    const lookupPromise = new Promise<unknown[]>((resolve) => {
      resolveLookup = resolve
    })
    vi.spyOn(api, 'post').mockReturnValue(lookupPromise as never)

    await openWithPreview({
      ...preview,
      entries: [
        {
          ...preview.entries[0]!,
          localSlug: 'review-team',
          type: 'workgroup',
          name: 'Review team',
          suggestedName: 'Review team',
          allowedActions: ['new'],
          defaultAction: 'new',
          missingPermissions: [],
          secretFields: [],
          candidates: [],
        },
      ],
      humanMembers: [
        {
          workgroupSlug: 'review-team',
          username: 'alice',
          displayName: 'reviewer',
          suggestedUserId: 'U-alice',
          required: false,
        },
      ],
    })

    // The mapping screen is already interactive while lookup is unresolved.
    const skip = await screen.findByTestId('package-human-action-0-skip')
    fireEvent.click(skip)
    fireEvent.click(screen.getByTestId('package-human-action-0-map'))
    expect((screen.getByTestId('package-import-commit') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      resolveLookup([
        {
          id: 'U-alice',
          username: 'alice',
          displayName: 'Alice Wang',
          role: 'user',
          status: 'active',
        },
      ])
      await lookupPromise
    })
    await waitFor(() => expect(screen.queryByText('Alice Wang · @alice')).toBeNull())
    expect((screen.getByTestId('package-import-commit') as HTMLButtonElement).disabled).toBe(true)
  })

  test('复用已有工作组时不要求也不提交不会生效的 human 映射', async () => {
    const commit = vi
      .spyOn(pkgApi, 'commitResourcePackage')
      .mockResolvedValue({ journalId: 'J-reuse', applied: [] })
    await openWithPreview({
      ...preview,
      entries: [
        {
          localSlug: 'review-team',
          type: 'workgroup',
          name: 'Review team',
          suggestedName: 'Review team 2',
          allowedActions: ['new', 'reuse'],
          defaultAction: 'reuse',
          missingPermissions: [],
          secretFields: [],
          candidates: [
            { id: 'WG-local', name: 'Local review team', expect: { version: 1 }, owned: true },
          ],
        },
      ],
      humanMembers: [
        {
          workgroupSlug: 'review-team',
          username: 'alice',
          displayName: 'reviewer',
          suggestedUserId: null,
          required: false,
        },
      ],
    })

    const submit = await screen.findByTestId('package-import-commit')
    expect(screen.queryByText('Map human members')).toBeNull()
    expect((submit as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(submit)
    await screen.findByTestId('package-import-report')
    expect(commit.mock.calls[0]?.[3]).toEqual([])
  })

  test('提交结果未知时冻结决策和凭据、锁住 Dialog，并保留同一幂等会话', async () => {
    const onClose = vi.fn()
    vi.spyOn(pkgApi, 'commitResourcePackage').mockRejectedValue(new Error('network response lost'))
    await openWithPreview(preview, undefined, onClose)
    fireEvent.click(await screen.findByTestId('package-action-mcp-tools-new'))
    fireEvent.click(screen.getByTestId('package-import-commit'))

    expect(await screen.findByTestId('package-import-retry-notice')).toBeTruthy()
    expect((screen.getByTestId('package-action-mcp-tools-new') as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(
      (screen.getByTestId('package-action-mcp-tools-reuse') as HTMLButtonElement).disabled,
    ).toBe(true)
    expect((screen.getByTestId('package-name-mcp-tools') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByTestId('package-secret-0') as HTMLInputElement).disabled).toBe(true)
    const closeButtons = screen.getAllByRole('button', { name: 'Close' }) as HTMLButtonElement[]
    expect(closeButtons.length).toBeGreaterThanOrEqual(2)
    expect(closeButtons.every((button) => button.disabled)).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    const fileInput = screen.getByTestId('package-import-file') as HTMLInputElement
    const replace = screen.getByTestId('package-import-file-button') as HTMLButtonElement
    const remove = screen.getByTestId('package-import-file-remove') as HTMLButtonElement
    expect(fileInput.disabled).toBe(true)
    expect(replace.disabled).toBe(true)
    expect(remove.disabled).toBe(true)
    fireEvent.click(replace)
    fireEvent.click(remove)
    expect(screen.queryByText(/ends the current idempotency session/)).toBeNull()
    expect(screen.getByText('pkg.zip')).toBeTruthy()
  })

  test('bundle-apply-unsettled 锁住同一 importId/preview/决策并只允许原样重试', async () => {
    const onClose = vi.fn()
    const unsettledPreview: pkgApi.PackagePreview = {
      ...preview,
      entries: [{ ...preview.entries[0]!, candidates: [preview.entries[0]!.candidates[0]!] }],
    }
    const commit = vi
      .spyOn(pkgApi, 'commitResourcePackage')
      .mockRejectedValueOnce(
        new ApiError(409, 'bundle-apply-unsettled', 'the journal is still converging'),
      )
      .mockResolvedValueOnce({ journalId: 'J-converged', applied: [] })
    await openWithPreview(unsettledPreview, undefined, onClose)
    fireEvent.click(await screen.findByTestId('package-import-commit'))

    expect(await screen.findByTestId('package-import-retry-notice')).toBeTruthy()
    expect(screen.queryByTestId('package-import-repreview-notice')).toBeNull()
    expect((screen.getByTestId('package-import-file') as HTMLInputElement).disabled).toBe(true)
    expect(
      (screen.getByTestId('package-action-mcp-tools-reuse') as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      screen
        .getAllByRole('button', { name: 'Close' })
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    const firstAttempt = commit.mock.calls[0]!.slice(0, 5)
    fireEvent.click(screen.getByTestId('package-import-commit'))
    await screen.findByTestId('package-import-report')
    expect(commit).toHaveBeenCalledTimes(2)
    expect(commit.mock.calls[1]!.slice(0, 5)).toEqual(firstAttempt)
    expect(commit.mock.calls[1]?.[1]).toMatchObject({
      importId: 'imp-1',
      previewToken: 'TOKEN-AS-ISSUED',
    })
  })

  test.each(['bundle-apply-failed-replay', 'bundle-baseline-stale'])(
    '%s 要求重新预检，不能原样重提旧基线',
    async (code) => {
      vi.spyOn(pkgApi, 'commitResourcePackage').mockRejectedValue(
        new ApiError(409, code, 'the persisted apply cannot be replayed from this baseline'),
      )
      await openWithPreview({
        ...preview,
        entries: [{ ...preview.entries[0]!, candidates: [preview.entries[0]!.candidates[0]!] }],
      })
      fireEvent.click(await screen.findByTestId('package-import-commit'))

      expect(await screen.findByTestId('package-import-repreview-notice')).toBeTruthy()
      expect(screen.queryByTestId('package-import-retry-notice')).toBeNull()
      expect((screen.getByTestId('package-import-commit') as HTMLButtonElement).disabled).toBe(true)
    },
  )

  test('提交结果未知时 human 映射也冻结，只允许原样重试', async () => {
    vi.spyOn(pkgApi, 'commitResourcePackage').mockRejectedValue(new Error('response lost'))
    await openWithPreview({
      ...preview,
      root: { slug: 'review-team', type: 'workgroup', name: 'Review team' },
      secrets: [],
      entries: [
        {
          ...preview.entries[0]!,
          localSlug: 'review-team',
          type: 'workgroup',
          name: 'Review team',
          suggestedName: 'Review team',
          allowedActions: ['new'],
          defaultAction: 'new',
          secretFields: [],
          candidates: [],
        },
      ],
      humanMembers: [
        {
          workgroupSlug: 'review-team',
          username: 'alice',
          displayName: 'reviewer',
          suggestedUserId: null,
          required: false,
        },
      ],
    })

    fireEvent.click(await screen.findByTestId('package-human-action-0-skip'))
    fireEvent.click(screen.getByTestId('package-import-commit'))
    expect(await screen.findByTestId('package-import-retry-notice')).toBeTruthy()
    expect((screen.getByTestId('package-human-action-0-map') as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByTestId('package-human-action-0-skip') as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  test('预检过期后重新检查同一文件，并保留仍然有效的资源选择', async () => {
    const commit = vi
      .spyOn(pkgApi, 'commitResourcePackage')
      .mockRejectedValueOnce(
        new ApiError(409, 'package-preview-expired', 'package preview expired; preview again'),
      )
      .mockResolvedValueOnce({ journalId: 'J-fresh', applied: [] })
    await openWithPreview()
    fireEvent.click(await screen.findByTestId('package-target-mcp-tools'))
    fireEvent.mouseDown(await screen.findByRole('option', { name: /tools · M-mine/ }))
    fireEvent.click(screen.getByTestId('package-import-commit'))

    expect(await screen.findByTestId('package-import-repreview-notice')).toBeTruthy()
    expect(screen.queryByTestId('package-import-retry-notice')).toBeNull()
    expect((screen.getByTestId('package-import-commit') as HTMLButtonElement).disabled).toBe(true)
    vi.mocked(pkgApi.previewResourcePackage).mockResolvedValueOnce({
      ...preview,
      previewToken: 'TOKEN-REFRESHED',
      expiresAt: Date.now() + 30 * 60_000,
    })
    fireEvent.click(screen.getByTestId('package-import-repreview'))
    await waitFor(() => expect(pkgApi.previewResourcePackage).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.getByTestId('package-target-mcp-tools').textContent).toContain('M-mine'),
    )

    fireEvent.click(screen.getByTestId('package-import-commit'))
    await screen.findByTestId('package-import-report')
    expect(commit.mock.calls[1]?.[1]).toMatchObject({ previewToken: 'TOKEN-REFRESHED' })
  })

  test('重新预检发现 overwrite 候选基线变化时清除覆盖并提示重新确认', async () => {
    const overwritePreview: pkgApi.PackagePreview = {
      ...preview,
      secrets: [],
      entries: [
        {
          ...preview.entries[0]!,
          allowedActions: ['new', 'reuse', 'overwrite'],
          secretFields: [],
          candidates: [
            {
              id: 'M-mine',
              name: 'tools',
              expect: { expectedConfigHash: 'H1' },
              owned: true,
            },
          ],
        },
      ],
    }
    vi.spyOn(pkgApi, 'commitResourcePackage').mockRejectedValue(
      new ApiError(409, 'package-selected-target-changed', 'target changed; preview again'),
    )
    await openWithPreview(overwritePreview)
    fireEvent.click(await screen.findByTestId('package-action-mcp-tools-overwrite'))
    fireEvent.click(screen.getByTestId('package-import-commit'))
    expect(await screen.findByTestId('package-import-repreview-notice')).toBeTruthy()

    vi.mocked(pkgApi.previewResourcePackage).mockResolvedValueOnce({
      ...overwritePreview,
      previewToken: 'TOKEN-H2',
      entries: [
        {
          ...overwritePreview.entries[0]!,
          candidates: [
            {
              id: 'M-mine',
              name: 'tools',
              expect: { expectedConfigHash: 'H2' },
              owned: true,
            },
          ],
        },
      ],
    })
    fireEvent.click(screen.getByTestId('package-import-repreview'))

    expect((await screen.findByTestId('package-import-overwrite-reset')).textContent).toContain(
      'tools',
    )
    expect(
      screen.getByTestId('package-action-mcp-tools-overwrite').getAttribute('aria-checked'),
    ).toBe('false')
    expect(screen.getByTestId('package-action-mcp-tools-reuse').getAttribute('aria-checked')).toBe(
      'true',
    )
  })

  test('overwrite expect 仅键序不同仍视为同一 canonical 基线并保留选择', async () => {
    const overwritePreview: pkgApi.PackagePreview = {
      ...preview,
      secrets: [],
      entries: [
        {
          ...preview.entries[0]!,
          allowedActions: ['new', 'reuse', 'overwrite'],
          secretFields: [],
          candidates: [
            {
              id: 'M-mine',
              name: 'tools',
              expect: { expectedUpdatedAt: 10, expectedAclRevision: 2 },
              owned: true,
            },
          ],
        },
      ],
    }
    vi.spyOn(pkgApi, 'commitResourcePackage').mockRejectedValue(
      new ApiError(409, 'package-selected-target-changed', 'target changed; preview again'),
    )
    await openWithPreview(overwritePreview)
    fireEvent.click(await screen.findByTestId('package-action-mcp-tools-overwrite'))
    fireEvent.click(screen.getByTestId('package-import-commit'))
    await screen.findByTestId('package-import-repreview-notice')

    vi.mocked(pkgApi.previewResourcePackage).mockResolvedValueOnce({
      ...overwritePreview,
      previewToken: 'TOKEN-CANONICAL',
      entries: [
        {
          ...overwritePreview.entries[0]!,
          candidates: [
            {
              id: 'M-mine',
              name: 'tools',
              expect: { expectedAclRevision: 2, expectedUpdatedAt: 10 },
              owned: true,
            },
          ],
        },
      ],
    })
    fireEvent.click(screen.getByTestId('package-import-repreview'))

    await waitFor(() =>
      expect(
        screen.getByTestId('package-action-mcp-tools-overwrite').getAttribute('aria-checked'),
      ).toBe('true'),
    )
    expect(screen.queryByTestId('package-import-overwrite-reset')).toBeNull()
  })

  test('写权限在提交前被撤销时必须重新预检，不能直接重提旧决策', async () => {
    vi.spyOn(pkgApi, 'commitResourcePackage').mockRejectedValue(
      new ApiError(403, 'package-write-forbidden', 'write permission changed; preview again'),
    )
    await openWithPreview()
    fireEvent.click(await screen.findByTestId('package-target-mcp-tools'))
    fireEvent.mouseDown(await screen.findByRole('option', { name: /tools · M-mine/ }))
    fireEvent.click(screen.getByTestId('package-import-commit'))

    expect(await screen.findByTestId('package-import-repreview-notice')).toBeTruthy()
    expect(screen.queryByTestId('package-import-retry-notice')).toBeNull()
    expect((screen.getByTestId('package-import-commit') as HTMLButtonElement).disabled).toBe(true)
  })

  test('根类型不匹配的自动打开会先释放 busy，再同步清 dirty', async () => {
    const mismatchPreview: pkgApi.PackagePreview = {
      ...preview,
      root: { slug: 'review-team', type: 'workgroup', name: 'Review team' },
      secrets: [],
      entries: [
        {
          ...preview.entries[0]!,
          localSlug: 'review-team',
          type: 'workgroup',
          name: 'Review team',
          suggestedName: 'Review team',
          allowedActions: ['new'],
          defaultAction: 'new',
          secretFields: [],
          candidates: [],
        },
      ],
    }
    vi.spyOn(pkgApi, 'previewResourcePackage').mockResolvedValue(mismatchPreview)
    vi.spyOn(pkgApi, 'commitResourcePackage').mockResolvedValue({
      journalId: 'J-root',
      applied: [],
      root: {
        resourceType: 'workgroup',
        resourceId: 'WG-review-team',
        name: 'Review team',
        action: 'create',
      },
    })
    let busy = false
    const events: string[] = []
    const prepareAutoOpen = vi.fn(() => {
      events.push(`prepare:${busy ? 'busy' : 'idle'}`)
      return false
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <ResourcePackageImportPanel
          expectedRootType="agent"
          beginCommitBusy={() => {
            busy = true
            events.push('busy:on')
            return () => {
              busy = false
              events.push('busy:off')
            }
          }}
          onDirtyChange={(dirty) => events.push(`dirty:${dirty ? 'yes' : 'no'}`)}
          prepareAutoOpen={prepareAutoOpen}
        />
      </QueryClientProvider>,
    )
    const file = new File(['zip'], 'pkg.zip', { type: 'application/zip' })
    fireEvent.change(await screen.findByTestId('package-import-file'), {
      target: { files: [file] },
    })
    fireEvent.click(screen.getByTestId('package-import-preview'))
    fireEvent.click(await screen.findByTestId('package-import-commit'))

    expect(await screen.findByTestId('package-import-report')).toBeTruthy()
    expect(prepareAutoOpen).toHaveBeenCalledTimes(1)
    const prepareIndex = events.indexOf('prepare:idle')
    expect(events.indexOf('busy:off')).toBeLessThan(prepareIndex)
    expect(events.slice(0, prepareIndex)).toContain('dirty:no')
  })

  test('multipart 精确序列化 humanMemberMappings 契约', async () => {
    const postMultipart = vi
      .spyOn(api, 'postMultipart')
      .mockResolvedValue({ journalId: 'J-transport', applied: [] } as never)
    const mappings: pkgApi.HumanMemberMapping[] = [
      { workgroupSlug: 'review-team', username: 'alice', userId: 'U-alice' },
      { workgroupSlug: 'review-team', username: 'bob', userId: null },
    ]
    const secrets: pkgApi.PackageSecretInput[] = [
      {
        resourceType: 'mcp',
        resourceName: 'tools',
        field: 'config.headers.Authorization',
        value: 'Bearer local-token',
      },
    ]
    await pkgApi.commitResourcePackage(
      new File(['zip'], 'pkg.zip', { type: 'application/zip' }),
      { previewToken: 'TOKEN-AS-ISSUED' },
      [{ localSlug: 'review-team', action: 'new', finalName: 'Review Team' }],
      mappings,
      secrets,
    )

    expect(postMultipart.mock.calls[0]?.[0]).toBe('/api/resource-packages/commit')
    const form = postMultipart.mock.calls[0]?.[1] as FormData
    expect(form.get('previewToken')).toBe('TOKEN-AS-ISSUED')
    expect(JSON.parse(String(form.get('humanMemberMappings')))).toEqual(mappings)
    expect(JSON.parse(String(form.get('secretInputs')))).toEqual(secrets)
  })
})
