// RFC-248 回归锁 —— 扇出分片的 `shard_key` 必须带仓的挂载路径前缀。
//
// 为什么（design/RFC-248-repo-groups/design.md §6.5，AC-20）：
// 多仓 `git_diff` 是「每仓一段、段首 `# === Repo: <keyWire> ===`」拼起来的。
// 若解析器不认这个标记，两个仓里的同名文件会产出**同一个 shard_key**，聚合时
// 按 shard_key 字典序合并就把两个仓的内容串到一起；per-directory 分片下更糟，
// 两个仓的 `src/` 会被合并成一个分片交给同一个 agent。
//
// 另一半同样重要：**单仓 diff 不含任何分段头**，此时游标保持空串、路径原样
// ——`diff-split.test.ts` 那 13 条老断言就是这条的 baseline 锁。

import { describe, expect, test } from 'bun:test'
import {
  parseDiff,
  splitDiffPerDirectory,
  splitDiffPerFile,
  splitDiffPerNFiles,
} from '@/util/diffSplit'

/** 造一个最小的单文件 diff 块。 */
function fileDiff(path: string, body = '+x'): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 111..222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    body,
  ].join('\n')
}

/** 多仓拼接形态：每仓一段、段首带标记。 */
function multiRepoDiff(sections: Array<{ keyWire: string; files: string[] }>): string {
  return sections
    .map((s) => [`# === Repo: ${s.keyWire} ===`, ...s.files.map((f) => fileDiff(f))].join('\n'))
    .join('\n')
}

describe('parseDiff 的仓前缀游标', () => {
  test('单仓（无分段头）⇒ 路径原样，字节级 baseline', () => {
    const files = parseDiff(fileDiff('src/a.ts'))
    expect(files.map((f) => f.path)).toEqual(['src/a.ts'])
    expect(files.map((f) => f.oldPath)).toEqual(['src/a.ts'])
  })

  test('多仓 ⇒ 每段的路径带该段的挂载路径前缀', () => {
    const diff = multiRepoDiff([
      { keyWire: '.', files: ['src/a.ts'] },
      { keyWire: 'vendor/b', files: ['lib/bar.rs'] },
    ])
    expect(parseDiff(diff).map((f) => f.path)).toEqual(['src/a.ts', 'vendor/b/lib/bar.rs'])
  })

  test('根仓的 `.` 映射回空前缀——路径必须与文本 diff 逐字符相等', () => {
    // 若写成 './src/a.ts' 或 '/src/a.ts'，前端靠路径相等 join 结构化 diff 就会
    // 静默脱节（这正是设计门 G3 抓到的那类问题）。
    const diff = multiRepoDiff([{ keyWire: '.', files: ['src/a.ts'] }])
    expect(parseDiff(diff)[0]?.path).toBe('src/a.ts')
  })

  test('rename 的 oldPath 同样带前缀', () => {
    const diff = [
      '# === Repo: vendor/b ===',
      'diff --git a/old.ts b/new.ts',
      'similarity index 90%',
      'rename from old.ts',
      'rename to new.ts',
    ].join('\n')
    const [f] = parseDiff(diff)
    expect(f?.oldPath).toBe('vendor/b/old.ts')
    expect(f?.path).toBe('vendor/b/new.ts')
  })

  test('分段头出现在上一段最后一个文件块之后 ⇒ 该块先被 flush，标记不被吞进去', () => {
    const diff = multiRepoDiff([
      { keyWire: 'a', files: ['x.ts'] },
      { keyWire: 'b', files: ['y.ts'] },
    ])
    const files = parseDiff(diff)
    expect(files).toHaveLength(2)
    expect(files[0]?.raw).not.toContain('# === Repo:')
    expect(files[1]?.raw).not.toContain('# === Repo:')
  })

  test('文件内容里出现同形文本**不会**被误当成分段头', () => {
    // 想象一个 markdown 文件正在文档化这个格式本身。在 unified diff 里，任何
    // 文件内容行都带 `+` / `-` / ` ` 前缀，所以 `^# === Repo:` 永远匹配不到内容
    // 行——这条锁住这个安全前提。它一旦破了，后续文件会被归错仓，扇出分片把
    // 一个仓的文件发给另一个仓的 agent。
    const diff = [
      '# === Repo: real ===',
      'diff --git a/doc.md b/doc.md',
      '--- a/doc.md',
      '+++ b/doc.md',
      '@@ -1,2 +1,3 @@',
      ' # === Repo: context-line ===', // 上下文行：前导空格
      '+# === Repo: added-line ===', // 新增行：前导 +
      '-# === Repo: removed-line ===', // 删除行：前导 -
      'diff --git a/after.ts b/after.ts',
      '--- a/after.ts',
      '+++ b/after.ts',
      '@@ -1 +1 @@',
      '+x',
    ].join('\n')
    // 两个文件都必须仍归 `real`——没有任何一行内容切走了游标。
    expect(parseDiff(diff).map((f) => f.path)).toEqual(['real/doc.md', 'real/after.ts'])
  })

  test('三个仓（含三层嵌套挂点）各自前缀正确', () => {
    const diff = multiRepoDiff([
      { keyWire: '.', files: ['src/main.ts'] },
      { keyWire: 'vendor/sdk', files: ['lib/sdk.ts'] },
      { keyWire: 'vendor/sdk/ext', files: ['ext/plug.ts'] },
    ])
    expect(parseDiff(diff).map((f) => f.path)).toEqual([
      'src/main.ts',
      'vendor/sdk/lib/sdk.ts',
      'vendor/sdk/ext/ext/plug.ts',
    ])
  })
})

describe('三种分片策略都带前缀', () => {
  const diff = multiRepoDiff([
    { keyWire: '.', files: ['src/a.ts', 'src/b.ts'] },
    { keyWire: 'vendor/b', files: ['src/a.ts'] },
  ])

  test('per-file：两个仓里的同名文件产出**不同**的 shard_key', () => {
    // 不带前缀的话两条都是 `src/a.ts`，聚合时按 shard_key 合并就串仓了。
    const keys = splitDiffPerFile(diff).map((s) => s.shardKey)
    expect(keys).toContain('src/a.ts')
    expect(keys).toContain('vendor/b/src/a.ts')
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('per-n-files：分片内的 files 列表也是带前缀的路径', () => {
    const shards = splitDiffPerNFiles(diff, 3)
    expect(shards).toHaveLength(1)
    expect(shards[0]?.files).toEqual(['src/a.ts', 'src/b.ts', 'vendor/b/src/a.ts'])
  })

  test('per-directory：两个仓的同名目录不被合并成一个分片', () => {
    // depth=1 时根仓的 `src` 与 vendor/b 的 `src` 若都算成 `src`（即分组键不带
    // 仓前缀），两个仓的文件就会被交给同一个 agent，跨仓审计上下文直接混在一起。
    // 注意 shardKey 本身是「桶内最小路径」而非分组键（`shardKeyOf`），所以这里
    // 断言的是**分桶结果**而不是键的字面值。
    const shards = splitDiffPerDirectory(diff, 1)
    expect(shards).toHaveLength(2)
    const buckets = shards.map((s) => s.files)
    expect(buckets).toContainEqual(['src/a.ts', 'src/b.ts']) // 根仓自己一桶
    expect(buckets).toContainEqual(['vendor/b/src/a.ts']) // 嵌套仓自己一桶
    // 决定性断言：没有任何一个分片同时含两个仓的文件。
    for (const files of buckets) {
      const repos = new Set(files.map((f) => (f.startsWith('vendor/b/') ? 'vendor/b' : '')))
      expect(repos.size).toBe(1)
    }
  })

  test('per-directory depth=2：嵌套仓按它自己的挂点成桶', () => {
    const shards = splitDiffPerDirectory(diff, 2)
    // 根仓两个文件各自成桶（`src/a.ts` 只有两段，dirPrefix 原样返回）；
    // 嵌套仓的 `vendor/b/src/a.ts` 归到 `vendor/b` 这一桶。
    expect(shards.map((s) => s.files).sort()).toEqual([
      ['src/a.ts'],
      ['src/b.ts'],
      ['vendor/b/src/a.ts'],
    ])
  })
})
