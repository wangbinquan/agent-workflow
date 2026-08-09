// RFC-271 T35 —— 导出按钮（六类共用的公共组件）。
//
// 两条要害：
//  ① 文件名走 `resourcePackageFilename`——中文名不该被打成一串下划线，但也不能带
//     文件系统真的会拒绝的字符。
//  ② **导出失败是预期内的产品行为**（闭包里有你看不见的资源 ⇒ 整体拒绝，AC-7），
//     所以服务端那句可读的原因必须交回页面，不能吞掉或换成通用错误。

import { describe, expect, test, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResourcePackageExportButton } from '../src/components/ResourcePackageExportButton'
import { ResourceActionList } from '../src/components/ResourceActionList'
import * as pkgApi from '../src/api/resourcePackages'
import * as dl from '../src/lib/resource-package-download'
import { resourcePackageFilename, safeDownloadBaseName } from '../src/lib/resource-package-download'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('① 文件名清洗', () => {
  test('保留中文与常见字符，只替换文件系统会拒绝的那些', () => {
    expect(safeDownloadBaseName('代码审计', 'x')).toBe('代码审计')
    expect(safeDownloadBaseName('a/b:c*d?e"f<g>h|i', 'x')).toBe('a-b-c-d-e-f-g-h-i')
  })

  test('Windows 拒绝结尾的点或空格', () => {
    expect(safeDownloadBaseName('report. ', 'x')).toBe('report')
  })

  test('清洗后为空 ⇒ 用兜底名（不产出一个没有主名的文件）', () => {
    expect(safeDownloadBaseName('', 'workflow')).toBe('workflow')
    expect(safeDownloadBaseName('   ', 'workflow')).toBe('workflow')
  })

  test('分隔符**变成横杠而不是消失** —— `///` 不该退化成兜底名', () => {
    // 这条把上一条的边界钉住：只有真正归一成空才用兜底，否则用户还能从文件名里
    // 认出原来的资源。
    expect(safeDownloadBaseName('///', 'workflow')).toBe('---')
  })

  test('完整文件名带类型前缀与 .awpkg.zip 后缀', () => {
    expect(resourcePackageFilename('workflow', '代码审计')).toBe('workflow-代码审计.awpkg.zip')
  })
})

describe('② 行为', () => {
  test('点击后调下载，并按类型+名字命名', async () => {
    const download = vi
      .spyOn(pkgApi, 'downloadResourcePackage')
      .mockResolvedValue(new Blob([new Uint8Array([1])]))
    // ⚠️ 必须挡掉真实的 `<a download>` click：happy-dom 会把它当成一次导航，
    // teardown 里的 `history.replaceState` 随之炸掉——失败点会出现在 setup.ts，
    // 与被测组件毫无关系，极难定位。这里断言的是「用什么文件名下载」，触发动作
    // 本身由 `triggerBlobDownload` 自己负责。
    const trigger = vi.spyOn(dl, 'triggerBlobDownload').mockImplementation(() => {})
    render(<ResourcePackageExportButton type="workflow" id="W1" name="audit" />)
    fireEvent.click(screen.getByTestId('export-package-workflow'))
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    expect(download.mock.calls[0]?.[0]).toBe('workflow')
    expect(download.mock.calls[0]?.[1]).toBe('W1')
    expect(download.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal)
    await waitFor(() => expect(trigger).toHaveBeenCalledTimes(1))
    expect(trigger.mock.calls[0]?.[1]).toBe('workflow-audit.awpkg.zip')
  })

  test('失败时把**服务端那句话**交回页面，不吞、不换成通用错误', async () => {
    vi.spyOn(pkgApi, 'downloadResourcePackage').mockRejectedValue(
      new Error("cannot export: agent:A references mcp 'M', which is not available to you"),
    )
    const onError = vi.fn()
    render(<ResourcePackageExportButton type="workflow" id="W1" name="audit" onError={onError} />)
    fireEvent.click(screen.getByTestId('export-package-workflow'))
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(String(onError.mock.calls[0]?.[0])).toContain('not available to you')
    expect(await screen.findByText(/not available to you/)).toBeTruthy()
  })

  test('More 动作形态复用统一 action item；未保存时解释原因且不发请求', () => {
    const download = vi.spyOn(pkgApi, 'downloadResourcePackage').mockResolvedValue(new Blob())
    render(
      <ResourcePackageExportButton
        type="plugin"
        id="P1"
        name="formatter"
        variant="action"
        disabled
        disabledReason="Save first"
      />,
    )
    const button = screen.getByTestId('export-package-plugin') as HTMLButtonElement
    expect(button.classList.contains('resource-action-list__item')).toBe(true)
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Save first')
    expect(button.querySelector('span')?.textContent).toBe('Save first')
    fireEvent.click(button)
    expect(download).not.toHaveBeenCalled()
  })

  test('More 导出 pending 时锁住整组动作并上报 busy，settle 后完整恢复', async () => {
    let release: (blob: Blob) => void = () => {}
    const download = vi.spyOn(pkgApi, 'downloadResourcePackage').mockReturnValue(
      new Promise<Blob>((resolve) => {
        release = resolve
      }),
    )
    vi.spyOn(dl, 'triggerBlobDownload').mockImplementation(() => {})
    const onBusyChange = vi.fn()
    render(
      <ResourceActionList onBusyChange={onBusyChange}>
        <ResourcePackageExportButton
          type="workgroup"
          id="WG1"
          name="review-team"
          variant="action"
        />
        <button type="button" data-testid="sibling-action">
          Sibling action
        </button>
      </ResourceActionList>,
    )

    const exportButton = screen.getByTestId('export-package-workgroup') as HTMLButtonElement
    const actionList = exportButton.closest('fieldset') as HTMLFieldSetElement
    fireEvent.click(exportButton)

    await waitFor(() => expect(actionList.disabled).toBe(true))
    expect(actionList.classList.contains('resource-action-list')).toBe(true)
    expect(actionList.getAttribute('aria-busy')).toBe('true')
    expect(onBusyChange).toHaveBeenCalledWith(true)
    expect(download).toHaveBeenCalledTimes(1)
    expect(download.mock.calls[0]?.[0]).toBe('workgroup')
    expect(download.mock.calls[0]?.[1]).toBe('WG1')
    expect(download.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal)

    release(new Blob([new Uint8Array([1])]))
    await waitFor(() => expect(actionList.disabled).toBe(false))
    expect(actionList.getAttribute('aria-busy')).toBeNull()
    expect(onBusyChange).toHaveBeenLastCalledWith(false)
  })

  test('进行中禁用，避免连点产出多份下载', async () => {
    let release: (b: Blob) => void = () => {}
    vi.spyOn(pkgApi, 'downloadResourcePackage').mockReturnValue(
      new Promise<Blob>((r) => {
        release = r
      }),
    )
    vi.spyOn(dl, 'triggerBlobDownload').mockImplementation(() => {})
    render(<ResourcePackageExportButton type="agent" id="A1" name="auditor" />)
    const btn = screen.getByTestId('export-package-agent') as HTMLButtonElement
    fireEvent.click(btn)
    await waitFor(() => expect(btn.disabled).toBe(true))
    expect(btn.getAttribute('aria-busy')).toBe('true')
    release(new Blob([new Uint8Array([1])]))
    await waitFor(() => expect(btn.disabled).toBe(false))
  })
})
