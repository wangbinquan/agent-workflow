# RFC-370 CI：当前迁移头的原配套断言

## 实际失败与当前来源

并行后继 4efba2f9 的主 CI 37733093270 中，Ubuntu 5／32 作业 113166465181 的 upgrade-rolling 原 sanity case 期望 242 项，实际 journal 已有 243 项；同套件的升级与真实 toy task 判据保持。原 SQLite journal 最后一项为 idx 242、tag 0243_rfc371_system_agent_native_usage，对应 PostgreSQL 0019_rfc371_system_agent_native_usage 追加迁移，历史项不改。

Ubuntu 15／32 作业 113166465278 的 RFC-349 schema projection 原 active parity case 仍期望 217 张表，实际为 233；同套件的六张 archive-only 省略、原 provider 类型和确定性 digest 判据通过。0019 的 logicalTables 恰好新增 16 项，均为 system*agent* 前缀，13 张原 native usage 状态／证据表及三张独立 System group／owner／source 表。原 Task 和 observation\_ 表继续保留。

Ubuntu 2／32 作业 113166465270 的 backup 原 layout case 使用 toMatchObject，只有 payload.activeTableCount 仍为 217；实际为 233。sourceProvider、sourceGenerationId、schemaDigest 与 archiveOnlyTableCount 的原字段、匹配方式和解包／envelope 文件 digest 校验保持。该作业的其它备份行为 case 通过；不把故障摘要展示的额外运行字段改成新的固定预期。

Ubuntu 31／32 作业 113166465335 的 canonical schema contract 也确认 source tables 为 239、active 为 233；原 metadata snapshot 仍是 223／217，完整 machine／human snapshot 由新增 System 表的 RFC-371 会话按原生成器同步，本片不改其生成器或产物。Ubuntu 12／32 作业 113166465424 的两个 SQLite logical source case 均仅因原 223 精确总数而失败，实际扫描／Worker tableRows 已为 239。两个原标题随精确数字改为 239，完整原 users 无损整数／稳定键／分页／Worker／变更信号、generation 判据和预算保持；canonical source／active 的三条数字改为 239／233，其余所有原人口与完整 snapshot 一致性断言保持。

## 有限修正

只改五份既有测试。upgrade-rolling 同时对齐原标题和 HEAD*TOTAL_MIGRATIONS 精确数字 243，加一条实际 0243 注释，全部旧 journal／升级／toy task case 与预算保持。PostgreSQL schema 的两条精确总数改为 233，保留原全部 observation* 名单、六张归档、immutable baseline 与完整历史重放判据；追加新增 System 表的排序后完整 16 项名单，强化来源一致性。backup 只改原 payload.activeTableCount 为 233，receiver、toMatchObject 和全部其它原字段不动。

原 baseline、journal／snapshot、安装 SQL 和所有生产源码不改，不添加 allowGrowth、不放宽旧枚举、数量或 matcher。完整文本逆变换恢复五个旧测试；纯 AST 比较核对原 case、断言、fixture 和预算，新增名单单独核验。

## 验收边界

本片没有 AW 新功能或生产改动，也没有架构 metadata、新 census、本机 AW tests／typecheck／build／service／E2E。有限独立功能门、精确发布／main 与 origin 同步以及新 exact-SHA GitHub CI 终态分别验收。用户已明确要求总流水线全绿后才继续 RFC；已通过的部分作业不代签全仓。runtime／Node／CS 新实施继续暂停，H7／A-G、M0～M4 与 RFC Done 仍开放，AW 尚未部署 CS。原共享正文与并行输出保持。
