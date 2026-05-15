# RFC-001 Plan — 实施分解

> 状态：Draft（2026-05-15）
> 关联：[proposal.md](./proposal.md)、[design.md](./design.md)

## 任务分解

按依赖序列，建议单 PR 提交（后端 + 前端紧耦合，改动量 < 600 LoC）。

| 编号 | 标题 | 范围 | Size | Deps |
| --- | --- | --- | --- | --- |
| RFC-001-T1 | shared types & util | `packages/shared/src/schemas/runtime.ts` 新增 `OpencodeModel` / `RuntimeOpencodeStatus` 类型并 re-export | XS | — |
| RFC-001-T2 | backend util `opencode-models.ts` | spawn + 解析 + 内存缓存 + cache 失效；测试通过 stub 输入 | S | T1 |
| RFC-001-T3 | backend 路由 `routes/runtime.ts` + server.ts 挂载 | 两条 GET；错误处理；用 `e2e/fixtures/stub-opencode.sh` 扩 `models` 子命令做 routes 测试 | S | T1, T2 |
| RFC-001-T4 | frontend `RuntimeStatusCard.tsx` + i18n keys | 组件 + en-US/zh-CN runtimeStatus* 七条 key + 单测 | S | T3 |
| RFC-001-T5 | frontend `ModelSelect.tsx` + i18n keys | 组件 + 四条 model* key + 单测（mode derive / 列表分组 / refresh） | S | T3 |
| RFC-001-T6 | `routes/settings.tsx` 接线 | 在 RuntimeTab 插入两个组件，保存后 invalidate 状态卡 query | XS | T4, T5 |
| RFC-001-T7 | E2E 手工验证 + typecheck + test | 按 design §7.2 走流程 + `bun run typecheck && bun test` | XS | T1–T6 |

总计 ~1–1.5 个工作日。

## PR 拆分建议

**单 PR**。理由：

- 后端 util / 路由若单独先 merge，没有前端调用方，新代码进入未使用状态；
- 前端组件依赖后端接口，分两 PR 后第一 PR 会有 dead route；
- 改动总量可控（预计后端 ~150 LoC、前端 ~250 LoC、i18n ~20 行 × 2、测试 ~150 LoC）。

PR 标题建议：`feat(settings): RFC-001 runtime status card + model dropdown`。

## 验收清单

实现完成时必须满足：

- [ ] `design/RFC-001-runtime-status-and-model-select/` 三文档齐全
- [ ] `bun run typecheck` 全绿
- [ ] `bun test` 全绿（含新增 backend tests for runtime routes & opencode-models util）
- [ ] 浏览器手工 E2E 5 项断言全部通过（见 proposal §4）
- [ ] `STATE.md` 追加 RFC-001 条目
- [ ] `design/plan.md` 加入 RFC 索引指引
- [ ] commit + push 后 GitHub Actions 全绿（按 [[feedback_post_commit_ci_check]]）

## 风险跟踪

| 风险 | 兜底 |
| --- | --- |
| `opencode models --verbose` 在 1.14.0 上输出格式与较新版本有差异 | 解析容错：解析失败时该模型只保留 id/provider/modelID，前端 UI 仍可工作 |
| 测试机器没装 opencode 或装的版本不满足 `--verbose` 行为 | 沿用 `e2e/fixtures/stub-opencode.sh` 模式扩 stub，CI 用 stub 跑，不依赖真 opencode |
| 模型列表非常大（数百项） | 用 `<optgroup>` 分组 + 浏览器原生 `<select>` 性能没问题；后续如需搜索可再升级（不在 v1 范围） |

## 后续工作（非本 RFC）

- 节点级 model override 字段同样改成下拉（在 `NodeInspector` 中复用 `ModelSelect` 组件） —— 单独 issue。
- 把模型列表持久化到 SQLite，daemon 重启后秒出 —— v2 性能优化。
- 支持显示模型成本 / 上下文窗口元数据（已经在 verbose JSON 里）—— v2 UX 增强。
