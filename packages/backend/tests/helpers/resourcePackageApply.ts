// RFC-359 —— 测试侧的资源包 apply 入口：**装的就是生产装的那一条**。
//
// 两台 apply 引擎合一之前，这些判据调的是 SQLite 专属的 `commitResourcePackage`
// （`platform/persistence/sqlite/legacyResourcePackageCommit.ts`），于是「资源包写入」的全部
// 行为判据只跑在一台机器上——PG 那台长期零覆盖。这个 helper 把它们接到统一引擎上，
// 形参与回执形状都对齐旧签名，好让那 40 多个调用点是**改接线、不改判据**。
//
// 回执里的 `applied[].opId`：引擎内部字段名是 `operationId`，HTTP 回执文档会把它翻成 `opId`
// （`services/resourcePackage/executionAdapter.ts` 的 `resourcePackageReceiptDocument`）。
// 这里做同一次翻译，让用例看到的就是用户看到的那一份。

import type { Actor } from '../../src/auth/actor'
import type { SecretBox } from '../../src/auth/secretBox'
import type { ProviderNeutralDatabase } from '../../src/db/query'
import { createPostgresqlCapabilityTemplatePackageMutationOwner } from '../../src/modules/code-capability/composition/capabilityTemplateOperations'
import { AuthorityClaimRegistry } from '../../src/modules/identity-access/application/operationContext'
import { createMcpTransactionLifecycle } from '../../src/modules/resource-catalog/composition/mcpRuntimeTestPersistence'
import { composePostgresqlResourcePackageProvider } from '../../src/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import { createPostgresqlResourcePackageAtomicApplyOperations } from '../../src/platform/persistence/postgresqlResourcePackageAtomicApply'
import type { BundleReceipt } from '../../src/services/bundle/provider'
import { createResourcePackagePluginInstaller } from '../../src/services/resourcePackage/pluginInstallerAdapter'
import type { ParsedPackage } from '../../src/services/resourcePackage/parse'

type ProviderInput = Parameters<typeof composePostgresqlResourcePackageProvider>[0]

export interface ResourcePackageApplyTestDeps {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  readonly box: SecretBox
  /** 省略即用真实安装器（与生产同一条）；要挡住装插件的用例自己传一个会抛的。 */
  readonly pluginInstaller?: ProviderInput['pluginInstaller']
  readonly id?: () => string
  readonly now?: () => number
}

export interface ResourcePackageApplyTestInput {
  readonly pkg: ParsedPackage
  readonly previewToken: string
  readonly decisions: readonly unknown[]
  readonly humanMemberMappings?: readonly unknown[]
  readonly secretInputs?: readonly unknown[]
}

/**
 * 与旧 `commitResourcePackage(deps, actor, input)` 同形的测试入口。
 *
 * 写会话会把 `context.authority` 解回 Actor 并与传入的 Actor 对照，所以这里现铸一个
 * local authority 并让 resolver 认回同一个 `actor`——等价于生产里「路由造 context，
 * 装配的 resolver 认回请求者」。
 */
export async function commitResourcePackageForTest(
  deps: ResourcePackageApplyTestDeps,
  actor: Actor,
  input: ResourcePackageApplyTestInput,
): Promise<BundleReceipt> {
  const provider = composePostgresqlResourcePackageProvider({
    db: deps.db,
    appHome: deps.appHome,
    authorityResolver: { resolve: () => actor },
    mcpLifecycle: createMcpTransactionLifecycle(),
    capabilityTemplates: createPostgresqlCapabilityTemplatePackageMutationOwner({ db: deps.db }),
    pluginInstaller: deps.pluginInstaller ?? createResourcePackagePluginInstaller(),
    ...(deps.id === undefined ? {} : { id: deps.id }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  })
  const atomicApply = createPostgresqlResourcePackageAtomicApplyOperations({
    db: deps.db,
    box: deps.box,
    ...(deps.id === undefined ? {} : { id: deps.id }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  })
  const receipt = await atomicApply.apply({
    authority: new AuthorityClaimRegistry().mintLocalAuthority({
      userId: actor.user.id,
      source: 'system' as const,
    }),
    actor,
    package: input.pkg,
    previewToken: input.previewToken,
    decisions: input.decisions as never,
    humanMemberMappings: (input.humanMemberMappings ?? []) as never,
    secretInputs: (input.secretInputs ?? []) as never,
    mutationSessionFactory: provider.mutationSessionFactory,
  })
  return {
    journalId: receipt.journalId,
    applied: receipt.applied.map((item) => ({
      resourceType: item.resourceType,
      opId: item.operationId,
      resourceId: item.resourceId,
      action: item.action,
      name: item.name,
    })),
    ...(receipt.root === undefined ? {} : { root: { ...receipt.root } }),
    ...(receipt.skippedSecrets === undefined
      ? {}
      : { skippedSecrets: receipt.skippedSecrets.map((entry) => ({ ...entry })) }),
  }
}
