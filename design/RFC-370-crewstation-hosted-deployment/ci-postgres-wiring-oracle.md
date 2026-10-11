# CI：显式 PostgreSQL 启动的双引擎接线判据

`63446f121167db7aedd6d7ae7e458b12414517f7` 的主 CI `38139167698` 中，macOS 第七分片 `114469258720` 在原 `rfc359-w8-ci-dual-engine-wiring.test.ts:154-158` 报失败。唯一 failed case 是“① backend 分片在 ubuntu 上起了 postgres 服务容器”，原判据只读取 `backend.services.postgres`。这是本次将声明式服务迁至 checkout 后显式启动时遗漏的配套判据；原有限设计／实现 PASS 只覆盖其冻结输入，不能据此签收整仓 CI。原失败日志 454787 bytes／SHA256 `dabbea1f863cfc8126f2a86df47a7e6d3b97da7098ea87e05271486d6f36de17` 保留。

同一提交的真实 PostgreSQL 作业 `114469258367` 已正式 success：checkout 后调用原 helper，实际 Docker mirror 配置为 `https://mirror.gcr.io/`，成功拉取 `docker.io/library/postgres:17`，实际 digest 为 `sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3`，服务版本为 PostgreSQL 17.11。原 SQL probe、36 个原功能案例、RFC-359 P0 mutation 和清理全部成功。默认完整 Windows `38139255380`／`114469518510` 的 26 步与四工作区 typecheck code 0 已核对；这些成功不代签主 CI 全绿，也不宣称实际缓存命中或回退分支已被运行。

## 功能要求与有限修改

仅修改该 W8 测试和本说明；保留 workflow、helper、provider harness、生产源码、全部 H／L／R／SO／原 boot 用例及预算。原九个 case 的名称和顺序保持，原 provider 收窄扫描、Ubuntu URL 要求、macOS／Windows 两个例外及五个负 fixture 全文保持。①的原 `toBe(true)` 要求仍是 Ubuntu 在双引擎测试前拥有可用 PostgreSQL，更新的是启动形式的结构读取。

在原解析出的 job steps 上增加私有接线判据，只使用现有 YAML 数据：checkout 必须先于唯一已选启动步骤；启动步骤的原 id、bash shell、Ubuntu 条件和 `start awtest` helper 命令必须完整；原 PostgreSQL SQL probe 在启动之后，所有携带 `AW_TEST_POSTGRESQL_URL` 的 `bun test` 在 probe 之后；同一 helper 的停止步骤位于这些测试之后，并保留原 `always()`、Ubuntu 条件和 start outcome 非空／非 skipped 的清理条件。没有完整接线就返回 false；不把旧的声明式形态当成当前显式启动的证明。

追加一个负 fixture case，使用同一真实 job 的复制步骤验证缺启动、错误数据库或运行条件、启动移到 probe／测试之后、缺清理、清理移到测试前或去掉 `always()` 时不能通过。它验证接线判据仍有区分力；不执行 helper，不把 shell 实现逐行复制成测试，不延长原等待预算或减少数据库验证。新增私有函数没有 production/public 合同或新架构增长许可，因此不运行新 census。

## 验收顺序

先完成本有限设计的独立功能门，再实施、定向格式／lint与纯完整源码／AST 保留核对，并完成独立实现门。只精确提交两条相关路径，保留 Task 草稿和所有并行输出。原 CI 继续至终态，不因新修复或主干前进取消；后继同 SHA 完整主 CI／默认完整 Windows 分别验收，仍需核对 637 次原目标实际具名执行。

不运行本机 AW tests／typecheck／build／service／E2E 或所提供 helper。原失败、门与发布历史保留。总流水线全绿后继续 Task 完整装配、三个启动根和十九 owner、H7／A-T7／A-G，再进行各层 CS adapter、先 M0 实际部署后 M1～M4；AW 尚未部署 CS，RFC-370 未完成。
