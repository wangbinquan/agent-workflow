# RFC-370 CI：原单进程活跃度端口与插入站点登记

本片设计只处理 `ca6f8417e3c4903966e72d21f89264b7756b6586` 主 CI `38171413992` 最后完成的两项功能失败。完整主流水线已为 `completed / failure`，72 个作业中 52 个成功；完整 Windows `38171413874` 也失败。已有 Task 夹具／旧源码判据修复及 RFC-371 缓存会话的候选分别保留，本片不代签它们。

## 原单进程活跃度端口

Ubuntu shard 12 `114564631397`、macOS shard 12 `114564631467` 的 RFC-359 W8 原 case 要求 `participants.activity.isActive.length === 1`。原 `composeLegacyTaskActivityParticipant` 将 `services/task.ts` 的 `isTaskActive` 函数直接放入这一格；Task 宿主实例装配给该服务函数新增了可选 `executionModule` 第二参数，因此 SQLite 原端口现在暴露了两个形参。PostgreSQL 一参数端口仍通过，两个 provider 的原合同产生了可见差异。

修复只在既有 `composeLegacyTaskActivityParticipant` 装配点把这一格绑定成一参数委托：`isActive: (taskId) => isTaskActive(taskId)`。它仍调用原全局函数，传入同一 taskId、不传 module，继续使用原进程级 driver 与测试 controller；不重建 registry、模块或 lifetime，也不把宿主实例路由放回全局面。`awaitReleasedSettled` 仍是原函数，返回对象仍冻结。选中宿主的另一份 `createBoundTaskActivityParticipant` 和所有业务算法保持。

原 W8 case、全部端口方法名、形参个数期望、真实双 provider 行为、断言和预算保持。由 GitHub Actions 实际重跑既有 W8 验收；无需新增镜像测试或本机 AW 执行。原 P12 的十一份整文件 preimage 不涉及这个独立基础装配文件，仍按其完整原 bytes／SHA 验收，不能替换原期望。

## 原插入站点登记

Ubuntu shard 25 `114564631481`、macOS shard 5 `114564631358` 的 RFC-359 W7 原 case 报告仅一行变化：`services/task.ts:2504` 变为 `services/task.ts:2537`，三列仍为 `executionLineageId+ lineageSlotPathJson+ launchOrigin+`。其余三个站点逐字一致。原规则明确将真实源码行号也作为登记的一部分，插入点上方的编辑必须跟随登记。

修复只把 `TASK_INSERT_SITES` 中这一条更新为实际行号 2537，并附上 RFC-370 宿主装配增加前置文本的理由。仍登记原四个站点、三列齐全。`taskInsertSites` 原 AST 遍历、源码树人口下限、负向缺列自证、全部旧 case、断言和超时预算不变，不增加豁免、不改扫描键或规则。

## 实施与验收顺序

独立有限功能设计门实际消费后，再实施上述一参数委托和精确站点登记。随后与本会话其余必要 CI 修复组成有限源码候选，根完整消费独立实现回执。累计用量持久化／缓存、原报告 Worker、迁移头及 public consumer 修复由「设计运行观测统计全景」会话继续负责；其独立源码候选交接后，双方冻结内容一起执行一次必要的原 scoped census 与配套检视，避免重复生成。未纳入本次 CI 修复的 maintenance 并行输出完整保留并排除生成输入与发布清单。

精确暂存／提交／紧邻许可退役、push 前后 origin/main 同步、新确切 SHA 的完整主流水线与完整 Windows 分别验收。只有 GitHub 总 CI 全绿才恢复 RFC 后续实施；SOURCE 或纯字节检查不能替代实际 W7／W8／Task 行为。无本机 AW test／typecheck／build／测试服务／E2E，原失败与已有门结论分别保留。

完整 H7／十九 owner／三个生产启动根、A-T7／A-G、各层独立 CS adapter、先 M0 实际部署再 M1～M4逐步适配，以及 RFC 完成仍开放。AW 尚未部署到 CS。
