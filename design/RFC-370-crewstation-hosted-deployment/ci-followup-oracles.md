# RFC-370 原 CI 时序修复的跟进

用户要求先回顾既有功能和质量、修绿 CI，再继续适配能力。本片只修真实 CI 揭示的测试类型与预期、一个文档相对链接，生产与架构规则不改。

## 精确 d05 证据

已发布 `d05fc28b026bd01e45662cb1d282664de4638182`，主 CI `37711897500`、Windows `37711897530`。Windows 正式终态为 failure：三套原 held-barrier 测试实际完成并通过 24／28／4 个 case，后续 typecheck 因两处原同步／异步端口值的 `.catch` 调用失败。主 CI 的基础检查也报这两处 `TS2339`。

主 CI 的文档链接作业 `113099468689` 报 RFC plan 中一个新链接重复了目录前缀；后端分片 `113099469120` 报两条 PostgreSQL failed-claim rollback oracle 和一条 selected preparation retry HTTP 预期。上述真实失败保留，主 CI 整个 run 的正式终态另留证，不把部分测试成功记成全仓绿。

## 三份测试的有限修正

provider runtime 的原端口返回 `HostExecutionResult<T> = T | Promise<T>`。两处观察改成 `void Promise.resolve(starting).catch(...)`，保留原变量、实际返回 Promise、完整 rejection matcher 及 barrier 释放位置，兼容同步返回的类型；没有吞掉最终测试断言。

failed-claim 的原真实 PostgreSQL COMMIT／ROLLBACK response-loss 探针，经 Drizzle sqlite-proxy 返回 `DrizzleQueryError`，原 `rollbackError` 位于 `cause`。修正为原类、`query === 'rollback'` 和 `cause === rollbackError` 的三重断言。保留原真实 server-held 事务、两种 outcome、精确 row／owner／ACK／drain、资源编辑与 finally，以及原 `15_000` 预算。与前批已经修正的 finalization oracle 使用同一真实错误契约，不修改生产错误。

selected Task preparation 的原 PostgreSQL retry 会先写入失败 attempt，再把真实 clone `DomainError` 返回 HTTP；这在 RFC-370 前的 `a53425b87bc6fa124d74829c278f52059ca04c93` 已存在，当前仍保持。SQLite 的原后台 retry 返回 `200`；PostgreSQL 同步失败返回 `400`。原零 baseline window 用例保留 SQLite 的 `200`，明确断言 PostgreSQL `400` 和完整 `repo-clone-failed`／源 URL 形状，后续失败任务、至少两条 attempt、原 settings receiver 与文件不变断言全部保留，原 `30_000` 预算不改。

三份测试的完整逆向只删除上述有限修正即可逐字还原 d05。全部原 case 名称、数量和预算保持；provider matcher 输入全相等，另两份只纠正已确认的错误 oracle 并增加完整错误断言。没有新增镜像测试、workflow 预算或生产改动。

## 与回顾修复配套的关系

H345-P2-001／H7-P2-001 的已审 SOURCE18 仍完整保持，本 CI 片不修改其 18 文件。其唯一原 census 和 13 matching 输出不重跑、不改写，sourceDigest 仍为 `sha256:67b6d66cc0ff1163f62e52dd533d13fa2377e55f47a836d2c7d2f395e258f9bc`；129 有序 ledger 全行／why／baseline 保持，零增长许可。源码 gate、matching gate、有限 CODE3／文档 gate、精确发布和 hosted CI 分别绑定。

共享 STATE／plan 只补本片事实和纠正本会话新增的错误相对链接，所有其它回顾修复、旧正文及并行输出保持。测试和文档不会作为新的适配能力签收。

## 验收边界

本机只完成自有格式、lint 和纯 AST／字节核对，没有 AW tests、typecheck、build、services、E2E 或第二次 census。独立功能复核、精确提交与新 exact-SHA 主 CI／Windows 分别验收，静态检查不代签远端结果。

新的 runtime／Node／CS 实现继续暂停至回顾修复与 CI 收口。H7／A-T7／A-G、各层独立 CS adapters 和 M0～M4 仍开放，AW 尚未部署 CS，RFC 未完成。原时序修复见[held matcher 记录](ci-held-rejection-matchers.md)，回顾配套见[发布记录](retrospective-functional-repairs-publication.md)。
