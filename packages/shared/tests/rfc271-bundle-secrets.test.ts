// RFC-271 T6 —— 脱敏投影的锁。
//
// **承重断言是「脱敏后仍过各自的严格 schema」**（AC-6）。这条正是 dump 投影栽的
// 地方（R2-D1）：`projectMcpForDump` 输出的 `oauth` 是字符串、URL 被追加了说明
// 文字、argv 被改成 `‹redacted›-arg-N` —— 三样都让产物过不了 `McpRemoteConfigSchema`
// 或者导入后跑不起来。
//
// 只断言「与某个既有脱敏函数一致」是没用的：那只会把同一份不完整集合锁死。
// 所以这里**逐 carrier** 验证，并对每个 carrier 追加一条 schema 复核。

// ⚠️ 夹具**一律不用真实厂商前缀**（ghp_ / glpat- 等）：gitleaks 扫的是**全部 git
// 历史**，一旦提交进去，改当前文件消不掉历史里的那一条，只能靠 .gitleaksignore
// 的 fingerprint 钉住——代价远大于换个字符串。判据走键名与熵，与前缀无关。
// （docs/dev-gotchas.md 已记这条；本文件初版仍踩了，故在此就地留注。）

import { describe, expect, test } from 'bun:test'
import { McpLocalConfigSchema, McpRemoteConfigSchema } from '../src/schemas/mcp'
import {
  encodePackageSecretFieldSegments,
  PACKAGE_SECRET_PLACEHOLDER,
  redactArgv,
  redactFreeJson,
  redactPluginSpec,
  redactRecord,
  redactUrlKeepingShape,
  type RedactionSink,
} from '../src/bundle/secrets'

const sink = (): RedactionSink => ({ resourceType: 'mcp', resourceName: 'github', found: [] })

describe('carrier · env / headers —— 键保留、值收敛', () => {
  test('值全部收敛且逐条进 secrets 索引', () => {
    const s = sink()
    const out = redactRecord({ GITHUB_TOKEN: 'FAKE_TOKEN_VALUE', MODE: 'prod' }, s, 'config.env')
    expect(out).toEqual({
      GITHUB_TOKEN: PACKAGE_SECRET_PLACEHOLDER,
      // ⚠️ 连 MODE 也收敛：一个叫 MODE 的环境变量同样可能装着 token，
      // 键名判据对它无能为力，而 env 整体就是公认的密钥载体。
      MODE: PACKAGE_SECRET_PLACEHOLDER,
    })
    expect(s.found.map((f) => f.field)).toEqual(['config.env.GITHUB_TOKEN', 'config.env.MODE'])
  })

  test('脱敏后仍过 McpLocalConfigSchema', () => {
    const s = sink()
    const config = { command: ['tool'], env: redactRecord({ T: 'x' }, s, 'config.env') }
    expect(McpLocalConfigSchema.safeParse(config).success).toBe(true)
  })
})

describe('carrier · argv —— 只换命中的那一个，结构与长度不变', () => {
  test('--token=<高熵> 只换值、保留键与 argv 长度', () => {
    const s = sink()
    // gitleaks:allow — 合成夹具，验证 argv 只换命中项
    const out = redactArgv(
      ['mcp-server', '--port', '8080', '--token=FAKEtok_A1b2C3d4E5f6G7h8I9j0K'],
      s,
    )
    // ⚠️ dump 投影会把 argv[1..] 全改成 ‹redacted›-arg-N —— 那会摧毁真实命令。
    expect(out[0]).toBe('mcp-server')
    expect(out[1]).toBe('--port')
    expect(out[2]).toBe('8080')
    expect(out[3]).toBe(`--token=${PACKAGE_SECRET_PLACEHOLDER}`)
    expect(out).toHaveLength(4)
  })

  test('--token value / --password value 分离式 flag 只替换 value 槽', () => {
    const s = sink()
    const out = redactArgv(
      ['mcp-server', '--token', 'short-token', '--password', 'pw', '--port', '8080'],
      s,
    )

    expect(out).toEqual([
      'mcp-server',
      '--token',
      PACKAGE_SECRET_PLACEHOLDER,
      '--password',
      PACKAGE_SECRET_PLACEHOLDER,
      '--port',
      '8080',
    ])
    expect(s.found.map((ref) => ref.field)).toEqual(['config.command[2]', 'config.command[4]'])
  })

  test('分离式敏感 flag 缺值或下一项仍是 flag 时不误杀，普通 port 原样', () => {
    const s = sink()
    const out = redactArgv(
      [
        'mcp-server',
        '--token',
        '--verbose',
        '--password',
        '--port',
        '8080',
        '--monkey',
        'banana',
        '--secret',
        '--',
        '--password',
        'positional',
      ],
      s,
    )

    expect(out).toEqual([
      'mcp-server',
      '--token',
      '--verbose',
      '--password',
      '--port',
      '8080',
      '--monkey',
      'banana',
      '--secret',
      '--',
      '--password',
      'positional',
    ])
    expect(s.found).toEqual([])
  })

  test('executable 本身永不收敛', () => {
    const s = sink()
    expect(redactArgv(['/usr/local/bin/foo'], s)[0]).toBe('/usr/local/bin/foo')
    expect(s.found).toHaveLength(0)
  })

  test('脱敏后仍过 McpLocalConfigSchema（command 至少一个元素）', () => {
    const s = sink()
    // gitleaks:allow — 同上
    const config = { command: redactArgv(['tool', '--token=FAKEtok_A1b2C3d4E5f6G7h8I9j0K'], s) }
    expect(McpLocalConfigSchema.safeParse(config).success).toBe(true)
  })
})

describe('carrier · URL —— 换值但仍是合法 http URL', () => {
  test('userinfo 被整段剥掉（不塞占位符——那会被 percent-encode）', () => {
    const s = sink()
    const out = redactUrlKeepingShape('https://user:pw@example.com/sse', s, 'config.url')
    expect(out.startsWith('https://')).toBe(true)
    expect(out).not.toContain('user')
    expect(out).not.toContain('pw@')
    // 占位符塞进 userinfo 会变成 %3CREDACTED%3ASECRET%3E —— 既不可读也不再等于占位符。
    expect(out).not.toContain('%3C')
    expect(out).toContain('example.com')
    expect(s.found).toHaveLength(1)
  })

  test('敏感 query 值被换、非敏感 query 保留', () => {
    const s = sink()
    // gitleaks:allow — 合成夹具
    const url = 'https://h.co/p?access_token=FAKEq_abc123XYZ789&mode=fast'
    const out = redactUrlKeepingShape(url, s, 'u')
    expect(out).toContain('mode=fast')
    expect(out).not.toContain('FAKEq_abc123XYZ789')
  })

  test('脱敏后仍过 McpRemoteConfigSchema —— dump 投影在这里必挂', () => {
    const s = sink()
    const config = {
      // gitleaks:allow — 合成夹具
      url: redactUrlKeepingShape('https://u:p@h.co/sse?token=FAKEq_abc123XYZ789', s, 'config.url'),
      headers: redactRecord({ Authorization: 'Bearer x' }, s, 'config.headers'),
      // ⚠️ oauth 保持**对象**形状。dump 投影把它变成字符串 '‹redacted›' ⇒ 这里必红。
      oauth: { clientId: 'cid', clientSecret: PACKAGE_SECRET_PLACEHOLDER },
    }
    const parsed = McpRemoteConfigSchema.safeParse(config)
    expect(parsed.success).toBe(true)
  })

  test('oauth 为字符串时 schema 必须拒绝（锁住 dump 投影的那个 bug）', () => {
    const bad = { url: 'https://h.co', oauth: '<REDACTED:SECRET>' }
    expect(McpRemoteConfigSchema.safeParse(bad).success).toBe(false)
  })

  test('解析不了的 URL 也要收敛成一个**合法** http URL', () => {
    const s = sink()
    const out = redactUrlKeepingShape('not a url at all', s, 'config.url')
    expect(out.startsWith('https://')).toBe(true)
    expect(McpRemoteConfigSchema.safeParse({ url: out }).success).toBe(true)
  })
})

describe('carrier · 自由 JSON（frontmatterExtra / plugin options / 工作流 passthrough）', () => {
  test('键名命中 SECRET_KEY_RE 的值被换，其余保留', () => {
    const s = sink()
    const out = redactFreeJson(
      { github_token: 'FAKEv', note: 'hello', nested: { apiKey: 'k', depth: 2 } },
      s,
      'frontmatterExtra',
    ) as Record<string, unknown>
    expect(out.github_token).toBe(PACKAGE_SECRET_PLACEHOLDER)
    expect(out.note).toBe('hello')
    expect((out.nested as Record<string, unknown>).apiKey).toBe(PACKAGE_SECRET_PLACEHOLDER)
    expect((out.nested as Record<string, unknown>).depth).toBe(2)
  })

  test('数组里的对象也要下钻', () => {
    const s = sink()
    const out = redactFreeJson([{ secret: 'a' }, { keep: 'b' }], s, 'options') as Array<
      Record<string, unknown>
    >
    expect(out[0]!.secret).toBe(PACKAGE_SECRET_PLACEHOLDER)
    expect(out[1]!.keep).toBe('b')
  })

  test('高熵值即使键名无辜也会被换（looksHighEntropy 要求 ≥32 字符）', () => {
    const s = sink()
    const long = 'A1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvWx'
    expect(long.length).toBeGreaterThanOrEqual(32)
    const out = redactFreeJson({ blob: long }, s, 'x') as Record<string, unknown>
    expect(out.blob).toBe(PACKAGE_SECRET_PLACEHOLDER)
  })

  test('短的类 token 串不会被误伤（阈值以下）', () => {
    const s = sink()
    const out = redactFreeJson({ blob: 'A1b2C3d4E5f6' }, s, 'x') as Record<string, unknown>
    expect(out.blob).toBe('A1b2C3d4E5f6')
  })

  test('segment field 区分点号、方括号、数组下标与数字对象 key', () => {
    const s = sink()
    const out = redactFreeJson(
      {
        'a.b': { token: 'literal-dot' },
        a: { b: { token: 'nested-dot' } },
        'items[0]': { password: 'literal-bracket' },
        items: [{ password: 'array-index' }],
        numeric: { '0': { apiKey: 'numeric-key' } },
      },
      s,
      'frontmatterExtra',
    ) as Record<string, unknown>

    expect(out).not.toEqual({})
    expect(s.found.map((ref) => ref.field).sort()).toEqual(
      [
        ['frontmatterExtra', 'a.b', 'token'],
        ['frontmatterExtra', 'a', 'b', 'token'],
        ['frontmatterExtra', 'items[0]', 'password'],
        ['frontmatterExtra', 'items', 0, 'password'],
        ['frontmatterExtra', 'numeric', '0', 'apiKey'],
      ]
        .map(encodePackageSecretFieldSegments)
        .sort(),
    )
  })
})

describe('carrier · plugin spec', () => {
  test('git URL 里的内嵌凭据被换，npm 包名原样', () => {
    const s = sink()
    expect(redactPluginSpec('@acme/plugin@1.2.3', s)).toBe('@acme/plugin@1.2.3')
    const git = redactPluginSpec('https://user:tok@github.com/a/b.git', s)
    expect(git).not.toContain('tok@')
    expect(git).not.toContain('user')
    expect(git).toContain('github.com')
  })
})

describe('范围边界（决策 18）', () => {
  test('本模块只处理结构化字段——不提供任何技能文件树扫描入口', async () => {
    // 这条是**故意的负向断言**：技能目录里硬编码的凭据属于技能作者的责任
    // （proposal §3 非目标）。若将来有人加了扫描入口，这条会提醒他先改 RFC。
    const api = Object.keys(await import('../src/bundle/secrets'))
    expect(api.some((k) => /scanSkill|skillTree|scanFiles/i.test(k))).toBe(false)
  })
})
