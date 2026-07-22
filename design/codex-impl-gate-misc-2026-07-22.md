# Codex Adversarial Review

Target: branch diff against 532b703b
Verdict: needs-attention

NO-SHIP：确认 6 条高风险与 4 条中风险缺陷，涉及 RFC-200 换行绕过、两条技能目录逃逸路径、结构化 stdout 被先截断后解析、OpenCode 版本回退失效及 IndexedDB 多标签永久阻塞。对 0e4df981、0d5e6dc1、1125dd83/89cdbd92、369695b1、35ca6398/36c6078a、3a1c43ea 未找到可支撑的实质 blocker；d146d46d/33d1b00a 尚需浏览器实测。

Findings:
- [high] [cc25c302/962c575d] 裸 CR 可绕过 RFC-200 行首指令中和 (packages/shared/src/promptFencing.ts:62-78)
  `neutralizeLineStartAnchors` 只按 `\n` 分行，`toSingleLine` 也要求存在 `\n`。触发路径：clarify 标题包含 `Which?\r### User directive: ...`，schema 接受后由 `renderFlatQaItem` 写到 fence 外；CR 后的攻击内容在模型看来是新行，但不会被前缀 `›`。这使已宣称闭环的单行字段边界仍可注入。
  Recommendation: 先统一规范化 `\r\n?`、U+2028、U+2029，再执行分行中和与单行折叠；为 clarify、memory、manual、workgroup 的每种行结束符补端到端攻击向量。
- [high] [9ab672df] `writeSkillContent` 仍会跟随复制进 staging 的 SKILL.md symlink (packages/backend/src/services/skill.ts:500-501)
  `commitSkillVersion` 先用默认不解引用的 `cpSync` 复制 live files，再由这里直接 `writeFileSync(join(staging, 'SKILL.md'))`。若导入、恢复或 fusion 批准后的 live `SKILL.md` 是指向宿主文件的 symlink，该写操作会以 daemon 权限覆盖宿主文件。现有测试只用该 symlink 调 `readSkillContent`，没有覆盖生产写入口。
  Recommendation: 把 no-follow/containment 检查下沉到 `commitSkillVersion` 的统一写入边界，或至少让 `writeSkillContent` 使用不可跟随 symlink 的安全写原语；增加 live SKILL.md symlink 的写入回归测试。
- [high] [9ab672df] dangling symlink 确定性绕过叶节点检查，且检查与写入仍是 TOCTOU (packages/backend/src/util/safePath.ts:108-115)
  代码用 `existsSync(target)` 决定是否 `lstat`，但该 API 会跟随 symlink；指向尚不存在宿主文件的 dangling link 返回 false。触发路径：staging 中 `escape -> /outside/new-file`，父目录检查通过，随后 `writeFileSync` 跟随链接并在宿主创建文件。即便目标已存在，realpath 检查和后续写/删仍是两个 syscall，可被并发替换。当前测试只覆盖指向已存在文件的链接。
  Recommendation: 不要用 `existsSync` 判定叶 symlink；更根本地改用 descriptor-relative、no-follow 的原子操作（如 openat2/RESOLVE_BENEATH 等价实现），或在不可被其他执行方修改的 staging 树中拒绝任何 symlink。补 dangling-leaf 与检查后换链测试。
- [high] [61aa45b4] NDJSON 在协议解析前按物理行截断，可破坏合法 workflow-output envelope (packages/backend/src/services/runner.ts:1931-1956)
  `pumpLines` 在 callback 前把超过 1 MiB 的行截断并丢弃余段，而 OpenCode 会把整个 text part（包括 XML envelope）放在一条 NDJSON 记录中。合法的大型输出因此先变成无效 JSON或缺失闭合标签，随后才进入 event/envelope parser，导致任务失败、重试或错误的 missing-envelope 结果；8 MiB 尾缓冲也会从任意字符处切掉 envelope 开头。现有测试只测截断原语，没有跑真实 NDJSON→事件→envelope 链。
  Recommendation: 先增量解析协议帧，再对解码后的字段施加有文档的端口容量限制；超限应产生明确的 `stdout-event-too-large`，不能把损坏文本交给 envelope parser。补 1 MiB/8 MiB 边界的真实 OpenCode 事件端到端测试。
- [high] [1964a0d0] custom OpenCode 1.18 在 daemon 重启后的 headless 首次运行仍使用失效旧 flag (packages/backend/src/util/opencode-version-registry.ts:20-25)
  版本注册表仅在进程内存中，并明确让 unknown custom binary 回退 `--dangerously-skip-permissions`。启动时只探测默认 binary；自定义 runtime 只有被 `/api/runtimes/status` 探测后才登记。因此 daemon 重启后由定时任务、自动恢复或无浏览器调用触发的 custom 1.18 runtime 会使用已移除 flag，并可持续失败，因为失败的 spawn 不会填充注册表；二进制原地升级还会保留旧缓存。
  Recommendation: 在解析实际 runtime binary 时探测并按 binary identity 持久化/失效版本，或 unknown 时 feature-detect 并只重试另一 flag 一次。覆盖 daemon 重启后的 headless custom runtime、PUT 更换 binary、原地升级及探测垃圾输出。
- [high] [80308991] 共享 façade 仍会在多标签 v1→v2 升级时永久 pending (packages/frontend/src/lib/draftDb.ts:49-60)
  open 请求没有 `onblocked`，成功后的 DB 连接也没有 `onversionchange` 关闭与清缓存。触发路径：旧 bundle 标签页持有 memoized v1 connection，新标签页加载 v2 并发起升级；旧代码不会关闭连接，新页的 `openDraftDb()` Promise 永不 resolve/reject，所有 review/clarify 草稿读写随之永久等待。测试明确只做源码/无 IndexedDB 路径，没有行为级多标签升级覆盖。
  Recommendation: 为当前连接注册 `onversionchange` 并 close/reset promise；为 `onblocked` 提供超时、可见错误和重试/刷新指引。使用 fake-indexeddb 或 Playwright 多页测试锁定 v1 holder、并发 v2 upgrade 及未来 v3 升级。
- [medium] [b56190a3] prompt 限长不能阻止 unchecked 环境变量触发 E2BIG (packages/backend/src/services/runtime/opencode/spawn.ts:168-180)
  spawn 环境仍无上限地注入 `OPENCODE_CONFIG_CONTENT`。Linux 的单个 argv/env 字符串同样受约 128 KiB 限制，macOS 还受 argv+env 总量限制；因此 prompt 小于 120 KiB 时，大型 inline agent/MCP/config 或继承环境仍会在 execve 抛原始 E2BIG。上游仅用 UTF-16 `.length` 发出 32 KiB warning，不按字节校验也不阻止执行。
  Recommendation: 将大型配置改走受控文件或 stdin；在统一 spawn 层按编码后字节数检查所有 argv/env 单项及总量，并把 E2BIG 转为稳定错误。补 prompt 未超限但环境单项或总量超限的测试。
- [medium] [191bc32c/8338f393/d9176470/85c1ab19] 六个 shell 桩没有实现 TS 桩的 `--` 尾参契约 (e2e/fixtures/stub-opencode.sh:34)
  TS 桩精确取 literal `--` 后的唯一参数，但 shell 桩用 `RAW_PROMPT="$*"`，把 flags、agent、session 等全部混入 prompt。触发路径：非 prompt 参数包含 nonce 或 `commit_message` 等分支标记时，shell 桩会产生假阳性；未来尾参解析再次回归时，契约测试仍可能因 nonce 出现在整串 argv 中而通过。当前契约测试只断言退出码和 nonce，不断言桩实际提取的 prompt。
  Recommendation: 六个 shell 桩统一遍历参数到 literal `--`，随后校验只剩一个位置参数并令 `RAW_PROMPT=${1-}`；测试应回传并精确比较多行、破折号开头且夹带 session-like 文本的 prompt。
- [medium] [6adf3ea1] OpenCode live integration 路径过滤遗漏真实兼容层 (.github/workflows/integration-opencode.yml:44-52)
  workflow 的 push/PR path filter 包含 runner、envelope 和少量测试，却不包含 `services/runtime/opencode/**`、`util/opencode*.ts`、录制脚本或 shell 桩。因此 1964a0d0 这类直接修改 driver/spawn/version registry 的 CLI 兼容提交不会触发 live OpenCode integration。结构守卫只验证 push 集合不小于 PR 集合，无法发现两者共同遗漏。
  Recommendation: 把 OpenCode driver、spawn、版本工具、录制脚本和桩目录纳入过滤；守卫应从声明的生产依赖闭包验证覆盖，而不只是比较 push/PR 两份相同列表。
- [medium] [71dfca67] 全局按 GHSA ID 忽略会遮蔽后来进入生产依赖图的同一漏洞 (.github/workflows/ci.yml:274-279)
  `bun audit --ignore GHSA-*` 不绑定当前锁版本、依赖路径或 dev-only 可达性。当前三条公告虽由 drizzle/eslint 工具链引入，但只要后续生产依赖也带入相同 advisory，CI 仍会静默通过；注释中的“dev-only”不会被机器验证，也没有过期或父包升级棘轮。
  Recommendation: 解析 audit JSON，仅豁免当前精确锁版本和已证明的 dev-only 路径；若同一 GHSA 出现在 production dependency、版本或路径变化，应立即失败，并为每条临时豁免设置到期/移除条件。

Next steps:
- 优先阻断 RFC-200 CR 绕过与技能目录两条宿主逃逸路径，再复审完整写/删入口清单。
- 把 stdout、argv/env、版本探测和 IndexedDB 场景补成真实协议或多进程/多标签行为测试，而非源码锁。
- 修正 OpenCode integration 路径过滤，并将 bun audit 豁免改为依赖路径受限的可过期 allowlist。
- question: 在 plain-http、窄视口 Node/Edge Inspector Dialog 内，Chromium 与 WebKit 的 `execCommand('copy')` 回退是否稳定成功？`clipboard.ts` 注释假设所有调用均在 Dialog 外，但当前调用图与该假设冲突；需要浏览器实测后决定是否把 d146d46d/33d1b00a 升为 blocker。

Codex session ID: 019f8759-5371-7f62-b110-bfcee438c90b
Resume in Codex: codex resume 019f8759-5371-7f62-b110-bfcee438c90b
