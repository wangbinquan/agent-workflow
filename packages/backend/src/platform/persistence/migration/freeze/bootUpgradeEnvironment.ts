import { runGit } from '@/util/git'
import { realpath, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  createBootUpgradeFacts,
  type BootUpgradeFact,
  type BootUpgradeFacts,
} from '../conversion/bootUpgradeFacts'
import type { ContentInventory } from '../conversion/content'
import type { ContentRootSpec, FreezeContentManifest, FrozenSourceHandle } from '../run/types'
import type { DecodedSourceRow } from '../sourceTypes'

export interface BootUpgradeCaptureInput {
  readonly stage: 'plan' | 'freeze' | 'run'
  readonly source: FrozenSourceHandle
  readonly root: ContentRootSpec
  readonly content: ContentInventory
  readonly manifest: FreezeContentManifest
  readArtifact(name: string): Promise<Uint8Array | null>
  writeArtifact(name: string, bytes: Uint8Array): Promise<void>
}
export interface BootUpgradeEnvironmentContribution {
  readonly id: string
  capture(input: BootUpgradeCaptureInput): Promise<readonly BootUpgradeFact[]>
}
export interface BootUpgradeEnvironmentPort {
  capture(input: BootUpgradeCaptureInput): Promise<BootUpgradeFacts>
}
export function createBootUpgradeEnvironment(
  contributions: readonly BootUpgradeEnvironmentContribution[],
): BootUpgradeEnvironmentPort {
  if (new Set(contributions.map((entry) => entry.id)).size !== contributions.length)
    throw new Error('v2-boot-duplicate-environment-contribution')
  return {
    async capture(input) {
      await input.source.reader.assertUnchanged(input.source.preflight)
      const facts: BootUpgradeFact[] = []
      for (const entry of [...contributions].sort((a, b) => a.id.localeCompare(b.id)))
        facts.push(...(await entry.capture(input)))
      await input.source.reader.assertUnchanged(input.source.preflight)
      return createBootUpgradeFacts(facts)
    },
  }
}
/** An absent source table must be an admitted absence, never an unknown-table fallback. */
export async function bootSourceRows(
  source: FrozenSourceHandle,
  table: string,
): Promise<readonly DecodedSourceRow[]> {
  if (!source.preflight.tables.some((entry) => entry.table === table))
    if (source.preflight.expectedAbsent.includes(table)) return []
    else throw new Error(`v2-boot-source-table-unavailable:${table}`)
  const rows: DecodedSourceRow[] = []
  let after = null
  for (;;) {
    const chunk = await source.reader.readChunk(table, after, 1000)
    rows.push(...chunk.decodedRows)
    if (chunk.lastKey === null || chunk.rows.length === 0) break
    after = chunk.lastKey
  }
  return rows
}

export interface LocalGitFact {
  readonly path: string
  readonly ref: string | null
  readonly state: 'present' | 'absent' | 'not-repository' | 'unavailable'
  readonly realRoot: string | null
  readonly fileUrl: string | null
  readonly bare: boolean | null
  readonly branchOid: string | null
  readonly tagOid: string | null
  readonly remoteOid: string | null
  readonly resolvedOid: string | null
  readonly remoteOnly: boolean
}
async function git(
  path: string,
  args: readonly string[],
): Promise<{ code: number; output: string; error: string }> {
  const result = await runGit(path, [...args], { env: { LC_ALL: 'C' } })
  return { code: result.exitCode, output: result.stdout.trim(), error: result.stderr }
}
export async function probeLocalGit(path: string, ref: string | null): Promise<LocalGitFact> {
  const empty: LocalGitFact = {
    path,
    ref,
    state: 'unavailable',
    realRoot: null,
    fileUrl: null,
    bare: null,
    branchOid: null,
    tagOid: null,
    remoteOid: null,
    resolvedOid: null,
    remoteOnly: false,
  }
  try {
    try {
      if (!(await stat(path)).isDirectory()) return { ...empty, state: 'not-repository' }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...empty, state: 'absent' }
      if ((error as NodeJS.ErrnoException).code === 'ENOTDIR')
        return { ...empty, state: 'not-repository' }
      throw error
    }
    const top = await git(path, ['rev-parse', '--show-toplevel'])
    const bare = await git(path, ['rev-parse', '--is-bare-repository'])
    const root =
      top.code === 0 && top.output
        ? top.output
        : bare.code === 0 && bare.output === 'true'
          ? await git(path, ['rev-parse', '--absolute-git-dir']).then((result) =>
              result.code === 0 ? result.output : null,
            )
          : null
    if (!root)
      return {
        ...empty,
        state:
          top.code === 128 && bare.code === 128 && /not a git repository/i.test(bare.error)
            ? 'not-repository'
            : 'unavailable',
      }
    const realRoot = await realpath(root)
    const oid = async (name: string): Promise<string | null> => {
      const result = await git(realRoot, ['rev-parse', '--verify', '--quiet', name])
      if (result.code === 0) return result.output || null
      if (result.code === 1) return null
      throw new Error('v2-boot-git-ref-unavailable')
    }
    const spelledRemote = !!ref && /^(origin\/|refs\/remotes\/|remotes\/)/.test(ref)
    const evidenceOid = (name: string) => oid(name).catch(() => null)
    const localOid = spelledRemote ? oid : evidenceOid
    const branchOid = ref ? await localOid(`refs/heads/${ref}`) : null
    const tagOid = ref ? await localOid(`refs/tags/${ref}`) : null
    const remoteName = ref?.replace(/^refs\/remotes\//, '').replace(/^remotes\//, '')
    const remoteOid = remoteName ? await evidenceOid(`refs/remotes/${remoteName}`) : null
    return {
      ...empty,
      state: 'present',
      realRoot,
      fileUrl: pathToFileURL(realRoot).href,
      bare: bare.output === 'true',
      branchOid,
      tagOid,
      remoteOid,
      resolvedOid: await evidenceOid(ref ?? 'HEAD'),
      remoteOnly: spelledRemote && !branchOid && !tagOid,
    }
  } catch {
    return empty
  }
}
