# RFC-148 · prompt/clarify 协议 ADT + RFC-132 收尾（design）

> 行号为 2026-07-08 调研实测（两路 fan-out 交叉核对）。

## 1. 死活判定总表（调研实录）

### 1.1 死族（生产零生产者/零调用，仅测试保活）

| 项                                                           | 位置                                               | 死判据                                                             |
| ------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------ |
| `crossClarifyContext` 字段+透传                              | `prompt.ts:261`、`runner.ts:160/:725-726`          | scheduler 全域零赋值；runNode 五调用点均不传                       |
| `## External Feedback` 渲染段                                | `prompt.ts:556-576`                                | xcc 恒 undefined                                                   |
| `__external_feedback__`/`_iteration__`/`_sources__` 3 token  | BUILTIN_VARS `prompt.ts:337-339` + 代换 `:431-436` | 恒空替换                                                           |
| `CrossClarifyPromptContext`                                  | `prompt.ts:160-187`                                | 生产零构造                                                         |
| `ClarifyPromptContext.questionsBlock/answersBlock/directive` | `prompt.ts:92-93/:109`                             | scheduler:2700-2713 组装恒不含                                     |
| legacy 轮次分组段                                            | `prompt.ts:522-542`                                | cc 定义 ⟹ flatBlock 非空（clarifyQueue.ts:301/315）⟹ :515 恒先命中 |
| `__clarify_questions__`/`__clarify_answers__` 2 token        | `prompt.ts:423-426`                                | 后备字段零生产者                                                   |
| `currentRoundOnly`                                           | `prompt.ts:537`（唯一消费，在死段内）              | 生产恒与 inline 成对（scheduler:2710-2712），且消费点不可达        |
| `buildClarifyPromptBlock`                                    | `clarify.ts:236-258`                               | 生产零调用                                                         |
| `buildExternalFeedbackBlock`（+`CrossClarifySourceContext`） | `clarify.ts:473-496/:458-464`                      | 唯一链 renderCrossClarifySource 仅测试                             |
| `renderCrossClarifySource`                                   | `clarify.ts:499-501`                               | 仅测试                                                             |
| `renderManualFeedbackSection`                                | `clarify.ts:512-521`                               | 全仓零 caller                                                      |
| `renderClarifyQuestionsBlock`                                | `clarify.ts:203`                                   | 唯一 caller 是死的 buildExternalFeedbackBlock                      |

### 1.2 活域（保留，golden 锁）

flatBlock（scheduler:2705 唯一产出）、`iteration`/`remaining` + 对应 2 token
（scheduler:2706-2707 活产）、`mode:'inline'` 4 个活消费（prompt.ts:447/457/595/638，
死的 :524/:537 随段删）、hasClarifyChannel（:597/:637 + runner:1208 门）、
priorOutputUpdate（:590-604）、clarifyStopNotice（:615 → renderClarifyDirectiveTrailer）、
clarifyStopped/clarifyMode（runner 解析层 :1218/:1240 门）、
renderEnvelopeFollowupPrompt 全链、`__external_feedback__` 端口名域（RFC-147 领地）。

## 2. T1 golden 表 + 防回潮断言（先钉）

新 `packages/shared/tests/prompt-golden-matrix.test.ts`（vitest? shared 测试跑 bun——
落 backend tests 惯例位 `packages/backend/tests/rfc148-prompt-golden-matrix.test.ts`）：

- 参数化行：{hasClarifyChannel} × {mode isolated/inline} × {flatBlock 有/无} ×
  {reviewContext absent/reject/iterate} × {priorOutputUpdate 有/无（askback vs update
  变体）} × {clarifyStopNotice} 的**活组合**（≈16 行代表格），每行锁
  `renderUserPrompt(...)` 完整输出字节（模板字面量内嵌期望，非 snapshot 文件——仓库
  无 snapshot 惯例）。
- followup 侧：`renderEnvelopeFollowupPrompt` reason 6 值 × clarifyDirective ×
  perKindRepairBlocks 代表组合。
- 防回潮断言（同文件）：backend+shared src 剥注释扫描——`crossClarifyContext:` 构造
  赋值零再现（runner 类型管道删后无豁免）、`buildClarifyPromptBlock(`/
  `buildExternalFeedbackBlock(`/`renderCrossClarifySource(`/
  `renderManualFeedbackSection(` 零调用、`questionsBlock:`/`answersBlock:` 生产赋值
  零再现。**T1 提交时这些断言部分已绿**（本就零生产者），T2 删除后全绿。

## 3. T2 删除接线表

| 动作                    | 文件                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 删 §1.1 全部渲染侧项    | prompt.ts（字段/段/token/接口）、clarify.ts（5 函数+1 接口）                                                                                                           |
| 删死管道                | runner.ts:160 字段 + :25 import + :725-726 透传                                                                                                                        |
| BUILTIN_VARS 减 5 token | prompt.ts:337-339 + questions/answers 两行（保留 iteration/remaining）                                                                                                 |
| 测试删除                | `cross-clarify-prompt-rfc056.test.ts`、`cross-clarify-prompt-injection.test.ts` 整文件                                                                                 |
| 测试重写                | `clarify-prompt-injection.test.ts`（:17-63 legacy 段用例 + :143-144 token guard）、`clarify-prompt-inline.test.ts`（legacy 标题分支用例，保留 inline reminder 行为锁） |
| 测试拆分                | `cross-clarify-update-mode.test.ts` / `prompt-inline-crossclarify-multirepo.test.ts`（保留 multi-repo/inline 活部分）                                                  |
| 测试大删                | `clarify-baseline-prompt-render.test.ts` / `clarify-utils.test.ts` / `clarify-cross-rfc056.test.ts` / `clarify-cross-resolvers-edge.test.ts` 的死函数 describe         |
| rfc120 适配             | `rfc120-deferred-dispatch.test.ts:2310/2329` crossClarifyContext 用例                                                                                                  |

## 4. T3 判别联合

### 4.1 promptMode（runner 渲染分派）

```ts
// shared/prompt.ts（类型与 renderer 同居）
export type PromptMode =
  | { kind: 'initial' }
  | {
      kind: 'followup'
      resumeSessionId: string // D2 修订：非法态「followup 无 session」不可表示
      reason: EnvelopeFollowupReason // RFC-145 单源，消灭 runner 内联第三份
      clarifyDirective?: 'continue' | 'stop'
      portValidations?: ReadonlyArray<PortValidationFailure>
    }
```

- RunNodeOptions：`envelopeFollowup?/envelopeFollowupReason?/
envelopeFollowupClarifyDirective?/envelopeFollowupPortValidations?` 四字段 →
  `promptMode?: PromptMode`（缺省 = initial）+ 既有 `resumeSessionId`（保持独立字段：
  followup ⟹ resumeSessionId 由 scheduler 保证，运行时守卫替代类型强制——避免把
  session 恢复语义卷进渲染类型）。
- runner 5 处散装守卫（:515/:534/:646/:668/:699）改 `opts.promptMode?.kind ===
'followup'` 判别；`?? 'envelope-missing'` 兜底删除（reason 随臂必填）。
- scheduler 组装点（:2942-2958）改产 promptMode 对象。

### 4.2 clarifyChannel

```ts
export type ClarifyChannel =
  | { kind: 'none' }
  | { kind: 'self' | 'cross'; stopped: boolean; injectStopNotice: boolean }
```

- 吸收 RunNodeOptions 四散装：hasClarifyChannel（=kind!=='none'）、clarifyMode
  （self/cross）、clarifyStopped、clarifyStopNotice。
- 消费点改造：runner:1208（clarifyActive ⇒ channel.kind!=='none' && !stopped）、
  :1218（stopped 门）、:1240（cross ⇒ maxQuestions∞）；renderUserPrompt 入参
  hasClarifyChannel/clarifyStopNotice → channel（:597/:615/:637 三处改判别）。
- scheduler :2742-2765 三个派生布尔收敛为一次 channel 对象构造（resolveEffective
  ClarifyChannel + nodeStopOverride + shouldInjectStopNotice 的结果打包）。
- 非法组合（stopped 而无通道）类型不可表示——runner:1218 的 `clarifyStopped===true
&& kind==='clarify'` 防御分支随类型收窄简化。

### 4.3 签名波及控制

调研实测：生产调用方仅 2（runner:710 / PromptPreview:48）+ 测试 15 文件。顺序：
T1 golden 表先收敛代表性 fixture → T3 改签名时 golden 表单点更新、散文件只做机械
适配；`rfc122-clarify-directive-oracle` 的 `Partial<Parameters<...>>` 推断自动漂移。

## 5. T4 sessionMode 拍板（D1）

删死后 inlineMode 活消费仅 4 处且语义正交（模板替换值 :447 / 端口自动段 :457 /
prior-output 门 :595 / trailing :638）——**不做策略对象**（audit 提议基于删前 7 处
印象；4 处 if 已是最小形态，强行表化增加一层间接却无新增维收益）。处置：4 处各加
槽位注释（substituteInputs/inputPortSections/priorOutputSection/trailing）+ golden
矩阵 inline 轴全覆盖。若未来 mode 增第三值再表化。

## 6. 决策记录

- **D1** sessionMode 不策略对象化（§5）。
- **D2** promptMode 不吸收 resumeSessionId（§4.1——渲染模式与会话恢复分层）。
- **D3** golden 用模板字面量内嵌期望而非 snapshot 文件（仓库零 snapshot 惯例，
  内嵌期望 review 面前置）。
- **D4** `__clarify_iteration__`/`__clarify_remaining__` 保留（调研修正：活产）；
  模板引用扫描不需要（token 继续工作）。
- **D5** 死函数所在测试的删除属于「死代码的棺材钉」，不算削弱覆盖——它们锁的
  是零生产者代码的内部行为。

## 7. 测试策略

§2 golden 表 + 防回潮断言；§3 表列测试处置；纯行为锁群
（rfc132-flat-render / rfc100-mandatory-clarify / protocol / prompt-preview /
prompt-multi-repo-vars / prompt-system-port-no-empty-header / rerun-prior-output×2 /
runner-envelope-followup）**零改动全绿**为 T2/T3 交付判据；clarifyChannel/promptMode
新增单测（非法组合类型不可表示的编译期断言 + 判别子行为格）。

## 8. 任务分解 → plan.md（3 commit）
