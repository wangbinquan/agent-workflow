# RFC-272 · 技术设计

状态：Done（2026-08-10）。先读 `proposal.md` 的 D1–D9、C1–C5 与 AC；本文只定义实现契约。

## 1. 当前锚点

| 事实                     | 当前源码                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| MCP 闭包编码             | `packages/backend/src/services/runtime/opencode/verifiedPlan.ts` 的 `planMcpConfig`                |
| local wrapper allow-back | 同文件 `materializeMcpWrappers` 的 `bindReadOnly`                                                  |
| skill 预检/冻结          | 同文件 `inspectManagedSkillTree` / `snapshotManagedSkillTree` 调用                                 |
| frozen block             | 同文件 `appendFrozenBlock`；当前只带 name/sha256/body                                              |
| owner identity           | `executionIdentity.ts#businessOpencodeIdentityDigest`，当前只规范化 shell/MCP wrapper attempt path |
| 同实例启动门             | `verifiedLauncher.ts`：providers → agents → skills → source → inventory → session                  |
| HTTP client              | `directClient.ts`：已有 `/config/providers`、`/agent`、`/skill`，无 `/mcp`                         |
| inventory                | `verifiedInventory.ts`：MCP 来自 manifest 且固定 `status:'configured'`                             |
| Claude 对照              | `runner.ts` 的 `fencedMcpServers` / `declaredMcpServers` 与 `parseUnusableMcpServers`              |

外部行为基线钉 OpenCode 1.18.14（tag 源码，不是当前 dev 分支）：

- [`httpapi/groups/mcp.ts:28-48`](https://github.com/anomalyco/opencode/blob/v1.18.14/packages/opencode/src/server/routes/instance/httpapi/groups/mcp.ts#L28-L48)：status 路由为 `GET /mcp`；
- [`mcp/index.ts:78-100`](https://github.com/anomalyco/opencode/blob/v1.18.14/packages/opencode/src/mcp/index.ts#L78-L100)：status 是 connected / disabled / failed / needs_auth / needs_client_registration 闭集；
- [`mcp/index.ts:316-385`](https://github.com/anomalyco/opencode/blob/v1.18.14/packages/opencode/src/mcp/index.ts#L316-L385)：local transport 失败和 tool-list 失败都收敛为 failed，只有完成适用的 tool list 才保留 connected；
- [`mcp/index.ts:458-493`](https://github.com/anomalyco/opencode/blob/v1.18.14/packages/opencode/src/mcp/index.ts#L458-L493) 与 [`:551-567`](https://github.com/anomalyco/opencode/blob/v1.18.14/packages/opencode/src/mcp/index.ts#L551-L567)：首次 status 读取经 `InstanceState.get` 等待配置中的 MCP 并发初始化完成后返回闭集状态。

接手实现时必须对实际 vendored/支持版本重跑这些引用；RFC 文本不是永久替代源码证明。

## 2. Manifest contract

business manifest 新增必填闭集：

```ts
mcpReadiness: {
  enabled: boolean
  servers: Array<{
    name: string
    type: 'local' | 'remote'
  }>
}
frozenSkillSeals: Array<{
  name: string
  skillId: string
  sealName: string // sha256(skillId).slice(0, 24)
  treeDigest: string
  entryCount: number
}>
identityCodec: 'business-v2-legacy' | 'business-v3-skill-roots'
```

约束：

1. 两个数组按 code point 排序、名字/skill id 去重；disabled MCP 不进入 servers。
2. local/remote 类型来自冻结 DB 投影，不从 controlled config 反猜。
3. `sealName` 必须由 `skillId` 重算，物理根恒为
   `<runRoot>/opencode-identity-seal/skills/<sealName>`。
4. readiness 即使 `inventory.enabled=false` 仍存在；inventory 不是执行 gate 的开关。
5. manifest 是 one-shot，codec 仍可整体升级；持久兼容由 owner `identityCodec` 选择逻辑承担。

`VerifiedInventoryPlan` 不再重复保存 MCP 类型闭包；构造 inventory 时接收 readiness receipt 与
manifest 闭集，避免“用于 gate 的集合”和“用于展示的集合”两份派生。

## 3. `/mcp` 解码与 readiness receipt

### 3.1 Closed decoder

`directClient.getMcpStatuses()` 用有界 schema 解码 record：key 1..256 bytes、最多 256 项；status
只接受当前支持的 closed union（connected/disabled/failed/needs_auth/
needs_client_registration）。failed 的 `error` 可为输入解码所需，但返回业务层前必须丢弃。
响应超预算、重复/非法 key 或未知形状属于 bootstrap failure，不把原 body写入诊断。

### 3.2 Pure comparator

新增纯函数：

```ts
compareMcpReadiness(expected, statuses): {
  connected: McpReadinessItem[]
  unavailableLocal: McpReadinessItem[]
  unavailableRemote: McpReadinessItem[]
}
```

只遍历 expected。status map 额外项不进入 receipt；缺 key 等同 unavailable。每项只携带
`name/type/status`，status 缺失规范为 `missing`。

### 3.3 Ordering

launcher 顺序改为：

```text
verify manifest/source/binary
spawn server + listen
providers / agents / skills
MCP status (only when expected non-empty)
source fingerprint recheck
write optional inventory
resolve/create session
emit session-ready + wait ACK
prompt
```

readiness 必须早于 session side effect，才能证明 local failure 的 session/model 调用数均为 0。
远端 warning 不改变顺序。

## 4. Runner control frame 与失败归属

新增与 session-ready 同级、闭 schema 的控制 frame（名称最终由实现选择，但必须复用
`CONTROL_LINE_PREFIX` 的 canonical base64url 编码与 16 KiB 上限）：

```ts
{
  kind: 'mcp-readiness'
  unavailableLocal: Array<{ name; status }>
  unavailableRemote: Array<{ name; status }>
}
```

runner 在 `processRunnerOpencodeControlLine` 前消费它：

- remote：写 masked structured warning 和一个 stderr/text diagnostic event，继续；
- local：设置现有 `fencedMcpFailure` 同类的可重试错误，发起终止；不写
  `failure_code`，因此不会被 permanent execution-identity 路由吞掉；
- frame 重复、包含 manifest 外名字、local/remote 极性不符、超预算或非 canonical ⇒
  `execution-identity-control-failed`。

launcher 对 local unavailable 发 frame 后以专用内部错误退出；隐藏 CLI catch 对该错误不得再发
`AW_OPENCODE_FAILURE execution-identity-mismatch`，否则会把可重试故障覆盖成永久身份失败。

## 5. Wrapper 边界不变

v1 不改 wrapper 的可写集合，不创建 receipt，不解析或转发 child stderr。`GET /mcp` 的 state 初始化
已经覆盖 exec/connect/initialize/适用的 tool-list 失败；平台对外只报告 MCP 名与 closed status。
这样不会为“更细原因”在 sealed child 中新增一个可伪造的写回面。若后续需要阶段级取证，须单独
证明通道的完整性、大小上限、secret redaction 与跨平台语义。

## 6. Frozen skill block

### 6.1 Rendering

把泛化的 `appendFrozenBlock` 拆成 skill 专用 renderer 与其他 block renderer。skill 形状：

```text
<aw-frozen-skill name="lint" sha256="…" root="/…/skills/abc"
  fileCount=3 filesTruncated=false>
<aw-frozen-skill-files encoding="json-lines">
"SKILL.md"
"examples/"
"reference.md"
</aw-frozen-skill-files>
…SKILL.md…
</aw-frozen-skill>
```

opening tag 的值沿用现有 JSON literal codec；文件子块每行是一个 JSON string，避免把任意文件名
塞进超长属性或产生 quote 歧义。清单只含 relative safe path，目录以 trailing `/` 表示。预算建议
每 skill 64 KiB、整份 persona 256 KiB；超过时保留按序可放下的前缀并设
`filesTruncated=true`，`fileCount` 始终是完整数量。root 是权威入口，截断不会让文件不可访问。

### 6.2 Tool access

计划器把 selected roots 传给 controlled permission builder。只对已允许的 read/grep/glob 使用
精确 external-directory allow；全局 `* deny` 仍为最后规则。bash wrapper 的 bindReadOnly 已含
roots，继续复用；不得把共同父 `.../skills` 或 sealRoot 整体放回。

### 6.3 Identity normalization

新增 `businessOpencodeIdentityDigestV3({config,...,frozenSkills})`：

1. 验证每个 target 是 `sealRoot/skills/<derived sealName>`，无重复/包含关系；
2. 解析 controlled config 中 root agent 与 dependents 的生成 prompt；
3. 对计划声明该 skill 的每个 persona，要求恰有一个 matching block；
4. 只替换 opening tag 的 exact `root` value 为 logical URI；
5. 文件清单、treeDigest、正文和声明关系仍留在摘要中；
6. 任一多/少 block、路径不符或 parse 失败均 mismatch。

launcher 从 manifest 重建物理 roots 后调用同一个 helper，禁止复制算法。

### 6.4 Legacy owner

计划阶段同时可构造 legacy persona/config/digest 与 v3 persona/config/digest：

- new owner：只使用 v3；
- resume owner digest == v3：使用 v3；
- resume owner digest == exact legacy v2：使用 legacy config，manifest 标 legacy，skill roots 不加
  external-directory allow；
- 其余：session mismatch，且发生在任何 mkdir/chmod/store 写之前。

不更新历史 owner row，不把一次 session 的 persona 中途换代。

## 7. Inventory

`buildVerifiedInventorySnapshot` 接收 readiness receipt。MCP status 写 `connected`、`failed`、
`missing` 等归一化值；hint 只写安全、固定文案（如 `remote unavailable at startup`），绝不带
upstream error。local unavailable 不会走到成功 inventory 写入时，可在失败诊断事件中看到；
若 inventory 文件需要保留失败快照，必须在 RFC 实现门前明确其 cleanup/读取语义，不能留下
半成品冒充 captured success。

## 8. 测试策略

### MCP

- direct client decoder：全 status、未知形状、超项/超字节、error 丢弃；
- comparator：missing/extra/disabled、local/remote 分轴、确定性排序；
- launcher harness：无 MCP 零请求、全 connected 顺序、local 在 session 前失败、remote 继续、
  connected 零工具接受；
- runner control：frame canonical/重复/伪造名字、retry polarity、事件与日志无秘密；
- wrapper/SDK A/B：exec/nonzero/initialize/tool-list 失败都成为 unavailable，且 child write allow
  集合字节不扩张；
- inventory：receipt 与展示同源，禁止固定 `configured` 回归。

### Skill

- renderer：escaping、排序、目录、预算截断、正文伪造 opening tag；
- plan：真实 `reference.md` frozen 后，root/清单来自同一次 inspection；
- containment：macOS Seatbelt 与 Linux bwrap 下 bash/read 可读 selected sibling、写/越界失败；
- identity：runRoot A/B 同摘要，tree/file-list/body 任一变化不同摘要；launcher/plan 共 helper；
- resume：v3→v3、legacy→legacy、近似 digest 拒绝、失败前零写；
- Windows：canonical path 与无 sealed shell 分支至少做结构测试，不伪称真机能力。

## 9. 运维与安全

- readiness 请求使用现有 bootstrap deadline 与 abort signal，不新增无界等待；
- 所有控制帧有数量、单项和总字节上限；
- 日志只列 MCP 名和 closed status；名字仍经诊断 masking；
- skill root 是 attempt path，可在任务 Session 诊断中出现，但不能进入跨任务 API 或普通资源导出；
- 本 RFC 不自动修 local MCP。失败提示应指向“把命令及显式依赖放进管理员允许的只读路径”，
  不能建议放宽 home/tmp。
