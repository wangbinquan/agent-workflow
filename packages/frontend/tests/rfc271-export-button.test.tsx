// RFC-271 T35 —— 导出按钮（六类共用的公共组件）。
//
// 两条要害：
//  ① 文件名走 `resourcePackageFilename`——中文名不该被打成一串下划线，但也不能带
//     文件系统真的会拒绝的字符。
//  ② **导出失败是预期内的产品行为**（闭包里有你看不见的资源 ⇒ 整体拒绝，AC-7），
//     所以服务端那句可读的原因必须交回页面，不能吞掉或换成通用错误。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { api } from '../src/api/client'
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
    render(
      <ResourcePackageExportButton
        type="workflow"
        id="W1"
        name="audit"
        fence={{ expectedVersion: 7 }}
      />,
    )
    fireEvent.click(screen.getByTestId('export-package-workflow'))
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    expect(download.mock.calls[0]?.[0]).toBe('workflow')
    expect(download.mock.calls[0]?.[1]).toBe('W1')
    expect(download.mock.calls[0]?.[2]).toEqual({ expectedVersion: 7 })
    expect(download.mock.calls[0]?.[3]).toBeInstanceOf(AbortSignal)
    await waitFor(() => expect(trigger).toHaveBeenCalledTimes(1))
    expect(trigger.mock.calls[0]?.[1]).toBe('workflow-audit.awpkg.zip')
  })

  test('失败时把**服务端那句话**交回页面，不吞、不换成通用错误', async () => {
    vi.spyOn(pkgApi, 'downloadResourcePackage').mockRejectedValue(
      new Error("cannot export: agent:A references mcp 'M', which is not available to you"),
    )
    const onError = vi.fn()
    render(
      <ResourcePackageExportButton
        type="workflow"
        id="W1"
        name="audit"
        fence={{ expectedVersion: 7 }}
        onError={onError}
      />,
    )
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
        fence={{ expectedConfigHash: 'plugin-hash' }}
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
          fence={{ expectedVersion: 3 }}
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
    expect(download.mock.calls[0]?.[2]).toEqual({ expectedVersion: 3 })
    expect(download.mock.calls[0]?.[3]).toBeInstanceOf(AbortSignal)

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
    render(
      <ResourcePackageExportButton
        type="agent"
        id="A1"
        name="auditor"
        fence={{ expectedUpdatedAt: 11, expectedAclRevision: 2 }}
      />,
    )
    const btn = screen.getByTestId('export-package-agent') as HTMLButtonElement
    fireEvent.click(btn)
    await waitFor(() => expect(btn.disabled).toBe(true))
    expect(btn.getAttribute('aria-busy')).toBe('true')
    release(new Blob([new Uint8Array([1])]))
    await waitFor(() => expect(btn.disabled).toBe(false))
  })

  test('六类根资源的 exact-revision fence 原样进入下载 query', async () => {
    const getBlob = vi.spyOn(api, 'getBlob').mockResolvedValue(new Blob())

    await pkgApi.downloadResourcePackage('workflow', 'W1', { expectedVersion: 1 })
    await pkgApi.downloadResourcePackage('workgroup', 'WG1', { expectedVersion: 2 })
    await pkgApi.downloadResourcePackage('agent', 'A1', {
      expectedUpdatedAt: 3,
      expectedAclRevision: 4,
    })
    await pkgApi.downloadResourcePackage('skill', 'S1', {
      expectedContentVersion: 5,
      expectedMetaRevision: 6,
      expectedAclRevision: 7,
    })
    await pkgApi.downloadResourcePackage('mcp', 'M1', { expectedConfigHash: 'mcp-hash' })
    await pkgApi.downloadResourcePackage('plugin', 'P1', {
      expectedConfigHash: 'plugin-hash',
    })

    expect(getBlob.mock.calls.map(([path, query]) => [path, query])).toEqual([
      ['/api/workflows/W1/export-package', { expectedVersion: 1 }],
      ['/api/workgroups/WG1/export-package', { expectedVersion: 2 }],
      ['/api/agents/A1/export-package', { expectedUpdatedAt: 3, expectedAclRevision: 4 }],
      [
        '/api/skills/S1/export-package',
        { expectedContentVersion: 5, expectedMetaRevision: 6, expectedAclRevision: 7 },
      ],
      ['/api/mcps/M1/export-package', { expectedConfigHash: 'mcp-hash' }],
      ['/api/plugins/P1/export-package', { expectedConfigHash: 'plugin-hash' }],
    ])
  })
})

describe('③ fence 值缺失时不得发出空 fence', () => {
  // 服务端对**显式空**的 fence 参数返回 422：`?expectedConfigHash=` 曾被静默当成
  // 「没传 fence」，于是返回 200 + 一个完全没有「所见非所得」保护的 zip；而
  // `?expectedConfigHash=wrong` 才 409。静默降级比报错糟得多——调用方以为自己有保护。
  //
  // 而空值恰恰是前端最容易拼出来的：`operationConfigHash ?? ''`、表单未填、查询还没
  // 落地。mcps / plugins 两个详情页当时写的就是 `?? ''`。修法不是在前端把空串过滤掉
  // （那等于把静默降级搬到前端），而是**没拿到 revision 就禁用导出**：没有「所见」，
  // 就谈不上「所见即所得」。
  //
  // 这条锁的是那两处 `disabled` 条件里 `=== undefined` 那一项不被顺手删掉。
  const src = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'routes', 'mcps.detail.tsx'),
    'utf8',
  )
  const pluginSrc = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'routes', 'plugins.detail.tsx'),
    'utf8',
  )

  test('mcps / plugins 详情页在 operationConfigHash 未就绪时禁用导出', () => {
    expect(src).toContain('query.data?.operationConfigHash === undefined')
    expect(pluginSrc).toContain('query.data?.operationConfigHash === undefined')
  })

  test('组件层：fence 逐字透传给 API（不会在中途被"清洗"掉）', async () => {
    // 与上面互补：即使某个调用方真的传了奇怪的值，组件也不该自作主张改写它——
    // 该拒绝的由服务端拒绝，前端悄悄改写会让 409/422 与用户实际点的东西对不上。
    const spy = vi
      .spyOn(pkgApi, 'downloadResourcePackage')
      .mockResolvedValue(new Blob(['z']) as unknown as Blob)
    vi.spyOn(dl, 'triggerBlobDownload').mockImplementation(() => {})

    render(
      <ResourcePackageExportButton
        type="mcp"
        id="M1"
        name="gh"
        fence={{ expectedConfigHash: 'abc123' }}
      />,
    )
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(spy).toHaveBeenCalled())
    expect(spy.mock.calls[0]?.[2]).toEqual({ expectedConfigHash: 'abc123' })
  })
})

describe('④ skill 页面：两个查询不同版时不得导出', () => {
  // metadata 与 content 是**两个独立查询**。实现门第四轮的 P2-5 给了具体时序：
  //   1. `/content` 读到 v1，响应因文件读取慢还没到；
  //   2. 另一个写者保存 v2；
  //   3. `/api/skills/S` 返回 metadata v2；
  //   4. 迟到的 content v1 到达，成为页面**可见正文**；
  //   5. 导出按钮却发 metadata 的 v2 三维 revision，后端如实导出 v2。
  // 用户看到 v1、导出 v2，而 fence 一路绿灯——它保护的是「metadata 没变」，不是
  // 「你看到的东西没变」。
  //
  // 修法不解码 `token`（它对前端不透明），而是让 content 响应一并回传同快照的数值
  // revision，页面数值比较后停手。这条守卫盯住那个 `disabled` 条件不被顺手删掉。
  const src = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'routes', 'skills.detail.tsx'),
    'utf8',
  )

  test('页面按数值 revision 判定同版，并把它接进导出的 disabled', () => {
    expect(src).toContain('const skillRevisionsAgree =')
    expect(src).toContain('content.data.contentVersion === meta.data.contentVersion')
    expect(src).toContain('content.data.metaRevision === meta.data.metaRevision')
    expect(src).toContain('!skillRevisionsAgree')
  })

  test('**两个字段都要在才比** —— 只有一个时按「拿不到证据」放行', () => {
    // 这条是踩出来的。第一版只判了 `contentVersion` 缺失就放行，然后照样去比
    // `metaRevision`：一个只带 `contentVersion` 的响应（旧后端、或任何部分实现）会拿
    // `undefined` 去比一个真实数字，恒判「不同版」、把导出**永久禁用**。现有的
    // `skills-split-page` mock 正是这种形状，当场变红。
    //
    // 判据必须是「拿不到证据 ⇒ 不阻塞」，不是「拿不全证据 ⇒ 当作证否」——后者会把一条
    // 防护变成一个恒真的故障。
    expect(src).toContain('content.data?.contentVersion === undefined ||')
    expect(src).toContain('content.data.metaRevision === undefined')
  })

  test('不解码 token —— 它对前端是不透明的', () => {
    // 解码 token 能达到同样效果，但会让前端依赖一个被明确声明为 opaque 的编码，
    // 从此后端改不动它。这条把那条路堵死。
    expect(src).not.toContain('decodeSkillToken')
    expect(src).not.toContain('base64url')
  })

  test('后端 content 响应确实带上了这两个数值（否则上面的判定恒为 true）', () => {
    const service = readFileSync(
      resolve(import.meta.dirname, '..', '..', 'backend', 'src', 'services', 'skill.ts'),
      'utf8',
    )
    expect(service).toContain('contentVersion: skill.contentVersion')
    expect(service).toContain('metaRevision: gen.metaRevision')
  })
})
