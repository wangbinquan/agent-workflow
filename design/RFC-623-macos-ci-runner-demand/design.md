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

## 托管超时后的后端权重修正

首轮新macOS拓扑通过，但既有后端第10片在同内容、普遍变慢条件下耗尽15分钟。修正更新`.github/backend-test-timings.json`及配套`.source.json`，并增加复用严格collector的手动多来源数据准备器及回归；不触及生产源码、业务测试或运行命令。采用完整成功6c92/run45846353277与d8385a/run45893530203的逐文件较大实测值，分别验证44份产物及各自精确source全集。最终投影到当前已提交3108文件，全部有测量且无removed；未提交在制文件不得混入数据分析。

继续Bun1.4.3原生连续加权44片算法；以相同完整green文件成本对照新旧边界及预算敏感性，区分历史模型与hosted结果。每片文件内容与全集覆盖由原生分片语义保持，现有source完整性回归复用；集中验证检查新数据provenance、准确文件集合、原生边界与原44片/15分钟接线。最终仍由新exact-SHA完整CI验收，保留首轮失败与macOS retry证据，不直接重跑原失败job追绿。

### 严格多来源数据准备器

单源d838经跨green成本复核后暂缓，改为两个完整成功来源的逐文件最大值。新增手动数据准备CLI，复用现有collector读取完整raw artifact目录：先分别验证整个source run成功、实际source SHA workflow、success-only rerun upload规则、原44片与精确source tree测量全集，再允许进入组合。失败run/缺片/重复/外来路径/无效时长任一出现均拒绝，不从review摘要猜完整性。自动CI collector继续只输出单次真实测量，不自动发布组合权重。

抽取现有backend collector的source读取为可复用函数，保留原CLI参数/输出语义；新CLI接受输出路径及明确的artifact目录/run ID对，至少两个不同成功run。纯组合器验证每份完整source数据与元信息，按目标已提交SHA的测试文件全集投影；每个值必须精确等于一个source的该文件测量，取最大值、相等时选run ID较大者，不依赖参数顺序。未被任何source测量的新文件仍不造权重，记录unmeasured并使用原Bun默认值；本候选3108文件全部有测量。旧来源中已移除的文件记录removed，不复活测试。

组合输出保持Bun原生version1/files格式；配套source元数据明确aggregation=per-file-maximum、目标SHA、各完整来源原SHA/run/shards/files/总测量、每个文件选中的来源、合成估值总和及未知/移除清单，不冒充某一次完整run。数据输出只写指定审阅路径，root审阅后精确复制入库。

回归覆盖两个完整source、输入顺序稳定/相等取较新、旧新文件集合、每个数值来源、无人工系数、missing/duplicate/invalid source与duration拒绝、失败source/不完整片继续由原严格collector拒绝；原单来源CLI必须保持兼容。全部新实现/测试写齐后集中执行相关范围，真实88份artifact CLI回放核验，独立功能门与新hosted结果仍必需。

组合与来源读取回归加入现有`ci-backend-timing-refresh.test.ts`，不新增测试文件；因此修正候选的测试路径全集仍为3108，生成数据可以按当前已提交目标tree完成，无须为了权重生成拆分本地提交。新增CLI属于scripts/ci，不增加后端测试路径。
