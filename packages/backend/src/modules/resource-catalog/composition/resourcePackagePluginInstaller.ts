// RFC-359 —— 资源包写插件时用的**消费方自有**安装器绑定。
//
// 这个对象本来在 `main.ts` 的 PostgreSQL 分支里内联写着一份；SQLite 分支走的是
// `services/bundle/legacyResourcePackageMutationDependencies.ts` 里另一份，**底下调的是
// 同两个函数**（`plannedGenerationDir` / `installPlugin`）。两条 apply 引擎合一之后
// 只剩一个装配口，绑定自然也只该有一份。
//
// RFC-455：自 `services/resourcePackage/pluginInstallerAdapter.ts` 迁入 resource-catalog `composition`——它包着的
// `infrastructure/local/filePluginInstallation` 本就在本模块里，绑定随之归本模块的装配；bootstrap 改取这里。

import { installPlugin, plannedGenerationDir } from '../infrastructure/local/filePluginInstallation'

/**
 * 端口形状按**结构**声明（迁入前它在 legacy 层，取模块 composition 的类型要在 `rfc317-module-boundary` 记一条边）。
 * 真漂了在装配点就编译不过——bootstrap 把这个对象交给 `composePostgresqlResourcePackageProvider`。
 */
interface ResourcePackagePluginInstaller {
  plannedGenerationDirectory(input: {
    readonly pluginId: string
    readonly spec: string
    readonly generationId: string
    readonly pluginsDir: string
  }): string | null
  install(input: {
    readonly pluginId: string
    readonly spec: string
    readonly generationId: string
    readonly pluginsDir: string
  }): Promise<{
    readonly cachedPath: string
    readonly resolvedVersion: string | null
    readonly sourceKind: 'file' | 'npm' | 'git'
    readonly generationDirectory: string | null
  }>
}

/** 两个 provider 共用的插件安装绑定：目录规划同步算，安装落盘异步做。 */
export function createResourcePackagePluginInstaller(options?: {
  readonly npmBin?: string
  readonly timeoutMs?: number
}): ResourcePackagePluginInstaller {
  const installOptions = {
    ...(options?.npmBin === undefined ? {} : { npmBin: options.npmBin }),
    ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  }
  return Object.freeze({
    plannedGenerationDirectory(input: {
      readonly pluginId: string
      readonly spec: string
      readonly generationId: string
      readonly pluginsDir: string
    }): string | null {
      return plannedGenerationDir(input.pluginId, input.spec, input.generationId, input.pluginsDir)
    },
    async install(input: {
      readonly pluginId: string
      readonly spec: string
      readonly generationId: string
      readonly pluginsDir: string
    }) {
      const installed = await installPlugin(input.pluginId, input.spec, {
        generationId: input.generationId,
        pluginsDir: input.pluginsDir,
        ...installOptions,
      })
      return Object.freeze({
        cachedPath: installed.cachedPath,
        resolvedVersion: installed.resolvedVersion,
        sourceKind: installed.sourceKind,
        generationDirectory: installed.generationDir,
      })
    },
  })
}
