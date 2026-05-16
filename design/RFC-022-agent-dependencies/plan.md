# RFC-022 Plan — 任务分解

> 状态：Draft（2026-05-16）
> 关联文档：[proposal.md](./proposal.md)、[design.md](./design.md)
> 编号规则：`RFC-022-T{n}`。Size：S = ≤ 2h / M = 0.5d / L = 1d。
> 单 PR 默认（commit message 前缀：`feat(agents): RFC-022 dependsOn …`）；如个别 T 改动量过大可考虑拆 PR，详见 §拆分建议。

## 任务清单

| ID         | 标题                                                | Size | Deps           | 关键产出                                                                              |
| ---------- | --------------------------------------------------- | ---- | -------------- | ------------------------------------------------------------------------------------- |
| RFC-022-T1 | Migration 0006 + shared schema dependsOn 字段       | S    | —              | `0006_agents_depends_on.sql` / `schemas/agent.ts` 新增字段 / 现有 agent fixture 默认 `[]` |
| RFC-022-T2 | `services/agentDeps.ts` 新模块                      | M    | T1             | `resolveDependsClosure` / `validateDependsOn` / `findAgentsDependingOn` + 单测            |
| RFC-022-T3 | `services/agent.ts` 接入 deps 守卫                  | M    | T2             | create/update 调 validateDependsOn；delete/rename 调 findAgentsDependingOn；4 测试         |
| RFC-022-T4 | `services/scheduler.ts` 闭包展开 + skills 并集     | M    | T2             | 节点 spawn + multi-process 子 shard 两处接入；2 测试                                       |
| RFC-022-T5 | `services/runner.ts` buildInlineConfig 改签名      | S    | T4             | 多 agent inline JSON + 32KB warn + 1 单测                                                |
| RFC-022-T6 | `services/workflow.validator.ts` 闭包扫描          | S    | T2             | 节点 agent 闭包内 agent/skill 引用校验；2 测试                                              |
| RFC-022-T7 | agent.md parser dependsOn 字段                     | S    | T1             | parser 识别 dependsOn；非数组兜底 frontmatterExtra；2 测试                                  |
| RFC-022-T8 | 前端 AgentForm "Depends on agents" chips           | M    | T1, T3         | 表单字段 + 候选 = 现有 agents \ self + 服务端错误回显 + 3 vitest                            |
| RFC-022-T9 | `<DependencyTree>` 共享组件 + `buildDependencyTree` 纯函数 | M | T2 | `components/agents/DependencyTree.tsx` + `lib/dependency-tree.ts` + styles.css `.dep-tree` 系列 + duplicateRef 不递归 + onNodeClick + 4 vitest |
| RFC-022-T10 | closure / closure-preview endpoints + AgentForm 接 preview + StatsTab 接 closure | M | T2, T8, T9 | `GET /api/agents/:name/closure` + `POST /api/agents/closure-preview`（preview 返 200+ok:false 不抖红）+ AgentForm debounce 200ms 调用 + cycle banner + StatsTab 渲染 tree + 3 backend + 3 frontend vitest |
| RFC-022-T11 | Playwright e2e A→B→C 闭包 case + 全套门槛           | S    | 全部           | `e2e/agent-depends-on.spec.ts` 含 "编辑表单可见 tree" + "Stats tab 可见同一 tree" 两断言；typecheck + test + format:check 全绿 |

合计 **11 个子任务**，预计 ~3.5 天（单人专注）。

## 关键依赖

```
T1 (migration + schema)
  ├─ T2 (agentDeps.ts)
  │   ├─ T3 (agent.ts guards)
  │   ├─ T4 (scheduler closure)
  │   │   └─ T5 (runner inlineConfig)
  │   ├─ T6 (validator)
  │   ├─ T9 (DependencyTree 组件 / 纯函数)
  │   └─ T10 (closure endpoints + AgentForm preview + StatsTab tree)
  ├─ T7 (agent.md parser)
  └─ T8 (AgentForm UI) ── 也需 T3 错误码到位
        └─ T10
              └─ T11 (e2e + 门槛)
```

T7 可与 T3 / T4 并行；T8 可在 T3 完成后立刻起手；T9 与 T2 并行（纯前端组件，不需 endpoint）；T10 等 T2 + T8 + T9 都到位。

## PR 拆分建议

默认**单 PR**（与 RFC workflow 默认一致）。

如果实际改动行数超过 ~800 行（实测 backend + frontend + tests 大概率 600–800），考虑拆成两 PR：

- **PR-A（backend + schema + tests）**：T1–T7 + 对应单测。后端独立可跑（API 加了字段、运行期可注入），UI 暂未暴露 dependsOn 编辑入口（沿用 frontmatterExtra 临时写入）。
- **PR-B（frontend + e2e）**：T8–T10。

实际拆与不拆等 T1–T7 完成后再评估。若一开始就明显超量，第一时间转拆。

## 验收清单（PR 落地前）

- [ ] `bun run typecheck` 全绿
- [ ] `bun run test` 全绿（含本 RFC 新增 backend ≥ 14、frontend ≥ 3）
- [ ] `bun run format:check` 全绿
- [ ] 手动验证：A→B→C agent 创建 → 保存 → 启 task → 节点详情看到 dependent agents
- [ ] 手动验证：环（A→B→A）保存时 400 + UI 红字 + cyclePath 正确
- [ ] 手动验证：删除被 dependsOn 引用的 agent 拒绝 + UI 列出引用方
- [ ] `design/plan.md` RFC 索引行状态从 Draft → In Progress（PR 起手时）→ Done（PR merge 后）
- [ ] `STATE.md` 顶部"进行中 RFC"指针在 PR 起手时加上 `RFC-022-agent-dependencies`，merge 后挪到"已完成"表（与 P-X-XX 同等级）
- [ ] GitHub Actions CI（含单二进制 build + Playwright e2e）按 [feedback_post_commit_ci_check] 推完立刻查

## 测试用例索引（与 design.md §6 同步）

backend 至少 17：

- T2: `agent-depends-on-save.test.ts`（C1, 4 测试）+ `agent-deps-find-depending-on.test.ts`（1 测试）
- T3: `agent-depends-on-cascade-guard.test.ts`（C2, 2 测试）
- T4: `scheduler-depends-closure.test.ts`（C3, 2 测试）+ `scheduler-skills-union.test.ts`（1 测试）
- T5: `runner-build-inline-config-multi.test.ts`（C4, 1 测试）
- T6: `workflow-validator-depends.test.ts`（C5, 2 测试）
- T7: `agent-md-import-depends-on.test.ts`（C6, 1 测试）
- T10: `agents-closure-endpoint.test.ts`（1 测试）+ `agents-closure-preview-endpoint.test.ts`（2 测试）

frontend 至少 10：

- T8: AgentForm chips 渲染 / 服务端错误回显（3 case）
- T9: `<DependencyTree>` 渲染（单层 / 多层 / duplicateRef 不递归 / onNodeClick）（4 case）+ `buildDependencyTree` 纯函数（1 case）
- T10: AgentForm debounce 调 closure-preview + tree 渲染 + cycle banner（3 case）+ StatsTab 渲染 closure tree（1 case）

e2e 1：

- T11: `e2e/agent-depends-on.spec.ts` A→B→C 主线，含编辑表单 tree 可见 + Stats tab 同 tree 可见两条 visual 断言
