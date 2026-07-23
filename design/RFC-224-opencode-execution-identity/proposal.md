# RFC-224 opencode 执行身份完整性（从 RFC-223 拆出）

- 状态：Implemented / release evidence pending（2026-07-23；设计门与实现门最终均为
  0 P0 / 0 P1 / 0 P2；T28 本地全门已完成，T32 exact-SHA push/CI 证据待提交后完成）
- 关联：RFC-223（多租户资源标识——本 RFC 承接其 §6 拆出的执行完整性关切）

## 1. 背景

RFC-223 设计门核实官方 opencode v1.18.3 后确认：平台过去认为
`OPENCODE_CONFIG_CONTENT` “最后合并、恒胜”的假设不成立。inline 之后仍有
active-org、managed、macOS MDM、legacy `mode` 与 `OPENCODE_PERMISSION` 等来源；
同名 agent 的 prompt/model/permission/mode 或 MCP 可被替换，`disable` /
`mode:subagent` 还能令 `--agent` 回退默认 agent。

多租户放大了已有缺陷：平台虽按稳定 id 选定 tenant agent，opencode 最终仍按
name 注册；跨 owner agent 在某 repo 执行时，该 repo 或宿主配置可以覆盖同名
执行定义。这是执行完整性问题，不是 RFC-223 的资源标识问题，故独立立 RFC。

设计门还证明了三个不能靠“多做一次配置检查”解决的上游行为：

1. V1 external plugin 在 `/config` 可见前 import；V2 plugin 和 repo custom tool
   另有不受 `OPENCODE_PURE` 完整覆盖的动态 import 路径。
2. `task_id` resume 不验证 parent/directory/agent/permission；HTTP
   `SubtaskPartInput` 还能绕过 task tool visibility。
3. `opencode serve` 的 Basic Auth secret 位于 server env，官方 shell/local MCP
   默认继承全量 env；模型可借 loopback API 更新 config、prompt 任意 session。
   官方 `run --attach` 自己的 `/agent` lookup 失败还会回退默认 agent。

因此本 RFC 必须同时关闭配置漂移、动态代码加载、loopback 管理面与 CLI fallback；
只做 resolved-config fingerprint 仍是 NO-SHIP。

## 2. 目标 / 非目标

**目标**

- G1 平台按 id 选定的 business/system agent 与受控 MCP，在第一个模型请求前，
  其最终配置身份必须等于冻结输入；任一差异 fail closed。
- G2 配置/bootstrap 自动执行面不能触发未经身份检查的用户可写宿主 executable；
  执行期间模型可达代码不能读取平台/server secret、访问 loopback 管理 API 或
  替换 identity runtime artifact，并且模型显式运行的 worktree/OS-TCB 代码只能在
  inner containment 内执行。
- G3 business、memory distill、runtime smoke 三条生产入口统一经过同一门，并有
  bounded cancel/reap。

**非目标**

- N1 不证明 provider 网络对端、MCP executable/remote service、模型显式运行的
  worktree artifact、只读 root-owned OS toolchain 或最终 TLS 链的供应链身份；
  这些代码的保证是 containment，不是 binary identity。
- N2 不证明 repo `AGENTS.md` 或平台 skill Markdown 的内容良性；平台只把
  no-symlink copy/re-hash 后的冻结文本注入 prompt，不开放 OpenCode 自身的
  instruction/skill 发现与读取工具。
- N3 同 uid 的主动宿主进程、root/admin 与 OS 内核不在威胁模型内。

## 3. 拟采方案

1. **官方 binary identity**：只接受仓内精确
   `{os,arch,version,sha256,codec}` allowlist。父进程在进入 sandbox 前把 binary
   复制到只读 runtime seal，复算摘要；真实 server 只执行该副本。
2. **hermetic config/import 面**：固定私有 `OPENCODE_CONFIG_DIR` /
   `HOME` / `OPENCODE_TEST_HOME` / XDG config/cache/state，启用
   `OPENCODE_PURE=1`、`OPENCODE_DISABLE_PROJECT_CONFIG=1` 与
   `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`，同时禁用 models fetch、default
   plugins 与 file watcher。清空继承的 `OPENCODE_*`，只生成 selected provider
   的受限 `OPENCODE_AUTH_CONTENT`，并将 managed config/MDM 路径从 outer
   sandbox 隐藏。按 V2 真实发现算法在 server 前与 prompt 前扫描/fingerprint；
   repo config、plugin、custom tool、external skill、agent/command executable
   surface 与 V2 `reference/references` 一律拒绝。
3. **same-server direct codec**：verified launcher 启动专用 loopback
   `opencode serve`，读取 `/config`、`/agent`、`/skill`，全字段校验并二次 seal。
   校验通过后 launcher 自己订阅 SSE，生成 caller-owned `messageID`，并向同一
   server 的 `/session/:id/message` 提交显式 agent/model + 单 text part；只接纳
   逐 step 绑定该 caller message 的有序 assistant reply 集，不再调用有 fallback
   的 `opencode run --attach`。
4. **最小自动执行面**：final raw config 强制并校验固定 shell、
   `lsp:false`、`formatter:false`、`snapshot:false`、`autoupdate:false`、
   `compaction.auto:false`、`share:"disabled"`；新 session 使用非默认 title，
   避免 title/compaction 额外模型请求。
5. **模型子进程隔离**：secure v1 只在 Linux RFC-205 sandbox `enforce` 且
   `bwrap` 可用时运行；macOS 因无 PID namespace，诊断可验证 binary/config，
   但模型执行 fail closed。shell/local MCP 必经只读 seal 中的平台 wrapper；
   wrapper 从 allowlist 重建 env，使用 private net+pid namespace，并遮蔽 daemon
   真实 HOME、共享 `/tmp`/`/var/tmp`。内层仅精确 worktree + 专用 scratch 可写，
   平台 home、runtime seal、OpenCode data/cache 与其它 PATH 不可见或只读。
6. **工具收口**：官方 V1 file tools 只做 lexical project-boundary 判断，worktree
   symlink 可让 server 进程读写 `/proc`/XDG secret，所以受控 Agent.Info 最终
   deny `read/edit/write/apply_patch/grep/glob/skill/task/webfetch/websearch/lsp`、
   OpenCode tool-output truncate glob 与 external directory；文件操作只经 sealed
   netless shell。launcher no-symlink copy/re-hash 选中的 `AGENTS.md`；managed
   skill 则按 frozen `contentVersion` snapshot **整棵 tree**（`SKILL.md` 与全部
   辅助文件），对 canonical path/type/mode/content 计算 tree digest，copy 后逐项
   re-hash，只从 immutable seal 注入正文或 bind aux。V1 也关闭 external/project skills、
   platform plugin 与 opencode dependent agent；非空选择返回稳定 unsupported
   错误，不静默降级。
7. **session 与 codec fail closed**：resume 只从当前 instance 的分页
   `/experimental/session` inventory 找 id，并校验 root/目录/workspace/
   agent/model/permission；绝不 GET 一个会先路由 foreign directory 的 session。
   SSE drop、未知相关事件、非 expected session、HTTP/schema/error 都在模型结果
   被接纳前失败。

## 4. 兼容性与迁移

- v1 仅支持官方 opencode 1.18.3；custom fork 与“任意 >= min”不再可执行。
- v1 安全模型执行只支持具备可用 `bwrap` 的 Linux；macOS OpenCode
  business/system/smoke 模型执行稳定返回 `execution-identity-sandbox-required`，
  不以较弱隔离静默运行。
- fresh seed 与现有 OpenCode runtime 的 `model=NULL` 保持“未配置”，但 UI/probe/
  run 明确要求先选择显式 model。
- OpenCode platform plugin、`dependsOn` dependent agent、官方 file/grep/glob
  tools、external/project skills、在线 shell、formatter、LSP、snapshot、web
  fetch/search 与 local MCP 网络在 v1 secure mode 不可用。工作流图多节点调度、
  离线 shell 中的文件操作/测试与 remote MCP 不受该项影响。
- 恢复以上能力需要上游 mandatory hook/credential handoff 或受维护 fork，并另过
  RFC design gate。

## 5. 验收标准

- AC1 active-org/managed/MDM/mode/env/repo 任一覆盖 agent 或 MCP 字段，或触发
  default fallback，均在首个模型请求前拒绝。
- AC2 unknown/fake/wrapper binary、hash-copy race、只读 seal 替换均拒绝；实际
  server executable 是复验后的副本。
- AC3 V1/V2 plugin、repo custom tool/config、`reference/references` 与模型可控
  symlink fixture 的模块执行计数恒为 0；project/external skill symlink 也在
  server bootstrap 前拒绝。managed skill 的 rename/contentVersion/aux mutation/
  symlink race 不得改变 sealed tree digest 或运行输入。V2 location 在模型可控内容
  接触前完成并冻结；同 uid主动宿主进程竞态不在 N3 威胁模型内。
- AC4 raw config 与 Agent.Info 全字段 mutation、permission 顺序、精确
  tool-output truncate deny、显式 model/provider、provider implementation npm
  allowlist、MCP unknown field 都有 table-driven 负测，错误只含
  code/path/digest。
- AC5 shell/local MCP 无 server/platform/provider secret、无 loopback/network/
  process-info、不能看见 daemon 真实 HOME 或共享 temp，不能写 runtime
  seal/data/cache/PATH；Linux `bwrap` 不可用或 sandbox 非 enforce 直接失败；
  worktree symlink 不能借官方 file tool 读取 `/proc/self/environ` 或 private XDG，
  取消/超时后 private PID namespace 内无孤儿。
- AC6 direct codec 只提交 selected agent/model 的单 text prompt；pinned-compatible
  caller message id、有序 assistant parent binding、新/resume provenance、SSE
  ready-before-POST、event filtering、official JSON golden 与 cancel/abort 均有
  自动化证据；双 resume 只能有一个在 store 接触前取得 lease，resume 对
  title/path/share/revert/metadata 的任一漂移 fail closed。
- AC7 business/system/smoke 三入口无 direct opencode bypass；identity failure 是
  permanent，不进 envelope followup/普通 retry。
- AC8 plugin/dependent/null-model 等不支持状态在保存/launch/probe/UI 都给稳定、
  可操作错误。
- AC9 取消/超时执行 TERM → grace → 负进程组 KILL，并 bounded reap/drain
  launcher/server；无孤儿。
- AC10 CLAUDE.md 的 inline-恒胜断言与运维文档已勘误，完整 gates、compiled
  binary smoke、实现门与 exact-SHA CI 全绿。
