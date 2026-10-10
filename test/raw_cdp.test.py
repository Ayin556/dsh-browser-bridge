#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""裸 CDP 通道（BuiltinSession）直测。

Playwright 驱动对 type=webview/iframe 的 target 会直接 detach（coreBundle.js
`_onAttachedToTarget`），所以真实 DSH 内置浏览器面板大概率走本文件的 BuiltinSession
通道。本测试用一个普通 Chrome（type=page，ws 端点等价）直接驱动 BuiltinSession，
验证 navigate/evaluate/dom/click/screenshot 全链路。

运行： DSH_BRIDGE_E2E=1 venv3/bin/python3 test/raw_cdp.test.py
会弹一个 Chrome 窗口，结束自动收尸。
"""
import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from browser_daemon import BuiltinSession  # noqa: E402

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT = 9334
HERE = Path(__file__).resolve().parent


def main():
    work = Path(tempfile.mkdtemp(prefix="dsh-bridge-raw-"))
    fixture = HERE / "fixture.html"
    proc = subprocess.Popen(
        [CHROME, "--remote-debugging-port=%d" % PORT, "--user-data-dir=%s" % (work / "p"),
         "--no-first-run", "--no-default-browser-check", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        targets = None
        for _ in range(60):
            try:
                with urllib.request.urlopen("http://127.0.0.1:%d/json/list" % PORT, timeout=2) as resp:
                    targets = json.loads(resp.read())
                if any(t.get("type") == "page" and t.get("webSocketDebuggerUrl") for t in targets):
                    break
            except Exception:
                pass
            time.sleep(0.3)
        assert targets, "CDP 端点未就绪"
        page_t = next(t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl"))
        session = BuiltinSession(page_t["webSocketDebuggerUrl"])
        assert session.alive(), "alive 探活失败"
        print("✓ 裸 CDP 连接 + 探活 →", page_t["url"][:60])

        nav = session.navigate({"url": fixture.as_uri()})
        assert "fixture.html" in nav["url"], nav
        assert session.title() == "bridge fixture"
        print("✓ navigate（raw）→", nav["url"])

        assert session.evaluate({"expression": "1 + 1"})["value"] == 2
        assert session.evaluate({"expression": "() => document.getElementById('out').textContent"})["value"] == "初始文本"
        print("✓ evaluate（表达式 + 函数体自动调用）")

        session.evaluate({"expression": "() => document.getElementById('who').value = 'raw'"})
        session.click({"selector": "#btn"})
        out = session.evaluate({"expression": "() => document.getElementById('out').textContent"})
        assert out["value"].startswith("已点击 raw"), out
        print("✓ click（Input 鼠标事件，联动输入框）")

        summary = session.dom({})
        assert summary["inputs"] and any(x["type"] == "password" and x["value"] is None for x in summary["inputs"]), summary
        html = session.dom({"selector": "#out"})
        assert "已点击" in html["html"], html
        print("✓ dom 摘要（密码框 value 隐去）+ dom(selector)")

        shot = session.screenshot({})
        assert Path(shot["path"]).stat().st_size > 1000
        print("✓ screenshot →", shot["path"], "(%dKB)" % (shot["bytes"] // 1024))

        nav2 = session.navigate({"url": "data:text/html,<title>raw-nap</title><h1>ok</h1>"})
        assert session.title() == "raw-nap", nav2
        print("✓ 导航后面板 target 不换 ws 端点，会话仍可用")
        print("\n裸 CDP 通道全部通过")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
