# RFC-388 实施计划

**前置**：RFC-387 已提交。由 Codex 实施、本会话审核。单批次交付：先完成全部实现与用例，再集中验证一次。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-388-T1 | `TE/composition/taskExecutionBinding.ts`：执行绑定接口与进程级 / 会话级两个工厂 | design §2 |
| RFC-388-T2 | 中立 `composeTaskExecutionProviderRuntime`；删除两个 provider 命名函数、SQLite 路由启动包装、重复的 DAG 协作与工作区参与者、修复别名的使用 | design §1、§2 |
| RFC-388-T3 | 适配器表收缩为 `provider` / 执行绑定 / 并发作用域；模块组直接调用中立函数；类型再导出改中立 | design §2 |
| RFC-388-T4 | 删除测试专用活动钩子，四个测试改用执行模块运行注册表；直接构造运行时的测试与助手改用中立函数 | design §3.1 |
| RFC-388-T5 | 结构锁、旧锁与账本（design §3.2、§3.3）；`docs/dev-gotchas.md` 一条：任务执行运行时只有一个中立组合函数 | design §3 |

**依赖**：T1 → T2 → T3 → T4；T5 贯穿。

## 冲突面

`TE/composition/providerRuntime.ts`、`cli/daemonModules/{adapters,taskExecution}.ts`、P / V 的类型引用：与 RFC-389～392 串行。

## 验收清单

- [ ] proposal AC-1～AC-4
- [ ] 推送后 exact SHA 的 CI 全绿（含 PostgreSQL 分片）
