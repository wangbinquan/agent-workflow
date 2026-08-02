// Split a unified git diff into shards for multi-process node fan-out
// (P-3-01). Three strategies match the design.md ShardingStrategy enum:
//
//   - per-file        : one shard per file diff. Renames stay together.
//   - per-n-files     : group files in chunks of N (final chunk may be smaller).
//   - per-directory   : group by the first `depth` path components (default 1).
//
// Binary files are NOT included in the shard content — diffing them per
// shard would be wasteful and they're rarely auditable. Instead they're
// listed once as a footer note appended to each shard:
//
//     binary files: a.png, b.bin
//
// Renames are a single FileDiff with both `oldPath` and `newPath`. Pure
// mode changes (no content) are also one shard.

export interface FileDiff {
  /** Header line starting with `diff --git`. */
  header: string
  /** All lines for this file, including the header. */
  raw: string
  /** Path on the `b/` side (or `a/` side for deletes). */
  path: string
  /** Old path for renames. Equal to `path` otherwise. */
  oldPath: string
  /** True when the diff contains binary patch hunks (or only metadata). */
  binary: boolean
}

export interface Shard {
  /** Stable identifier used for ordering + tagging child node_runs. */
  shardKey: string
  /** Diff content delivered to the child node. May be empty when only
   *  binary files match this shard. */
  content: string
  /** Files included in this shard (paths, not full diffs). */
  files: string[]
}

const DIFF_HEAD_RE = /^diff --git a\/(.+?) b\/(.+)$/

/**
 * RFC-248 — 多仓 `git_diff` 的仓分段标记。文本 diff 把每个仓拼成一段，段首是
 * `# === Repo: <keyWire> ===`（`keyWire` 是挂载路径，根仓写 `.`）。
 *
 * 解析时用它切换「当前仓」游标，并把该段里的路径前缀成 `<挂载路径>/<仓内路径>`
 * ——这样扇出分片的 `shard_key` 与 agent 在磁盘上看到的路径一致（`cd` 就到位），
 * 而且两个仓里的同名目录在 per-directory 分片下不会被合并成一个分片。
 *
 * 单仓任务的 diff **不含**任何分段头，游标保持空串，路径原样——与今天字节级一致。
 */
const REPO_MARKER_RE = /^# === Repo: (.+) ===$/

function joinRepoPrefix(repoKey: string, path: string): string {
  return repoKey === '' ? path : `${repoKey}/${path}`
}

/**
 * Parse a unified diff into per-file blocks. The parser is tolerant of
 * leading text before the first `diff --git` line (it gets dropped).
 *
 * RFC-248: `# === Repo: X ===` 分段头会切换仓前缀游标（见 `REPO_MARKER_RE`）。
 */
export function parseDiff(diff: string): FileDiff[] {
  const out: FileDiff[] = []
  let repoKey = ''
  let current: { header: string; buf: string[]; path: string; oldPath: string } | null = null

  function flush() {
    if (current === null) return
    const raw = current.buf.join('\n')
    out.push({
      header: current.header,
      raw,
      path: current.path,
      oldPath: current.oldPath,
      binary: isBinary(raw),
    })
    current = null
  }

  for (const line of diff.split('\n')) {
    // 仓分段头必须先于 diff 头判定：它出现在两个仓的 diff 之间，此时上一个仓的
    // 最后一个文件块还开着，必须 flush 掉再换游标，否则会把标记行吞进上一块。
    const rm = REPO_MARKER_RE.exec(line)
    if (rm !== null) {
      flush()
      const wire = rm[1] ?? '.'
      repoKey = wire === '.' ? '' : wire
      continue
    }
    const m = DIFF_HEAD_RE.exec(line)
    if (m !== null) {
      flush()
      const [, a, b] = m
      current = {
        header: line,
        buf: [line],
        path: joinRepoPrefix(repoKey, b ?? a ?? ''),
        oldPath: joinRepoPrefix(repoKey, a ?? ''),
      }
      continue
    }
    if (current !== null) current.buf.push(line)
  }
  flush()
  return out
}

function isBinary(raw: string): boolean {
  // git emits `Binary files a/x and b/y differ` for binary patches; with
  // --binary flag it also emits `GIT binary patch` for the real bytes.
  return raw.includes('Binary files ') || raw.includes('GIT binary patch')
}

// ---------------------------------------------------------------------------
// Three sharding strategies
// ---------------------------------------------------------------------------

export interface SplitOptions {
  /** When false, the binary-files note is omitted entirely. Default true. */
  appendBinaryNote?: boolean
}

export function splitDiffPerFile(diff: string, opts: SplitOptions = {}): Shard[] {
  return groupShards(parseDiff(diff), (files) => files.map((f) => [f]), opts)
}

export function splitDiffPerNFiles(diff: string, n: number, opts: SplitOptions = {}): Shard[] {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`splitDiffPerNFiles: n must be a positive integer, got ${n}`)
  }
  return groupShards(
    parseDiff(diff),
    (files) => {
      const out: FileDiff[][] = []
      for (let i = 0; i < files.length; i += n) out.push(files.slice(i, i + n))
      return out
    },
    opts,
  )
}

export function splitDiffPerDirectory(
  diff: string,
  depth: number = 1,
  opts: SplitOptions = {},
): Shard[] {
  if (!Number.isInteger(depth) || depth < 1) {
    throw new Error(`splitDiffPerDirectory: depth must be >= 1, got ${depth}`)
  }
  return groupShards(
    parseDiff(diff),
    (files) => {
      const groups = new Map<string, FileDiff[]>()
      for (const f of files) {
        const key = dirPrefix(f.path, depth)
        const arr = groups.get(key) ?? []
        arr.push(f)
        groups.set(key, arr)
      }
      // Stable order: sort by group key ascending so shard_key dictionary
      // order in the aggregator matches the input.
      return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v)
    },
    opts,
  )
}

function dirPrefix(path: string, depth: number): string {
  const segs = path.split('/')
  if (segs.length <= depth) return path
  return segs.slice(0, depth).join('/')
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function groupShards(
  files: FileDiff[],
  group: (files: FileDiff[]) => FileDiff[][],
  opts: SplitOptions,
): Shard[] {
  const textFiles = files.filter((f) => !f.binary)
  const binFiles = files.filter((f) => f.binary)
  const groups = group(textFiles)
  // Binary file footer: appended to every shard when there are any binary
  // files in the parent diff. Keeps audit-style agents aware they were
  // skipped without forcing them to splice patches themselves.
  const appendBin = opts.appendBinaryNote !== false
  const binNote =
    appendBin && binFiles.length > 0
      ? `\n\nbinary files: ${binFiles.map((f) => f.path).join(', ')}`
      : ''

  return groups.map((bucket) => {
    const files = bucket.map((f) => f.path)
    const content = bucket.map((f) => f.raw).join('\n') + binNote
    return {
      shardKey: shardKeyOf(bucket),
      content,
      files,
    }
  })
}

function shardKeyOf(bucket: FileDiff[]): string {
  if (bucket.length === 0) return '__empty__'
  if (bucket.length === 1) return bucket[0]!.path
  // Stable key: smallest path in the bucket. Aggregator sorts by shard_key
  // dictionary order so this matches per-file output ordering.
  return [...bucket].map((f) => f.path).sort()[0]!
}
