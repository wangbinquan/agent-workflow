// RFC-238 — the single MCP-row → frozen execution-material boundary.
//
// Both runtime drivers consume this projection. They are deliberately unable
// to reinterpret the DB row independently, which keeps local executable
// identity, remote credential slots, and exact-one-MCP semantics identical.

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { chmod, lstat, mkdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { Mcp } from '@agent-workflow/shared'
import type { PreparedContainmentPlan } from '@/services/sandbox'
import type { McpTestExecutionMaterial } from './types'
import { snapshotRuntimeBinary, verifyRuntimeBinarySnapshot } from './binarySnapshot'
import { identityDigest, type IdentityJson } from './opencode/executionIdentity'
import {
  materializeNetlessWrapper,
  sanitizeMcpAuthoredEnvironment,
} from './opencode/sealedSubprocess'
import { runtimeContainmentAdmissionFromPrepared } from './opencode/containment'
import { executionIdentityFailure } from './opencode/failure'
import { buildControlledPathForHost } from '@/util/platformExec'

const SAFE_RUNTIME_KEY = /^[a-z0-9][a-z0-9_-]{0,127}$/

function frozenRecord(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') Object.freeze(child)
  }
  return Object.freeze(value)
}

async function ensurePrivateRoot(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  await mkdir(path, { recursive: true, mode: 0o700 })
  const metadata = await lstat(path)
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o700)
  ) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  await chmod(path, 0o700)
}

async function frozenFileDigest(path: string, expectedMode: number): Promise<string> {
  const metadata = await lstat(path)
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (process.platform !== 'win32' && (metadata.mode & 0o777) !== expectedMode)
  ) {
    return executionIdentityFailure('execution-identity-mismatch')
  }
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

function assertCommon(mcp: Mcp): void {
  if (!mcp.enabled || !SAFE_RUNTIME_KEY.test(mcp.name) || mcp.id.length === 0) {
    return executionIdentityFailure('execution-identity-mismatch')
  }
}

function remoteCredentialShape(mcp: Extract<Mcp, { type: 'remote' }>): IdentityJson {
  const oauth = mcp.config.oauth
  return {
    headerNames: Object.keys(mcp.config.headers ?? {}).sort(),
    oauth:
      oauth === false
        ? false
        : oauth === undefined
          ? null
          : {
              fields: Object.keys(oauth).sort(),
              clientSecretPresent:
                typeof oauth.clientSecret === 'string' && oauth.clientSecret.length > 0,
            },
  }
}

export interface PrepareMcpTestExecutionMaterialInput {
  mcp: Mcp
  root: string
  worktreePath: string
  appHome: string
  containment: PreparedContainmentPlan
}

/**
 * Materialize exact executable bytes and the local no-network wrapper before a
 * runtime-specific plan is built. Secret values remain only in the returned
 * in-memory entries and later private 0600 runtime config; digests contain only
 * credential slot shape.
 */
export async function prepareMcpTestExecutionMaterial(
  input: PrepareMcpTestExecutionMaterialInput,
): Promise<McpTestExecutionMaterial> {
  assertCommon(input.mcp)
  await ensurePrivateRoot(input.root)
  if (
    !isAbsolute(input.worktreePath) ||
    resolve(input.worktreePath) !== input.worktreePath ||
    !isAbsolute(input.appHome) ||
    resolve(input.appHome) !== input.appHome
  ) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }

  if (input.mcp.type === 'remote') {
    const endpoint = new URL(input.mcp.config.url)
    if (
      (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') ||
      endpoint.username !== '' ||
      endpoint.password !== ''
    ) {
      return executionIdentityFailure('execution-identity-mismatch')
    }
    const descriptor = {
      codec: 1,
      transport: 'remote',
      runtimeKey: input.mcp.name,
      endpoint: endpoint.toString(),
      timeoutMs: input.mcp.config.timeoutMs ?? null,
      credentialShape: remoteCredentialShape(input.mcp),
    } satisfies IdentityJson
    const opencodeEntry: Record<string, unknown> = {
      type: 'remote',
      enabled: true,
      url: input.mcp.config.url,
      ...(input.mcp.config.headers === undefined
        ? {}
        : { headers: { ...input.mcp.config.headers } }),
      ...(input.mcp.config.oauth === undefined ? {} : { oauth: input.mcp.config.oauth }),
      ...(input.mcp.config.timeoutMs === undefined ? {} : { timeout: input.mcp.config.timeoutMs }),
    }
    const claudeEntry: Record<string, unknown> = {
      type: 'http',
      url: input.mcp.config.url,
      ...(input.mcp.config.headers === undefined
        ? {}
        : { headers: { ...input.mcp.config.headers } }),
    }
    const executionDigest = identityDigest({
      domain: 'agent-workflow:mcp-test-execution:v1',
      mcpId: input.mcp.id,
      descriptor,
    })
    return Object.freeze({
      codec: 'mcp-test-execution-material-v1',
      mcpId: input.mcp.id,
      runtimeKey: input.mcp.name,
      type: 'remote',
      opencodeEntry: frozenRecord(opencodeEntry),
      claudeEntry: frozenRecord(claudeEntry),
      executionDigest,
      rawCommandDigest: identityDigest({
        domain: 'agent-workflow:mcp-test-remote-command:v1',
        descriptor,
      }),
      root: input.root,
      preSpawnVerify: async () => {},
    })
  }

  const command = input.mcp.config.command
  if (command.length === 0 || command.some((part) => part.length === 0 || part.includes('\0'))) {
    return executionIdentityFailure('execution-identity-mismatch')
  }
  // RFC-242 — MCP-authored env goes through the MCP rule (author configured the
  // command AND its variables), not the daemon-env allowlist: `token` is a
  // legitimate key, `LD_PRELOAD` is not, and the failure names which is which.
  const configuredEnv = sanitizeMcpAuthoredEnvironment(input.mcp.config.env ?? {}, input.mcp.name)
  const snapshotPath = join(input.root, 'mcp-bin', 'server')
  const snapshot = await snapshotRuntimeBinary({
    command: [command[0]!],
    snapshotPath,
  })
  const wrapperPath = join(input.root, 'mcp-wrapper', 'run')
  const wrapperManifestPath = join(input.root, 'mcp-wrapper', 'netless.json')
  const wrapperHome = join(input.root, 'home')
  const wrapperTmp = join(input.root, 'tmp')
  await Promise.all([ensurePrivateRoot(wrapperHome), ensurePrivateRoot(wrapperTmp)])
  const admission = runtimeContainmentAdmissionFromPrepared(input.containment)
  await materializeNetlessWrapper({
    wrapperPath,
    manifestPath: wrapperManifestPath,
    manifest: {
      codec: 1,
      mode: 'mcp',
      provider: admission.childProvider,
      worktreePath: input.worktreePath,
      scratchPath: input.root,
      appHome: input.appHome,
      realHome: homedir(),
      gitCommonDirs: [],
      bindReadOnly: [snapshotPath],
      env: {
        ...configuredEnv,
        PATH: buildControlledPathForHost(),
        HOME: wrapperHome,
        TMPDIR: wrapperTmp,
        PWD: input.worktreePath,
      },
      command: [snapshotPath, ...command.slice(1)],
    },
  })
  await verifyRuntimeBinarySnapshot(snapshotPath, snapshot.digest)
  const wrapperDigest = await frozenFileDigest(wrapperPath, 0o500)
  const wrapperManifestDigest = await frozenFileDigest(wrapperManifestPath, 0o400)

  const descriptor = {
    codec: 1,
    transport: 'local',
    runtimeKey: input.mcp.name,
    executableDigest: snapshot.digest,
    argv: command.slice(1),
    envNames: Object.keys(configuredEnv).sort(),
    timeoutMs: input.mcp.config.timeoutMs ?? null,
  } satisfies IdentityJson
  const executionDigest = identityDigest({
    domain: 'agent-workflow:mcp-test-execution:v1',
    mcpId: input.mcp.id,
    descriptor,
  })
  return Object.freeze({
    codec: 'mcp-test-execution-material-v1',
    mcpId: input.mcp.id,
    runtimeKey: input.mcp.name,
    type: 'local',
    opencodeEntry: frozenRecord({
      type: 'local',
      enabled: true,
      command: [wrapperPath],
      ...(input.mcp.config.timeoutMs === undefined ? {} : { timeout: input.mcp.config.timeoutMs }),
    }),
    claudeEntry: frozenRecord({
      command: wrapperPath,
      args: [],
    }),
    executionDigest,
    rawCommandDigest: snapshot.digest,
    root: input.root,
    preSpawnVerify: async () => {
      await verifyRuntimeBinarySnapshot(snapshotPath, snapshot.digest)
      if (
        (await frozenFileDigest(wrapperPath, 0o500)) !== wrapperDigest ||
        (await frozenFileDigest(wrapperManifestPath, 0o400)) !== wrapperManifestDigest
      ) {
        return executionIdentityFailure('execution-identity-mismatch')
      }
    },
  })
}
