// RFC-287 G6 —— git 失败分类的判据表。
//
// 这张表决定「抖一下就好」与「你写错了」的分界：判错前者代价是白等一个 60s 窗口
// 再报同一个错，判错后者代价是把可恢复的抖动变成硬失败。所以两类都要有正例，
// 且**顺序**（先判 permanent）必须单独锁——真实 stderr 常同时含两类词。

import { describe, expect, test } from 'bun:test'
import { classifyGitFailure, isRetryableGitFailure } from '../src/gitFailureClass'

describe('RFC-287 G6 — git 失败分类', () => {
  test('网络/瞬时类判可重试', () => {
    for (const s of [
      'fatal: unable to access: Failed to connect to example.com port 443: Connection timed out',
      'ssh: connect to host git.example.com port 22: Connection refused',
      'fatal: unable to access: Could not resolve host: git.example.com',
      'error: RPC failed; curl 56 Recv failure: Connection reset by peer',
      'fatal: the remote end hung up unexpectedly',
      'error: 503 Service Unavailable',
      'git timed out after 30000ms (killed)',
    ]) {
      expect(classifyGitFailure(s), s.slice(0, 40)).toBe('retryable-network')
      expect(isRetryableGitFailure(s)).toBe(true)
    }
  })

  test('鉴权/不存在/无权限判永久——立刻失败、不占窗口', () => {
    for (const s of [
      'remote: Invalid username or password.\nfatal: Authentication failed for https://…',
      'ERROR: Repository not found.',
      'remote: Permission denied to user',
      'fatal: could not read Username for https://…: terminal prompts disabled',
      "fatal: couldn't find remote ref refs/heads/nope",
      'remote: HTTP Basic: Access denied\nfatal: 403 Forbidden',
      'Host key verification failed.',
    ]) {
      expect(classifyGitFailure(s), s.slice(0, 40)).toBe('permanent')
      expect(isRetryableGitFailure(s)).toBe(false)
    }
  })

  test('两类词同时出现时**先判 permanent**（顺序不可换）', () => {
    // 真实形态：认证失败时 git 常先报一句连接诊断，再报 Authentication failed。
    // 若先判网络，这类失败会被白白重试满一个窗口才报同一个错。
    const mixed =
      'fatal: unable to access https://git.example.com/x.git/: Failed to connect to proxy\n' +
      'remote: Invalid username or password.\nfatal: Authentication failed'
    expect(classifyGitFailure(mixed)).toBe('permanent')
  })

  test('认不出来的按不可重试处理（宁可早报错，不白等窗口）', () => {
    expect(classifyGitFailure('fatal: something entirely new')).toBe('unknown')
    expect(isRetryableGitFailure('fatal: something entirely new')).toBe(false)
    expect(classifyGitFailure('')).toBe('unknown')
  })
})

// 实现门自审沉淀 —— 14 类**真实 git 失败措辞**的判定表。
//
// 这些措辞原本只活在一次性探针脚本里，探完就没了；沉淀成用例后，将来任何人改
// 特征词表都要先面对它们。表里刻意包含「判 unknown 因而不重试」的一档：那不是
// 遗漏，是**刻意的保守默认**——磁盘满、只读文件系统、对象损坏、目录已存在、
// LFS 缺失，重试一万次也一样，让用户立刻看到错误远好过白等一个 60s 窗口。
describe('RFC-287 G6 — 真实 git 失败措辞判定表（自审沉淀）', () => {
  const TABLE: Array<[string, string, 'retryable-network' | 'permanent' | 'unknown']> = [
    [
      '私有仓无凭据(HTTPS)',
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      'permanent',
    ],
    [
      'SSH 无权限',
      'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
      'permanent',
    ],
    [
      '仓库不存在',
      'ERROR: Repository not found.\nfatal: Could not read from remote repository.',
      'permanent',
    ],
    ['分支不存在', "fatal: couldn't find remote ref refs/heads/nope", 'permanent'],
    [
      '服务端 500',
      'error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500',
      'retryable-network',
    ],
    [
      'DNS 临时失败',
      'fatal: unable to access: Could not resolve host: git.example.com',
      'retryable-network',
    ],
    ['大仓 pack 中断', 'fatal: early EOF\nfatal: index-pack failed', 'retryable-network'],
    // 以下五类判 unknown ⇒ 不重试。**这是刻意的**，不是特征词漏了。
    ['磁盘满', 'fatal: write error: No space left on device', 'unknown'],
    [
      '只读文件系统',
      'fatal: could not create leading directories: Read-only file system',
      'unknown',
    ],
    [
      '目录已存在',
      "fatal: destination path 'x' already exists and is not an empty directory.",
      'unknown',
    ],
    [
      '对象损坏',
      'error: object file .git/objects/ab/cd is empty\nfatal: loose object abcd is corrupt',
      'unknown',
    ],
    ['LFS 缺失', 'Error downloading object: x (abc): Smudge error', 'unknown'],
  ]

  test.each(TABLE)('%s → %s', (_name, stderr, expected) => {
    expect(classifyGitFailure(stderr)).toBe(expected)
  })

  // T14 实现门实测出的**双向误判**：真实 git-over-HTTPS 里最高频的瞬时态其实是
  // 纯数字形态（curl 只回 `The requested URL returned error: 503`，不带 reason
  // phrase）。原表只认「503 Service Unavailable」这种带短语的写法，于是最该重试的
  // 那一类反而落进 unknown ⇒ 直接硬失败，G6 对它形同虚设。反方向同样错：git 报
  // 体积过大时原话是 `error: RPC failed; HTTP 413 …`，`rpc failed` 抢先命中网络组
  // 把它判成可重试，于是一个永远不会成功的请求要白耗满整个窗口。
  describe('数字态 HTTP 状态码（实现门实测的双向误判）', () => {
    const NUMERIC: Array<[string, string, 'retryable-network' | 'permanent']> = [
      [
        '503 无 reason phrase',
        'fatal: unable to access: The requested URL returned error: 503',
        'retryable-network',
      ],
      [
        '500 无 reason phrase',
        'fatal: unable to access: The requested URL returned error: 500',
        'retryable-network',
      ],
      [
        '429 限流应退避',
        'fatal: unable to access: The requested URL returned error: 429',
        'retryable-network',
      ],
      ['空回复', 'fatal: unable to access: Empty reply from server', 'retryable-network'],
      [
        '413 体积过大不该重试',
        'error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413',
        'permanent',
      ],
      ['404 数字态', 'fatal: unable to access: The requested URL returned error: 404', 'permanent'],
      [
        '403 数字态',
        'error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403',
        'permanent',
      ],
    ]
    test.each(NUMERIC)('%s → %s', (_n, stderr, expected) => {
      expect(classifyGitFailure(stderr)).toBe(expected)
    })

    // 4xx 判永久靠的是负向前瞻排除 429；这条锁住「别顺手把 429 一起扫进去」。
    test('4xx 归永久时必须放过 429（否则限流退避直接失效）', () => {
      expect(classifyGitFailure('HTTP 429')).toBe('retryable-network')
      expect(classifyGitFailure('HTTP 400')).toBe('permanent')
    })
  })

  test('HTTP 407 代理认证按不重试处理（已知的可讨论边界）', () => {
    // 企业网里它既可能是「代理凭据配错」（永久）也可能是「代理临时抽风」（可重试）。
    // 现取不重试：用户立刻看到错误，好过白等 60s 才得到同一个结论。这条单独立用例
    // 是为了让将来改判据的人**知道自己在改一个已被权衡过的选择**，而不是补漏。
    expect(
      classifyGitFailure(
        'fatal: unable to access: Received HTTP code 407 from proxy after CONNECT',
      ),
    ).not.toBe('retryable-network')
  })
})

// 三轮门（Codex 契约面半场）实测出来的漏判：语境词与状态码之间**有版本号**时全线失配。
//
// 为什么这是真缺陷而不是理论问题：curl / git 报 HTTP 错误的主流原话就带版本
// ——`Received HTTP/1.1 407 …`、`returned error: HTTP/2 429`。原正则写死一个空格
// （`\bhttp (?:code )?5\d\d\b`），于是 `HTTP/2 429` 判 unknown ⇒ **不进退避窗口**，
// G6 对「服务端让你慢点」这一最该退避的情形直接失效。
describe('RFC-287 G6 —— 带版本号的 HTTP 状态行同样要认', () => {
  test('HTTP/1.1 与 HTTP/2 形态的 5xx / 429 进网络组', () => {
    for (const s of [
      'fatal: unable to access https://x/y.git/: The requested URL returned error: HTTP/2 429',
      'fatal: unable to access: HTTP/2 503',
      'fatal: unable to access: Received HTTP/1.1 502 Bad Gateway',
    ]) {
      expect(classifyGitFailure(s), s).toBe('retryable-network')
    }
  })

  test('带版本号的 4xx（429 除外）仍归 permanent，不白耗窗口', () => {
    for (const s of [
      'fatal: unable to access: Received HTTP/1.1 404 Not Found',
      'fatal: unable to access: Received HTTP/2 400 Bad Request',
    ]) {
      expect(classifyGitFailure(s), s).toBe('permanent')
    }
  })

  test('代理鉴权归 permanent（部署配置问题，重试无益）', () => {
    expect(
      classifyGitFailure(
        'fatal: unable to access: Received HTTP/1.1 407 Proxy Authentication Required',
      ),
    ).toBe('permanent')
  })

  test('回归：既有的无版本形态与 413 优先级一字不变', () => {
    // 放宽版本号不得把老形态带偏。
    expect(classifyGitFailure('error: RPC failed; HTTP 502 curl 22')).toBe('retryable-network')
    expect(classifyGitFailure('fatal: The requested URL returned error: 429')).toBe(
      'retryable-network',
    )
    // 413 同时命中 `rpc failed`（网络组）与 4xx（permanent 组），必须仍是 permanent
    // ——否则一个永远不会成功的 push 会白耗满窗口（T14 实现门的老教训）。
    expect(classifyGitFailure('error: RPC failed; HTTP 413 Payload Too Large')).toBe('permanent')
  })
})
