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
// RFC-286 F3：wire 形状下沉 shared/schemas/resourcePackage（以后端实际产出为
// 源；requirements 各字段必填——parse 层 .default([]) 保证）。本模块保留
// re-export，下游消费方 import 路径不动。
import type {
  HumanMemberMapping,
  HumanMemberSlot,
  ImportAction,
  ImportDecision,
  PackageImportReceipt,
  PackagePreview,
  PackagePreviewCandidate,
  PackagePreviewEntry,
  PackageRequirements,
  PackageSecretInput,
  PackageSecretRef,
  ResourcePackageType,
} from '@agent-workflow/shared'

export type {
  HumanMemberMapping,
  HumanMemberSlot,
  ImportAction,
  ImportDecision,
  PackageImportReceipt,
  PackagePreview,
  PackagePreviewCandidate,
  PackagePreviewEntry,
  PackageRequirements,
  PackageSecretInput,
  PackageSecretRef,
  ResourcePackageType,
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
