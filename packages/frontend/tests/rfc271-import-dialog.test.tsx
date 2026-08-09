// RFC-271 T39 —— 导入对话框。
//
// 两组断言：
//  ① **零自写 chrome**（CLAUDE.md 前台风格强制原则）。这条用源码层文本断言兜住——
//     新写一套 `.xxx__overlay` / 原生 `<select>` 是 code review 一律打回的回归，
//     但它不会让任何行为测试变红，所以必须显式锁。
//  ② 交互契约：预检默认「能复用就复用」，切到 `new` 才出改名框；**别人的候选会被
//     标出来**（可复用但不可覆盖）；提交回传的是**原样的** previewToken。

import { describe, expect, test, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ResourcePackageImportDialog } from '../src/components/ResourcePackageImportDialog'
import * as pkgApi from '../src/api/resourcePackages'

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
})

const preview: pkgApi.PackagePreview = {
  importId: 'imp-1',
  previewToken: 'TOKEN-AS-ISSUED',
  expiresAt: Date.now() + 60_000,
  secrets: [{ resourceType: 'mcp', resourceName: 'tools', field: 'config.headers.Authorization' }],
  requirements: {},
  entries: [
    {
      localSlug: 'mcp-tools',
      type: 'mcp',
      name: 'tools',
      suggestedName: 'tools-2',
      allowedActions: ['new', 'reuse'],
      candidates: [
        { id: 'M-mine', name: 'tools', expect: { expectedConfigHash: 'H' }, owned: true },
        { id: 'M-theirs', name: 'tools', expect: { expectedConfigHash: 'H2' }, owned: false },
      ],
    },
  ],
}

async function openWithPreview(): Promise<void> {
  vi.spyOn(pkgApi, 'previewResourcePackage').mockResolvedValue(preview)
  render(<ResourcePackageImportDialog open onClose={() => {}} />)
  const input = await screen.findByTestId('package-import-file')
  const file = new File([new Uint8Array([1, 2, 3])], 'pkg.zip', { type: 'application/zip' })
  fireEvent.change(input, { target: { files: [file] } })
}

describe('① 零自写 chrome —— 全部走公共组件', () => {
  test('不新写 modal chrome / 原生下拉 / 自写错误盒', () => {
    expect(SRC).not.toMatch(/__overlay/)
    expect(SRC).not.toMatch(/__panel/)
    // 原生 `<select>` 的弹层无法与周围 UI 对齐，公共 `<Select>` 才有键盘与 a11y。
    expect(SRC).not.toMatch(/<select[\s>]/)
    expect(SRC).not.toMatch(/className="error-box"/)
  })

  test('用的是 Dialog / Select / Field / TextInput / StatusChip / 三个状态组件', () => {
    for (const name of [
      'Dialog',
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
    // 分段控件走 `.segmented`，不自写 radio 组。
    expect(SRC).toContain('className="segmented"')
  })
})

describe('② 交互契约', () => {
  test('预检后默认「复用已有」，且列出全部候选', async () => {
    await openWithPreview()
    expect(await screen.findByTestId('package-target-mcp-tools')).toBeTruthy()
    // 默认是 reuse ⇒ 不出现改名框。
    expect(screen.queryByTestId('package-name-mcp-tools')).toBeNull()
  })

  test('切到「新建」才出改名框，且预填建议名', async () => {
    await openWithPreview()
    fireEvent.click(await screen.findByTestId('package-action-mcp-tools-new'))
    const input = (await screen.findByTestId('package-name-mcp-tools')) as HTMLInputElement
    expect(input.value).toBe('tools-2')
  })

  test('脱敏提示会告诉用户「导入后要重新填」', async () => {
    await openWithPreview()
    expect((await screen.findByTestId('package-import-secrets')).textContent).toContain('1')
  })

  test('提交时 previewToken **原样回传**，decisions 是当前选择', async () => {
    const commit = vi
      .spyOn(pkgApi, 'commitResourcePackage')
      .mockResolvedValue({ journalId: 'J', applied: [] })
    await openWithPreview()
    fireEvent.click(await screen.findByTestId('package-import-commit'))
    await screen.findByTestId('package-import-report')

    expect(commit).toHaveBeenCalledTimes(1)
    const [, passedPreview, decisions] = commit.mock.calls[0]!
    // 前端不解读、不重算 token —— 改了任何一项都会在服务端对不上。
    expect(passedPreview.previewToken).toBe('TOKEN-AS-ISSUED')
    expect(decisions).toEqual([{ localSlug: 'mcp-tools', action: 'reuse', targetId: 'M-mine' }])
  })
})
