// RFC-271 T18 —— zip **编码**（导出侧）。解码侧在 `services/skill-zip.ts:decodeZip`。
//
// **store-only（不压缩）**是刻意的：
//   · 配置包的体量由技能文件树决定，而那些文件多半已经是压缩过的资产；
//   · store-only 让产出**逐字节可复现**——同一份闭包导出两次必须完全一样，这是
//     AC-7b「零匹配与全不可见逐字节同形」能被断言的前提。deflate 的实现细节
//     （level / 字典状态）不进入我们的契约。
//
// 时间戳同理钉死：zip 的 DOS 时间字段若取 `Date.now()`，同一份内容每次导出都不同，
// 「两次导出应当字节相同」这条断言就永远写不出来。

import { zipSync } from 'fflate'

/** 导出包内的一个文件。路径必须是相对的、正斜杠分隔。 */
export interface ZipFile {
  path: string
  bytes: Uint8Array
}

/**
 * DOS 时间的固定值（1980-01-01 00:00:00，zip 纪元起点）。
 * ⚠️ 不要改成当前时间——见文件头。
 */
const FIXED_MTIME = new Date(Date.UTC(1980, 0, 1))

export function encodeZip(files: readonly ZipFile[]): Uint8Array {
  const tree: Record<string, Uint8Array> = {}
  for (const file of files) {
    const path = file.path.replaceAll('\\', '/')
    if (path.length === 0 || path.startsWith('/') || path.split('/').includes('..')) {
      throw new Error(`zip entry path must be relative and must not traverse: '${file.path}'`)
    }
    if (tree[path] !== undefined) {
      throw new Error(`duplicate zip entry '${path}'`)
    }
    tree[path] = file.bytes
  }
  // 条目顺序也钉死（字典序）：`zipSync` 按插入序写，靠调用方顺序会让「同一份内容
  // 因为 Map 遍历序不同而产出不同字节」。
  const ordered: Record<string, Uint8Array> = {}
  for (const path of Object.keys(tree).sort()) ordered[path] = tree[path]!
  return zipSync(ordered, { level: 0, mtime: FIXED_MTIME })
}
