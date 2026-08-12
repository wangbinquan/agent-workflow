# RFC-290 任务分解

## 子任务

| 编号       | 任务               | 内容                                                                                                                                                                                                                                                                                                                                                                                                           | 依赖   |
| ---------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| RFC-290-T1 | 换算纯函数         | 新建 `packages/frontend/src/lib/formatUnit.ts`：`formatUnitValue(n, unit, t)` 三阶梯（ms/days/bytes）；按量级只选第一个适用单位，该单位除不尽即返回 null（不降级成 90 秒一类噪音）；`0` 特判成功返回原样。translator 作为参数注入，不读全局 i18n                                                                                                                                                               | —      |
| RFC-290-T2 | i18n key           | en/zh 各加 `common.range` / `common.rangeMaxOnly` / `common.rangeConverted` + 时间与天数单位复数 key（`unit.hour_one`/`_other` 等）；本仓 `Resources` 键树要求中文也同时提供 `_one`/`_other`。KiB/MiB 不进 i18n；英文半角括号、中文全角括号                                                                                                                                                                    | —      |
| RFC-290-T3 | NumberInput 扩展   | `Form.tsx`：`NumberInputProps` 加 `rangeHint?: boolean` / `unit?: 'ms'\|'bytes'\|'days'` / `aria-describedby`；渲染判据 `rangeHint !== false && max !== undefined`；启用时返回 Fragment（`<input>` + `<span className="form-field__range" aria-hidden>`），`useId()` 生成 id 并与调用方 description id 合并；range 从包裹 label 的 accessible name 剔除但作为 description 朗读；两端任一换算失败则整体退纯数字 | T1、T2 |
| RFC-290-T4 | CSS                | `styles.css` 加 `.form-field__range { order: 1; font-size: 12px; color: var(--muted); }` + RFC-290 注释说明 order 意图                                                                                                                                                                                                                                                                                         | —      |
| RFC-290-T5 | Pagination opt-out | `Pagination.tsx:73` 加 `rangeHint={false}`，行内注释写明理由（横向紧凑布局 + 动态 max 无信息增量）                                                                                                                                                                                                                                                                                                             | T3     |
| RFC-290-T6 | settings 单位标注  | `settings.tsx` 4 处加 `unit`：`intentBuilderTurnTimeoutMs`→`'ms'`、`commitPushDiffMaxBytes`→`'bytes'`、`webhookDeliveryBodyRetentionDays` / `…RowRetentionDays`→`'days'`。其余 4 个有界字段不动（默认开即生效）                                                                                                                                                                                                | T3     |
| RFC-290-T7 | 组件测试           | 新建 `packages/frontend/tests/number-input-range.test.tsx`，覆盖 design §6.1 全部 case，含 accessible name/description 不重复、description id 合并与 en/zh 复数渲染                                                                                                                                                                                                                                            | T3     |
| RFC-290-T8 | 边界一致性锁       | 新建 `packages/frontend/tests/settings-bounds-parity.test.ts`，8 个有界字段表驱动：`ConfigSchema` + `ConfigPatchSchema` 双行为探测，且字段锚定比对 `settings.tsx` 的 `min={…}` / `max={…}` 两个字面量。顶部注释写明「双份真值的防漂锁」                                                                                                                                                                        | —      |
| RFC-290-T9 | 收口               | `design/plan.md` RFC 索引置 Done、`STATE.md` 进行中行改 Done 并进已完成表；`bun run gate:local` 全绿后推 main，按 exact SHA 查 CI                                                                                                                                                                                                                                                                              | T1–T8  |

## PR 拆分

单 PR（本仓主干开发，直接 `main` 提交）。建议两次提交：

1. `feat(frontend): RFC-290 数字设置项范围提示（T1–T6）` —— 实现 + 单位标注
2. `test(frontend): RFC-290 组件行为与前后端边界一致性锁（T7–T8）`

若两次提交间隔较久，按 CLAUDE.md「测试随每次改动落地」，合并为单次提交更稳妥。

## 验收清单

见 `proposal.md §5`。补充执行项：

- [x] T8 的边界探测与 `packages/shared/src/schemas/config.ts` 当前值一致（实现门复核 8/8 对齐）
- [x] 未触碰任何后端文件、未改任何边界值
- [x] 未与在途 RFC-283（`routes/webhookTriggers.ts`）/ RFC-284（services 迁移）冲突
- [x] 多人并发树：只按路径精确提交本 RFC 涉及文件，不用 `git add -A`

## 风险

| 风险                                                    | 缓解                                                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 12 处「默认开即生效」的调用点未逐一目视，可能有布局意外 | 全部在 `<Field>` 内（已核），Field 是 flex column 天然容纳第二行；T9 前本地起 dev server 目视设置页 / 工作组表单 / 调度弹窗 / 触发规则四处 |
| `order: 1` 依赖 `.form-field` 是 flex column            | 已核 `styles.css:4395-4401`；canvas inspector 经 `display:contents` 透传（`historyMeta.tsx:86`）。T7 加一条 Field 内渲染顺序断言           |
| i18next 复数在 zh 的回退                                | en/zh 键树均显式提供 `_one` / `_other`，中文两档文案相同；T7 覆盖中英双语渲染                                                              |
