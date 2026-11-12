# -*- coding: utf-8 -*-
"""等 pilot run 跑完 → 下产物 → 跑 v1/v2 两套 baseline + bundle → 出 v1_vs_v2.md。

只用标准库做等待/下载编排；建模部分调子进程（用带 pandas/sklearn 的 venv python）。

用法：
  <venv-python> tools/wait_and_build_v2.py --run 40479938455
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOK = (Path.home() / ".gse" / "gh_token.txt").read_text(encoding="utf-8").strip()
API = "https://api.github.com/repos/g1914y/gse-ndic-probe"
HDR = {"Authorization": f"Bearer {TOK}",
       "Accept": "application/vnd.github+json",
       "User-Agent": "gse-wait"}


def _get(url: str) -> dict:
    r = urllib.request.Request(url, headers=HDR)
    with urllib.request.urlopen(r, timeout=60) as resp:
        return json.loads(resp.read())


def wait_run(run_id: int, every: int = 60, max_min: int = 200) -> dict:
    t0 = time.time()
    while True:
        d = _get(f"{API}/actions/runs/{run_id}")
        st = d["status"]
        print(f"[wait] {run_id} status={st}", flush=True)
        if st == "completed":
            return d
        if (time.time() - t0) / 60 > max_min:
            print("[wait] 超时，退出", flush=True)
            return d
        time.sleep(every)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", type=int, required=True)
    ap.add_argument("--python", default=sys.executable)
    a = ap.parse_args()

    d = wait_run(a.run)
    print(f"[wait] conclusion={d.get('conclusion')}", flush=True)
    if d.get("conclusion") != "success":
        print("[!] 非 success，仍尝试下载")

    out = ROOT / "09_开源数据平替" / "reports" / f"cogis_pilot_run_{a.run}"
    subprocess.run([a.python, str(ROOT / "tools" / "gh_run.py"),
                    "--only-download", str(a.run),
                    "--out", str(out)], check=False)

    pilot = out / "pilot"
    ev1 = pilot / "pilot_events.csv"
    ev2 = pilot / "pilot_events_v2.csv"
    ser = pilot / "pilot_series.csv"
    meta = pilot / "pilot_meta.json"
    for p in (ev1, ev2, ser, meta):
        if not p.exists():
            print(f"❌ 缺 {p}", file=sys.stderr)
            return 2

    print(f"\n=== pilot_meta.json v1/v2 ===", flush=True)
    m = json.loads(meta.read_text(encoding="utf-8"))
    print(json.dumps({"v1": m.get("v1", {}), "v2": m.get("v2", {})},
                     ensure_ascii=False, indent=1)[:2000], flush=True)

    results = {}
    for variant, ev in (("v1", ev1), ("v2", ev2)):
        bdir = out / f"baseline_{variant}"
        print(f"\n=== baseline {variant} ===", flush=True)
        r = subprocess.run([a.python, "-m", "scripts.run_pilot_baseline",
                            "--events", str(ev), "--series", str(ser),
                            "--out", str(bdir)],
                           cwd=str(ROOT / "09_开源数据平替"), check=False)
        results[f"baseline_{variant}"] = r.returncode
        if r.returncode != 0:
            continue
        print(f"\n=== bundle {variant} ===", flush=True)
        r = subprocess.run([a.python, "-m", "scripts.build_pilot_bundle",
                            "--events", str(ev), "--series", str(ser),
                            "--baseline", str(bdir), "--meta", str(meta),
                            "--protocol", "B", "--variant", variant,
                            "--out", str(out / f"pilot_bundle{'_v2' if variant == 'v2' else ''}.json")],
                           cwd=str(ROOT / "09_开源数据平替"), check=False)
        results[f"bundle_{variant}"] = r.returncode

    print("\n=== compare ===", flush=True)
    subprocess.run([a.python, "-m", "scripts.compare_v1_v2",
                    "--meta", str(meta),
                    "--events", str(ev1), "--events-v2", str(ev2),
                    "--bundle", str(out / "pilot_bundle.json"),
                    "--bundle-v2", str(out / "pilot_bundle_v2.json"),
                    "--out", str(ROOT / "09_开源数据平替" / "reports" / "v1_vs_v2.md")],
                   cwd=str(ROOT / "09_开源数据平替"), check=False)

    print("\n=== 结果 ===", flush=True)
    print(json.dumps(results, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
