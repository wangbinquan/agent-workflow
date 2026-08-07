# RFC-264 · 任务分解

关联：[proposal.md](./proposal.md) · [design.md](./design.md)

**PR 拆分建议**：单 PR。改动面横跨 shared / backend / frontend，但只有一条语义（放宽名称规则）；拆开会让中间态出现"前端已放行、后端仍拒"的不一致窗口。commit 前缀 `feat(naming): RFC-264 工作流 / 工作组名称支持中文`。

依赖链：`T1 → (T2 ∥ T3 ∥ T4) → T5 → T6 → T7 → T8`。T5 与命名规则无依赖，可与 T2–T4 并行。

---

## T1 · shared：人类可读名规则（单一事实源）

- 新建 `packages/shared/src/schemas/resourceName.ts`：`RESOURCE_DISPLAY_NAME_MAX` / `normalizeResourceDisplayName` / `RESOURCE_DISPLAY_NAME_RE` / `RESOURCE_DISPLAY_NAME_MSG` / `ResourceDisplayNameSchema`（design §1）。
- `schemas/workgroup.ts:63-69`、`schemas/workflow.ts:351-365` 改为再导出别名，删掉本地正则与旧文案；`index.ts` 导出新模块。
- 新建 `packages/shared/tests/resource-display-name.test.ts`：design §6「shared」全部矩阵（字符集 / 归一化 / 幂等 / 码点计数 / 别名同一对象 / schema 归一化生效）。

**验收**：`bun run test` 内 shared 全绿；`WORKFLOW_NAME_RE === WORKGROUP_NAME_RE` 仍成立（`packages/frontend/tests/workflows-pages.test.tsx:235` 不改也绿）。

## T2 · backend：写入路径归一化 + 错误文案

- `services/workflow.ts:345` 在快照归一化中加入名称归一化（**先于** `:347` 取字节）；`:961-971` 错误文案改写，判据（`current === submitted` 早退）不变。
- `services/workflow.yaml.ts:104-114` 错误文案同步。
- 测试：`packages/backend/tests/workflows.test.ts` 增中文名 create / rename / 非法名 422；存量 grandfather 断言（`:358` 附近）不改判；YAML 导入中文名成功 + 含换行的名 422。

**验收**：中文名工作流可建可改可存；未改动的存量自由格式名照常保存。

## T3 · backend：副本名与代理对截断（含既有 bug 修复）

- `services/resourceCopyName.ts`：`normalizeCopyBase` 换用 RFC-264 归一化 + 去首尾 `-_` + 去前导 `_`；`copyCandidate` 的截断改 `[...base].slice(max).join('')`（design §2.2）。
- 新增 / 扩充 `packages/backend/tests/resource-copy-name.test.ts`：中文名 → `-copy` / `-copy-2`；**emoji 名在 128 上限附近截断不产出孤立代理项**，且结果能通过 `RESOURCE_DISPLAY_NAME_RE`。测试顶部注释写明它锁的是 UTF-16 `slice` 截断 bug。

**验收**：复制中文名工作流 / 工作组保留中文；emoji 名复制不再 500。

## T4 · backend：`/intent` 提示词

- `services/intent/intentDoc.ts:139` 的通用 `name` 规则拆成两条：workflow / workgroup 可用任意可读文本（跟随用户语言）；agent / skill / mcp / plugin 仍 `^[a-z0-9][a-z0-9_-]*$`。
- 测试：源码文本断言（提示词含新表述且仍声明 slug 规则）；一条 changeset 校验用例证明中文工作流名能通过 `CreateWorkflowSchema`。
- **不改** `applyChangeset.ts:227` / `resolveChangeset.ts:482` 的 `toLowerCase()` 占位判重（design §2.2 已登记理由）。

**验收**：中文提问时 AI 产出中文工作流名并能落库。

## T5 · frontend：选择器 ID 后缀消歧（用户拍板）

- `lib/resource-option-label.ts` 新增纯函数 `buildResourceOptionLabels`（design §4），`resourceOptionLabel` 本身不改。
- 接入五处：`routes/tasks.new.tsx:778-813`（工作流 / 工作组两处；代理列表同函数顺带受益）、`canvas/inspector/CallWorkflowEdit.tsx`、`canvas/inspector/CallWorkgroupEdit.tsx:134-140`、`workflow-editor/WorkflowStarterDialog.tsx:334`、`webhooks/TriggersPanel.tsx:781-790`。
- 新建 `packages/frontend/tests/resource-option-label.test.ts`：无撞车不加后缀 / owner 可区分不加后缀 / name+owner 全同各带 ID 后 6 位。

**验收**：重名候选在下拉里可分辨；不重名的下拉一个后缀都不多。

## T6 · frontend：表单校验、文件名、删除原生 pattern

- `lib/workflow-form.ts:31-35`、`lib/workgroup-form.ts:56-59` 改为先归一化再判（空 → `nameRequired`，正则不过 → `nameInvalid`）。
- `routes/workgroups.detail.tsx:625,1041` 改用共享校验；`:997,1030` 删 `namePattern`；`components/NameDescriptionFields.tsx` / `components/RenameDialog.tsx` 删失去调用方的 `namePattern` prop。
- `lib/workflow-draft-export.ts:21,38` 换 `safeDownloadBaseName`（design §3）。
- 测试：两个表单 helper 的矩阵（`'   '` → `nameRequired`）；`workflow-draft-export` 中文 / 含 `/` / 空兜底；源码层断言 `namePattern` 已从三个文件消失。

**验收**：UI 里能填中文名并保存；下载文件名保留中文。

## T7 · i18n 文案

- `i18n/zh-CN.ts` / `i18n/en-US.ts`：`workflows.fieldNameHint`、`workgroups.fieldNameHint`（**两者逐字一致**，`workflows-pages.test.tsx:826-830` 锁）、两处 `errors.nameInvalid`、`errors['workflow-name-invalid']`。
- 新文案不得出现 "URL" / "小写" / "lowercase"；描述新规则（支持中文、不能以 `_` 开头、最长 128 字符）。

**验收**：既有 i18n parity / key-resolution 测试全绿。

## T8 · e2e + 文档 + 索引

- e2e：中文名建工作流 → 重命名 → 列表 / 画布显示中文名（`e2e/workflow-editor.spec.ts` 或新 spec）。
- `docs/workflow-yaml.md`：若含命名规则表述则同步（`docs/agent.md` / `docs/skill.md` 属其它资源，**不动**）。
- `design/plan.md` 的「RFC 索引」加 RFC-264 条目；`STATE.md` 顶部加"进行中 RFC"指向本目录，完工后改 Done 并进已完成表。

**验收**：`bun run typecheck && bun run lint && bun run test && bun run format:check` 四门全绿；Playwright e2e 绿；推送后按 exact SHA 查 CI。

---

## 交付前清单

- [ ] proposal §6 的 AC-1..AC-13 逐条有对应测试
- [ ] proposal §5 的 B-1 / B-2 / B-3 三条行为变更已获用户确认（**RFC 批准即视为确认**）
- [ ] 存量名零迁移：无 migration 文件、无回填脚本
- [ ] 代理 / 技能 / MCP / 插件 / 运行时的命名规则一个字节未改（grep 确认）
- [ ] Codex 实现门（`docs/dev-gotchas.md` §Codex 的分离 worktree 姿势）跑完并修完 findings
