"""
make_sidecar.py · 生成 <asset>.twin.json（P11 §3 规范）

作用：把「模型节点」和「业务主数据」焊在一起。
      前端按 id 反查节点，link 直达决策卡 —— 这一条是「孪生」和「模型展示」的分界线。

数据来源：02_可运行产物/pilot_bundle_final77.json（77 井真实月产油曲线）。
不编造数值：每台设备的 value 都从 bundle 取；取不到的字段留 null 并标注来源。

用法：
    python make_sidecar.py --asset pumpjack --bundle <bundle.json> --out <dir>
    python make_sidecar.py --asset christmas_tree --bundle <bundle.json> --out <dir>
    python make_sidecar.py --asset tank --bundle <bundle.json> --out <dir>
"""
import argparse
import json
import os
from datetime import datetime, timezone, timedelta

CST = timezone(timedelta(hours=8))

ASSETS = {
    "pumpjack": {
        "prefix": "PM",
        "spec": "C-456-305-144",
        "label": "抽油机",
        "bbox": [9.0, 2.5, 8.6],
        "bind": "well",
    },
    "christmas_tree": {
        "prefix": "XT",
        "spec": '7-1/16" 350',
        "label": "采油树",
        "bbox": [1.2, 1.0, 2.6],
        "bind": "well",
    },
    "tank": {
        "prefix": "TK",
        "spec": "500m3 D9.0 H9.0",
        "label": "拱顶储罐",
        "bbox": [9.0, 9.0, 9.0],
        "bind": "site",
    },
}

DISCLAIMER = (
    "按行业通用型号建的示意资产，非本井实物；"
    "尺寸取自 API Spec 11E / API 6A / API 650 通用规格。"
)


def latest_oil(well, curve):
    """取该井当前产油（m³/d）：current_oil → actual[-1] → history[-1]。返回 (值, 来源)。"""
    v = well.get("current_oil")
    if v is not None:
        return float(v), "current_oil"
    for key in ("actual", "history"):
        arr = curve.get(key) or []
        for pt in reversed(arr):
            val = pt.get("oil")
            if val is not None:
                return float(val), key
    return None, None


def build_well_bound(bundle, spec, count):
    """抽油机 / 采油树：一台设备绑一口井。"""
    wells = bundle.get("wells", [])
    curves = {c["well_id"]: c for c in (bundle.get("curves") or []) if "well_id" in c}
    cand = [w for w in wells if w.get("well_id") in curves]
    cand.sort(key=lambda w: w.get("anchor") or 0, reverse=True)
    picked = cand[:count]

    data = {}
    for i, w in enumerate(picked, start=1):
        wid = w["well_id"]
        oil, src = latest_oil(w, curves[wid])
        dev_id = f"{spec['prefix']}-WELD-A-{i:03d}"
        st = w.get("state", "gray")
        color = {"green": "#4f8a5b", "yellow": "#b99340", "red": "#a8453c", "gray": "#59636a"}[st]
        value = {
            "oil_m3d": round(oil, 3) if oil is not None else None,
            "oil_src": src,
            "npv_wan": round(w.get("value_npv") or 0, 2),
            "status": "running" if st != "gray" else "idle",
            "well_id": wid,
        }
        if spec["prefix"] == "PM":
            value["stroke_rate"] = 7.2      # 冲次：设备参数，非测量值（T08 可调 1–12）
            value["stroke_m"] = 3.66        # 144 in
        else:
            value["wellhead_pressure_mpa"] = 35.0   # 350 型额定值，非实测
        data[dev_id] = {
            "value": value,
            "status": st,
            "color": color,
            "label": f"A-{i} {spec['label']} · {wid}",
            "link": f"/well/{wid}",
            "model": {"id_prefix": f"{spec['prefix']}-", "spec": spec["spec"], "bbox_m": spec["bbox"]},
        }
    return data


def build_site_bound(bundle, spec):
    """储罐：绑站，value 用全站聚合（77 井合计），不摊到单井。"""
    wells = bundle.get("wells", [])
    oils = [w.get("current_oil") for w in wells if w.get("current_oil") is not None]
    total = round(sum(oils), 3)
    npvs = [w.get("value_npv") for w in wells if w.get("value_npv") is not None]
    dev_id = f"{spec['prefix']}-WELD-A-001"
    return {
        dev_id: {
            "value": {
                "site_oil_m3d": total,
                "site_oil_src": "sum(wells.current_oil)",
                "well_count": len(oils),
                "site_npv_wan": round(sum(npvs), 2),
                "level_pct": 62.0,          # 液位：演示参数，T08 随数据变
                "capacity_m3": 500.0,
                "status": "in_service",
            },
            "status": "green",
            "color": "#4f8a5b",
            "label": "Weld 站 · 1# 拱顶储罐",
            "link": "/site/weld",
            "model": {"id_prefix": f"{spec['prefix']}-", "spec": spec["spec"], "bbox_m": spec["bbox"]},
        }
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--asset", required=True, choices=list(ASSETS.keys()))
    ap.add_argument("--bundle", required=True)
    ap.add_argument("--out", required=True, help="输出目录（文件名自动为 <asset>.twin.json）")
    ap.add_argument("--n", type=int, default=8)
    a = ap.parse_args()

    spec = ASSETS[a.asset]
    with open(a.bundle, "r", encoding="utf-8") as f:
        bundle = json.load(f)

    data = (build_well_bound(bundle, spec, a.n) if spec["bind"] == "well"
            else build_site_bound(bundle, spec))

    units = {"oil_m3d": "m³/d", "npv_wan": "万元", "site_oil_m3d": "m³/d",
             "site_npv_wan": "万元", "level_pct": "%", "capacity_m3": "m³"}
    if spec["prefix"] == "PM":
        units.update({"stroke_rate": "1/min", "stroke_m": "m"})
    if spec["prefix"] == "XT":
        units["wellhead_pressure_mpa"] = "MPa"

    side = {
        "asset": a.asset,
        "spec": spec["spec"],
        "data": data,
        "units": units,
        "scale": {
            "unit": "m",
            "up_axis": "Y",
            "source_up_axis": "Z",
            "bbox_m": spec["bbox"],
            "origin": "底面贴地、水平居中",
        },
        "meta": {
            "disclaimer": DISCLAIMER,
            "data_mode": "历史回放（bundle 最新一期），非实时",
            "bundle": os.path.basename(a.bundle),
            "device_count": len(data),
            "bind": spec["bind"],
        },
        "updated_at": datetime.now(CST).replace(microsecond=0).isoformat(),
    }

    os.makedirs(a.out, exist_ok=True)
    path = os.path.join(a.out, f"{a.asset}.twin.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(side, f, ensure_ascii=False, indent=2)
    print(f"[sidecar] {a.asset}: {len(data)} 台 → {path}")


if __name__ == "__main__":
    main()
