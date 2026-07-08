# RFC-156 — 技术设计

## 1. 概览与影响面

**本 RFC 是一次前端页签重构 + 一处 shared schema 补洞**,不触碰任何后端派发/解析/spawn 逻辑。

- 前端:`packages/frontend/src/routes/settings.tsx`(新增 `SystemAgentsTab` + `FusionAgentCard`、删 `MemoryTab`、瘦身 `LimitsTab`、改 `Tab` 联合类型 + `TabBar` 列表 + 分发)。
- shared:`packages/shared/src/schemas/config.ts` 的 `ConfigPatchSchema.extend` 补 `mergeAgentRuntime` + 三个 legacy `*Model`(`commitPushModel`/`memoryDistillModel`/`mergeAgentModel`)空值(D6)。
- i18n:`packages/frontend/src/i18n/zh-CN.ts` / `en-US.ts` 新增/迁移键。
- 测试:更新既有两锁 + i18n 锁,新增回归锁(新页签源码/i18n grep + merge/fusion render+PUT/PATCH + schema null + D6 model-clear)。

融合卡是唯一写 `/api/agents`(而非 `/api/config`)的卡片:runtime-only `PATCH`。其余三卡走统一 config `PUT`。

后端 config 字段 `commitPushRuntime` / `commitPushMaxRepairRetries` / `commitPushDiffMaxBytes` / `memoryDistillRuntime` / `memoryDistillLang` / `mergeAgentRuntime` **全部已存在且已接线**(见 `config.ts:145-270`、`resolveInternalAgentRuntime`),PUT `/api/config` 已能持久化它们——前端只是换个页签渲染同一批 key。

## 2. 数据流

```
SystemAgentsTab                                              ← 单一 Save（onSave）驱动两条写路径
  ├─ useTabState(config, [commitPushRuntime, commitPushModel,            ← 三 config 型 agent
  │                       commitPushMaxRepairRetries, commitPushDiffMaxBytes,
  │                       memoryDistillRuntime, memoryDistillModel, memoryDistillLang,
  │                       mergeAgentRuntime, mergeAgentModel])
  │    └─ save.mutate() → PUT /api/config  (mergePatch;null 键删除→继承 defaultRuntime)
  │         · 运行时选择器交互 → { xRuntime: v, xModel: null }（D6：一并清 legacy model）
  │         └─ 后端 resolveInternalAgentRuntime(runtimeName → deprecatedModel → defaultRuntime)
  └─ fusion（真实 agent 行）：本地 fusionDraft（undefined=未改→镜像已载入 pin）
       ├─ GET /api/agents/aw-skill-merger   载入当前 runtime pin
       └─ onSave 时：fusionDraft 确有变更才 → PUT /api/agents/aw-skill-merger { runtime }
             （runtime-only,后端窄例外放行；未改则不发冗余 PATCH）
```

- 单一 `onSave` = `save.mutate()`（config PUT）**＋** 条件 `fusionSave.mutate(fusionDraft)`（仅当 `fusionDraft !== undefined && !== fusionCurrent`）。`SectionForm` 的 busy/error/success 合并两条 mutation 的状态。
- 三个 `*Model` 进 slice 只为「交互时能一并置 null」,**不渲染任何 model 控件**(RFC-117 D2:model 归 profile)。fusion runtime 走本地 draft + 独立 mutation,但**不再有自己的 Save/即时保存**——并入统一 Save(实现期用户反馈)。

## 3. 接口契约

### 3.1 `Tab` 联合类型(settings.tsx)

```
type Tab =
  | 'runtime'
  | 'systemAgents'   // 新增
  | 'limits'
  // 'memory' 删除
  | 'recovery' | 'gc' | 'network' | 'appearance' | 'rendering' | 'authentication'
```

`TabBar` 顺序:`runtime` 之后紧跟 `systemAgents`(运行时注册表 → 谁用哪个运行时,概念相邻),再 `limits`……原 `memory` 项从列表移除。分发处 `{tab === 'systemAgents' && <SystemAgentsTab config={config.data} />}`,删除 `{tab === 'memory' && <MemoryTab .../>}`。

### 3.2 `SystemAgentsTab`(新)

沿用现有 `useTabState` + `SectionForm`(**整个页签一个 Save**,与其它页签一致),内部用公共 `.form-section` 把 4 个 agent 各分一节:

```
// 运行时选择器交互统一走这个 helper：设 runtime + 一并清 legacy model（D6）
function pickRuntime(state, setState, rtKey, modelKey) {
  return (v /* string | null */) => setState({ ...state, [rtKey]: v, [modelKey]: null })
}

function SystemAgentsTab({ config }: TabProps) {
  const { state, setState, save } = useTabState(config, [
    'commitPushRuntime', 'commitPushModel', 'commitPushMaxRepairRetries', 'commitPushDiffMaxBytes',
    'memoryDistillRuntime', 'memoryDistillModel', 'memoryDistillLang',
    'mergeAgentRuntime', 'mergeAgentModel',
  ])
  return (
    <SectionForm onSave={save.mutate} busy={save.isPending} error={save.error} success={...}>
      <section className="form-section">
        <div className="form-section__title">{t('systemAgents.commitPushTitle')}</div>
        <p className="settings-hint">{t('systemAgents.commitPushHint')}</p>
        <div className="form-section__body">
          <Field label={t('settingsForm.commitPushRuntime')} hint={...}>
            <RuntimeSelect value={state.commitPushRuntime}
                           onChange={pickRuntime(state, setState, 'commitPushRuntime', 'commitPushModel')}
                           ariaLabel={...} />
          </Field>
          <div className="form-grid form-grid--cols-2">
            <Field .../* commitPushMaxRepairRetries */>
            <Field .../* commitPushDiffMaxBytes */>
          </div>
        </div>
      </section>

      <section className="form-section"> {/* 记忆提取:RuntimeSelect(pickRuntime …DistillRuntime/Model) + memoryDistillLang Select */} </section>
      <section className="form-section"> {/* 合并冲突解决:RuntimeSelect(pickRuntime mergeAgentRuntime/mergeAgentModel) */} </section>
      <FusionAgentCard /> {/* 技能融合:独立 GET/PATCH agent 行,不进上面这个 config SectionForm 的保存 */}
    </SectionForm>
  )
}
```

- config 型三节的字段控件**逐字复用**从 `LimitsTab` / `MemoryTab` 迁出的既有 JSX(同 `RuntimeSelect` / `NumberInput` / `Select` 用法、同 i18n 值 key、同 `data-testid`),仅换外层 section 包裹 + runtime `onChange` 改走 `pickRuntime`(D6),其余零行为变化。
- `memoryDistillLang` 的 `<Select>` 连同 `data-testid="settings-memory-distill-lang-select"` 原样搬入记忆提取节(测试锚点不破)。
- **D6 语义**:`pickRuntime` 令 runtime 选择器每次交互都 `xModel: null`。留空(继承)时删 runtime + 清 legacy model → `resolveInternalAgentRuntime` 直落 `defaultRuntime`;选定 profile 时 runtimeName 本就压过 model,清 model 只是渐进清理。`*Model` 字段仅入 slice、**不渲染控件**。

### 3.3 `FusionAgentCard`(新,内联 runtime 选择器 —— 写 agent 行)

```
function FusionAgentCard() {
  const { t } = useTranslation(); const qc = useQueryClient()
  const q = useQuery<Agent>({ queryKey: ['agents', 'aw-skill-merger'],
    queryFn: () => api.get('/api/agents/aw-skill-merger') })
  const save = useMutation({
    mutationFn: (runtime: string | null) =>
      api.put<Agent>('/api/agents/aw-skill-merger', { runtime }),   // runtime-ONLY body
    onSuccess: (a) => qc.setQueryData(['agents', 'aw-skill-merger'], a),
  })
  return (
    <section className="form-section">
      <div className="form-section__title">{t('systemAgents.fusionTitle')}</div>
      <p className="settings-hint">{t('systemAgents.fusionHint')}</p>
      <Field label={t('systemAgents.fusionRuntime')} hint={...}>
        <RuntimeSelect value={q.data?.runtime ?? null}
                       onChange={(v) => save.mutate(v)}   // v: string | null（继承发 null）
                       ariaLabel={t('systemAgents.fusionRuntime')} />
      </Field>
      {/* save.isPending / save.error 就地反馈；可选一个「在 /agents 查看定义」次要链接 */}
    </section>
  )
}
```

- **写路径必须是 runtime-only**:body 恰好 `{ runtime }`(一个键),命中后端 `isRuntimeOnlyAgentPatch`(`routes/agents.ts:43-46`,keys.length===1 && keys[0]==='runtime')→ 绕过 `assertNotBuiltin`;`{runtime:null}` 同样命中(清 pin→继承 `defaultRuntime`)。**切勿**混入其它键,否则 403 `builtin-readonly`。
- `aw-skill-merger` = 后端 `SKILL_MERGER_AGENT_NAME`(`services/systemResources.ts:35`);前端硬编码该字符串(加源码文本锁对齐)。
- **权限**:`PUT /api/agents/aw-skill-merger` 经 `requireResourceOwner`,builtin 是 `__system__`-owned → **仅 admin** 可存。`GET /api/agents/:name` 经 `loadVisibleAgent`(builtin public 可见)。整个「系统 Agent」页签与 `/api/config`(同为管理面)一样面向 admin;非 admin 保存会 403——与其余三卡一致,不特殊处理(可选:非 admin 时禁用,留 impl 判断)。
> **实现落地(用户实现期反馈,与上方初稿的两处差异,以代码为准)**:
> 1. **单一 Save,不再即时保存**。fusion 不再 `onChange→PATCH`;改为本地 `fusionDraft` + 与 config 三卡**共用一个 Save 按钮**:`onSave = save.mutate()` ＋(仅当 fusionDraft 变更)`fusionSave.mutate()`。消除「保存按钮下方还挂一张自保存卡」的割裂与「Save 存哪些」的歧义。因此 `FusionAgentCard` 不再是独立组件,fusion 的 query/mutation/draft 收进 `SystemAgentsTab`,fusion 卡与其余三卡同为 `SectionForm` 子节点(渲染在 Save 按钮之上)。
> 2. **每个内置 agent 包成独立带边框卡片**。四块原为裸 `.form-section`(仅 margin,无边框)→ 视觉糊在一起;改用共享 `<Card>` 原语(RFC-124:panel 背景 + border + radius + padding)经一个本地 `AgentCard({title,hint,children})` 包装,四块清晰区隔。复用公共原语、零新增 CSS(仅挂一个 `system-agent-card` class 备用),符合前端一致性铁律。渲染层锚点仍是 role=combobox aria-label + `data-testid`,不依赖 `.form-section`,故测试不受影响。

### 3.4 `LimitsTab` 瘦身

从 `useTabState` slice 与 JSX 双双移除 `commitPushRuntime` / `commitPushMaxRepairRetries` / `commitPushDiffMaxBytes` 三键及其对应 `<Field>`(含 `RuntimeSelect` 与那对 `form-grid--cols-2` 的 NumberInput)。移除后 `RuntimeSelect` 若在 `LimitsTab` 已无其它用处则该文件仍需 import(记忆节/merge 节仍用),整体 import 不删。

### 3.5 `MemoryTab` 删除

整函数删除 + 分发处删除 + `TabBar` 项删除。**注意**:`MemoryTab` 当前是 `export function`,被 `settings-memory-distill-lang.test.tsx` `import { MemoryTab }`——删除会破测试导入,测试须改为 `import { SystemAgentsTab }`(见 §6)。

### 3.6 shared `ConfigPatchSchema` 补洞

```
// config.ts ConfigPatchSchema.extend({...})
memoryDistillRuntime: z.string().min(1).nullable().optional(),
commitPushRuntime:    z.string().min(1).nullable().optional(),
mergeAgentRuntime:    z.string().min(1).nullable().optional(),   // 新增
// D6：runtime 选择器交互一并清 legacy model，故这三个也要能收 null
memoryDistillModel:   z.string().min(1).nullable().optional(),   // 新增
commitPushModel:      z.string().min(1).nullable().optional(),   // 新增
mergeAgentModel:      z.string().min(1).nullable().optional(),   // 新增
```

理由:
1. RuntimeSelect 的「继承」`onChange(null)` 会发 `{ mergeAgentRuntime: null }`;基础 `ConfigSchema` 是 `z.string().min(1).optional()`(不收 null),`mergePatch` 依赖收到 `null` 才删键回退继承。不补则 merge「继承」保存 400。
2. D6 的 `pickRuntime` 会随交互发 `{ xModel: null }`——三个 `*Model` 同样须能收 null,否则任一 runtime 选择器交互都会 400。
基础 `ConfigSchema` 与后端 `resolveInternalAgentRuntime` 读取逻辑不变(仍 `min(1)`,null 仅用于 patch 删键)。

## 4. 与现有模块的耦合点

| 耦合点 | 说明 | 处置 |
|---|---|---|
| `useTabState` / `SectionForm` | 现有 per-tab 草稿 + 单 Save 原语 | 直接复用,不改。 |
| `RuntimeSelect` | RFC-117 公共运行时选择器,已服务 commit/distiller | 复用;merge 节第三个消费者。 |
| `.form-section*` | RFC-155 给 AgentForm 分节的公共 class | 复用作每个内置 agent 的分节容器。 |
| `TabBar<Tab>` | 泛型页签栏(RFC-150) | 改 `Tab` 联合 + tabs 数组;删 memory、插 systemAgents。 |
| `ConfigPatchSchema` | PUT /api/config 校验 | 补 `mergeAgentRuntime` + 三个 `*Model` nullable(§3.6)。 |
| `isRuntimeOnlyAgentPatch` + `PUT /api/agents/:name`(RFC-117 窄例外) | 后端已允许对 builtin 行发 runtime-only patch | 融合卡的写路径**复用**它,发 `{runtime}`——本 RFC 是它注释预告的「settings picker」首个消费者。**不动后端**。 |
| `resolveInternalAgentRuntime` + scheduler 派发 | 后端解析 merge/commit/distiller 运行时 | **不动**——字段语义不变,只是获得了 UI。 |
| `RESTART_REQUIRED_KEYS` | 需重启的键集 | 本 RFC 所有键均无需重启,不加入。 |
| `agents.detail.tsx` 保存 | 现发整份 draft、对 builtin 必 403 | **不动**——融合改内联 runtime-only 后不再依赖详情页;详情页 builtin 全字段只读的既有行为保持。 |

## 5. 失败模式与边界

1. **merge「继承」/ D6 清 model 保存 400**:若忘补 `ConfigPatchSchema`,merge 选「继承」发 `{mergeAgentRuntime:null}`、或任一选择器交互发 `{xModel:null}` 都会被拒 → §6 加 schema 回归锁(六个新 nullable 键都测)。
2. **融合卡混键 403**:`FusionAgentCard` 若不慎发出非 runtime-only body(多一个键)→ `isRuntimeOnlyAgentPatch` false → 403 `builtin-readonly`。mutation body **必须**恰好 `{ runtime }` → §6 render 锁断言 PATCH body 键集 === `['runtime']`。
3. **测试导入断链**:删 `MemoryTab` 导致 `settings-memory-distill-lang.test.tsx` 编译失败(import 找不到)——必须同 PR 改该测试导入到 `SystemAgentsTab`,否则 typecheck 红。
4. **stale 注释**:`settings-commit-push.test.ts` 顶注与断言注释写「Limits tab」「Memory tab」;断言本身是整文件 grep 仍通过,但注释须随迁改为「System Agents tab」以免误导(测试文件注释改动豁免测试)。
5. **融合名失效**:`aw-skill-merger` 常量若改名会致融合卡 GET/PATCH 404;前端硬编码字符串,加一条源码文本锁断言含 `aw-skill-merger`,与后端 `SKILL_MERGER_AGENT_NAME` 对齐(后端已有 builtin 名锁)。
6. **非 admin 用户**:整页(三卡 config PUT + 融合 PATCH)都是 admin 面;非 admin 保存 403。与既有 settings 一致,不特殊兜底(impl 可选禁用态)。
7. **Save 覆盖面**:config `SectionForm` 的 Save 覆盖 9 个 config 键;`FusionAgentCard` 即时保存、独立 mutation,**不**进该 slice——确认两条保存路径互不干扰。
8. **空 slice 保存**:用户不改任何字段直接 Save,`useTabState` 发的是各键当前值(与既有行为一致),幂等无副作用。

## 6. 测试策略(CLAUDE.md test-with-every-change)

### 6.1 更新既有锁

- **`settings-commit-push.test.ts`**:断言是整 `settings.tsx` grep(`toContain("'commitPushRuntime'")` 等),字段搬到新页签后**仍通过**;仅更新顶部注释与 describe 措辞「Limits tab」→「System Agents tab」。
- **`settings-memory-distill-lang.test.tsx`**:真实 render 测试。改 `import { MemoryTab }` → `import { SystemAgentsTab }`,mount `SystemAgentsTab`,经既有 `testid="settings-memory-distill-lang-select"` 定位语言 `<Select>`,三选项 / Default→undefined / zh-CN→PUT 三条断言逻辑不变(锚点随卡片一起搬,仍在)。
- **`i18n-distill-output-lang-keys.test.ts`**:distill 输出语言相关 i18n 键若键名不变则不受影响;若本 RFC 未改这些键则跑绿——确认后不动。

### 6.2 新增锁

- **`settings-system-agents.test.ts`(源码 + i18n grep)**:
  - `Tab` 联合含 `'systemAgents'`、不含 `'memory'`;`TabBar` tabs 数组含 `systemAgents`、不含 `memory`;分发含 `<SystemAgentsTab`、不含 `<MemoryTab`。
  - `SystemAgentsTab` 的 `useTabState` slice 含全部九键(三 runtime + 三 model + commitPush 两旋钮 + memoryDistillLang)。
  - 渲染绑定:`state.mergeAgentRuntime` + `t('settingsForm.mergeAgentRuntime')` 出现;融合卡的 GET/PATCH 目标含字符串 `aw-skill-merger`。
  - `LimitsTab` slice **不再**含 `commitPushRuntime`(防回搬)。
  - i18n:`systemAgents.*` 页签标题/节标题/融合文案(`fusionRuntime` 等)+ `mergeAgentRuntime` label 在 zh-CN / en-US 两侧都在。
- **`settings-system-agents-render.test.tsx`(render 锁)**:mount `SystemAgentsTab`:
  - merge:`getByRole` 找 merge 运行时选择器;选 runtime → config PUT body 含 `mergeAgentRuntime:<name>` **且** `mergeAgentModel:null`(D6);选「继承」→ `mergeAgentRuntime:null` + `mergeAgentModel:null`。
  - 融合:mock GET `/api/agents/aw-skill-merger` 返回带 runtime 的行;选 runtime → 断言 PATCH `/api/agents/aw-skill-merger` 的 **body 键集 === `['runtime']`**(锁 §5.2 混键 403 风险)+ 值正确;选「继承」→ body `{runtime:null}`。
  - 用 role/testid 锚点,避开 i18n race(见 cross-clarify flaky 教训)。
- **shared config schema 锁(`packages/shared/tests` 或 backend config 测试)**:`ConfigPatchSchema.parse({...})` 对六个新 nullable 键(`mergeAgentRuntime`/`commitPushModel`/`memoryDistillModel`/`mergeAgentModel` + 既有两 runtime)传 `null` 均成功;传 `''` 均失败(min(1) 仍在)。锁住 §5.1。

### 6.3 门槛

`bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿(pre-push gate,记忆 prepush-gate-includes-lint);frontend vitest 单独跑(记忆 frontend-i18n-batch:frontend 测试在 vitest 非 `bun test`);推后查 GitHub Actions(含 build:binary smoke + Playwright e2e)。Playwright 若有 settings 页签视觉基线,页签集变化(+systemAgents / −memory)会刷新基线——需同步更新截图基线(参照 RFC-155 视觉基线刷新流程)。

## 7. PR 拆分

单 RFC 单 PR(改动集中、互相依赖:schema 补洞 + 前端搬迁 + 测试须同批绿)。commit message 前缀 `feat(frontend): RFC-156 …`。
