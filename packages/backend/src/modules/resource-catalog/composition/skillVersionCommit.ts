// RFC-353 T6/T7 —— 融合提交时「推进技能版本」那一半的装配出口。RFC-359 W4-D5 起两个 provider 同一份：
// tx-bound participant 工厂绑定调用方交来的统一事务句柄；SQLite 侧的同步变体退役。
export {
  composePostgresqlSkillVersionCommitParticipantFactory,
  composeSkillVersionCommitParticipantFactory,
  type PostgresqlSkillVersionCommitParticipantFactory,
  type SkillVersionCommitParticipantFactory,
} from '../infrastructure/skillVersionCommitParticipant'
