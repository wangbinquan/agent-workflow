# RFC-272 · 运行时能力就绪证明与密封技能寻址

> **部分由 RFC-276 废弃（2026-08-10）**：保留自然 runtime 的 skill/plugin/MCP 可用性目标；冻结身份、readiness 准入与受控 store 仅作历史记录。

状态：Done（2026-08-10）

## 1. 背景

verified OpenCode 路径已经把节点选中的 MCP 闭包编进受控配置，也把 managed skill
整棵树冻结到每次运行的 identity seal；但“配置里有”与“模型实际能用”之间仍有两条
不可观测断点。

第一条是 MCP。local MCP 的 wrapper 位于密封边界内，wrapper 启动的业务脚本及其
传递依赖则只有显式 allow-back 才可读。脚本或 `node_modules` 不在 allow-back 集合时，
OpenCode 会把该 MCP 标为失败并继续启动；verified launcher 当前不读这一事实，节点可在
工具缺失的情况下照常完成。实测对照：同目录、同解释器，零依赖版本出现在运行时工具面，
`import @modelcontextprotocol/sdk` 的版本不出现；平台侧没有告警、事件或日志。

第二条是 skill。`SKILL.md` 正文进入 `<aw-frozen-skill>`，整棵树虽已只读挂入 bash
子进程，却没有任何提示或环境告诉模型 seal 的物理根。用户创建的 `reference.md`、
`examples/` 等辅助文件因此“存在且被身份摘要覆盖，但运行时不可寻址”。

这两条不是要求拆掉围栏；要求是让声明的能力要么可用、要么明确失败，并让已经密封的
skill 辅助文件具备受控地址。

## 2. 目标

1. 在模型 prompt 之前核对本次受控配置中每个已启用 MCP 的同实例连接状态。
2. 平台围住的 local MCP 不可用时，节点以可重试的 `mcp-unavailable` 失败，不能静默 done。
3. remote MCP 不可用时保留现有“允许继续”语义，但必须写结构化告警和运行事件。
4. verified inventory 记录本次实际观察到的 MCP 状态，不再一律写 `configured`。
5. frozen skill block 告诉模型该 skill 的只读根和确定性相对文件清单；bash 与受控只读工具
   都能读取该根，仍不能改写。
6. 新的 skill 寻址信息在 OpenCode session resume 的不同 `runRoot` 间保持同一逻辑身份。

## 3. 非目标

- 不恢复 RFC-251 删除的“两次读取并比较有效配置”证明，也不新增 `/config` 二读。
- 不调用已被旧设计文本称为 `/mcp/status` 的路径；OpenCode 1.18.14 的公开同实例端点是
  `GET /mcp`。
- 不要求 MCP 至少暴露一个 tool。合法的 resource/prompt-only MCP 可以是零工具。
- 不在没有历史基线时猜测“应该有哪些精确 tool 名”；本 RFC 证明 server availability，
  不把资源声明误当 tool 清单。
- 不从 MCP argv 猜依赖目录，不把脚本父目录或 `node_modules` 自动加入 allow-back。
- 不注入所有辅助文件正文，不取消多文件 skill，不放开 repo/global/external skill。
- 不扩大 local MCP、shell 或 skill 之外的 appHome/home/tmp 可见范围。

## 4. 产品决策

### D1 · MCP readiness 是一次事实读取

verified launcher 在 server listen 后、创建/恢复 session 之前调用同实例 `GET /mcp` 一次。
响应只用于判定已密封 manifest 中的 MCP 名是否处于 `connected`；额外名字忽略，错误文本
丢弃。它与现有 `/config/providers`、`/agent`、`/skill` 单读同类，不宣称恢复配置防篡改。

### D2 · local fail，remote warn

- selected + enabled + local：缺失或非 `connected` ⇒ 向 runner 发受控 readiness frame，
  launcher 在 prompt 前终止；runner 记 `mcp-unavailable`，按普通节点重试预算处理。
- selected + enabled + remote：缺失或非 `connected` ⇒ 同一 frame 中报告，写 warning 与
  `node_run_event`，但继续创建 session。
- disabled MCP 不进入期望集合。

这个极性与 Claude 路径现有 `fencedMcpServers` / `declaredMcpServers` 契约一致：平台自己
围住的本地能力缺失会失败，外部远端可用性只做可见告警。

### D3 · `connected` 足够，零工具不是失败

OpenCode 1.18.14 的 local connect 在 transport 建连后执行 capabilities/tools/list；列举失败会
关闭 client 并把 status 收敛为 failed。只有 server 宣告 tools capability 时才列 tools，故
`connected` 能证明连接和适用的工具列举完成，却不会误伤合法零工具 server。

### D4 · readiness 进入 inventory 和诊断

开启 inventory 时，每个选中 MCP 的 `status` 写同一次 readiness 读到的闭集值；不开
inventory 也必须执行 local gate。受控 frame 只含经过 schema 校验的 MCP 名、type 与
归一化 status，不含 upstream error、argv、路径、env 或凭据。

### D5 · v1 不另开 wrapper 写回通道

OpenCode 的 MCP state 初始化会等待 transport connect，并在 server 宣告 tools capability 时完成
tools list 后才把状态收敛为 `connected`；wrapper/业务命令非零、initialize 失败和 tool list 失败
都会成为非 connected。v1 因此只消费这一同实例事实，不给密封 child 新增 receipt 文件、可写路径
或第二套真值。诊断能点名 server + closed status，但不承诺区分 `exec` / dependency / protocol
阶段；若以后确需精确阶段，应另行设计受控诊断通道，不能拿 child stderr 原文直接出围栏。

### D6 · skill block 暴露只读根与清单

每个 `<aw-frozen-skill>` 增加：

- `root`：本次 seal 内的 canonical absolute root；
- `fileCount` / `filesTruncated`：完整数量与清单是否因提示预算截断；
- 一个 `aw-frozen-skill-files` 子块：从已经验证的 `inspection.entries` 派生、按 Unicode code
  point 排序的 JSON Lines 相对路径清单。

`SKILL.md` 仍内联；辅助文件只给地址，不重复注入正文。路径必须来自计划器计算，skill
正文不能伪造或覆盖这些属性。

### D7 · 物理路径不污染可恢复身份

skill root 含 attempt-local `runRoot`。业务 owner identity 因此不能直接摘要原字符串。
identity helper 接收计划器生成的 skill seal 元数据，只在结构化 frozen block 的 `root`
属性中把经过验证的物理根规范化为
`agent-workflow://frozen-skill/<skill-id-hash>/<tree-digest>`；正文中的相似文本不替换。
launcher 用 manifest 中同一闭集重算。物理根、logical root、tree digest 或 block 出现次数
任一不一致均 fail closed。

### D8 · 已有 session 不被升级强断

新 owner 使用新 identity codec 与增强 block。恢复升级前 owner 时，计划器同时重建旧 block
与旧 codec：只有 owner digest 精确命中旧值才按旧 prompt 恢复；不会把增强 prompt 偷渡进
旧 session。该 owner 生命周期结束后，新 session 自动进入新契约。

### D9 · 读权限只放回选中的 seal

frozen skill roots 继续进入 shell/local-MCP child 的只读 bind；对 OpenCode `read/grep/glob`
增加逐根精确 `external_directory: allow`，最末尾仍保留全局 deny。seal 文件/目录权限与外层
profile 继续拒绝写。未选 skill、managed 源树、`~/.agent-workflow`、repo/global skill 均不可见。

## 5. 能力与兼容性影响清单（需逐项确认）

- **C1（失败语义收紧）**：此前 local MCP 启动失败时节点可能在缺工具状态下 done；升级后
  该节点在 prompt 前失败并消耗普通可重试预算。受影响的是声明了失效 local MCP 的任务。
- **C2（可见性扩张）**：选中的 managed skill seal 从“只有 `SKILL.md` 正文可见”扩张为
  “同一只读 seal 的辅助文件可寻址”；不扩张到源目录或未选 skill。
- **C3（remote 兼容）**：remote MCP 故障仍不阻断节点，但不再静默；日志、事件和 inventory
  会出现 unavailable 状态。
- **C4（依赖目录不扩张）**：local MCP 的业务脚本/传递依赖不会因本 RFC 自动获得读取权；
  现有依赖在围栏外的配置会从静默降级变成明确失败。后续若需要，应新增管理员显式
  `readOnlyPaths` 契约，而不是猜 argv。
- **C5（resume 兼容）**：升级前已存在的 owner 保持旧 prompt/旧能力直至该 session 结束；
  不因升级强断，也不会在原 session 中突然获得辅助文件能力。

## 6. 用户故事

- 作为任务作者，我选了一个 local MCP；它的 SDK 依赖读不到时，我看到点名 MCP 的失败，
  而不是拿到一份自信但没用工具的结果。
- 作为管理员，我配置的 remote MCP 暂时不可用时，任务仍能继续，但事件树明确告诉我它没有
  连接。
- 作为 skill 作者，我能在 `SKILL.md` 中引用 `reference.md`，模型能从 frozen block 给出的
  root 读取，且绝不会回读我随后修改过的源文件。
- 作为运维者，我升级 daemon 后，正在复用的旧 OpenCode session 不因路径换代而失配。

## 7. 验收标准

- **AC-1** 无 MCP 的 verified run 不发 `/mcp` 请求，既有启动顺序不变。
- **AC-2** 全部 selected MCP connected 时，readiness 在 session create/prompt 之前完成。
- **AC-3** local 缺失/failed/disabled/auth-pending 均在 prompt 前得到可重试
  `mcp-unavailable`，模型调用数为 0。
- **AC-4** remote 同类状态写 warning + `node_run_event` + inventory，但任务可继续。
- **AC-5** status 响应中的 error 文本、路径、env、凭据不进入 control frame/日志/DB。
- **AC-6** resource-only、零 tools、status=connected 的 MCP 被接受。
- **AC-7** wrapper/业务命令非零与“进程起来但 initialize/tool list 失败”均由 status gate 捕获；
  不新增 child write-back，日志/事件不含 upstream error 原文。
- **AC-8** inventory MCP status 来自同一次 readiness receipt，不再固定 `configured`。
- **AC-9** frozen block 给出 canonical root、相对文件清单、总数和截断标志。
- **AC-10** bash 与允许的 read/grep/glob 能读取 selected seal 内 `reference.md`；写入失败。
- **AC-11** 未选 skill、managed 源树、repo/global skills 与 seal 外兄弟路径仍不可读。
- **AC-12** 辅助文件变化会改变 tree digest/新 owner identity；仅 runRoot 变化不会。
- **AC-13** 升级前 owner 可按旧 codec 恢复且 prompt 字节不变；任何近似而非精确旧摘要都拒绝。
- **AC-14** Linux/macOS/Windows 平台契约测试覆盖路径规范化；真机至少复跑 macOS A/B 探针。
