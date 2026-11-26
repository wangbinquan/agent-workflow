# RFC-611 技术设计

## 边界与架构

本次实现位于 `.github/`、CI 工具 `scripts/ci/`、Playwright 配置和测试 helper。RFC-294 的生产 context、依赖方向、持久化 owner、执行链均不变；不在生产模块新增调度或可变全局状态。独立纯规划/合并函数与 IO 边界分开，便于测试真实算法及失败路径。

## 1. 两条完整验证队列与快速反馈

CI concurrency group 为 workflow/ref/运行编号奇偶。GitHub 表达式不支持取模，使用 `endsWith(format('{0}', github.run_number), '0'/'2'/'4'/'6'/'8')` 选 even/odd。每组 `queue: max`、`cancel-in-progress: false`，从开始到 CI required 结束均持有 lane。同 ref 同时最多两轮完整矩阵，重试 run_number 不变。各组最多 100 pending 是 GitHub 边界，溢出仍须显式报告取消；不宣称全局 commit FIFO。旧策略已启动的 run 需自然结束后才能观察稳态。

两 lane 避免单 lane 在尾片时让容量空闲过多，也限制新 SHA 无限 fanout。它不增加账号配额，不保证其他 workflows/仓库不会争用，不能保证 macOS 供给。CI required 保留名称、needs、always、非 success 一律失败和 5 分钟执行预算。

GitHub 已支持 `queue: max`，但 actionlint 1.7.12 的语法表尚未更新（上游 issue #657）。`.github/actionlint.yaml` 仅对 `ci.yml` 的精确 unknown-queue 诊断做兼容；拓扑回归独立校验完整 concurrency 合同与例外范围，禁止 job 新增未校验 queue。其余 actionlint 错误仍失败；上游识别字段后删除该例外。

独立 `CI feedback` 运行格式、lint、类型检查，可 supersede 同 ref 的旧 feedback；它只提供早期诊断，不代签完整候选。复用同一质量命令。仅新增持久化内容校验的 Prettier 缓存，键包含工具、lockfile、配置；typed lint 不新增按单文件持久化缓存。

## 2. 时长与分片

后端继续使用 Bun 的整文件 `--timings` 与 44 个 runner。初次刷新用成功 run 的全部 44 片原始结果，记录来源 SHA/run；合并器验证版本、路径、非负有限时长、重复、分片齐全与来源 Git tree 的测试全集。当前新增未测文件保持 Bun 的缺省权重并在更新摘要中列出；不捏造测量。自动化只产出审阅 artifact，不擅自写共享 main。

后端只上传成功片的计时，避免成功重跑时可选上传故障留下旧失败样本。刷新器拒绝旧 workflow 的多 attempt 运行；只有首次即成功的旧运行，或 source workflow 已采用 success-only 上传，才可合并。本次基线 run 的 attempt 为 1。

E2E 保留 Linux 3、macOS/Windows 各 4 片以及每片 4 workers。先由同一 Playwright base config 的原生 `--list` 得到实际入选 spec（同 project/grep），再按该 OS 的历史权重将完整文件分配到片。执行通过 child config 的精确 testMatch 选择本片，禁止再次 native shard，否则会漏测。全部片共享同一确定性输入及算法；并集等于发现集、交集为空；无权重新文件使用明确保守缺省值。保持文件内顺序和 beforeAll 语义，不打开 fullyParallel。

初始 E2E 权重来自成功日志的可见耗时估计，明确记录为 estimate，不能称为精确整文件测量。新增 reporter 记录文件运行时间窗口及成功状态，为后续刷新提供证据；仅接受完整成功运行，保留 setup/teardown 测量限制。其他 nightly 和本地默认入口继续原配置，避免误施主 CI 的 tier 分配。

`CI timing refresh` 在 main push 的完整 CI 成功后下载 44 个后端及 11 个 E2E 产物，验证来源 SHA、测试全集、无遗漏/重复和各平台分片一致性。E2E 只接受完整且无重试的测量；重跑失败 job 后遗留的较早成功片可以使用，但逐片 attempt 必须不晚于最终 run attempt，并保留来源。输出 `reviewed-ci-timings-<run-id>` artifact，审阅后才更新仓内权重。手动刷新命令分别为 `bun scripts/ci/refresh-backend-timings.ts ARTIFACTS_DIR RUN_ID OUTPUT_JSON` 和 `bun scripts/ci/refresh-e2e-timings.ts ARTIFACTS_DIR RUN_ID OUTPUT_JSON`；需在主 checkout 中拥有对应源 commit，并通过 gh 访问该运行。

## 3. 测试夹具稳定性

`rfc398AutoUpgrade.barriers()` 写同目录唯一临时文件，再原子 rename 到原路径，finally 清理临时文件。production checkpoint 读者不变。新回归以持有旧 inode 的文件描述符证明读者只能见到旧完整值或新完整值，验证发布失败清理。

wait 监测调用时活跃的直属子进程原始 exited promise。意外非零退出先重读目标条件，目标未满足才快速报 PID/退出码及 stdout/stderr。kill 在发信号前登记预期死亡；已结束的历史失败不污染新 wait，正常 0 退出不当故障。不能因为故意杀父进程而破坏接管用例。不扩大为生产进程监督重构。

## 4. 下游条件与链接

E2E 仅在本平台 build success 时启动，失败/取消保留在 CI required。可选计时 artifact 上传不能使测试绿变红。

docs job 首先用 Lychee offline 扫全部 design Markdown 的仓内链接；再对本次 push/PR 的变更 design Markdown 在线检查。比较使用事件明确的 base/head，缺失 base 或手动触发保守检查全部。文件名通过结构化数组/NUL 安全传递，不拼 shell。重命名后的路径按新路径取，删除文件不传入。

每日外链 workflow 扫全历史 design Markdown，保留原 HTTP 状态策略、证据链接排除、有限重试和失败可见性。主门不直接接受 503，不掩盖被修改文档的真实外链问题。

## 5. 验证与发布

先完成全部代码、workflow、回归、配套，再一次集中跑相关单元/拓扑/fixture测试及必要静态检查。E2E 分片用真实 `--list` 验证全集与各片映射，不在本机重复全量 CI。发布采用 shared main 短 critical section、精确 allowlist、空共享 index、正常 commit/push；保留所有并发输出。exact-SHA hosted CI 是最终全仓证据，其他 session 引入的失败只记录归因。

后续观察：完整 run 墙钟/queue、CI required ready→start、runner 总分钟、各片 P50/P90/max、首次失败时延、按根因分类的失败率。当前阶段不承诺低于某分钟，先对比同覆盖候选及压力条件。
