# RFC-370 已提交重构的 hosted CI 断言修正

原 `8229927503b20f8412c5376b8e8ce11b03349151` 主 CI `37644567999` 的实际失败显示：SQLite logical source 与备份仍断言新增宿主写上下文表之前的数量，rolling upgrade 尚未登记 `0242_rfc370_host_execution_write_context`，三个启动配置／平台工具接线测试仍匹配重构前的调用形状。本批只修这六份原测试，不修改生产代码、扫描规则、数据库或迁移历史。

已提交的原 schema 合同是 223 个源表、217 个 active 表与 6 个 archive-only 表，SQLite journal 有 242 项。原分页／无损键／漂移／Worker／备份／升级用例、历史冻结目标及严格计数继续保留，只将确切数量登记到真实新 head。

启动配置锁继续要求 local floor、selected reader 与同一个 human-gate driver 接线；在原依赖对象内核对两个分支，避免别处的 resolver 掩盖漏传。人工续跑仍携带原 runtime，新增 reader 的异步返回在原 children.resume 之前 await；原回退根的本地配置与 selected drive 两条分支分别在场。平台工具测试从 600 字符距离改为解析原唯一 composeSqliteAppDeps 调用的实参，要求同名 shorthand 成员且目录仍只组装一次、同时交给 HTTP 与 employee OS。所有原功能案例、业务断言和 timeout 保持。

本机只运行本批 format／lint 与纯源码、AST、字节和 JSON 核对，没有 AW tests／typecheck／build／service，也不新增 architecture census。独立有限实现门、精确路径发布和新 exact-SHA hosted CI 分别验收，当前尚不能记全仓绿。

Task C2-W1 源码候选仍冻结在另一独立功能门；其余业务写点、完整 H7／A-T7／A-G 与 CS adapters、M0 首次部署和 M1～M4 继续。AW 尚未部署到 CS，RFC 不记完成。原失败与并行输出完整保留。

## PostgreSQL active parity 的确切计数续修

前批七路径经 SOURCE7-R1 有效稳定 PASS 后已精确发布 `14d4b2b7ccb120ac00b454e14506280c5017ea77`，推后 main／origin 0／0、index 空、全部 24 条并行在制路径保持；主 CI `37654626982` 已注册，终态另验。

进一步核对原 `37644567999` 的 Ubuntu shard 15 日志，`rfc349-postgresql-schema.test.ts` 的 active table 与 unique logicalId 两个严格计数仍为 216，实际为 217。本续批仅同步这两个精确计数及原头注释；原六个案例、六项 archive-only、十六个 observation 表全文、provider 类型／默认值／标识长度、完整 DDL digest、immutable baseline 与 append-only history replay 判据均保持。原测试除此三处可完整逆向恢复；不改 projector、schema、journal、历史迁移或扫描规则，无新 census／本机 AW 运行。有限功能门、精确发布与新 exact-SHA CI 分别验收。

Task SOURCE23-R1 的一个 heartbeat 与 owner revision 功能 P2 已实际消费并保留；D6 同步设计在独立复核，尚未修生产。十九 owner／三个 roots／UI、A-G 与 CS M0～M4 继续，RFC 仍未完成。
