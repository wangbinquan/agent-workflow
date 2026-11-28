// RFC-626 §3.5 / §3.4 row 6b: the environment check of the automatic upgrade and the conversion
// must agree on whether the home `config.json` is acceptable.
//
// Why this file exists: a `config.json` the conversion rejects used to surface in the middle of
// the conversion (`v2-boot-runtime-config-unproven`), after the freeze and the inventory. RFC-626
// reports it before the upgrade is recorded. The judgement lives twice — in the conversion rule
// that captures the file (`runtime-management/infrastructure/migration/runtimeConfigRule.ts`:
// `judgeRuntimeConfigFile`, used by `runtimeConfigEnvironment().capture`) and in the check
// (`system-operations/domain/epochSwitch/environmentPrecheck.ts`: `checkHomeConfig`), because
// system-operations may not import another module's internals. If the two drift, the check lets
// through a file the conversion then stops on, or refuses one the conversion accepts. One table
// of cases is fed to both here: the verdict, the reason and the key that is named must be equal.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  judgeRuntimeConfigFile,
  runtimeConfigEnvironment,
} from '@/modules/runtime-management/infrastructure/migration/runtimeConfigRule'
import {
  checkHomeConfig,
  environmentRefusalConclusion,
  homeConfigRefusal,
  unloadableConfigRefusal,
  type HomeConfigObservation,
} from '@/modules/system-operations/domain/epochSwitch/environmentPrecheck'
import { readHomeConfigFile } from '@/modules/system-operations/infrastructure/local/autoUpgradeEnvironment'
import { errorText } from '@/platform/persistence/migration/errorText'
import type { BootUpgradeCaptureInput } from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'

const text = (value: string) => new TextEncoder().encode(value)
const failing = (code: string) => (): Uint8Array | null => {
  throw Object.assign(new Error(`${code}: cannot read 'config.json'`), { code })
}

/** What reading the file gives, and whether the upgrade may proceed with it. */
const CASES: readonly {
  readonly name: string
  readonly read: () => Uint8Array | null
  readonly valid: boolean
  /** The reason both sides give, without the `config-` prefix. */
  readonly reason?: 'unreadable' | 'not-utf8' | 'not-json' | 'not-object' | 'binary-invalid'
  /** The key both sides name. */
  readonly names?: 'opencodePath' | 'claudeCodePath'
}[] = [
  { name: 'the file does not exist', read: () => null, valid: true },
  { name: 'reading reports that the file does not exist', read: failing('ENOENT'), valid: true },
  { name: 'an empty object', read: () => text('{}'), valid: true },
  {
    name: 'both binary paths are text',
    read: () => text('{"opencodePath":"/usr/bin/opencode","claudeCodePath":"claude"}'),
    valid: true,
  },
  { name: 'a binary path is null', read: () => text('{"opencodePath":null}'), valid: true },
  {
    name: 'a binary path is the empty text',
    read: () => text('{"claudeCodePath":""}'),
    valid: true,
  },
  {
    name: 'keys the rule does not know, of any type',
    read: () => text('{"defaultModel":7,"x":[1],"database":null}'),
    valid: true,
  },
  {
    name: 'non-ASCII text in valid UTF-8',
    read: () => text('{"opencodePath":"/工具/opencode"}'),
    valid: true,
  },
  { name: 'surrounding white space', read: () => text('\n  {"opencodePath":"o"}\n'), valid: true },
  {
    name: 'reading fails: permission denied',
    read: failing('EACCES'),
    valid: false,
    reason: 'unreadable',
  },
  {
    name: 'reading fails: it is a directory',
    read: failing('EISDIR'),
    valid: false,
    reason: 'unreadable',
  },
  {
    name: 'bytes that are not UTF-8',
    read: () => new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d]),
    valid: false,
    reason: 'not-utf8',
  },
  {
    name: 'a truncated UTF-8 sequence inside a text',
    read: () => new Uint8Array([...text('{"opencodePath":"'), 0xe5, 0xb7, ...text('"}')]),
    valid: false,
    reason: 'not-utf8',
  },
  {
    name: 'UTF-16 with a byte order mark',
    read: () => new Uint8Array([0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00]),
    valid: false,
    reason: 'not-utf8',
  },
  { name: 'an empty file', read: () => new Uint8Array(), valid: false, reason: 'not-json' },
  { name: 'white space only', read: () => text(' \n'), valid: false, reason: 'not-json' },
  {
    name: 'a truncated object',
    read: () => text('{"opencodePath":'),
    valid: false,
    reason: 'not-json',
  },
  { name: 'a trailing comma', read: () => text('{"a":1,}'), valid: false, reason: 'not-json' },
  { name: 'a comment', read: () => text('// settings\n{}'), valid: false, reason: 'not-json' },
  { name: 'top level null', read: () => text('null'), valid: false, reason: 'not-object' },
  {
    name: 'top level array',
    read: () => text('[{"opencodePath":"o"}]'),
    valid: false,
    reason: 'not-object',
  },
  { name: 'top level text', read: () => text('"config"'), valid: false, reason: 'not-object' },
  { name: 'top level number', read: () => text('42'), valid: false, reason: 'not-object' },
  { name: 'top level boolean', read: () => text('true'), valid: false, reason: 'not-object' },
  {
    name: 'opencodePath is a number',
    read: () => text('{"opencodePath":42}'),
    valid: false,
    reason: 'binary-invalid',
    names: 'opencodePath',
  },
  {
    name: 'opencodePath is an array',
    read: () => text('{"opencodePath":["o"]}'),
    valid: false,
    reason: 'binary-invalid',
    names: 'opencodePath',
  },
  {
    name: 'claudeCodePath is an object',
    read: () => text('{"claudeCodePath":{"path":"claude"}}'),
    valid: false,
    reason: 'binary-invalid',
    names: 'claudeCodePath',
  },
  {
    name: 'claudeCodePath is false, opencodePath is text',
    read: () => text('{"opencodePath":"o","claudeCodePath":false}'),
    valid: false,
    reason: 'binary-invalid',
    names: 'claudeCodePath',
  },
  {
    name: 'both binary paths are not text: the first one is named',
    read: () => text('{"claudeCodePath":0,"opencodePath":1}'),
    valid: false,
    reason: 'binary-invalid',
    names: 'opencodePath',
  },
]

/**
 * The observation the check is given for a read: what `readHomeConfigFile` makes of it — the
 * bytes, absence for "no such file", and the text of any other failure. (That the real reader
 * does this is asserted below, on real files.)
 */
function observe(read: () => Uint8Array | null): HomeConfigObservation {
  try {
    return { bytes: read() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: null }
    return { error: errorText(error) }
  }
}

/** What the rule's judgement is given for the same read: the bytes or the thrown value. */
function ruleOutcome(read: () => Uint8Array | null) {
  try {
    return { bytes: read() }
  } catch (error) {
    return { error }
  }
}

/** All the rule's capture reads besides the file: a source without runtime rows, and the home. */
const captureInput = (root: string) =>
  ({
    stage: 'plan',
    source: { preflight: { tables: [], expectedAbsent: ['runtimes'] } },
    root: { kind: 'app-home', root, runsSupplied: true, objects: 'none' },
    content: {},
    manifest: {},
    readArtifact: async () => null,
    writeArtifact: async () => {},
  }) as unknown as BootUpgradeCaptureInput

/** The state the conversion rule records; `read` undefined uses the rule's own file reader. */
async function capturedState(
  read: ((path: string) => Promise<Uint8Array | null>) | undefined,
  root = '/installation',
): Promise<string> {
  const facts = await runtimeConfigEnvironment(read).capture(captureInput(root))
  expect(facts).toHaveLength(1)
  return (facts[0]!.evidence as { config: { state: string } }).config.state
}
/** `unavailable` and `invalid` block the conversion of the runtime rows. */
const converts = (state: string) => state === 'absent' || state === 'present'

describe('RFC-626 —— config.json 的前置判定与转换规则的判定一致', () => {
  for (const item of CASES)
    test(`${item.name}：两边都判为${item.valid ? '有效' : '无效'}`, async () => {
      const checked = checkHomeConfig(observe(item.read))
      const judged = judgeRuntimeConfigFile(ruleOutcome(item.read))
      // The expectation of the table, then the two against each other.
      expect(checked.valid).toBe(item.valid)
      expect(judged.valid).toBe(item.valid)
      // What the capture records for the conversion is that judgement.
      const state = await capturedState(async () => item.read())
      expect(state).toBe(judged.state)
      expect(converts(state)).toBe(item.valid)
      if (checked.valid) {
        expect(checked.state).toBe(judged.state as 'absent' | 'present')
        expect(judged.reason).toBeNull()
        return
      }
      // The same reason under the same name.
      expect(checked.reason).toBe(item.reason!)
      const refusal = homeConfigRefusal('/installation/config.json', checked)!
      expect(refusal.reason).toBe(`config-${item.reason}`)
      expect(String(judged.reason)).toStartWith(refusal.reason)
      if (item.names) {
        // And the same key.
        expect(judged.reason).toBe(`config-binary-invalid: ${item.names}`)
        expect(checked.detail).toStartWith(`${item.names} is `)
      }
    })

  test('用例表覆盖了规则给出的四种状态与五种无效原因', () => {
    const states = new Set<string>()
    for (const item of CASES) states.add(judgeRuntimeConfigFile(ruleOutcome(item.read)).state)
    expect([...states].sort()).toEqual(['absent', 'invalid', 'present', 'unavailable'])
    expect(
      [...new Set(CASES.flatMap((item) => (item.reason ? [item.reason] : [])))].sort(),
    ).toEqual(['binary-invalid', 'not-json', 'not-object', 'not-utf8', 'unreadable'])
  })

  test('前置判定不引用规则的实现：两边各自独立，由本文件对齐', () => {
    const source = readFileSync(
      join(
        import.meta.dir,
        '../src/modules/system-operations/domain/epochSwitch/environmentPrecheck.ts',
      ),
      'utf8',
    )
    expect(source).not.toMatch(/from '@\/modules\/runtime-management/)
    // The pointer a reader follows from the check to the rule and to this file.
    expect(source).toContain('judgeRuntimeConfigFile')
    expect(source).toContain('tests/rfc626-home-config-parity.test.ts')
  })
})

describe('RFC-626 —— 两边各自的读文件方式对同一个真实文件结论一致', () => {
  const homes: string[] = []
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })
  const home = () => {
    const path = mkdtempSync(join(tmpdir(), 'rfc626-config-'))
    homes.push(path)
    return path
  }

  test('文件不存在：都照常通过，且谁也不创建它', async () => {
    const root = home()
    expect(readHomeConfigFile(join(root, 'config.json'))).toEqual({ bytes: null })
    expect(checkHomeConfig(readHomeConfigFile(join(root, 'config.json')))).toEqual({
      valid: true,
      state: 'absent',
    })
    expect(await capturedState(undefined, root)).toBe('absent')
    expect(existsSync(join(root, 'config.json'))).toBe(false)
  })

  test('读文件的系统错误不是「不存在」：前置判定得到的是错误的文字', () => {
    const root = home()
    mkdirSync(join(root, 'config.json'))
    const observed = readHomeConfigFile(join(root, 'config.json'))
    expect('error' in observed && observed.error.length > 0).toBe(true)
    expect(checkHomeConfig(observed)).toMatchObject({ valid: false, reason: 'unreadable' })
  })

  for (const [name, write, valid] of [
    ['合法的对象', (path: string) => writeFileSync(path, '{"opencodePath":"/bin/opencode"}'), true],
    ['不是合法 JSON', (path: string) => writeFileSync(path, '{"opencodePath":'), false],
    [
      '不是合法 UTF-8',
      (path: string) => writeFileSync(path, Buffer.from([0xff, 0xfe, 0x7b, 0x7d])),
      false,
    ],
    ['顶层是数组', (path: string) => writeFileSync(path, '[]'), false],
    ['路径不是文本', (path: string) => writeFileSync(path, '{"claudeCodePath":1}'), false],
    // A directory in the file's place: reading fails with a system error that is not "absent".
    ['是一个目录', (path: string) => mkdirSync(path), false],
  ] as const)
    test(`${name}：两边都判为${valid ? '有效' : '无效'}`, async () => {
      const root = home()
      write(join(root, 'config.json'))
      expect(checkHomeConfig(readHomeConfigFile(join(root, 'config.json'))).valid).toBe(valid)
      expect(converts(await capturedState(undefined, root))).toBe(valid)
    })
})

describe('RFC-626 —— config.json 被拒绝时的文案', () => {
  const path = '/srv/agent-workflow/config.json'
  test('每种无效原因都写明是哪一条、文件路径与解析错误', () => {
    const expected: Record<string, RegExp> = {
      unreadable: /cannot be read: EACCES: cannot read 'config\.json'/,
      'not-utf8': /is not valid UTF-8: /,
      'not-json': /is not valid JSON: /,
      'not-object': /must hold a JSON object at the top level; it holds an array\./,
      'binary-invalid': /opencodePath and claudeCodePath must be text: opencodePath is a number\./,
    }
    const samples: Record<string, () => Uint8Array | null> = {
      unreadable: failing('EACCES'),
      'not-utf8': () => new Uint8Array([0xff]),
      'not-json': () => text('{'),
      'not-object': () => text('[]'),
      'binary-invalid': () => text('{"opencodePath":1}'),
    }
    for (const [reason, read] of Object.entries(samples)) {
      const refusal = homeConfigRefusal(path, checkHomeConfig(observe(read)))!
      expect(refusal.reason).toBe(`config-${reason}`)
      expect(refusal.guidance[0]).toContain(path)
      expect(refusal.guidance[0]).toMatch(expected[reason]!)
      expect(refusal.guidance.join('\n')).toContain(`Correct ${path}, then start again.`)
      expect(refusal.guidance.join('\n')).toContain('nothing was recorded for this upgrade')
    }
    // The parser's own words, not a paraphrase of them.
    let parser = ''
    try {
      JSON.parse('{')
    } catch (error) {
      parser = (error as Error).message
    }
    expect(parser.length).toBeGreaterThan(0)
    expect(homeConfigRefusal(path, checkHomeConfig({ bytes: text('{') }))!.guidance[0]).toContain(
      parser,
    )
  })

  test('顶层与路径字段的各种取值在文案里各有说法', () => {
    const holds = (json: string) =>
      homeConfigRefusal(path, checkHomeConfig({ bytes: text(json) }))!.guidance[0]!
    expect(holds('null')).toContain('it holds null.')
    expect(holds('"x"')).toContain('it holds a string.')
    expect(holds('7')).toContain('it holds a number.')
    expect(holds('false')).toContain('it holds a boolean.')
    expect(holds('{"claudeCodePath":{}}')).toContain('claudeCodePath is an object.')
    expect(holds('{"claudeCodePath":[]}')).toContain('claudeCodePath is an array.')
    expect(holds('{"opencodePath":true}')).toContain('opencodePath is a boolean.')
  })

  test('有效的文件不产生拒绝', () => {
    expect(homeConfigRefusal(path, checkHomeConfig({ bytes: null }))).toBeNull()
    expect(homeConfigRefusal(path, checkHomeConfig({ bytes: text('{}') }))).toBeNull()
  })

  test('拒绝的结论是退出码 3、没有操作编号、带原因代码', () => {
    const conclusion = environmentRefusalConclusion(
      homeConfigRefusal(path, checkHomeConfig({ bytes: text('[]') }))!,
    )
    expect(conclusion).toMatchObject({
      mode: 'auto',
      outcome: 'refused',
      exitCode: 3,
      operationId: null,
      code: 'config-not-object',
    })
    expect(Object.hasOwn(conclusion, 'artifactRoot')).toBe(false)
    expect(Object.hasOwn(conclusion, 'receipt')).toBe(false)
    // A file the conditions above accept and the configuration loader still rejects.
    const unloadable = environmentRefusalConclusion(
      unloadableConfigRefusal(path, 'maxConcurrentNodes: expected number'),
    )
    expect(unloadable).toMatchObject({ outcome: 'refused', exitCode: 3, operationId: null })
    expect(unloadable.code).toBe('config-not-loadable')
    expect(unloadable.guidance[0]).toContain(path)
    expect(unloadable.guidance[0]).toContain('maxConcurrentNodes: expected number')
  })
})
