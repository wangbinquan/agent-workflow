# 已发布增量表与原 CI 基线的同步

2026-10-12，本片修复已发布提交 `134603ad5658c0a45ebbc4a12881cf504e9b75e9` 的真实 CI 基线不一致。主 CI `38218462107` 中，原 SQLite source scan 两例、备份活跃表计数、完整 schema contract 两例仍使用新增表前的 241／235／6；原 PostgreSQL upgrade 控制夹具不认识新修订表的种子 metadata 语句；原微 helper 清单也遗漏两个新增的逐页 SHA builder。它们与前一片 test-only root inverse 修复、SQLite 行数语义修复分别处理，不修改累计使用量或 mindmap 的业务实现。

## 八表及完整清单

已发布 0245／PostgreSQL 0021 添加三个 `run-observability` KEEP 表：`observation_calculation_rows`、`observation_calculation_versions`、`observation_source_revisions`。已发布 0246／PostgreSQL 0022 添加五个 `collaboration` KEEP 表：`clarify_mindmap_command_receipts`、`clarify_mindmap_node_revisions`、`clarify_mindmap_nodes`、`clarify_mindmap_sessions`、`clarify_mindmap_snapshots`。两份不可变 upgrade 描述给出完整逻辑表、插入位置和前后 contract digest。

清单同步以 `ed12db25fb409fe7819e5b696b5e9dcd018daabb` 的已提交原 241 表清单为起点，纯数据重放这两份增量描述。逐步核对每份前后 digest、完整顺序及八个唯一 KEEP 追加；原 241 张表的每个完整描述保持相等。最终与该确切提交的完整源 roster 对拍，得到 249 source／243 active／6 archive，最终 contract digest 为 `sha256:f093173a29f7875afcbd167fae1d2687cc3118431348a2f3a848acb8cb929d49`，与 0022 的已发布目标 digest 相同。

同步 `schema-contract.json` 与 `schema-contract.md` 时复现原 canonical JSON 和报告格式，并先核对旧输出的完整字节相等。这次仅执行数据解析、标准库格式生成和身份核对，没有导入或执行 AW schema、generator、迁移、数据库、测试或服务，也没有把并行未发布的 schema WIP 加入当前清单。原生成器和生产 contract 实现保持原正文。

完整 schema 测试另锁八表的实际 owner、KEEP、迁移键和两个 provider 映射；六张归档表的精确清单、原全文 manifest 对拍、完整表描述及丢失／多余／重复表判据保留。这里没有使用运行时生成的表数作为自身的期望值。

SOURCE-R1 的冻结八文件功能核对未发现问题，但末轮 live 对拍期间，共享 main 的 `86a822bdf8a7840deff739e1d806bf6b8a94de76` 已发布 RFC-372 的五张 Task-owned 表。该提交原样保留本片八表断言，并把两个完整清单及完整 schema 测试同步为 254／248／6。R1 因三份 live 身份已改变而不具发布效力，保留其原始回执和分析；不覆盖或重新生成这三份已发布共享文件，也不重复提交它们。

当前候选只续接四个剩余原测试和本说明。SQLite source scan 两例显式锁新已发布 254 表；备份显式锁 248 active／6 archive。0023 的完整不可变增量描述、已发布 roster、已发布清单及完整 schema 测试作为控制依据，独立核对其与 0022 的 249／243／6 前缀及五个唯一 KEEP 增量相合，再复核这些测试的全部原判据。原 PostgreSQL 种子及两个流式 builder 的修复不变。

## PostgreSQL 控制夹具与逐页 builder

upgrade 夹具只接受原完整 SQL 清单中已登记、kind 为 `metadata`、logicalId 精确为 `observation_source_revisions:initial-revisions` 的语句，并把它记录在事务候选状态中。其它未知 SQL 仍拒绝。成功升级必须恰好执行一次原种子语句；新增种子失败回归核对原事务、原 schema／metadata 回滚、无提交回调和一次连接 release；pointer 回调失败后的重试另核对种子不重放。原 native function／trigger、index、代际更新、锁与 pointer 判据保持。

微 helper 的完整精确路径集合仅追加 `completeCalculationFactReader.ts` 与 `completeCalculationFactStore.ts`。二者跨有界页／多行迭代更新同一个 SHA 状态，原 digest 输入和导入／读取算法保持，不把单步 hash 副本放进许可。原 sha1、monotonic、race 和完整 SHA 路径等号判据均保留。

## 验证与退出条件

当前五个 owned 为四个原测试和本说明；开始时的四个原测试均为干净已提交内容。限域格式、lint、纯语法和独立功能实现门之后精确上库。没有生产源码或生成规则改动，不重复 RFC-294 的 src-only 架构 census。不执行本机 AW test／typecheck／build／服务／E2E；新增用例及修复效果仅由后继确切 SHA 的 GitHub 主 CI 和默认完整 Windows 判定。

本片不代签 SQLite 行数修复、所有其它 CI 作业或完整 RFC 完成；原失败记录保留。H7、CS adapter、真实部署和 M0～M4 继续开放，RFC 的后续实施仍等待完整总绿。
