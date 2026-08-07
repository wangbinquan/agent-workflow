# RFC-262 · 任务分解

单 PR（直接在 `main` 上小步提交，本仓不建分支）。任务按依赖排序，T1 → T3 是后端主链，T4 → T6 前端，T7 收文档与错误码。

## RFC-262-T1 · shared：字段 + 纯函数（前后端唯一事实源）

- `packages/shared/src/schemas/workflow.ts`：`UPLOAD_ON_CONFLICT` / `UploadOnConflictSchema` / `UploadInputSchema.onConflict`
- 新 `packages/shared/src/uploadNaming.ts`：`sanitizeUploadFilename`（自 `backend/services/upload.ts:99` 整体迁入，不留 re-export）、`normalizeUploadDir`、`uploadLandingKey`、`findDuplicateUploadTarget`
- `packages/shared/src/index.ts` 导出
- 测试：新 `packages/shared/tests/upload-naming.test.ts`（design §8 第 1–4 组）

依赖：无。

## RFC-262-T2 · backend：写盘覆盖分支 + 同批判重

- `services/upload.ts`：`UploadInputDef.onConflict`；`validateUploadPlan` 追加判重段；`applyUploadsToWorktree` 选名分叉（`lstat` → 目录报错 / unlink 换真实文件），其余路径逐字不动；`sanitizeFilename` 改为从 shared 导入
- `util/errors` 侧无需新增类型（沿用 `ValidationError` + 新错误码字符串）
- 测试：扩 `tests/upload-apply-to-worktree.test.ts`（存量断言不改判，导入路径随迁移更新）+ 新 `tests/rfc262-upload-overwrite.test.ts`（design §8 第 5–11、14 组，含 RFC-107 同款符号链接夹具）

依赖：T1。

## RFC-262-T3 · backend：透传与静态校验

- `services/launchMultipart.ts:166` `collectUploadInputDefs` 透传 `onConflict`
- `services/workflow.validator.ts:1628` 4d 段增 `upload-input-on-conflict-invalid`
- 测试：design §8 第 12–13 组

依赖：T1、T2。

## RFC-262-T4 · frontend：画布 inspector 编辑器

- `components/canvas/inspector/InputEdit.tsx`：`<Field>` + `.segmented` 两选项（改名 / 覆盖），走既有 `onPatch` + 撤销栈边界
- i18n：`inspector.upload.onConflict{,Hint,Rename,Overwrite}`（zh-CN + en-US 同步，类型形状一致）
- 测试：design §8 第 15、18 组（`getByRole` + 源码层锚）

依赖：T1。

## RFC-262-T5 · frontend：启动表单提示与拦截

- `components/launch/UploadPicker.tsx`：overwrite 定义下渲染覆盖提示行
- `routes/tasks.new.tsx:890` gating：接 shared `findDuplicateUploadTarget`，命中则禁用 Start + 内联错误（复用既有错误组件，不自拼）
- i18n：`launch.upload.overwriteHint` / `launch.upload.duplicateName`
- 测试：design §8 第 16–17 组

依赖：T1。

## RFC-262-T6 · e2e

- 新夹具 `e2e/fixtures/.../upload-input-overwrite.yaml`（沿用 `upload-input-roundtrip.yaml` 形状，加 `onConflict: overwrite`）
- `e2e/workflow-matrix.spec.ts`：预置仓内同名文件 → 启动 → 断言 packed 路径无 ` (1)` 且 worktree 内是上传内容（AC-11）

依赖：T2、T3。

## RFC-262-T7 · 文档与错误码文案

- i18n 错误文案（zh-CN + en-US）：`upload-duplicate-filename` / `upload-target-is-dir` / `upload-input-on-conflict-invalid`
- `docs/workflow-yaml.md:90,101`：upload 字段列 + 示例补 `onConflict`
- `services/intent/intentDoc.ts:154`：supported input forms 补 `onConflict?`
- `design/RFC-020-input-file-upload/design.md:215`：给"绝不覆盖"那条加勘误注记，指向本 RFC（存量断言的**语义**被 RFC-262 显式改判，按 CLAUDE.md 的改判记档规矩留痕）
- `design/plan.md` RFC 索引加 RFC-262 行；`STATE.md` 顶部加"进行中 RFC"行
- 测试：i18n key 完备性由既有 key 对齐测试覆盖（无新增用例）

依赖：T2–T6。

## RFC-262-T8 ·（可选）inspector 数字字段收敛到公共原语

`InputEdit.tsx:267/289/304` 三处原生 `<input className="form-input" type="number">` → 公共 `<NumberInput>`。纯风格收敛，与本 RFC 功能无关，做与不做由你定；若做则同 PR 内附一条渲染断言。

## 验收清单

提交前逐条勾：

- [x] AC-1…AC-12 全部有对应测试（design §8 编号 1–19）
- [x] 存量 `upload-apply-to-worktree.test.ts`「renames on collision」未改判
- [x] proposal §6 能力影响清单 C1–C4 已呈用户确认，C2 选定**方案 A**（大小写折叠）
- [x] `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿
- [ ] Codex 设计门（用户选择跳过，直接开工）+ 实现门（declare done 前，待跑）
- [ ] push 后按 exact SHA 查 CI（含单二进制 build smoke + Playwright e2e）
- [x] `STATE.md` 完工行 + `design/plan.md` 索引状态改 Done

## 落地记录（与计划的偏差）

- **T1 扩展**：`sanitizeUploadFilename` 迁入 shared 后**不留别名再导出**，backend 侧
  `upload.ts` 只 import 不 re-export，`upload-apply-to-worktree.test.ts` 里对应的
  4 条断言随函数一起迁到 `packages/shared/tests/upload-naming.test.ts`（单一归属，
  避免同一函数两处测试各自漂移）。
- **D6 收紧**：判重 key 的**目录段也折叠大小写**（不止文件名）。判据同 C2 方案 A——
  大小写不敏感 FS 上 `Docs/` 与 `docs/` 是同一个目录，不折叠就在高一层留下同样的
  静默丢文件洞。
- **T3 细节**：validator 读 `onConflict` 用**原值**而非 `readString`——后者对非字符串
  返回 `undefined`，会把 `onConflict: true` 这类脏值静默放行。
- **存量断言改判 1 处**：`rfc199-workflow-validation-targets.test.ts` 的 emission 棘轮
  128 → 129（新增 `upload-input-on-conflict-invalid`，带 strict workflow-input target），
  并在测试内注明来源。
- **T8（可选）未做**：`InputEdit.tsx` 三处原生 number input 收敛到 `<NumberInput>` 仍
  待办，与本 RFC 功能无关，留给下次触及该文件时顺手做。
