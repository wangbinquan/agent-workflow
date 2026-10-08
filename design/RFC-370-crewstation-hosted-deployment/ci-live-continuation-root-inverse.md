# RFC-370 CI：澄清续接完整根的已提交变化

## 正式失败与归属

回顾修复及类型跟进已发布到 `80f59b754fbfc0cddfd2be742cfebe56f1512497`。该版本 Windows `37719697790` 在类型检查和平台测试步骤成功后，于构建期间被并行后继取消，正式结论仍为 cancelled；原主 CI `37719697713` 的终态另验。

并行后继 `e6098f5ba885875013f0af9a6c0831c69084c032` 完整包含该版本，25 份已审自有候选正文不变。其 Windows `37720290354` 正式 failure，功能作业 `113126269860` 的平台套件实际为 941 pass、3 skip、1 fail；唯一失败是 `RFC-370 native MCP root completeness > all three native roots retain every original body statement and argument`。旧主 CI `de10350b` 的 `37716532515` 也已正式 failure，旧失败与取消不倒写。

`e6098f5b` 将 `cli/start.ts:3107` 的 `gateContinuationDeps` 改为显式使用 `taskLaunchConfiguration.continuationQueries`。对应 composition 保留原 live reader，原同步与异步续接行为由该提交自带测试覆盖；本片不修改或重签并行生产实现。原完整根 reader 仍要求该语句的旧摘要 `099a3b158c79b88af5b975507a86da698ba394c747439eb8a30d3f86318356fa`，因此在全量逆向前准确拒绝了新语句。

## 有限修正

只更新原 fixture 中这一项的当前语句摘要为 `61e0831ea8fe71e1919782d0ecf7bcaa9426cb85c75ca019d07775aef26c6414`，并在同一项记 `reviewedCommit`。所有原 `previousStatement`、其余摘要、四 root 人口与原完整 MCP body／argument 断言、名称、预算保持。没有加入宽泛匹配、跳过未知语句或改写旧完整 body 摘要。

纯 AST 对拍使用原 reader：旧 fixture 读取当前源码重现同一拒绝；新 fixture 将四个完整 SourceFile 恢复为旧 fixture 读取 `80f59b75` 源码时的相同结果。将这一 live binding 改为另一 binding 仍被拒绝。此项只证明 reader 和全量文本保持，不是本机 AW 测试结果。

Windows push／PR 两个路径过滤器各登记该 reader 的 TS 和 JSON 输入，共四行；完整逆向回到原 workflow，全部 jobs、测试命令、断言、环境、预算不变。生产和架构产物零变化，不重复 census。

## 验收边界

共享 STATE／plan 的所有旧正文与并行内容完整保留，只增加这次实际事实。本机只做自有格式与纯 AST／字节核对，没有 AW tests、typecheck、build、services、E2E。有限独立功能门、精确发布及新 exact-SHA 主／Windows CI 分别验收。回顾修复不重审或冒称已取得新整仓 CI；新的 runtime／Node／CS 实施继续暂停，H7／A-G、M0～M4 与 RFC Done 保持开放，AW 尚未部署 CS。
