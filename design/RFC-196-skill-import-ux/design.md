# RFC-196 — Skill ZIP 导入体验重构：技术设计

## 1. 当前实现与不变量

### 1.1 当前文件

| 面            | 当前实现                                                                  | 本 RFC 处理                                                                |
| ------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| route         | `routes/skills.new.tsx`：managed / zip 两个 keep-mounted panel            | 保留 mode 与 keep-mounted；ZIP active 时动态标题 / 说明                    |
| panel         | `components/skills/ImportZipPanel.tsx`：file row + 五列表格 +内联 summary | 改为 select / review / result 判别联合状态机                               |
| pure logic    | `lib/skill-zip-import.ts`                                                 | 保留决策与 rename 规则；扩充 view summary / submit gate 纯函数             |
| form controls | 原生 file input、原生 rename input、共享 `Select`                         | 新 `FileDropzone`；rename 改 `Field + TextInput`；Select 保留              |
| status UI     | 私有 error / warning / conflict / summary CSS                             | 复用 `Card` / `StatusChip` / `ErrorBanner` / `EmptyState` / `LoadingState` |
| backend       | `/api/skills/import-zip/{parse,commit}` + `services/skill-zip.ts`         | wire / 行为不变；limits 常量下沉 shared 后 re-export                       |
| tests         | `import-zip-panel.test.tsx`、helper、route source lock                    | 改为阶段 / role / focus / responsive 合同并保留安全矩阵                    |

### 1.2 必须保持的不变量

- parse multipart：`file=<同一 File>`；commit multipart：`file=<同一 File>` +
  `decisions=<JSON.stringify(buildDecisionMap(rows))>`。
- parse 是只读；commit 才写入。
- no conflict 初始 `import`；conflict 初始 `skip`。
- `availableActionsFor` 权限矩阵与 backend `isResourceOwner` 兜底不变。
- commit 对候选逐项处理、部分失败继续下一个；response 四数组 shape 不变。
- managed 创建、覆盖时版本写入、reserve / ACL / boot verify / cache key 不变。
- ZIP panel 跨 managed / zip 页签 keep-mounted；File 暂存不进入 split dirty guard。
- 成功后必须 invalidate `['skills']`；仅“是否自动 navigate”改变。

## 2. 状态模型

移除目前互相正交的 `file + phase + busy + commitError + summary` 五份状态，改成一份判别联合；
`busy` 只表示当前阶段的瞬时请求：

```ts
type ZipImportPhase =
  | {
      kind: 'select'
      file: File | null
      selectionError: string | null
      parseError: ZipUiError | null
    }
  | {
      kind: 'review'
      file: File
      parse: ParseSkillZipResponse
      rows: RowState[]
      commitError: ZipUiError | null
    }
  | {
      kind: 'result'
      fileName: string
      summary: CommitSkillZipResponse
    }

type ZipImportBusy = 'parse' | 'commit' | null
```

### 2.1 转移表

| 当前        | 事件                             | 下一状态                          | 说明                                     |
| ----------- | -------------------------------- | --------------------------------- | ---------------------------------------- |
| select      | choose/drop valid file           | select(new file, errors null)     | 同文件也可重新选择；input value 每次清空 |
| select      | choose/drop invalid / oversize   | select(file null, selectionError) | 不发请求                                 |
| select      | check → 2xx                      | review(file, parse, rows)         | File 对象原样保留供 commit               |
| select      | check → non-2xx / network error  | select(same file, parseError)     | 可原文件重试                             |
| review      | update decision                  | review(rows patched)              | immutable row update                     |
| review      | back / replace                   | select(same file, no errors)      | 旧 parse / rows 不再可提交               |
| review      | import → non-2xx / network error | review(same rows, commitError)    | 决策逐字保留，可重试                     |
| review      | import → 2xx                     | result(fileName, summary)         | await invalidate 后进入；不自动 navigate |
| result      | import another                   | fresh select(null)                | 清掉 File / response，focus 选择按钮     |
| 任意非 busy | tab switch away/back             | 原状态                            | keep-mounted + `hidden` 保持             |

`choose/drop` 与 `back` 在 busy 时 disabled；因此同一 panel 内不会出现 A 文件 parse 迟到覆盖 B 文件的竞态。
组件 unmount 时不依赖响应结果完成任何全局副作用；commit 已成功则 invalidate 在进入 result 前完成。

### 2.2 错误归一

```ts
interface ZipUiError {
  code?: string
  message: string
}
```

- non-2xx：读取 `{code,message}`；缺字段时回落 i18n + HTTP status。
- `fetch` reject / body decode reject：catch `unknown`，保留可读 message，绝不让事件 handler 产生未处理 rejection。
- parse response `errors[]` 不是请求错误，属于 review 内容；与 valid candidates 并存。

## 3. 公共 `FileDropzone`

### 3.1 API

```ts
interface FileDropzoneProps {
  file: File | null
  onFileChange: (file: File | null) => void
  accept?: string
  disabled?: boolean
  title: string
  description?: string
  chooseLabel: string
  replaceLabel?: string
  removeLabel?: string
  error?: string
  icon?: ReactNode
  inputRef?: Ref<HTMLInputElement>
  'data-testid'?: string
}
```

- 单文件是原语的明确边界；多文件继续由 `UploadPicker` 负责，不用一个复杂 union API 假装统一。
- 文案、icon、accept 全由 caller 注入，组件不依赖 i18n namespace 或 Skill 类型。
- input `display:none`，真实 `.btn` 触发 `input.click()`；drop surface 不挂伪 button role。
- `dragenter/dragleave/drop` 只维护视觉 active；drop 取 `dataTransfer.files[0]`。
- `onFileChange(null)` 清除；选择 / drop 后 input `.value=''`，保证可重新选择同名文件。
- file summary 显示 caller file name + 组件内部短字节格式；长名 `min-width:0 + ellipsis + title`。
- error 节点 `role=alert`，并通过 `aria-describedby` 与选择按钮关联。

### 3.2 Skill 校验

feature 层纯函数：

```ts
type SkillZipFileCheck = { ok: true; file: File } | { ok: false; reason: 'type' | 'too-large' }

function validateSkillZipFile(file: File): SkillZipFileCheck
```

- 名称大小写不敏感以 `.zip` 结尾；MIME 仅作辅助，不因浏览器给空 MIME 拒绝合法 zip。
- `file.size <= SKILL_ZIP_LIMITS.totalBytes`。
- backend 继续执行 decode、uncompressed total、per-file、entries、depth、traversal 全套校验；前端不复制这些
  无法从压缩文件元数据可靠判断的规则。

### 3.3 limits 单一事实源

`packages/shared/src/skill-zip.ts` 导出：

```ts
export const SKILL_ZIP_LIMITS = {
  totalBytes: 64 * 1024 * 1024,
  perFileBytes: 10 * 1024 * 1024,
  entries: 2000,
  depth: 12,
} as const
```

backend 保持兼容导出：

```ts
export const ZIP_LIMITS = SKILL_ZIP_LIMITS
```

既有 backend tests 仍可 import `ZIP_LIMITS`；数值零变化。frontend 只读取 `totalBytes` 做早反馈与文案插值，
不把 `64 MiB` 写死在翻译字符串里。

## 4. 页面结构

```text
SkillCreatePage
├─ header
│  ├─ dynamic title (managed=new / zip=import)
│  ├─ zip subtitle (zip only)
│  └─ create action (managed only)
├─ TabBar<managed|zip>
├─ managed panel (unchanged)
└─ zip panel (keep-mounted)
   └─ ImportZipPanel
      ├─ SelectPhase
      │  ├─ FileDropzone
      │  ├─ structure example Card
      │  └─ check action
      ├─ ReviewPhase
      │  ├─ ArchiveHeader (file summary + replace)
      │  ├─ ReviewSummary (StatusChip group)
      │  ├─ ErrorBanner / ArchiveErrors / EmptyState
      │  ├─ CandidateCardList
      │  └─ ReviewActionBar
      └─ ResultPhase
         ├─ result heading + counts
         ├─ non-empty result groups
         └─ import-another / return-list actions
```

不使用共享 `Stepper`：该原语的“visited steps 可回跳 + 通用 Next/Back footer”不符合 commit 后不可回到旧
review 重提的安全要求。阶段通过互斥页面、标题与明确动作表达；不新造另一套通用 stepper。

## 5. Select 阶段

### 5.1 信息层级

1. `FileDropzone` 是首屏唯一主视觉和主行动。
2. 下方 compact `Card` 展示正确目录结构，不用一整句混合中英文路径：

```text
pack.zip
└── my-skill/
    ├── SKILL.md
    └── references/...
```

3. 辅助事实：单个 `.zip`、最大值（由 shared constant 格式化）、导入后均为托管 Skill。
4. file 选中后 dropzone 内显示摘要；主按钮文案从「选择 ZIP」变「检查 ZIP 内容」。

### 5.2 Parse gate

`file !== null && busy === null && selectionError === null` 才可检查。点击后：

- Dropzone 全部 action disabled；
- 主按钮显示 `LoadingState` 不合适（会改变按钮高度），使用 `zipChecking` pending 文案 + `aria-busy`；
- dropzone 下增加 visually stable `role=status` 文案，避免只靠 disabled 表示进行中。

## 6. Review 阶段

### 6.1 候选 view model

`lib/skill-zip-import.ts` 增：

```ts
interface ReviewSummary {
  candidates: number
  conflicts: number
  readonlyConflicts: number
  archiveErrors: number
}

interface SubmitState {
  enabled: boolean
  reason?: 'nothing-selected' | 'rename-invalid' | 'names-unavailable' | 'busy'
  counts: RowsSummary
}
```

`deriveReviewSummary(parse)` 与 `deriveSubmitState(rows, existingNamesState, busy)` 作为单一派生点；JSX 不再手拼
“有多少 + 能否提交”。rename 校验继续调用 `validateRenameTarget`。

### 6.2 CandidateCard

`CandidateRow` 改名 `CandidateCard`，但稳定 testid 尽量保留：

- root：`zip-row-${name}`；
- action：`zip-action-${name}`；
- rename：`zip-rename-${name}` / `zip-rename-error-${name}`。

结构：

```tsx
<Card
  className="zip-candidate"
  header={<CandidateIdentityAndStatus />}
  footer={<CandidateDecision />}
>
  <CandidateDescription />
  <CandidateFacts />
  <CandidateWarnings />
</Card>
```

- ready：`StatusChip success`；managed conflict：`warn`；不可覆盖：`neutral` + 明确文案，不用 danger 暗示系统错误。
- fileCount + totalBytes 是辅助 facts；description 最多两行但保留 title。
- warning 列表不隐藏在 tooltip；可能影响导入理解，逐条可见并折行。
- `Select.ariaLabel = t('skills.zipActionFor', {name})`。
- rename 的 `Field` label 同样含 name；`TextInput` 使用 `aria-invalid/errorId`。

### 6.3 Archive errors

parse response 的 `errors[]` 渲染在候选列表前：

- 一个 warning `Card`，标题“有 N 项未通过检查”；
- `<ul>` 每行 path（空 path 显示 `(zip)`）+ code + message；
- 这类条目从未进入 rows，不能被选择或提交；
- 有 valid rows 时仍显示 action bar；无 valid rows 时显示 `EmptyState` + “更换 ZIP”。

### 6.4 existing names query

沿用 query key `['skills']` 与父 split list 缓存：

- data 已有时直接验证；background refetch 不清空 names。
- 首次 loading 且没有 rename row：不阻塞 import / skip / overwrite。
- 任一 row 选 rename 而 data 从未成功：submit reason=`names-unavailable`，显示 ErrorBanner + retry。
- query error 但有旧 data：继续用旧 data 做早检查，同时明确 backend commit 仍是最终真值；不把 refetch error
  升格成全流程阻断。

### 6.5 Action bar

行动条位于 panel 当前 scroll area 的末端，在候选较多时 `position:sticky; bottom:0`：

- 左侧 aria-live counts；overwrite>0 时额外 warning 句。
- 右侧「返回」+ primary「导入 N 个 Skill」。
- sticky 背景、border、shadow 使用 token；窄栏取消左右布局，按钮纵向 / 满宽，DOM 顺序仍先返回后导入。
- `N = importing + overwriting + renaming`；0 时 disabled。

## 7. Result 阶段

### 7.1 主状态

```ts
type ResultKind = 'success' | 'partial' | 'no-write'

function resultKind(summary: CommitSkillZipResponse): ResultKind
```

- success：`failed.length===0 && created.length+updated.length>0`；
- partial：有 created/updated 且 failed>0；
- no-write：created+updated===0（可能全失败，也可能 response 只含 skipped）。

顶部用 icon + heading + 四 counts，不把 result 伪装成 transient toast。

### 7.2 分组

- created / updated：name 为 `<Link to="/skills/$name">`；描述可选，状态 chip 区分新建 / 更新。
- skipped：name + reason；不链接以免把“未处理”误解为本次成功目标（同名存量仍可能存在）。
- failed：name + `code: message`，`ErrorBanner` 只做总提示，逐项详情在 list。
- 四组仅非空才渲染；列表使用 shared Card 或简洁语义 `<ul>`，不再造 data table。

### 7.3 焦点

- 进入 result 后 focus 主 heading（`tabIndex=-1`），读屏立即得到结果。
- 「继续导入」reset 后 focus FileDropzone 选择按钮。
- 点击成功 name 正常路由；点击「返回技能列表」到 `/skills`。

## 8. CSS 与响应式

新 namespace：`.skill-import` / `.file-dropzone`；删除退役 `.zip-import__table`、原生 rename、私有
error/summary 样式。

关键约束：

```css
.skill-import,
.skill-import * {
  min-width: 0;
}

.zip-candidate .card__footer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(180px, 220px);
}

@media (max-width: 720px) {
  .zip-candidate .card__footer,
  .skill-import__actions {
    grid-template-columns: minmax(0, 1fr);
  }
}
```

实际实现不使用全局 universal selector（上例仅表达 min-width 不变量），而在每个 flex/grid 边界显式落
`min-width:0`。候选列表一列，避免 170px detail 下 card grid 再分栏。`code/path/message` 统一
`overflow-wrap:anywhere`。sticky action bar 不盖住最后一张卡：列表末尾留等于 action bar 高度的空间，
或行动条作为正常流末项 + sticky 自身占位（优先后者）。

真实浏览器验证发现旧 shell 在 390px 下把 feature 根压到 138px，单改内部卡片只能得到“无 overflow 但不可用”的
假响应式。因此 `<=720px` 对含 `.skill-import` 的 `/skills/new` 壳使用 route-scoped `:has()`：隐藏全局 sidebar 与
Skills 列表 rail、让 split 退成单列，并显示页内返回链接。选择器不会改变其他路由或桌面布局；390px 下 feature
根实测 358px，document 与 feature 均无水平 overflow。

## 9. i18n

`skills` zh/en 对称整理：

- mode / header：`tabZip` 值更新、`importTitle`、`importSubtitle`；
- select：`zipDropTitle`、`zipDropHint`、`zipChoose`、`zipReplace`、`zipRemove`、`zipStructureTitle`、
  `zipManagedHint`、`zipTooLarge`、`zipWrongType`、`zipCheck`、`zipChecking`；
- review：summary / ready / conflicts / actionFor / renameFor / back / archive errors / names retry；
- result：success / partial / noWrite / group labels / continue / return / open item。

既有能复用的 action / conflict / rename error / fallback key 保留；`zipCol*`、旧 `zipEmptyHint` 等无调用者后
删除。实现后跑 i18n key 对称测试与全仓 grep，避免死键。

## 10. 测试设计

### 10.1 公共原语

`file-dropzone.test.tsx`：

1. button 唯一可达且触发 hidden input；
2. input change / drop 各交付一个 File；
3. 同名重选（input value 清空）；
4. selected summary / remove / replace；
5. disabled 不接收 click/drop；
6. error role + describedby；
7. drag active 不改变 accessible name。

### 10.2 纯函数

`skill-zip-import-helpers.test.ts` 增：

- file type / size 边界（`limit-1 / limit / limit+1`）；
- review summary；
- submit state：nothing / invalid rename / names unavailable / busy / allowed；
- result kind 三态；
- 原有 action matrix / rename collisions / decision map 全保留。

shared / backend：

- `SKILL_ZIP_LIMITS` 字面值锁；backend `ZIP_LIMITS === SKILL_ZIP_LIMITS`；现有 decode limit suite 继续绿。

### 10.3 Panel 集成

`import-zip-panel.test.tsx` 重构但保留安全主线：

1. select 空态、invalid / oversize、parse pending、HTTP / network error 保 file 重试；
2. parse → review，archive error 与 valid cards 并存，零 candidate EmptyState；
3. managed owner / non-owner action矩阵；默认 conflict=skip；
4. rename 四错误、query unavailable gate + retry；
5. commit FormData 精确、pending 防重复、HTTP / network error 保 rows；
6. 2xx 全成功也不 navigate，进入 result；partial / no-write 分组正确；
7. success links / continue reset / return list；
8. file A review → back → file B：A rows / error / result 零残留；
9. tab keep-mounted 往返 file / review 决策保留（route integration）；
10. unique accessible names 与 result / reset focus。

### 10.4 Route / responsive / visual

- `skills-split-page.test.tsx`：managed/ZIP 动态 heading、managed create button 不回归。
- source guard：`ImportZipPanel` 不再出现 `<table` / raw rename `<input type="text">` / 私有 error chrome；
  `FileDropzone`、`Card`、`StatusChip`、`ErrorBanner`、`TextInput` import 存在。
- dev 浏览器：1280×800 light/dark 的 select / review / result；390×844 的 review（长 name/description/error）
  量测 feature 根 `scrollWidth===clientWidth`，所有 buttons/inputs rect 在 detail client rect 内。
- keyboard：选择 → 检查 → action Select → rename error → 修正 → import → result → continue，焦点顺序可预测。
- axe：select / review / result 三态零 serious/critical violation。

## 11. 文件变更

| 文件                                                         | 改动                                                |
| ------------------------------------------------------------ | --------------------------------------------------- |
| `packages/shared/src/skill-zip.ts`                           | `SKILL_ZIP_LIMITS` 单源常量                         |
| `packages/backend/src/services/skill-zip.ts`                 | `ZIP_LIMITS` 改为 shared alias，行为不变            |
| `packages/frontend/src/components/FileDropzone.tsx`          | 新公共单文件 dropzone                               |
| `packages/frontend/src/components/skills/ImportZipPanel.tsx` | 三阶段状态机与新 UI                                 |
| `packages/frontend/src/lib/skill-zip-import.ts`              | file / summary / submit / result 纯函数             |
| `packages/frontend/src/routes/skills.new.tsx`                | ZIP mode 动态 title / subtitle；手机端页内返回入口  |
| `packages/frontend/src/i18n/{zh-CN,en-US}.ts`                | 对称文案整理                                        |
| `packages/frontend/src/styles.css`                           | 新任务流 CSS、手机专注布局；退役旧 table/error 样式 |
| `packages/frontend/tests/*zip*`、`file-dropzone.test.tsx`    | 纯函数、组件、route、a11y 合同                      |
| `e2e/`（按实现时最小路径）                                   | responsive / axe / keyboard 视觉验收                |

## 12. 风险与缓解

| 风险                                             | 缓解                                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 全成功不再自动跳转被误认为回归                   | RFC 明确产品决定；result 提供成功链接、继续导入、返回列表；测试翻转旧 navigate 断言 |
| shared limit 常量移动影响 backend import         | 保留 `export const ZIP_LIMITS = SKILL_ZIP_LIMITS` 兼容名 + equality test            |
| Drop 伪接受非 zip / MIME 漂移                    | 以 filename extension 为主；backend decode 最终兜底                                 |
| existing names query 暂时失败                    | 只在 rename 需要时阻断；有 cached data failure-soft；backend 始终最终校验           |
| result 后回到旧 review 重复 commit               | 判别状态机没有 result→review 转移；只有 reset 到 fresh select                       |
| sticky footer 遮挡 / 窄栏过高                    | footer 在正常流保留占位；390 + 30 candidates 实测滚动首尾可达                       |
| 当前 `styles.css` / i18n 有 RFC-194/195 并发改动 | 只 patch ZIP 邻近块与 `skills` key；实现前逐 hunk 复核，真实同行冲突停下协调        |
| shell 390px 只给 detail 170px                    | 路由级 `:has(.skill-import)` 仅在手机隐藏两个桌面 rail，页内返回链接保持导航可达    |

## 13. 回滚

单 RFC、无 migration、无新 API。回滚 frontend/shared/backend alias commit 即恢复原界面；ZIP 文件、Skill 数据、
ACL 与版本历史无需回滚。已成功导入的数据属于用户明确 commit 的业务结果，不随 UI 代码回滚删除。
