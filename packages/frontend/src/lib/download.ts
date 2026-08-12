// RFC-286 F2 —— 浏览器「把 Blob 存成文件」的唯一实现。
//
// 此前四处各揣一份 a[download] 触发逻辑（WorktreeFilesPanel 私有 saveBlob /
// lib/worktree-download 私有 saveBlobAs / reviews.detail 内联导出 / RFC-271
// resource-package-download 的 triggerBlobDownload——实现门路 1 P2-2 清点补账），
// 字节几乎相同却各自漂移。收敛单点：对象 URL 生命周期（finally revoke）、rel=noopener、
// 挂载后即点即删。为什么是 blob + 对象 URL 而不是 <a download href=api>：下载
// 路由需要 Authorization 头，且 base 可能指向跨源远端 daemon——裸 <a download>
// 会被忽略 download 属性并把 token 逼进 URL。
//
// 大文件预算：调用方经 api.getBlob 显式传 DOWNLOAD_DEADLINE_MS（proposal V3：
// 不引入 300s 默认硬顶回归——工件/仓库文件可以很大，默认预算是给 JSON API 的）。

/** 显式的「不限时」下载预算。旧裸 fetch 下载没有任何超时；1h 一类固定顶会把
 *  慢链路大文件（GB 级 worktree 产物）在 90% 处掐死、字节全废——比旧行为更差
 *  （实现门路 2 P2-2）。api 客户端 withDeadline 对 Infinity 走专门支线（跳过
 *  AbortSignal.timeout），取消权完全归调用方传入的 AbortSignal。 */
export const DOWNLOAD_DEADLINE_MS = Infinity

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
