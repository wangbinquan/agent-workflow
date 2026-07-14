# RFC-184 任务分解——工作组 host 轮输出隔离

> 承接 [`proposal.md`](./proposal.md) / [`design.md`](./design.md)。单 PR，零 migration。

## PR 拆分

单个 PR：`fix(workgroup): RFC-184 host 轮输出隔离——leader/worker 只认 wg 协议端口`。改动集中在 3 个后端文件 + 1 个测试文件，互相耦合紧、不宜拆。

## 子任务

### RFC-184-T1 —— 角色→端口映射纯函数 + 一致性锁
- 在 `packages/shared/src/schemas/workgroupRuntime.ts` 新增并导出 `wgHostRolePorts(role: WorkgroupProtocolRole): string[]`，返回 design.md §2.1 的三张端口列表（复用 `WG_PORT_*` 常量，勿硬编码字面量）。
- `packages/shared/src/index.ts` 若需 re-export 则补上（对齐既有 WG 导出习惯）。
- 依赖：无。

### RFC-184-T2 —— host 轮投影 + 空串过滤 + persist 守卫（scheduler + runner）
- `WorkgroupHostRunRequest`（`workgroupRunner.ts` hooks 接口）新增 `hostOutputPorts?: string[]`。
- `RunNodeOptions`（`runner.ts`）新增 `persistDeclaredOutputs?: boolean`（默认 `true`）；持久化块（`runner.ts:1382`）守卫为 `if (status === 'done' && opts.persistDeclaredOutputs !== false)`。**唯一** runNode 核心改动，解析/校验/信封不动。
- scheduler `runHostNode`（`scheduler.ts:655`）：
  - 调 `runNode` 前构造投影 agent `{...req.agent, outputs: req.hostOutputPorts, outputKinds: undefined}`（`hostOutputPorts===undefined` 时用原 agent）；传 `persistDeclaredOutputs: req.hostOutputPorts !== undefined ? false : undefined`；`prepareNodeRunInjection` 仍传**原** `req.agent`。
  - 抽局部 `projectOutputs(outputs)`：`hostOutputPorts` 存在时 `filter(([,v]) => v !== '')`，否则原样；作用于 `:930` 与 `:968` 两处 `{status:'done', outputs}`。
- 依赖：T1。

### RFC-184-T3 —— 三处调用点接线（workgroupRunner）
- leader（`:990`）、assignment（`:1195`）、message（`:1350`）三处 `hooks.runHostNode({…})` 补 `hostOutputPorts: wgHostRolePorts(role)`，`role` 取值与同处 `renderWgProtocolBlock(role,…)` **完全一致**（leader / `free_collab?fc_member:worker`）。
- 依赖：T1、T2。

### RFC-184-T4 —— 测试（随 T1-T3 落，不单独排期）
- 新建 `packages/backend/tests/workgroup-host-output-isolation.test.ts`（顶部注释链接本 RFC + F42SE 事故 `01KXFE9668F0TJ7D2P720F42SE`）：
  - `wgHostRolePorts` 三 role 端口断言 + "映射表 ⟺ `renderWgProtocolBlock` grep 端口集"一致性断言。
  - `projectWgHostAgent`（若抽出）字段保留断言。
  - runNode 真实路径 **红→绿对照**（design.md §6）：不投影→`port-validation-path-empty-path` 失败；投影→`done` 且 outputs 含 wg 端口无校验错。
  - 可选端口漏产语义（`projectOutputs` 纯函数单测 or 集成断言）。
  - **§2.4 persist 守卫锁**：投影 + `persistDeclaredOutputs:false` → 该 run `node_run_outputs` 零行；缺省则落库行数>0（证明守卫只作用 host 轮）。
  - 源码文本锁：三处 `hostOutputPorts` + scheduler 投影/过滤/`persistDeclaredOutputs:false` + runner 持久化块 `!== false` 守卫存在。
- shared 侧纯函数测试放 `packages/shared`（注意 shared 测试不在 CI 的 `bun test` root，按既有 shared 测试惯例落位）。
- 依赖：T1-T3。

## 验收清单（对齐 proposal §验收标准）
- [ ] leader/worker/fc_member host 轮：声明业务 outputKinds 的 agent 只产 wg 端口 → `done`、无 `port-validation-*`、assignment 落库（AC1/AC2/AC4）。
- [ ] 必填 `wg_decision` 漏产仍报 "missing required port wg_decision"；可选端口漏产不报错（AC3）。
- [ ] 普通工作流节点漏产 `markdown_file` 端口仍 `port-validation-path-empty-path`（AC5，零回归）。
- [ ] 真实 `runNode` 回归锁 + 源码文本锁到位（AC6）。
- [ ] `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；单二进制 smoke 不受影响；CI + e2e 绿（AC7）。
- [ ] Codex 设计门（批准前）+ 实现门（declaring done 前）各跑一次并折入 findings。

## 收尾
- `design/plan.md` RFC 索引状态 Draft→Done。
- `STATE.md` 顶部"进行中 RFC"行移除 / 已完成表加一行。
- commit + push 后按 [feedback_post_commit_ci_check] 立刻查 CI。
