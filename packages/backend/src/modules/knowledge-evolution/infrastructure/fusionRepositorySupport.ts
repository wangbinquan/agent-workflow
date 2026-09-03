import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { ResourceAccess, WorkflowDefinition } from '@agent-workflow/shared'
import {
  QUARANTINED_FUSION_SKILL_ID,
  WorkflowDefinitionSchema,
  planCanonicalWorkflowLayout,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { ConflictError, ValidationError } from '@/util/errors'
import { createSha256DigestBuilder } from '@/util/hash'

export { QUARANTINED_FUSION_SKILL_ID }

export interface FusionSkillToken {
  readonly skillId: string
  readonly contentVersion: number
  readonly metaRevision: number
}

export function encodeFusionSkillToken(token: FusionSkillToken): string {
  return Buffer.from(
    JSON.stringify([token.skillId, token.contentVersion, token.metaRevision]),
    'utf-8',
  ).toString('base64url')
}

export function decodeFusionSkillToken(value: string): FusionSkillToken | null {
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf-8'))
  } catch {
    return null
  }
  if (!Array.isArray(decoded) || decoded.length !== 3) return null
  const [skillId, contentVersion, metaRevision] = decoded
  if (typeof skillId !== 'string' || skillId.length === 0) return null
  if (!Number.isInteger(contentVersion) || Number(contentVersion) < 0) return null
  if (!Number.isInteger(metaRevision) || Number(metaRevision) < 0) return null
  return {
    skillId,
    contentVersion: Number(contentVersion),
    metaRevision: Number(metaRevision),
  }
}

export function resolveFusionSkillAccess(
  actor: Actor,
  row: { readonly ownerUserId: string | null; readonly visibility: 'private' | 'public' },
  grant: 'read' | 'write' | null,
): ResourceAccess {
  if (actor.permissions.has('resource-acl:bypass')) return 'own'
  const canReadPrivate = actor.permissions.has('resource-acl:private')
  const publicResource = row.visibility === 'public'
  if (row.ownerUserId === actor.user.id && (publicResource || canReadPrivate)) return 'own'
  if (!canReadPrivate) return publicResource ? 'read' : 'none'
  if (grant === 'write') return 'write'
  if (grant === 'read') return 'read'
  return publicResource ? 'read' : 'none'
}

export function canEditFusionSkill(access: ResourceAccess): boolean {
  return access === 'write' || access === 'own'
}

export function repairFusionWorkflowDefinition(
  definition: string,
  mergerAgentId: string,
): { readonly definition: string; readonly changed: boolean } {
  let parsed: unknown
  try {
    parsed = JSON.parse(definition)
  } catch {
    throw new ConflictError(
      'builtin-workflow-definition-invalid',
      'the built-in fusion workflow definition is not valid JSON',
    )
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ConflictError(
      'builtin-workflow-definition-invalid',
      'the built-in fusion workflow definition is not an object',
    )
  }
  const record = parsed as Record<string, unknown>
  if (!Array.isArray(record['nodes'])) {
    throw new ConflictError(
      'builtin-workflow-definition-invalid',
      'the built-in fusion workflow has no nodes array',
    )
  }
  let mergerFound = false
  let changed = false
  for (const candidate of record['nodes']) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const node = candidate as Record<string, unknown>
    if (node['kind'] !== 'agent-single' || node['id'] !== 'merger') continue
    mergerFound = true
    if (node['agentId'] !== mergerAgentId) {
      node['agentId'] = mergerAgentId
      changed = true
    }
  }
  if (!mergerFound) {
    throw new ConflictError(
      'builtin-workflow-definition-invalid',
      'the built-in fusion workflow has no merger agent node',
    )
  }
  const shape = WorkflowDefinitionSchema.safeParse(record)
  if (!shape.success) {
    throw new ConflictError(
      'builtin-workflow-definition-invalid',
      'the built-in fusion workflow definition does not match the workflow schema',
    )
  }
  const laidOut = planCanonicalWorkflowLayout(record as unknown as WorkflowDefinition).next
  const nextDefinition = JSON.stringify(laidOut)
  if (nextDefinition !== definition) changed = true
  return { definition: changed ? nextDefinition : definition, changed }
}

function assertRegularTree(path: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    throw new ValidationError(
      'skill-identity-tree-invalid',
      `skill tree contains a symbolic link: ${path}`,
    )
  }
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) assertRegularTree(join(path, name))
    return
  }
  if (!stat.isFile()) {
    throw new ValidationError(
      'skill-identity-tree-invalid',
      `skill tree contains a non-regular entry: ${path}`,
    )
  }
}

function collectFiles(root: string, at: string, output: string[]): void {
  for (const name of readdirSync(join(root, at))) {
    const child = at === '' ? name : `${at}/${name}`
    const stat = lstatSync(join(root, child))
    if (stat.isSymbolicLink()) {
      throw new ValidationError(
        'skill-identity-tree-invalid',
        `skill tree contains a symbolic link: ${join(root, child)}`,
      )
    }
    if (stat.isDirectory()) collectFiles(root, child, output)
    else if (stat.isFile()) output.push(child)
    else {
      throw new ValidationError(
        'skill-identity-tree-invalid',
        `skill tree contains a non-regular entry: ${join(root, child)}`,
      )
    }
  }
}

function hashRegularTree(root: string): string {
  assertRegularTree(root)
  const files: string[] = []
  collectFiles(root, '', files)
  files.sort()
  const hash = createSha256DigestBuilder()
  for (const file of files) {
    hash.update(file)
    hash.update('\x00')
    hash.update(readFileSync(join(root, file)))
    hash.update('\x00')
  }
  return hash.digestHex()
}

function copyProposal(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true })
  for (const name of readdirSync(source)) {
    if (name === '.git' || name === '.agent-workflow') continue
    cpSync(join(source, name), join(destination, name), { recursive: true })
  }
}

export interface FusionSkillFilesystemPlan {
  readonly operationId: string
  readonly skillId: string
  readonly versionIndex: number
  readonly filesDir: string
  readonly stagingDir: string
  readonly backupDir: string
  readonly versionDir: string
  readonly stagingPath: string
  readonly candidatePath: string
  readonly contentHash: string
}

export function prepareFusionSkillFilesystem(input: {
  readonly appHome: string
  readonly operationId: string
  readonly skillId: string
  readonly versionIndex: number
  readonly proposedWorktreePath: string
}): FusionSkillFilesystemPlan {
  const filesDir = join(input.appHome, 'skills', input.skillId, 'files')
  const stagingDir = `${filesDir}.op-${input.operationId}.staged`
  const backupDir = `${filesDir}.op-${input.operationId}.backup`
  const versionDir = join(
    input.appHome,
    'skills',
    input.skillId,
    'versions',
    `v${input.versionIndex}`,
    'files',
  )
  rmSync(stagingDir, { recursive: true, force: true })
  rmSync(versionDir, { recursive: true, force: true })
  copyProposal(input.proposedWorktreePath, stagingDir)
  const contentHash = hashRegularTree(stagingDir)
  mkdirSync(dirname(versionDir), { recursive: true })
  cpSync(stagingDir, versionDir, { recursive: true })
  if (hashRegularTree(versionDir) !== contentHash) {
    throw new Error('fusion skill version snapshot does not match staged content')
  }
  return {
    operationId: input.operationId,
    skillId: input.skillId,
    versionIndex: input.versionIndex,
    filesDir,
    stagingDir,
    backupDir,
    versionDir,
    stagingPath: relative(input.appHome, stagingDir),
    candidatePath: relative(input.appHome, versionDir),
    contentHash,
  }
}

export function publishFusionSkillFilesystem(plan: FusionSkillFilesystemPlan): void {
  mkdirSync(dirname(plan.filesDir), { recursive: true })
  rmSync(plan.backupDir, { recursive: true, force: true })
  if (existsSync(plan.filesDir)) renameSync(plan.filesDir, plan.backupDir)
  try {
    renameSync(plan.stagingDir, plan.filesDir)
    if (hashRegularTree(plan.filesDir) !== plan.contentHash) {
      throw new Error('published fusion skill tree does not match the committed snapshot')
    }
    rmSync(plan.backupDir, { recursive: true, force: true })
  } catch (error) {
    if (!existsSync(plan.filesDir) && existsSync(plan.backupDir)) {
      renameSync(plan.backupDir, plan.filesDir)
    }
    throw error
  }
}

export function abortFusionSkillFilesystem(plan: FusionSkillFilesystemPlan): void {
  rmSync(plan.stagingDir, { recursive: true, force: true })
  rmSync(plan.versionDir, { recursive: true, force: true })
  if (!existsSync(plan.filesDir) && existsSync(plan.backupDir)) {
    renameSync(plan.backupDir, plan.filesDir)
  } else {
    rmSync(plan.backupDir, { recursive: true, force: true })
  }
}
