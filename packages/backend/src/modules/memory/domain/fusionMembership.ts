// RFC-353 T2（RFC-294 W4-E3）—— 融合成员关系的**唯一**判据（纯函数，零 IO）。
//
// 这里只回答两个问题：
//   ① 技能回滚到第 N 版时，哪几条记忆要退回待用？
//   ② 记忆被融入 / 被退回时，provenance 那一组列该写成什么？
//
// 为什么必须收成一份：RFC-353 立项前实测，这两个判据在两个 provider 上各写了一份——
// SQLite（`sqliteMemoryCatalog.unfuseMemoriesTx`）先 SELECT 再逐行 UPDATE、返回 SELECT 顺序；
// PostgreSQL（`postgresqlSkillMemoryFusionParticipant`）一条 UPDATE ... RETURNING 再 `.sort()`。
// 集合一样、顺序不一样，而这个数组经 `skill-catalog.restore-skill-version.v1` 的
// `unfusedMemoryIds` 直接上 wire。memory id 是 ULID、通常按时间递增，所以插入顺序≈字典序，
// 日常看不出来——只有记忆不按 id 顺序落库时才现形。这与 RFC-352 开局撞到的 canManage
// 双 provider 漂移是同一类形状，处置也一样：**同一判据只留一个 owner 出口**。
//
// 顺序取字典序、不取插入顺序：插入顺序是存储实现的副产品（SQLite 的 rowid），
// 换个 provider、换个索引就变；调用方拿到的 id 数组要能跨部署逐字对拍。

/** 判据只看这几列——传进来的行可以是任何带这四个字段的东西。 */
export interface FusionMembershipRow {
  readonly id: string
  readonly status: string
  readonly fusedIntoSkillId: string | null
  readonly fusedIntoSkillVersion: number | null
}

export interface UnfuseSelector {
  readonly skillId: string
  readonly aboveVersion: number
}

/**
 * 回滚到 `aboveVersion` 时要退回的记忆 id，**字典序**。
 *
 * 不变式：fused ⟺ 该知识在技能的当前版本里。所以融入版本**严格大于**目标版本的才退——
 * 等于目标版本的知识仍在回滚后的内容里，退了就等于把已生效的知识再注入一遍。
 */
export function memoriesToUnfuseAbove(
  rows: readonly FusionMembershipRow[],
  selector: UnfuseSelector,
): string[] {
  return orderMembershipIds(
    rows
      .filter(
        (row) =>
          row.status === 'fused' &&
          row.fusedIntoSkillId === selector.skillId &&
          row.fusedIntoSkillVersion !== null &&
          row.fusedIntoSkillVersion > selector.aboveVersion,
      )
      .map((row) => row.id),
  )
}

/**
 * 成员关系 id 数组对外的**唯一**顺序。
 *
 * 单独导出是给「选中规则已经在 SQL 里判过」的 provider 用的（PostgreSQL 侧是一条
 * `UPDATE … RETURNING`，行已经筛好了，只差顺序）。让它复用同一个排序，
 * 而不是在适配器里各写一个 `.sort()`——否则「顺序」又变成两处判据，
 * 而顺序恰恰是本刀查出的那处双 provider 漂移。
 */
export function orderMembershipIds(ids: readonly string[]): string[] {
  return [...ids].sort()
}

export interface FusedProvenance {
  readonly skillId: string
  readonly skillName: string
  readonly skillVersion: number
  readonly fusionId: string
  readonly actorUserId: string
  readonly now: number
}

export interface FusedProvenanceStamp {
  readonly status: 'approved' | 'fused'
  readonly fusedIntoSkillId: string | null
  readonly fusedIntoSkill: string | null
  readonly fusedIntoSkillVersion: number | null
  readonly fusedAt: number | null
  readonly fusedByUserId: string | null
  readonly fusedFusionId: string | null
}

/**
 * provenance 那一组列的唯一写法：`null` = 退回待用（全清），否则 = 融入（全写）。
 * 收成一份是为了让「融合写了哪几列」与「回滚清了哪几列」永远对称——
 * 少清一列就会留下一条状态是 approved、却仍指着某个技能版本的幽灵行。
 */
export function fusedProvenanceStamp(provenance: FusedProvenance | null): FusedProvenanceStamp {
  if (provenance === null) {
    return {
      status: 'approved',
      fusedIntoSkillId: null,
      fusedIntoSkill: null,
      fusedIntoSkillVersion: null,
      fusedAt: null,
      fusedByUserId: null,
      fusedFusionId: null,
    }
  }
  return {
    status: 'fused',
    fusedIntoSkillId: provenance.skillId,
    fusedIntoSkill: provenance.skillName,
    fusedIntoSkillVersion: provenance.skillVersion,
    fusedAt: provenance.now,
    fusedByUserId: provenance.actorUserId,
    fusedFusionId: provenance.fusionId,
  }
}
