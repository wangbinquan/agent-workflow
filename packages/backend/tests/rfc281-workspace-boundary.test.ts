// RFC-281 T1 — locks the opencode workspace-boundary permission synthesis.
//
// Why this file exists (do not delete on refactor): RFC-281 confines an agent's
// writes/execution to its own task worktree via opencode's `external_directory`
// permission key. The load-bearing invariant is KEY ORDER — proven by T0 live
// probes (design §5 E4/M1): the platform's `external_directory` deny baseline
// must sit AFTER the author's other keys (especially a `'*': 'allow'`), or the
// author's wildcard dissolves the boundary (越界放行). A value-only assertion
// cannot see an ordering regression, so several tests assert key INDICES.
//
// Anchor: production event that motivated the RFC — an agent wandered into a
// sibling task's worktree and executed there. See design/RFC-281 §1.

import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Paths } from '@/util/paths'
import { resolve } from 'node:path'
import {
  claudeExpressibleAuthorDirs,
  machineSkillRoots,
  resolveBoundaryMounts,
  opencodeDataDir,
  claudeWriteBoundaryAvailability,
  composeClaudeBoundarySettings,
  isClaudeRuleExpressible,
  renderClaudeBoundary,
  composeOpencodeBoundary,
  type BoundaryCtx,
} from '../src/services/execution/workspaceBoundary'

const CTX: BoundaryCtx = {
  taskMounts: ['/home/aw/iso/T1/R1'],
  runDir: '/home/aw/runs/T1/R1',
  stagedSkillDirs: ['/home/aw/skills/audit/files'],
  tmpGlobs: ['/tmp/opencode/*'],
}

describe('composeOpencodeBoundary — deny baseline + re-allow', () => {
  test('undefined author yields a deny baseline with re-allow globs, baseline first', () => {
    const out = composeOpencodeBoundary(undefined, CTX)
    const ext = out['external_directory'] as Record<string, string>
    const keys = Object.keys(ext)
    // '*': 'deny' is the baseline and MUST be the first rule (findLast → later
    // allows win over it, never the reverse).
    expect(keys[0]).toBe('*')
    expect(ext['*']).toBe('deny')
    // every W(run) member is re-allowed as `<dir>/*`.
    expect(ext['/home/aw/runs/T1/R1/*']).toBe('allow')
    expect(ext['/home/aw/skills/audit/files/*']).toBe('allow')
    expect(ext['/home/aw/iso/T1/R1/*']).toBe('allow')
    expect(ext['/tmp/opencode/*']).toBe('allow')
  })

  test('gitMetaDirs are re-allowed when present', () => {
    const out = composeOpencodeBoundary(undefined, {
      ...CTX,
      gitMetaDirs: ['/home/user/repo/.git/worktrees/iso'],
    })
    const ext = out['external_directory'] as Record<string, string>
    expect(ext['/home/user/repo/.git/worktrees/iso/*']).toBe('allow')
  })

  test('trailing slashes on dirs do not produce double slashes', () => {
    const out = composeOpencodeBoundary(undefined, { ...CTX, runDir: '/home/aw/runs/T1/R1/' })
    const ext = out['external_directory'] as Record<string, string>
    expect(ext['/home/aw/runs/T1/R1/*']).toBe('allow')
    expect(ext['/home/aw/runs/T1/R1//*']).toBeUndefined()
  })
})

describe('composeOpencodeBoundary — key-order discipline (E4/M1)', () => {
  test("author '*':'allow' cannot dissolve the boundary — external_directory is appended AFTER it", () => {
    const out = composeOpencodeBoundary({ '*': 'allow' }, CTX)
    const keys = Object.keys(out)
    // The whole point: external_directory index > author '*' index, so opencode's
    // findLast picks the deny baseline over the author wildcard (E4 proven).
    expect(keys.indexOf('external_directory')).toBeGreaterThan(keys.indexOf('*'))
    const ext = out['external_directory'] as Record<string, string>
    expect(ext['*']).toBe('deny')
    // author's top-level '*':'allow' is preserved in place (governs OTHER keys,
    // not external_directory, thanks to the ordering).
    expect(out['*']).toBe('allow')
  })

  test('author non-external keys keep their original order; external_directory is last', () => {
    const out = composeOpencodeBoundary({ bash: 'allow', '*': 'allow', read: 'allow' }, CTX)
    const keys = Object.keys(out)
    expect(keys).toEqual(['bash', '*', 'read', 'external_directory'])
  })
})

describe('composeOpencodeBoundary — author external_directory handling', () => {
  test('author record whitelist is honored AFTER the deny baseline (findLast wins)', () => {
    const out = composeOpencodeBoundary(
      { external_directory: { '/home/user/refrepo/*': 'allow' } },
      CTX,
    )
    const ext = out['external_directory'] as Record<string, string>
    const keys = Object.keys(ext)
    expect(keys[0]).toBe('*')
    expect(ext['*']).toBe('deny')
    // author's explicit allow sits after the baseline → it wins for that path.
    expect(ext['/home/user/refrepo/*']).toBe('allow')
    expect(keys.indexOf('/home/user/refrepo/*')).toBeGreaterThan(keys.indexOf('*'))
  })

  test("author scalar external_directory 'allow' takes over the whole key (no baseline)", () => {
    const out = composeOpencodeBoundary({ external_directory: 'allow' }, CTX)
    // explicit scalar = author owns it; platform does not synthesize a baseline
    // (design §3.3 — save-time warns that this waives the boundary).
    expect(out['external_directory']).toBe('allow')
  })

  test("author scalar external_directory 'deny' is left untouched", () => {
    const out = composeOpencodeBoundary({ external_directory: 'deny' }, CTX)
    expect(out['external_directory']).toBe('deny')
  })

  test('author record with its own deny/ask entries is carried through', () => {
    const out = composeOpencodeBoundary(
      { external_directory: { '/x/*': 'deny', '/y/*': 'ask' } },
      CTX,
    )
    const ext = out['external_directory'] as Record<string, string>
    expect(ext['/x/*']).toBe('deny')
    expect(ext['/y/*']).toBe('ask')
    expect(ext['*']).toBe('deny')
  })
})

// ---------------------------------------------------------------------------
// claude side (T2/T3) — write-only boundary, no deny lists
// ---------------------------------------------------------------------------

describe('composeClaudeBoundarySettings — write boundary only', () => {
  test('emits sandbox with allowWrite for this task’s mounts and nothing else', () => {
    const s = composeClaudeBoundarySettings({
      taskMounts: ['/home/aw/iso/T1/R1'],
      explicitPermission: false,
    })
    expect(s.sandbox.enabled).toBe(true)
    expect(s.sandbox.filesystem.allowWrite).toEqual(['/home/aw/iso/T1/R1'])
    // 实现门 P1-3: `allowUnsandboxedCommands` 必须**不发**（claude schema: false
    // 会让 dangerouslyDisableSandbox 被完全忽略 = 移除 headless 下唯一的自救路径，
    // 典型 build 节点写 ~/.bun/cache 撞 EPERM 后就烂在那里）。防误入不需要它。
    expect('allowUnsandboxedCommands' in s.sandbox).toBe(false)
    // bypassPermissions nodes read freely; no additionalDirectories needed.
    expect(s.permissions).toBeUndefined()
  })

  test('NEVER emits denyWrite or a deny list (T0 §5-2: it would kill the agent’s own cwd)', () => {
    const s = composeClaudeBoundarySettings({
      taskMounts: ['/home/aw/iso/T1/R1', '/home/aw/iso/T1/R2'],
      gitMetaDirs: ['/home/user/repo/.git/worktrees/iso'],
      authorAllowDirs: ['/home/user/refrepo'],
      explicitPermission: true,
    })
    const json = JSON.stringify(s)
    // The §0 lock: any denyWrite/denyRead/permissions.deny would risk breaking
    // legitimate business writes (an appHome-ancestor denyWrite shadows cwd).
    expect(json).not.toContain('denyWrite')
    expect(json).not.toContain('denyRead')
    expect(json).not.toContain('"deny"')
    // appHome root itself must never appear as a governed path.
    expect(s.sandbox.filesystem.allowWrite).not.toContain('/home/aw')
  })

  test('explicit-permission nodes get additionalDirectories so multi-repo mounts stay readable (B4)', () => {
    const s = composeClaudeBoundarySettings({
      taskMounts: ['/mnt/a', '/mnt/b'],
      authorAllowDirs: ['/ref'],
      explicitPermission: true,
    })
    expect(s.permissions?.additionalDirectories).toEqual(['/mnt/a', '/mnt/b', '/ref'])
    expect(s.sandbox.filesystem.allowWrite).toEqual(['/mnt/a', '/mnt/b', '/ref'])
    // 实现门 P1-1: additionalDirectories 只给**读**（T0 §5-5 实测 dontAsk 下写
    // additionalDirectory 仍报 "Write tool access not available in current mode"），
    // 写必须由 permissions.allow 的 Edit/Write 规则放行，否则多仓节点写不了另一个仓。
    // `//` = 文件系统根（单斜杠是「相对 settings 源」，会被解成 <项目根>/mnt/a）；
    // 且只发 Edit —— 它覆盖 Write/NotebookEdit，而单独的 Write(...) 规则 claude
    // 接受却从不查询（官方 permissions 文档核实）。
    expect(s.permissions?.allow).toEqual(['Edit(//mnt/a/**)', 'Edit(//mnt/b/**)', 'Edit(//ref/**)'])
  })

  test('dedupes and strips trailing slashes across mounts / git dirs / author dirs', () => {
    const s = composeClaudeBoundarySettings({
      taskMounts: ['/mnt/a/', '/mnt/a'],
      gitMetaDirs: ['/mnt/a'],
      authorAllowDirs: ['/ref/', ''],
      explicitPermission: false,
    })
    expect(s.sandbox.filesystem.allowWrite).toEqual(['/mnt/a', '/ref'])
  })
})

describe('machineSkillRoots — re-allow what opencode itself whitelists (impl-gate P1-2)', () => {
  // opencode's default external_directory whitelist includes skill.dirs()
  // (agent/agent.ts:108-113 @1.18.4), sourced from ~/.claude|.agents skills plus
  // the config-dir {skill,skills} roots (skill/index.ts:185-195). Our deny
  // baseline merges AFTER those defaults and would shadow them — the SKILL.md
  // still reaches the prompt (config layer, not permission), so the model then
  // reads a sibling script and gets denied: a half-working skill.
  const ORIG = process.env['XDG_CONFIG_HOME']
  afterEach(() => {
    if (ORIG === undefined) delete process.env['XDG_CONFIG_HOME']
    else process.env['XDG_CONFIG_HOME'] = ORIG
  })

  test('covers the claude/agents external roots and the opencode config roots', () => {
    delete process.env['XDG_CONFIG_HOME']
    expect(machineSkillRoots('/home/u')).toEqual([
      '/home/u/.claude/skills',
      '/home/u/.agents/skills',
      '/home/u/.config/opencode/skill',
      '/home/u/.config/opencode/skills',
      '/home/u/.opencode/skill',
      '/home/u/.opencode/skills',
    ])
  })

  test('honors XDG_CONFIG_HOME for the opencode config roots', () => {
    process.env['XDG_CONFIG_HOME'] = '/cfg'
    const roots = machineSkillRoots('/home/u')
    expect(roots).toContain('/cfg/opencode/skills')
    expect(roots).not.toContain('/home/u/.config/opencode/skills')
  })

  test('the boundary re-allows each root as a subtree glob', () => {
    const roots = machineSkillRoots('/home/u')
    const ext = composeOpencodeBoundary(undefined, {
      ...CTX,
      stagedSkillDirs: ['/run/.opencode/skills', ...roots],
    })['external_directory'] as Record<string, string>
    for (const root of roots) expect(ext[`${root}/*`]).toBe('allow')
  })
})

describe('opencodeDataDir — matches opencode’s own XDG data resolution', () => {
  // Read from opencode source (packages/core/src/global.ts:11 @1.18.16):
  //   data = path.join(xdgData, 'opencode')
  // and xdg-basedir resolves xdgData as $XDG_DATA_HOME || ~/.local/share on
  // every platform (no darwin special case). `<data>/tool-output` holds
  // truncated tool payloads the agent reads back, so the boundary must
  // re-allow it or a large-file read trips the fence (§0).
  const ORIG = process.env['XDG_DATA_HOME']
  afterEach(() => {
    if (ORIG === undefined) delete process.env['XDG_DATA_HOME']
    else process.env['XDG_DATA_HOME'] = ORIG
  })

  test('falls back to ~/.local/share/opencode', () => {
    delete process.env['XDG_DATA_HOME']
    expect(opencodeDataDir('/home/u')).toBe('/home/u/.local/share/opencode')
  })

  test('honors XDG_DATA_HOME when set', () => {
    process.env['XDG_DATA_HOME'] = '/custom/xdg'
    expect(opencodeDataDir('/home/u')).toBe('/custom/xdg/opencode')
  })

  test('an empty XDG_DATA_HOME is treated as unset', () => {
    process.env['XDG_DATA_HOME'] = ''
    expect(opencodeDataDir('/home/u')).toBe('/home/u/.local/share/opencode')
  })
})

describe('§0 guard — the agent’s own cwd is always inside the boundary', () => {
  // Locks the REAL function the runner calls (impl-gate P3-7: this used to be a
  // copy of runner.ts's expression, so deleting that code left the test green).
  test('cwd is prepended when the repo metadata lists other paths (canonical vs iso skew)', () => {
    const cwd = '/home/aw/iso/T1/R1'
    const mounts = resolveBoundaryMounts(cwd, ['/home/aw/worktrees/repo/T1'])
    expect(mounts[0]).toBe(cwd)
    const ext = composeOpencodeBoundary(undefined, { ...CTX, taskMounts: mounts })[
      'external_directory'
    ] as Record<string, string>
    expect(ext[`${cwd}/*`]).toBe('allow')
  })

  test('empty / blank repo metadata still yields the cwd', () => {
    expect(resolveBoundaryMounts('/w', [])).toEqual(['/w'])
    expect(resolveBoundaryMounts('/w', [''])).toEqual(['/w'])
  })

  test('no duplicate when the metadata already contains cwd', () => {
    expect(resolveBoundaryMounts('/w', ['/w', '/w2'])).toEqual(['/w', '/w2'])
  })

  test('multi-repo metadata is preserved in order', () => {
    expect(resolveBoundaryMounts('/w', ['/w', '/w2', '/w3'])).toEqual(['/w', '/w2', '/w3'])
  })

  test('the runner wires this function (source lock, not a re-implementation)', () => {
    const src = readFileSync(resolve(import.meta.dir, '../src/services/runner.ts'), 'utf-8')
    expect(src).toContain('resolveBoundaryMounts(')
    expect(src).toContain('opts.worktreePath,')
  })
})

describe('claudeWriteBoundaryAvailability — degrade loudly, never block (AC-6)', () => {
  const all = () => true
  const none = () => false

  test('macOS always has the mechanism', () => {
    expect(claudeWriteBoundaryAvailability('darwin', none)).toEqual({ available: true })
  })

  test('linux with bwrap+socat is available', () => {
    expect(claudeWriteBoundaryAvailability('linux', all)).toEqual({ available: true })
  })

  test('linux missing a dependency reports WHICH one (diagnosable, not silent)', () => {
    const r = claudeWriteBoundaryAvailability('linux', (bin) => bin !== 'socat')
    expect(r.available).toBe(false)
    expect(r.reason).toBe('missing-dependencies:socat')
  })

  test('an unsupported platform names itself in the reason', () => {
    const r = claudeWriteBoundaryAvailability('win32', all)
    expect(r.available).toBe(false)
    expect(r.reason).toBe('unsupported-platform:win32')
  })
})

describe('AC-8 — platform-sensitive paths are outside the re-allow set', () => {
  // impl-gate P3-8: enumerate `Paths` instead of hand-copying a list — a new
  // secret-bearing entry (e.g. `.daemon.control`, which carries the shutdown
  // nonce) must be covered the day it is added, not the day someone remembers.
  // Evaluation mirrors opencode's own semantics (findLast over Wildcard.match,
  // `*` crossing `/`), so a too-broad allow like `/home/*` would fail this.
  const APP_HOME = '/home/aw'
  const OTHER_TASK = [
    `${APP_HOME}/iso/OTHER_TASK/run1`,
    `${APP_HOME}/runs/OTHER_TASK/run1`,
    `${APP_HOME}/worktrees/repo/OTHER_TASK`,
  ]

  const platformPaths = (): string[] => {
    const out: string[] = []
    for (const key of Object.keys(Paths)) {
      const value = (Paths as unknown as Record<string, unknown>)[key]
      if (typeof value === 'string' && value.length > 0) out.push(value)
    }
    return out
  }

  /** opencode's裁决: last matching rule wins; `*` crosses `/`. */
  const decide = (rules: Record<string, string>, target: string): string => {
    const toRe = (pattern: string): RegExp =>
      new RegExp(
        '^' +
          pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.') +
          '$',
        's',
      )
    let verdict = 'deny'
    for (const [pattern, action] of Object.entries(rules)) {
      if (toRe(pattern).test(target)) verdict = action
    }
    return verdict
  }

  test('opencode: every platform path and every other task path evaluates to deny', () => {
    const ext = composeOpencodeBoundary(undefined, CTX)['external_directory'] as Record<
      string,
      string
    >
    const targets = [...platformPaths(), ...OTHER_TASK]
    expect(targets.length).toBeGreaterThan(5) // the enumeration really produced paths
    for (const target of targets) {
      // the boundary's re-allow set covers this run's own dirs only; these are
      // outside it, so the deny baseline must survive the findLast pass.
      expect({ target, verdict: decide(ext, target) }).toEqual({ target, verdict: 'deny' })
    }
  })

  test('claude: no platform path enters allowWrite (write stays cwd+tmp+mounts)', () => {
    const s = composeClaudeBoundarySettings({
      taskMounts: ['/home/aw/iso/T1/R1'],
      explicitPermission: true,
    })
    const allow = s.sandbox.filesystem.allowWrite
    for (const target of [...platformPaths(), ...OTHER_TASK]) expect(allow).not.toContain(target)
  })
})

describe('claudeExpressibleAuthorDirs — literal dirs only, lossy globs disclosed', () => {
  test('literal dirs (with or without /*) become claude-expressible paths', () => {
    const r = claudeExpressibleAuthorDirs({
      external_directory: { '/home/me/refrepo/*': 'allow', '/opt/data': 'allow' },
    })
    expect(r.dirs).toEqual(['/home/me/refrepo', '/opt/data'])
    expect(r.lossy).toEqual([])
  })

  test('mid-pattern globs are reported as lossy, never silently dropped', () => {
    const r = claudeExpressibleAuthorDirs({ external_directory: { '/a/*/b': 'allow' } })
    expect(r.dirs).toEqual([])
    expect(r.lossy).toEqual(['/a/*/b'])
  })

  test('non-allow entries and the bare wildcard are ignored', () => {
    const r = claudeExpressibleAuthorDirs({
      external_directory: { '*': 'allow', '/x': 'deny', '/y': 'ask' },
    })
    expect(r.dirs).toEqual([])
    expect(r.lossy).toEqual([])
  })

  test('missing / scalar external_directory yields nothing', () => {
    expect(claudeExpressibleAuthorDirs(undefined).dirs).toEqual([])
    expect(claudeExpressibleAuthorDirs({ external_directory: 'allow' }).dirs).toEqual([])
  })
})

describe('claude rule expressibility — never emit a rule we cannot predict (self-probe S1/S2)', () => {
  // Local probe on the pre-fix code produced `Edit(//data/repo (old)/src/**)`
  // — the `)` closes the rule early — and `Edit(//data/re*po/**)`, where a REAL
  // asterisk in the directory name becomes a wildcard that matches OTHER dirs.
  // Rules are gitignore syntax and the official docs state self-written rules
  // are not escaped (and document no escape for `)`), so such dirs get the
  // plain-path treatment only.
  test('paths with gitignore-pattern characters are excluded from `allow` but stay writable', () => {
    const clean = '/home/aw/iso/T1/R1'
    const parens = '/data/repo (old)/src'
    const star = '/data/re*po'
    const r = renderClaudeBoundary({
      taskMounts: [clean, parens, star],
      explicitPermission: true,
    })
    // sandbox + additionalDirectories are plain path lists → every dir is there
    expect(r.settings.sandbox.filesystem.allowWrite).toEqual([clean, parens, star])
    expect(r.settings.permissions?.additionalDirectories).toEqual([clean, parens, star])
    // only the clean one becomes a rule
    expect(r.settings.permissions?.allow).toEqual([`Edit(//home/aw/iso/T1/R1/**)`])
    expect(r.unexpressibleDirs).toEqual([parens, star])
  })

  test('no `allow` key at all when every mount is unexpressible (never emit a broken rule)', () => {
    const r = renderClaudeBoundary({ taskMounts: ['/a/b(c)'], explicitPermission: true })
    expect(r.settings.permissions?.allow).toBeUndefined()
    expect(r.settings.permissions?.additionalDirectories).toEqual(['/a/b(c)'])
  })

  test('spaces and non-ASCII are fine — they are not pattern characters', () => {
    expect(isClaudeRuleExpressible('/Users/me/My Project/repo')).toBe(true)
    expect(isClaudeRuleExpressible('/数据/仓库')).toBe(true)
    for (const bad of ['/a/b(c)', '/a/b)c', '/a/re*po', '/a/b?c', '/a/[x]', '/a/b\\c']) {
      expect({ bad, ok: isClaudeRuleExpressible(bad) }).toEqual({ bad, ok: false })
    }
  })
})
