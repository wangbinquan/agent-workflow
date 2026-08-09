// RFC-271 T34 —— 配置包下载的文件名与触发。
//
// `safeDownloadBaseName` 从 `workflow-draft-export.ts` 抽出来：那个文件在批次 I 里
// 要整个删掉（C3 本地草稿导出下线），而这条清洗逻辑与草稿无关——它回答的是
// 「一个资源名怎么变成一个各平台都能落盘的文件名」，六类导出都要用。
//
// 只替换文件系统**真的会拒绝**的字符；`<a download>` 能正常携带 UTF-8（这条路径
// 从不经过 HTTP 头，所以 RFC 5987 不适用），中文名不该被打成一串下划线。

import { normalizeResourceDisplayName } from '@agent-workflow/shared'

export function safeDownloadBaseName(name: string, fallback: string): string {
  const cleaned = normalizeResourceDisplayName(name)
    .replace(/[/\\:*?"<>|]/g, '-') // POSIX 分隔符 + Windows 保留字符集
    .replace(/\p{Cc}/gu, '-')
    .replace(/[. ]+$/, '') // Windows 拒绝结尾的点或空格
  return cleaned === '' ? fallback : cleaned
}

/** 配置包的文件名：`<类型>-<名字>.awpkg.zip`。 */
export function resourcePackageFilename(type: string, name: string): string {
  return `${type}-${safeDownloadBaseName(name, type)}.awpkg.zip`
}

/**
 * 触发一次浏览器下载。
 *
 * ⚠️ `revokeObjectURL` 必须在 click **之后**——提前撤销会让下载拿到一个已经失效的
 * URL，表现是「点了没反应」，而且只在部分浏览器/时序下复现。
 */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
