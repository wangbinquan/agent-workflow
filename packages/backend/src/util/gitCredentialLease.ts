// RFC-321 — exact-target, one-shot Git credential helper lease shared by
// source-control publication and legacy clone/background-refresh consumers.
//
// The secret exists only in a mode-0600 lease file. Git receives a sanitized
// endpoint in argv and only the lease-file path in env. The hidden helper
// answers when protocol + normalized authority + repository path all match;
// a sibling project or hostile submodule receives an empty response.

import { chmodSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { IS_EMBEDDED } from '@/embed'
import { GIT_CREDENTIAL_HELPER_SOURCE } from '@/embed.generated'
import { Paths } from '@/util/paths'

export const GIT_CREDENTIAL_SUBCOMMAND = '__git-credential'
const LEASE_NAME_RE = /^\.gitcred-[0-9A-HJKMNP-TV-Z]{26}$/
const HELPER_NAME_RE = /^\.gitcred-helper-[0-9A-HJKMNP-TV-Z]{26}\.mjs$/
const BUN_BE_BUN_ENV = 'BUN_BE_BUN'

export interface GitCredentialLeasePayloadV1 {
  readonly version: 1
  readonly protocol: 'http' | 'https'
  readonly host: string
  readonly path: string
  readonly username: string
  readonly password: string
}

export interface GitCredentialLease {
  readonly leadingArgs: readonly string[]
  readonly env: Readonly<Record<string, string>>
  cleanup(): void
}

function gitCredentialSelfArgv(): string[] {
  if (IS_EMBEDDED) return [process.execPath, GIT_CREDENTIAL_SUBCOMMAND]
  const mainPath = resolve(import.meta.dir, '..', 'main.ts')
  return [process.execPath, 'run', mainPath, GIT_CREDENTIAL_SUBCOMMAND]
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

export function gitCredentialHelperValue(): string {
  return `!${gitCredentialSelfArgv().map(shQuote).join(' ')}`
}

function extractedGitCredentialHelperValue(path: string): string {
  return `!${[process.execPath, 'run', path, GIT_CREDENTIAL_SUBCOMMAND].map(shQuote).join(' ')}`
}

export function parseGitCredentialRequest(stdin: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const raw of stdin.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '') break
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    fields[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return fields
}

function normalizedAuthority(protocol: string, raw: string): string | null {
  const authority = raw.trim().toLowerCase()
  if (
    authority === '' ||
    authority.includes('@') ||
    authority.includes('/') ||
    authority.includes('\\')
  ) {
    return null
  }
  if (protocol === 'https' && authority.endsWith(':443')) return authority.slice(0, -4)
  if (protocol === 'http' && authority.endsWith(':80')) return authority.slice(0, -3)
  return authority
}

function normalizedCredentialPath(raw: string): string {
  return raw.replace(/^\/+/, '').replace(/\/+$/, '')
}

function targetOf(
  endpointUrl: string,
): Omit<GitCredentialLeasePayloadV1, 'version' | 'username' | 'password'> | null {
  let parsed: URL
  try {
    parsed = new URL(endpointUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return null
  }
  const protocol = parsed.protocol.slice(0, -1) as 'http' | 'https'
  const host = normalizedAuthority(protocol, parsed.host)
  const path = normalizedCredentialPath(parsed.pathname)
  if (host === null || path === '') return null
  return { protocol, host, path }
}

function storedLeaseOf(raw: string): GitCredentialLeasePayloadV1 | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const value = parsed as Partial<GitCredentialLeasePayloadV1>
  if (
    value.version !== 1 ||
    (value.protocol !== 'http' && value.protocol !== 'https') ||
    typeof value.host !== 'string' ||
    typeof value.path !== 'string' ||
    typeof value.username !== 'string' ||
    typeof value.password !== 'string'
  ) {
    return null
  }
  const host = normalizedAuthority(value.protocol, value.host)
  const path = normalizedCredentialPath(value.path)
  if (host === null || path === '' || value.username === '' || value.password === '') return null
  return { ...value, host, path } as GitCredentialLeasePayloadV1
}

export function computeGitCredentialResponse(
  requestFields: Readonly<Record<string, string>>,
  lease: GitCredentialLeasePayloadV1,
): string {
  const protocol = (requestFields.protocol ?? '').toLowerCase()
  if (protocol !== lease.protocol) return ''
  const host = normalizedAuthority(protocol, requestFields.host ?? '')
  if (host === null || host !== lease.host) return ''
  if (normalizedCredentialPath(requestFields.path ?? '') !== lease.path) return ''
  return `username=${lease.username}\npassword=${lease.password}\n`
}

export function runGitCredentialSubcommand(operation: string, stdin: string): string {
  if (operation !== 'get') return ''
  const credFile = process.env.AW_GIT_CRED_FILE
  if (credFile === undefined || credFile === '') return ''
  let lease: GitCredentialLeasePayloadV1 | null
  try {
    lease = storedLeaseOf(readFileSync(credFile, 'utf8'))
  } catch {
    return ''
  }
  return lease === null ? '' : computeGitCredentialResponse(parseGitCredentialRequest(stdin), lease)
}

export function leaseTargetBoundGitCredential(input: {
  readonly endpointUrl: string
  readonly username: string
  readonly password: string
  readonly appHome?: string
  readonly rejectUnauthorized?: boolean
}): GitCredentialLease | null {
  const target = targetOf(input.endpointUrl)
  if (target === null || input.username === '' || input.password === '') return null
  const id = ulid()
  const credFile = join(input.appHome ?? Paths.root, `.gitcred-${id}`)
  const helperFile =
    IS_EMBEDDED && process.platform === 'win32'
      ? join(input.appHome ?? Paths.root, `.gitcred-helper-${id}.mjs`)
      : null
  const lease: GitCredentialLeasePayloadV1 = {
    version: 1,
    ...target,
    username: input.username,
    password: input.password,
  }
  let credentialCreated = false
  let helperCreated = false
  try {
    // `wx` refuses an existing path (including a pre-planted symlink) instead
    // of following it. A chmod failure removes the just-written secret before
    // reporting the lease as unavailable.
    writeFileSync(credFile, JSON.stringify(lease), { mode: 0o600, flag: 'wx' })
    credentialCreated = true
    chmodSync(credFile, 0o600)
    if (helperFile !== null) {
      if (GIT_CREDENTIAL_HELPER_SOURCE.length === 0) {
        throw new Error('compiled Git credential helper source is missing')
      }
      writeFileSync(helperFile, GIT_CREDENTIAL_HELPER_SOURCE, { mode: 0o600, flag: 'wx' })
      helperCreated = true
      chmodSync(helperFile, 0o600)
    }
  } catch {
    if (credentialCreated) {
      try {
        rmSync(credFile, { force: true })
      } catch {
        // The caller still receives no usable lease; boot cleanup remains narrow.
      }
    }
    if (helperCreated && helperFile !== null) {
      try {
        rmSync(helperFile, { force: true })
      } catch {
        // The helper contains no credential; a later boot can remove the orphan.
      }
    }
    return null
  }
  const helperValue =
    helperFile === null ? gitCredentialHelperValue() : extractedGitCredentialHelperValue(helperFile)
  return {
    leadingArgs: [
      '-c',
      'credential.helper=',
      '-c',
      'credential.useHttpPath=true',
      '-c',
      'credential.interactive=false',
      '-c',
      `http.${input.endpointUrl}.extraHeader=`,
      '-c',
      `http.${input.endpointUrl}.followRedirects=false`,
      '-c',
      `http.${input.endpointUrl}.sslVerify=${input.rejectUnauthorized === false ? 'false' : 'true'}`,
      '-c',
      `credential.helper=${helperValue}`,
    ],
    env: {
      AW_GIT_CRED_FILE: credFile,
      ...(helperFile === null ? {} : { [BUN_BE_BUN_ENV]: '1' }),
      GIT_TERMINAL_PROMPT: '0',
      // An inherited debug setting must not print the Authorization exchange
      // before Git's own redactor gets a chance to protect it.
      GIT_TRACE: '0',
      GIT_TRACE_CURL: '0',
      GIT_TRACE_PACKET: '0',
      GIT_CURL_VERBOSE: '0',
      GIT_TRACE_REDACT: '1',
    },
    cleanup() {
      try {
        rmSync(credFile, { force: true })
      } catch {
        // Best effort: boot cleanup handles a crash between creation and finally.
      }
      if (helperFile !== null) {
        try {
          rmSync(helperFile, { force: true })
        } catch {
          // It contains no credential and remains scoped to this lease id.
        }
      }
    },
  }
}

export function extractGitUserinfo(
  plainUrl: string,
): { username: string; password: string } | null {
  try {
    const parsed = new URL(plainUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (parsed.username === '' && parsed.password === '') return null
    return {
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    }
  } catch {
    return null
  }
}

export function credentialFreeHttpUrl(plainUrl: string): string | null {
  try {
    const parsed = new URL(plainUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    parsed.username = ''
    parsed.password = ''
    return parsed.toString()
  } catch {
    return null
  }
}

/** Compatibility adapter for clone/background refresh; publication uses the explicit target API. */
export function leaseGitCredential(
  plainUrl: string,
  appHome: string = Paths.root,
): GitCredentialLease | null {
  const info = extractGitUserinfo(plainUrl)
  const endpointUrl = credentialFreeHttpUrl(plainUrl)
  if (info === null || endpointUrl === null) return null
  return leaseTargetBoundGitCredential({ endpointUrl, ...info, appHome })
}

/** Remove only old, owner-controlled RFC-321 lease/helper files after an unclean daemon exit. */
export function cleanupOrphanedGitCredentialLeases(
  appHome: string = Paths.root,
  input: { readonly now?: number; readonly minAgeMs?: number } = {},
): number {
  const now = input.now ?? Date.now()
  const minAgeMs = input.minAgeMs ?? 15 * 60_000
  let removed = 0
  let names: string[]
  try {
    names = readdirSync(appHome)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!LEASE_NAME_RE.test(name) && !HELPER_NAME_RE.test(name)) continue
    const path = join(appHome, name)
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(path)
    } catch {
      continue
    }
    if (!stat.isFile() || now - stat.mtimeMs < minAgeMs) continue
    if (process.platform !== 'win32') {
      if ((stat.mode & 0o777) !== 0o600) continue
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) continue
    }
    try {
      rmSync(path)
      removed += 1
    } catch {
      // Best effort and deliberately narrow: never broaden the target set.
    }
  }
  return removed
}
