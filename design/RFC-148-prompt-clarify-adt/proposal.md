# RFC-148 · prompt/clarify 协议 ADT + RFC-132 收尾（proposal）

- **状态**：Draft（G3-G10 批量授权第 4 弹，设计门后直接实现）
- **来源**：`design/flag-audit-2026-07-07.md` §5.1（RFC-G6）；RFC-132 `clarify.ts:537-538` 挂账
  （"PR-2 / PR-4 route the injectors through it and delete the round-grouped /
  External-Feedback blocks" —— (a) 注入器已路由，(b) 删除从未执行）
- **前期调研**：两路 fan-out（渲染层死活盘点 / 挂账+跨层传参图），行号以调研实测为准。
  **audit 修正三处**：①「7 个 clarify token 恒空」实为 **5 恒空 + 2 活**
  （`__clarify_iteration__`/`__clarify_remaining__` 由 scheduler:2706-2707 真实生产）；
  ②「6 处 `!== true` 守卫」实为 **5 处**（3 负 + 2 正）；③ "Always passed together"
  指 `envelopeFollowup` 与 **`resumeSessionId`** 恒配对（非四字段互配）。

## 1. 背景

RFC-132 把 clarify 注入统一到 flat 队列后，**删除半途而废**——渲染层留着三代注入路径
叠置，全部只由测试保活：

1. **crossClarifyContext 全族死**：scheduler 零赋值（grep 全域证实），
   `runner.ts:160` 字段 + `:725-726` 透传是死管道；`prompt.ts:556-576`
   `## External Feedback` 渲染段 + 3 个 `__external_feedback*__` token 恒空。
2. **legacy 轮次分组臂死**：scheduler 组装 `clarifyContext` 恒带非空 `flatBlock`
   （`clarifyQueue.block` 空则整个 context 为 undefined），故 `prompt.ts:515` 恒先
   命中、`:522-542` else-if（questionsBlock/answersBlock 段）生产不可达；
   `ClarifyPromptContext.{questionsBlock, answersBlock, directive}` 零生产者；
   `currentRoundOnly` 唯一到达路径在死段内。
3. **死函数链**：`buildClarifyPromptBlock` / `buildExternalFeedbackBlock` /
   `renderCrossClarifySource` / `renderManualFeedbackSection`（全仓零 caller）/
   `renderClarifyQuestionsBlock`——生产零调用，仅测试引用。
4. **散装布尔簇**：clarify 通道 4 字段（hasClarifyChannel/clarifyStopped/
   clarifyStopNotice/clarifyMode，类型可表示 stopped∧¬hasChannel 非法组合）+
   envelopeFollowup 四字段（flag 与载荷未打包，`?? 'envelope-missing'` 容错补丁，
   runner 内 5 处散装守卫，reason union 在 runner 还有第三份逐字拷贝）。

## 2. 目标

1. **T1 先钉**：活路径参数化 golden 表（8 轴矩阵）+「零生产者」防回潮断言先行落地
   ——删除与重构全程有字节级护栏。
2. **T2 RFC-132 收尾删除**：§1 的 1/2/3 全删（含 5 个恒空 token、死渲染段、死函数链、
   死透传管道），测试侧按盘点清单删/重写；活路径 golden 字节零变化为交付判据。
3. **T3 判别联合**：
   - `promptMode`（runner 渲染分派）：`{kind:'initial', …} | {kind:'followup',
resumeSessionId, reason, clarifyDirective?, portValidations?}` ——四散装字段
     打包、`?? 'envelope-missing'` 兜底消灭、reason union 第三份拷贝消灭、5 处散装
     守卫改判别；
   - `clarifyChannel`：`{kind:'none'} | {kind:'self'|'cross',
directive:'mandatory'|'suppressed'|'stopped', injectStopNotice}`——设计门修订：
     三态 directive 保住「cross 接线在但本次不强制」的正交活状态（review 重跑
     抑制时解析 cap 语义仍随 kind 走），非法组合类型不可表示。
4. **T4 sessionMode 渲染分支归拢**：删死后活分支仅 4 处（替换值/端口段/prior-output
   门/trailing）——**拍板不强行策略对象化**（4 处语义正交、if 形态已最小），以注释
   槽位语义 + inline 语义格测试锁定（audit 的策略对象提议基于删除前 7 处的印象）。

## 3. 非目标

- **`__external_feedback__` 端口名域不碰**——RFC-147 系统通道端口注册表的领地
  （validator/dispatchFrontier/taskQuestionDispatch 的端口引用全部活线）；本 RFC 只
  删「经 crossClarifyContext 的 designer 渲染路径」。
- `renderClarifyDirectiveTrailer` 保留（被 `prompt.ts:616` clarifyStopNotice 活调用）。
- `renderFlatClarifyQueue` / flatBlock 主路径零改动（字节锁护航）。
- `decideResumeSessionId` / sessionMode 服务层解析（已收口良好）不动。
- 前端 PromptPreview 只随签名机械适配（不传 clarify ctx，行为零变化）。

## 4. 验收标准

1. golden 表先行提交且在 T2/T3 全程保持绿（活路径字节零变化的机器证明）。
2. §1 死族清单全删；防回潮断言（crossClarifyContext 构造 / 死函数名 /
   questionsBlock·answersBlock 生产赋值）翻红机制生效。
3. `promptMode`/`clarifyChannel` 判别联合落地：非法组合类型不可表示、
   `?? 'envelope-missing'` 与 reason 第三份拷贝消灭、runner 守卫改判别子。
4. 受影响测试按盘点清单处置（删 2 文件、重写 2 文件、拆分 2 文件、
   大删 3 文件的死函数 describe；纯行为锁群零改动全绿）。
5. 门禁 + CI conclusion=success + Codex 双门收敛。
