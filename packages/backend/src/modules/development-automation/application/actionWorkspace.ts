import { createHash } from 'node:crypto'
import { PLATFORM_WORKSPACE_DIR } from '@agent-workflow/shared'
import type { EvidenceArtifactPort } from './ports/evidenceArtifacts'
import type { ActionWorkspaceEffects } from './ports/actionWorkspaceEffects'
import type {
  AutomationWorkspaceEffects,
  AutomationWorkspaceEffectsFactory,
} from './ports/automationWorkspaceEffects'
import { withSelectedAutomationWorkspaceEffects } from './automationWorkspaceEffectLifetime'

export interface WorkspaceDeps {
  readonly evidence: EvidenceArtifactPort
  readonly seedsRoot: string
  /**
   * workspace 宿主根。生产必须落 appHome 之下（RFC-308 exclude participant
   * 对平台家外的 worktree 抛 owner-mismatch，task 启动会失败——PR-4 fork J
   * 实测）；缺省 tmpdir 仅供纯 workspace 单测。
   */
  readonly workspacesRoot?: string
}

export interface MaterializeInput {
  readonly baselineRepoPath: string
  readonly baselineSha: string
  /** placement 的 seedChangeRef（= planDigest）；null = 无上传 seed。 */
  readonly seedRef: string | null
  readonly bundles: readonly { readonly bundleId: string; readonly mountPath: string }[]
}

export interface MaterializedWorkspace {
  readonly workspacePath: string
  readonly businessTreeDigest: string
}

async function businessTreeDigest(
  root: string,
  selected: ActionWorkspaceEffects,
  contents: AutomationWorkspaceEffects,
): Promise<string> {
  const hash = createHash('sha256')
  const factory = selected.contents
  const files: string[] = []
  const walk = async (rel: string): Promise<void> => {
    const reference = rel === '' ? root : factory.resolve(root, rel)
    const facts = await selected.requireEntry(reference)
    if (facts.kind === 'directory') {
      for (const name of [...(await contents.listNames(reference))].sort()) {
        const childRel = rel === '' ? name : `${rel}/${name}`
        if (childRel === '.git' || childRel === PLATFORM_WORKSPACE_DIR) continue
        await walk(childRel)
      }
      return
    }
    if (facts.kind === 'file') files.push(rel)
  }
  await walk('')
  for (const rel of files.sort()) {
    hash.update(`${rel}\n`)
    hash.update(
      createHash('sha256')
        .update(await contents.readBytes(factory.resolve(root, rel)))
        .digest('hex'),
    )
    hash.update('\n')
  }
  return hash.digest('hex')
}

async function copySeedTree(
  source: string,
  target: string,
  selected: ActionWorkspaceEffects,
  contents: AutomationWorkspaceEffects,
): Promise<void> {
  const factory: AutomationWorkspaceEffectsFactory = selected.contents
  const walk = async (rel: string): Promise<void> => {
    const reference = rel === '' ? source : factory.resolve(source, rel)
    const facts = await selected.requireEntry(reference)
    if (facts.kind === 'directory') {
      for (const name of [...(await contents.listNames(reference))].sort()) {
        await walk(rel === '' ? name : `${rel}/${name}`)
      }
      return
    }
    if (facts.kind === 'file') {
      const destination = factory.resolve(target, rel)
      await contents.createDirectory(factory.parent(destination), true)
      await contents.copyFile(reference, destination, false)
      await contents.setMode(destination, facts.mode & 0o777)
    }
  }
  if (await contents.exists(source)) await walk('')
}

export async function materializeActionWorkspace(
  deps: WorkspaceDeps,
  input: MaterializeInput,
  selected: ActionWorkspaceEffects,
): Promise<MaterializedWorkspace> {
  return withSelectedAutomationWorkspaceEffects(selected.contents, async (contents, factory) => {
    const ws = await selected.allocate(deps.workspacesRoot)
    const clone = await selected.cloneBaseline(ws, input.baselineRepoPath)
    if (clone.exitCode !== 0) {
      await selected.discard(ws)
      throw new Error(`workspace clone failed: ${clone.stderr.slice(0, 300)}`)
    }
    const checkout = await selected.run(ws, ['checkout', '--quiet', '--detach', input.baselineSha])
    if (checkout.exitCode !== 0) {
      await selected.discard(ws)
      throw new Error(`workspace checkout failed: ${checkout.stderr.slice(0, 300)}`)
    }
    const removeOrigin = await selected.run(ws, ['remote', 'remove', 'origin'])
    if (removeOrigin.exitCode !== 0) {
      await selected.discard(ws)
      throw new Error(`workspace remote removal failed: ${removeOrigin.stderr.slice(0, 300)}`)
    }
    await selected.installPlatformExclude(ws)
    if (input.seedRef !== null) {
      await copySeedTree(factory.resolve(deps.seedsRoot, input.seedRef), ws, selected, contents)
    }
    for (const bundle of input.bundles) {
      await deps.evidence.materializeBundle(bundle.bundleId, factory.resolve(ws, bundle.mountPath))
    }
    return {
      workspacePath: ws,
      businessTreeDigest: await businessTreeDigest(ws, selected, contents),
    }
  })
}

/** Adopt the exact prepared scene without cloning, overlaying a seed or changing markers. */
export async function adoptActionWorkspace(
  deps: Pick<WorkspaceDeps, 'evidence'>,
  input: {
    readonly workspacePath: string
    readonly bundles: readonly { readonly bundleId: string; readonly mountPath: string }[]
  },
  selected: ActionWorkspaceEffects,
): Promise<MaterializedWorkspace> {
  return withSelectedAutomationWorkspaceEffects(selected.contents, async (contents, factory) => {
    for (const bundle of input.bundles) {
      await deps.evidence.materializeBundle(
        bundle.bundleId,
        factory.resolve(input.workspacePath, bundle.mountPath),
      )
    }
    return {
      workspacePath: input.workspacePath,
      businessTreeDigest: await businessTreeDigest(input.workspacePath, selected, contents),
    }
  })
}
