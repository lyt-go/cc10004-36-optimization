# 数据产品运营与归因分析平台

面向数据产品运营、渠道归因、用户行为分析、ROI评估、转化优化与数据应用监控的数据分析工程平台。

这是一个**纯前端**管理平台：React + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 React + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 渠道管理 | `channel` | 渠道配置 | 渠道编号、渠道名称、渠道类型 |
| 投放活动 | `campaign` | 投放活动 | 活动编号、活动名称、关联渠道 |
| 触点追踪 | `touchpoint` | 触点记录 | 触点编号、用户标识、触点类型 |
| 归因分析 | `attribution` | 归因模型 | 模型编号、模型名称、归因算法 |
| ROI评估 | `roi` | ROI报告 | 报告编号、关联活动、投入金额 |
| 转化漏斗 | `conversion` | 转化定义 | 转化编号、转化名称、步骤序列 |
| 用户路径 | `userpath` | 路径模式 | 模式编号、路径名称、节点序列 |
| 留存分析 | `retention` | 留存方案 | 方案编号、方案名称、初始事件 |
| 事件定义 | `eventdef` | 埋点事件 | 事件编号、事件名称、事件类型 |
| 用户画像 | `profile` | 画像定义 | 画像编号、画像名称、统计维度 |
| 热力分析 | `heatmap` | 热力方案 | 方案编号、页面名称、热力类型 |
| 竞品对标 | `benchmark` | 对标方案 | 方案编号、对标对象、对比指标 |
| 数据审计 | `auditcheck` | 审计规则 | 规则编号、审计对象、校验字段 |
| 分流配置 | `abgroup` | 分流方案 | 方案编号、方案名称、分流类型 |
| 可视化配置 | `dataviz` | 图表配置 | 配置编号、图表名称、图表类型 |
| 舆情分析 | `sentiment` | 舆情方案 | 方案编号、监控主题、关键词集合 |
| 生命周期 | `lifecycle` | 生命周期模型 | 模型编号、模型名称、生命周期阶段 |
| 运营预警 | `opsalert` | 预警规则 | 预警编号、监控指标、比较方式 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `data-product-ops:entries` 这一项，或调用 `resetModule(模块)`。

## 画像分流增量影响域（PROF-0003 / ABGR-0001 / ABGR-0003）

用户画像与分流配置两个模块在通用 CRUD 之上，增加了独立的域数据层
`frontend/src/data/profile-ab/`，持久化键为 `data-product-ops:profile-ab`：

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 画像版本、分层、方案、命中记录、更新批次等不可变领域类型 |
| `engine.ts` | 纯函数引擎：分层人群计算、增量命中、批次仲裁、作废撤回、重合度、比例精度 |
| `seed.ts` | 域示例数据（v1 历史快照 + 两个待仲裁批次） |
| `store.ts` | localStorage 持久化与订阅发布，所有写操作整体替换状态 |
| `use-profile-ab.ts` | `useSyncExternalStore` 订阅 hook |
| `engine.test.ts` / `store.smoke.ts` | 48 条引擎断言与 store 冒烟 |

影响范围规则：

- 画像按**版本不可变**保存；更新批次只声明覆盖的分层区间，应用时按
  「画像版本 + 分层」定位受影响方案，只重算这些方案的命中，未受影响方案不产生新记录、
  继续复用原分流比例。同画像共享的分层人群在版本对象内只计算一次并缓存。
- 两个批次同时覆盖同一分层时，**覆盖完整度高者优先；完整度相同则批次序号（版本）新者优先**，
  败者标记「已被取代」并完整保留为历史，不生成任何人群与比例。
- 画像作废统一把当前命中候选标记 `withdrawn`（撤回），版本、命中、批次全部保留可对照；
  其它画像的方案不受牵连。
- 画像重合判断：两份画像当前版本全量分层人群的 **Jaccard 系数，阈值 0.6000**。
- 分流比例用**整数基点 bips**（1 bips = 0.01%）存储，人数按最大余数法分配，
  比例由人数反算并把舍入残差补给人数最多的组，各组比例之和恒为 100.00%。

测试与构建：

```bash
cd frontend
npm run typecheck      # 类型检查（测试文件不进生产构建）
npm run test:engine    # 引擎 48 条断言
npm run test:store     # store 持久化/订阅冒烟
npm run build          # 生产构建
```

领域：数据工程
子方向：数据分析与数据应用
