# RFC-050 — Distiller 输出语言可配置（技术设计）

## 设计要点

1. **System prompt 主体保持英文不变**——指令 / categories / 拒绝规则 /
   envelope 形态全部沿用现有 `DISTILLER_SYSTEM_PROMPT` 常量，字节级守恒，
   `memory-distiller.test.ts` 既有 grep 守卫零退化。
2. **新增一段"输出语言指示语"**，由 user prompt 装配器在末尾追加。
   两条候选文案（English 默认 / 中文），写在 `memoryDistiller.ts` 顶部
   导出常量 `DISTILLER_OUTPUT_LANG_DIRECTIVE`，按 `outputLang` 查表：
   - `'en-US'` →
     `"Emit candidates' \`title\` (after the [category:xxx] prefix) and \`bodyMd\` in English. The category prefix itself remains lowercase ASCII (e.g. [category:invariant])."`
   - `'zh-CN'` →
     `"候选记忆的 \`title\`（[category:xxx] 前缀之后部分）与 \`bodyMd\` 用简体中文输出。\`[category:xxx]\` 前缀本身保持小写 ASCII（如 [category:invariant]），不要翻译。"`
3. **配置入口**：`ConfigSchema` 新增
   `memoryDistillLang: LanguageSchema.optional()`（复用 RFC-025 的 enum，
   仅 `'zh-CN'` / `'en-US'` 两值；`undefined` ≡ `'en-US'` 字节级保 RFC-041
   baseline）。`DEFAULT_CONFIG` 显式留空（不设默认值），由 distiller
   层负责 fallback；这样既有 settings 文件不需 migration。
4. **scheduler 透传**：`memoryDistillScheduler.ts` 在 dispatch 阶段
   `config.memoryDistillLang ?? 'en-US'` 写到新创建的 `memory_distill_jobs.output_lang`
   列（migration 0027 加 nullable text 列；老行 NULL，运行时 SELECT
   时 `null` 走 `'en-US'` 兜底，与"未设置 ≡ 英文"语义一致）。
5. **runDistill** 不读 config，只读 job 行的 `output_lang`——保证
   retry / supersede 路径与首发批次语言一致，即使 admin 中途切换设置，
   同一 job 的多次 attempt 也不混语言。
6. **持久化候选语言**：候选记忆行**不**新增 lang 列；候选 → 审批
   场景里直接 join `memory_distill_jobs.output_lang` 拿语言；approved
   后 memory 行成为独立实体，不再追踪生成语言（admin 已确认这条
   设计取舍：approved 记忆是"事实"，不该再追溯产出来源的设置）。
7. **前端展示**：
   - Settings → Memory 区块加 `<Select>`（RFC-036 公共 Select），label
     i18n key `settings.memoryDistillLang.label`，options 用 i18n
     `settings.memoryDistillLang.opts.zh-CN` / `.en-US`，置于
     `memoryDistillModel` 下方。
   - 审批队列卡片 / All 列表行：候选行 join job.output_lang 后渲染
     `<Chip>` 显示 `EN` / `中`（不展开全名以省空间）。已 approved /
     archived / superseded 行**不**展示 chip（拿不到 job 行）。
   - distill 详情页（RFC-043）`DetailHeader` 加一行
     `Output language: zh-CN / en-US`（pure read 新列）。
8. **prompt 末尾指示语守恒**：源码层 grep 守卫锁两件事：
   - `memoryDistiller.ts` 必须含 `DISTILLER_OUTPUT_LANG_DIRECTIVE`
     map 的两条字面字符串（任何文案改动必走 PR + RFC follow-up）。
   - `buildDistillerUserPrompt` 末尾必须 append 该 directive，禁止
     在 system prompt 里偷渡语言指示（保证 RFC-041 主体守恒）。

## 数据流

```
[Settings UI] --PATCH /api/config { memoryDistillLang: 'zh-CN' }-->
   ConfigSchema --persist--> config.json
                                   |
[Scheduler tick] read config.memoryDistillLang
   |
   v
INSERT memory_distill_jobs (..., output_lang='zh-CN')
   |
   v
[runDistill] SELECT job.output_lang -> renderUserPrompt(..., outputLang)
   |
   v
userPrompt + appended DISTILLER_OUTPUT_LANG_DIRECTIVE[outputLang]
   |
   v
opencode child -> XML envelope -> candidates (bodyMd in zh-CN)
   |
   v
INSERT memories (status='candidate', no lang column)
   |
   v
[Approval queue] SELECT memories LEFT JOIN distill_jobs ON job_id
   ... renders <LangChip lang={job.output_lang ?? 'en-US'} />
```

## 与现有模块的耦合点

| 文件 | 改动 |
|---|---|
| `packages/shared/src/schemas/config.ts` | `ConfigSchema` 新字段 `memoryDistillLang` 复用 `LanguageSchema`；`DEFAULT_CONFIG` 不写默认值，由 distiller 层 fallback |
| `packages/backend/src/db/migrations/0027_distill_job_output_lang.ts`（新） | `ALTER TABLE memory_distill_jobs ADD COLUMN output_lang TEXT` nullable |
| `packages/backend/src/db/schema.ts` | `memoryDistillJobs.outputLang: text('output_lang')` |
| `packages/backend/src/services/memoryDistillScheduler.ts` | `enqueueDistillJob` insert payload + `runJob` 不读 config，只读 job 行 |
| `packages/backend/src/services/memoryDistiller.ts` | 新 const `DISTILLER_OUTPUT_LANG_DIRECTIVE`；`buildDistillerUserPrompt` 接 `outputLang` 参数，append directive 到末尾 |
| `packages/backend/src/services/memoryDistillJobDetail.ts` | SELECT 新列，返回给详情页 |
| `packages/backend/src/routes/memoryDistillJobs.ts` | 详情 response schema 加 `outputLang` |
| `packages/frontend/src/components/memory/distill-job-detail/DetailHeader.tsx` | 渲染新行 |
| `packages/frontend/src/components/memory/MemoryApprovalQueue.tsx` | 候选卡片加 LangChip |
| `packages/frontend/src/components/memory/MemoryRow.tsx` | All 列表行的 chip（仅 candidate 行展示） |
| `packages/frontend/src/components/settings/MemorySection.tsx`（既有，名字以源码为准） | 加 Select |
| `packages/frontend/src/i18n/{zh-CN,en-US}.ts` | 新 keys：`settings.memoryDistillLang.{label,help,opts.zh-CN,opts.en-US}` + `memory.candidateRow.lang.{zh-CN,en-US}` |
| `packages/frontend/src/styles.css` | `.lang-chip` 命名空间（如已有可复用现有 chip 样式则不新增） |

## 失败模式

- **设置中途切换**：通过"job 行落库自己的 outputLang"隔离——同 job
  retry 不混语言。
- **存量 job 行 `output_lang IS NULL`**：runtime 兜底 `'en-US'`，与
  RFC-041 baseline 一致；详情页 header 显示 `Output language:
  en-US (default)`。
- **opencode 不遵循指示语**：grep 守卫只能锁 prompt 文本，不锁产出
  内容。验收 e2e 跑一次 zh-CN job + 一次 en-US job，断言候选
  `bodyMd` 至少各含一个目标语种的代表字符（CJK 区块 / ASCII 全字母）。
  人工抽检写进 PR 描述。
- **下游 agent 注入错配**：本 RFC 主动接受这条历史顾虑被显式推翻
  （proposal §背景已论证），不试图在 inject 阶段做语言探测；admin
  保留通过 RFC-045 编辑或直接 reject 中文候选的兜底。
- **migration rollback**：0027 是纯加列，回滚只需 DROP COLUMN；老
  binary 看不见新列不影响读写（不在任何 SELECT 中强制 NOT NULL）。

## 测试策略

shared schema 测试：
- `config-schema-memory-distill-lang.test.ts` — 3 case：'zh-CN'/'en-US'
  接受、undefined 接受、非法值 422。

backend 单元：
- `migration-0027-distill-job-output-lang.test.ts` — 3 case：新建库含
  列 / 老库迁移加列幂等 / 写入读出 round-trip。
- `memory-distill-scheduler-output-lang.test.ts` — 4 case：默认
  config → 入库 'en-US'；config zh-CN → 入库 'zh-CN'；切换 config 后
  既有 pending job 不变（已落 outputLang）；merge sibling 共享同一
  outputLang。
- `memory-distiller-output-lang-directive.test.ts` — 4 case：
  outputLang='en-US' → user prompt 末尾匹配英文指示语 + system prompt
  字节级 unchanged；outputLang='zh-CN' → 中文指示语；retry 用 job
  行的 outputLang（不读 config）；source code grep 守卫两个常量字面
  + system prompt 字节级与 RFC-041 baseline 一致。

backend 路由：
- `routes-memory-distill-job-detail-output-lang.test.ts` — 2 case：
  detail GET 返回 outputLang；null 行返回 null（前端兜底为 'en-US'）。

frontend：
- `settings-memory-distill-lang.test.tsx` — 3 case：select 渲染 + 选项
  匹配 i18n + onChange 触发 PATCH /api/config。
- `distill-job-detail-output-lang.test.tsx` — 2 case：header 行展示
  outputLang；null 行展示 default。
- `memory-approval-queue-lang-chip.test.tsx` — 3 case：candidate 行
  按 job.outputLang 展示 chip；approved 行无 chip；i18n key 渲染。
- `i18n-distill-output-lang-keys.test.ts` — 4 case：zh-CN / en-US bundle
  含所有新 key + 无遗漏。

source 层 grep 守卫（无运行时）：
- `memory-distiller-grep-output-lang-directive.test.ts` — 4 case：
  常量包含两条 directive 字符串；`buildDistillerUserPrompt` 函数体
  内 append directive；`DISTILLER_SYSTEM_PROMPT` 不含任何中文字符
  （`\p{Script=Han}` 正则负断言锁主体永远英文）；prompt 主体 SHA256
  hash 与 RFC-041 baseline 锁定值一致（hash 写在测试常量里，未来
  改主体必须显式更新 hash）。

e2e（可选，按 RFC-049 之前的拆 PR 节奏，先不上 e2e）：
- 起一个 distill job 走 zh-CN 模型 mock 路径，断言入库候选 bodyMd
  含 CJK；切回 en-US 再跑一遍断言 ASCII-only。

## 不走 RFC 的后续

- 字段命名：若未来想细分"title 语言 vs body 语言"，再起新 RFC。
- 自动语言探测：显式排除，见 proposal §非目标。
