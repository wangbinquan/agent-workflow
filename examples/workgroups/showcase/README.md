# 混合工作组展示

这一目录提供三套通过公共 HTTP API 创建的真实工作组，以及各自对应的可启动任务：

- `showcase-governed-release-swarm`：Leader 先反问人类，再把研究、代码和测试分派给多个
  Worker；同一 Builder 可并行 fan-out，成员可发私信和公共消息，协议错误会重试，隔离
  worktree 会合并回任务工作区，最终完成门支持驳回、修订和批准。
- `showcase-open-collaboration-room`：无 Leader 的自由协作。成员并行规划，框架对近似任务去重，
  同时处理消息轨和任务轨，把多张卡批量交给成员执行并合并，机械收敛后进入人工完成门。
- `showcase-generated-delivery-dag`：内置编排器根据 Agent 能力生成 DAG；人类可驳回第一版并要求
  重生成，批准后由普通工作流引擎执行 `source.draft → reviewer.draft` 的类型化交接。

七个配套 Agent、三组定义和三条任务目标都在
[`seed.ts`](./seed.ts) 中。真实 daemon E2E
[`../../../e2e/workgroup-matrix.spec.ts`](../../../e2e/workgroup-matrix.spec.ts)
直接调用同一个种子，因此示例和已验证定义不会各自漂移。测试仍走真实 HTTP、SQLite 调度器、
Bun 子进程、隔离 Git worktree、merge-back、协议解析和人工门；只把外部模型替换成确定性、
无网络的 OpenCode fixture。

## 预览和落库

默认只打印计划，不修改服务：

```bash
bun examples/workgroups/showcase/seed.ts
```

创建缺失的 Agent 和 Workgroup（同名资源会复用，不覆盖用户修改）：

```bash
AGENT_WORKFLOW_TOKEN='<token>' \
  bun examples/workgroups/showcase/seed.ts --apply
```

显式增加 `--launch` 会再启动三条 scratch 任务：

```bash
AGENT_WORKFLOW_TOKEN='<token>' \
  bun examples/workgroups/showcase/seed.ts --apply --launch
```

`--launch` 会使用 daemon 当前配置的运行时，任务提示词可能发送给相应模型提供方；脚本因此不会
默认启动。可通过 `--url` 或 `AGENT_WORKFLOW_URL` 指向非默认服务。

## 预期人工交互

- Leader-worker 先进入 `awaiting_human`；回答发布策略后执行并进入 `awaiting_review`。第一次驳回
  应新增修订任务，第二次批准后结束。
- Free-collab 应并行产生计划、去重任务并完成批次，然后进入 `awaiting_review`；批准后结束。
- Dynamic-workflow 先展示生成图；驳回并要求加入 reviewer 后再次生成，批准第二版图才执行 DAG。

任务目标中的 `{{do_not_expand}}`、`{{fc_literal}}` 和 `{{dw_goal_literal}}` 是刻意保留的普通
文本，用于证明框架组合后的 goal 不会再被误当成工作流模板变量而静默删除。
