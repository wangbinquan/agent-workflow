// RFC-193 — path 端口产物归档制（archive-at-emit）。
//
// 病根：path 形端口入库的只是路径字符串，能否兑现为文件内容取决于消费方
// 自己重建「根 / 时刻 / 可见性」三个维度（RFC-130 后三者全不稳定——节点
// iso 短命、wrapper-canonical 分层、.gitignore 挡快照、worktree 会被 GC）。
// 每接一个新消费方就埋一个新断链（review / 前端预览 / 下游 agent / fanout）。
//
// 根治：runner 校验窗口（节点 iso 存活、handler 刚校验完存在性）是全生命
// 周期唯一 100% 可读的时刻——在这里把文件内容以【原始字节】归档为不可变
// 副本（appHome 下），node_run_outputs.archive_json 存引用。此后一切「读
// 内容」的消费方（review / port-artifacts API / 前端）一律走
// readPortArtifact：归档 → worktree 回退（存量行）→ missing 三级链，与
// worktree 生命周期彻底解耦。「要文件在工作区」的语义（下游 agent 编辑）
// 则由必达 merge-back（forcedPortPathsForTask → snapshotFullState 的
// forceIncludePaths）另行保障——两种语义分离，见 design.md D1/D2。

import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  statSync,
  writeFileSync,
  realpathSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { and, eq, isNotNull } from 'drizzle-orm'
import { WORKTREE_FILE_MAX_BYTES, tryParseKind, splitListItems } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { nodeRunOutputs, nodeRuns } from '@/db/schema'
import { createLogger } from '@/util/log'

const log = createLogger('port-artifacts')

// ---------------------------------------------------------------------------
// 磁盘 / 路由键编码（D3）。
// ---------------------------------------------------------------------------

/**
 * portName → 安全的单段磁盘键。`AgentSchema.outputs` 仅校验为 string——端口
 * 名可含 `/`、`..`、任意 Unicode。键 = 可读前缀（非 [A-Za-z0-9_-] 折为 `_`，
 * 截 48）+ sha256 前 16 hex：**有界**（组件 ≤65 字符，不会超文件系统 255
 * 限）、**区分大小写**（macOS 默认卷大小写不敏感，`Report`/`report` 纯
 * sanitize 会撞同一目录——digest 区分，Codex 实现门 P2）、确定性、单段
 * （无 `/`、不可能是 `..`）。
 */
export function encodePortSegment(portName: string): string {
  const sanitized = portName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48)
  const digest = createHash('sha256').update(portName, 'utf8').digest('hex').slice(0, 16)
  return `${sanitized}_${digest}`
}

/** 该 nodeRun 全部端口归档的根目录（appHome 相对）。 */
export function portArchiveRootRel(taskId: string, nodeRunId: string): string {
  return join('runs', taskId, 'ports', nodeRunId)
}

// ---------------------------------------------------------------------------
// 容器相对化（D4/D6）。
// ---------------------------------------------------------------------------

/**
 * repo0 相对路径 → 容器相对路径。多 repo 任务的 `tasks.worktreePath` 是父
 * 容器、repo 挂在 `{worktreePath}/{worktreeDirName}`；归档引用与必达清单统
 * 一用容器相对形态（与 task.worktreePath 语义同构）。单 repo `dirName=''`
 * 时恒等。注意 content 列**不能**用这个形态——下游 agent 的 cwd 是 repo0
 * 根而非容器根（design D6，Codex 设计门 P1）。
 */
export function toContainerRelative(worktreeDirName: string, repoRelPath: string): string {
  return worktreeDirName === '' ? repoRelPath : join(worktreeDirName, repoRelPath)
}

/** {@link toContainerRelative} 的对偶：容器相对清单 → 指定 repo 的 repo 相对子集。 */
export function repoRelForcedPaths(
  containerPaths: readonly string[] | undefined,
  worktreeDirName: string,
): string[] {
  if (containerPaths === undefined || containerPaths.length === 0) return []
  if (worktreeDirName === '') return [...containerPaths]
  const prefix = worktreeDirName + '/'
  return containerPaths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length))
}

// ---------------------------------------------------------------------------
// archive_json 形态（D4）。
// ---------------------------------------------------------------------------

export interface PortArchiveItem {
  /** 容器相对源路径。 */
  path: string
  /** appHome 相对归档副本路径；超限二进制不存副本 → null（D12）。 */
  file: string | null
  /** 源文件原始字节数。 */
  size: number
  truncated: boolean
  /**
   * D19（Codex 实现门 P2）：端口值为 symlink 且目标在 worktree 内时，目标的
   * 容器相对路径。必达清单从 archive_json 重建（forcedPortPathsForTask）——
   * 不持久化目标的话，下游 base 快照只 add -f 链接本体、丢掉被 ignore 的
   * 目标，得到悬挂 symlink。
   */
  linkTarget?: string
}

export interface PortArchive {
  v: 1
  items: PortArchiveItem[]
}

export function parseArchiveJson(raw: string | null | undefined): PortArchive | null {
  if (raw === null || raw === undefined || raw === '') return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      (parsed as { v?: unknown }).v !== 1 ||
      !Array.isArray((parsed as { items?: unknown }).items)
    ) {
      return null
    }
    return parsed as PortArchive
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 写入面：archive-at-emit（D1/D12/D15）。
// ---------------------------------------------------------------------------

/** git 同款二进制启发：采样前 8KB，出现 NUL 字节 ⟹ 二进制。 */
function sniffBinary(absPath: string): boolean {
  const fd = openSync(absPath, 'r')
  try {
    const buf = Buffer.alloc(8192)
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n).includes(0)
  } finally {
    closeSync(fd)
  }
}

/** 文本截断副本尾部注入的警告行（D12——doc_version 原样归档，reviewer 必见）。 */
export function truncationNotice(containerRelPath: string): string {
  return `\n\n> ⚠️ [RFC-193] content truncated at ${Math.floor(WORKTREE_FILE_MAX_BYTES / (1024 * 1024))} MiB — full file in worktree: \`${containerRelPath}\`\n`
}

export interface ArchivePortArtifactsResult {
  archiveJson: string
  /** repo0 相对源路径清单（T4 必达 merge-back 用）。 */
  portFilePaths: string[]
}

/**
 * 把一个 path 形端口的全部 item 以原始字节归档（校验窗口内调用——全部端口
 * 校验通过之后，见 D15 两阶段）。幂等覆写：envelope followup 重试同一
 * nodeRunId 会整体重写，与 node_run_outputs 的 onConflictDoUpdate 对齐。
 * 任何写盘失败向上抛 —— runner 把它转成 port-artifact-archive-failed。
 */
export function archivePortArtifacts(opts: {
  appHome: string
  taskId: string
  nodeRunId: string
  portName: string
  /** 单值端口长度 1；list 端口按 splitListItems 行序。 */
  items: Array<{ sourceAbs: string; sourcePath: string }>
  /** repos[0] 的 worktreeDirName（容器相对化前缀；单 repo ''）。 */
  worktreeDirName: string
  /** 校验根（= agent cwd = repos[0] iso）。D19 symlink 目标判定用。 */
  worktreeRootAbs: string
}): ArchivePortArtifactsResult {
  const rootRel = portArchiveRootRel(opts.taskId, opts.nodeRunId)
  const portRel = join(rootRel, encodePortSegment(opts.portName))
  const portAbs = resolve(opts.appHome, portRel)
  // D3 containment 断言：encode 后天然满足；防御未来编码器回归。
  const rootAbs = resolve(opts.appHome, rootRel)
  if (portAbs !== rootAbs && !portAbs.startsWith(rootAbs + sep)) {
    throw new Error(`port-artifact containment violated: '${opts.portName}' → ${portAbs}`)
  }
  mkdirSync(portAbs, { recursive: true })

  const items: PortArchiveItem[] = []
  const portFilePaths: string[] = []
  for (let i = 0; i < opts.items.length; i++) {
    const it = opts.items[i]!
    const containerRel = toContainerRelative(opts.worktreeDirName, it.sourcePath)
    const size = statSync(it.sourceAbs).size
    const ext = extname(it.sourcePath) // 保留源扩展名（可为空），MIME 推断用
    const fileRel = join(portRel, `item_${i}${ext}`)
    const fileAbs = resolve(opts.appHome, fileRel)
    if (size <= WORKTREE_FILE_MAX_BYTES) {
      // copyFileSync 跟随 symlink → 物化目标内容（D19）。
      copyFileSync(it.sourceAbs, fileAbs)
      items.push({ path: containerRel, file: fileRel, size, truncated: false })
    } else if (sniffBinary(it.sourceAbs)) {
      // 超限二进制：截断副本只会是损坏字节，不如诚实只记元数据（D12）。
      items.push({ path: containerRel, file: null, size, truncated: true })
    } else {
      // 超限文本：截断存 + 尾部警告行（review 主场景保住；D12）。
      const fd = openSync(it.sourceAbs, 'r')
      let head: Buffer
      try {
        head = Buffer.alloc(WORKTREE_FILE_MAX_BYTES)
        const n = readSync(fd, head, 0, head.length, 0)
        head = head.subarray(0, n)
      } finally {
        closeSync(fd)
      }
      writeFileSync(fileAbs, Buffer.concat([head, Buffer.from(truncationNotice(containerRel))]))
      items.push({ path: containerRel, file: fileRel, size, truncated: true })
    }
    portFilePaths.push(it.sourcePath)
    // D19：symlink 端口值——`git add -f` 只收录链接对象本身，目标若被 ignore
    // 会让下游 iso 里的链接失效。目标仍在 worktree 内（相对链接）时把目标也
    // 追加进必达清单，并持久化到 archive item（linkTarget）——后续任务级
    // roster 从 archive_json 重建，瞬态 portFilePaths 之外必须有持久痕迹
    // （Codex 实现门 P2）。绝对目标（指向本 iso 之外）warn，工作区语义不
    // 承诺（阅读语义已由上面的 copyFileSync 跟随物化兜底）。
    try {
      if (lstatSync(it.sourceAbs).isSymbolicLink()) {
        const realTarget = realpathSync(it.sourceAbs)
        const realRoot = realpathSync(opts.worktreeRootAbs)
        if (realTarget === realRoot || realTarget.startsWith(realRoot + sep)) {
          const targetRepoRel = relative(realRoot, realTarget)
          portFilePaths.push(targetRepoRel)
          const last = items[items.length - 1]
          if (last !== undefined) {
            last.linkTarget = toContainerRelative(opts.worktreeDirName, targetRepoRel)
          }
        } else {
          log.warn('symlink port target outside worktree — workspace semantics not guaranteed', {
            port: opts.portName,
            source: it.sourcePath,
          })
        }
      }
    } catch {
      // lstat/realpath race (file vanished) — roster stays as-is.
    }
  }
  const archive: PortArchive = { v: 1, items }
  return { archiveJson: JSON.stringify(archive), portFilePaths }
}

// ---------------------------------------------------------------------------
// 读取面：消费原语（D8）。
// ---------------------------------------------------------------------------

export interface PortArtifactReadItem {
  /** 容器相对源路径；存量行 worktree 回退时 = content 行；missing 时可为 null。 */
  path: string | null
  /** 文本消费面（UTF-8 解码只发生在这里；二进制消费方用 bytes）。 */
  body: string
  /** 原始字节（API 下载面）。missing 时为空 Buffer。 */
  bytes: Uint8Array
  /** 源文件原始字节数（archive_json 透传；worktree 回退 = 实读字节数）。 */
  size: number
  truncated: boolean
  source: 'archive' | 'worktree' | 'missing'
}

/**
 * lexical + realpath 双重 containment（对齐 worktreeFiles.ts / RFC-103 T7）。
 * 绝对输入不直接拒——存量行（pre-RFC-193）的 content 可能是「worktree 内的
 * 绝对路径」（旧 envelope 校验接受它）；containment 语义与 envelope 一致：
 * lexical 在根内 → realpath 收紧（防 symlink 读穿）；lexical 在根外 →
 * realpath 同位证明才放行（macOS /var→/private/var 前缀差异）。
 */
function readInsideRoot(rootAbs: string, rel: string): Buffer | null {
  const root = resolve(rootAbs)
  const target = isAbsolute(rel) ? resolve(rel) : resolve(root, rel)
  try {
    const lexicalInside = target === root || target.startsWith(root + sep)
    const realTarget = realpathSync(target)
    const realRoot = realpathSync(root)
    const realInside = realTarget === realRoot || realTarget.startsWith(realRoot + sep)
    if (!realInside) return null
    if (!lexicalInside && !isAbsolute(rel)) return null // 相对输入不许 lexical 逃逸
    return readFileSync(realTarget)
  } catch {
    return null
  }
}

/**
 * 统一读取原语：archive_json（归档副本）→ fallback worktree（存量行 / 超限
 * 二进制）→ missing。所有「读端口文件内容」的消费方必须走这里——不许再
 * 自己 join 某个根（design G5；review.ts 由源码文本锁强制）。
 */
export function readPortArtifact(opts: {
  appHome: string
  taskId: string
  archiveJson: string | null
  /** node_run_outputs.content（repo0 相对路径文本；回退面按行消费）。 */
  content: string
  kind: string | null
  /** review 传 scopeRoot；API 传 task.worktreePath；null = 无回退根。 */
  fallbackWorktreeRoot: string | null
  /**
   * repos[0] 的 worktreeDirName。存量行（archive_json NULL）的 content 是
   * repo0 相对，而 fallbackWorktreeRoot 是容器根——多 repo 时文件实际在
   * `{root}/{dirName}/{line}`，不补前缀会把存在的文件误报 missing（Codex
   * 实现门 P1）。单 repo '' 恒等；省略默认 ''。
   */
  legacyRepoDirName?: string
  /**
   * 选择性读取（Codex 实现门 P2）：'meta' 只回元数据（不读任何字节——100
   * item 的端口元数据请求不应吃 200MiB）；number 只读该下标的字节，其余
   * item 仅元数据。省略 = 全量（review 归档面需要全部 body）。
   */
  only?: 'meta' | number
}): { items: PortArtifactReadItem[] } {
  const wantBytes = (idx: number): boolean =>
    opts.only === undefined ? true : opts.only === 'meta' ? false : opts.only === idx
  const archive = parseArchiveJson(opts.archiveJson)
  if (archive !== null) {
    // D3/§4.3 containment：归档副本必须落在本任务的 ports/ 命名空间内
    // （防 DB 污染的 `../` 逃逸——file 字段只被信任到「相对本命名空间」）。
    const portsRootAbs = resolve(opts.appHome, 'runs', opts.taskId, 'ports')
    const items = archive.items.map((it, idx): PortArtifactReadItem => {
      if (it.file !== null) {
        const rel = relative(portsRootAbs, resolve(opts.appHome, it.file))
        if (rel.startsWith('..') || isAbsolute(rel)) {
          log.warn('archive_json file outside task ports namespace — treating as missing', {
            file: it.file,
            taskId: opts.taskId,
          })
        } else if (!wantBytes(idx)) {
          // 元数据面：existsSync 定 source，绝不读字节。
          if (existsInsideRoot(portsRootAbs, rel)) {
            return {
              path: it.path,
              body: '',
              bytes: EMPTY_BYTES,
              size: it.size,
              truncated: it.truncated,
              source: 'archive',
            }
          }
        } else {
          const buf = readInsideRoot(portsRootAbs, rel)
          if (buf !== null) {
            return {
              path: it.path,
              body: buf.toString('utf8'),
              bytes: buf,
              size: it.size,
              truncated: it.truncated,
              source: 'archive',
            }
          }
        }
      }
      // file null（超限二进制）或归档副本丢失 → worktree 回退（容器相对 path）。
      if (opts.fallbackWorktreeRoot !== null) {
        if (!wantBytes(idx)) {
          if (existsInsideRoot(opts.fallbackWorktreeRoot, it.path)) {
            return {
              path: it.path,
              body: '',
              bytes: EMPTY_BYTES,
              size: it.size,
              truncated: false,
              source: 'worktree',
            }
          }
        } else {
          const buf = readInsideRoot(opts.fallbackWorktreeRoot, it.path)
          if (buf !== null) {
            return {
              path: it.path,
              body: buf.toString('utf8'),
              bytes: buf,
              size: it.size,
              truncated: false,
              source: 'worktree',
            }
          }
        }
      }
      return {
        path: it.path,
        body: '',
        bytes: EMPTY_BYTES,
        size: it.size,
        truncated: it.truncated,
        source: 'missing',
      }
    })
    return { items }
  }

  // 存量行（archive_json NULL）：content 即路径文本，行为与 RFC-193 之前的
  // 消费方一致（join(root, line)），只是 root 现在由调用方给对（scopeRoot）。
  const parsed = opts.kind !== null ? tryParseKind(opts.kind) : null
  const isPathish =
    parsed !== null &&
    (parsed.kind === 'path' || (parsed.kind === 'list' && parsed.item.kind === 'path'))
  if (!isPathish) {
    // 非 path 形端口：content 本身就是 body（inline markdown / string）。
    const buf = Buffer.from(opts.content, 'utf8')
    return {
      items: [
        {
          path: null,
          body: opts.content,
          bytes: buf,
          size: buf.length,
          truncated: false,
          source: 'archive',
        },
      ],
    }
  }
  const lines = parsed.kind === 'list' ? splitListItems(opts.content) : [opts.content.trim()]
  // 存量行的 line 是 repo0 相对——容器根下补 dirName 前缀（单 repo '' 恒等）。
  const dirName = opts.legacyRepoDirName ?? ''
  const items = lines.map((line, idx): PortArtifactReadItem => {
    const containerRel = toContainerRelative(dirName, line)
    if (opts.fallbackWorktreeRoot !== null) {
      if (!wantBytes(idx)) {
        if (existsInsideRoot(opts.fallbackWorktreeRoot, containerRel)) {
          return {
            path: containerRel,
            body: '',
            bytes: EMPTY_BYTES,
            size: 0,
            truncated: false,
            source: 'worktree',
          }
        }
      } else {
        const buf = readInsideRoot(opts.fallbackWorktreeRoot, containerRel)
        if (buf !== null) {
          return {
            path: containerRel,
            body: buf.toString('utf8'),
            bytes: buf,
            size: buf.length,
            truncated: false,
            source: 'worktree',
          }
        }
      }
    }
    return {
      path: containerRel,
      body: '',
      bytes: EMPTY_BYTES,
      size: 0,
      truncated: false,
      source: 'missing',
    }
  })
  return { items }
}

const EMPTY_BYTES: Uint8Array = Buffer.alloc(0)

/** {@link readInsideRoot} 的存在性面（元数据模式——零字节读取）。 */
function existsInsideRoot(rootAbs: string, rel: string): boolean {
  const root = resolve(rootAbs)
  const target = isAbsolute(rel) ? resolve(rel) : resolve(root, rel)
  try {
    const lexicalInside = target === root || target.startsWith(root + sep)
    const realTarget = realpathSync(target)
    const realRoot = realpathSync(root)
    const realInside = realTarget === realRoot || realTarget.startsWith(realRoot + sep)
    if (!realInside) return false
    if (!lexicalInside && !isAbsolute(rel)) return false
    return statSync(realTarget).isFile()
  } catch {
    return false
  }
}

/** path 形 kind 判定（path<…> 或单层 list<path<…>>；markdown_file 折叠为 path<md>）。 */
export function isPathishKindString(kind: string | null | undefined): boolean {
  if (kind === null || kind === undefined) return false
  const parsed = tryParseKind(kind)
  return (
    parsed !== null &&
    (parsed.kind === 'path' || (parsed.kind === 'list' && parsed.item.kind === 'path'))
  )
}

/** 归档缺失时 review 的占位 body（沿用 RFC-079 文案锚，测试锁定）。 */
export function missingArtifactPlaceholder(path: string | null): string {
  return `> ⚠️ RFC-079: file not found in worktree: \`${path ?? '(unknown)'}\``
}

/**
 * RFC-193 D16 — 派生投影的归档子集：review 决策产物（approved_doc /
 * accepted）把上游 path 端口的路径（子集）转写成自己的 content，归档引用也要
 * 跟着来，否则这些行在 worktree GC 后照样 404。`wantPaths` 是决策产物的行
 * （repo0 相对，= doc_versions 的 sourceFilePath/itemPath）；上游 archive
 * items[].path 是容器相对——精确匹配优先，其次「/ 边界后缀」匹配吸收多
 * repo 前缀差。产出 items 按 wantPaths 序。全部不匹配 → null（回退链兜底）。
 */
export function subsetArchiveJson(
  upstreamArchiveJson: string | null,
  wantPaths: readonly string[],
): string | null {
  const arch = parseArchiveJson(upstreamArchiveJson)
  if (arch === null) return null
  const items: PortArchiveItem[] = []
  for (const want of wantPaths) {
    const hit =
      arch.items.find((i) => i.path === want) ?? arch.items.find((i) => i.path.endsWith('/' + want))
    if (hit !== undefined) items.push(hit)
  }
  return items.length > 0 ? JSON.stringify({ v: 1, items } satisfies PortArchive) : null
}

// ---------------------------------------------------------------------------
// K1 必达清单聚合（design §4.5 / D7）。
// ---------------------------------------------------------------------------

/**
 * 该任务迄今归档过的全部 path 端口源文件（容器相对，去重）。ignored 端口文件
 * 要跨节点存活必须过三跳（producer final 快照 → merge-back 落 canonical →
 * consumer base 快照），①③ 都是 add -A——所以每个全状态快照点都要带上这份
 * 清单 `add -f`。archive_json 本身就是持久化的清单（无需新列）；handle 为
 * per-node-run 短命对象，每次 dispatch 重建 ⇒ 清单天然最新（唯一长命例外
 * wrapper final 由调用方重聚合，design §4.5）。
 */
export async function forcedPortPathsForTask(db: DbClient, taskId: string): Promise<string[]> {
  const rows = await db
    .select({ archiveJson: nodeRunOutputs.archiveJson })
    .from(nodeRunOutputs)
    .innerJoin(nodeRuns, eq(nodeRunOutputs.nodeRunId, nodeRuns.id))
    .where(and(eq(nodeRuns.taskId, taskId), isNotNull(nodeRunOutputs.archiveJson)))
  const out = new Set<string>()
  for (const r of rows) {
    const arch = parseArchiveJson(r.archiveJson)
    if (arch === null) continue
    for (const it of arch.items) {
      out.add(it.path)
      // D19：symlink 目标随 item 持久化——重建的 roster 必须含目标，否则
      // 下游 base 快照只带链接本体、目标被 ignore 时得到悬挂 symlink。
      if (it.linkTarget !== undefined) out.add(it.linkTarget)
    }
  }
  return [...out]
}
