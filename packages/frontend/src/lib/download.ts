// RFC-286 F2 —— 浏览器「把 Blob 存成文件」的唯一实现。
//
// 此前三处各揣一份 a[download] 触发逻辑（WorktreeFilesPanel 私有 saveBlob /
// lib/worktree-download 私有 saveBlobAs / reviews.detail 内联导出），字节几乎
// 相同却各自漂移。收敛单点：对象 URL 生命周期（finally revoke）、rel=noopener、
// 挂载后即点即删。为什么是 blob + 对象 URL 而不是 <a download href=api>：下载
// 路由需要 Authorization 头，且 base 可能指向跨源远端 daemon——裸 <a download>
// 会被忽略 download 属性并把 token 逼进 URL。
//
// 大文件预算：调用方经 api.getBlob 显式传 DOWNLOAD_DEADLINE_MS（proposal V3：
// 不引入 300s 默认硬顶回归——工件/仓库文件可以很大，默认预算是给 JSON API 的）。

/** 显式的大下载预算（1h）。AbortSignal.timeout 不接受 Infinity，取一个明确的
 *  「人会等」上限；真正的取消权在调用方的 AbortSignal。 */
export const DOWNLOAD_DEADLINE_MS = 60 * 60 * 1000

/** Save a Blob to disk via a transient object-URL anchor. */
export function saveBlobAs(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = fileName
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
