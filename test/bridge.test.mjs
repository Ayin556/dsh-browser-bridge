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
	// 2026-10-13：默认目标改为内置浏览器面板（此前 managed 会让模型不传 target 时弹外置 Chrome）
	assert.equal(config.defaultTarget, "builtin", "defaultTarget 默认应是 builtin");
	console.log("✓ Config 默认值（viewport 390x844 / 有头 / slowMo 250ms / venv3 python / 默认目标 builtin）");

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
	assert.ok(announceText.includes("内置浏览器面板"), "公告应说明默认走 DSH 内置浏览器面板");
	assert.ok(announceText.includes("target=managed"), "公告应说明 managed 是显式可选项");
	assert.ok(announceText.includes("不要用 bash 打开外部浏览器"), "公告应含「禁止外部浏览器」硬规则");
	assert.ok(announceText.includes("fe-local-autologin"), "公告应包含登录红线提示");
	assert.equal(h.effects.length, 1, "应注册一个清理 effect");
	console.log("✓ apply() 注册 7 工具 + announce 段落 + 清理 effect");

	// 2b. 每个带 target 的工具：schema 描述必须与真实默认一致（模型靠它决定开不开外置窗口）
	const targetDesc = (tool) => tool.parameters.properties.target.description;
	for (const name of ["browser_navigate", "browser_evaluate", "browser_screenshot", "browser_dom", "browser_click", "browser_emulate"]) {
		const desc = targetDesc(h.tools.get(name));
		assert.ok(desc.includes("省略即 builtin"), `${name}.target 描述应声明默认 builtin，实际：${desc.slice(0, 60)}`);
	}
	const withManagedDefault = { ...config, defaultTarget: "managed" };
	const h2 = makeHarness();
	plugin.apply(h2.ctx, withManagedDefault);
	assert.ok(
		targetDesc(h2.tools.get("browser_navigate")).includes("省略即 managed"),
		"defaultTarget=managed 时描述应跟着变（描述随配置动态生成）"
	);
	assert.ok(h2.sections[0].text({ scope: void 0 }).includes("显式传 target=builtin"), "managed 默认时公告应指引 builtin");
	console.log("✓ target 参数描述随 defaultTarget 动态生成（builtin / managed 两态均正确）");

	// 3. render 形状
	for (const tool of h.tools.values()) {
		const rendered = tool.output.render({}, { text: "x" });
		assert.deepEqual(rendered, [{ type: "text", text: "x" }], `${tool.name}.render 形状`);
		assert.equal(tool.isConcurrencySafe(), false, `${tool.name} 不应并发`);
	}
	console.log("✓ render 形状 / isConcurrencySafe=false");

	// 4. 机型库（对齐 Chrome DevTools 的 EmulatedDevices 列表）
	const devices = await import("../lib/devices.js");
	assert.equal(devices.DEVICES.length, 46, "机型库应为 DevTools 的 46 款");
	const max = devices.matchDevice("iPhone 16 Pro Max");
	assert.ok(max, "应能按全名匹配 iPhone 16 Pro Max");
	assert.deepEqual([max.vertical.width, max.vertical.height, max.dpr], [440, 956, 3], "iPhone 16 Pro Max 尺寸/dpr 应与 DevTools 一致");
	assert.equal(max.capabilities.includes("touch") && max.capabilities.includes("mobile"), true, "手机必须具备 touch+mobile 能力");
	assert.ok(max.ua.startsWith("Mozilla/5.0 (iPhone"), "应带 DevTools 的真实 iPhone UA");
	assert.equal(max.uaMeta.platform, "iOS", "应带 Client Hints 元数据");
	assert.equal(devices.matchDevice("iphone16pro").title, "iPhone 16 Pro", "简写（去空格/小写）应命中");
	assert.equal(devices.matchDevice("zfold6").title, "Galaxy Z Fold 6", "连字符不敏感应命中");
	assert.equal(devices.matchDevice("Pixel 9").title, "Pixel 9", "全名应精确命中（而非前缀命中 Pixel 9 Pro）");
	assert.equal(devices.matchDevice("根本不存在"), undefined, "未知名应返回 undefined");
	const lap = devices.buildSpec({ device: "Laptop with HiDPI screen" });
	assert.equal(lap.spec.mobile, false, "笔记本不应是 mobile");
	assert.equal(lap.spec.dpr, 2);
	const custom = devices.buildSpec({ overrides: { width: 1920, height: 1080, dpr: 1 } });
	assert.equal(custom.spec.preset, "custom");
	assert.equal(custom.spec.mobile, false);
	const land = devices.buildSpec({ device: "iPhone 16", orientation: "horizontal" });
	assert.deepEqual([land.spec.width, land.spec.height], [852, 393], "横屏应交换宽高（取 DevTools 的 horizontal 框）");
	assert.ok(devices.buildSpec({ device: "无此机型" }).error, "未知机型应给可读错误");
	console.log("✓ 机型库：46 款 / 尺寸·dpr·UA·Client Hints 与 DevTools 一致 / 模糊匹配 / 横竖屏 / 自定义视口");

	// 5. browser_emulate：list 不打后端即可回答；错误参数给出指引
	const listOut = await h.tools.get("browser_emulate").execute({ list: true }, {});
	assert.ok(listOut.text.includes("iPhone 16 Pro Max"), "list 应含机型名");
	assert.ok(listOut.text.includes("46 款"), "list 应说明机型总数");
	assert.ok(listOut.text.includes("Chrome DevTools"), "list 应说明数据源口径");
	const badOut = await h.tools.get("browser_emulate").execute({ device: "无此机型" }, {});
	assert.ok(badOut.text.includes("仿真参数有误"), "未知机型应提示参数有误");
	assert.ok(badOut.text.includes("iPhone SE") || badOut.text.includes("可用机型"), "未知机型应附机型清单");
	assert.ok(h.tools.get("browser_emulate").parameters.properties.device, "emulate 应暴露 device 参数");
	assert.ok(h.tools.get("browser_emulate").parameters.properties.list, "emulate 应暴露 list 参数");
	console.log("✓ browser_emulate(list=true) 与未知机型指引（均不触达后端）");

	// 6. 非 Electron 宿主必须给出可读的降级原因（Electron CDP 是内置面板的完美仿真通道）
	const emu = await import("../lib/electron-emulation.js");
	const cap = emu.probe();
	assert.equal(cap.ok, false, "单测环境非 Electron，不应声称具备原生 CDP");
	assert.ok(typeof cap.reason === "string" && cap.reason.length > 0, "降级必须带可读原因");
	const diag = emu.diagnose(1234);
	assert.equal(diag.ok, false, "非 Electron 下 diagnose 应返回 ok:false");
	assert.ok(diag.verdict.includes("无原生 CDP"), "diagnose 必须给可读判定（而非抛错）");
	assert.ok(h.tools.get("browser_emulate").parameters.properties.diagnose, "emulate 应暴露 diagnose 参数");
	assert.ok(h.tools.get("browser_emulate").parameters.properties.orientation, "emulate 应暴露 orientation 参数");
	assert.ok(h.tools.get("browser_emulate").parameters.properties.dpr, "emulate 应暴露 dpr 参数");
	console.log("✓ Electron CDP 能力探测 + diagnose：非 Electron 宿主均给可读判定（不抛错）");

	// 8. UI 接线契约：面板机型下拉横跨三文件（client.cjs ↔ browser_daemon.py ↔ index.js），
	//    任一处的关键件被删/改名都会让 UI 静默失效，故做静态断言守住契约。
	const { readFileSync } = await import("node:fs");
	const { dirname, join } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
	const clientSrc = readFileSync(join(ROOT, "lib/client.cjs"), "utf8");
	const daemonSrc = readFileSync(join(ROOT, "lib/browser_daemon.py"), "utf8");
	const pluginSrc = readFileSync(join(ROOT, "lib/index.js"), "utf8");
	const contracts = [
		["lib/client.cjs", clientSrc, ["/devices", "/ui/emulate", "dsh-bridge-device", "applyDeviceChoice", "isNative", "specFromRow", "dshBridgeBadge", "desiredUa"]],
		["lib/browser_daemon.py", daemonSrc, ['"/devices"', '"/ui/emulate"', "def _ui_emulate", "_UI_BROWSER", "DSH_BRIDGE_CONTROL_PORT"]],
		["lib/index.js", pluginSrc, ["devices: DEVICES"]]
	];
	for (const [file, src, needles] of contracts) {
		for (const needle of needles) assert.ok(src.includes(needle), `${file} 应含 ${needle}（UI 接线契约）`);
	}
	// 回归护栏：resetChrome 曾把工具栏整个拆掉 → 用户切到"原生"后再也切不回机型（2026-10-14 修）
	assert.ok(!clientSrc.includes("__dshToggle.remove()"), "resetChrome 不应再移除工具栏（否则机型下拉会消失）");
	console.log("✓ UI 接线契约：机型下拉横跨 client.cjs / browser_daemon.py / index.js 三处关键件齐全");
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
		// 本段测的是 managed（路线 B）链路，故显式把默认目标设为 managed——
		// 插件生产默认已是 builtin（走 client.cjs 命令通道，e2e 环境没有该客户端）。
		await request("config", { profileDir: config.profileDir, shotsDir: config.shotsDir, viewportWidth: 390, viewportHeight: 844, deviceScaleFactor: 2, slowMoMs: 0, headless: false, defaultTarget: "managed" });

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
