// RFC-310 PR-0 T6 —— one-shot EvidenceSink probe（测试专用，不进生产）。
//
// 证明两件事（pr0-go-no-go.md §C）：①外部 provider 的大输出可以**流式**进
// staged root——固定大小 chunk 写盘+滚动 hash，峰值内存与总字节解耦；
// ②staged → evidence 的导入是 safe-walk：拒绝 symlink/非常规文件/路径逃逸/
// 超预算，digest 由导入侧重算（不信 provider 自报）。PR-3 T34 把同一口径
// 搬进生产 EvidenceStore importer。

import { createHash } from 'node:crypto'
import {
  createWriteStream,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export interface SinkBudget {
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
}

export interface SinkEntry {
  readonly relativePath: string
  readonly bytes: number
  readonly sha256: string
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

async function* iterateStream(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (Symbol.asyncIterator in source) {
    yield* source as AsyncIterable<Uint8Array>
    return
  }
  const reader = (source as ReadableStream<Uint8Array>).getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done === true) return
      if (value !== undefined) yield value
    }
  } finally {
    reader.releaseLock()
  }
}

/** adapter 唯一可写的一次性暂存根：流式收文件，close 后拒绝一切写。 */
export class OneShotEvidenceSink {
  readonly #root: string
  readonly #budget: SinkBudget
  readonly #entries: SinkEntry[] = []
  #totalBytes = 0
  #closed = false

  constructor(root: string, budget: SinkBudget) {
    this.#root = root
    this.#budget = budget
    mkdirSync(root, { recursive: true })
  }

  async addFile(
    relPath: string,
    source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<SinkEntry> {
    if (this.#closed) throw new Error('sink is closed')
    assertSafeRelPath(relPath)
    if (this.#entries.length + 1 > this.#budget.maxFiles) throw new Error('budget: too many files')
    const abs = join(this.#root, relPath)
    mkdirSync(join(abs, '..'), { recursive: true })
    const hash = createHash('sha256')
    let bytes = 0
    const stream = createWriteStream(abs, { flags: 'wx' })
    try {
      for await (const chunk of iterateStream(source)) {
        bytes += chunk.byteLength
        this.#totalBytes += chunk.byteLength
        if (bytes > this.#budget.maxFileBytes) throw new Error('budget: file too large')
        if (this.#totalBytes > this.#budget.maxTotalBytes)
          throw new Error('budget: total too large')
        hash.update(chunk)
        if (!stream.write(chunk)) {
          await new Promise<void>((resolve) => stream.once('drain', resolve))
        }
      }
      await new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => (err ? reject(err) : resolve()))
      })
    } catch (error) {
      stream.destroy()
      // 失败的文件不占预算：回滚本次已计入的字节，保持 sink 可继续收合法文件。
      this.#totalBytes -= bytes
      throw error
    }
    const entry: SinkEntry = { relativePath: relPath, bytes, sha256: hash.digest('hex') }
    this.#entries.push(entry)
    return entry
  }

  close(): readonly SinkEntry[] {
    this.#closed = true
    return [...this.#entries].sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1))
  }
}

/** 流式 hash 一个已落盘文件（64KB chunk，内存有界）。 */
export async function hashFileStreaming(absPath: string): Promise<string> {
  const { createReadStream } = await import('node:fs')
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absPath, { highWaterMark: 64 * 1024 })
    stream.on('data', (chunk) => hash.update(chunk as Buffer))
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  return hash.digest('hex')
}

/**
 * 登记一个由外部下载器（curl 等）已写入 staged root 的文件：路径校验 + 预算
 * 复核 + 流式重算 digest。
 *
 * 为什么存在（2026-08-18 PR-0 实测）：Bun 的 fetch 与 node:http 客户端在
 * 「快生产者、慢消费者」下内部缓冲不背压——裸读丢 128MB 响应的 RSS 峰值
 * 680MB/580MB。GB 级 evidence 下载必须由子进程下载器直接落盘（内存恒定），
 * daemon 内只做登记与 hash；`addFile` 流式接口仅用于小响应与受控流。
 */
export class StagedFileRegistrar {
  readonly #root: string
  readonly #budget: SinkBudget
  readonly #entries: SinkEntry[] = []
  #totalBytes = 0

  constructor(root: string, budget: SinkBudget) {
    this.#root = root
    this.#budget = budget
    mkdirSync(root, { recursive: true })
  }

  stagedPathFor(relPath: string): string {
    assertSafeRelPath(relPath)
    const abs = join(this.#root, relPath)
    mkdirSync(join(abs, '..'), { recursive: true })
    return abs
  }

  async register(relPath: string): Promise<SinkEntry> {
    assertSafeRelPath(relPath)
    const abs = join(this.#root, relPath)
    const st = lstatSync(abs)
    if (!st.isFile()) throw new Error(`registered path is not a regular file: ${relPath}`)
    if (this.#entries.length + 1 > this.#budget.maxFiles) throw new Error('budget: too many files')
    if (st.size > this.#budget.maxFileBytes) throw new Error('budget: file too large')
    this.#totalBytes += st.size
    if (this.#totalBytes > this.#budget.maxTotalBytes) {
      this.#totalBytes -= st.size
      throw new Error('budget: total too large')
    }
    const entry: SinkEntry = {
      relativePath: relPath,
      bytes: st.size,
      sha256: await hashFileStreaming(abs),
    }
    this.#entries.push(entry)
    return entry
  }

  entries(): readonly SinkEntry[] {
    return [...this.#entries].sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1))
  }
}

/** staged → evidence 的 safe import：拒 symlink/非常规文件/逃逸/超预算，重算 digest。 */
export function safeImportStagedTree(
  stagedRoot: string,
  destRoot: string,
  budget: SinkBudget,
): SinkEntry[] {
  const entries: SinkEntry[] = []
  let totalBytes = 0
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
    if (entries.length + 1 > budget.maxFiles) throw new Error('budget: too many files')
    if (st.size > budget.maxFileBytes) throw new Error('budget: file too large')
    totalBytes += st.size
    if (totalBytes > budget.maxTotalBytes) throw new Error('budget: total too large')
    const content = readFileSync(abs)
    const dest = join(destRoot, rel)
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, content)
    entries.push({
      relativePath: rel,
      bytes: st.size,
      sha256: createHash('sha256').update(content).digest('hex'),
    })
  }
  visit('')
  return entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1))
}
