// RFC-359 W8 —— 资源包维护的两条小判据：**一份实现，两个 provider 共用**。
//
// 合一前 `sqliteResourcePackageMaintenance.ts` 与 `postgresqlResourcePackageMaintenance.ts`
// 各揣一份**逐字相同**的 `assertManagedPath` 与 `errorValue`。两者都不碰数据库、没有任何方言面
// ——纯路径判据 + 一个错误归一，两份并存的唯一后果就是「改一份、漂另一份」。
//
// `assertManagedPath` 尤其不该有两份：它决定「哪些路径算在托管根之内」，两侧一旦漂开，
// 同一个清扫动作在两个 provider 上会得出不同的「可删」结论，而两条路径各自的用例都还绿着。
//
// 注意：`modules/intent/infrastructure/postgresqlIntentApplyArtifactLifecycle.ts` 也有一个叫
// `assertManagedPath` 的函数，但那是**另一个实现**（走 `pathInside`、抛另一个错误码），
// 不属于这一对，别顺手合过来。
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** `path` 必须落在 `root` 之内（含 root 自身）；否则拒绝，错误码与清扫端口的合同一致。 */
export function assertManagedPath(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path))
  if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) return
  throw new Error('resource-package-maintenance-path-outside-managed-root')
}

/** 任意 throw 值归一成 `Error`，好让上层的日志与补偿只面对一种形状。 */
export function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
