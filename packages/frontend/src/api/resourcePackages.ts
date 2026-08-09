// RFC-271 T33 —— 配置包的前端 client。
//
// 薄封装，不自己拼请求：下载走既有 `api.getBlob`、两次上传走 `api.postMultipart`，
// 于是超时预算 / 鉴权头 / 错误信封都与其余端点同源。
//
// **preview → commit 之间靠两个字段绑定**，前端必须原样回传：
//   · `importId`     幂等键。没有它，commit 成功但响应丢失后重传同一个包会**再建
//                    一遍资源**——服务端每次新生成 id 等于没有幂等。
//   · `previewToken` 把整套确认基线签死。前端不解读它、不重算它，只是搬运。

import { api } from '@/api/client'

export type ImportAction = 'new' | 'reuse' | 'overwrite'
export type ResourcePackageType = 'agent' | 'skill' | 'mcp' | 'plugin' | 'workflow' | 'workgroup'

export interface PackageSecretRef {
  resourceType: ResourcePackageType
  resourceName: string
  field: string
}

export interface PackagePreviewCandidate {
  id: string
  name: string
  expect: Record<string, unknown>
  owned: boolean
}

export interface PackagePreviewEntry {
  localSlug: string
  type: ResourcePackageType
  name: string
  candidates: PackagePreviewCandidate[]
  allowedActions: ImportAction[]
  /** Server-selected safe default. Overwrite is never selected implicitly. */
  defaultAction: ImportAction | null
  /** Missing permission points when no write action is currently available. */
  missingPermissions: string[]
  /** Credential positions owned by this entry. */
  secretFields: PackageSecretRef[]
  suggestedName: string
}

export interface HumanMemberSlot {
  workgroupSlug: string
  username: string
  displayName: string
  suggestedUserId: string | null
  required: boolean
}

export interface PackageRequirements {
  runtimes?: string[]
  codeHosts?: string[]
  executables?: string[]
  pluginSources?: Array<{ name: string; spec: string; sourceKind: string }>
  projectSkills?: string[]
  mcpKinds?: string[]
  humanMembers?: string[]
}

export interface PackagePreview {
  importId: string
  root: { slug: string; type: ResourcePackageType; name: string }
  entries: PackagePreviewEntry[]
  humanMembers: HumanMemberSlot[]
  previewToken: string
  expiresAt: number
  secrets: PackageSecretRef[]
  requirements: PackageRequirements
}

export interface ImportDecision {
  localSlug: string
  action: ImportAction
  targetId?: string
  finalName?: string
}

export interface HumanMemberMapping {
  workgroupSlug: string
  username: string
  userId: string | null
}

export interface PackageSecretInput extends PackageSecretRef {
  value: string
}

export interface PackageImportReceipt {
  journalId: string
  applied: Array<{
    opId: string
    resourceType: string
    resourceId: string
    action: 'create' | 'update'
    name: string
  }>
  root?: {
    resourceType: ResourcePackageType
    resourceId: string
    name: string
    action: 'create' | 'update' | 'reuse'
  }
  skippedSecrets?: PackageSecretRef[]
}

/** 六类共用一条路径形状。 */
export type ExportableType = ResourcePackageType

/** Root-only exact revision fence required by each export endpoint. */
export interface ResourcePackageExportFenceByType {
  agent: { expectedUpdatedAt: number; expectedAclRevision: number }
  skill: {
    expectedContentVersion: number
    expectedMetaRevision: number
    expectedAclRevision: number
  }
  mcp: { expectedConfigHash: string }
  plugin: { expectedConfigHash: string }
  workflow: { expectedVersion: number }
  workgroup: { expectedVersion: number }
}
export type ResourcePackageExportFence = ResourcePackageExportFenceByType[ExportableType]

const SEGMENT: Record<ExportableType, string> = {
  agent: 'agents',
  skill: 'skills',
  mcp: 'mcps',
  plugin: 'plugins',
  workflow: 'workflows',
  workgroup: 'workgroups',
}

export function exportPackageUrl(type: ExportableType, id: string): string {
  return `/api/${SEGMENT[type]}/${encodeURIComponent(id)}/export-package`
}

export async function downloadResourcePackage<T extends ExportableType>(
  type: T,
  id: string,
  fence: ResourcePackageExportFenceByType[T],
  signal?: AbortSignal,
): Promise<Blob> {
  return api.getBlob(
    exportPackageUrl(type, id),
    fence,
    signal === undefined ? undefined : { signal },
  )
}

export async function previewResourcePackage(
  file: File,
  signal?: AbortSignal,
): Promise<PackagePreview> {
  const form = new FormData()
  form.set('file', file)
  return api.postMultipart<PackagePreview>(
    '/api/resource-packages/preview',
    form,
    signal === undefined ? undefined : { signal },
  )
}

export async function commitResourcePackage(
  file: File,
  preview: Pick<PackagePreview, 'previewToken'>,
  decisions: readonly ImportDecision[],
  humanMemberMappings: readonly HumanMemberMapping[] = [],
  secretInputs: readonly PackageSecretInput[] = [],
  signal?: AbortSignal,
): Promise<PackageImportReceipt> {
  const form = new FormData()
  form.set('file', file)
  // ⚠️ 原样回传，不重算：`previewToken` 里签着候选与它们的基线，前端改了任何一项
  // 都会在服务端对不上（那正是它存在的意义）。
  form.set('previewToken', preview.previewToken)
  form.set('decisions', JSON.stringify(decisions))
  form.set('humanMemberMappings', JSON.stringify(humanMemberMappings))
  form.set('secretInputs', JSON.stringify(secretInputs))
  return api.postMultipart<PackageImportReceipt>(
    '/api/resource-packages/commit',
    form,
    signal === undefined ? undefined : { signal },
  )
}
