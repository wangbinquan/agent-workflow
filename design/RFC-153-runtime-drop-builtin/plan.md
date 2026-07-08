# RFC-153 任务分解 — 取消 runtime 内置区分

## 子任务

### RFC-153-T1 — 迁移 + schema + 类型

- migration **0078** rebuild 删 `runtimes.builtin`（12-step，参照 0072）；更新 `_journal.json`
  （77→78）。
- `schema.ts`：删 `builtin` 列（:103）+ 更新表注释（:90-91 去掉「builtin=1, RFC-104 read-only」）。
- `runtimeRegistry.ts`：`RuntimeRow` / `RuntimeView` / `runtimeRowToView` 删 builtin 字段 + 映射。
- **测试**：迁移 rebuild 保数据 + builtin 列消失；`upgrade-rolling` journal 77→78 + 注释计数 bump。
- 依赖：无。

### RFC-153-T2 — 服务行为

- 删 `assertNotBuiltinRuntime` + `deleteRuntime` 内的调用（保留 `findRuntimeReferences`）。
- `validateName` 删 `BUILTIN_NAMES.has` 保留名 check（解除保留名）。
- `createRuntime` 删 `builtin: false`。
- `seedBuiltinRuntimes` 改「整表为空才插入两行，非空 no-op」，删 identity-reset 分支。
- `assertConfigDefaultsMigrated` 改按真正的协议默认行查（`name in BUILTIN_NAMES ∧ protocol === name`）。
- **设计门 F1**：`findRuntimeReferences` 的 `isDefault` 折叠 effective default（`?? 'opencode'`）。
- **设计门 F2**：`migrateConfigIntoBuiltins` backfill 加 protocol 校验（仅协议匹配才写）。
- **测试**：seed 空表建 / 非空 no-op（含删过预置行）；删除预置 runtime 成功 / 被引用 409；
  保留名解除后可创建同名；model freeze → inline config 端到端（呼应用户原问）；**F1** 删
  opencode（default unset）→ 409；**F2** 撞名异协议行不被 backfill；**F3** 撞名行不污染守卫。
- 依赖：T1（类型）。

### RFC-153-T3 — 前端 + i18n

- `RuntimeList.tsx`：删 `RuntimeView.builtin`、「内置」徽章、删除按钮 `!rt.builtin` 门槛、
  相关注释。
- i18n：删 `runtimes.builtin`（en-US:632 / zh-CN:3123 + 类型 :741）。
- **测试**：RuntimeList 无「内置」徽章、删除按钮对预置行显示、RuntimeView 无 builtin。
- 依赖：T1（GET 响应 shape）。

### RFC-153-T4 — 测试翻转 + 边界锁 + 收口

- 翻转 `runtime-registry.test` / `runtime-routes-registry.test` 的 builtin 断言（delete
  403→200、identity-reset→空表语义、`.every(builtin)` 删）。
- 补 model 端到端回归 + 保留名解除回归。
- 确认 `rfc104-builtin-readonly.test`（agents / workflows）零回归（边界锁）。
- STATE.md / design/plan.md 索引收口，状态 Draft→Done。
- 依赖：T1-T3。

## PR 拆分

默认**单 PR**（改动跨层但同属「删除一个概念」，聚焦）。commit 前缀
`feat(runtime): RFC-153 取消内置区分——删 builtin 列/徽章/保留名/补种`。若 T1 迁移希望
先行落库，可拆为「T1 迁移+schema」+「T2-T4」两 PR。

## 依赖与并行注意

- migration 取下一可用号（提交前核对 `_journal.json` 末尾，避与并行 G4-G10 撞号；G4-G10 也
  可能加迁移）。
- 与 STATE.md「G3-G10 批量重构」队列并行——[记忆 dont-delete-others-code-for-ci /
  shared-index-commit-race]：只 `git add` 本 RFC 精确路径，不碰他人 runtime 文件；共享索引
  （plan.md / STATE.md）用一步 `git commit -- <paths>`。

## 验收清单

- [ ] `builtin` 列 / 字段 / 徽章 / 保留名 / 只读守卫 / 补种全清
- [ ] 内置可删（引用保护保留）、删了不补种、空表首建
- [ ] model 端到端传递不变（呼应用户原问）
- [ ] RFC-104 agents/workflows 边界零回归
- [ ] `resolveRuntimeByName` 协议名兜底保留（dispatch 不 brick）
- [ ] `bun run typecheck && bun run test && bun run format:check` + lint（max-warnings 0）+
      binary smoke 全绿
- [ ] Codex 设计门 + 实现门 clean
- [ ] 推送后查 GitHub Actions（[记忆 post-commit-ci-check]）
