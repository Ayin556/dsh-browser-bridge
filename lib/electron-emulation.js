/**
 * 内置浏览器面板的设备仿真 —— 走 Electron **主进程**的原生 CDP。
 *
 * ## 为什么必须绕这一道
 *
 * 要和 **Chrome DevTools 设备工具栏完全一致**，只有 CDP 的三个域能给：
 *
 *   Emulation.setDeviceMetricsOverride   viewport 尺寸 / mobile / dpr / screen / 朝向
 *   Emulation.setUserAgentOverride       UA + Client Hints（userAgentMetadata）
 *   Emulation.setTouchEmulationEnabled   navigator.maxTouchPoints、ontouchstart、
 *                                        @media (pointer: coarse)/(hover: none)
 *
 * 渲染进程里的 `<webview>` 只暴露 setUserAgent / setZoomFactor / executeJavaScript ——
 * **没有 Emulation 域**，所以纯 CSS 锁宽 + 改 UA 那套永远做不出
 * `(pointer: coarse)` / 真实 touch / `navigator.userAgentData`，也就谈不上"完美"。
 *
 * DSH 桌面端的 cordis host 就跑在 Electron 主进程里（asar 内 `require("electron")`
 * 命中 12 处、无 utilityProcess），于是插件可以直接：
 *
 *   webContents.fromId(id).debugger.attach("1.3") → sendCommand("Emulation.*")
 *
 * **零启动参数** —— 区别于 `browser_attach` 那条需要 `--remote-debugging-port=9222`
 * 的降级通道（v5 起日常不再需要它）。
 *
 * ## 能力探测
 *
 * 非 Electron 宿主（CLI 起的 web profile、单测环境）返回 `{ok:false, reason}`，
 * 调用方据此回落 client.cjs 的 CSS/JS 近似实现，并在结果里如实标注"降级"。
 */
import { createRequire } from "node:module";

const requireFromHere = createRequire(import.meta.url);

/** webContentsId → { debugger, wc }（复用已 attach 的会话，避免重复 attach 报错）。 */
const ATTACHED = new Map();

/**
 * 探测当前进程能否走原生 CDP。
 * @returns {{ok: boolean, reason?: string, electron?: object, version?: string}}
 */
export function probe() {
	if (process.versions.electron === undefined) {
		return { ok: false, reason: `非 Electron 宿主（process.versions.electron 缺失，当前 Node ${process.versions.node}）` };
	}
	let electron;
	try {
		electron = requireFromHere("electron");
	} catch (error) {
		return { ok: false, reason: `require("electron") 失败：${error instanceof Error ? error.message : String(error)}` };
	}
	if (electron?.webContents?.fromId === undefined) {
		return { ok: false, reason: "electron.webContents.fromId 不可用" };
	}
	return { ok: true, electron, version: process.versions.electron };
}

function debuggerFor(electron, webContentsId) {
	const cached = ATTACHED.get(webContentsId);
	if (cached !== void 0 && cached.debugger.isAttached()) return cached;
	const wc = electron.webContents.fromId(webContentsId);
	if (wc === void 0 || wc === null) {
		throw new Error(`找不到 webContents ${webContentsId}（面板可能已关闭，或 webview 被重建）`);
	}
	const dbg = wc.debugger;
	if (!dbg.isAttached()) {
		try {
			dbg.attach("1.3");
		} catch (error) {
			throw new Error(`attach 调试器失败：${error instanceof Error ? error.message : String(error)}（若该 webview 正开着 DevTools，需先关掉）`);
		}
	}
	const entry = { debugger: dbg, wc };
	ATTACHED.set(webContentsId, entry);
	return entry;
}

/** CDP 的 UserAgentMetadata 必填项；brands 缺失时 Chromium 会自行填充，失败则退回只给 UA。 */
function uaMetadata(spec) {
	const meta = spec.uaMeta;
	if (meta === null || meta === void 0) return void 0;
	return {
		platform: meta.platform ?? "",
		platformVersion: meta.platformVersion ?? "",
		architecture: meta.architecture ?? "",
		model: meta.model ?? "",
		mobile: meta.mobile === true
	};
}

/**
 * 下发一套设备仿真（DevTools 设备工具栏用的是同一组 CDP 调用）。
 * @param {object} electron probe() 返回的 electron 模块
 * @param {number} webContentsId 面板 webview 的 webContents id（由 client.cjs 上报）
 * @param {object} spec devices.js 的 buildSpec() 产物
 */
export async function applySpec(electron, webContentsId, spec) {
	const { debugger: dbg } = debuggerFor(electron, webContentsId);
	await dbg.sendCommand("Emulation.setDeviceMetricsOverride", {
		width: spec.width,
		height: spec.height,
		deviceScaleFactor: spec.dpr ?? 1,
		mobile: spec.mobile === true,
		screenWidth: spec.screenWidth ?? spec.width,
		screenHeight: spec.screenHeight ?? spec.height,
		positionX: 0,
		positionY: 0,
		scale: 1,
		screenOrientation: {
			type: spec.orientation === "horizontal" ? "landscapePrimary" : "portraitPrimary",
			angle: spec.orientation === "horizontal" ? 90 : 0
		}
	});
	await dbg.sendCommand("Emulation.setTouchEmulationEnabled", {
		enabled: spec.touch === true,
		maxTouchPoints: spec.touch === true ? 5 : 1,
		configuration: spec.touch === true ? "mobile" : "desktop"
	});
	if (typeof spec.ua === "string" && spec.ua !== "") {
		try {
			await dbg.sendCommand("Emulation.setUserAgentOverride", { userAgent: spec.ua, userAgentMetadata: uaMetadata(spec) });
		} catch {
			await dbg.sendCommand("Emulation.setUserAgentOverride", { userAgent: spec.ua });
		}
	}
	return { via: "electron-cdp", webContentsId };
}

/** 清除仿真，恢复面板原生视口/UA/指针形态。 */
export async function clearSpec(electron, webContentsId) {
	const { debugger: dbg } = debuggerFor(electron, webContentsId);
	await dbg.sendCommand("Emulation.clearDeviceMetricsOverride");
	await dbg.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: false, maxTouchPoints: 1 });
	await dbg.sendCommand("Emulation.setUserAgentOverride", { userAgent: "" });
	return { via: "electron-cdp", webContentsId, cleared: true };
}

/** 插件卸载时断开所有调试器（不关面板，只断连接）。 */
export function disposeAll() {
	for (const [id, entry] of ATTACHED) {
		try {
			if (entry.debugger.isAttached()) entry.debugger.detach();
		} catch {
			/* 已断则忽略 */
		}
		ATTACHED.delete(id);
	}
}

/** 供排障：列出已 attach 的 webContents id。 */
export function attachedIds() {
	return [...ATTACHED.keys()];
}

/**
 * 仿真能力诊断：本进程能否用原生 CDP **触达**面板，以及本 Electron 实例里到底有哪些 webContents。
 *
 * 存在的理由（2026-10-13 进程拓扑实测）：DSH 桌面端**正常启动**时，cordis host 是
 * 独立于 UI 的 Electron 子进程（UI renderer 的父进程是 app 主进程 54905，
 * 而插件跑在子进程 55379 里）。Electron 的 `webContents` 模块**只在同一实例内可见**，
 * 所以 host 进程很可能够不到 UI 实例中的面板 webview（`fromId()` 返回 undefined）。
 * 本函数把"能不能够到"变成一条结论，避免在会话里盲猜。
 *
 * @param {number|null} panelWebContentsId 由 client.cjs 上报的面板 webContents id
 */
export function diagnose(panelWebContentsId) {
	const cap = probe();
	if (!cap.ok) {
		return { ok: false, reason: cap.reason, webContents: [], verdict: `无原生 CDP：${cap.reason}` };
	}
	let list = [];
	try {
		list = cap.electron.webContents.getAllWebContents().map((wc) => ({
			id: wc.id,
			type: typeof wc.getType === "function" ? wc.getType() : "?",
			url: typeof wc.getURL === "function" ? String(wc.getURL()).slice(0, 120) : ""
		}));
	} catch (error) {
		return { ok: false, reason: `读取 webContents 列表失败：${error.message}`, webContents: [], verdict: "无原生 CDP" };
	}
	const has = typeof panelWebContentsId === "number";
	const reachable = has && list.some((w) => w.id === panelWebContentsId);
	let verdict;
	if (reachable) {
		verdict = "可达：宿主进程拿得到面板 webContents —— 内置面板可做与 DevTools 等价的仿真（零启动参数）";
	} else if (has) {
		verdict = "不可达：面板 webContents 不在本进程的 Electron 实例里（host 与 UI 分属两个实例）→ 零参数通道不可用；请改用 browser_attach（一次带参重启）或 target=managed";
	} else {
		verdict = "面板 webContents id 未知（面板可能没打开；先 browser_navigate 一次再诊断）";
	}
	return { ok: true, electron: cap.version, webContents: list, panelWebContentsId: has ? panelWebContentsId : null, reachable, verdict };
}
