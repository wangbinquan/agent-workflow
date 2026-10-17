import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IS_EMBEDDED } from '@/embed'
import { platformSpawnOptionsForHost } from '@/util/platformExec'
import { readHostedGitRuntimeBindings, sshGitTarget } from './gitCredentials'

const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`
function self(subcommand: string): string {
  return (
    IS_EMBEDDED
      ? [process.execPath, subcommand]
      : [process.execPath, 'run', join(import.meta.dir, '../../../../main.ts'), subcommand]
  )
    .map(quote)
    .join(' ')
}

/** Called once by the one-command task-image process. These settings are
 * ephemeral environment, never written to a repository or shared /work. */
export function taskImageGitEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const bindings = readHostedGitRuntimeBindings(env)
  if (bindings.length === 0) return {}
  for (const binding of bindings)
    if (!env[binding.authEnv]) throw new Error('hosted-git-secret-unavailable')
  const config: [string, string][] = [
    ['credential.helper', ''],
    ['credential.useHttpPath', 'true'],
    ['credential.interactive', 'false'],
    ['credential.helper', `!${self('__hosted-git-credential')}`],
    ['core.sshCommand', self('__hosted-git-ssh')],
    ['http.followRedirects', 'false'],
  ]
  for (const binding of bindings)
    if (binding.kind === 'http') {
      config.push(
        [`http.${binding.url}.extraHeader`, ''],
        [`http.${binding.url}.sslVerify`, 'true'],
      )
    }
  return {
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(
      config.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
    GIT_SSH_COMMAND: self('__hosted-git-ssh'),
    GIT_SSH_VARIANT: 'ssh',
    GIT_TERMINAL_PROMPT: '0',
    GIT_TRACE: '0',
    GIT_TRACE_CURL: '0',
    GIT_CURL_VERBOSE: '0',
    GIT_TRACE_PACKET: '0',
    GIT_TRACE_REDACT: '1',
  }
}

/** Git's SSH transport supplies a single, shell-quoted repository argument. */
export function parseHostedGitSshRequest(argv: readonly string[]) {
  let port = 22,
    user: string | undefined,
    index = 0
  while (argv[index]?.startsWith('-')) {
    const flag = argv[index++],
      value = argv[index++]
    if (flag === '-p' && value && /^\d+$/.test(value)) port = Number(value)
    else if (flag === '-l' && value) user = value
    else if (
      flag === '-o' &&
      ['SendEnv=GIT_PROTOCOL', 'BatchMode=yes', 'StrictHostKeyChecking=accept-new'].includes(
        value ?? '',
      )
    ) {
      /* our Git wrapper options; actual SSH remains strict */
    } else throw new Error('hosted-git-ssh-request-invalid')
  }
  const authority = argv[index++],
    command = argv[index++]
  if (!authority || !command || index !== argv.length)
    throw new Error('hosted-git-ssh-request-invalid')
  const address = /^(?:([a-zA-Z0-9._-]+)@)?([a-zA-Z0-9.-]+)$/.exec(authority)
  const remote = /^(git-upload-pack|git-receive-pack|git-upload-archive) '((?:[^']|'\\'')*)'$/.exec(
    command,
  )
  if (!address || !remote || (user && address[1] && user !== address[1]))
    throw new Error('hosted-git-ssh-request-invalid')
  return {
    host: address[2]!.toLowerCase(),
    user: user ?? address[1] ?? 'git',
    port,
    path: remote[2]!.replaceAll("'\\''", "'"),
    command,
  }
}

/** Only the bound host, port, account and repository can consume the key.
 * A pinned known_hosts file is mandatory; no host-key TOFU or ambient agent. */
export async function runHostedGitSsh(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  let root: string | undefined
  try {
    const request = parseHostedGitSshRequest(argv)
    const binding = readHostedGitRuntimeBindings(env).find((entry) => {
      if (entry.kind !== 'ssh') return false
      const target = sshGitTarget(entry.url)
      return (
        target.host === request.host &&
        target.port === request.port &&
        target.user === request.user &&
        target.path === request.path
      )
    })
    if (!binding || binding.kind !== 'ssh' || !env[binding.authEnv]) return 255
    root = mkdtempSync(join(tmpdir(), 'aw-git-ssh-'))
    const key = join(root, 'key'),
      hosts = join(root, 'known_hosts')
    writeFileSync(key, env[binding.authEnv]!, { mode: 0o600 })
    writeFileSync(hosts, binding.knownHosts, { mode: 0o600 })
    const childEnv = { ...env }
    for (const name of Object.keys(childEnv)) if (name.startsWith('AW_GIT_')) delete childEnv[name]
    delete childEnv.SSH_AUTH_SOCK
    const child = Bun.spawn({
      ...platformSpawnOptionsForHost(),
      cmd: [
        'ssh',
        '-F',
        '/dev/null',
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'IdentityAgent=none',
        '-o',
        'GlobalKnownHostsFile=/dev/null',
        '-o',
        `UserKnownHostsFile=${hosts}`,
        '-i',
        key,
        '-p',
        String(request.port),
        '-l',
        request.user,
        '--',
        request.host,
        request.command,
      ],
      env: childEnv,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
    // Never remove a credential while its original process still owns it.
    return await child.exited
  } catch {
    return 255
  } finally {
    if (root) rmSync(root, { recursive: true, force: true })
  }
}
