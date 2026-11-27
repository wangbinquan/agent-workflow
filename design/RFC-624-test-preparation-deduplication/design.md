# RFC-624 技术设计

## 层次与约束

本次属于测试工程层，新增共用机制落在tests/helpers或测试配置中；不改变产品bounded context、生产装配、数据模型或RFC294目标依赖方向，不申领生产架构迁移credit。复用现有native provider、Playwright/Vitest、fixture清理和守卫机制。

## 数据库模板选择

`Rfc395FixtureGeneration.reset()`无参数行为保持：创建独立可用空库，后续native/runtime访问、原install语义不变。增加显式initialTemplateKey：已有模板时直接创建独立clone，未命中走原冷路径；记录预备key，首次install必须匹配声明，热命中只消费预备状态，不重复drop/clone。同例后续install继续在当前库执行升级callback。错误key拒绝，不静默套用其他版本。

仅Q3PhaseBoundary固定head路径opt-in，经V3/V2/V1/R2传递明确的初始版本/key resolver。其它harness保持无参数reset，不引入异步getter或通用lazy runtime代理。每例独立physical DB，template只读；SQLite行为和两provider保持。原pending/cancel/drain/session close/drop顺序及真实SQL错误/锁释放回归保留，并增加冷/热、错误key、空库与二次安装对照。构造器可注入真实database factory用于观察与屏障控制，默认仍是原native provider实现；回归实际执行CREATE/DROP和SQL，不替换结果。重叠reset在pending检查之后才恢复stopping，避免清除正在进行的取消；晚到clone先接管后检查取消，确保cleanup能删除。

## 相同静态语料与报告

集中15条同口径旧路径规则到一个有界套件，各规则保留独立测试名和OLD/MOVED唯一权威数据。新套件自身持有原四根目录递归枚举，包含未跟踪工作树文件；共享helper仅提供纯解析及规则数据。原15文件其余独有断言保持；所有原负向fixture改用同一个真实parser，不能继续检验被废弃的副本。

新scanner保留与实际枚举关联的>=6000下限、正向误报/负向漏报fixture、零违规断言，并可被guardTestFiles发现。guard-manifest只按实际职责迁移scanner/下限/fixture记录；不改T13/T14算法、例外或高水位，不扩大其它口径不同的守卫范围。不引入持久扫描缓存。

RFC370的module-owner人口、backend/module数量和sourceSha断言移到RFC376现有first报告。RFC376仍从固定SHA独立读取并构建second，禁止共享同一结果冒充确定性。RFC370 committed reader的revision/extra input/缺失路径/无效revision测试继续。V2/V3共同正向runtime/CLI四断言保留一份，分别的isV2/isV3、恢复机制及profile负向规则不合并。

## E2E与前端

三个独立E2E文件去掉mode:serial，保持fullyParallel:false、文件内顺序、4workers、CI retry=1/本地retry=0和原case/job预算。各case本来无suite hooks或跨case可变状态，每例自建环境并finally清理。增加真实Playwright runner的小型失败注入回归，证明顺序保持且只有失败case重试；不需要浏览器即可验证调度语义。产品E2E仍走原三平台真实浏览器。canvas-controls仅把无关daemon/登录/agents页面换为page.setContent提供原固定几何元素，原遮挡负例、错误坐标、<5s和正向点击断言保持。

Vitest两个inline projects显式extends:true；公共alias/css/globals/30s预算保留。source-guards精确include原已审4文件；dom使用原默认include与configDefaults.exclude加相同4文件，happy-dom、URL和原setupFiles移至dom内部，避免数组继承使Node仍加载DOM setup。原两OS各3分片、shuffle和命令不变。发现集合/项目环境/预算用原生globTestSpecifications和resolved/workerSerialized config核验，专项测试另执行。明确名单为`tests/canvas-corner-theming-source.test.ts`、`tests/canvas-wrapper-styles.test.ts`、`tests/btn-variants-styles.test.ts`、`tests/tabs-modifier-styles.test.ts`（均相对packages/frontend）。

两份ValidationPanel测试保留原路径，共用非test helper仅构造fresh definition、真实组件和打开overlay；不复制生产判断、不共享DOM/回调。保留warning分组、code/message、Auto-fit显隐与回调、route clearWrapperSize接线。真实消息按Raw details入口检查；definition包含真实wrapper，legacy pointer正向保持；新增strict target优先、失效不回退pointer和缺callback隐藏。Node守卫正文不变。

## 验证与计时

先完成全部生产接线/测试和义务映射，再集中执行相关Bun/Vitest测试、真实provider fixture回归、Playwright原生发现和小型runner协议回归，以及相关类型/lint/format/actionlint和账本检查。运行一次完整hosted CI，失败先按日志/源码归因，修本任务缺陷，不以重跑追绿。

保存精确基线及候选run/jobs/原始计时；旧到新文件/测试义务映射处理合法迁移。优先比较同源码基线79085123与最终候选受影响组总成本；无完整基线或存在重试/无关依赖变化时明确限制。报告实际完整CI结论、backend/E2E/前端组耗时、runner-minutes、领取等待及墙钟，不承诺未经实测的节省比例。
