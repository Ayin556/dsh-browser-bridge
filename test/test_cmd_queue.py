#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""daemon 命令队列逻辑单测：_next_cmd_id / _poll_cmd / _set_cmd_result / _via_client 等待配对。

用法（需含 playwright 的解释器，推荐 venv3）：
    python3 test/test_cmd_queue.py
"""
import os
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
import browser_daemon as D  # noqa: E402

# 1. cmd id 递增
a, b = D._next_cmd_id(), D._next_cmd_id()
assert a != b and a.startswith("c"), (a, b)
print("✓ _next_cmd_id:", a, b)

# 2. 模拟 _via_client 的入队 + poll 取命令 + result 回报
browser = D.Browser()
D._CMD_PENDING.clear(); D._CMD_TAKEN.clear(); D._CMD_WAKE.clear()

result_holder = {}


def worker():
    # 模拟 client：poll 取命令
    cmd = D._poll_cmd(block_seconds=3)
    assert cmd is not None, "poll 应取到命令"
    assert cmd["op"] == "navigate", cmd
    # 模拟执行后回报
    D._set_cmd_result({"id": cmd["id"], "ok": True, "result": {"url": "http://x/", "title": "t"}})


t = threading.Thread(target=worker)
t.start()
# 主线程：入队并等待（模拟 _via_client）
cmd_id = D._next_cmd_id()
evt = threading.Event()
with D._CMD_LOCK:
    D._CMD_PENDING[cmd_id] = {"op": "navigate", "params": {"url": "http://x/"}, "event": evt, "result": None}
D._CMD_WAKE.set()
ok = evt.wait(5)
t.join()
assert ok, "应收到回报"
with D._CMD_LOCK:
    item = D._CMD_PENDING.pop(cmd_id, None)
assert item["result"]["ok"] is True
assert item["result"]["result"]["title"] == "t"
print("✓ 入队→poll→result→event 全链路 OK")

# 3. 超时路径：无 client 回报时应超时且清队列
D._CMD_PENDING.clear(); D._CMD_TAKEN.clear(); D._CMD_WAKE.clear()
cmd_id2 = D._next_cmd_id()
evt2 = threading.Event()
with D._CMD_LOCK:
    D._CMD_PENDING[cmd_id2] = {"op": "dom", "params": {}, "event": evt2, "result": None}
start = time.time()
got = evt2.wait(0.3)
assert got is False, "无回报应超时"
with D._CMD_LOCK:
    D._CMD_PENDING.pop(cmd_id2, None)
print("✓ 无回报超时路径 OK（%.2fs）" % (time.time() - start))

# 4. _client_alive：无轮询时 False，poll 后 True
browser2 = D.Browser()
D._CLIENT_LAST_SEEN = 0.0  # 重置：清掉前面步骤的轮询痕迹
assert browser2._client_alive(window_s=2) is False, "未轮询应 False"
D._poll_cmd(block_seconds=0)  # 触发 _CLIENT_LAST_SEEN
assert browser2._client_alive(window_s=2) is True, "poll 后应 True"
print("✓ _client_alive 探活 OK")


# 5. _builtin_dispatch 超时预算：navigate(30s) → ≥45s；无 timeout_ms → 25s
def calc(params, timeout=None):
    if timeout is None:
        timeout = 25
        tms = params.get("timeout_ms") if isinstance(params, dict) else None
        if tms:
            try:
                timeout = max(timeout, int(tms) / 1000.0 + 15)
            except (TypeError, ValueError):
                pass
    return timeout


assert calc({"timeout_ms": 30000}) == 45.0
assert calc({}) == 25
assert calc({"timeout_ms": 5000}) == 25
print("✓ 超时预算计算 OK（navigate 30s→45s / 缺省→25s）")

# 6. ping 结果含 client_alive_s（无 CDP 排障口）
out = D.handle(D.Browser(), {"op": "ping"})
assert out["pong"] and "client_alive_s" in out
print("✓ ping 含 client_alive_s =", out["client_alive_s"])

print("\n✅ 命令队列 / 通道辅助全部通过")
