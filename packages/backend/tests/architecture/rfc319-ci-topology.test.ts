// RFC-319 T14 —— 分档接线本身的守卫。
//
// 这一层的失败**全都是静默的**，所以必须有机器判据：
//
//   ① PR 腿漏掉 `--grep-invert '@nightly'` ⇒ 593 条 nightly 用例涌进 PR 门，
//      墙钟翻倍。这条会被人注意到（慢），是三条里最良性的。
//   ② windows 腿把两个排除项写成**两个** `--grep-invert` ⇒ Playwright 只认最后一个，
//      前一个静默失效。写这段的时候没有任何报错，跑起来也不报错，只是那批用例
//      悄悄进了 PR 门（或者 windows 的既有排除悄悄失效，那两条一直红的用例会
//      让新腿红在到达那一刻）。
//   ③ nightly 腿忘了设 `AW_E2E_ROUTE_JOURNAL` ⇒ **整套覆盖棘轮从不执行**。
//      账本永远与自己相等，永远绿。这是最坏的一种：棘轮看起来在，实际是个摆设。
//      RFC-317 的 T72 就是同一形态——机制建好了，但没有任何东西要求它被接上。
//
// 判据走**源码文本**而不是解析 YAML：这几条要钉的恰恰是「命令行长什么样」，
// 解析成结构反而会把 shell 那一层丢掉。

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const CI_YML = readFileSync(resolve(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
const NIGHTLY_YML = readFileSync(
  resolve(REPO_ROOT, '.github', 'workflows', 'e2e-full-nightly.yml'),
  'utf8',
)

/**
 * 剥掉整行注释后的 YAML。
 *
 * 判据必须只看**命令行**，不看散文——本文件的第一版栽在这里：它断言 nightly 腿
 * 「不含 --grep-invert」，而那份 workflow 的头注释里正好解释了「PR 腿用
 * --grep-invert 排除 nightly 档」。守卫当场红，红的原因是它在读注释。
 * docs/dev-gotchas.md 记过同一条：一句断言和它的否定长得一模一样。
 */
const stripComments = (yaml: string): string =>
  yaml
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')

const NIGHTLY_CODE = stripComments(NIGHTLY_YML)
const CI_CODE = stripComments(CI_YML)

/**
 * 一段 workflow 正文里的 `bun run e2e` 调用（续行已折平）。
 *
 * 提成模块级纯函数是为了能喂**伪造输入**——判据留在 test 体里时，负 fixture 只能
 * 证明「拷贝还活着」，证不了扫真实语料的那份还咬得动（RFC-317 T14 的原话）。
 *
 * 交替式 `(?:\\\n|[^\n])*` 而不是 `[^\n]*(?:\\\n[^\n]*)*`：后者的 `(?:…)*`
 * 匹配零次即成功，正则引擎没有理由回溯去把续行吃进来，于是每条调用都在行尾的
 * 反斜杠处截断。本文件第一版就是那样写的，实测两条调用都只截到 `--shard=…` 为止。
 */
export function e2eInvocations(workflowCode: string): string[] {
  return [...workflowCode.matchAll(/bun run e2e --(?:\\\n|[^\n])*/g)].map((m) =>
    m[0].replace(/\\\n\s*/g, ' '),
  )
}

/** 一条调用里出现了几次 `--grep-invert`。>1 即失效——Playwright 只认最后一个。 */
export function grepInvertCount(call: string): number {
  return (call.match(/--grep-invert/g) ?? []).length
}

/** 唯一的 nightly 档标记。拼错一个字母 ⇒ 那条用例会安静地留在 PR 档。 */
const NIGHTLY_TAG = '@nightly'

describe('RFC-319 —— 语料非空（文件被挪走 / 改名时必须红，而不是空转成绿）', () => {
  test('两份 workflow 都读得到且非空', () => {
    expect(CI_YML.length).toBeGreaterThan(5_000)
    expect(NIGHTLY_YML.length).toBeGreaterThan(1_000)
  })

  test('ci.yml 里确实有那个 e2e job（找不到就不该有下面的断言）', () => {
    expect(CI_YML).toContain('Playwright e2e (shard')
    expect(CI_CODE).toContain('bun run e2e --')
  })
})

describe('RFC-319 —— PR 腿只跑 PR 档', () => {
  test('分档变量就是 @nightly，且被引号包住（YAML 里 @ 开头的裸标量非法）', () => {
    expect(CI_YML).toContain(`AW_E2E_TIER_EXCLUDE: '${NIGHTLY_TAG}'`)
  })

  test('两个分支都排除了 nightly 档（漏掉任一分支 ⇒ 那个 OS 的 PR 门跑全量）', () => {
    const runStep = CI_CODE.slice(CI_CODE.indexOf('Run e2e (shard'))
    const invocations = e2eInvocations(runStep)
    expect(invocations.length, 'e2e 调用的形态变了，这条守卫需要跟着改').toBe(2)
    for (const call of invocations) {
      expect(call, `这条调用没有排除 nightly 档：${call}`).toContain('AW_E2E_TIER_EXCLUDE')
    }
  })

  test('**windows 腿把两个排除项合成一条正则**（Playwright 只认一个 --grep-invert）', () => {
    const runStep = CI_CODE.slice(CI_CODE.indexOf('Run e2e (shard'))
    const windowsCall = e2eInvocations(runStep).find((call) =>
      call.includes('AW_E2E_WINDOWS_EXCLUDE'),
    )
    expect(windowsCall, 'windows 腿的既有排除项不见了').toBeDefined()
    expect(
      grepInvertCount(windowsCall!),
      '写了两个 --grep-invert：Playwright 只认最后一个，前一个静默失效。' +
        '两个排除项必须合成一条正则（用 | 连接）',
    ).toBe(1)
    expect(windowsCall!).toContain('$AW_E2E_TIER_EXCLUDE|$AW_E2E_WINDOWS_EXCLUDE')
  })
})

describe('RFC-319 —— nightly 腿必须真的驱动棘轮', () => {
  test('跑全量：不带任何 grep 过滤', () => {
    expect(
      NIGHTLY_CODE,
      'nightly 腿加了 grep 过滤就不再是全量，而 R1/R2 的对账只在全量上成立',
    ).not.toContain('--grep-invert')
    expect(NIGHTLY_CODE).toContain('bun run e2e -- --shard=')
  })

  test('**设了 AW_E2E_ROUTE_JOURNAL**（漏了 ⇒ 采集是空操作，棘轮永远绿）', () => {
    expect(NIGHTLY_CODE).toContain('AW_E2E_ROUTE_JOURNAL:')
    // 采集与对账两处都要有：一处产、一处消。
    expect((NIGHTLY_CODE.match(/AW_E2E_ROUTE_JOURNAL:/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  test('对账 job 真的跑那两条账本守卫', () => {
    expect(NIGHTLY_YML).toContain('rfc319-endpoint-coverage.test.ts')
    expect(NIGHTLY_YML).toContain('rfc319-route-coverage.test.ts')
  })

  test('上游没全绿时拒绝对账（残缺语料会把账本比成一堆误报）', () => {
    expect(NIGHTLY_YML).toContain("needs.e2e-full.result != 'success'")
  })

  test('分片数不足时拒绝对账（少下一个 artifact 会安静表现为「覆盖变差」）', () => {
    expect(NIGHTLY_YML).toContain('期望 4 个分片的 journal')
  })
})

describe('RFC-319 —— 档位标记不许拼错', () => {
  const e2eDir = resolve(REPO_ROOT, 'e2e')
  const specs = readdirSync(e2eDir).filter((n) => n.endsWith('.spec.ts'))

  test('语料非空：spec 目录还在', () => {
    expect(specs.length).toBeGreaterThan(40)
  })

  test('spec 里出现的每一个 tag 都是已知档位', () => {
    const bad: string[] = []
    for (const name of specs) {
      const src = readFileSync(join(e2eDir, name), 'utf8')
      for (const m of src.matchAll(/tag:\s*(?:\[\s*)?['"]([^'"]+)['"]/g)) {
        if (m[1] !== NIGHTLY_TAG) bad.push(`${name}: ${m[1]}`)
      }
    }
    expect(
      bad,
      `未知的档位标记。拼错一个字母不会有任何报错，那条用例会安静地留在 PR 档——` +
        `唯一合法的是 ${NIGHTLY_TAG}`,
    ).toEqual([])
  })
})

describe('RFC-319 —— 负 fixture：判据自己咬得动吗', () => {
  // 这些断言**完全不碰真实语料**，只把伪造的 workflow 片段喂给扫真实语料的
  // 同一份判据。它们回答的是 RFC-317 T14 点名的那种失效：语料还在、断言还在，
  // 但 matcher 不咬了，于是「零违规」与「合规」同形。
  //
  // fake 用多行模板字面量而不是运行时 `join('\n')`：census 的「伪造输入」判据看的是
  // **字面量本身**的代码形态，运行时才拼出来的换行它看不见——写成数组时本文件的
  // negativeFixture 被判为 0，等于没配 fixture。

  test('续行会被折平（交替式正则写错时这条会红）', () => {
    const fake = `        run: |
          bun run e2e -- --shard=1/2 \\
            --grep-invert "$X"
`
    const calls = e2eInvocations(fake)
    expect(calls).toHaveLength(1)
    expect(
      calls[0]!,
      '续行没被折进来 ⇒ 守卫看不到 --grep-invert，任何漏掉过滤的改动都会照绿',
    ).toContain('--grep-invert')
  })

  test('「两个 --grep-invert」这种失效形态被判出来', () => {
    const fake = `          bun run e2e -- --shard=1/2 \\
            --grep-invert "$A" --grep-invert "$B"
`
    const calls = e2eInvocations(fake)
    expect(calls).toHaveLength(1)
    expect(grepInvertCount(calls[0]!), '数不出第二个 --grep-invert ⇒ 那条守卫是摆设').toBe(2)
  })

  test('只有一个 --grep-invert 时不误报', () => {
    const fake = `          bun run e2e -- --shard=1/2 --grep-invert "$A|$B"
`
    expect(grepInvertCount(e2eInvocations(fake)[0]!)).toBe(1)
  })

  test('认不出任何调用时返回空数组（而不是抛异常静默跳过）', () => {
    const fake = `        run: echo nothing here
        shell: bash
`
    expect(e2eInvocations(fake)).toEqual([])
  })
})
