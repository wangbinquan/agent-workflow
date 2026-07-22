# Codex Adversarial Review

Target: branch diff against c5cffeac
Verdict: needs-attention

NO-SHIP：4 个 P0、3 个 P1。静态封存、scheduled 自持凭据、跨用户 wire 无凭据和四启动面复用均被当前实现直接反证。

Findings:
- [critical] [P0 凭据泄漏] query token 仍作为活跃路径字段进入数据库、备份和 wire (packages/backend/src/services/repoCredentials.ts:209-255)
  历史 query URL 的 slug 会把 `?access_token=TOPSECRET` 变成 `repo.git-access_token-TOPSECRET`（git-url.ts:281-289），随后写入 cached_repos.local_path。这里的回填只清理 URL/错误列，完全不迁移 cached_repos.local_path、tasks.repo_path、task_repos.repo_path；VACUUM 只会重写并继续保留这些活跃值，VACUUM INTO 也会把 token 原样带进备份。rowToCached 的 redactSensitiveString 同样识别不了已被 slug 化、没有 `=` 的 token。现有测试用纯 hash 路径造数据，因此掩盖了真实路径形态。
  Recommendation: 为历史 query 行实现无凭据目录迁移：重命名镜像目录并修复所有 DB/Git worktree 路径引用；无法安全迁移时应阻断备份并要求显式修复。测试必须用 gitUrlCacheKeyWith 生成真实路径，并扫描数据库、WAL、备份 tar 和所有 DTO 的 token 子串。
- [critical] [P0 凭据泄漏] 新建缓存仍直接把原始凭据 URL 明文落库 (packages/backend/src/services/gitRepoCache.ts:552-570)
  冷克隆成功后的 INSERT 明确写入 `url: input.url`，没有写 url_enc，返回对象还固定 urlEnc=null。封存 gate 只在 daemon 启动和 backup 前运行，因此启动后新录入的私仓凭据会在 db.sqlite/WAL 中明文驻留整个进程生命周期；这不是瞬时兼容窗口。
  Recommendation: 把 SecretBox 设为 GitRepoCacheDeps 的生产必需依赖，在同一个 INSERT 中写 urlEnc=seal(input.url)、urlRedacted，并令 url=''；启动 gate 仅用于遗留数据。新增“不重启、不备份”的冷克隆落盘测试。
- [critical] [P0 凭据泄漏] scheduled v4 自封存未实现，明文可进入备份且空编辑会毁掉凭据 (packages/backend/src/services/scheduledTasks.ts:258-286)
  createScheduledTask 仍复用启动 schema 并把完整 body 直接 JSON.stringify 落库，没有 Request/Storage/Response 三契约或 repoUrlEnc。若 URL 没有匹配缓存，repoCredentials.ts:167-205 明确保留明文，因此紧接着执行 backup 仍会导出凭据；现有测试甚至在 261-272 行锁定了该不安全行为。GET 只把 URL 改成 `***`，前端 PUT 又完整回写 launchPayload，导致空编辑把真实凭据永久替换成掩码；cachedRepoId 载荷则依赖缓存行，删除缓存后不能重放。
  Recommendation: 按 v4 实现独立 Request、Storage、Response schema：保存时解析 repoUrl/cachedRepoId 并用 SecretBox 自封存为 repoUrlEnc+repoUrlRedacted，fire 时解封，响应只给脱敏值及不可伪造的保留凭据句柄。补齐无缓存、删缓存、GET→PUT 空编辑、首次备份和历史 query 载荷测试。
- [critical] [P0 凭据泄漏] URL 门禁与解析语义不一致，可绕过拒绝和脱敏 (packages/shared/src/git-url.ts:164-220)
  query 匹配器只识别字面 `[?&]key=`：`?access%5Ftoken=TOPSECRET` 会被 parseGitUrl 接受，但 hasQueryCredential=false 且 redactGitUrl 原样返回。batch-import/retry 又只调用 parseGitUrl，所以普通 `?access_token=` 也能绕过入口门。另一个可复现例是 `https://user:part1@part2@example.com/o/r.git`：解析器以最后一个 `@` 分隔 authority，脱敏正则却在第一个 `@` 截止，输出仍含 `part2`；这些值会流入缓存 DTO、WS、错误和日志。
  Recommendation: 对 URI authority 和 query 做结构化解析：按实际分隔规则处理完整 userinfo，对参数名进行一次受控解码后再比较敏感键，并拒绝歧义/非法编码。把 query 凭据断言下沉到 resolveCachedRepo 公共边界，同时接入 batch create/retry；增加编码键、多 `@`、重复参数、SSH 和大小写 scheme 的性质测试。
- [high] [P1 正确性] 前端单仓编码仍丢弃 cachedRepoId，relaunch 反向映射也不识别它 (packages/frontend/src/lib/launch-repo-source.ts:87-110)
  RepoSourceRow 选择历史镜像后会设置 cachedRepoId，但单仓 buildLaunchBody 仍无条件发送 `repoUrl: source.repoUrl`；该值只是脱敏标签。与此同时，bodyToRepoSources/repoEntryToSource（171-195）只识别 repoUrl，taskToLaunchPayload 生成的 `{cachedRepoId}` 在 relaunch 或 schedule edit 时会退化成空仓源。多仓 builder 已处理 ID，造成单仓与多仓协议不一致且测试未覆盖主路径。
  Recommendation: 抽出单一 repoSourceToWire/fromWire 转换并让单仓、多仓、relaunch、schedule edit 共用；cachedRepoId 存在时只发 ID，反向映射必须恢复 ID 和脱敏标签。补私仓单仓选择、relaunch、schedule edit 的请求体断言。
- [high] [P1 正确性] SecretBox 仍是可选依赖，三个启动面及 multipart 无法复用已封存行 (packages/backend/src/services/startTaskDeps.ts:35-48)
  已封存行在缺少 SecretBox 时由 unsealRepoUrl 返回 null。虽然普通 JSON workflow 路由传入了 key，但 agents.ts:211-219、workgroups.ts:163-171、scheduleLaunch.ts:28-45 均省略该参数，multipart 还在 routes/tasks.ts:986 以仅含 db 的依赖先调用 materializeSpace。daemon 重启封存并清空 url 后，这些路径使用 cachedRepoId 会稳定返回 cached-repo-credential-unavailable。
  Recommendation: 在生产启动依赖中把 SecretBox 改为编译期必需，并贯通 agent、workgroup、scheduler/run-now 和 multipart 的首次 materialize 调用。用真实 sealed row 对 workflow、agent、workgroup、scheduled、multipart 五条路径做集成回归。
- [high] [P1 正确性] SSH user:pass 反例推翻了 backfill 的 hash 等价前提 (packages/backend/src/services/repoCredentials.ts:140-165)
  linkFromUrl 用任务中已经脱敏的 repoUrl 重算 hash。HTTP canonical 会丢 userinfo，但 SSH canonical 把 user 纳入键：`ssh://alice:sekret@example.com/org/repo.git` 的明文 canonical 是 `ssh://alice:sekret@...`，脱敏后则是 `ssh://***:***@...`，二者 hash 不同。升级后 tasks/task_repos.cached_repo_id 留空，历史私仓 relaunch 与记忆 scope 修复均失效；现有等价测试只覆盖 HTTPS。
  Recommendation: 封存前从 cached row 明文建立“脱敏身份→ID”映射，或用 SecretBox 解封后建立映射；只在唯一匹配时回填，多个 SSH 凭据镜像冲突必须显式报待修复，不能任取。增加 SSH URI user:pass 的迁移、relaunch 和 memory scope 回归。

Next steps:
- 阻断合并，先修复全部 P0，并以真实 SQLite/备份产物做 token 字节扫描。
- 补齐 cachedRepoId 五启动路径、schedule 空编辑/删缓存、SSH backfill 和真实 query-slug 回归后重新实施门检。
- 本 worktree 的 RFC-204 定向测试当前在收集阶段因缺少 `ulid` 依赖退出（0 pass、2 errors）；补齐依赖后运行完整 typecheck、lint、test、format 和 smoke 门禁。

Codex session ID: 019f8743-f572-79a3-9afa-918808148ff1
Resume in Codex: codex resume 019f8743-f572-79a3-9afa-918808148ff1
