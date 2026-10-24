import { z } from 'zod'
import { utf16MaxLength } from '@agent-workflow/shared'
import type { BusinessEnvironmentValue } from '@/platform/crewstation/nativeMaterial'
import { computeGitCredentialResponse, parseGitCredentialRequest } from '@/util/gitCredentialLease'

const line = z
  .string()
  .min(1)
  .check(utf16MaxLength(4096))
  .refine(
    (value) => !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
  )
const httpLocation = line.refine((value) => {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return (
    ['http:', 'https:'].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname !== '/' &&
    !url.pathname.includes('\\')
  )
})

export function sshGitTarget(value: string): {
  host: string
  port: number
  user: string
  path: string
} {
  const scp = /^([a-zA-Z0-9._-]+)@([a-zA-Z0-9.-]+):(.+)$/.exec(value)
  const url = scp ? null : URL.canParse(value) ? new URL(value) : null
  const target = scp
    ? { user: scp[1]!, host: scp[2]!, port: 22, path: scp[3]! }
    : url?.protocol === 'ssh:' && !url.password && !url.search && !url.hash
      ? {
          user: url.username || 'git',
          host: url.hostname,
          port: Number(url.port || 22),
          path: decodeURIComponent(url.pathname),
        }
      : null
  if (
    !target ||
    !/^[a-zA-Z0-9.-]+$/.test(target.host) ||
    !/^[a-zA-Z0-9._-]+$/.test(target.user) ||
    !Number.isInteger(target.port) ||
    target.port < 1 ||
    target.port > 65535 ||
    !target.path ||
    target.path.includes('\\') ||
    target.path.split('/').includes('..') ||
    Array.from(target.path).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new Error('hosted-git-ssh-target-invalid')
  return { ...target, host: target.host.toLowerCase() }
}

const sshLocation = line.refine((value) => {
  try {
    sshGitTarget(value)
    return true
  } catch {
    return false
  }
})
const knownHosts = z
  .string()
  .min(1)
  .check(utf16MaxLength(65536))
  .refine((value) => !value.includes('\0'))
const publicBinding = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('http'),
      url: httpLocation,
      username: line,
      passwordSecretId: z.guid({ error: 'Invalid uuid' }).meta({ format: 'uuid' }),
    })
    .strict(),
  z
    .object({
      kind: z.literal('ssh'),
      url: sshLocation,
      privateKeySecretId: z.guid({ error: 'Invalid uuid' }).meta({ format: 'uuid' }),
      knownHosts,
    })
    .strict(),
])
const authName = z.string().regex(/^AW_GIT_AUTH_(?:[0-9]|[12][0-9]|3[01])$/)
const runtimeBindings = z
  .array(
    z.discriminatedUnion('kind', [
      z
        .object({ kind: z.literal('http'), url: httpLocation, username: line, authEnv: authName })
        .strict(),
      z
        .object({ kind: z.literal('ssh'), url: sshLocation, knownHosts, authEnv: authName })
        .strict(),
    ]),
  )
  .max(32)
export type HostedGitRuntimeBinding = z.infer<typeof runtimeBindings>[number]

function parseBindings<T>(parse: () => T): T {
  // Schema and JSON errors must never include a malformed credential value.
  try {
    return parse()
  } catch {
    throw new Error('hosted-git-credential-bindings-invalid')
  }
}

/** Public configuration holds Secret identities; only CS resolves the values. */
export function compileHostedGitEnvironment(
  raw: string | undefined,
): Readonly<Record<string, BusinessEnvironmentValue>> | undefined {
  if (!raw?.trim()) return undefined
  const bindings = parseBindings(() => z.array(publicBinding).max(32).parse(JSON.parse(raw)))
  if (bindings.length === 0) return undefined
  const env: Record<string, BusinessEnvironmentValue> = {}
  const targets = new Set<string>()
  const runtime = bindings.map((binding, index) => {
    const target =
      binding.kind === 'http'
        ? new URL(binding.url).href
        : JSON.stringify(sshGitTarget(binding.url))
    if (targets.has(target)) throw new Error('hosted-git-credential-target-duplicate')
    targets.add(target)
    const authEnv = `AW_GIT_AUTH_${index}`
    if (binding.kind === 'http') {
      env[authEnv] = { secret: { configDefinitionId: binding.passwordSecretId } }
      return { kind: binding.kind, url: binding.url, username: binding.username, authEnv }
    }
    env[authEnv] = { secret: { configDefinitionId: binding.privateKeySecretId } }
    return { kind: binding.kind, url: binding.url, knownHosts: binding.knownHosts, authEnv }
  })
  env.AW_GIT_RUNTIME_BINDINGS = JSON.stringify(runtime)
  return Object.freeze(env)
}

/**
 * The runtime form a task command or Agent receives: bindings with the
 * `AW_GIT_AUTH_<n>` names CS resolves. It must not reuse the deployment
 * variable `AW_GIT_CREDENTIAL_BINDINGS`: CrewStation gives every task container
 * the project's configuration as environment, so that name already carries the
 * public form (Secret ids) there, and a command without credentials failed on
 * it (`hosted-git-credential-bindings-invalid`, RFC-370 acceptance 2026-10-17).
 */
export function readHostedGitRuntimeBindings(
  env: Readonly<Record<string, string | undefined>>,
): readonly HostedGitRuntimeBinding[] {
  const raw = env.AW_GIT_RUNTIME_BINDINGS
  if (!raw?.trim()) return []
  return parseBindings(() => runtimeBindings.parse(JSON.parse(raw)))
}

/** Git's command-scope environment parser accepts single-quoted key/value
 * pairs (git/config.c parse_config_env_list). This is data, never a shell
 * command: embedded quotes stay inside the same Git value. */
const gitParameter = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** Agent Git subprocesses get the same exact-repository credential helper as
 * preparation commands. CS resolves and freezes Secret references as part of
 * the material; the AW service never reads their bytes. The helper binary is
 * the fixed task-image executable, not this control-plane process.execPath. */
export function createHostedGitAgentEnvironment(raw: string | undefined) {
  const environment = compileHostedGitEnvironment(raw) ?? {}
  const bindings = readHostedGitRuntimeBindings({
    AW_GIT_RUNTIME_BINDINGS:
      typeof environment.AW_GIT_RUNTIME_BINDINGS === 'string'
        ? environment.AW_GIT_RUNTIME_BINDINGS
        : undefined,
  })
  const credentialHelper = '!agent-workflow __hosted-git-credential'
  const sshHelper = 'agent-workflow __hosted-git-ssh'
  return (identity: {
    readonly gitUserName?: string | null
    readonly gitUserEmail?: string | null
  }) => {
    const config: [string, string][] = []
    if (identity.gitUserName && identity.gitUserEmail) {
      if (
        !line.safeParse(identity.gitUserName).success ||
        !line.safeParse(identity.gitUserEmail).success
      )
        throw new Error('hosted-git-identity-invalid')
      config.push(['user.name', identity.gitUserName], ['user.email', identity.gitUserEmail])
    }
    if (bindings.length) {
      config.push(
        ['credential.helper', ''],
        ['credential.useHttpPath', 'true'],
        ['credential.interactive', 'false'],
        ['credential.helper', credentialHelper],
        ['core.sshCommand', sshHelper],
        ['http.followRedirects', 'false'],
      )
      for (const binding of bindings)
        if (binding.kind === 'http')
          config.push(
            [`http.${binding.url}.extraHeader`, ''],
            [`http.${binding.url}.sslVerify`, 'true'],
          )
    }
    if (!config.length) return undefined
    const env: Record<string, BusinessEnvironmentValue> = {
      ...environment,
      GIT_CONFIG_PARAMETERS: config
        .map(([key, value]) => `${gitParameter(key)}=${gitParameter(value)}`)
        .join(' '),
    }
    if (bindings.length)
      Object.assign(env, {
        GIT_SSH_COMMAND: sshHelper,
        GIT_SSH_VARIANT: 'ssh',
        GIT_TERMINAL_PROMPT: '0',
        GIT_TRACE: '0',
        GIT_TRACE_CURL: '0',
        GIT_CURL_VERBOSE: '0',
        GIT_TRACE_PACKET: '0',
        GIT_TRACE_REDACT: '1',
      })
    return Object.freeze(env)
  }
}

/** Exact protocol, authority and repository matching also isolates submodules. */
export function hostedGitCredentialResponse(
  operation: string,
  stdin: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (operation !== 'get') return ''
  try {
    const fields = parseGitCredentialRequest(stdin)
    for (const binding of readHostedGitRuntimeBindings(env)) {
      if (binding.kind !== 'http') continue
      const password = env[binding.authEnv]
      if (
        !password ||
        Array.from(password).some((c) => c === '\r' || c === '\n' || c.charCodeAt(0) === 0)
      )
        continue
      const url = new URL(binding.url)
      const result = computeGitCredentialResponse(fields, {
        version: 1,
        protocol: url.protocol.slice(0, -1) as 'http' | 'https',
        host: url.host.toLowerCase(),
        path: url.pathname.replace(/^\/+|\/+$/g, ''),
        username: binding.username,
        password,
      })
      if (result) return result
    }
  } catch {
    /* Helpers return no credential for an invalid invocation. */
  }
  return ''
}

/** Only operations that own Git effects receive project Git Secrets. */
const gitOperations = new Set([
  'resolve-repository',
  'prepare-development-repository',
  'materialize-single',
  'materialize-group',
  'git',
  'isolation',
  'isolation-conflict-prepare',
  'isolation-conflict-finish',
  // RFC-370 §9.2 V3 coarse operations that reach a remote: candidate
  // publication and the employee Case remote-head fetch.
  'candidate-push',
  'conflict-workspace',
  'employee-case',
  'development-workspace',
  'plugin-installation',
  // RFC-370 §10 V17: repository picker reads and registration checks.
  'repository-remote',
])
export function createHostedGitCommandEnvironment(raw: string | undefined) {
  const environment = compileHostedGitEnvironment(raw)
  return (operation: string) => (gitOperations.has(operation) ? environment : undefined)
}
