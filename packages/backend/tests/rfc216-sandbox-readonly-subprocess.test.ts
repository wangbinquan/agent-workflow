// RFC-216 §6 — the BEHAVIORAL read-only proof (P1#1/#2-r4). A real child process
// runs the real sandboxCommand (real Bun.spawn/which/readConfig) with:
//   - HOME / AGENT_WORKFLOW_HOME / cwd / TMPDIR / XDG_{CONFIG,CACHE}_HOME all
//     pointed at separate MONITORED dirs (closes the cwd/tmp/XDG write escapes),
//   - a PATH holding fake apt-get/dnf/…/sudo/sysctl/sh that write a sentinel iff
//     executed, and (scenario B) a fake bwrap that records its argv OUTSIDE the
//     monitored dirs and exits non-zero.
// Assertions: no forbidden binary ever executed (no sentinel), nothing written
// into any monitored dir (incl. no config.json), and the probe legitimately ran
// bwrap with the exact whitelisted argv. A "print → execute" or
// "readConfig → loadConfig" regression writes a sentinel / a config.json → red.

import { describe, expect, it, afterEach } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const FORBIDDEN = ['apt-get', 'dnf', 'pacman', 'apk', 'zypper', 'sudo', 'sysctl', 'sh', 'bash']
const MONITORED = ['home', 'awhome', 'cwd', 'tmp', 'xdgConfig', 'xdgCache'] as const

type Dirs = Record<(typeof MONITORED)[number] | 'bin' | 'sentinels' | 'marker', string>

function setup(withBwrap: boolean): Dirs {
  const root = mkdtempSync(join(tmpdir(), 'rfc216-sub-'))
  roots.push(root)
  const dirs = {
    home: join(root, 'home'),
    awhome: join(root, 'awhome'),
    cwd: join(root, 'cwd'),
    tmp: join(root, 'tmp'),
    xdgConfig: join(root, 'xdgconfig'),
    xdgCache: join(root, 'xdgcache'),
    bin: join(root, 'bin'),
    sentinels: join(root, 'sentinels'),
    marker: join(root, 'marker'), // OUTSIDE the monitored set — bwrap's argv sink
  } as Dirs
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })

  for (const b of FORBIDDEN) {
    const p = join(dirs.bin, b)
    writeFileSync(p, `#!/bin/sh\ntouch "${join(dirs.sentinels, b)}"\nexit 0\n`)
    chmodSync(p, 0o755)
  }
  if (withBwrap) {
    const p = join(dirs.bin, 'bwrap')
    writeFileSync(
      p,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${join(dirs.marker, 'bwrap-argv')}"\nexit 1\n`,
    )
    chmodSync(p, 0o755)
  }
  return dirs
}

function run(dirs: Dirs, args: string[] = []) {
  const fixture = join(import.meta.dir, 'fixtures', 'rfc216-run-sandbox.ts')
  const proc = Bun.spawnSync({
    cmd: [process.execPath, fixture, ...args],
    cwd: dirs.cwd,
    env: {
      PATH: dirs.bin, // child resolves bwrap/apt-get ONLY from the fake bin
      HOME: dirs.home,
      AGENT_WORKFLOW_HOME: dirs.awhome,
      TMPDIR: dirs.tmp,
      TMP: dirs.tmp,
      TEMP: dirs.tmp,
      XDG_CONFIG_HOME: dirs.xdgConfig,
      XDG_CACHE_HOME: dirs.xdgCache,
      RFC216_FAKE_PLATFORM: 'linux',
      // Disable Bun's OWN runtime transpiler cache — otherwise the interpreter
      // (not the code under test) writes $XDG_CACHE_HOME/bun and trips the
      // zero-write assertion. With it off, any write into a monitored dir is
      // genuinely sandboxCommand's doing.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    code: proc.exitCode,
  }
}

/** Files written into ANY monitored dir — must be empty (zero-write). */
function monitoredWrites(dirs: Dirs): string[] {
  const bad: string[] = []
  for (const key of MONITORED) {
    for (const e of readdirSync(dirs[key])) bad.push(`${key}/${e}`)
  }
  return bad
}
/** Which forbidden binaries left a sentinel — must be empty (zero forbidden exec). */
function executedForbidden(dirs: Dirs): string[] {
  return readdirSync(dirs.sentinels)
}

describe('sandbox preflight — real subprocess, isolated env, zero write / zero forbidden exec', () => {
  it('scenario A (bwrap not installed): prints install command, executes nothing, writes nothing', () => {
    const dirs = setup(/* withBwrap */ false)
    const r = run(dirs)

    expect(executedForbidden(dirs)).toEqual([]) // detectPackageManager uses which(), never runs apt-get
    expect(monitoredWrites(dirs)).toEqual([]) // incl. NO config.json in AGENT_WORKFLOW_HOME (readConfig is read-only)
    expect(r.stdout).toContain('apt-get install -y bubblewrap') // apt-get IS on PATH → detected
    expect(r.stdout).not.toContain('sysctl')
    expect(r.code).toBe(1) // linux warn + unavailable
  })

  it('scenario B (installed but broken): no install command, runs the exact probe argv, executes no forbidden binary, writes nothing', () => {
    const dirs = setup(/* withBwrap */ true)
    const r = run(dirs)

    expect(executedForbidden(dirs)).toEqual([]) // apt/sysctl/sudo/sh never invoked
    expect(monitoredWrites(dirs)).toEqual([]) // zero write into any monitored dir
    // The probe DID legitimately execute bwrap with the whitelisted argv:
    const argv = readFileSync(join(dirs.marker, 'bwrap-argv'), 'utf-8')
    expect(argv).toContain('--bind / / -- /bin/true')
    // ...and the report is the installed-but-broken branch, NOT an install prompt:
    expect(r.stdout).toContain('已安装但试跑失败')
    expect(r.stdout).not.toContain('install -y bubblewrap')
    expect(r.code).toBe(1)
  })

  it('--require-available on an unavailable host is non-zero (CI gate)', () => {
    const dirs = setup(false)
    const r = run(dirs, ['--require-available'])
    expect(r.code).toBe(1)
    expect(monitoredWrites(dirs)).toEqual([])
  })
})
