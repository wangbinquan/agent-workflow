# RFC-623 技术设计

## 所属层次与现有机制

本次属于仓库CI工程层：`.github/workflows`、`scripts/ci`和其回归。不改产品bounded context、生产装配或持久化；遵循RFC-294的复用既有机制原则，不新增产品层调度器，不为纯CI变更申领架构迁移credit。

复用RFC-611的Playwright原生discovery、整文件LPT分配和运行期test ID精确校验，复用RFC-615同提交reusable workflow与13输出严格required。只将macOS矩阵完整地改成1..3和分母3；原共享执行步骤、macos-latest（实际macOS26 arm64）、build依赖、4workers/retries1、20分钟预算保持。Linux3/Windows4保持。

## 计时来源与兼容

使用6c92 / run45846353277已完整验证的controller-wall-clock权重。来源仍诚实记录历史3/4/4、finalAttempt2；mac3仅为未获runner后的重新领取，源文件均无Playwright retry。其余平台权重一起更新，不伪造或补造计时。新文件沿用原默认值。

`assertE2EShardTopology`从source SHA解析出的workflow返回可信拓扑，只接受完整3/3/4或3/4/4。每个平台必须有准确OS、完整索引1..N和同一分母，不允许include/exclude或混合矩阵绕过。CLI把该拓扑随source传给merge；merge入口再次验证允许拓扑，不能依据artifact数量推断。

artifact总数、plan/timing分母、完整平台名称、输出provenance的sourceShardCounts均由同一source topology决定。继续严格验证run/SHA/attempt、discovery digest、整个分配、实际tests/文件与retry序列；完整检查结束后才允许含重试的合法样本中性skip。历史四片缺一份不能解释为新三片成功。

## 不变量与失败处理

完整CI69个物理job，13个独立结果不变；任一失败、取消、跳过、缺失或未知结果都使CI required失败。分片减少不改变case集合、过滤、预期skip或进程清理。没有新执行器或并发模型，单机仍仅一套4worker Playwright。exact-once指分片身份归属一次，既有retry的多个attempt与预期skip保持；不为字面执行次数禁用重试。

保留两条计算lane，不将观测峰值20当成已确认套餐上限。macOS平台容量仍可能导致等待/未领取；不以自动重跑测试失败或提高超时掩盖它。测试数增长和慢runner仍可能耗尽20分钟，以hosted证据为准。

## 验证设计

1. 保留四片exact-once回归并新增三片全集等价、顺序稳定、新文件默认及运行期selection拒绝测试。
2. 两种collector拓扑分别验证完整来源、缺失/重复、错误分母、错SHA/digest、unsupported拓扑、含retry及后续corruption；当前source/历史source路径都覆盖。
3. 拓扑门明确更新69job、macOS3片；全部13组输出、deadline、无exclude、filters及原运行命令继续锁定。
4. 全部开发完成后只做一次相关集中验证；有本人缺陷只复验受影响范围，不因共享HEAD前进重跑全量gate。
5. exact-SHA hosted检查完整69job/10E2E、测试population与timing完整性，再按领取与执行分开的口径记录实际效果。

## 权威资料与证据

- [GitHub Actions limits](https://docs.github.com/en/actions/reference/limits)：默认macOS并发Free/Pro/Team均5，larger与standard共用；实际账户调整未知。
- [runner images](https://github.com/actions/runner-images)：镜像标签不构成独立容量保证；当前latest为macOS26 arm64。
- [larger runners](https://docs.github.com/en/actions/concepts/runners/larger-runners)：组织Team/Enterprise资格与收费，不作为个人仓库的免配置替换。
- [矩阵并发](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations)：max-parallel约束执行并发，不减少runner申请次数。
- 本轮7run原始JSON、并发区间、官方capacity annotation与分析脚本保存在任务临时证据目录；来源run ID在proposal逐项列明。
