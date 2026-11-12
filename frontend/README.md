# Weld 区块压裂措施决策 · 前端四幕

纯静态离线演示站。**只读 `bundle.json`**，不连后端、不调模型、不发任何请求。
构建产物是**单个 `dist/index.html`**，断网双击即可运行。

## 1. 快速开始

```bash
cd frontend
npm install          # 无 pnpm，统一用 npm
npm run dev          # 开发预览 http://localhost:5173
npm run build        # 产出 dist/index.html（单文件，约 1.1 MB）
npm run typecheck    # vue-tsc --noEmit
npm run acceptance   # 无头 Edge 跑 16 项验收断言
npm run verify       # typecheck + build + acceptance 一条龙
```

打开方式：直接双击 `dist/index.html`（`file://` 协议）。**hash 路由**，刷新不会 404。

## 2. 技术栈（版本已锁定并实测）

| 层 | 选型 | 版本 |
|---|---|---|
| 框架 | Vue 3 + TypeScript | vue 3.5.44 |
| 构建 | Vite（Rollup 版，非 Rolldown） | vite 7.3.7 |
| 单文件 | vite-plugin-singlefile | 2.3.4 |
| 状态 | Pinia | 4.1.0 |
| 路由 | Vue Router（hash） | 5.4.0 |
| 图表 | ECharts（**按需 `use()`**） | 6.1.0 |
| UI | Naive UI（按需 import） | 2.45.3 |
| 类型检查 | vue-tsc / TypeScript 5.x | 3.3.13 / 5.9.3 |

> 刻意不用的版本：Vite 8（Rolldown 与 singlefile 组合未经验证）、TypeScript 7（Go 重写版，vue-tsc 兼容性未验证）。
> 包管理器固定 **npm**，不安装 pnpm。

## 3. 四幕与路由

| hash | 页面 | 内容 |
|---|---|---|
| `#/` | `Panorama.vue` | KPI 条 · 2.5D 井区（SVG）· 价值矩阵（ECharts 四象限）· 筛选/假设滑杆 |
| `#/well/:wellId` | `DecisionCard.vue` | 反事实三条世界线 · 四象限 · 不确定性指纹 · 证据链 · 动作面板 · 数据缺口 |
| `#/portfolio` | `Portfolio.vue` | 预算/风险档位 · 候选表 · **五栏对照** · 结算摘要 · 有效前沿 |
| `#/review` | `Review.vue` | VOI · 学习曲线 · 历史回放 · 规律消融 · 协议抽屉 · 数据卡 |
| `#/report` | `ReportView.vue` | A4 决策报告（`window.print()`，含签字栏） |

全局：`TopBar`（数据模式角标 / 契约提示）· `PassportDrawer`（数字护照抽屉，任意数字可点开）。

## 4. 数据规则（**不可协商**）

- 数据源：`src/data/provider.ts` 的 `getBundle()`，JSON 用 `import` 引入，**禁止 `fetch`**。
- **主 `mock_bundle.json` 逐字节未修改**（与 `10_前端与模型对接/mock_bundle.json` 完全一致，可用 `cmp` 校验）。
- 缺失字段一律显示 **「暂无」**，不推算、不编造。
- 示意补充数据放 **`src/data/mock_supplement.json`**，与主 bundle **分离**：

| 项 | 说明 |
|---|---|
| 合并方式 | 只追加主 bundle 里不存在的条目，**同名不覆盖** |
| 新增井 | `W004`（低产、NPV −3、置信 0.31）补齐**灰象限** |
| 新增区块 | `learning_curve` / `backtest` / `ablation` / `protocol`（第四幕四块） |
| 角标 | 所有补充条目 `source: "illustrative"`，UI 必打 **「示意」** |
| real 模式 | **不加载**补充文件 → 空象限 / 缺块显示「暂无」 |

### 切真数据（自动识别，不用改代码）

| 落到 `src/data/` 的文件 | `meta.data_mode` | 顶栏角标 |
|---|---|---|
| `bundle.json` | `real` | **实测数据**（绿） |
| `pilot_bundle.json` | `real_pilot` | **实测 pilot**（青蓝） |
| 都没有 | `synthetic` | **示意数据**（黄，加载 mock + 示意补充） |

优先级：`bundle.json` > `pilot_bundle.json` > mock。
**pilot_bundle.json 一旦落盘即自动生效**，无需改任何代码；正式全量到了直接覆盖即可。
可用 `VITE_DATA_MODE=real | real_pilot | mock` 强制指定；指定了但文件缺失会回退 mock 并在角标报「数据缺失」。

> `real` / `real_pilot` 下**不加载**示意补充文件 → 空象限与第四幕缺块一律「暂无」，不冒充实测。

## 5. 第三幕「你的选择」结算口径

| 指标 | 口径 |
|---|---|
| 期望增油 / 期望 NPV | **所选井单井值求和**（期望值线性可加；已用 mock 三个 grid point 验算恒等：420+310+60=790、68+42−8=102） |
| 亏损概率 / CVaR / 命中率 / 后悔值 | **不做前端公式**，只查表。查表顺序：**① `combo_metrics`（优先）→ ② `portfolio.points`（回退）** |

- 有 `combo_metrics` 时**只查它**，未命中就是「暂无」，不回退（避免两个口径混用）。
- 没有 `combo_metrics` 时才回退 `portfolio.points`，同样未命中即「暂无」。
- 查表 key = `selected` 按 `well_id` 排序后拼接，与模型侧约定一致。
- 默认勾选取 `combo_metrics.items[0]`（模型推荐组合），保证开局就能命中查表。

契约新增字段（只加不改）：

```ts
interface ComboMetric { selected: string[]; loss_prob: number; cvar: number; hit_rate: number; regret: number }
interface ComboMetrics { available: boolean; k: number; n_total: number; n_items: number; items: ComboMetric[] }
```

预算/风险滑杆只走 bundle 里**实际存在的档位**（45/90/135、0.1/0.2/0.3），不做插值。

## 6. 已知缺口（留给模型侧，前端已降级到位）

1. **`passport` 缺 `p_conf_w003`**（W003 引用了它）→ 护照抽屉该条显示「暂无」。
2. **第四幕四块契约顶层未定义**：`learning_curve` / `backtest` / `ablation` / `protocol`
   目前由 `mock_supplement.json` 以「示意」提供。请在契约 v1.1 固化字段后由
   `build_frontend_bundle.py` 产出真值。
3. **`strategies` 缺 `you`** → 由前端按上表口径生成（符合契约说明）。
4. **`portfolio.points` 覆盖不全**：objective 仅 `npv`，budget/risk 各 3 档 → 网格外的组合指标为「暂无」。
   已由 `combo_metrics`（Top-20，C(20,3)=1140）接管该栏，pilot bundle 请务必带上它。
5. **「至少一个指标老师傅赢」未满足**：当前 mock 中老师傅在 `hit_rate` 与 AI **打平**（0.5），
   其余指标均落后。前端如实高亮并列最优，未做修饰；需数据侧补真值再判。

以上均可在 `#/review` 的「契约校验」面板看到实时提示。

## 7. 已通过的验收（16/16）

`npm run acceptance` 用无头 Edge 逐条断言，当前全绿：

```
首页 3 秒内可交互（229 ms）        单井 1 秒内打开（36 ms）
四象限都有井（绿/黄/红/灰 各 1）   数据模式角标可见
决策卡含 曲线/保本线/滞后/指纹/证据链/缺口
数字护照抽屉可打开且含公式          第三幕：求和 + 查表；未命中 → 暂无
第四幕四块有内容 + 示意角标         报告含页眉与签字栏
1920×1080 / 1366×768 布局不崩（横向溢出 0px）
断网（offline）首页与第四幕可跑     无 console error / 未捕获异常
```

产物自检：`dist/index.html` 无任何外部 `src`/`href`，无 CDN、无 `fetch` 本地 JSON。

### pilot 接入已用一次性夹具验证（夹具已删除，未入库）

按 pilot 口径造了 120 井 / 120 事件、带 `combo_metrics`、且**故意不带**第四幕四块的夹具，
构建后实测：

| 项 | 实测 |
|---|---|
| 顶栏角标 | **实测 pilot** |
| 井/事件 | 120 / 120，全部命中筛选 |
| 首页渲染（120 井） | **287 ms**（限 3 s） |
| 第三幕默认勾选 | 命中 `combo_metrics`，显示 Top-20 |
| 第四幕 | 3 块显示「暂无 · 等待模型侧产出 …」；**示意角标 0 个** |
| 产物体积 | 1,570 kB（120 井规模；mock 为 1,120 kB） |

结论：真 pilot bundle 落盘即可生效，无需改前端。

## 8. 环境坑：Windows 受控文件夹访问

工程放在**桌面**等受保护目录时，`node_modules` 里的 `esbuild.exe` 会被拒绝读取文件：

```
X [ERROR] Cannot read file "package.json": winapi error #5
```

`npm run build` 已通过 `tools/build.mjs` 自动规避：把 esbuild 二进制复制到系统临时目录，
再用 `ESBUILD_BINARY_PATH` 指向它。无需手工干预。
若仍失败，把工程移到非受保护目录（如 `D:\work\`）即可。

## 9. 硬约束对照

- ✅ 只读 `bundle.json`，不调后端/模型/API
- ✅ JSON `import` 引入，`vite-plugin-singlefile` 打单文件
- ✅ hash 路由，断网双击可开
- ✅ 无外部 CDN 外链、无 `fetch` 本地 JSON
- ✅ 不做 3D / Three.js，井区与剖面用 SVG
- ✅ 不做登录、后端、数据库
- ✅ 不修改 bundle 字段，只新增不改动；缺失显示「暂无」
