# Workflow end-to-end catalog

这组 YAML 不是伪造的调度器对象，而是通过公开
`POST /api/workflows/import` 导入、通过精确 revision 校验、再由真实 daemon、
SQLite、scheduler 和 OpenCode 测试桩执行的工作流。

配套测试是 [`e2e/workflow-matrix.spec.ts`](../../../e2e/workflow-matrix.spec.ts)。
测试启动时会创建这些 YAML 引用的 `matrix-*` agent，因此文件可以保持可移植的
`agentName` 引用，不包含安装相关的 `agentId`。

## 覆盖矩阵

| 文件                                    | 预期结果                       | 主要覆盖                                                                                    |
| --------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------- |
| `prompt-input-kinds.yaml`               | done                           | text/files/enum/git、显式替换、未引用输入自动附加、内建变量、字面量 token 不递归展开        |
| `upload-input-roundtrip.yaml`           | done                           | multipart upload、落盘后路径打包、必填/数量约束、prompt 注入                                |
| `output-kinds-roundtrip.yaml`           | done                           | string、markdown、path、三类 list、signal 的 envelope 解析、归一化和 output 投影            |
| `linear-fan-in.yaml`                    | done                           | 并行根节点、同端口 fan-in、确定性拼接、下游调度与最终 output                                |
| `wrapper-git-change-set.yaml`           | done                           | 外部输入到 wrapper 内节点、tracked/untracked 变更、`git_diff` 路径列表、下游消费            |
| `wrapper-git-noop.yaml`                 | done                           | 内部成功但无文件变化时，wrapper 以空 diff 正常结束                                          |
| `wrapper-loop-port-empty.yaml`          | done / 2 轮                    | `port-empty`、迭代行、loop outputBindings                                                   |
| `wrapper-loop-port-equals.yaml`         | done / 2 轮                    | `port-equals`                                                                               |
| `wrapper-loop-port-count-lt.yaml`       | done / 2 轮                    | `port-count-lt` 与自定义阈值                                                                |
| `wrapper-fanout-aggregate.yaml`         | done、empty done 或 fail-all   | list 分片、broadcast、重复值稳定 shard key、join、失败汇合、aggregator、output rename       |
| `wrapper-git-around-fanout.yaml`        | done                           | Git → Fanout；全部 shard 文件变更先合并，再由外层 Git 计算一次 diff                         |
| `wrapper-loop-around-fanout.yaml`       | done / 2 轮                    | Loop → Fanout；每轮新 generation、broadcast 输入、只用当前 generation 判定退出并提升输出    |
| `wrapper-loop-around-git.yaml`          | done / 2 轮                    | Loop → Git；每轮独立 diff，loop 只提升最后一轮                                              |
| `wrapper-git-around-loop.yaml`          | done / 2 轮                    | Git → Loop；git 捕获整个循环的累计 diff                                                     |
| `mixed-wrapper-human-roundtrip.yaml`    | human → review → review → done | Git → Loop 内 clarify+驳回重审；已澄清决定折叠进 prior output，再 fanout 审计并最终人工批准 |
| `wrapper-loop-review.yaml`              | awaiting_review → done         | 人工态上浮、approve resume、reject reason + prior output 注入、重跑后再次 approve           |
| `clarify-self-roundtrip.yaml`           | awaiting_human → done          | `clarify`、问题封存、stop ask-back、提问 agent 带 Q&A 重跑                                  |
| `clarify-cross-agent-roundtrip.yaml`    | awaiting_human → done          | `clarify-cross-agent`、默认仅 asker 重跑、designer 不被隐式重跑                             |
| `runtime-lifecycle.yaml`                | done / failed / cancelled      | fresh-session retry、永久失败耗尽、全局节点 timeout、运行中 cancel、禁止失败输出投影        |
| `wrapper-loop-exhausted.yaml`           | failed                         | maxIterations 用尽、wrapper `exhausted` 终态                                                |
| `wrapper-fanout-unsupported-inner.yaml` | importable / launch rejected   | fanout 体内放 wrapper 在校验期即拒（RFC-354 `wrapper-fanout-unsupported-inner-kind`）       |
| `wrapper-loop-nested.yaml`              | done                           | loop-in-loop（RFC-354：嵌套即递归，帧 `container_run_id` 隔离每一轮）                       |

## 状态空间

- 节点：覆盖当前全部 9 种节点类型：`input`、`output`、`agent-single`、
  `wrapper-git`、`wrapper-loop`、`wrapper-fanout`、`review`、`clarify`、
  `clarify-cross-agent`。
- 启动输入：覆盖 `text`、`files`、`enum`、`git`、`upload` 五种输入，以及
  required、未知 key、长度、数量、枚举选项、multi-select JSON 和 Git 子类型校验。
- Agent 输出：覆盖 `string`、`markdown`、`path<md>`、`list<string>`、
  `list<markdown>`、`list<path<md>>`、`signal` 七类线格式及任务输出投影。
- DAG：覆盖单根、多根并行、fan-in、空分片、重复分片值、单分片失败后 join、
  下游阻塞和包装器边界边。
- 人工状态：覆盖 `awaiting_review`、拒绝后重跑、再次审批，
  `awaiting_human`、self/cross-agent 问答恢复，以及旧 Q&A 被有意淘汰后，已澄清决定
  通过 prior output 与 review 驳回意见共同驱动 Agent 重跑。
- 运行终态：覆盖 `done`、`failed`、`cancelled`、timeout、重试成功、
  重试耗尽与 loop exhausted。

## Prompt 内容注入

这里测试的是功能语义，不是安全攻击：输入内容在正确的调度时刻、以正确的
上下文进入正确节点。

- `{{port}}` 只替换显式引用；已替换端口不会再被自动附加。
- 已连入但模板未引用的输入，会作为结构化输入段自动附加一次。
- `__task_id__`、`__node_id__`、`__iteration__`、`__repo_path__` 和
  `__repo_count__` 在运行时填充。
- 用户值中的 `{{looks_like_a_token}}` 保持字面量，不会发生第二轮模板展开。
- Review 拒绝时，拒绝原因与上一版输出只进入允许重跑的节点；clarify 的 Q&A
  只触发约定的 asker 路径。

## 本地运行

```sh
bun run build:binary:e2e
bun run e2e e2e/workflow-matrix.spec.ts
```

单独导入任一 YAML 时，需要先创建同名 `matrix-*` agent。文件中的
`MATRIX_*` prompt marker 只用于确定性测试桩分流；工作流的节点、边、边界、
输出提升与包装器结构都是生产格式。

测试桩只替代 OpenCode/模型进程的非确定性输出。导入、revision fence、启动
输入校验、HTTP/multipart、SQLite 持久化、scheduler、隔离工作树、wrapper
generation/shard、review/clarify 恢复、retry/timeout/cancel 和输出投影都走
生产实现。

## 当前包装器边界

- `wrapper-git` 只对外暴露框架生成的 `git_diff: list<path<*>>`，内部 agent
  的任意输出不能直接穿透包装器。
- `wrapper-loop` 支持 `port-empty`、`port-not-empty`、`port-equals` 和
  `port-count-lt`；跨轮状态通过工作树文件传递，不存在反馈端口。
- `wrapper-fanout` 当前运行时只调度内部 `agent-single`，其中至多一个
  `role: aggregator`。其他内部节点类型会 fail closed。
- wrapper containment 必须是一棵树。一个节点不能属于两个父包装器，且
  loop-in-loop 当前被静态校验拒绝。

| 父 → 子               | 当前结果 | 对应定义                                |
| --------------------- | -------- | --------------------------------------- |
| Git → Loop            | 支持     | `wrapper-git-around-loop.yaml`          |
| Loop → Git            | 支持     | `wrapper-loop-around-git.yaml`          |
| Git → Fanout          | 支持     | `wrapper-git-around-fanout.yaml`        |
| Loop → Fanout         | 支持     | `wrapper-loop-around-fanout.yaml`       |
| Fanout → 任意 wrapper | 静态拒绝 | `wrapper-fanout-unsupported-inner.yaml` |
| Loop → Loop           | 支持     | `wrapper-loop-nested.yaml`              |
