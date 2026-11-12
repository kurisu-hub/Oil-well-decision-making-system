# 油井措施决策系统

面向油井措施筛选的离线原型。主应用串联井区筛选、单井产量与不确定性、预算约束下的组合比较、复盘和报告。页面中的历史回放使用本地数据，不连接生产设备或实时数据源。

## 运行示意版

在新克隆的仓库中，使用 Node.js 22.12+（已使用 Node.js 24）：

```sh
cd frontend
npm ci
node tools/prepare-demo.mjs
npm run dev
```

也可运行 `npm run typecheck` 和 `npm run build`。构建完成后打开 `frontend/dist/index.html`，无需启动服务。示意井和回放只用于走通界面；油价和成本档位没有预计算收益表，缺失项不能用来评估措施效果。生成脚本保留已存在的本地数据文件。

## 目录

| 路径 | 用途 |
| --- | --- |
| `frontend/src/` | 主决策应用，Vue、TypeScript、Three.js、ECharts |
| `frontend/screen/`、`frontend/twin/` | 两个独立的大屏和三维展示原型；各自需要本地 `src/data.json` |
| `pipeline/` | 措施事件提取、递减基线、预测与区间、组合优化、回测和孪生状态脚本 |
| `tools/` | 数据打包、离线验收与 Blender 模型生成工具 |

本仓库保留源码、依赖锁定文件、示意夹具和通用三维模型。原有井样本及其衍生 JSON、发布包、截图和评测输出留在本地。大屏入口的 `data.json`、模型流水线引用的原始产量和措施事件表不随仓库提供；部分脚本仍依赖原交付目录。`frontend/README.md` 记录早期版本，当前示意版的启动步骤以上文为准。
