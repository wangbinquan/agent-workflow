// RFC-254 D23 — whole-repo negative scan for POSIX-only execution/path idioms.
//
// WHY THIS EXISTS
// ---------------
// The RFC-254 design gate ran two independent adversarial reviews over a
// hand-written inventory of "every place that assumes POSIX". The RFC claimed 4
// `startsWith(`${root}/`)` sites; review A found 6; this scan found 10. The RFC
// claimed 4 PATH-joining sites; review A found 7; this scan found 10 (nobody
// Several of the original controlled-runtime allowances have since been removed.
// Two of the sites everyone missed are live defects rather than tidiness:
// pluginInstaller's GC would delete plugin generations that ARE referenced, and
// systemAgentRun's seed-path check would reject every legitimate path.
//
// The lesson is not "count more carefully next time" — it is that an inventory
// maintained by hand becomes the shared wrong premise for both the
// implementation and its tests. So coverage is a property the compiler-adjacent
// tooling proves, not a list somebody keeps current. Rules below are stated as
// FORBIDDEN FORMS; anything still matching must be enumerated with a reason.
//
// Two kinds of entry, deliberately kept apart:
//   - `exempt`  — the site is posix-by-contract and will never migrate (git
//                 emits `/` on every platform; a repo-relative archive path is
//                 not a filesystem path). These are permanent.
//   - `pending` — the site is a real migration that has not landed yet. Every
//                 one carries the task that closes it. This list may only ever
//                 SHRINK; the staleness ratchet below fails the build when an
//                 entry stops matching, so a finished migration cannot quietly
//                 leave its allowance behind for the next violation to reuse.
//
// Ratchet shape mirrors `scripts/depcheck.ts` KNOWN_VIOLATIONS, which was
// introduced for exactly this failure mode (an allow-list keyed by FILE lets
// every future violation in that file through; keyed by OCCURRENCE it cannot).

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const SRC_ROOT = resolve(import.meta.dir, '..', 'src')

type RuleId =
  | 'null-device'
  | 'posix-path-list'
  | 'posix-dirname'
  | 'posix-path-prefix'
  | 'posix-file-identity'
  | 'spawn-without-platform-options'

interface Rule {
  readonly id: RuleId
  /** What the form gets wrong on Windows, in one line, for the failure message. */
  readonly why: string
  /** Global regex; every match is one occurrence. */
  readonly pattern: RegExp
}

const RULES: readonly Rule[] = [
  {
    id: 'null-device',
    why: '`/dev/null` does not exist on Windows; the null sink is the reserved name `NUL`',
    pattern: /['"`]\/dev\/null['"`]/g,
  },
  {
    id: 'posix-path-list',
    why: '`:` is the drive separator on Windows; PATH-style lists join with `;`',
    // Either a hardcoded posix search list, or joining path entries with ':'.
    pattern: /(?:['"`]\/(?:usr|bin|sbin)[^'"`\n]*:[^'"`\n]*['"`]|\.join\(':'\))/g,
  },
  {
    id: 'posix-dirname',
    why: "`lastIndexOf('/')` misses `\\`-separated Windows paths; use `dirname()`",
    pattern: /lastIndexOf\(['"]\/['"]\)/g,
  },
  {
    id: 'posix-file-identity',
    why: 'NTFS `ino` is 0/unstable through Node, so a private dev+ino comparison silently equates unrelated files on Windows; use assertSameFileIdentity()',
    pattern: /\.(?:dev|ino) (?:!==|===) /g,
  },
  {
    id: 'spawn-without-platform-options',
    why: 'a production spawn that omits platformSpawnOptions() flashes a console window per child on Windows — and for a long-running agent, one per grandchild',
    // Object-form spawns whose literal does not spread the platform options.
    // Deliberately anchored on the OPENING of the call plus a bounded lookahead
    // rather than trying to parse the whole object: the failure it guards is
    // "somebody added a new spawn and forgot", which shows up right here.
    // Covers BOTH call shapes. The first draft only matched the object form
    // `Bun.spawn({...})` and therefore missed `Bun.spawn([argv], {opts})`
    // entirely — archive.ts sat unnoticed with two un-hidden spawns until a
    // manual read found them, which is precisely the gap this scan exists to
    // remove.
    pattern:
      /Bun\.spawn(?:Sync)?\(\s*(?:\{(?![\s\S]{0,140}platformSpawnOptions)|\[[\s\S]{0,200}?\]\s*,\s*\{(?![\s\S]{0,140}platformSpawnOptions))/g,
  },
  {
    id: 'posix-path-prefix',
    why: 'a `${root}/` prefix test never matches a `\\`-separated path and ignores NTFS case folding; use isLexicallyInside()',
    // Matches the LITERAL, not the call, on purpose. The first draft of this
    // rule keyed on `startsWith(`${x}/`)` and was immediately blind to the
    // two-step spelling four lines above one of its own hits:
    //   const worktreePrefix = `${ctx.worktreePath}/`
    //   ... .startsWith(worktreePrefix)
    // Guarding the call shape lets the same defect through by renaming a
    // variable; guarding the path-prefix literal cannot be dodged that way.
    pattern: /`\$\{[^}]+\}\/`/g,
  },
]

interface Allowance {
  readonly rule: RuleId
  /** src-relative path. */
  readonly file: string
  /** The exact matched text, so the allowance is keyed by OCCURRENCE not file. */
  readonly match: string
  /** How many identical matches in that file this allowance covers. */
  readonly count: number
  /** Required. For `exempt`: why the site is posix-by-contract. */
  readonly why: string
  /** Present iff this is a not-yet-migrated site; names the closing task. */
  readonly closedBy?: string
}

const ALLOWANCES: readonly Allowance[] = [
  // --- permanent: posix-by-contract ------------------------------------------
  {
    rule: 'posix-path-prefix',
    file: 'util/git.ts',
    match: '`${m}/`',
    count: 2,
    why: 'git pathspec construction and ls-files output matching; git speaks `/` on every platform (RFC-248)',
  },
  {
    rule: 'posix-path-prefix',
    file: 'modules/development-automation/application/uploadPlan.ts',
    match: '`${target}/`',
    count: 1,
    why: 'operands are canonical REPO-relative target paths, never host paths: repoRelativePathSchema rejects `\\` and absolute forms at admission, so `/` is the only separator on every platform (RFC-310 upload plan ancestor/descendant collision check)',
  },
  {
    rule: 'posix-path-prefix',
    file: 'modules/development-automation/application/uploadPlan.ts',
    match: '`${other}/`',
    count: 1,
    why: 'same canonical repo-relative contract as `${target}/` above — the symmetric side of the ancestor/descendant collision check (RFC-310)',
  },
  {
    rule: 'posix-path-prefix',
    file: 'modules/development-automation/application/uploadPlan.ts',
    match: '`${p}/`',
    count: 1,
    why: 'policy allowedTargetPrefixes are authored as repo-relative `/` paths against the same schema-normalized targets (RFC-310)',
  },
  {
    rule: 'posix-path-prefix',
    file: 'services/taskPlatformInputPaths.ts',
    match: '`${root}/`',
    count: 1,
    why: 'the roster is a closed repo-relative wire grammar, not a host path: canonicalPath() rejects `\\`, absolute forms, empty/`.`/`..` segments and control chars BEFORE this prefix test runs, so `/` is the only separator that can reach it on any platform (RFC-310 PR-12 platform input mounts)',
  },
  {
    rule: 'posix-path-prefix',
    file: 'modules/source-control/domain/changeCandidate.ts',
    match: '`${root}/`',
    count: 1,
    why: 'operands are git name-status output paths and repo-relative protected roots — git speaks `/` on every platform, no host path ever enters this check (RFC-310 T48)',
  },
  {
    rule: 'posix-path-prefix',
    file: 'modules/source-control/domain/taskCommitPolicy.ts',
    match: '`${PLATFORM_WORKSPACE_DIR}/`',
    count: 1,
    why: 'operand is a normalized repository-relative Git path, not a host filesystem path; Git name-status uses `/` on every platform and core.ignoreCase is applied by the matcher (RFC-308)',
  },
  {
    rule: 'posix-path-prefix',
    file: 'modules/source-control/domain/taskCommitPolicy.ts',
    match: '`${normalized}/`',
    count: 1,
    why: 'appends the Gitignore directory marker to an already-normalized repository-relative path; this value is passed to the matcher and never opened as a host path (RFC-308)',
  },
  {
    rule: 'posix-path-prefix',
    file: 'services/codeHost/url.ts',
    match: '`${basePath}/`',
    count: 1,
    why: 'operand is a URL pathname (`new URL(...).pathname`), not a filesystem path — URL pathnames are `/`-separated and case-sensitive on every platform, so neither the win32 separator nor NTFS case folding applies (RFC-269)',
  },
  {
    rule: 'posix-path-prefix',
    file: 'services/codeHost/project.ts',
    match: '`${prefixPath}/`',
    count: 1,
    why: 'operands are normalized Git repository URL paths, not filesystem paths — URL and Git wire paths use `/` as a case-sensitive segment separator on every platform',
  },
  {
    rule: 'posix-dirname',
    file: 'services/webhook/gitlabAdapter.ts',
    match: "lastIndexOf('/')",
    count: 1,
    why: 'operand is a GitLab project path from the webhook payload (`group/subgroup/repo`) — a wire identifier that is `/`-separated on every platform, never a filesystem path (RFC-263)',
  },
  {
    rule: 'posix-path-prefix',
    file: 'services/skillIdentityPaths.ts',
    match: '`${expectedPrefix}/`',
    count: 1,
    why: 'operand is a skill-archive-relative operation path (`skills/<key>/...`), a wire identifier rather than a filesystem path',
  },
  {
    rule: 'posix-path-prefix',
    file: 'services/structuralDiff/callGraph/expandService.ts',
    match: '`${dir}/`',
    count: 1,
    why: 'operands are structural-diff symbol refs prefixed by repo mount labels, normalized to posix before they reach here',
  },
  {
    rule: 'null-device',
    file: 'services/skillVersion.ts',
    match: "'/dev/null'",
    count: 2,
    why: 'synthesizes the `--- /dev/null` header of a unified diff — diff-format text, never opened as a device',
  },

  // --- pending migration (must only shrink) ----------------------------------
  {
    rule: 'posix-file-identity',
    file: 'services/skill.ts',
    match: '.dev === ',
    count: 1,
    why: 'NOT a verified-store fence — it detects case-folding collisions in skill dirs. Failing closed here would break skill management on Windows outright, so it needs a non-fail-closed identity notion (own design question)',
    closedBy: 'RFC-254-T0b',
  },
  {
    rule: 'posix-file-identity',
    file: 'services/skill.ts',
    match: '.ino === ',
    count: 1,
    why: 'NOT a verified-store fence — it detects case-folding collisions in skill dirs. Failing closed here would break skill management on Windows outright, so it needs a non-fail-closed identity notion (own design question)',
    closedBy: 'RFC-254-T0b',
  },
  {
    rule: 'posix-file-identity',
    file: 'services/skillMigrateOp.ts',
    match: '.dev === ',
    count: 1,
    why: 'NOT a verified-store fence — same case-folding role as skill.ts; needs the same non-fail-closed identity notion before it can migrate',
    closedBy: 'RFC-254-T0b',
  },
  {
    rule: 'posix-file-identity',
    file: 'services/skillMigrateOp.ts',
    match: '.ino === ',
    count: 1,
    why: 'NOT a verified-store fence — same case-folding role as skill.ts; needs the same non-fail-closed identity notion before it can migrate',
    closedBy: 'RFC-254-T0b',
  },
]

function allProductionTypeScript(): Array<{ path: string; text: string }> {
  const files: Array<{ path: string; text: string }> = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (entry.endsWith('.ts')) {
        // Normalize to posix separators: `relative()` yields `\` on Windows,
        // and every allowance/exemption in this file is written with `/`.
        // (Found by the Windows CI job on its first run — the guard itself had
        // the very portability defect it exists to catch.)
        files.push({
          path: relative(SRC_ROOT, path).split(sep).join('/'),
          text: readFileSync(path, 'utf8'),
        })
      }
    }
  }
  walk(SRC_ROOT)
  return files
}

interface Occurrence {
  rule: RuleId
  file: string
  match: string
}

/**
 * The scan itself. Comments are stripped first: a forbidden form quoted inside
 * an explanatory comment is documentation, not a call site, and letting those
 * trip the guard is how table-level guards get watered down into file-level
 * ones (RFC-072).
 */
function scan(): Occurrence[] {
  const found: Occurrence[] = []
  for (const { path, text } of allProductionTypeScript()) {
    // The destination modules necessarily CONTAIN the forms they replace —
    // that is what makes them the single implementation.
    if (path === 'util/platformExec.ts' || path === 'util/fileTrust.ts') continue
    const code = text.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/(^|[^:])\/\/[^\n]*/g, '$1')
    for (const rule of RULES) {
      for (const match of code.matchAll(rule.pattern)) {
        found.push({ rule: rule.id, file: path, match: match[0] })
      }
    }
  }
  return found
}

function allowanceKey(a: { rule: RuleId; file: string; match: string }): string {
  // JSON rather than a delimiter: `match` is arbitrary source text and any
  // separator character could appear inside it. (The first draft used a raw
  // NUL, which tripped the repo's no-NUL-bytes-in-source guard -- NUL makes
  // grep/rg silently skip the WHOLE file while tsc/prettier stay happy.)
  return JSON.stringify([a.rule, a.file, a.match])
}

describe('RFC-254 platform surface guard', () => {
  test('every POSIX-only execution/path form is migrated or explicitly allowed', () => {
    const remaining = new Map<string, number>()
    for (const occurrence of scan()) {
      const key = allowanceKey(occurrence)
      remaining.set(key, (remaining.get(key) ?? 0) + 1)
    }
    for (const allowance of ALLOWANCES) {
      const key = allowanceKey(allowance)
      const seen = remaining.get(key) ?? 0
      remaining.set(key, Math.max(0, seen - allowance.count))
    }
    const unallowed = [...remaining.entries()]
      .filter(([, count]) => count > 0)
      .map(([key, count]) => {
        const [rule, file, match] = JSON.parse(key) as [RuleId, string, string]
        const why = RULES.find((r) => r.id === rule)?.why ?? ''
        return `${file}: ${count}× ${match} [${rule}] — ${why}`
      })
      .sort()

    expect(unallowed).toEqual([])
  })

  test('no allowance is stale — a finished migration must delete its entry', () => {
    const counts = new Map<string, number>()
    for (const occurrence of scan()) {
      const key = allowanceKey(occurrence)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const stale = ALLOWANCES.filter((a) => (counts.get(allowanceKey(a)) ?? 0) < a.count).map(
      (a) =>
        `${a.file}: ${a.rule} "${a.match}" expected ${a.count}× but found ${counts.get(allowanceKey(a)) ?? 0}× — delete or shrink this allowance`,
    )

    expect(stale).toEqual([])
  })

  test('every allowance states a reason, and pending ones name the closing task', () => {
    const bad = ALLOWANCES.filter(
      (a) =>
        a.why.trim().length < 20 ||
        a.count < 1 ||
        (a.closedBy !== undefined && !/^RFC-\d{3}-T/.test(a.closedBy)),
    ).map((a) => `${a.file}: ${a.rule} "${a.match}"`)

    expect(bad).toEqual([])
  })

  test('the scan is actually able to see production code', () => {
    // Sanity anchor: a guard whose scanner silently reads nothing is green and
    // worthless (docs/dev-gotchas.md records dependency-cruiser being blind for
    // two years while reporting zero violations). Assert both that we walked a
    // realistic number of files AND that a known-present form is found.
    const files = allProductionTypeScript()
    expect(files.length).toBeGreaterThan(200)
    const occurrences = scan()
    // Anchor on a form that is DELIBERATELY permanent (a synthesized unified
    // diff header), not on one awaiting migration — otherwise finishing that
    // migration silently turns this sanity check into a no-op, which is the
    // exact way a scanner goes blind while still reporting green.
    expect(
      occurrences.some((o) => o.file === 'services/skillVersion.ts' && o.rule === 'null-device'),
    ).toBe(true)
  })
})

// RFC-317 T14 —— 负 fixture：把伪造的违规喂给 **RULES 里那一份 pattern**。
//
// 本文件的注释里已经记了两次「初版正则漏掉一种写法、于是真实违规静默通过」
// （`spawn-without-platform-options` 只匹配对象形态、`posix-path-prefix` 初版
// 键在 call 上）。两次都是**事后人工读代码**才发现的——因为漏匹配的表现就是
// 「零违规」，与合规同形。这一条把每条规则的「咬得动」变成可复跑的断言：规则被
// 收窄到不再命中它自己的典型违规时，这里当场红。
describe('RFC-317 T14 —— matcher 自证：每条规则都必须抓到它自己的典型违规', () => {
  const byId = new Map(RULES.map((rule) => [rule.id, rule.pattern]))

  const CASES: ReadonlyArray<{
    rule: RuleId
    offending: readonly string[]
    clean: readonly string[]
  }> = [
    {
      rule: 'null-device',
      offending: ['stdout: "/dev/null"', "const sink = '/dev/null'"],
      clean: ['const sink = nullDevice()'],
    },
    {
      rule: 'posix-path-list',
      offending: ['PATH: "/usr/local/bin:/usr/bin"', "entries.join(':')"],
      clean: ['entries.join(delimiter)'],
    },
    {
      rule: 'posix-dirname',
      offending: ["const dir = p.slice(0, p.lastIndexOf('/'))"],
      clean: ['const dir = dirname(p)'],
    },
    {
      rule: 'posix-file-identity',
      offending: ['if (a.dev === b.dev && a.ino === b.ino) return true'],
      clean: ['if (await assertSameFileIdentity(a, b)) return true'],
    },
    {
      rule: 'spawn-without-platform-options',
      offending: [
        'Bun.spawn({ cmd, cwd, stdout: "pipe" })',
        'Bun.spawn([bin, "--version"], { cwd, stderr: "pipe" })',
        'Bun.spawnSync({ cmd, cwd })',
      ],
      clean: [
        'Bun.spawn({ cmd, cwd, ...platformSpawnOptions() })',
        'Bun.spawn([bin], { cwd, ...platformSpawnOptions() })',
      ],
    },
    {
      rule: 'posix-path-prefix',
      offending: ['const prefix = `${ctx.worktreePath}/`'],
      clean: ['const inside = isLexicallyInside(root, candidate)'],
    },
  ]

  test('每条规则都在 CASES 里有覆盖（新增规则忘了写 fixture 就红）', () => {
    expect(CASES.map((c) => c.rule).sort()).toEqual(RULES.map((rule) => rule.id).sort())
  })

  const verdicts = (pick: 'offending' | 'clean'): string[] =>
    CASES.flatMap((testCase) => {
      const pattern = byId.get(testCase.rule)
      if (pattern === undefined) return [`${testCase.rule}: 不在 RULES 里`]
      return testCase[pick].filter((sample) => {
        pattern.lastIndex = 0
        return pattern.test(sample) !== (pick === 'offending')
      })
    })

  test('每条规则都抓得到它自己的典型违规（判据被收窄就红）', () => {
    expect(verdicts('offending'), '这些伪造的违规没有被对应规则抓到').toEqual([])
  })

  test('合规写法一个都不误伤（判据被放宽就红）', () => {
    expect(verdicts('clean'), '这些合规写法被规则误报了').toEqual([])
  })
})
