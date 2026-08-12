// RFC-286 F2 —— bare fetch 收敛的回归锁。
//
// 锁四件事（design §F2 测试策略）：
//   ① downloadPortArtifact 的 404→worktree 回退链（红→绿对：legacy 行走回退
//     成功；非 404 错误原样浮出，绝不静默吞掉）；
//   ② 大文件不撞默认 deadline——两条下载路径都必须显式携带
//     DOWNLOAD_DEADLINE_MS（proposal V3：不引入 300s 默认硬顶回归）；
//   ③ 离线（网络层 reject）经 api 客户端的结构化错误原样传播（本地化错误码
//     路径由 ApiError.code 承载，不再有面板私有 http-<status> 压平）；
//   ④ saveBlobAs 单点触发（a[download] + 对象 URL 生命周期）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, ApiError } from '../src/api/client'
import { DOWNLOAD_DEADLINE_MS, saveBlobAs } from '../src/lib/download'
import { downloadPortArtifact, downloadWorktreeFile } from '../src/lib/worktree-download'

const BLOB = new Blob(['x'], { type: 'text/plain' })

let clicks: string[]

beforeEach(() => {
  clicks = []
  // jsdom 无真实下载：拦 anchor click，记录触发时的 download 文件名。
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push(this.download)
  })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('RFC-286 F2 — 下载收敛', () => {
  test('④ saveBlobAs：单次 anchor 触发 + 对象 URL 必然 revoke', () => {
    saveBlobAs(BLOB, 'a.txt')
    expect(clicks).toEqual(['a.txt'])
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock')
  })

  test('②+④ downloadWorktreeFile：走 api.getBlob 且显式大预算，存盘取 basename', async () => {
    const getBlob = vi.spyOn(api, 'getBlob').mockResolvedValue(BLOB)
    await downloadWorktreeFile('t1', 'docs/report.md')
    expect(getBlob).toHaveBeenCalledTimes(1)
    const [path, , opts] = getBlob.mock.calls[0]!
    expect(path).toBe('/api/worktree-files/t1/docs/report.md')
    expect(opts?.deadlineMs).toBe(DOWNLOAD_DEADLINE_MS) // 不撞 JSON API 默认硬顶
    expect(clicks).toEqual(['report.md'])
  })

  test('① 回退链绿半边：archive 404 → 回退 worktree 路成功下载', async () => {
    const getBlob = vi
      .spyOn(api, 'getBlob')
      .mockRejectedValueOnce(new ApiError(404, 'artifact-not-found', 'no archive'))
      .mockResolvedValueOnce(BLOB)
    await downloadPortArtifact('t1', 'r1', 'out', 'dist/pkg.tar')
    expect(getBlob).toHaveBeenCalledTimes(2)
    expect(getBlob.mock.calls[0]![0]).toBe('/api/tasks/t1/port-artifacts/r1/out?item=0')
    expect(getBlob.mock.calls[1]![0]).toBe('/api/worktree-files/t1/dist/pkg.tar')
    // 两跳都必须带显式大预算。
    expect(getBlob.mock.calls[0]![2]?.deadlineMs).toBe(DOWNLOAD_DEADLINE_MS)
    expect(getBlob.mock.calls[1]![2]?.deadlineMs).toBe(DOWNLOAD_DEADLINE_MS)
    expect(clicks).toEqual(['pkg.tar'])
  })

  test('① 回退链红半边：非 404（含离线）原样浮出、绝不触发下载', async () => {
    vi.spyOn(api, 'getBlob').mockRejectedValue(new ApiError(0, 'network-unreachable', 'offline'))
    await expect(downloadPortArtifact('t1', 'r1', 'out', 'dist/pkg.tar')).rejects.toMatchObject({
      code: 'network-unreachable', // ③ 结构化错误码传播，非 http-<status> 压平
    })
    expect(clicks).toEqual([])
  })

  test('① 回退链红半边：回退路本身失败也浮出（不吞第二跳错误）', async () => {
    vi.spyOn(api, 'getBlob')
      .mockRejectedValueOnce(new ApiError(404, 'artifact-not-found', 'no archive'))
      .mockRejectedValueOnce(new ApiError(404, 'task-not-found', 'gone'))
    await expect(downloadPortArtifact('t1', 'r1', 'out', 'dist/pkg.tar')).rejects.toMatchObject({
      code: 'task-not-found',
    })
    expect(clicks).toEqual([])
  })
})
