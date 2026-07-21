// RFC-205 T2 — sandbox mechanism probe.
//
// Existence is NOT usability (design Q3): bwrap installs fine on distros where
// unprivileged user namespaces are disabled and then fails at spawn; a Seatbelt
// profile can be rejected by a hardened host. So the probe RUNS the mechanism
// once around /usr/bin/true and believes only the exit code. Probed once per
// daemon boot and cached (the mechanism doesn't come and go mid-process; a
// fresh probe rides the next restart).

export type SandboxMechanism = 'seatbelt' | 'bwrap'

export interface SandboxStatus {
  mechanism: SandboxMechanism | null
  available: boolean
  /** Human hint when unavailable (surfaced by the status API / alert). */
  detail: string | null
}

export type ProbeSpawnFn = (cmd: string[]) => Promise<number>

const defaultSpawn: ProbeSpawnFn = async (cmd) => {
  try {
    const proc = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' })
    return await proc.exited
  } catch {
    return 127 // ENOENT etc. — treated as unavailable
  }
}

/** Trial-run the platform mechanism. Pure of module state — caching is the
 *  caller's (getSandboxStatus) job so tests can drive this directly. */
export async function probeSandboxMechanism(
  platform: NodeJS.Platform = process.platform,
  spawnFn: ProbeSpawnFn = defaultSpawn,
): Promise<SandboxStatus> {
  if (platform === 'darwin') {
    const code = await spawnFn([
      '/usr/bin/sandbox-exec',
      '-p',
      '(version 1)(allow default)',
      '/usr/bin/true',
    ])
    return code === 0
      ? { mechanism: 'seatbelt', available: true, detail: null }
      : {
          mechanism: 'seatbelt',
          available: false,
          detail: `sandbox-exec trial run exited ${code}`,
        }
  }
  if (platform === 'linux') {
    const code = await spawnFn(['bwrap', '--bind', '/', '/', '--', '/bin/true'])
    return code === 0
      ? { mechanism: 'bwrap', available: true, detail: null }
      : {
          mechanism: 'bwrap',
          available: false,
          detail:
            code === 127
              ? 'bwrap not found on PATH (install bubblewrap)'
              : `bwrap trial run exited ${code} (unprivileged user namespaces disabled?)`,
        }
  }
  return { mechanism: null, available: false, detail: `unsupported platform ${platform}` }
}

let cached: SandboxStatus | null = null

/** Boot-cached status. First call probes; later calls are free. */
export async function getSandboxStatus(
  platform?: NodeJS.Platform,
  spawnFn?: ProbeSpawnFn,
): Promise<SandboxStatus> {
  if (cached === null) cached = await probeSandboxMechanism(platform, spawnFn)
  return cached
}

/** Test hook — drop the cache (and optionally preseed a status). */
export function resetSandboxStatusForTest(next: SandboxStatus | null = null): void {
  cached = next
}
