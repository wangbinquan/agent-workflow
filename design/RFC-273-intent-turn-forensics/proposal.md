# RFC-273 · Intent 单轮产能指引与失败取证

状态：Done（2026-08-10）

## 1. 背景

Intent Builder 的形式上限很大：changeset 最多 64 ops、JSON 最多 2 MiB，单轮默认 600 秒，
stdout 默认保留 8 MiB。但真实复杂构建存在远低于形式上限的产能拐点。一次要求主工作流
覆盖 13 种节点时，连续三轮在 415/465/459 秒以 `intent-envelope-missing` 结束；退到 9 种
仍撞 600 秒 timeout；拆成“约 6 节点工作流 + 资源分批建”后稳定成功。

现有诊断无法区分这些形态：`content_json` 只有 `{code:'intent-envelope-missing'}`，stderr
为空就不落，stdout 文本超过 cap 时只是停止拼接，成功退出后 scratch 在调用方解析 envelope
之前已删。UI 虽有完整事件树和“重试本轮”，却回答不了：模型有没有说过话、最后停在哪类
消息、输出是否触顶、是完全没产出还是 envelope 被截掉。

本 RFC 不把一次现场经验伪装成 parser 能力上限；它建立可观测证据、保留失败现场，并给模型
一个明确的单轮交付预算，让复杂意图主动拆批。

## 2. 目标

1. 每个 system-agent run 记录不含正文的输出证据：是否出现 assistant text、观察/保留字节、
   cap 是否命中、最后事件 kind/type、终态结果是否出现。
2. Intent protocol 失败把该证据写进 `run_meta_json`，并在 `content_json` 给出稳定原因分类。
3. `intent-envelope-missing` 能区分“无 assistant 文本”“有文本但无 envelope”“输出被 cap
   截断”“终态结果缺 envelope”。
4. runtime 成功退出但 Intent 后处理失败时保留 scratch，交由现有保留期 GC 清理。
5. `INTENT.md` 明示单轮复杂度/字节交付预算，并要求超出时提交一个完整可用的部分批次，
   而不是读完 inventory 后无 envelope 停止。
6. UI 用本地化文案展示最可能原因与下一步，不要求用户翻 raw event tree 猜。

## 3. 非目标

- 不把正式 schema 的 64 ops / 2 MiB 上限缩小；已经能一次成功提交的大 changeset 继续接受。
- 不承诺“6 节点必成”或“第 7 个必败”；预算是生成协议，不是运行时拒绝阈值。
- 不把完整 assistant 文本复制进 `content_json` / `run_meta_json`，事件树仍是正文事实源。
- 不延长默认 600 秒 timeout，不自动无限重试，不让一个 turn 并行拆成多模型调用。
- 不永久保留 scratch，不在普通用户 API 中暴露宿主绝对路径。
- 不把 stderr 为空解释成 runtime 正常；stderr 只是证据之一。

## 4. 产品决策

### D1 · 统一的 `SystemAgentOutputEvidence`

`runSystemAgent` 对所有调用方返回：

```ts
{
  assistantTextSeen: boolean
  observedAssistantTextBytes: number
  retainedAssistantTextBytes: number
  eventTextCapHit: boolean
  unparsedStdoutSeen: boolean
  lastNormalizedEventKind: NormalizedEventKind | null
  lastRuntimeEventType: string | null
  terminalResult: 'success' | 'error' | 'not-observed'
}
```

计数按 UTF-8 字节，observed 即使超过 retained cap 也继续饱和计数；整数在安全上限处饱和，
不能溢出。`lastRuntimeEventType` 由 driver 的 closed extractor 给出并限长，不能把 raw JSON
或模型文本塞进 metadata。

### D2 · 稳定原因分类

`intent-envelope-missing` 增加 `reason`：

- `no-assistant-text`：未观察到 assistant text；
- `output-cap-hit`：观察字节大于保留字节或 capHit；
- `terminal-without-envelope`：观察到 terminal result 但保留文本中无 envelope；
- `assistant-stopped-without-envelope`：有 assistant text、未触 cap、也无合法 envelope；
- `runtime-shape-unknown`：legacy/mock driver 无法给出足够证据。

优先级为 cap > no-text > terminal > stopped > unknown。原因只是诊断，不改变 retry/预算归属。

### D3 · protocol 失败保留 scratch

Intent 调 `runSystemAgent` 时把“成功后立刻删”改成“调用方完成协议判定后释放”：

- questions 或通过正式 envelope/changeset schema 的 changeset（即使后续 draft/business validation
  有业务错误）⇒ 安全删除；
- envelope missing/malformed、ports exclusive、changeset JSON 无法解析、输出 cap 命中 ⇒ 保留；
- spawn/timeout/nonzero 等原本就是失败，维持保留；
- cancel/context superseded 不因本 RFC额外延长，沿现有生命周期处理。

保留目录仍是 `<appHome>/intent-scratch/<turnId>`，`scratch_retained=true`；默认 24 小时，boot
和 hourly sweep 清理 terminal/unknown 且过期目录。UI 只显示“现场已保留至多 N 小时”，不显示
绝对路径；管理员日志可按 turnId 定位。

### D4 · 单轮交付预算写入 `INTENT.md`

生成文档增加固定章节：

- 每轮 changeset **建议且要求模型**不超过 8 ops；
- 单轮新建/整体重写的 workflow 节点总数不超过 6；
- envelope 中 changeset JSON 目标不超过 256 KiB；
- 超出时优先交付依赖资源或一个可验证的 6-node slice，在 summary 写明剩余批次；
- 每一批都必须先输出完整 nonce envelope，不能为了“继续思考”省略本轮结果。

这些是 prompt protocol hard guidance；server parser 仍接受正式大上限，以免把成功能力收缩成
422。后续用 evidence 统计重新校准数字时，须改常量、文档和测试同一源。

### D5 · UI 诊断不替代事件树

error turn 在 code 旁展示 reason 的本地化解释、观测字节/保留字节、最后事件类型、scratch
保留状态。完整 Session event tree 继续可展开；UI 不猜“模型为什么这么做”，只呈现平台观察。

## 5. 能力与兼容性影响

- **C1（无 parser 收缩）**：64 ops / 2 MiB 接受域不变；预算只改变 agent 默认拆批行为。
- **C2（磁盘占用上升）**：clean-exit 但协议失败的 scratch 从立即删除改为默认保留 24 小时；
  受现有 GC 和配置最大 14 天约束。
- **C3（诊断扩张）**：turn DTO 的 `runMeta`/`content` 增字段；旧客户端按 record/unknown 兼容，
  旧行无字段时 UI 显示“证据不可用”。
- **C4（正文边界不变）**：新增 metadata 不含 assistant 正文、prompt、inventory 内容、路径或凭据。

## 6. 用户故事

- 作为资源作者，我看到失败卡写“本轮没有产生 assistant 文本，最后事件是 tool_use”，而不只
  是 `intent-envelope-missing`。
- 作为排障者，我能分辨模型说了一半撞到 8 MiB cap，还是完整结束却忘了 envelope。
- 作为复杂意图用户，builder 会先交付一个可提交批次并说明下一批，而不是用 10 分钟做完
  inventory 阅读后整轮作废。
- 作为管理员，我可在 24 小时窗口内检查失败 scratch，GC 之后不会永久堆积。

## 7. 验收标准

- **AC-1** observed/retained/capHit 在跨 cap 的多事件流中精确，正文拼接旧语义不变。
- **AC-2** OpenCode 与 Claude driver 都给出安全 event type/terminal result；未知 runtime 降级 null。
- **AC-3** 无 assistant text 的 clean exit 落 `reason:no-assistant-text`。
- **AC-4** 有文本无 envelope、terminal 无 envelope、cap 截断分别落正确 reason。
- **AC-5** runMeta 永远带 evidence；stderr 为空不影响 evidence 持久化。
- **AC-6** metadata/日志/DTO 不含 assistant 原文、nonce、seed file 绝对路径或凭据。
- **AC-7** protocol failure scratch 存在、权限私有、`scratch_retained=1`；成功 questions/changeset 删除。
- **AC-8** boot/hourly GC 不删 running turn，过保留期删除 terminal/unknown；删除失败只告警。
- **AC-9** `INTENT.md` 只从共享常量渲染 8 ops / 6 workflow nodes / 256 KiB，不出现复制数字漂移。
- **AC-10** 一个超过预算的 fixture 被提示分两批且每批都有合法 envelope；parser 仍接受一个
  人工构造的 9-op、>6-node 但正式上限内 changeset。
- **AC-11** zh-CN/en-US UI 展示 reason、字节、最后类型、scratch 保留提示和分批重试建议。
- **AC-12** 用户记录的 13/9/6-node 形态用 deterministic mock 重放诊断分支，真实 runtime 只作
  非门禁复验，不把模型波动写成单测。
