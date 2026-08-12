# RFC-290 数字设置项的可调范围自解释

## 1. 背景

起于一次真实求助链：用户的 intent builder 跑出 `intent-run-timeout`，需要调大单轮超时
（`intentBuilderTurnTimeoutMs`）。打开设置页后，**用户不知道最大能填多少**——

- 界面上只有一个数字输入框和一句 hint：「每轮生成的最长时长；默认 600000。」
  （`packages/frontend/src/i18n/zh-CN.ts:6791`）
- 真值 `min(30_000).max(3_600_000)` 藏在后端 zod schema
  （`packages/shared/src/schemas/config.ts:302`），前台不可见
- 输入框确实带了原生 `min`/`max`（`settings.tsx:1549-1550`），但浏览器的原生 number
  约束**只在提交时报错**，不会主动告诉用户边界在哪；用户只能靠试

复核后确认这不是单个字段的疏漏，而是**系统性缺口**：

- 设置页 25 处 `NumberInput`，**没有一条** hint 写了可调范围，全部只写默认值
- 全仓 43 处 `NumberInput` 中 **17 处带 `max`**，同样一处没有范围提示
- 其中 8 个设置页字段是真有上界的：`intentBuilderTurnTimeoutMs`(30000–3600000) /
  `intentBuilderMaxGenerateRounds`(1–500) / `commitPushMaxRepairRetries`(0–10) /
  `commitPushDiffMaxBytes`(0–262144) / `gitSubmoduleJobs`(1–32) /
  `webhookDeliveryBodyRetentionDays`(1–3650) / `webhookDeliveryRowRetentionDays`(1–3650) /
  `bindPort`(0–65535)

只有下界、无上界的字段（`defaultPerNodeTimeoutMs` / `maxConcurrentNodes` 等）在后端本来
就是 `.positive()` / `.nonnegative()`，前端不设 `max` 是忠实的，**不属于本 RFC 要修的缺陷**。

## 2. 目标

- 带上界的数字设置项在界面上**自解释**：用户不打开源码、不试错就知道能填到多少
- 提示由**公共组件统一产出**，不靠逐条 i18n 文案维护——新增有界字段自动获得提示，
  不会因为作者忘写文案而回到今天的状态
- 毫秒 / 字节 / 天数三类字段附人性化换算，免去用户心算
  （3600000ms 是不是 1 小时、262144 是不是 256 KiB、3650 天是不是 10 年）

## 3. 非目标

- **不改任何边界值本身**。本 RFC 只暴露既有边界，不讨论 3600000 这个上限合不合理。
- **不解决前后端双份真值**。前端 `min={30000} max={3600000}` 是硬编码字面量，真值在
  shared 的 zod schema，二者靠人工保持一致。落档时逐个核过 **8/8 完全对齐**，但没有任何
  机制拦住它漂。根治方案（shared 立 `CONFIG_BOUNDS` 常量，schema 与前端同源取值）
  **本轮登记不做**，见 §6。
- **不给只有下界的字段加提示**。17 个 min-only 字段渲染「最小 1000」信息量低、噪音大，
  且不解决用户提出的「最大能调多少」。（用户 2026-08-12 拍板）
- 不改 intent builder 的超时语义、不改 `intent-run-timeout` 的错误处理路径。

## 4. 用户故事

1. **管理员调大 intent 超时**：intent builder 报 `intent-run-timeout`，管理员打开设置 →
   系统代理，看到「单轮超时（ms）」下方写着「范围 30000 – 3600000（30 秒 – 1 小时）」，
   直接填 1800000 并知道这没超上限。

2. **管理员配置 webhook 留存**：填 `webhookDeliveryRowRetentionDays` 时看到
   「范围 1 – 3650（1 天 – 10 年）」，立刻明白 3650 是十年而不是随便一个大数。

3. **后续开发者新增有界数字设置项**：只要写了 `max`，范围提示自动出现，无需新增 i18n
   文案，也无需知道本 RFC 存在。

## 5. 验收标准

- [x] 设置页 8 个有界字段全部显示范围提示，数值与 `packages/shared/src/schemas/config.ts`
      的 zod 边界逐一相等
- [x] `intentBuilderTurnTimeoutMs` 显示「范围 30000 – 3600000（30 秒 – 1 小时）」；
      `commitPushDiffMaxBytes` 显示「（0 – 256 KiB）」；两个 `*RetentionDays` 显示
      「（1 天 – 10 年）」；其余 4 个有界字段只显示纯数字、无括号
- [x] 全仓 17 处带 `max` 的调用点中 16 处显示提示，`Pagination.tsx` 的跳页框
      **不显示**（紧凑横向布局，见 design §3.3）
- [x] min-only 字段（17 处）不显示任何范围提示
- [x] 范围提示视觉上排在 Field 的 hint **之后**（hint 讲用途、范围讲约束）
- [x] 屏幕阅读器朗读输入框时能读到范围约束（`aria-describedby` 关联），且范围文本不被
      包裹式 `<label>` 同时并入 accessible name 后重复朗读
- [x] canvas inspector 的 6 处 `NumberInput`（隔着 `InspectorHistoryBoundary`）布局不破
- [x] en/zh 双语文案齐备；`bun run gate:local` 全绿

## 6. 登记不做（本轮）

| 项                                                    | 理由                                                                                                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared `CONFIG_BOUNDS` 单一真值（消除前后端双份边界） | 需改 zod schema 定义方式，射程远超本诉求；当前 8/8 对齐无实害。本 RFC 的组件层能力与它**正交**——将来做了 `CONFIG_BOUNDS`，`NumberInput` 无需任何改动 |
| min-only 字段显示下界                                 | 用户拍板不做（§3）                                                                                                                                   |
| 用 zod `_def.checks` 内省自动派生边界                 | zod 3 的 `_def` 是私有 API，升级 zod 4 即碎；显式常量才是稳的单一真值路径                                                                            |

## 7. 与在途 RFC 的关系

- 与 **RFC-286**（前端数据层与死 class）**不冲突**：审计台账 D14 划出的是**新建**原语清单
  （CopyButton/MetaGrid/LocalizedDateTime 等），D17 划出的是 form-input 直落 / 死 CSS 收尾；
  本 RFC 是给**既有**公共原语 `NumberInput` 加能力，且由用户诉求驱动而非审计技术债，
  与那批归一收口正交。
- 编号避开 STATE.md 已预留的 287（装配线收敛）/ 288（WP-5 环拆解）/ 289（WP-6b fanout 内链）。
- 触及文件（`components/Form.tsx` / `styles.css` / `settings.tsx` / i18n）与在途的
  RFC-283（webhook 路由）/ RFC-284（services 迁移）无重叠。
