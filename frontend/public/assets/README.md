# assets · 主角资产包

> 产出：三维建模专家（P3）· 2026-11-10
> 口径：**按行业通用型号建的示意资产，非本井实物**。
> 数据：sidecar 绑的是 bundle 里的历史值（`current_oil`），**不是实时**。

## 文件

| 资产 | LOD0 / 1 / 2 三角面 | LOD0 体积 | 预算（D-001） | 占比 |
|---|---|---|---|---|
| 抽油机 `pumpjack` | 6,108 / 3,504 / 2,564 | 159 KB | 60k | 10.2% |
| 采油树 `christmas_tree` | 8,988 / 5,152 / 4,032 | 184 KB | 25k | 36.0% |
| 拱顶储罐 `tank` | 12,028 / 3,760 / 1,504 | 229 KB | 40k | 30.1% |

三件 LOD0 合计 **572 KB**，base64 内联 ≈ 763 KB（D-004 闸门 8 MB，用掉 9.5%）。

| 文件 | 内容 |
|---|---|
| `<asset>_lod{0,1,2}.glb` | 三档 LOD，米制、Y-up、底面贴地 |
| `<asset>.twin.json` | sidecar：设备 ID ↔ 业务主数据 |

## 尺寸与朝向

| 资产 | 包围盒（Blender: X/Y/Z） | three 里读到的（Y-up） | 朝向 |
|---|---|---|---|
| 抽油机 | 9.0 × 2.5 × 8.6 | 9.0 × 8.6 × 2.5 | 驴头在 +X，电机在 −X |
| 采油树 | 1.2 × 1.0 × 2.6 | 1.2 × 2.6 × 1.0 | 两翼沿 ±X |
| 储罐 | 9.0 × 9.0 × 9.0 | 9.0 × 9.0 × 9.0 | 回转体，无朝向 |

> 九个数全部 **误差 0.0000%**，`calibration_scale` 全为 `1.0`（即建模直接命中，没有靠缩放兜底）。

## 节点结构

**抽油机**（6 个运动组，供 T08 四连杆驱动）：
```
PM_ROOT
├── pq_static           底座 / 支架 / 减速箱 / 电机 / 井口 / 护栏 / 梯子
├── pq_beam             游梁 + 驴头 + 绳挂   ← 绕支架轴承摆动
├── pq_crank_l / _r     曲柄臂 + 平衡块      ← 绕曲柄轴回转
└── pq_pitman_l / _r    连杆                 ← 两端铰接
```
冲程 `S ≈ 2R × (前臂/后臂)` = `2 × 0.86 × (4.05/1.90)` = 3.66 m（144 in）。
支点 `(-1.20, 0, 7.70)`、曲柄轴 `(-3.30, 0, 1.05)`、后臂铰点 `(-3.02, ±0.80, 8.00)`。
静态曲柄停在 **130°**：90° 时曲柄臂-连杆-游梁后臂共线，四连杆关系读不出来。

**采油树**：`ct_static`（全部阀体与法兰）+ `ct_wheel`（所有手轮，可整体转）。
层序自下而上：底座法兰 → 套管头 → 套管四通 → 油管头 → 下主阀 → 上主阀 → 四通 → 双翼（左翼带节流阀）→ 树帽 + 压力表。

**储罐**：`tk_static` + `tk_liquid`（液位柱，T08 按 % 缩放 Y）。

## 装载代码骨架

```ts
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const loader = new GLTFLoader()
const [l0, l1, l2] = await Promise.all(
  ['_lod0', '_lod1', '_lod2'].map((s) => loader.loadAsync(`/assets/pumpjack${s}.glb`)),
)
const lod = new THREE.LOD()
;[0, 150, 600].forEach((d, i) => {
  const s = [l0, l1, l2][i].scene
  s.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  lod.addLevel(s, d)
})
scene.add(lod)

// 8 台实例化：同型号只存 1 份几何
// 实测不做实例化 8 台 = 136 draw call，做了 = 18（含地面 1 个）

// sidecar
const side = await fetch('/assets/pumpjack.twin.json').then((r) => r.json())
// dev.value.oil_m3d  m³/d（取自 bundle current_oil）
// dev.status        green/yellow/red/gray，与 WellGeo.state 同口径，可直接喂 COLOR 表
// dev.link          /well/{well_id} → 点设备跳决策卡
```

## 已知局限

1. **零贴图**。材质是纯 PBR 参数，没做 Cycles 烘焙。理由：单件最多 12k 三角，在井场 520 m 视距下贴图无收益；贴图预算 0 / 40 MB。
2. **未做 Draco**（R-008 已裁 A：弃用）。未压缩体积已远低于闸门，Draco 要额外内联 ~400 KB decoder wasm。
3. **储罐未做外挂盘梯**。实物盘梯外伸 0.9–1.2 m，做了直径就变 10.2 m，与 spec 的 Φ9.0 直接冲突。侧壁接管同样压成贴壁凸台（实物外伸 0.3 m）。这是**为守包围盒断言做的取舍**，不是漏做。
4. **采油树阀体是方箱**。真实闸阀是圆角铸件，这里用 box 近似；加倒角会让单件面数翻倍，而画面上看不出差别。
5. **帧率没测**。软件渲染数字不能当达标（P3 明令），等 T19 真机。
6. **运行态没做**。四连杆解析式、液位跟随、管流 shader 属 T08；glb 只保证节点可独立驱动。
