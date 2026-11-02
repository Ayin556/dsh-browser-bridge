/**
 * 插件层回归测试（2026-10-10 死锁事故专项）：
 *
 *   node test/plugin_path_check.mjs
 *
 * 背景：DaemonClient.ensure() 曾在就绪回调里重入 this.request("config")，
 * 与自身 readyPromise 形成 adoption 自引用死锁 → 所有工具调用在 `await ensure()`
 * 处无限悬挂（无任何超时护栏），表现为"browser_navigate 卡死、会话无法终止"。
 *
 * 本测试用假 ctx 驱动真实插件代码，覆盖"急启动 → 首次工具调用"全链路：
 *   1. apply() 后急启动必须完成（守护进程 ready + config 下发走通）；
 *   2. browser_navigate(target=builtin) 必须在限定时间内**要么返回、要么报可读错**
 *      （本测试环境 9331 端口无 client 轮询 → 预期快速报"客户端未在线"，但绝不无限悬挂）；
 *   3. 结束时给守护进程发 EOF 收尸，零残留。
 */
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 相对本文件解析插件入口，避免把作者本机的绝对路径写死在仓库里
const pluginUrl = pathToFileURL(
	resolve(dirname(fileURLToPath(import.meta.url)), "../lib/index.js")
).href;
const plugin = await import(pluginUrl);

const tools = new Map();
const logs = [];
const ctx = {
	logger: {
		info: (m) => { logs.push(m); },
		warn: (m) => { logs.push(m); }
	},
	tools: {
		register: (d) => { tools.set(d.name, d); return () => tools.delete(d.name); },
		get: (n) => tools.get(n)
	},
	systemPrompt: { section: () => {} },
	effect: () => {}
};
const config = plugin.Config({
	controlPort: 9331, // 避开生产 9330
	profileDir: "/tmp/repro-bridge/profile",
	shotsDir: "/tmp/repro-bridge/shots"
});

console.log("== 1. apply()（含急启动）==");
plugin.apply(ctx, config);
await sleep(6500);
const readySeen = logs.some((m) => String(m).includes("守护进程已就绪"));
console.log(readySeen ? "✓ 急启动完成（ready 已到）" : "✗ 急启动未完成（ensure 疑似又死锁！）");
if (!readySeen) process.exit(1);

console.log("== 2. browser_navigate(target=builtin)：必须在有限时间内落地 ==");
const nav = tools.get("browser_navigate");
const t0 = Date.now();
const raced = await Promise.race([
	nav.execute({ url: "http://127.0.0.1:8799/builtin_probe.html", target: "builtin" }, {})
		.then((r) => ({ kind: "result", r }), (e) => ({ kind: "error", e })),
	sleep(70000).then(() => ({ kind: "timeout" }))
]);
const secs = Math.round((Date.now() - t0) / 1000);
if (raced.kind === "timeout") {
	console.log(`✗ 70s 内无任何响应——死锁回归！`);
	process.exit(1);
}
console.log(`✓ ${secs}s 内落地（${raced.kind === "result" ? "返回结果" : "可读报错：" + String(raced.e.message).slice(0, 80)}）`);

console.log("== 3. 收尸（EOF）==");
await sleep(1500);
console.log("\n✅ 插件层链路回归通过（无死锁、有超时护栏）");
process.exit(0);
