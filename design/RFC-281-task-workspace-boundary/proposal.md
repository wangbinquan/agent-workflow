# RFC-281 · 任务工作区边界（防误入）

状态：In Progress（2026-08-11 落档 + 用户批准 + T0 实测完成；方向：防误入为主 / 默认开 + 作者白名单 / 两个 runtime；**首要实现原则见 §2**）

## 0. 首要实现原则（用户定调 2026-08-11，高于一切细节）

**业务正常执行不被误伤是硬约束，防护强度让路。** 本 RFC 要防的就一件事：**一个 agent 干活只在自己的工作区里，别跑到别的任务工作区去**。据此：

- 只做**工作区隔离**这一个维度：把 agent 的写/执行收敛到本任务自己的工作区。不追加会增大误伤面又非此核心的加固（v1 明确**不做** claude 读面逐项 deny 敏感文件、不做 `excludedCommands` 等复杂键面钉死、不做多级降级机器；见 §3）。
- 宁可漏防不可误伤：机制不可用（如 Linux 缺 bwrap）时**告警放行**，绝不阻断业务。
- **脚本节点等先不碰**（本就不在范围，§3）。
- 任何"为了更安全"的收窄，若可能让多仓 / git / 注入资源 / 合法外部读等正常业务跑不了，一律不做或退回作者白名单。T0 已避掉一个此类真坑（claude `denyWrite` 列 appHome 祖先根会连 agent 自己 cwd 一起盖死，design §5-2）。

## 1. 背景

生产观察到：一个任务的 agent 子进程跑到**另一个任务的工作目录**里执行了工作。复盘确认这不是单点 bug，而是三层既定事实叠加后的必然：

1. **RFC-276（Done，2026-08-10）明文撤销了全部 OS 隔离**。能力影响清单 C1 写明 runtime 可访问宿主账号可达的一切（`design/RFC-276-runtime-hardening-deprecation/proposal.md:106-110`）；spawn 只设 `cwd` 指路（`services/runner.ts:1005`），`managedProcess.ts` 文件头自陈 deliberately no filesystem policy。
2. **opencode 侧平台无条件传 `--auto`**（`services/runtime/opencode/spawn.ts:94-109`）。opencode 原生有越界闸门：文件工具触碰 cwd/worktree 之外的路径会触发 `external_directory` 权限判定，默认 `ask`（opencode `agent/agent.ts:119-136`）；headless 下 ask 本会被自动拒绝，但 `--auto` 把它翻转为**自动批准**（opencode `cli/cmd/run.ts:796-816`）。越界因此被静默放行。
3. **claude 侧未声明 permission 的节点走 `bypassPermissions`**（`services/runtime/claudeCode/spawn.ts:126`），无任何边界；声明了 permission 的节点虽有 `dontAsk` 的 cwd 语义，但 Bash 子进程不受文件规则约束。

同时，所有任务的 worktree / iso 工作区互为**兄弟目录**（`util/git.ts:937-938`、`services/nodeIsolation.ts:166-175`，均在 `~/.agent-workflow` 下），prompt 还把绝对路径交给模型（`shared/src/prompt.ts:551-554`）——`ls ..` 一步即达其他任务；同一可达面里还有 `db.sqlite`、`secret.key`、`token`、`config.json` 等平台敏感文件（`util/paths.ts:16-32`）。

## 2. 目标

给每个业务节点 run 一个**默认生效的工作区边界**：agent 的文件访问收敛到「本任务自己的工作区 + 本次 run 的注入资源 + 临时目录」，越界访问被 runtime **原生权限机制**拒绝（工具报错、run 继续，不 fail 节点）。

- **定位是防误入**：拦截模型走神 / 路径混淆这类事故（本次事故形态），不承诺对抗蓄意恶意 agent。
- **只用两个 runtime 自家的普通配置面**（opencode `permission.external_directory`；claude `permissions` 路径规则 + claude 自带 sandbox 设置），不重造 RFC-276 删除的平台自有 OS 围栏，不复用其具名符号，不触其反向守卫。
- **默认开 + 作者白名单**：所有业务节点默认受边界约束；agent 作者可在 frontmatter `permission.external_directory` 里显式声明额外可达目录（延续「用户显式声明是唯一权限输入」的产品不变量），平台负责在两个 runtime 上尽力兑现并披露粒度损失。
- 平台敏感面（`~/.agent-workflow` 下的 DB / 密钥 / 令牌 / 其他任务工作区）的**写**由工作区隔离**天然覆盖**（都在 cwd 之外）：opencode `external_directory` 读写都挡、claude sandbox 默认写边界挡写。**不为它们再做 claude 侧读面专项 deny**（§0 原则；claude 读面全盘默认保持，归 §5 B8 残留）——这是"聚焦工作区、不过度加固"的直接取舍。

## 3. 非目标

- **不对抗蓄意恶意 agent**。以下残洞明确保留并文档化（见 §5 B6）：opencode Bash 的间接越界（`sed`/`python`/`git -C`/重定向等不在其参数扫描白名单内，opencode `tool/shell.ts:28-50`）、opencode 路径判定为纯词法不防 symlink（opencode core `fs-util.ts:270-273`）、claude sandbox 不可用平台上的子进程越界。
- **不重建平台自有 OS sandbox**：不引入 Seatbelt/bwrap 自管代码、不建 provider/准入/降级机器。claude 自带 sandbox 是 claude 的产品功能，平台只通过 `--settings` 传配置。
- **不改变 readonly 语义**：readonly 仍是「一次性工作区 + 不合回」（RFC-276 C6），不是文件系统写拒绝。
- **脚本节点不在范围内**：script 节点是宿主直跑的 Bun 进程，不经 runtime 权限面；其收紧属独立议题（§0 用户明确「先不碰脚本」）。
- **v1 不做 claude 读面敏感文件专项 deny**（§0 原则）：claude sandbox 默认读全盘，平台不逐项 deny `db.sqlite`/`secret.key`/`token` 等——这些文件的**写**已被 sandbox 默认写边界挡住，其**读**在 claude 节点上归 B8 残留（零业务成本的极小 deny 可后续按需加，不在 v1）。opencode 节点因 `external_directory` 是相对判定，读写都已挡、无此残留。
- **system agent 面（intent / distiller / smoke / 测试台）v1 不套边界**：它们已是一次性工作区 + 只消费结构化输出（RFC-276 C4）；待 RFC-280 T4 统一执行器收编后再评估统一接入。
- 不改变工具面语义：不动 `--tools` 载入集映射（RFC-242 契约）、不把未声明 permission 的 claude 节点从 `bypassPermissions` 改走 `dontAsk`。

## 4. 用户故事

- 平台运维：并行跑 N 个任务，某个 agent 模型走神想去改「看起来相关」的另一个任务目录——工具调用直接被 runtime 拒绝并附规则说明，agent 回到自己的工作区继续，两个任务互不污染。
- agent 作者：写一个需要读机器上参考仓的审计 agent，在 frontmatter 里声明 `permission.external_directory: { "/Users/me/dev/code/refrepo/*": "allow" }`——opencode 上原生放行该目录；claude 上平台将其兑现为 additional directory，无法精确表达的 glob 在保存时收到告警。
- 平台开发者：新增的边界注入完全落在 RFC-280 统一注入层与 spawn 装配层的既有单点上，不新增第二条 spawn 链路。

## 5. 能力影响清单（按 CLAUDE.md 能力收缩条款，逐项请用户确认）

> B1 / B3 是本 RFC 的两条真正的行为收缩；其余为兑现 / 修复 / 披露。每条拒绝分支都必须有测试（§见 design 测试策略）。

- **B1 · opencode 业务节点：文件工具越界从「自动批准」变为「默认拒绝」**。read/write/edit/apply_patch/glob/grep/lsp 触碰边界外路径 → `DeniedError`。受影响：依赖静默读外部路径（参考仓、机器全局文件）的存量 agent，需要作者补一行 `external_directory` 白名单声明。`--auto` 保留（deny 在 ask 之前短路，不受其影响，opencode `permission/index.ts:75-79`；即 RFC-276 AC-5 语义的直接运用）。
- **B2 · opencode：平台重新放行运行必需目录**。平台合成的 deny 基线会遮蔽 opencode 默认白名单，平台按本次 run 的**实际注入清单**逐项 re-allow：staged skill 目录、`$TMPDIR/opencode/*`、tool-output 目录、runDir——对用户是行为不变项。**例外（用户已确认，2026-08-11）**：opencode 项目配置 `references` 声明的外部参考目录**不**自动放行（平台不解析 opencode 配置），默认同样被拒，需要作者在 `external_directory` 白名单里声明——用了 references 的存量项目属 B1 影响面。
- **B3 · claude 业务节点：默认启用 claude 自带 sandbox（可用时），只做写边界**。写边界 = cwd + tmp + 本任务 mounts + 作者白名单（sandbox 默认「写=cwd+tmp+allowWrite」承担，T0 §5-2 已证生产 appHome 在 home 下时兄弟默认拒写）；**连 Bash 子进程一起约束**，且 `bypassPermissions` 下仍强制。未声明 permission 的节点工具面不变，仅新增 `--settings` 文件系统边界。**不下发 denyWrite**（列 appHome 祖先根会连 agent 自己 cwd 一起盖死，T0 §5-2）。sandbox 不可用（Linux 未装 bubblewrap+socat、Windows）→ **告警放行，不阻断业务**（§0 原则；不做多级降级机器）。**读面 v1 不做**（§3、§0）：claude 默认读全盘保持，读兄弟/敏感文件归 B8 残留。与 opencode（相对判定、读写全拦）的读面差异如实分述，不假装对称（用户已确认接受，2026-08-11）。
- **B4 · claude 声明 permission 的节点：多仓 mounts 通过 additional directories 变为可达**。今天 `dontAsk` 下 cwd 之外即拒，多仓任务的其他成员 mount 本就够不着——本 RFC 顺带修复该缺口（属能力恢复）。
- **B5 · `external_directory` 升级为跨 runtime 的平台级词汇**。此前它在 claude 侧是 known-but-empty（`runtime/claudeCode/permissionMap.ts:58-59,74`，映射为空且无告警）。现在：opencode 原生兑现；claude 把字面目录形 pattern 兑现为 additional directory + sandbox 放行，无法表达的 glob / scalar `allow` 在保存时显式告警粒度损失（延续 RFC-242 permissionMap 的披露风格）。
- **B6 · 明示的残洞（非目标）**：见 §3 第一条。文档（`docs/OPENCODE_CONFIG.md`）必须如实列出，不得把本边界描述为安全隔离或 sandbox 承诺。
- **B7 · readonly / merge-back / 快照语义零变化**：这些是 daemon 侧 git 操作，不经 runtime 权限面。resume / clarify 续跑是 runtime 再 spawn，**每次 attempt 重新注入边界**（新进程重新吃本次 env/config/settings），有专项回归锁（design §5-7）。
- **B8 · 边界的既有放宽面（披露，不对抗）**：①opencode 的 active-org / managed / MDM 配置在平台 inline 配置**之后**合并（1.18.4 `config/config.ts:396-535` 已核实），机器/组织管理员可借此放宽边界——这是 RFC-276 C2 声明保留的机器配置面，按「管理员拥有机器」的既有信任模型披露而非对抗；worktree 内项目配置在 inline **之前**合并，不构成放宽面。②claude 的 `--settings` 是逐键合并层，平台钉死全部已知安全键（design §4.1），但未来新增的未知安全键、以及数组键若实测为跨层拼接（design §5-8），构成仓库内容级的残留放宽面，同样披露。

## 6. 与 RFC-276 的关系（显式修订，非复辟）

- 本 RFC **修订** RFC-276 的一条产品语句：「作者显式 permission 是唯一的平台 permission overlay / 平台不再加全局 allow/deny」（`agentInjection.ts:201-203` 注释、RFC-276 design §4.3）。修订后：平台额外注入**一条路径边界**（deny 基线 + run 必需白名单），作者声明仍然最后生效、可显式放宽。AC-6 的本义（不给无 permission 节点套 all-deny/read-only **工具** profile）继续成立——本 RFC 不动工具面。
- 不触反向守卫：不复用 `sandbox/ containment/ verified/ netless/ execution-identity` 等具名符号与文件路径（`tests/rfc276-runtime-hardening-deprecation.test.ts:47-118`）。新代码命名回避 `sandbox` 词根（claude 设置里的 `"sandbox"` JSON 键是 claude 的词汇，出现在渲染数据里而非平台符号名）。**文档措辞已知冲突（设计门 F11）**：守卫的 docs 扫描集含 `docs/OPENCODE_CONFIG.md`，正则禁 `\b(?:Seatbelt|bubblewrap)\b`（同测试 `:120-137`）——T5 的边界章节措辞必须回避该词族（写「claude 自带 sandbox，OS 机制细节见上游文档链接」），如确需点名机制词，须同 PR 显式修订守卫正则并注明 RFC-281 授权。
- RFC-276 的「若未来需要隔离，必须以新 RFC 从零定义」（`proposal.md:96`）——本 RFC 即该条款的执行：不恢复旧链路，只用 runtime 原生配置面。

## 7. 验收标准

- **AC-1** opencode 业务节点内，read 工具访问兄弟任务 worktree（`../<其他 taskId>/…`）被拒绝，agent 会话不中断；同一 run 内写自己 worktree 正常；**原生子代理（`general` 等 task 子会话）越界同样立即被拒**（不悬挂、不被 `--auto` 放行）。真 opencode 集成测试覆盖。
- **AC-2** `--auto` 仍在，deny 不被其翻转（mutation：移除平台 deny 基线 → 越界重新被放行，测试必须由红转绿证明基线是拦截原因）。
- **AC-3** 平台 re-allow 清单生效：managed skill 文件、`$TMPDIR/opencode/*`、tool-output 目录在边界开启后仍可读（回归锁：技能读取用例在边界开启前后行为一致）。
- **AC-4** 作者 `external_directory` 白名单在 opencode 上放行所声明目录；**claude 上字面目录白名单有真 runtime 读+写用例**（additionalDirectories 读 edit、sandbox allowWrite 经 Bash 写各一条）；作者显式 scalar（`allow`/`deny`）接管整键；`ask` 在保存时收到「headless 无意义」告警。
- **AC-5** claude 节点（macOS Seatbelt 可用环境）：Bash 写兄弟任务目录失败、写 cwd 成功；未声明 permission 节点的工具面与既有行为逐字节一致（argv 除新增 `--settings` 外不变）。gated 集成测试覆盖。
- **AC-6** claude sandbox 不可用时**告警放行、不阻断业务**（§0 原则；非多级降级机器）：有结构化告警日志与测试证明放行发生且被记录（不静默）。
- **AC-7** claude 声明 permission 的多仓节点能读写本任务全部 mounts（B4 修复）。
- **AC-8** 平台敏感面（`db.sqlite`、`secret.key`、`token`、其他任务 worktree/iso/runs）：**opencode** 侧因 `external_directory` 相对判定，读写都在拒绝范围内（归 T1，清单从 `util/paths.ts` 单一事实源遍历生成、不手抄）；**claude** 侧敏感面的**写**被 sandbox 默认写边界拒绝（归 T3 一条写用例即可），**读**按 §0 原则 v1 不做、归 B8 残留、不设测试。不追求两 runtime 读面对称。
- **AC-9** `docs/OPENCODE_CONFIG.md` 增补边界章节：机制、作者白名单写法、残洞清单；措辞不得声称安全隔离。
- **AC-10** 全部新增拒绝分支与降级分支有测试；`gate:local` 全绿。
