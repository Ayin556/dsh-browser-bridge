#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""managed 通道设备仿真的真实验证：起真守护进程（无头 Chrome），下发 iPhone 规格，
再回读页面侧的关键指标——判断"完美仿真"是否真的成立。

指标对应关系（Chrome DevTools 设备工具栏同款 CDP）：
  innerWidth/innerHeight  ← Emulation.setDeviceMetricsOverride(width/height, mobile)
  devicePixelRatio        ← deviceScaleFactor
  navigator.maxTouchPoints / (pointer: coarse) ← setTouchEmulationEnabled
  navigator.userAgent / userAgentData       ← setUserAgentOverride(+Metadata)
"""
import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
VENV = "/Users/ayin/person/person-python/windowsPC/pythonPC/venv3/bin/python3"
DAEMON = str(ROOT / "lib" / "browser_daemon.py")
FIXTURE = (HERE / "fixture.html").as_uri()
# 带 <meta name="viewport" content="width=device-width"> 的探针页：设备仿真的视口断言必须用它，
# 否则 Chromium（以及 Chrome DevTools）会按 980px 的默认 layout viewport 缩放显示。
FIXTURE_VP = (HERE / "emulation-fixture.html").as_uri()

proc = subprocess.Popen([VENV, DAEMON], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
next_id = 1


def read_msg(timeout):
    """读一条 NDJSON 消息（跳过空行；进程退出则报错）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                raise RuntimeError("守护进程已退出")
            continue
        line = line.strip()
        if line:
            return json.loads(line)
    raise TimeoutError("等待守护进程输出超时")


def wait_ready(timeout=90):
    deadline = time.time() + timeout
    while time.time() < deadline:
        msg = read_msg(deadline - time.time())
        if msg.get("type") == "ready":
            return
        if msg.get("type") == "log":
            print("   [daemon]", msg.get("message"))
    raise TimeoutError("守护进程 90s 内未就绪")


def call(op, params=None, timeout=180):
    global next_id
    rid = next_id
    next_id += 1
    proc.stdin.write(json.dumps({"id": rid, "op": op, "params": params or {}}) + "\n")
    proc.stdin.flush()
    deadline = time.time() + timeout
    while time.time() < deadline:
        msg = read_msg(deadline - time.time())
        if msg.get("type") == "log":
            print("   [daemon]", msg.get("message"))
            continue
        if msg.get("type") is not None:
            continue
        if msg.get("id") != rid:
            continue
        if not msg.get("ok"):
            raise RuntimeError(f"{op} 失败：{msg.get('error')}")
        return msg.get("result")
    raise TimeoutError(f"{op} 超时")


def close():
    try:
        proc.stdin.close()
    except Exception:
        pass
    try:
        proc.wait(timeout=20)
    except Exception:
        proc.kill()
    err = ""
    try:
        err = proc.stderr.read() or ""
    except Exception:
        pass
    if err.strip():
        print("\n[daemon stderr]\n" + err.strip()[-2000:])


probe_js = """() => ({
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  dpr: window.devicePixelRatio,
  screen: [screen.width, screen.height],
  ua: navigator.userAgent,
  uaDataMobile: navigator.userAgentData ? navigator.userAgentData.mobile : null,
  uaDataPlatform: navigator.userAgentData ? navigator.userAgentData.platform : null,
  maxTouchPoints: navigator.maxTouchPoints,
  coarse: matchMedia('(pointer: coarse)').matches,
  hoverNone: matchMedia('(hover: none)').matches
})"""

try:
    wait_ready()
    print("✓ 守护进程就绪")

    call("config", {
        "profileDir": "/tmp/emu-probe/profile",
        "shotsDir": "/tmp/emu-probe/shots",
        "viewportWidth": 1280, "viewportHeight": 800, "deviceScaleFactor": 1,
        "slowMoMs": 0, "headless": True, "controlPort": 9332, "defaultTarget": "managed",
    })
    call("navigate", {"url": FIXTURE, "wait_until": "load"})
    before = call("evaluate", {"expression": probe_js})["value"]
    print("\n【仿真前】")
    for k, v in before.items():
        print(f"   {k:<16} {v}")

    spec = {
        "preset": "iPhone 16 Pro Max", "orientation": "vertical",
        "width": 440, "height": 956, "dpr": 3, "mobile": True, "touch": True,
        "screenWidth": 440, "screenHeight": 956,
        "ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
        "uaMeta": {"platform": "iOS", "platformVersion": "18.5", "architecture": "", "model": "iPhone", "mobile": True},
    }
    res = call("emulate", {"target": "managed", "spec": spec})
    print("\n【下发】", json.dumps(res, ensure_ascii=False))

    # 基线对照：页面没有 <meta name="viewport"> 时，mobile 模式用 980px 默认 layout viewport
    # （Chromium 行为，Chrome DevTools 设备模式同样如此）——不是仿真失效。
    nometa = call("evaluate", {"expression": probe_js})["value"]
    print(f"\n【无 viewport meta 页面】innerWidth={nometa['innerWidth']}（mobile 默认 layout viewport，与 DevTools 一致）")

    call("navigate", {"url": FIXTURE_VP, "wait_until": "load"})
    after = call("evaluate", {"expression": probe_js})["value"]
    print("\n【仿真后（带 viewport meta 的页面）】")
    for k, v in after.items():
        print(f"   {k:<16} {v}")

    print("\n【判定】")
    checks = [
        ("viewport = 440×956", after["innerWidth"] == 440 and after["innerHeight"] == 956, (after["innerWidth"], after["innerHeight"])),
        ("devicePixelRatio = 3", float(after["dpr"]) == 3.0, after["dpr"]),
        ("screen = 440×956", after["screen"] == [440, 956], after["screen"]),
        ("UA 变 iPhone", "iPhone" in after["ua"], after["ua"][:60]),
        ("Client Hints platform=iOS", after["uaDataPlatform"] == "iOS", after["uaDataPlatform"]),
        ("Client Hints mobile=true", after["uaDataMobile"] is True, after["uaDataMobile"]),
        ("maxTouchPoints = 5", after["maxTouchPoints"] == 5, after["maxTouchPoints"]),
        ("(pointer: coarse) 命中", after["coarse"] is True, after["coarse"]),
        ("(hover: none) 命中", after["hoverNone"] is True, after["hoverNone"]),
        ("无 viewport meta 页 = 980（DevTools 同行为）", nometa["innerWidth"] == 980, nometa["innerWidth"]),
        ("跨导航保持仿真", after["uaDataPlatform"] == "iOS", after["uaDataPlatform"]),
    ]
    bad = 0
    for name, ok, got in checks:
        print(("   ✓ " if ok else "   ✗ ") + f"{name}（实测 {got}）")
        bad += 0 if ok else 1

    call("emulate", {"target": "managed", "reset": True})
    cleared = call("evaluate", {"expression": probe_js})["value"]
    ok_clear = cleared["innerWidth"] != 440 and "iPhone" not in cleared["ua"] and cleared["maxTouchPoints"] == 0
    print(("   ✓ " if ok_clear else "   ✗ ") + f"reset 生效（innerWidth={cleared['innerWidth']} ua是原生={'iPhone' not in cleared['ua']} maxTouchPoints={cleared['maxTouchPoints']}）")
    bad += 0 if ok_clear else 1

    print("\n" + ("全部通过：managed 仿真与 Chrome DevTools 等价" if bad == 0 else f"{bad} 项未达标"))
    sys.exit(1 if bad else 0)
finally:
    close()
