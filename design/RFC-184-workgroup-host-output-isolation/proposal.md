# RFC-184 工作组 host 轮输出隔离——leader/worker 只认 wg 协议端口

> 产品视角。技术设计见 [`design.md`](./design.md)，任务分解见 [`plan.md`](./plan.md)。

## 背景

线上任务 `01KXFE9668F0TJ7D2P720F42SE`（名 "UUU"，工作组 `test`、`leader_worker`、全自动）在**第一轮 leader 就秒挂**，`error_summary="workgroup leader turn failed"`、`error_message="port-validation-path-empty-path: path port content must be a worktree-relative path, got empty string"`。

排查结论（代码级确认，见 design.md §1）：

- 工作组 host 轮（leader / worker / fc_member）**复用成员的真实 agent**（`resolveMemberAgent` → `getAgent`，`workgroupRunner.ts:837`），连它自己声明的 `outputs` / `outputKinds` 一起原样喂进通用 `runNode`。
- 本次 leader = agent `coder`，它声明了自己的业务输出 `outputs=["software_design","test_design"]` 且 `outputKinds` 两者都是 `markdown_file`（`agents.frontmatter_extra`）。
- leader 按工作组协议**正确**只产出 `wg_assignments` + `wg_decision`（协调不写代码），于是它自己的 `software_design` / `test_design` 被 `parseEnvelope` 补成空串（`envelope.ts:381-384`），RFC-049 即时逐端口校验（`runner.ts:1323-1346`）对空串按 `markdown_file`(=`path<md>`) 校验失败（`shared/outputKinds/path.ts:104`）→ leader 轮 failed → `reportFatal('workgroup leader turn failed')`（`workgroupRunner.ts:899-900`）→ 整个任务挂。

**这不是个例，是 leader_worker 派发这条路整体没跑通**：DB 里 6 个工作组任务全部 `failed`/`interrupted`、**0 个 done**；唯二到 `dispatched` 的 assignment 都是人类手动 `@coder` 建的（`created_by_user_id` 有值），没有一次是 leader 真正派发成功。之所以一直没暴露，是因为工作组引擎测试全部 stub 掉了 `runHostNode`（`rfc164-workgroup-engine.test.ts:170` 直接返回假 outputs），真实 `runNode` 路径从未被 e2e 覆盖（测试自己在 733-734 行承认这点）。

## 问题的两层

即使修掉空串校验，还有第二层：`runNode` 的 `result.outputs = Object.fromEntries(parsed.ports)`（`runner.ts:1268`）**只保留 agent 声明端口**，而 wg 端口对 `coder` 是"未声明端口"→被直接丢弃→workgroupRunner 会改报 "missing required port wg_decision"。所以只要 leader/worker agent 声明了自己的 outputs，这个组就 dispatch 不了。两层必须一起解。

## 目标

1. 工作组 host 轮的**输出契约 = 纯 wg 协议端口**，与成员 agent 自己声明的业务 `outputs`/`outputKinds` 彻底解耦。
2. 让 leader/worker/fc_member 三类 host 轮都能把 `wg_*` 端口正确回传给引擎（解掉第二层"端口被丢弃"）。
3. 让成员 agent 声明的 `markdown_file` / `path<…>` / `list<path>` 等业务输出 kind **不再**在工作组轮里触发校验（解掉第一层"空串校验挂 leader"）。
4. 补上真实 `runNode` 路径的回归锁，堵住"引擎测试 stub 掉 host 轮 → 真实路径裸奔"的缺口。

## 非目标

- **不改** RFC-049 逐 kind 校验对**普通工作流节点**的行为（普通节点漏产出 `markdown_file` 端口仍应是硬错误）。
- **不捕获**成员 agent 自己声明的业务端口：工作组轮里成员写的 `software_design.md` 等文件仍随 iso worktree 合并保留（平台"diff 即产物"语义不变），但它声明的 `software_design` **端口**在工作组内不解析、不校验、不入库（用户 2026-07-14 拍板"完全忽略"）。
- **不动** `dynamicWorkflowRunner` 的编排生成 host 轮（RFC-167）——它用受控 builtin 编排 agent，本 RFC 的机制留成可选开关，暂不为它接线（见 design.md §6 失败模式）。
- 无 schema / migration / 前端改动。

## 用户故事

- 作为发起人，我把一个声明了自己 `outputs`（比如 `coder` 产 `software_design.md`）的 agent 设为工作组 leader，启动后 leader 能正常拆解目标并派发 assignment，而不是第一轮就以 `port-validation-path-empty-path` 秒挂。
- 作为 worker（同样声明了业务 outputs 的 agent），我被派到一个 assignment，能正常产出 `wg_result` 汇报，而不会因为没产出自己的 `test_design` 端口被判协议违规。
- 作为维护者，当我改动 host 轮的输出解析时，有一条走真实 `runNode` 的回归测试立刻变红，而不是被 stub 掩盖。

## 验收标准

1. **正向（leader）**：leader agent 声明了 `outputKinds:{x:markdown_file}`，其 host 轮只产出 `wg_assignments`+`wg_decision` 时，run 结束为 `done`、`result.outputs` 含 `wg_decision`/`wg_assignments`、**无** `port-validation-*` 错误，assignment 正常落库。
2. **正向（worker / fc_member）**：worker 只产出 `wg_result`（fc_member 另可产 `wg_tasks_add`）时同上，不因漏产 `wg_messages` 等可选端口被判协议违规。
3. **可选端口语义保持**：leader 漏产 `wg_decision`（必填）仍报 "missing required port wg_decision"；漏产 `wg_messages`/`wg_assignments`（可选）不报错、按空处理。
4. **业务端口忽略**：host 轮里成员 agent 声明的业务端口不入 `node_run_outputs`、不触发任何 kind 校验。
5. **host 轮零 output 行**（设计门 P1）：host 轮成功后 `node_run_outputs` 该 run **零行**，保持今日不变式——clarify 老化不因残留 output 行把"信封合法但 wg 语义非法"的违规重试误判为"已产出"而老化掉已答 Q&A。
6. **普通节点零回归**：非工作组节点漏产 `markdown_file` 端口仍以 `port-validation-path-empty-path` 失败（既有行为不变）；普通节点持久化照旧。
7. **回归锁**：新增一条走真实 `runNode`（非 stub hook）的测试，覆盖验收 1/2/3/5；并有源码文本锁保证 host 轮调用点应用了输出投影 + persist 守卫。
8. `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；CI 三项 + 单二进制 smoke + e2e 全绿。
