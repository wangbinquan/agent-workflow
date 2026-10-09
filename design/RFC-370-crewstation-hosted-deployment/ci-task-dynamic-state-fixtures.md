# RFC-370 C2-W2-D：真实动态生成夹具与 SQL 观测配套

## 原失败与必要修复

确切提交 `331f30aaf75500487b38910da08df946648664e9` 的主 CI `37919924358` 中，Ubuntu backend21 的 job `113785124642` 有 22 个失败：两 provider 各 9 个动态生成案例在进入生成器分支前即失败，另外 4 个 PG 案例在 SQL 更新条数断言失败。Mac backend9 的 job `113785124739` 有同样的 9 个 SQLite 生成案例失败。原失败日志保留，不将旧失败记为成功。

原 `WorkgroupMemberDisplayNameSchema` 禁止显示名带空白。新增夹具的 `original member` 因此不能通过原 `WorkgroupRuntimeConfigSchema`，原生成器返回配置不可读，未执行预期的取消、等待、失败重试或成功确认分支。本修复将该单一夹具值改为 `original-member`，并在写入原任务快照前断言原 schema 的解析结果与夹具完整相等。成员 ID、Agent、工作组、生成内容和业务预期保持。

PG 原 provider schema 将真实更新渲染为 `update "agent_workflow"."workgroup_task_state" ...`；原 SQL 计数仅匹配未限定表名。本修复在原两个 matcher 增加固定的可选 `"agent_workflow".`，并以表名后的空白限定完整表名。仍只计原 `UPDATE workgroup_task_state`；原精确 1 次更新、1 次 commit 或 rollback、无相反事务终结、实际数据库状态、原 owner、原工作和同一事务断言保持。

## 共享架构配套

Mac backend5 job `113785124762` 的唯一失败是原 RFC-317 R1 精确边清单与 authored debt 不相等。原一次 canonical 输出已记录新增边 `services/dynamicWorkflowRunner.ts -> @/modules/task-execution/application/dynamicWorkflowWriteSelection [value:static-import]`；配套漏加对应 authored 行。新增行已经具名交接给正在生成共享 13 份架构配套的 RFC-371 会话，由其下一普通候选加入并独立复核：原 356 行及全部 why/顺序保留，新增 1 行，inbound baseline 310→311，A-T7 / RFC-294 W4-E 退役。原 R1 oracle 与完整规则保持，不以忽略边或删断言修绿。

该架构行、共享配套和四项 growth 的普通后继退役由协调后的独立发布验收。本测试批不写共享架构文件，不代签该配套。

## 有限验收与剩余范围

本候选只修改新动态状态测试及本记录。七个生产文件、原 20 个 test 定义、26/provider + 1 global 的案例人口、原所有断言与预算保持，仅新增夹具完整解析断言。逆向还原上述五个文本改动必须得到已提交测试的完整原字节。必要静态格式和有限独立功能检视后精确提交；新 SHA 的 GitHub 主 CI、原 Windows 完整登记/运行及实际新增案例分别验收。

没有本机 AW tests/typecheck/build/services/E2E，没有新增整仓 census，也不扩展为安全审计。全仓总绿前下一批生产实施暂停。完整 H7/A-T7/A-G、十九 owner、三个实际 roots、各层独立 CS adapter 与 M0～M4 继续开放；AW 尚未部署 CS，RFC 未完成。
