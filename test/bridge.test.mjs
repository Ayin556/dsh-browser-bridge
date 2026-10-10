/**
 * dsh-browser-bridge 的测试：
 *
 *   默认（unit）  node test/bridge.test.mjs
 *     1. Config 默认值解析
 *     2. apply() 用假 ctx 注册恰好 7 个工具（5 操作 + browser_attach + browser_emulate）+ 公告段落 + effect
 *     3. 工具输出 render 形状
 *
 *   端到端（e2e） DSH_BRIDGE_E2E=1 node test/bridge.test.mjs
 *     直接驱动真守护进程 + 有头 Chrome（slowMo=0 提速）：
 *     路线 B：navigate(file://fixture) → dom 摘要 → evaluate → click → dom(selector) → screenshot
 *     路线 C：再起一个带 --remote-debugging-port 的 Chrome → attach → target=builtin 全链路
 *     全程会弹出两个 Chrome 窗口，属预期。
 */
import { mkdtempSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

// 单测隔离：不让 apply() 急启动真守护进程（否则进程不退出；e2e 段自己起）
process.env.DSH_BRIDGE_TEST_NO_START = "1";
const plugin = await import("../lib/index.js");
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = new URL("fixture.html", import.meta.url).href;

function makeHarness() {
	const tools = new Map();
	const sections = [];
	const effects = [];
	const logs = { info: [], warn: [] };
	const ctx = {
		logger: {
			info: (m) => logs.info.push(m),
			warn: (m) => logs.warn.push(m)
		},
		tools: {
			register: (d) => {
				tools.set(d.name, d);
				return () => tools.delete(d.name);
			},
			get: (n) => tools.get(n)
		},
		systemPrompt: { section: (s) => sections.push(s) },
		effect: (gen, label) => effects.push({ gen, label })
	};
	return { ctx, tools, sections, effects, logs };
}

//#region unit
{
	// 1. Config 默认值
	const config = typeof plugin.Config === "function" ? plugin.Config({}) : plugin.Config;
	assert.equal(plugin.name, "dsh-browser-bridge");
	assert.deepEqual(plugin.inject, ["tools", "systemPrompt"]);
	assert.equal(config.pythonBin.endsWith("/bin/python3"), true, "pythonBin 默认应是 venv3 python3");
	assert.equal(config.viewportWidth, 390);
	assert.equal(config.viewportHeight, 844);
	assert.equal(config.headless, false);
	assert.equal(config.slowMoMs, 250);
	console.log("✓ Config 默认值（viewport 390x844 / 有头 / slowMo 250ms / venv3 python）");

	// 2. apply 注册
	const h = makeHarness();
	plugin.apply(h.ctx, config);
	assert.deepEqual([...h.tools.keys()].sort(), [
		"browser_attach",
		"browser_click",
		"browser_dom",
		"browser_emulate",
		"browser_evaluate",
		"browser_navigate",
		"browser_screenshot"
	]);
	assert.equal(h.sections.length, 1, "应注册一个公告段落");
	const announceText = h.sections[0].text({ scope: void 0 });
	assert.ok(announceText.includes("browser_navigate"), "公告应包含 browser_navigate");
	assert.ok(announceText.includes("browser_attach"), "公告应包含 browser_attach");
	assert.ok(announceText.includes("browser_emulate"), "公告应包含 browser_emulate");
	assert.ok(announceText.includes("target=builtin"), "公告应说明 builtin 路由");
	assert.ok(announceText.includes("fe-local-autologin"), "公告应包含登录红线提示");
	assert.equal(h.effects.length, 1, "应注册一个清理 effect");
	console.log("✓ apply() 注册 7 工具 + announce 段落 + 清理 effect");

	// 3. render 形状
	for (const tool of h.tools.values()) {
		const rendered = tool.output.render({}, { text: "x" });
		assert.deepEqual(rendered, [{ type: "text", text: "x" }], `${tool.name}.render 形状`);
		assert.equal(tool.isConcurrencySafe(), false, `${tool.name} 不应并发`);
	}
	console.log("✓ render 形状 / isConcurrencySafe=false");
}
//#endregion

//#region e2e（DSH_BRIDGE_E2E=1 才跑）
if (process.env.DSH_BRIDGE_E2E === "1") {
	console.log("\n== e2e：真守护进程 + 有头 Chrome（slowMo=0）==");
	const work = mkdtempSync(join(tmpdir(), "dsh-browser-bridge-e2e-"));
	const base = typeof plugin.Config === "function" ? plugin.Config({}) : plugin.Config;
	const config = {
		...base,
		profileDir: join(work, "profile"),
		shotsDir: join(work, "shots"),
		slowMoMs: 0,
		startupTimeoutMs: 60000
	};
	const { DaemonClient } = await import("../lib/daemon-client.mjs").catch(() => ({ DaemonClient: void 0 }));
	// DaemonClient 未单独导出时，从闭包里拿不到——退而求其次：直接用 python 子进程协议层测。
	if (DaemonClient === void 0) {
		const { spawn } = await import("node:child_process");
		const pythonBin = config.pythonBin;
		const daemon = resolve(dirname(fileURLToPath(import.meta.url)), "../lib/browser_daemon.py");
		const proc = spawn(pythonBin, [daemon], { stdio: ["pipe", "pipe", "pipe"] });
		proc.stdout.setEncoding("utf8");
		let buffer = "";
		const pending = new Map();
		let nextId = 1;
		let readyResolve;
		const ready = new Promise((r) => { readyResolve = r; });
		const request = (op, params) => new Promise((res, rej) => {
			const id = nextId++;
			pending.set(id, { res, rej });
			proc.stdin.write(JSON.stringify({ id, op, params }) + "\n");
		});
		proc.stdout.on("data", (chunk) => {
			buffer += chunk;
			let i;
			while ((i = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, i).trim();
				buffer = buffer.slice(i + 1);
				if (!line) continue;
				let msg;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				if (msg.type === "ready") { readyResolve(); continue; }
				if (msg.type === "log") { console.log("  [daemon]", msg.message); continue; }
				if (pending.has(msg.id)) {
					const p = pending.get(msg.id);
					pending.delete(msg.id);
					if (msg.ok) p.res(msg.result);
					else p.rej(new Error(msg.error));
				}
			}
		});
		proc.stderr.setEncoding("utf8");
		proc.stderr.on("data", (chunk) => process.stderr.write(`  [daemon:stderr] ${chunk}`));
		await ready;
		await request("config", { profileDir: config.profileDir, shotsDir: config.shotsDir, viewportWidth: 390, viewportHeight: 844, deviceScaleFactor: 2, slowMoMs: 0, headless: false });

		const nav = await request("navigate", { url: FIXTURE, wait_until: "load" });
		assert.equal(nav.title, "bridge fixture");
		assert.ok(nav.url.endsWith("fixture.html"));
		console.log("✓ navigate →", nav.url, `（HTTP ${nav.status ?? "file://"}）`);

		const summary = await request("dom", {});
		assert.ok(summary.inputs.length >= 2, "摘要应列出输入框");
		assert.ok(summary.inputs.some((x) => x.type === "password" && x.value === null), "密码框 value 不应回传");
		assert.ok(summary.text.includes("初始文本"));
		console.log(`✓ dom 摘要（${summary.inputs.length} 个输入框，密码框 value 已隐去）`);

		assert.equal((await request("evaluate", { expression: "1 + 1" })).value, 2);
		assert.equal((await request("evaluate", { expression: "() => document.getElementById('out').textContent" })).value, "初始文本");
		console.log("✓ evaluate（表达式 + 函数体）");

		await request("evaluate", { expression: "() => document.getElementById('who').value = '游客'" });
		const clicked = await request("click", { selector: "#btn" });
		assert.equal(clicked.clicked, "#btn");
		assert.equal((await request("evaluate", { expression: "() => document.getElementById('out').textContent" })).value, "已点击 游客");
		console.log("✓ click（按钮生效，读到了输入框的值）");

		const html = await request("dom", { selector: "#out" });
		assert.ok(html.html.includes("已点击"));
		console.log("✓ dom(selector) →", html.html);

		const shot = await request("screenshot", {});
		assert.ok(existsSync(shot.path) && statSync(shot.path).size > 1000, "截图文件应存在且非空");
		console.log("✓ screenshot →", shot.path, `（${Math.round(shot.bytes / 1024)}KB）`);

		const pong = await request("ping", {});
		assert.equal(pong.pong, true);
		console.log("✓ 路线 B 全链路 + ping 通过");

		//#region 路线 C：本地 Chrome 带 CDP 端口，attach → target=builtin 全链路
		console.log("\n== e2e：路线 C（CDP attach 到本地 Chrome 模拟\"内置面板\"）==");
		const chromeBin = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
		const cdpPort = 9333;
		const cdpProfile = join(work, "cdp-profile");
		const chromeProc = spawn(chromeBin, [
			`--remote-debugging-port=${cdpPort}`,
			`--user-data-dir=${cdpProfile}`,
			"--no-first-run",
			"--no-default-browser-check",
			FIXTURE
		], { stdio: "ignore" });
		// 等 CDP 端点就绪
		const { default: http } = await import("node:http");
		async function cdpReady(tries) {
			for (let i = 0; i < (tries ?? 50); i++) {
				try {
					await new Promise((res, rej) => {
						const req = http.get(`http://127.0.0.1:${cdpPort}/json/version`, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(new Error(String(r.statusCode))); });
						req.on("error", rej);
						req.setTimeout(1000, () => { req.destroy(); rej(new Error("timeout")); });
					});
					return;
				} catch {
					await new Promise((r) => setTimeout(r, 300));
				}
			}
			throw new Error("CDP 端点 15s 内未就绪");
		}
		await cdpReady();
		const targets0 = await request("targets", { cdp_port: cdpPort });
		assert.ok(targets0.targets.length >= 1, "targets 应至少有 about:blank");
		console.log(`✓ targets：${targets0.targets.length} 个（webview ${targets0.webview_count} 个）`);

		const attach = await request("attach", { cdp_port: cdpPort });
		assert.equal(attach.attached, true, `attach 应成功：${JSON.stringify(attach).slice(0, 300)}`);
		console.log("✓ attach →", attach.selected.url);

		// 未 attach 前直接调 builtin 应报可读错误（此时已 attach，改为测错误路由：先 detach）
		await request("detach", {});
		await assert.rejects(
			() => request("navigate", { url: FIXTURE, target: "builtin" }),
			/browser_attach|重新 attach|尚未 attach/
		);
		console.log("✓ detach 后 target=builtin → 明确报错提示先 attach");
		await request("attach", { cdp_port: cdpPort });

		const navB = await request("navigate", { url: FIXTURE, target: "builtin" });
		assert.ok(navB.url.endsWith("fixture.html"), "builtin 导航应作用于被 attach 的 Chrome");
		assert.equal(navB.title, "bridge fixture");
		const evalB = await request("evaluate", { expression: "() => document.title", target: "builtin" });
		assert.equal(evalB.value, "bridge fixture");
		await request("click", { selector: "#btn", target: "builtin" });
		assert.equal(
			(await request("evaluate", { expression: "() => document.getElementById('out').textContent", target: "builtin" })).value.startsWith("已点击"),
			true
		);
		const shotB = await request("screenshot", { target: "builtin" });
		assert.ok(existsSync(shotB.path) && statSync(shotB.path).size > 1000);
		console.log("✓ target=builtin：navigate/evaluate/click/screenshot 全部作用于被 attach 的浏览器");

		await request("detach", {});
		try {
			chromeProc.kill();
		} catch { /* 已退则忽略 */ }
		await new Promise((r) => {
			chromeProc.once("exit", r);
			setTimeout(r, 8000).unref?.();
		});
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				rmSync(cdpProfile, { recursive: true, force: true });
				break;
			} catch {
				await new Promise((r) => setTimeout(r, 800));
			}
		}
		console.log("✓ detach / 模拟浏览器收尸，路线 C 通过");
		//#endregion

		proc.kill();
		await new Promise((r) => setTimeout(r, 1000));
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				rmSync(work, { recursive: true, force: true });
				break;
			} catch {
				await new Promise((r) => setTimeout(r, 800));
			}
		}
		console.log("\n✓ 收尸退出，e2e 全部通过");
	} else {
		throw new Error("daemon-client.mjs 不应存在（本版未拆分导出）");
	}
} else {
	console.log("\n（未设 DSH_BRIDGE_E2E=1，跳过真浏览器 e2e）");
}
console.log("\n全部通过");
