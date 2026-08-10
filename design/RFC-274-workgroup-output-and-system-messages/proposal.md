# RFC-274 · 工作组产出契约与系统消息本地化

状态：Done（2026-08-10）

## 1. 背景

leader-worker 工作组在声明 done 时，只要存在完成 assignment 且 canonical worktree 零变更，
`warnIfZeroDeltaDone` 就发“outputs may not have merged”告警。这条启发式源于文件生产型工作组
的 merge-back 故障，但评审、架构讨论、风险研判等工作组本来就只在房间给结论，不写文件，
于是每次成功都被标成疑似失败。

同时，房间系统消息从 `leaderWorker.ts`、`freeCollab.ts`、`engine.ts` 等多处直接拼英文
`bodyMd`。zh-CN 用户看到系统作者标签已翻译、正文却突兀英文。后端没有模板 key/参数层，
只翻零-delta 一条会让同一房间更不一致，也无法按观看者语言呈现历史消息。

两者同属“平台在房间里对执行状态作解释”的可信度问题：平台必须知道工作组承诺的是文件
还是讨论结论，并用可本地化、可回退、对 agent 仍稳定的消息契约表达判断。

## 2. 目标

1. 工作组显式声明 `outputContract:'files'|'discussion'`。
2. 只有 files 工作组运行 zero-delta merge advisory；discussion 工作组不调用 git delta probe。
3. 存量与字段缺失默认 files，避免静默取消已有防护。
4. 所有平台作者、可枚举语义的房间系统消息使用 closed template key + typed params + 英文 fallback。
5. 前端按每个观看者当前 locale 渲染模板；agent 上下文、旧客户端和历史行继续使用 fallback。
6. 系统消息的动态参数、引用、搜索、WebSocket/HTTP DTO 在新旧版本间可兼容。

## 3. 非目标

- 不把所有 `authorKind:'system'` 消息强制翻译。agent 生成的 summary、用户输入和不可枚举的
  runtime 诊断仍是原文，template key 为 null。
- 不改变 done/gate/assignment 状态机，不让 discussion 自动 done，也不禁止它写文件。
- 不根据“当前有没有 diff”反推 output contract；契约是作者意图，不是运行结果猜测。
- 不在后端选择某个用户语言并把翻译文本持久化；一个房间可被不同 locale 用户同时观看。
- 不删除 `body_md`，不批量重写历史消息，不要求 agent 理解 i18n key。
- 不把错误详情当 HTML/Markdown 模板执行；UI 仍按当前纯文本 body 规则显示。

## 4. 产品决策

### D1 · 新配置维度

workgroup resource、launch snapshot 和 task-level editable config 都携带：

```ts
outputContract: 'files' | 'discussion'
```

- create 缺失 ⇒ files；
- full update 缺失 ⇒ 保留 existing（不能被 schema default 偷改）；
- legacy resource/task snapshot 缺失 ⇒ files；
- UI 创建/编辑用两张 choice cards：文件交付（默认）/讨论结论；只读详情也展示。

### D2 · zero-delta 只属于 files

`warnIfZeroDeltaDone` 第一条业务判断是 `outputContract==='files'`。discussion 直接 return，甚至
不调用 `getCanonicalFilesChanged`；这既消除误报，也避免无意义 git IO。files 的原判据、软告警
而非阻断语义、git 失败吞掉语义均保持。

### D3 · 契约进入 prompt，但不变成硬权限

每个 member/leader prompt 明示期望交付：files 要把成果写入自己的 working copy 并走 merge；
discussion 要把可执行结论写入房间/最终 summary。它只是协作协议，不从 tools 中删 write，
discussion 仍可在验证需要时产生文件。

### D4 · system message 双表示

`workgroup_messages` 保留 `body_md` 作为 `bodyMdFallback`，新增 nullable
`template_key`、`template_params_json`。三者规则：

- platform templated system row：closed key + schema-valid params + nonempty fallback；
- legacy / agent-authored / human/member row：key/params 均 null，body 原语义；
- key 与 params 必须同时 null 或同时非 null；非 system author 不得写 template。

fallback 统一英语，供 agent prompt、日志、旧 UI、CLI 和回滚版本使用；不是当前观看者翻译缓存。

### D5 · closed registry 是单一事实源

shared 定义 template key union 与每 key 的 params schema；backend helper 同时生成 row fields 与
英文 fallback；frontend i18n 以同一 key union 做 exhaustiveness guard。禁止调用点裸写
`templateKey:string` 或自行 `JSON.stringify` params。

### D6 · 前端按观看者 locale 渲染

RoomTimeline 对 template row 解析 params 后调用 `t('workgroups.systemMessages.<key>', params)`；
缺 translation、未知 key、malformed params 一律显示 `bodyMd` fallback 并报告非致命诊断。
message reference、搜索摘要和复制正文使用同一 renderer，不能主消息已翻译而引用仍英文。

### D7 · 平台消息一次性迁移，动态原文保留

实现批次枚举所有 backend `authorKind:'system'`/平台 decision callsite：固定语义迁 registry；
agent summary/result body 不套模板。新增源码守卫禁止再次出现“system + 英文模板字面量”绕过
helper，但保留有注释的 dynamic-original allowlist。

## 5. 能力与兼容性影响清单（需确认）

- **C1（可选告警关闭）**：选择 discussion 后，zero-delta advisory 完全不运行；files 与所有
  存量组保持现状。讨论型不再误报，误选 discussion 的文件组也会失去该软提示。
- **C2（默认不变）**：旧 resource、旧 task snapshot、缺字段 API 请求全部按 files；不会因升级
  静默减少防护。
- **C3（观看文本变化）**：支持 locale 的新 UI 会把平台 system message 显示为观看者语言；
  agent、旧客户端、导出/日志仍看到英语 fallback。同一行在不同用户屏幕上正文可不同。
- **C4（wire 扩张）**：Workgroup DTO/配置包增加 outputContract，message DTO 增 nullable template
  metadata；旧字段 `bodyMd` 不删除。
- **C5（存储扩张）**：新增一个 workgroups 列和两个 message 列；历史 message 不回填模板，
  新 UI 对它们继续原样显示。

## 6. 用户故事

- 作为架构评审组作者，我选“讨论结论”，所有 assignment 完成、房间有结论且文件零变更时，
  不再收到 merge 丢失告警。
- 作为代码实现组作者，我保留“文件交付”，worker 写到错误绝对路径时仍看到 zero-delta 告警。
- 作为 zh-CN 成员，我看到“已达到回合上限”等平台消息为中文；切换 en-US 后同一历史行立即
  显示英文，而 agent 所见上下文不随观看者切换。
- 作为运维者，我回滚到旧 binary 时，新消息仍有完整 `bodyMd` fallback，不会空白。

## 7. 验收标准

- **AC-1** create 默认 files；full update 省略保留；legacy task snapshot 缺字段解析为 files。
- **AC-2** discussion done 不调用 canonical delta hook、不发告警；files 零 delta 保持原告警。
- **AC-3** files 有 delta、零 done assignments、git probe failure 的原分支字节语义不变。
- **AC-4** resource create/update/copy/package export-import round-trip outputContract。
- **AC-5** task launch/mid-run config edit冻结/保留 outputContract，prompt 明示但 tool 面不收缩。
- **AC-6** migration 为存量 workgroups 回填 files；message 历史行 key/params null、body 不变。
- **AC-7** registry 每个 key 有 strict params schema、英文 fallback 和 zh/en translation。
- **AC-8** platform templated row 的 key/params/fallback 原子生成；非法组合在构造与 DB 层拒绝。
- **AC-9** agent summary/用户正文不被模板化、不被翻译、不被当 i18n 参数执行。
- **AC-10** 主消息、reply reference、搜索/复制使用同一 viewer renderer；locale 切换即时生效。
- **AC-11** unknown key/malformed params/缺翻译安全 fallback，不让整个 room DTO/render 失败。
- **AC-12** backend system callsite 全量盘点有结构守卫，新硬编码英文不能绕过 registry。
- **AC-13** 390px/桌面、light/dark、zh/en 真浏览器验证，长参数不造成横向溢出。
