# 真实业务工作组场景

这里的场景不是抽象能力演示，而是可以通过公共 HTTP API 落库、启动并进入真实调度链路的业务
用例。场景定义与 E2E 共用同一份 TypeScript catalog，避免示例叙述和验证对象各自漂移。
跨 Workflow / Workgroup 的业务验收合同与后续场景见
[`../../BUSINESS_SCENARIOS.md`](../../BUSINESS_SCENARIOS.md)。

## 客户数据迁移作战室

[`business-operations.ts`](./business-operations.ts) 创建一个可写迁移负责人、一个只读风险评审者、
一个 `free_collab` Workgroup 和一条 scratch 任务。两名成员分别完成初始规划回合，执行卡只会
分给可写成员。迁移目标被拆成三张可审计卡：

1. 冻结源数据 schema，并产出字段映射；
2. 校验加密导出包；
3. 准备回滚 runbook。

首次批量执行时，字段映射成功，但加密包校验因 checksum 不一致自报 `failed`。框架应只把失败卡
重新放回任务池；已经成功的字段映射和同一首批完成的回滚 runbook 都不能重跑。第二批只执行加密包
校验，成功后机械收敛并进入人工 completion gate。真实 daemon E2E
[`../../../e2e/business-workgroup-scenarios.spec.ts`](../../../e2e/business-workgroup-scenarios.spec.ts)
会验证：

- 两个成员分别收到初始规划回合，任务轨使用 `wg_task_results` 逐卡结算；
- 成功卡各执行一次，失败卡恰好执行两次；
- 失败原因、恢复进展和最终收敛都进入工作组房间；
- 三份迁移实物确实存在于任务 worktree；
- 人工批准 completion gate 后任务才进入 `done`。

测试保留真实 HTTP、SQLite、调度器、Bun 子进程、隔离 Git worktree 和 merge-back；只有外部模型
替换为确定性、无网络 fixture。

## 预览和执行

默认只打印资源计划，不修改服务：

```bash
bun examples/workgroups/scenarios/business-operations.ts
```

创建缺失的资源。当前用户同名资源只有在 Agent 权限/提示词和 Workgroup 模式、成员、开关、
预算、人工门等完整场景契约一致时才会复用；Agent 的 runtime、输入输出、资源依赖和额外
frontmatter 也必须保持为空或默认值。检查时发现漂移会明确拒绝，既不覆盖也不启动错误场景：

```bash
AGENT_WORKFLOW_TOKEN='<token>' \
  bun examples/workgroups/scenarios/business-operations.ts --apply
```

显式增加 `--launch` 才会启动任务：

```bash
AGENT_WORKFLOW_TOKEN='<token>' \
  bun examples/workgroups/scenarios/business-operations.ts --apply --launch
```

`--launch` 会使用 daemon 当前配置的运行时，提示词可能发送给相应模型提供方。可以通过 `--url`
或 `AGENT_WORKFLOW_URL` 指向非默认服务。

当前公共启动 API 只对 Workgroup version 提供原子 fence，尚不能同时锁定成员 Agent 的内容
revision；因此检查完成后若有人并发修改 Agent，仍存在 check-to-launch 窗口。该边界已登记为
[`../../BUSINESS_SCENARIOS.md`](../../BUSINESS_SCENARIOS.md) 的 WG-03，后续架构设计需要在服务端
提供 closure revision/hash，而不是依赖客户端重复 GET。
