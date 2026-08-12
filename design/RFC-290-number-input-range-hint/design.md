# RFC-290 技术设计

## 1. 现状锚点

| 事实                                                                                                                                           | 位置                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `NumberInput` 返回**裸 `<input>`**，无 wrapper                                                                                                 | `packages/frontend/src/components/Form.tsx:199-222` |
| `NumberInputProps` 只有 value/onChange/placeholder/min/max/step/disabled/className/data-testid/onFocus——**拿不到字段名**                       | `Form.tsx:173-185`                                  |
| `Field` 渲染顺序：label → children → (error ‖ hint)，`.form-field` 是 `display:flex; flex-direction:column`                                    | `Form.tsx:51-71`、`styles.css:4395-4401`            |
| `.form-field__hint` 12px/`--muted`                                                                                                             | `styles.css:4416-4419`                              |
| error 存在时 hint **不渲染**（互斥）                                                                                                           | `Form.tsx:63-69`                                    |
| canvas inspector 的 `NumberInput` 隔着 `InspectorHistoryBoundary`，但它是 `display:contents`——布局上子元素仍是 `.form-field` 的直接 flex child | `canvas/inspector/historyMeta.tsx:86`               |
| 全仓 43 处 `NumberInput`，17 处带 `max`；42 处在 `<Field>` 内，唯一裸用是 Pagination                                                           | 见 §3.3 清单                                        |

**关键推论**：`unit` 无法由组件自行推断（拿不到字段名），必须由调用方显式标注。

## 2. 接口契约

`NumberInputProps` 新增两个可选 prop，均向后兼容：

```ts
interface NumberInputProps {
  // …既有字段不变…
  /** RFC-290: 关掉自动范围提示。默认开——有 `max` 就渲染。
   *  仅用于紧凑内联场景（横向布局塞不下第二行）。 */
  rangeHint?: boolean
  /** RFC-290: 让范围提示附人性化换算括号。组件拿不到字段名，
   *  必须由调用方标注。省略 = 纯数字。 */
  unit?: 'ms' | 'bytes' | 'days'
  /** 调用方已有的说明 id；范围 id 会与它合并而不是覆盖。 */
  'aria-describedby'?: AriaAttributes['aria-describedby']
}
```

**渲染判据**：`rangeHint !== false && max !== undefined`。

- `max === undefined` 一律不渲染 —— 覆盖 17 个 min-only 字段（proposal §3 拍板）
- 默认开而非默认关：17 个带 `max` 的调用点里 16 个该显示，只有 1 个要关；默认关会让
  「新增有界字段自动获得提示」（proposal §2）落空

## 3. 渲染方案

### 3.1 Fragment 而非 wrapper

启用时返回 Fragment，**不包 div**：

```tsx
return (
  <>
    <input … aria-describedby={mergeDescribedBy(callerDescriptionId, rangeId)} />
    <span id={rangeId} className="form-field__range" aria-hidden="true">{text}</span>
  </>
)
```

包 wrapper 会让 `<input>` 与范围文本合成 `.form-field` 的**单个** flex item，范围文本被
钉在 input 正下方、无法排到 hint 之后；且会给 43 处调用点凭空插入一层盒子，
`form-grid--cols-2` / `schedule-dialog__row` 等布局都要重新验。Fragment 让二者都是
`.form-field` 的直接 flex child，零布局侵入。

`InspectorHistoryBoundary` 的 `display:contents` 使 canvas inspector 那 6 处同样成立
（该文件注释明写此设计是为了「不加布局 chrome、不改共享原语 API」）。

### 3.2 顺序：CSS `order`

DOM 顺序是 label → input → range → hint，但期望视觉是 hint 在上、range 在下
（hint 讲用途，range 讲约束）。`.form-field` 已是 flex column，给 range 加 `order: 1`
即可——其余子元素保持默认 `order: 0`，按 DOM 顺序排在前：

```css
/* RFC-290: 范围提示排在 hint/error 之后——hint 讲用途，范围讲约束。
   .form-field 是 flex column，其余子元素 order:0 按 DOM 序在前。 */
.form-field__range {
  order: 1;
  font-size: 12px;
  color: var(--muted);
}
```

**副作用（正向）**：`Field` 在 error 态不渲染 hint，但 range 仍在——报错时正好告诉用户
正确范围是什么。

**a11y 代价与消解**：`Field` 的普通形态是包裹式 `<label>`。若只把可见 range span 放进去，
它会同时进入输入框的 accessible name；再挂 `aria-describedby` 后，读屏会把同一范围读两次。
因此可见 span 必须加 `aria-hidden="true"`，把它从包裹式 label 的名称计算中剔除；AccName
算法对 `aria-describedby` 显式引用的隐藏节点仍会取其文本作为 description。`useId()` 生成
range id，并与调用方已有的 `aria-describedby`（若有）以空格合并，不能覆盖。组件测试必须
同时锁住：accessible name 不含 range、accessible description 等于 range、调用方 id 仍保留。

### 3.3 opt-out 清单

全仓 17 处带 `max`：

| 文件                                                 | 处数                 | 决定                    |
| ---------------------------------------------------- | -------------------- | ----------------------- |
| `routes/settings.tsx`                                | 8                    | 显示（本 RFC 主目标）   |
| `components/ScheduleDialog.tsx`                      | 2                    | 显示                    |
| `components/workgroup/WorkgroupForm.tsx`             | 2                    | 显示                    |
| `components/workgroup/WorkgroupTaskConfigDialog.tsx` | 2                    | 显示                    |
| `components/RuntimeList.tsx`                         | 1（temperature 0–2） | 显示                    |
| `components/webhooks/TriggersPanel.tsx`              | 1（maxFires 1–100）  | 显示                    |
| `components/Pagination.tsx:73`                       | 1                    | **`rangeHint={false}`** |

Pagination 是唯一裸用点：在 `<label className="pagination__jump-field">` 的横向紧凑布局里，
`max` 还是动态的 `safePageCount`。加第二行文本会破坏行内对齐，且「范围 1 – 12」对跳页框
无信息增量。

### 3.4 单位标注

| 调用点                                                                  | `unit`        |
| ----------------------------------------------------------------------- | ------------- |
| `settings.tsx` `intentBuilderTurnTimeoutMs`                             | `'ms'`        |
| `settings.tsx` `commitPushDiffMaxBytes`                                 | `'bytes'`     |
| `settings.tsx` `webhookDeliveryBodyRetentionDays` / `…RowRetentionDays` | `'days'`      |
| 其余 13 处（轮数/重试/jobs/端口/温度/天数序号/并发）                    | 省略 = 纯数字 |

`ScheduleDialog` 的 interval 单位随 kind 动态变化（每 N 分钟/小时/天），不标。

## 4. 文案与换算

### 4.1 i18n key（en/zh 各一份）

```
common.range          'Range {{min}} – {{max}}'   / '范围 {{min}} – {{max}}'
common.rangeMaxOnly   'Max {{max}}'               / '最大 {{max}}'
common.rangeConverted '{{range}} ({{converted}})' / '{{range}}（{{converted}}）'
```

`min` 省略时（当前 17 处带 max 的调用点都有 min，属防御分支）走 `rangeMaxOnly`；若同时
标了 `unit`，`converted` 只放 max 的换算值。min 存在时，`converted` 才是 `from – to`。

### 4.2 换算规则

纯函数 `formatUnitValue(n, unit, t)` 注入 `TFunction`（helper 不读取全局 i18n 状态），按数值
量级从大到小取**第一个因子不大于 `abs(n)` 的目标单位**；该单位能整除才返回本地化文本，
否则返回 `null`，调用方不显示括号。不能继续降到更小单位凑整数——例如 `90000ms` 的量级
已进入分钟档，除不尽 60000，必须退纯数字，不能显示「90 秒」。

| unit    | 阶梯                                |
| ------- | ----------------------------------- |
| `ms`    | 小时 3600000 → 分钟 60000 → 秒 1000 |
| `days`  | 年 365 → 天 1                       |
| `bytes` | MiB 1048576 → KiB 1024              |

- **`0` 特判**：0 能被任何数整除，会算出「0 小时」。0 一律成功返回原样文本 `0`
  （`commitPushDiffMaxBytes` 的 min 就是 0）
- 两端**任一**端换算失败（除不尽）则整体不显示括号，只留纯数字范围——半边换算比不换算
  更难读
- `KiB`/`MiB` 是国际单位，不进 i18n；时间与天数走 i18next 复数
  （`unit.hour_one`/`unit.hour_other`）。本仓 `Resources` 接口要求 en/zh 键树 1:1，故中文
  `_one` / `_other` 两档都提供同一句文案，沿用仓内现有先例。

预期产出：

```
intentBuilderTurnTimeoutMs → 范围 30000 – 3600000（30 秒 – 1 小时）
commitPushDiffMaxBytes     → 范围 0 – 262144（0 – 256 KiB）
webhookDelivery*Days       → 范围 1 – 3650（1 天 – 10 年）
gitSubmoduleJobs           → 范围 1 – 32
```

## 5. 失败模式

| 模式                                                | 后果                     | 处置                                                               |
| --------------------------------------------------- | ------------------------ | ------------------------------------------------------------------ |
| 调用方给了 `max` 但布局塞不下                       | 文本挤出容器             | 该点显式 `rangeHint={false}`；已审全部 17 处，只有 Pagination 命中 |
| 前端 `max` 与后端 zod 边界漂移                      | UI 说能填 5000，保存被拒 | §6.2 的边界一致性测试锁死（本 RFC 的高价值副产品）                 |
| `unit` 标错（如把 days 标成 ms）                    | 换算数字荒谬             | 单测覆盖三类换算；标注点仅 4 处，人工可核                          |
| 动态 `max`（Pagination 的 `safePageCount`）频繁变化 | 文本抖动                 | 该点已 opt-out                                                     |
| `useId()` 在同页多实例                              | id 冲突                  | React 19 `useId()` 保证同页唯一                                    |

## 6. 测试策略

### 6.1 组件行为（`packages/frontend/tests/number-input-range.test.tsx`，新建）

必写 case：

- 有 `max` → 渲染范围文本；无 `max` → **不**渲染（锁 min-only 不显示的拍板）
- `rangeHint={false}` → 不渲染（锁 Pagination opt-out）
- `unit='ms'`：30000–3600000 → 含「30 秒 – 1 小时」
- `unit='bytes'`：0–262144 → 含「0 – 256 KiB」（锁 0 特判）
- `unit='days'`：1–3650 → 含「1 天 – 10 年」
- 除不尽退化：`unit='ms'` 且 max=90000（1.5 分钟）→ 只有纯数字、无括号
- 省略 `unit` → 只有纯数字
- `aria-describedby` 指向的元素 id 与范围 span 的 id 相等
- 包裹式 `Field` 下 accessible name **不含**范围，accessible description 恰好含一次范围；
  传入既有 `aria-describedby` 时两个 id 都保留
- error 态下 hint 消失但范围仍在
- en/zh 各渲染一例，锁住复数键与半/全角括号

### 6.2 前后端边界一致性（`packages/frontend/tests/settings-bounds-parity.test.ts`，新建）

**这是本 RFC 的高价值副产品**：不做 `CONFIG_BOUNDS` 重构，也要把漂移锁死。

表驱动，8 个有界字段各两条断言：

1. **schema 行为探测**（不碰 zod 私有 `_def`，只看 `safeParse` 的实际判定）：对
   `ConfigSchema` 与真实保存门 `ConfigPatchSchema` **两套** field schema 都断言
   `safeParse(max)` 成功、`safeParse(max + 1)` 失败；`min` 同理。两套都要测，因为 intent
   的 nullable patch 字段在 `ConfigPatchSchema.extend(...)` 里重复声明，单测 base schema
   会漏掉「页面提示与 base 同步、PATCH 上限仍旧」的真实保存失败。
2. **源码文本断言**：`settings.tsx` 中该字段对应 `NumberInput` 的 `min={…}` 与 `max={…}`
   两个字面量都与表驱动 oracle 相等；匹配必须锚定字段名，不能误吃相邻输入框。

文件顶部注释写明：_「锁 RFC-290 —— 前端硬编码 min/max 与 shared zod schema 是双份真值
（proposal §3 明示不做单一真值）。任一侧改了另一侧没跟，这条测试必须红。」_

### 6.3 快照/视觉

设置页既有测试若有 DOM 快照，随本 RFC 更新；`bun run gate:local` 全绿方可推。

## 7. 影响面

- **改**：`components/Form.tsx`（NumberInput +2 prop、+换算纯函数或抽 `lib/formatUnit.ts`）、
  `styles.css`（+`.form-field__range`）、`i18n/en-US.ts` + `zh-CN.ts`（+range/unit key）、
  `components/Pagination.tsx`（+`rangeHint={false}`）、`routes/settings.tsx`（4 处 +`unit`）
- **不改**：任何后端文件、任何边界值、其余 12 处带 max 的调用点（默认开即生效）
- **新增**：2 个测试文件
