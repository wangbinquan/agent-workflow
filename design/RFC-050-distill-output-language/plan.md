# RFC-050 — 任务分解

整体一个 PR 即可（改动面较小：1 schema + 1 migration + 2 backend service +
3 前端组件 + i18n + 测试约 28 case）。如 review 要求拆分，按
**PR-A schema/migration/scheduler** + **PR-B prompt directive + 前端展示**
两段。

## 子任务

### RFC-050-T1 — shared schema
- `packages/shared/src/schemas/config.ts`：`ConfigSchema` 加
  `memoryDistillLang: LanguageSchema.optional()`；`DEFAULT_CONFIG` **不**
  填默认（运行时兜底 'en-US'）。
- 测试 +1 文件 `config-schema-memory-distill-lang.test.ts`（3 case）。
- 验收：`bun test packages/shared` 全绿，schema 测试覆盖三态。

### RFC-050-T2 — DB migration 0027
- 新 `packages/backend/src/db/migrations/0027_distill_job_output_lang.ts`：
  `ALTER TABLE memory_distill_jobs ADD COLUMN output_lang TEXT`；幂等
  （`PRAGMA table_info` 检测后再 alter）。
- `packages/backend/src/db/schema.ts`：`memoryDistillJobs.outputLang:
  text('output_lang')`（nullable）。
- 测试 +1 `migration-0027-distill-job-output-lang.test.ts`（3 case：
  新建库含列 / 老库迁移 / round-trip）。
- 验收：`bun test packages/backend/.../migration-0027` 全绿，老库迁移
  无破坏。

### RFC-050-T3 — scheduler & runDistill plumbing
- `memoryDistillScheduler.ts`：`enqueueDistillJob` 写入 `output_lang =
  config.memoryDistillLang ?? 'en-US'`；merge sibling 路径不覆盖。
- `memoryDistiller.ts`：
  - 新 `export const DISTILLER_OUTPUT_LANG_DIRECTIVE: Record<Language, string>`。
  - `buildDistillerUserPrompt` 加 `outputLang: Language` 参数，末尾
    append directive；`DISTILLER_SYSTEM_PROMPT` **字节级不动**。
  - `runDistill` 从 job 行读 `outputLang`（不读 config），透传给装配器。
- 测试 +2 文件：
  - `memory-distill-scheduler-output-lang.test.ts`（4 case）。
  - `memory-distiller-output-lang-directive.test.ts`（4 case）。
- 验收：`bun test packages/backend/.../memory-distill*` 全绿；既有
  RFC-041 / RFC-044 / RFC-043 distiller 测试零退化。

### RFC-050-T4 — source-layer grep guards
- 新 `memory-distiller-grep-output-lang-directive.test.ts`（4 case，
  纯静态 read of memoryDistiller.ts，无运行时）：
  - 包含两条 directive 字符串字面。
  - `buildDistillerUserPrompt` 函数体内 append directive（正则锁
    `userPrompt += DISTILLER_OUTPUT_LANG_DIRECTIVE`）。
  - `DISTILLER_SYSTEM_PROMPT` 体内不含 CJK 字符。
  - prompt 主体 SHA256 与 baseline 锁定 hash 一致（首次落地把当前
    hash 写进测试常量，未来改主体必须同步更新）。

### RFC-050-T5 — route & detail service
- `routes/memoryDistillJobs.ts`：detail GET response 增字段
  `outputLang: 'zh-CN' | 'en-US' | null`。
- `services/memoryDistillJobDetail.ts`：SELECT 新列透传。
- 测试 +1 `routes-memory-distill-job-detail-output-lang.test.ts`（2
  case）。
- 验收：RFC-043 既有详情页测试零退化。

### RFC-050-T6 — Settings UI
- 找到 Settings 页 Memory 区块（实际文件名以源码为准，可能在
  `components/settings/MemorySection.tsx` 或类似位置），按 CLAUDE.md
  前台界面统一风格原则**复用** `<Select>`（RFC-036） + `<Field>`
  （Form.tsx），新增 `Distill output language` 选项。
- 加 i18n keys（zh-CN.ts + en-US.ts）：
  - `settings.memoryDistillLang.label`
  - `settings.memoryDistillLang.help`
  - `settings.memoryDistillLang.opts.zh-CN`
  - `settings.memoryDistillLang.opts.en-US`
- 测试 +1 `settings-memory-distill-lang.test.tsx`（3 case）。

### RFC-050-T7 — distill 详情页 header
- `DetailHeader.tsx` 渲染新行 `Output language: <chip>`；null → `EN
  (default)`。i18n key `memory.distillJobDetail.outputLang.{label,default}`。
- 测试 +1 `distill-job-detail-output-lang.test.tsx`（2 case）。

### RFC-050-T8 — 审批队列 & All 列表的 lang chip
- `MemoryApprovalQueue.tsx`：候选卡片右上区加 `<LangChip
  lang={job.outputLang ?? 'en-US'} />`。
- `MemoryRow.tsx`：candidate 行展示 chip；approved / archived /
  superseded 行不展示。
- 复用既有 chip 样式或新增 `.lang-chip`（先扫一遍现有 chip 类，
  能复用就不要新增）。
- i18n key `memory.candidateRow.lang.{zh-CN,en-US}`。
- 测试 +1 `memory-approval-queue-lang-chip.test.tsx`（3 case）。

### RFC-050-T9 — i18n key 完备性
- 测试 +1 `i18n-distill-output-lang-keys.test.ts`（4 case：
  zh-CN bundle 含全部新 key / en-US 含全部新 key / key 数量一致 /
  无遗孤未引用 key）。

### RFC-050-T10 — STATE.md 收尾
- RFC-050 状态从 Draft → Done。
- `STATE.md` 顶部"进行中 RFC"行移除。
- 已完成 RFC 表加一行 RFC-050（与 P-X-XX 同等级）。
- commit message `feat(memory): RFC-050 distiller 输出语言可配置`。

## 依赖

- T1 → T2/T3/T6（schema 先落）。
- T2 → T3/T5（migration 先落）。
- T3 → T4/T5/T7/T8。
- T6/T7/T8/T9 可并行（前端展示彼此独立）。
- T10 在所有上面之后。

## 不在本 RFC 范围

- 已批准 / 已驳回 / 已归档存量记忆**不**回填、**不**翻译。
- 自动语言探测、混合输出、per-scope 语言均显式拒绝（见 proposal §非目标）。
- 下游 agent inject 阶段不做语言检测 / 兼容层（admin 用 RFC-045 手工
  改 / reject）。

## 验收清单

- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿。
- [ ] 既有 RFC-041 / RFC-043 / RFC-044 / RFC-045 / RFC-046 / RFC-047
      / RFC-048 / RFC-049 测试套件零退化。
- [ ] `DISTILLER_SYSTEM_PROMPT` SHA256 hash baseline 测试通过（说明
      主体守恒）。
- [ ] 手动跑一次 zh-CN job + 一次 en-US job（mock spawn 也可），断言
      候选 bodyMd 含相应语种代表字符。
- [ ] CI run 六 jobs 全绿，PR 描述附 CI run id。
- [ ] PR commit message 前缀 `feat(memory): RFC-050 …`。
