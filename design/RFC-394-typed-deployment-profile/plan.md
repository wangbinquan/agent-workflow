# RFC-394 实施计划

**前置**：RFC-393 已提交。由 Codex 实施、本会话审核。单批次交付：先完成全部实现与用例，再集中验证一次。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-394-T1 | `bootstrap/deploymentProfile.ts` 类型；`bootstrap/standalone.ts` 单机工厂（含宿主探测）；托管工厂改为返回 profile；选择点改为 `selectDeploymentProfile` | design §2.1、§2.2 |
| RFC-394-T2 | 启动序列接收 profile、命令行监听参数与开发叠加；宿主探测改由 profile 提供；会话输入经展开构造；直接导入会话组合函数 | design §2.3 |
| RFC-394-T3 | 会话输入与应用图输入继承 `DeploymentSelections`；会话图到应用图一次展开；`requiredProvider` 判定取代 `admitSelections` | design §2.4 |
| RFC-394-T4 | `main.ts` start 分支与开发热重载回调 | design §2.5 |
| RFC-394-T5 | 新结构锁；G9 账本与 `counts.json`；按旧形状锁定的测试改写；新增 §3 用例 | design §2.6、§3 |
| RFC-394-T6 | 文档：`docs/dev-gotchas.md` 当前规则段落 | design §2.6 |

**依赖**：T1 → T2、T3 → T4 → T5；T6 贯穿。

## 冲突面

以下文件与 S2c 后继 RFC 串行：

- `bootstrap/**`、`main.ts`；
- `T/architecture/*`、`architecture/*.json`；
- RFC-370 根接线测试族、`T/helpers/providerHttpApplication.ts`。

## 验收清单

- [ ] proposal AC-1～AC-3
- [ ] 推送后 exact SHA 的 CI 全绿（含 PostgreSQL 分片、windows-platform、maintenance-soak、三平台 e2e）
