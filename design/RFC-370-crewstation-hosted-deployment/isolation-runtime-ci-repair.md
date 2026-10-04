# RFC-370：隔离切面实际 hosted CI 接续

本批只修复 `3dfdcdc2d73932fe18e76b9be98a11f5c9cf9ade` 主 CI `37184000634` 暴露的测试装配与旧地址投影，不修改生产隔离、Git、事务、持久化或执行程序。该 SHA 的 Windows `37184004335` 已 completed/success；主 CI 在本批开始时仍运行，已完成的后端分片报告下列问题。历史失败不改写为成功，新提交必须重新取得确切 SHA 的 hosted 结果。

## 精确修复

- RFC-130 的单候选／pre-agent undo 判据改为真实 `workspaceRecord(iso).scope.undoShard`；保留原候选数、先于 runNode 的顺序和全部行为用例，并新增本机 scope 对原 undo 程序的绑定断言。
- RFC-060 的逐仓路径列表判据改为真实 `scope.changedFiles(repo.path`；保留 readonly 过滤、逐仓循环、完整 patch 和单仓回退的反向断言，并补上真实 scope 获取与本机 `gitChangedFiles` 绑定。
- RFC-210 replay 的物理 identity 判据从旧直接 `isoKeyOf` 改为原恢复路径的 `scope.recoverKey`、DB row identity 与 workspace reference；另锁本机的原 `isoKeyOf` 绑定。其全部 keep/discard、CAS、writeSem 和实际失败用例不变。
- 新 isolation fan-out 夹具显式装配既有 `composeNodeRunRuntimePersistence(db)`。此前两个用例在 undo 之后、冻结配置之前得到缺失 `persistence.withSelection`，没有到达夹具刻意设置的 runtime stop；原预期、双 provider、全部 undo／错误／清理／effect 断言与预算保留。
- RFC-284 的 dropped 快照补入已存在的 `isolationWorkspaces`。原 disposition 已登记此键，运行时仍从同一 bootstrap 工厂为 child drive 重新提供，不序列化父 scope。后续 Git 切面的新增配置不属于本次提交。
- 原 T19f 账本按实际扫描补入 `rfc370-workgroup-commit-queue.test.ts: 1`，并明确登记到 open debt：其 SQLite client 是真实机制夹具，PG 的 held transaction ACK／任意拒绝是协议夹具，不能冒充真实 PG 对拍。原 scanner、分类、逐文件精确计数、互斥分区、open 精确比对及预算全部保留，不增加文件特制豁免。

## 验证边界

仅对这六个测试与本文件作目标格式／lint 和纯字节／AST 证明，再进行独立功能 source 门。未运行本机 AW tests、typecheck、build 或 services；未生成 canonical，生产源输入无变更。正在开发的仓库 Git 切面与 RFC-371 的并行内容不纳入这次提交。

其他 reported failure 仍分别保留：macOS 的取消用例失败、`rfc122-clarify-directive-dispatch` 所在分片的 job timeout 和 RFC-371 的浏览器失败，不能用这六项有限修正冒充关闭。继续按实际日志定位，原预算不降低、不延长，不能重跑取绿。

完整 A1–A8／AC00／A-G 与独立 CS adapters、B/M0 实际部署、M1–M4 仍开放。AW-in-CS 首次部署尚未完成。本批不关闭 RFC-370。

## 独立门首轮与 R2 修正

SOURCE6-DOC1 首轮指纹 `b86c197790a5a8ad1ccd59e0b039c34ba76af85daa8d31912d9fb194a377d550` 为 FAIL／P2：补齐 runtime persistence 并不能使原配置 STOP 到达结果，因为原 best-effort 配置读取明确吞掉该拒绝。该原失败回执保留。R2 仅在夹具完整 runtime persistence 的 `withSelection` 上主动拒绝 STOP；其余原 prototype 方法绑定原 receiver，保持完整参与者。`resolveFrozenRuntimeWith` 将此拒绝传播给原 fan-out 装配的失败／清理分支，时点在 undo 之后、Agent 执行之前。原两个用例的消息、undo、warning、清理、effect 断言和全部预算保持，不修改生产 best-effort 行为。R2 另作固定候选独立复核，尚未有新 hosted 结果。

## 实际高水库存遗漏接续

R2 已通过有限独立门并发布 `04a795a825edf01a3b2514923503d035272c6e4c`，精确 Windows `37187051255` completed/success。主 CI `37187048069` 的 Ubuntu 6/16 job `111391151776` 仍失败：原 RFC-317 清点发现 `TEST_ENGINE_HARDCODING_DEBT` 实际 322 条、库存仍 321；`OPEN_MIGRATION_DEBT` 实际 2 条、库存仍 1。这是本会话在登记测试债后遗漏同步两项高水库存，不能把前批写成 CI 通过。

本续批只用原 `ledgerEntryCount` 核两项实际计数并更新对应 baseline，按原协议各登记一次增长；129 原行顺序、原 why、其余全部库存与 payload 保持。provenance 用原函数派生，原 sourceDigest 不变；测试变动不在生产 census 语料内，不重复生产 census。匹配提交消费后通过正常后继退役增长回执。未改任何 scanner/classifier、测试断言或预算，也不把 PG 协议夹具冒充真实数据库验证。

此时主 CI 仍未全绿，另有 frontend wizard 的 Windows 断言与 E2E 的共享 package 导入失败需要继续定位；有限库存修复不表示这些失败或完整 A-G／部署已完成。

随后并行 owner 已发布 E2E 源码入口修正 `06c4e358c44c033940c45fff81fede0d19b1452a`；本批基于并保留该提交，不重复修改其页面用例。旧 `04a795a82` 的导入失败仍留在原 run，新入口的正式 CI 结果继续等待，不能追记旧 run 为通过。
