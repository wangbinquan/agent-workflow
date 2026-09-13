// RFC-359 —— 资源包写插件时用的**消费方自有**安装器绑定。
//
// 这个对象本来在 `main.ts` 的 PostgreSQL 分支里内联写着一份；SQLite 分支走的是
// `services/bundle/legacyResourcePackageMutationDependencies.ts` 里另一份，**底下调的是
// 同两个函数**（`plannedGenerationDir` / `installPlugin`）。两条 apply 引擎合一之后
// 只剩一个装配口，绑定自然也只该有一份——放在这里，因为「插件怎么装到盘上」是
// resource-catalog **外**的能力，模块只声明端口、由消费方填。

import { installPlugin, plannedGenerationDir } from '@/services/pluginInstaller'

/**
 * 端口形状按**结构**声明，不从 resource-catalog 的 composition 里 import 类型：
 * legacy 层指向模块内部 / composition 的边是有账本的（`rfc317-module-boundary`），
 * 为一个四字段的端口新欠一条边不值得。真漂了在装配点就编译不过——`main.ts` /
 * `server.ts` 把这个对象交给 `composePostgresqlResourcePackageProvider`。
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
