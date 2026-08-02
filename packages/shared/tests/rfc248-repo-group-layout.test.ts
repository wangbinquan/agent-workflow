// RFC-248 PR-1 — 仓库组纯布局代数的回归锁。
//
// 这份文件锁的是 design/RFC-248-repo-groups/design.md §1（概念模型 / 展平 /
// 挂载路径代数 / 包含关系）与 §3.3（分支序号）、§6.1（仓 key）里定死的语义。
// 之所以把这些抽成无 DB / 无 fs 的纯函数再单独锁：布局是**前端预览与后端物化
// 共用同一份**的东西，两边算出不同结果 = 用户看到的目录和真实跑出来的目录不一样。
//
// 几条断言的来历值得写明，免得未来 refactor 把它们改「顺手」了：
//   - `''` 与 `vendor/b` 共存必须**合法**：那正是「一个仓库是另一个仓库的子
//     目录」这条需求本身（D2 + 用户原话）。
//   - 环检测必须用**当前递归链**而不是全局 visited：同一个内层组被两个不同的
//     外层成员各引用一次是合法的（展平两次、落两个挂点）。
//   - `isUnder` 必须按**路径段边界**匹配：`a/bc` 不属于 `a/b`。纯 startsWith
//     会把它算成子节点，进而把排除规则写错、把 diff 前缀拆错。

import { describe, expect, test } from 'bun:test'
import {
  MAX_FLAT_REPOS,
  MAX_GROUP_DEPTH,
  RepoGroupLayoutError,
  UPLOAD_INPUTS_DIR,
  assertMountPathSet,
  assignBranchNames,
  containerOf,
  directChildren,
  exclusionPlanFor,
  flattenRepoGroup,
  isUnder,
  joinMountPath,
  mountDepth,
  normalizeMountPath,
  orderForMaterialize,
  parseRepoKeyWire,
  repoKeyWire,
  splitRepoPrefix,
  type FlattenableGroup,
} from '../src/index'

// ── 测试夹具 ────────────────────────────────────────────────────────────────

function repoMember(
  cachedRepoId: string,
  mountPath: string,
  extra: { ref?: string; subdir?: string; readonly?: boolean } = {},
) {
  return {
    kind: 'repo' as const,
    cachedRepoId,
    repoUrlRedacted: `https://git.example/${cachedRepoId}`,
    ref: extra.ref ?? '',
    subdir: extra.subdir ?? '',
    mountPath,
    readonly: extra.readonly ?? false,
  }
}

function groupMember(childGroupId: string, mountPath: string, readonly = false) {
  return { kind: 'group' as const, childGroupId, mountPath, readonly }
}

function loaderFor(...groups: FlattenableGroup[]) {
  const byId = new Map(groups.map((g) => [g.id, g]))
  return (id: string) => byId.get(id)
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (err instanceof RepoGroupLayoutError) return err.code
    return `unexpected:${String(err)}`
  }
  return 'no-throw'
}

// ── §1.2 挂载路径规范化 ─────────────────────────────────────────────────────

describe('normalizeMountPath', () => {
  test('空串合法——它就是「挂在根」', () => {
    expect(normalizeMountPath('')).toBe('')
  })

  test('折叠重复斜杠与尾斜杠', () => {
    expect(normalizeMountPath('vendor//sdk/')).toBe('vendor/sdk')
    expect(normalizeMountPath('a/b/c')).toBe('a/b/c')
  })

  test('拒绝绝对路径（含 Windows 盘符）', () => {
    expect(codeOf(() => normalizeMountPath('/etc'))).toBe('mount-path-absolute')
    expect(codeOf(() => normalizeMountPath('C:\\x'))).toBe('mount-path-absolute')
  })

  test('拒绝 . 与 .. 段——逃逸面，且 `.` 还是根仓的线上 key', () => {
    expect(codeOf(() => normalizeMountPath('..'))).toBe('mount-path-traversal')
    expect(codeOf(() => normalizeMountPath('a/../../etc'))).toBe('mount-path-traversal')
    expect(codeOf(() => normalizeMountPath('.'))).toBe('mount-path-traversal')
    expect(codeOf(() => normalizeMountPath('a/./b'))).toBe('mount-path-traversal')
  })

  test('拒绝 CR / LF / 反斜杠——它们会打断单行的 `# === Repo: X ===` 标记', () => {
    expect(codeOf(() => normalizeMountPath('a\nb'))).toBe('mount-path-unsafe-char')
    expect(codeOf(() => normalizeMountPath('a\rb'))).toBe('mount-path-unsafe-char')
    expect(codeOf(() => normalizeMountPath('a\\b'))).toBe('mount-path-unsafe-char')
  })

  test('拒绝 NUL 字节——C 层路径 API 会在它那里截断', () => {
    // `a\0/../..` 传到 git 就变成了 `a`，段级的 `..` 检查形同虚设。
    expect(codeOf(() => normalizeMountPath('a\0b'))).toBe('mount-path-unsafe-char')
    expect(codeOf(() => normalizeMountPath('a\0/../../etc'))).toBe('mount-path-unsafe-char')
  })

  test('Unicode 归一化到 NFC——否则 macOS 上两个「不同」的挂点会撞成一个', () => {
    // APFS/HFS+ 会归一化文件名：é (U+00E9) 与 é (U+0065 U+0301) 是同一个目录。
    // 不归一化的话精确字符串比较会放这两个挂点过去，磁盘上却撞车。
    //
    // **用码位显式构造**，不要在源文件里写两个肉眼相同的字面量——编辑器或
    // prettier 一旦把它们归一化成同一个串，这条测试就变成恒真的空测试。
    const nfc = `caf${String.fromCharCode(0xe9)}`
    const nfd = `cafe${String.fromCharCode(0x301)}`
    expect(nfc).not.toBe(nfd) // 前提：两者确实是不同的字节序列
    expect(normalizeMountPath(nfd)).toBe(nfc)
    expect(
      codeOf(() => assertMountPathSet([normalizeMountPath(nfc), normalizeMountPath(nfd)])),
    ).toBe('mount-path-duplicate')
  })

  test('全是斜杠的串归 absolute，绝不静默折叠成「挂根」', () => {
    // 静默降级成挂根是最坏的结果：用户以为写了个子目录，实际把整个 cwd 变成了
    // 那个仓。设计稿曾预留过一条 `mount-path-empty`，实现时证明不可达（非空且
    // 不以 '/' 开头的串必然至少有一个非空段），已删；这条锁住「不可达」这个前提。
    expect(codeOf(() => normalizeMountPath('///'))).toBe('mount-path-absolute')
    expect(codeOf(() => normalizeMountPath('/'))).toBe('mount-path-absolute')
    // 反面：任何合法的非空输入都折叠出非空结果。
    for (const s of ['a', 'a/', 'a//b', 'a/b/']) expect(normalizeMountPath(s)).not.toBe('')
  })
})

describe('assertMountPathSet', () => {
  test('空串挂点与 `vendor/b` 共存合法——这正是嵌套需求本身', () => {
    expect(() => assertMountPathSet(['', 'vendor/b'])).not.toThrow()
    expect(() => assertMountPathSet(['a', 'a/vendor/b', 'a/vendor/b/c'])).not.toThrow()
  })

  test('重复挂载点被拒', () => {
    expect(codeOf(() => assertMountPathSet(['a', 'a']))).toBe('mount-path-duplicate')
  })

  test('大小写不同但在 macOS 上会撞的挂载点也被拒', () => {
    // macOS 的 APFS/HFS+ 默认 case-insensitive：`Vendor` 与 `vendor` 在磁盘上是
    // 同一个目录，第二个 `git worktree add` 会撞 already exists 或覆盖第一个。
    // 组定义存在 DB 里、可以在 Linux 建而在 macOS 跑，所以两个平台都拒——只在
    // macOS 上拒会让同一个组「这台机器能跑、那台不能跑」。
    expect(codeOf(() => assertMountPathSet(['Vendor', 'vendor']))).toBe('mount-path-duplicate')
    expect(codeOf(() => assertMountPathSet(['a/B', 'a/b']))).toBe('mount-path-duplicate')
  })

  test('两个成员都挂根被拒（D2：至多一个），且报 multiple-roots 而不是 duplicate', () => {
    // 两条约束同时成立，但「至多一个成员可以挂在根」对用户更可操作——
    // `duplicate mount path:` 读起来像是路径写重了。故根计数先于重复检查。
    expect(codeOf(() => assertMountPathSet(['', '']))).toBe('mount-path-multiple-roots')
    expect(codeOf(() => assertMountPathSet(['', 'a', '']))).toBe('mount-path-multiple-roots')
  })
})

describe('joinMountPath', () => {
  test('内层组的「根成员」落在外层给该组的挂点上', () => {
    expect(joinMountPath('base', '')).toBe('base')
    expect(joinMountPath('', '')).toBe('')
  })

  test('逐层前缀拼接', () => {
    expect(joinMountPath('base', 'core')).toBe('base/core')
    expect(joinMountPath('', 'core')).toBe('core')
    expect(joinMountPath('a/b', 'c/d')).toBe('a/b/c/d')
  })
})

// ── §1.3 包含关系 ───────────────────────────────────────────────────────────

describe('isUnder / containerOf / directChildren', () => {
  test('按路径段边界匹配——`a/bc` 不属于 `a/b`', () => {
    // 纯 startsWith 会把 'a/bc' 当成 'a/b' 的子节点，于是排除规则写错、
    // diff 前缀也拆错。这条是本文件最容易被 refactor 破坏的断言。
    expect(isUnder('a/b', 'a/bc')).toBe(false)
    expect(isUnder('a/b', 'a/b/c')).toBe(true)
  })

  test('自己不是自己的容器', () => {
    expect(isUnder('a', 'a')).toBe(false)
  })

  test('挂根的仓包含其余一切', () => {
    expect(isUnder('', 'vendor/b')).toBe(true)
    expect(isUnder('', '')).toBe(false)
  })

  test('containerOf 取最长严格前缀', () => {
    const all = ['', 'vendor/sdk', 'vendor/sdk/ext']
    expect(containerOf('vendor/sdk/ext', all)).toBe('vendor/sdk')
    expect(containerOf('vendor/sdk', all)).toBe('')
    expect(containerOf('', all)).toBeNull()
  })

  test('没有仓挂根时，顶层挂点的容器是 null（落在普通父目录下）', () => {
    const all = ['frontend', 'backend', 'backend/vendor/x']
    expect(containerOf('frontend', all)).toBeNull()
    expect(containerOf('backend', all)).toBeNull()
    expect(containerOf('backend/vendor/x', all)).toBe('backend')
  })

  test('directChildren 只给直接子，不给孙子', () => {
    const all = ['', 'vendor/sdk', 'vendor/sdk/ext', 'site/docs']
    expect(directChildren('', all).sort()).toEqual(['site/docs', 'vendor/sdk'])
    expect(directChildren('vendor/sdk', all)).toEqual(['vendor/sdk/ext'])
    expect(directChildren('vendor/sdk/ext', all)).toEqual([])
  })
})

describe('exclusionPlanFor', () => {
  test('只排直接子，且路径相对该仓自己的工作树根', () => {
    const all = ['', 'vendor/sdk', 'vendor/sdk/ext', 'site/docs']
    // 根仓排它的两个直接子；`vendor/sdk/ext` 已在被排掉的子树里，不必重复排。
    expect(exclusionPlanFor('', all)).toEqual(['site/docs', 'vendor/sdk'])
    // sdk 自己仍要排 ext——它在 sdk 的工作树里。
    expect(exclusionPlanFor('vendor/sdk', all)).toEqual(['ext'])
    expect(exclusionPlanFor('vendor/sdk/ext', all)).toEqual([])
  })

  test('多仓任务里挂根的仓要连带排除上传目录（D12）', () => {
    expect(exclusionPlanFor('', ['', 'a'], { includeUploadDir: true })).toEqual([
      UPLOAD_INPUTS_DIR,
      'a',
    ])
    // 非根仓不加上传目录——上传物落在 cwd 根下，不在它工作树里。
    expect(exclusionPlanFor('a', ['', 'a', 'a/b'], { includeUploadDir: true })).toEqual(['b'])
  })
})

describe('mountDepth', () => {
  test('根为 0，其余按段数', () => {
    expect(mountDepth('')).toBe(0)
    expect(mountDepth('a')).toBe(1)
    expect(mountDepth('a/b/c')).toBe(3)
  })
})

// ── §1.1 展平 ───────────────────────────────────────────────────────────────

describe('flattenRepoGroup', () => {
  test('平铺组：原样展开，无内层组时 maxDepth=0', () => {
    const g: FlattenableGroup = {
      id: 'g1',
      name: '全栈',
      members: [repoMember('r-fe', 'frontend'), repoMember('r-be', 'backend')],
    }
    const { repos, maxDepth } = flattenRepoGroup('g1', loaderFor(g))
    expect(maxDepth).toBe(0)
    expect(repos.map((r) => r.mountPath)).toEqual(['frontend', 'backend'])
    expect(repos.every((r) => r.viaGroups.length === 1)).toBe(true)
  })

  test('挂根 + 嵌套 + 三层：挂载路径逐层前缀拼接', () => {
    const g: FlattenableGroup = {
      id: 'g1',
      name: 'app',
      members: [
        repoMember('r-app', ''),
        repoMember('r-sdk', 'vendor/sdk', { readonly: true }),
        repoMember('r-ext', 'vendor/sdk/ext'),
      ],
    }
    const { repos } = flattenRepoGroup('g1', loaderFor(g))
    expect(repos.map((r) => r.mountPath)).toEqual(['', 'vendor/sdk', 'vendor/sdk/ext'])
  })

  test('组套组：内层挂点被外层前缀重写，maxDepth 记实际深度', () => {
    const inner: FlattenableGroup = {
      id: 'g-base',
      name: '平台底座',
      members: [repoMember('r-core', ''), repoMember('r-proto', 'proto')],
    }
    const outer: FlattenableGroup = {
      id: 'g-order',
      name: '订单域',
      members: [repoMember('r-orders', ''), groupMember('g-base', 'base')],
    }
    const { repos, maxDepth } = flattenRepoGroup('g-order', loaderFor(outer, inner))
    expect(maxDepth).toBe(1)
    // 内层的「根成员」落在外层给它的挂点 `base` 上。
    expect(repos.map((r) => r.mountPath)).toEqual(['', 'base', 'base/proto'])
    expect(repos[1]?.viaGroups.map((v) => v.id)).toEqual(['g-order', 'g-base'])
  })

  test('D20 只读取并集：外层标只读 ⇒ 内层全部只读', () => {
    const inner: FlattenableGroup = {
      id: 'g-in',
      name: 'in',
      members: [repoMember('r-a', 'a'), repoMember('r-b', 'b', { readonly: true })],
    }
    const outer: FlattenableGroup = {
      id: 'g-out',
      name: 'out',
      members: [groupMember('g-in', 'vendor', true)],
    }
    const { repos } = flattenRepoGroup('g-out', loaderFor(outer, inner))
    expect(repos.map((r) => r.readonly)).toEqual([true, true])
  })

  test('D20 外层不标只读时，内层成员保持自己的标记（不被推翻成可写）', () => {
    const inner: FlattenableGroup = {
      id: 'g-in',
      name: 'in',
      members: [repoMember('r-a', 'a'), repoMember('r-b', 'b', { readonly: true })],
    }
    const outer: FlattenableGroup = {
      id: 'g-out',
      name: 'out',
      members: [groupMember('g-in', 'vendor', false)],
    }
    const { repos } = flattenRepoGroup('g-out', loaderFor(outer, inner))
    expect(repos.map((r) => r.readonly)).toEqual([false, true])
  })

  test('同一个内层组被两处引用**不是**环——展平两次落两个挂点', () => {
    // 这条锁的是「环检测必须用当前递归链而不是全局 visited」。用 visited
    // 集会把这个合法用法误判成环。
    const inner: FlattenableGroup = {
      id: 'g-lib',
      name: 'lib',
      members: [repoMember('r-lib', '')],
    }
    const outer: FlattenableGroup = {
      id: 'g-out',
      name: 'out',
      members: [groupMember('g-lib', 'a/lib'), groupMember('g-lib', 'b/lib')],
    }
    const { repos } = flattenRepoGroup('g-out', loaderFor(outer, inner))
    expect(repos.map((r) => r.mountPath)).toEqual(['a/lib', 'b/lib'])
  })

  test('自引用成环被拒', () => {
    const g: FlattenableGroup = { id: 'g1', name: 'g1', members: [groupMember('g1', 'x')] }
    expect(codeOf(() => flattenRepoGroup('g1', loaderFor(g)))).toBe('repo-group-cycle')
  })

  test('互引用成环被拒', () => {
    const a: FlattenableGroup = { id: 'a', name: 'a', members: [groupMember('b', 'b')] }
    const b: FlattenableGroup = { id: 'b', name: 'b', members: [groupMember('a', 'a')] }
    expect(codeOf(() => flattenRepoGroup('a', loaderFor(a, b)))).toBe('repo-group-cycle')
  })

  test(`嵌套深度超过 ${MAX_GROUP_DEPTH} 被拒`, () => {
    // 造一条 depth = MAX+1 的链：g0 → g1 → … → g(MAX+1)
    const groups: FlattenableGroup[] = []
    for (let i = 0; i <= MAX_GROUP_DEPTH + 1; i++) {
      groups.push({
        id: `g${i}`,
        name: `g${i}`,
        members:
          i === MAX_GROUP_DEPTH + 1 ? [repoMember('r', '')] : [groupMember(`g${i + 1}`, `l${i}`)],
      })
    }
    expect(codeOf(() => flattenRepoGroup('g0', loaderFor(...groups)))).toBe(
      'repo-group-depth-exceeded',
    )
  })

  test(`展平后超过 ${MAX_FLAT_REPOS} 个仓被拒（按展平后算，不是直接成员数）`, () => {
    const inner: FlattenableGroup = {
      id: 'g-in',
      name: 'in',
      members: Array.from({ length: 20 }, (_, i) => repoMember(`r${i}`, `r${i}`)),
    }
    const outer: FlattenableGroup = {
      id: 'g-out',
      name: 'out',
      // 直接成员只有 2 个，但展平后是 40 个 > 32。
      members: [groupMember('g-in', 'a'), groupMember('g-in', 'b')],
    }
    expect(codeOf(() => flattenRepoGroup('g-out', loaderFor(outer, inner)))).toBe(
      'repo-group-too-many-repos',
    )
  })

  test('引用不存在的组 ⇒ member-not-found', () => {
    const g: FlattenableGroup = { id: 'g1', name: 'g1', members: [groupMember('nope', 'x')] }
    expect(codeOf(() => flattenRepoGroup('g1', loaderFor(g)))).toBe('repo-group-member-not-found')
  })

  test('展平后的挂载点冲突会被集合级校验抓住', () => {
    const inner: FlattenableGroup = { id: 'g-in', name: 'in', members: [repoMember('r', '')] }
    const outer: FlattenableGroup = {
      id: 'g-out',
      name: 'out',
      // 两条都落到 `x`：一条来自内层组的根成员，一条是外层自己的仓。
      members: [groupMember('g-in', 'x'), repoMember('r2', 'x')],
    }
    expect(codeOf(() => flattenRepoGroup('g-out', loaderFor(outer, inner)))).toBe(
      'mount-path-duplicate',
    )
  })
})

describe('orderForMaterialize', () => {
  test('按挂载深度升序——外层必须先于内层建', () => {
    const planned = [
      { mountPath: 'vendor/sdk/ext' },
      { mountPath: '' },
      { mountPath: 'site/docs' },
      { mountPath: 'vendor/sdk' },
    ]
    expect(orderForMaterialize(planned).map((p) => p.mountPath)).toEqual([
      '',
      'site/docs',
      'vendor/sdk',
      'vendor/sdk/ext',
    ])
  })

  test('同深度保持展平序，让 repo_index 稳定可预期', () => {
    const planned = [{ mountPath: 'b' }, { mountPath: 'a' }, { mountPath: 'c' }]
    expect(orderForMaterialize(planned).map((p) => p.mountPath)).toEqual(['b', 'a', 'c'])
  })
})

// ── §3.3 分支序号（D14） ────────────────────────────────────────────────────

describe('assignBranchNames', () => {
  test('不同源仓共用同一个分支名——它们在不同的源仓里，不会撞', () => {
    const names = assignBranchNames([{ cachedRepoId: 'a' }, { cachedRepoId: 'b' }], 'T1')
    expect(names).toEqual(['agent-workflow/T1', 'agent-workflow/T1'])
  })

  test('同一个源仓出现多次 ⇒ 第 n 次带序号（否则撞 already checked out）', () => {
    const names = assignBranchNames(
      [{ cachedRepoId: 'a' }, { cachedRepoId: 'b' }, { cachedRepoId: 'a' }, { cachedRepoId: 'a' }],
      'T1',
    )
    expect(names).toEqual([
      'agent-workflow/T1',
      'agent-workflow/T1',
      'agent-workflow/T1-2',
      'agent-workflow/T1-3',
    ])
  })

  test('RFC-075 workingBranch 同样要带序号', () => {
    const names = assignBranchNames([{ cachedRepoId: 'a' }, { cachedRepoId: 'a' }], 'T1', 'feat/x')
    expect(names).toEqual(['feat/x', 'feat/x-2'])
  })
})

// ── §6.1 仓 key ─────────────────────────────────────────────────────────────

describe('repoKeyWire / parseRepoKeyWire', () => {
  test('根仓的线上形态是 `.`，往返无损', () => {
    expect(repoKeyWire('')).toBe('.')
    expect(parseRepoKeyWire('.')).toBe('')
    expect(repoKeyWire('vendor/b')).toBe('vendor/b')
    expect(parseRepoKeyWire('vendor/b')).toBe('vendor/b')
  })

  test('`.` 不可能与真实挂载路径冲突——normalizeMountPath 拒绝 `.` 段', () => {
    expect(codeOf(() => normalizeMountPath('.'))).toBe('mount-path-traversal')
  })
})

describe('splitRepoPrefix', () => {
  const keys = ['', 'vendor/sdk', 'vendor/sdk/ext', 'site/docs']

  test('最长前缀匹配——`vendor/sdk/ext/x.ts` 归 ext 而不是 sdk', () => {
    expect(splitRepoPrefix('vendor/sdk/ext/x.ts', keys)).toEqual(['vendor/sdk/ext', 'x.ts'])
    expect(splitRepoPrefix('vendor/sdk/lib/y.ts', keys)).toEqual(['vendor/sdk', 'lib/y.ts'])
  })

  test('根仓兜底：不匹配任何非空 key 的路径归根仓，且相对路径原样', () => {
    // 这条同时锁住「根仓不加前缀」——它必须与文本 diff 的 `src/a.ts` 逐字符相等。
    expect(splitRepoPrefix('src/a.ts', keys)).toEqual(['', 'src/a.ts'])
  })

  test('按段边界匹配：`site/docsx/a` 不属于 `site/docs`', () => {
    expect(splitRepoPrefix('site/docsx/a', keys)).toEqual(['', 'site/docsx/a'])
  })

  test('路径恰好等于挂载点本身 ⇒ 相对路径为空', () => {
    expect(splitRepoPrefix('vendor/sdk', keys)).toEqual(['vendor/sdk', ''])
  })

  test('key 集合里没有根仓时，未匹配路径仍归空串兜底（不抛）', () => {
    expect(splitRepoPrefix('whatever/x', ['a', 'b'])).toEqual(['', 'whatever/x'])
  })
})
