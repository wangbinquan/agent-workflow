# RFC-378 技术设计

> In Progress，用户已于 2026-10-18 批准实现与自主验收。设计基线 `293c1951fc1c56afcef9bb8ddb42d0d300b1308d`；RFC-294 2026-10-16 目标合同和 RFC-372 轻量合同为边界。实际候选与验收见 [acceptance.md](acceptance.md)。

## 1. 落位与单写源

| 内容                         | owner / 层                            | 实现约束                                                                                    |
| ---------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------- |
| 答案补充、确认摘要、推荐指导 | shared schema / 纯函数                | 沿现有问题和答案 DTO；不新增持久生命周期                                                    |
| 全景、聚焦、复核、引用追问   | frontend clarify feature              | 路由持有唯一答案和 durability controller；复用 Dialog、Form、Segmented、Select、ErrorBanner |
| 草稿、封存、归属、同轮追加   | collaboration                         | 原 commands / store / submit；不从 task-execution 内部取新业务能力                          |
| 模型执行和运行时绑定         | task-execution ports / infrastructure | bootstrap 选择既有 SystemAgentRunFamily；composition 仅构造注入                             |
| 起步模板                     | frontend workflow-starters            | 原候选校验、应用、历史与 launch，不创建另一种任务                                           |

本次消除追问固定本地执行工厂这一处部署选择旁路。其他 System family / composition 的历史结构不扩大重构；不新增 context 边、全局注册表或新的执行工厂。两个现存入口根仍存在属于 RFC-294 S2 的存量债，本次对两个根一致接线。

## 2. 答案合同

在既有 ClarifyAnswer / ClarifyDraftValue / 草稿请求 DTO 增加可选 `decision`，定义一次并共享：

```ts
type ClarifyDecision = {
  status?: 'decided' | 'provisional'
  rationale?: string // 0..2000，用户写下的依据
  tradeoff?: string // 0..2000，接受的代价
  uncertainty?: string // 0..2000，尚未验证或仍未知
  validationOwner?: string // 0..200，角色或人名文本，不自动分派
  revisitWhen?: string // 0..500，时间或触发条件，不创建定时任务
}
```

无 decision 或无 status 表示“未标注”。不解析自然语言来自动认定 decided/provisional，不从已确认或填写补充字段反推状态。空白可选字段规范化为缺省；空对象规范化为无 decision。只有用户明确选择才写 status，允许只填写依据或待验证内容而不标注成熟度；同一规范化函数用于比较、确认、提示和展示。

待验证、负责人和复核时机与 status 独立：已决定仍可以保留未知和复核安排，切换状态不得隐藏或清空已有字段。详情允许展开编辑；提交复核和最终输出展示所有已填字段。新生成问题不替用户预填答案、决定状态或待验证事实；仅提示输入方向。

`clarifyAnswerBasis` 仅在 decision 存在时把规范化 decision 加到既有哈希输入；缺省保持历史哈希字节语义，历史已确认答案无需重做。修改任一内容字段会清除确认；重新确认仍走现有草稿写入。

需要完整更新的链路包括：

- `schemas/clarify.ts` 的答案与 `ClarifyRoundDtoSchema.draftAnswers` 内联 schema（当前 472～479 行），以及 `schemas/resourceAcl.ts` 的草稿请求/值；
- `clarify.detail.tsx` 的服务端映射、本地恢复、写草稿及提交映射；
- 集中回答消费者和封存 DTO 的复制点；
- collaboration `draftMatchesAnswer`、`sealAnswersServerSide`、逐题归属冻结；
- 原有效答案覆盖草稿、部分锁定题、追加问题上下文与最终提示。

原 JSON 列容纳附加字段，不加表或迁移。普通 questions 模式不新增必填、不启用新的确认门；读取或展示包含 decision 的历史答案时完整保留内容。

## 3. 确定性投影与 UI

新增 clarify feature 下的纯投影：回答摘要使用当前选择的 option label 与 customText，显示长度受限但完整内容可在详情和复核中读取；决定摘要直接取用户字段，不另调模型。聚合统计分别计算回答确认数、暂定数和未标注数，不把决定状态混入原提交资格。

`MindmapWorkspace` 接收原 answers / onChange，继续复用同一 QuestionForm。`MindmapQuestionPane` 展示决定补充及追问指引；变更经路由唯一回调。全景卡片由 Canvas 的轻量节点投影扩展，节点高度由摘要行数的有限档位计算，保持可见裁剪和 Worker 布局；不为所有节点挂载表单。

单链分类压缩只作用显示投影：仅压缩“无直接问题且只有一个子分类”的节点，保留完整原路径、聚合身份、目标映射和面包屑。有分叉、有直接问题或用户显式定位的路径仍可展开。不得修改持久 categoryPath 或父问题 ID。

提交复核用原 Dialog，输入弹窗禁止点遮罩丢弃。复核是原提交 mutation 的前置展示，snapshot 取当下 answers 与 questionSetKey；提交前读取最新 durability 状态。若问题集或答案已变更，刷新复核并保留内容，不另造 confirmation ledger。原提交后的轮次保持只读，摘要仍可查看。

## 4. 主动追问

复用现有 `onFollowup(target, instruction)` 与 2000 字符限制。选区最多 500 字符，显示来源标签和可清除的引用；引用与用户指引合成一份有界 instruction，界面按合成长度提示剩余额度。字段超限明确提示，不静默截掉用户问题。选区无内容、跨多个问题或不属于当前详情时仍可自由输入；移动端用选择文本或普通追问输入均可。

四个入口是可编辑指引模板，不自动发送：检查依据（缺少何种证据）、考虑代价（受影响者和不利后果）、比较做法（同一取舍的替代方案）、自由追问。生成仍追加同轮 1～4 个问题，保留原 parentQuestionId / category target、幂等、取消、迟到响应与原提交阻断合同。

既有 `clarifyFollowupContext` 的答案投影加入可选 decision，让追问尊重暂定与复核安排；保留原上下文上限。指导文本增加原子取舍、非互斥多选、条件推荐和禁止装饰分类规则。当前接口只生成问题，UI 不承诺通用 AI 解释聊天。

## 5. 托管执行修复

现场错误：`clarify-followup-spawn-failed ... Executable not found in $PATH: "opencode"`。

`composeClarifyFollowupGenerator` 当前直接构造 `composeLocalSystemAgentRunFamily`。PostgreSQL 入口的 narrative / memory / intent 已使用 `input.systemAgentRunFamily`，追问遗漏了已选 factory。`createCrewStationSystemAgentRunFamily` 已提供与本地兼容的 family 和 bindRuntime，能复用远程执行和内容保留设施。

设计：追问装配接收一份已构造的 `{ family, bindRuntime }` 语义绑定，或由入口注入已选 family factory；不在生成器中读取部署环境或自行选本地回退。优先复用同入口已构造且相同 observation 配置的 System family binding；若确需独立实例，只在 bootstrap 构造一次并说明生命周期。两个根同步传入；原 frozen protocol/model/config、取消信号、180s 预算、retainedContents 释放和 observationDemand 归属保持。

功能回归必须通过实际装配验证：注入可追踪的非本地 factory 后，调用真实 generator，观察同一 binding 被调用且不发生本地 spawn；另保留真实本地 smoke 与托管真实追问。不得只断言源码出现某个字符串。

公开错误仍经原 PublicError 映射，追加适合用户的追问说明和重试动作，不让产品流程依赖阅读后台日志。

## 6. 起步模板与最终输出

在 `workflow-starters.ts` / `WorkflowStarterDialog` 新增 `mindmap-clarify` 与 `clarifier` 角色。选择已有可用代理及一个承载文本的输出端口；原预检发现无文本输出时说明缺口。应用模板生成 task input、agent、mindmap clarify、output 节点，澄清通道使用原连线辅助，不手拼分叉协议。业务输入仅是用户目标，节点提示要求先澄清后返回结果，原 schema 版本不变。

脑图答案的 render/summarise 路径追加明确的 Decision / Rationale / Tradeoff / Unverified / Validation 字段。`stop` 指令的普通问答语义保持，脑图决策上下文补充“保留未知，不替用户宣称已验证、认领责任或消除代价”。最终文档按原输出端口返回；没有输出或任务未 done 时展示真实生成状态，不以提交完成代替结果完成。

原版审计任务未返回最终输出是当时的历史观察，未据此宣称现有正式实例已修复。新候选的单机和托管完整旅程已分别取得 task done 与原始结果，最新内容质量和确切 SHA CI 按 acceptance.md 单独闭合。

### 6.1 实际失败样本驱动的内容一致性修复（2026-10-19）

第四轮原始提示仍向最终模型重复展示全部候选选项，包括用户明确未选的“共享日历”“记录与提醒”套餐。脑图的 flat Q&A 现在保留问题、单/多选类型、用户实际选中的标签、自定义原话及全部决定补充，省去未选提案；原轮次、界面与分支上下文仍保留完整选项。普通 questions 模式的提示字节结构保持。此处只改变既有上下文投影，不建立第二份答案或改写用户内容。

分支追问此前独立写死 `kind: single` 示例，现复用 shared 的 single / multi 与结构化选项示例。初始与追加问题共用的检查顺序为：确定唯一变量 → 检查选项可否同时成立 → 清除标签及说明中的独立附加决定 → 写明推荐前提与代价 → 核对分类。明确禁止通过“仅/否则/不作其他复核”人为制造互斥；历史记录与新观察、定时与事件复核都是可兼容来源或触发条件，未知记录是否存在须带可用性前提。

无基线且用户未指定具体机制/参数时，先澄清问题优先级、可观察的成功信号和可行证据，再讨论治理措施；明确请求的具体取舍仍优先处理，不新增必填证据门。格式示例给出完整的措施开/关、单一参数取值、兼容标准多选，字段沿原协议，普通问答保持；指导与示例合计控制命令行长度。

最终文档约束覆盖全文而不只覆盖引文：未选择、未决定与明确否定分别保留；推断章节也不能补造推断前提；在概要、执行范围等重复引用中保持原成熟度。决定文档优先一次完整记录每项选择与原补充，避免重复的范围清单产生新承诺。用户未要求的启用前置门不追加。用本次真实失败内容回归提示接线，随后仍须由原场景的实际模型产物证明 AC09/AC10，字符串断言不作为内容验收通过。

## 7. 测试与验收矩阵

先一次性写齐生产接线和以下用例，再集中执行功能验证：

| 层面              | 必须覆盖                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| shared            | 可选 decision/边界/规范化；旧 hash 恒等；任一字段变更失效；分类压缩与定位；单多选摘要；最终提示保留未知                      |
| backend 双库      | 草稿写读、封存、归属比较、部分锁定、集中派发；反问上下文；已选 factory 正向与取消/失败；旧 questions/self/cross 回归         |
| frontend          | 原 QuestionForm 选项不丢；决定编辑/视图共享/刷新；选区与无选区/超限；失败重试/取消/切换；最新答案复核/定位；提交一次和原阻断 |
| starter           | 原工作流校验、合法输出端口、生成回路、无代理与不可用代理、应用/取消及编辑历史                                                |
| System Mock / E2E | 完整起步→模型问题→暂定→主动追问→修改确认→刷新→复核→提交→输出；真实模型录制后固定，不用凭空合成答案代替真实证据               |
| 实机              | 单机与托管真实模型各至少一轮深入；实际任务 done 与文档内容；桌面/390/320px、浅/深色与键盘                                    |

质量权威为确切 SHA GitHub Actions，不跑本地全量门。原型阶段的浏览器检查仅证明原型交互。功能设计门/实现门只审功能正确性、完整性、用户可见行为与回归；安全相关一律不扫描、不分析、不验证、不提问、不提 findings、不提建议、不转成任务，也不得影响门结论。

## 实机验收修复补充（2026-10-19）

- 追问使用 Task Execution 既有 System Agent 的十分钟预算，保留原 AbortSignal、保留内容释放和观测归属；冻结快照中的 `__observation` 透传到 System 观测，不重查可变的运行时注册。
- 任务协作批量回答入口遇到未提交脑图轮次，显示明确的脑图入口并进入原 clarify detail；不会在批量入口初始化或封存这轮答案。跳转前等待弹窗中其他轮次本地持久化，失败阻止离开；普通问答及已封存的重答保留 defer/resubmit 合同。
- 对初始/追加题用具体形状约束独立取舍；最终输出一次回读原答案和决定补充，减少重复重述与成熟度漂移。提示约束不作为模型结果的确定保证，真实问题与原输出另留证据。
