# RFC-156 — 任务分解

单 PR:`feat(frontend): RFC-156 系统 Agent 设置页签（内置 framework agent 运行时+运行配置收纳）`

## 子任务

| ID | 任务 | 依赖 | 说明 |
|---|---|---|---|
| **RFC-156-T1** | shared:`ConfigPatchSchema.extend` 补 6 个 nullable 键——`mergeAgentRuntime` + `commitPushModel`/`memoryDistillModel`/`mergeAgentModel`（D6）+ 既有两 runtime 保持 | — | 无 `mergeAgentRuntime` 则 merge「继承」400；无三 `*Model` nullable 则 D6 清 model 交互 400。 |
| **RFC-156-T2** | i18n:zh-CN / en-US 新增 `settings.tabSystemAgents` + `systemAgents.*`（各节标题/说明、`fusionTitle`/`fusionHint`/`fusionRuntime`）+ `settingsForm.mergeAgentRuntime`（label + hint）；zh-CN.ts 类型声明块同步 | — | 两语种键对齐；`tabMemory` 键**保留**（仅从 TabBar 列表移除渲染；删键属额外清理，避免误伤）。 |
| **RFC-156-T3** | settings.tsx:`Tab` 联合加 `'systemAgents'`、删 `'memory'`；`TabBar` tabs 数组同步（`runtime` 后插 `systemAgents`，删 `memory`）；分发加 `<SystemAgentsTab>`、删 `<MemoryTab>` | T2 | — |
| **RFC-156-T4** | settings.tsx:新增 `SystemAgentsTab`（9 键 slice + `pickRuntime` helper〔D6 交互清 model〕 + `SectionForm` + 三 `.form-section`），从 `LimitsTab`/`MemoryTab` 逐字迁入字段 JSX；runtime `onChange` 改走 `pickRuntime` | T2,T3 | `memoryDistillLang` testid 原样保留；`*Model` 只入 slice、不渲染控件。 |
| **RFC-156-T5** | settings.tsx:新增 `FusionAgentCard`（`useQuery` GET + `useMutation` PUT runtime-only `{runtime}` 到 `/api/agents/aw-skill-merger`，内联 `RuntimeSelect` 即时保存） | T4 | body 必须恰好 `{runtime}`（含 null）否则 403；硬编码 `aw-skill-merger`。 |
| **RFC-156-T6** | settings.tsx:`LimitsTab` 移除 commit-push 三键 + 对应 `<Field>`；删除 `MemoryTab` 函数 | T4 | 确认 `RuntimeSelect` import 仍被新页签使用、不误删。 |
| **RFC-156-T7** | 测试更新:`settings-commit-push.test.ts` 注释措辞；`settings-memory-distill-lang.test.tsx` 导入改 `SystemAgentsTab` | T4,T6 | 断言逻辑基本不变。 |
| **RFC-156-T8** | 新增锁:`settings-system-agents.test.ts`（源码/i18n grep）+ `settings-system-agents-render.test.tsx`（merge PUT 含 runtime+model:null / 融合 PATCH body 键集===['runtime']）+ shared `ConfigPatchSchema` 6 键 null 锁 | T1,T4,T5,T6 | 见 design §6.2。 |
| **RFC-156-T9** | Playwright 视觉基线（若 settings 页签有基线截图）随页签集变化刷新 | T3-T6 | 参照 RFC-155 视觉基线刷新。 |
| **RFC-156-T10** | 门禁 + Codex 实现门 review + 推送查 CI | 全部 | typecheck+lint+test+format:check；Codex fold；推后查 Actions。 |

## 验收清单

- [ ] 「系统 Agent」页签出现;「记忆」页签消失;「限额」不含 commit-push 字段。
- [ ] 四卡齐全:提交推送 / 记忆提取 / 合并冲突解决(config 三卡,各 runtime + 运行配置) + 技能融合(内联 runtime 选择器,PATCH `/api/agents/aw-skill-merger`)。
- [ ] merge 运行时「继承」可保存(schema 已补);选定发对应名;D6——任一 runtime 选择器交互一并发配对 `*Model:null`。
- [ ] 融合卡:GET 载入当前 runtime;选定/继承 → PATCH body 恰好 `{runtime}` / `{runtime:null}`,不 403。
- [ ] `memoryDistillLang` 三选项 + testid + PATCH 行为不变。
- [ ] 全控件走公共原语;视觉与其它页签一致(light+dark 自查)。
- [ ] i18n 两语种键对齐;既有两锁 + i18n 锁绿;新增三类锁绿。
- [ ] typecheck+lint+test+format:check 全绿;CI(含 build:binary + e2e)绿;Codex 双门 fold。

## 风险与回归防护

- **删 `MemoryTab` 破测试导入** → T7 同批改导入,否则 typecheck 红。
- **忘补 6 个 nullable schema 键** → T1 + T8 shared 锁双保(merge「继承」/ D6 清 model 都要)。
- **融合卡混键 403** → T8 render 锁断言 PATCH body 键集 === `['runtime']`。
- **字段回搬 LimitsTab** → T8 断言 `LimitsTab` slice 不含 commit-push 键。
- **融合名失效** → T8 源码文本锁含 `aw-skill-merger`(对齐后端 `SKILL_MERGER_AGENT_NAME`)。
- **视觉基线漂移误报 CI 红** → T9 主动刷新基线。
