// RFC-154 — per-runtime config-dir injection configurability. Locks in:
//   (1) validateConfigDirName / validateConfigDirEnv — path-traversal +
//       reserved-spawn-env rejection (Codex design-gate P1/P3);
//   (2) resolve: NULL columns → protocol default; row overrides win; empty
//       strings fold to default; CRUD round-trip through migration 0079 columns;
//   (3) freeze survival (Codex design-gate P1): the configDir frozen at first
//       dispatch survives a later edit of the mutable runtimes row — resume /
//       frozenRuntimeOfSession read the snapshot; legacy runtime_params_json
//       (no __configDir key) reads back as the protocol default;
//   (4) spawn: custom env/name land in the business spawn env + skills staging
//       path for BOTH drivers, and the DEFAULT env var name is ABSENT when a
//       custom one is configured;
//   (5) the runner-preamble redundancy fix: claude business spawns create no
//       `.opencode` dir (pre-RFC-154 the runtime-blind preamble staged skills
//       into `.opencode` even for claude — a dead copy);
//   (6) stageSkills: empty list still creates `<configDir>/skills` (opencode
//       1.17+ writes a .gitignore into the config dir on startup and exits 1
//       when it is missing — see runtime-smoke.test.ts), managed→copy,
//       project→skip, strict vs bestEffort failure modes (RFC-178: managed-only);
//   (7) source guard: the config-dir literals stay confined to the shared
//       DEFAULT_CONFIG_DIR_PROFILE single source (+ the two homedir fallbacks
//       that reference the REAL ~/.claude, not our per-run dir).

import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { DEFAULT_CONFIG_DIR_PROFILE, RESERVED_SPAWN_ENV } from '@agent-workflow/shared'
import type { Agent } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { frozenRuntimeOfSession, resolveFrozenRuntime } from '../src/services/nodeRunMint'
import {
  createRuntime,
  defaultConfigDirProfile,
  resolveRuntimeByName,
  seedBuiltinRuntimes,
  updateRuntime,
  validateConfigDirEnv,
  validateConfigDirName,
} from '../src/services/runtimeRegistry'
import { getRuntimeDriver } from '../src/services/runtime'
import type { BusinessNodeSpawnContext } from '../src/services/runtime/types'
import { stageSkills } from '../src/services/runtime/stageSkills'
import { createLogger } from '../src/util/log'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const log = createLogger('rfc154-test')

// --- (1) validators ----------------------------------------------------------

describe('RFC-154 validateConfigDirName', () => {
  test('accepts a leaf name; trims; empty/null → null (unset)', () => {
    expect(validateConfigDirName('.mycode')).toBe('.mycode')
    expect(validateConfigDirName('  cfg  ')).toBe('cfg')
    expect(validateConfigDirName('')).toBeNull()
    expect(validateConfigDirName('   ')).toBeNull()
    expect(validateConfigDirName(null)).toBeNull()
    expect(validateConfigDirName(undefined)).toBeNull()
  })

  test('rejects separators, traversal, "." and NUL', () => {
    for (const bad of ['../x', 'a/b', '/abs', 'a\\b', '.', '..', 'a\0b']) {
      expect(() => validateConfigDirName(bad)).toThrow()
    }
  })
})

describe('RFC-154 validateConfigDirEnv', () => {
  test('accepts legal env names; empty/null → null (unset)', () => {
    expect(validateConfigDirEnv('MYCODE_CONFIG_DIR')).toBe('MYCODE_CONFIG_DIR')
    expect(validateConfigDirEnv('_x9')).toBe('_x9')
    expect(validateConfigDirEnv('')).toBeNull()
    expect(validateConfigDirEnv(null)).toBeNull()
  })

  test('rejects illegal names', () => {
    for (const bad of ['9BAD', 'A B', 'A=B', 'A-B', 'ü']) {
      expect(() => validateConfigDirEnv(bad)).toThrow()
    }
  })

  test('rejects every platform-reserved spawn key (Codex P1)', () => {
    // Full sweep so a future RESERVED_SPAWN_ENV addition is covered automatically.
    for (const reserved of RESERVED_SPAWN_ENV) {
      expect(() => validateConfigDirEnv(reserved)).toThrow(/reserved/)
    }
    // The agent-definition channel is the load-bearing one — assert it by name.
    expect(() => validateConfigDirEnv('OPENCODE_CONFIG_CONTENT')).toThrow()
  })

  test("the OTHER protocol's default config-dir env is deliberately NOT reserved", () => {
    expect(validateConfigDirEnv('OPENCODE_CONFIG_DIR')).toBe('OPENCODE_CONFIG_DIR')
    expect(validateConfigDirEnv('CLAUDE_CONFIG_DIR')).toBe('CLAUDE_CONFIG_DIR')
  })
})

// --- (2) resolve + CRUD round-trip (exercises migration 0079 columns) --------

describe('RFC-154 resolve — NULL → protocol default, overrides win', () => {
  test('defaultConfigDirProfile matches the shared single source per kind', () => {
    expect(defaultConfigDirProfile('opencode')).toEqual(DEFAULT_CONFIG_DIR_PROFILE.opencode)
    expect(defaultConfigDirProfile('claude-code')).toEqual(
      DEFAULT_CONFIG_DIR_PROFILE['claude-code'],
    )
  })

  test('seeded built-ins resolve to the protocol default', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBuiltinRuntimes(db)
    const oc = await resolveRuntimeByName(db, 'opencode')
    expect(oc.configDir).toEqual({ env: 'OPENCODE_CONFIG_DIR', name: '.opencode' })
    const cc = await resolveRuntimeByName(db, 'claude-code')
    expect(cc.configDir).toEqual({ env: 'CLAUDE_CONFIG_DIR', name: '.claude' })
    // Unseeded-name + unknown-name fallbacks carry the default too.
    const db2 = createInMemoryDb(MIGRATIONS)
    expect((await resolveRuntimeByName(db2, 'claude-code')).configDir.env).toBe('CLAUDE_CONFIG_DIR')
    expect((await resolveRuntimeByName(db2, 'no-such')).configDir.env).toBe('OPENCODE_CONFIG_DIR')
  })

  test('custom row: create → resolve overrides; update → clears back to default', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBuiltinRuntimes(db)
    await createRuntime(db, {
      name: 'myfork',
      protocol: 'opencode',
      binaryPath: '/opt/myfork',
      configDirEnv: 'MYFORK_CONFIG_DIR',
      configDirName: '.myfork',
    })
    const r = await resolveRuntimeByName(db, 'myfork')
    expect(r.configDir).toEqual({ env: 'MYFORK_CONFIG_DIR', name: '.myfork' })
    // Partial override: only the env customized → name stays default.
    await updateRuntime(db, 'myfork', { configDirName: null })
    expect((await resolveRuntimeByName(db, 'myfork')).configDir).toEqual({
      env: 'MYFORK_CONFIG_DIR',
      name: '.opencode',
    })
    // Empty string on update folds to NULL (unset).
    await updateRuntime(db, 'myfork', { configDirEnv: '' })
    expect((await resolveRuntimeByName(db, 'myfork')).configDir).toEqual(
      DEFAULT_CONFIG_DIR_PROFILE.opencode,
    )
  })

  test('create/update reject invalid values (service-level, not just the route)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBuiltinRuntimes(db)
    expect(
      createRuntime(db, { name: 'bad1', protocol: 'opencode', configDirName: '../evil' }),
    ).rejects.toThrow()
    expect(
      createRuntime(db, { name: 'bad2', protocol: 'opencode', configDirEnv: 'PWD' }),
    ).rejects.toThrow()
    await createRuntime(db, { name: 'ok', protocol: 'opencode' })
    expect(updateRuntime(db, 'ok', { configDirEnv: 'OPENCODE_CONFIG_CONTENT' })).rejects.toThrow()
  })
})

// --- (3) freeze survival (Codex P1) -------------------------------------------

async function seedRun(db: DbClient): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/r',
    worktreePath: '/w',
    baseBranch: 'main',
    branch: 'b',
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  const id = ulid()
  await db.insert(nodeRuns).values({ id, taskId, nodeId: 'n1', status: 'pending' })
  return id
}

describe('RFC-154 freeze — configDir rides the runtime snapshot', () => {
  test('frozen at first dispatch; a later row edit does NOT re-route resume', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBuiltinRuntimes(db)
    await createRuntime(db, {
      name: 'myfork',
      protocol: 'opencode',
      configDirEnv: 'MYFORK_CONFIG_DIR',
      configDirName: '.myfork',
    })
    const id = await seedRun(db)
    const first = await resolveFrozenRuntime(db, id, 'myfork', null)
    expect(first.configDir).toEqual({ env: 'MYFORK_CONFIG_DIR', name: '.myfork' })
    // Mutate the registry row — the frozen snapshot must not follow.
    await updateRuntime(db, 'myfork', { configDirEnv: 'CHANGED_DIR', configDirName: '.changed' })
    const resumed = await resolveFrozenRuntime(db, id, 'myfork', null)
    expect(resumed.configDir).toEqual({ env: 'MYFORK_CONFIG_DIR', name: '.myfork' })
  })

  test('frozenRuntimeOfSession returns the frozen configDir', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBuiltinRuntimes(db)
    await createRuntime(db, {
      name: 'myfork',
      protocol: 'claude-code',
      configDirEnv: 'MYFORK_CONFIG_DIR',
      configDirName: '.myfork',
    })
    const id = await seedRun(db)
    await resolveFrozenRuntime(db, id, 'myfork', null)
    await db.update(nodeRuns).set({ opencodeSessionId: 'ses_x' }).where(eq(nodeRuns.id, id))
    const frozen = await frozenRuntimeOfSession(db, 'ses_x')
    expect(frozen?.configDir).toEqual({ env: 'MYFORK_CONFIG_DIR', name: '.myfork' })
  })

  test('legacy runtime_params_json (no __configDir) reads back as protocol default', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const id = await seedRun(db)
    // Hand-freeze a pre-RFC-154 shape: params only, no __configDir key.
    await db
      .update(nodeRuns)
      .set({
        runtime: 'claude-code',
        runtimeParamsJson: JSON.stringify({ model: 'opus' }),
      })
      .where(eq(nodeRuns.id, id))
    const r = await resolveFrozenRuntime(db, id, null, null)
    expect(r.params.model).toBe('opus')
    expect(r.configDir).toEqual(DEFAULT_CONFIG_DIR_PROFILE['claude-code'])
  })

  test('params whitelist keeps __configDir out of RuntimeProfile', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBuiltinRuntimes(db)
    const id = await seedRun(db)
    const frozen = await resolveFrozenRuntime(db, id, 'opencode', null)
    expect('__configDir' in frozen.params).toBe(false)
    // The persisted JSON carries both faces.
    const row = (
      await db
        .select({ json: nodeRuns.runtimeParamsJson })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, id))
    )[0]
    const parsed = JSON.parse(row?.json ?? '{}') as Record<string, unknown>
    expect(parsed.__configDir).toEqual(DEFAULT_CONFIG_DIR_PROFILE.opencode)
  })
})

// --- (4)+(5) spawn: custom env/name in both drivers; no `.opencode` for claude --

function mkAgent(name: string): Agent {
  return {
    id: 'a-' + name,
    name,
    description: 'd',
    bodyMd: '## body',
    outputs: [],
    permission: {},
    skills: [],
    mcps: [],
    plugins: [],
    dependsOn: [],
    runtime: null,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Agent
}

function mkSpawnCtx(
  runRoot: string,
  overrides: Partial<BusinessNodeSpawnContext>,
): BusinessNodeSpawnContext {
  return {
    agent: mkAgent('root-agent'),
    prompt: 'P',
    injectedMemoryBlock: null,
    dependents: [],
    mcps: [],
    plugins: [],
    resolvedParamsByAgent: new Map(),
    skills: [],
    worktreePath: '/wt',
    runRoot,
    configDir: DEFAULT_CONFIG_DIR_PROFILE.opencode,
    wantsInventory: false,
    nodeRunId: 'nr-1',
    log,
    ...overrides,
  }
}

describe('RFC-154 spawn — custom config-dir profile lands in env + staging path', () => {
  test('opencode: custom env/name → FOO_DIR set, OPENCODE_CONFIG_DIR absent, skills under .foo', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-rfc154-oc-'))
    // Codex impl-gate P2: even when the DAEMON's own environment carries the
    // protocol default key, a custom-env spawn must scrub it — otherwise the
    // child sees BOTH keys and a fork that still consults the default one lands
    // in a stale dir. (Without the poison this assertion passes vacuously.)
    const prevEnv = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = '/stale/daemon/value'
    try {
      const ctx = mkSpawnCtx(runRoot, {
        opencodeCmd: ['oc'],
        configDir: { env: 'FOO_DIR', name: '.foo' },
      })
      const plan = await getRuntimeDriver('opencode').buildBusinessSpawn(ctx)
      expect(plan.env.FOO_DIR).toBe(join(runRoot, '.foo'))
      // The default key must NOT be set alongside the custom one (a fork reading
      // FOO_DIR would work, but a stale OPENCODE_CONFIG_DIR would mislead stock
      // binaries and debuggers about where the config lives).
      expect(plan.env.OPENCODE_CONFIG_DIR).toBeUndefined()
      expect(existsSync(join(runRoot, '.foo', 'skills'))).toBe(true)
      expect(existsSync(join(runRoot, '.opencode'))).toBe(false)
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = prevEnv
      rmSync(runRoot, { recursive: true, force: true })
    }
  })

  test('opencode: default profile stays byte-identical (golden anchor)', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-rfc154-oc2-'))
    try {
      const ctx = mkSpawnCtx(runRoot, { opencodeCmd: ['oc'] })
      const plan = await getRuntimeDriver('opencode').buildBusinessSpawn(ctx)
      expect(plan.env.OPENCODE_CONFIG_DIR).toBe(join(runRoot, '.opencode'))
      expect(existsSync(join(runRoot, '.opencode', 'skills'))).toBe(true)
    } finally {
      rmSync(runRoot, { recursive: true, force: true })
    }
  })

  test('claude: custom env/name → BAR_DIR set, CLAUDE_CONFIG_DIR absent, skills under .bar, NO .opencode (redundancy fix)', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-rfc154-cc-'))
    // Codex impl-gate P2 (claude side): poison the daemon env with the default
    // key — the custom-env spawn must scrub it (see the opencode twin above).
    const prevEnv = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = '/stale/daemon/value'
    try {
      const ctx = mkSpawnCtx(runRoot, {
        runtimeCmd: ['cc'], // test head → credential bridge off
        configDir: { env: 'BAR_DIR', name: '.bar' },
        skills: [],
      })
      const plan = await getRuntimeDriver('claude-code').buildBusinessSpawn(ctx)
      expect(plan.env.BAR_DIR).toBe(join(runRoot, '.bar'))
      expect(plan.env.CLAUDE_CONFIG_DIR).toBeUndefined()
      expect(existsSync(join(runRoot, '.bar', 'skills'))).toBe(true)
      // Regression lock (RFC-154): pre-154 the runner's runtime-blind preamble
      // created `.opencode` for EVERY run incl. claude — a dead copy the claude
      // binary never read. Locks the runner-preamble removal.
      expect(existsSync(join(runRoot, '.opencode'))).toBe(false)
    } finally {
      if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prevEnv
      rmSync(runRoot, { recursive: true, force: true })
    }
  })

  test('claude: default profile → CLAUDE_CONFIG_DIR at <runRoot>/.claude (golden anchor)', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-rfc154-cc2-'))
    try {
      const ctx = mkSpawnCtx(runRoot, {
        runtimeCmd: ['cc'],
        configDir: DEFAULT_CONFIG_DIR_PROFILE['claude-code'],
      })
      const plan = await getRuntimeDriver('claude-code').buildBusinessSpawn(ctx)
      expect(plan.env.CLAUDE_CONFIG_DIR).toBe(join(runRoot, '.claude'))
      expect(existsSync(join(runRoot, '.claude', 'skills'))).toBe(true)
    } finally {
      rmSync(runRoot, { recursive: true, force: true })
    }
  })
})

// --- (6) stageSkills ----------------------------------------------------------

describe('RFC-154 stageSkills', () => {
  test('empty list still creates <configDir>/skills (opencode pre-spawn contract)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-rfc154-st-'))
    try {
      stageSkills(join(dir, 'cfg'), [], log)
      expect(existsSync(join(dir, 'cfg', 'skills'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('managed → copy, project → skip, missing sourcePath → skip+warn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-rfc154-st2-'))
    try {
      const managedSrc = join(dir, 'managed-src')
      mkdirSync(managedSrc, { recursive: true })
      writeFileSync(join(managedSrc, 'SKILL.md'), 'managed')
      const cfg = join(dir, 'cfg')
      stageSkills(
        cfg,
        [
          { name: 'm', sourceKind: 'managed', sourcePath: managedSrc },
          { name: 'p', sourceKind: 'project', sourcePath: '/never' },
          { name: 'x', sourceKind: 'managed' }, // missing sourcePath
        ],
        log,
      )
      expect(readFileSync(join(cfg, 'skills', 'm', 'SKILL.md'), 'utf8')).toBe('managed')
      expect(existsSync(join(cfg, 'skills', 'p'))).toBe(false)
      expect(existsSync(join(cfg, 'skills', 'x'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('strict mode throws on a staging error; bestEffort logs and continues', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-rfc154-st3-'))
    try {
      const cfg = join(dir, 'cfg')
      // A managed skill whose sourcePath does not exist → cpSync throws.
      const broken = [{ name: 'b', sourceKind: 'managed' as const, sourcePath: join(dir, 'nope') }]
      expect(() => stageSkills(cfg, broken, log)).toThrow()
      expect(() => stageSkills(cfg, broken, log, { bestEffort: true })).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// --- (7) source guards ---------------------------------------------------------

describe('RFC-154 source guards — config-dir literals confined to the single source', () => {
  const BACKEND_SRC = resolve(import.meta.dir, '../src')

  test('runner.ts no longer hardcodes the .opencode preamble', () => {
    const src = readFileSync(join(BACKEND_SRC, 'services/runner.ts'), 'utf8')
    expect(src).not.toContain("join(runRoot, '.opencode')")
    expect(src).not.toContain('prepareSkills(')
  })

  test('drivers/spawn modules carry no quoted config-dir literals (import the shared profile instead)', () => {
    // The homedir fallbacks reference the REAL ~/.claude (vanilla claude's home
    // dir — semantically NOT our per-run profile) and stay literal by design:
    //   claudeCode/sessionCapture.ts (transcript fallback)
    //   claudeCode/config.ts (credentials bridge source)
    const files = [
      'services/runner.ts',
      'services/runtime/opencode/driver.ts',
      'services/runtime/opencode/spawn.ts',
      'services/runtime/claudeCode/driver.ts',
      'services/runtime/claudeCode/spawn.ts',
      'services/runtime/stageSkills.ts',
    ]
    for (const f of files) {
      const src = readFileSync(join(BACKEND_SRC, f), 'utf8')
      const code = src
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n')
      expect(code).not.toContain("'OPENCODE_CONFIG_DIR'")
      expect(code).not.toContain("'CLAUDE_CONFIG_DIR'")
      expect(code).not.toContain("'.opencode'")
      expect(code).not.toContain("'.claude'")
    }
  })
})
