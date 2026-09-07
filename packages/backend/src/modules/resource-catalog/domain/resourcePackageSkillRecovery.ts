// RFC-359 W9 —— 资源包崩溃恢复里「这个技能代际还该不该落盘」的判定：**一份实现，两个引擎共用**。
//
// 崩溃发生在「技能新版本内容已铺在盘上、还没换进 live 目录」这一刻；收敛器重启后要面对的问题是：
// 从崩溃到现在，账面（`skills.content_version`）可能已经不是当初那个代际了。用户在这段窗口里
// 完全可能又发布了一版、把技能删了、或者库回滚到更早的代际。判定只看两个数，纯函数、无副作用：
//
//   - `currentContentVersion === null`（技能行没了）  ⇒ `cleanup-deleted`：清掉暂存，**别复活**
//     一棵没有数据库行的孤儿目录。
//   - 账面 **>** 工件                                 ⇒ `cleanup-superseded`：live 目录里是用户
//     后发布的新内容，清掉暂存、**别把陈旧代际换回去**。
//   - 账面 **<** 工件                                 ⇒ `reject-missing-generation`：库根本不认识
//     这一代，报错留痕（可重试），**别把未知代际换进 live**。
//   - 相等                                            ⇒ `roll-forward-current`：正常换进去。
//
// 此前只有 PostgreSQL 侧有这四分支（`postgresqlResourcePackageSkillRecoveryDisposition`）；
// SQLite 的 `publishStagedVersion` 从头到尾不读 `content_version`、也不看技能行还在不在，
// 于是后三格全部静默走错（陈旧代际被换回、已删技能目录被复活、未知代际被当成功换入）。
// 判定是纯算术、与引擎无关，所以合一而不是各写一份；两侧的用户可见结果由
// `tests/rfc359-w9-resource-package-skill-recovery-conformance.test.ts` 的 4 格 × 2 引擎钉住。

/** 恢复时对一个已铺盘技能代际的处置。 */
export type ResourcePackageSkillRecoveryDisposition =
  | 'cleanup-deleted'
  | 'cleanup-superseded'
  | 'roll-forward-current'
  | 'reject-missing-generation'

/** 纯代际判定，在读任何快照之前做。`null` = 技能行已不存在。 */
export function resourcePackageSkillRecoveryDisposition(input: {
  readonly currentContentVersion: number | null
  readonly artifactVersion: number
}): ResourcePackageSkillRecoveryDisposition {
  if (input.currentContentVersion === null) return 'cleanup-deleted'
  if (input.currentContentVersion > input.artifactVersion) return 'cleanup-superseded'
  if (input.currentContentVersion < input.artifactVersion) return 'reject-missing-generation'
  return 'roll-forward-current'
}
