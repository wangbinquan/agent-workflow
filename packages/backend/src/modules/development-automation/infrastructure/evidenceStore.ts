// RFC-310 PR-3 T34 —— EvidenceStore（内容寻址 blob + bundle 清单）。
//
// PR-0 probe（tests/helpers/rfc310EvidenceSink.ts）的生产化：
//   <appHome>/evidence/blobs/<aa>/<sha256>      内容寻址、不可变、跨 bundle 去重
//   <appHome>/evidence/bundles/<bundleId>.json  bundle 清单（相对路径→blob）
// 大字节永不过 DB/事件/prompt；导入是 safe-walk（拒 symlink/非常规文件/路径
// 逃逸/超预算）+ 流式 hash（64KB chunk，峰值内存有界——Bun fetch 不背压的
// 教训见 dev-gotchas，网络下载必须由子进程下载器先落盘再 import）。
// 物化到 workspace 用拷贝（不 hardlink：workspace 会被整树废弃重建，硬链会
// 让「废弃」波及 blob 池的 inode 语义混乱；拷贝换确定性）。RFC-294 演进债：
// evidence-store 目标归 platform/contracts，现按现状落本 context infrastructure。

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { ulid } from 'ulid'

export interface EvidenceBudget {
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
}

export interface EvidenceEntry {
  readonly relativePath: string
  readonly bytes: number
  readonly sha256: string
}

export interface EvidenceBundleRecord {
  readonly bundleId: string
  readonly entries: readonly EvidenceEntry[]
  readonly totalBytes: number
}

function assertSafeRelPath(relPath: string): void {
  if (relPath.length === 0 || relPath.length > 4096) throw new Error(`unsafe path: ${relPath}`)
  if (relPath.includes('\0')) throw new Error(`unsafe path (NUL): ${relPath}`)
  if (relPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(relPath)) {
    throw new Error(`unsafe path (absolute): ${relPath}`)
  }
  const segments = relPath.split('/')
  if (segments.some((seg) => seg.length === 0 || seg === '.' || seg === '..')) {
    throw new Error(`unsafe path (traversal): ${relPath}`)
  }
}

async function hashFileStreaming(absPath: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256')
  let bytes = 0
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absPath, { highWaterMark: 64 * 1024 })
    stream.on('data', (chunk) => {
      hash.update(chunk as Buffer)
      bytes += (chunk as Buffer).byteLength
    })
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  return { sha256: hash.digest('hex'), bytes }
}

export class EvidenceStore {
  readonly #root: string

  constructor(root: string) {
    this.#root = root
    mkdirSync(join(root, 'blobs'), { recursive: true })
    mkdirSync(join(root, 'bundles'), { recursive: true })
  }

  blobPath(sha256: string): string {
    return join(this.#root, 'blobs', sha256.slice(0, 2), sha256)
  }

  /** 从已落盘文件收 blob（流式 hash；已存在则去重）。返回内容寻址 ref=sha256。 */
  async putBlobFromFile(absPath: string): Promise<{ sha256: string; bytes: number }> {
    const st = lstatSync(absPath)
    if (!st.isFile()) throw new Error(`not a regular file: ${absPath}`)
    const { sha256, bytes } = await hashFileStreaming(absPath)
    const dest = this.blobPath(sha256)
    if (!existsSync(dest)) {
      mkdirSync(dirname(dest), { recursive: true })
      const tmp = `${dest}.tmp-${ulid()}`
      copyFileSync(absPath, tmp)
      renameSync(tmp, dest)
    }
    return { sha256, bytes }
  }

  /**
   * staged 目录 → bundle：safe-walk（拒 symlink/非常规文件/NUL/逃逸/超预算），
   * 逐文件流式 hash 入 blob 池，写不可变 bundle 清单。digest 由本方法重算——
   * 生产者（adapter/materializer）自报的一律不信。
   */
  async importStagedTree(
    stagedRoot: string,
    budget: EvidenceBudget,
  ): Promise<EvidenceBundleRecord> {
    const entries: EvidenceEntry[] = []
    let totalBytes = 0
    const files: string[] = []
    const visit = (rel: string): void => {
      const abs = rel === '' ? stagedRoot : join(stagedRoot, rel)
      const st = lstatSync(abs)
      if (st.isSymbolicLink()) throw new Error(`unsafe staged entry (symlink): ${rel}`)
      if (st.isDirectory()) {
        for (const name of readdirSync(abs).sort()) {
          if (name.includes('\0')) throw new Error(`unsafe staged name: ${name}`)
          visit(rel === '' ? name : `${rel}/${name}`)
        }
        return
      }
      if (!st.isFile()) throw new Error(`unsafe staged entry (not a regular file): ${rel}`)
      assertSafeRelPath(rel)
      if (files.length + 1 > budget.maxFiles) throw new Error('budget: too many files')
      if (st.size > budget.maxFileBytes) throw new Error('budget: file too large')
      totalBytes += st.size
      if (totalBytes > budget.maxTotalBytes) throw new Error('budget: total too large')
      files.push(rel)
    }
    visit('')

    for (const rel of files.sort()) {
      const { sha256, bytes } = await this.putBlobFromFile(join(stagedRoot, rel))
      entries.push({ relativePath: rel, bytes, sha256 })
    }
    const bundleId = ulid()
    const record: EvidenceBundleRecord = { bundleId, entries, totalBytes }
    const manifestPath = join(this.#root, 'bundles', `${bundleId}.json`)
    const tmp = `${manifestPath}.tmp`
    writeFileSync(tmp, JSON.stringify(record, null, 2))
    renameSync(tmp, manifestPath)
    return record
  }

  getBundle(bundleId: string): EvidenceBundleRecord | null {
    const manifestPath = join(this.#root, 'bundles', `${bundleId}.json`)
    if (!existsSync(manifestPath)) return null
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as EvidenceBundleRecord
  }

  /** 把 bundle 物化到 workspace 目录（只读语义由消费侧快照对拍强制）。 */
  materializeBundle(bundleId: string, destRoot: string): EvidenceEntry[] {
    const record = this.getBundle(bundleId)
    if (record === null) throw new Error(`evidence bundle not found: ${bundleId}`)
    for (const entry of record.entries) {
      assertSafeRelPath(entry.relativePath)
      const src = this.blobPath(entry.sha256)
      if (!existsSync(src)) {
        throw new Error(`evidence blob missing: ${entry.sha256} (${entry.relativePath})`)
      }
      const dest = join(destRoot, entry.relativePath)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(src, dest)
    }
    return [...record.entries]
  }

  /** 读单个 blob 的字节数（存在性检查用；正文读取走 ranged streaming route）。 */
  hasBlob(sha256: string): boolean {
    return existsSync(this.blobPath(sha256))
  }
}
