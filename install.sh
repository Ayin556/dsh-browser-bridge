#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# dsh-browser-bridge 一键安装脚本（macOS / Linux；Windows 用 install.ps1）
#
# 用法：
#   ./install.sh [--profile desktop|web] [--python <venv python3 路径>] [--check]
#
# 默认装到 desktop profile（DSH 桌面端内置浏览器面板的宿主）。
# 自动完成三处登记：
#   1. profile 的 node_modules/dsh-browser-bridge → 软链到本插件目录
#   2. profile 的 package.json：dependencies 加 link: + dsh.profile.bundles 加包名
#   3. 插件自身 node_modules/@deepseek-ai/{cosmokit,dsh-tools,schemastery} → 软链到共享层
# 没有可用 venv 时自动用系统 python3 建 ~/.dsh/browser-bridge/venv 并装 playwright。
#
# 前置：DSH 桌面端装好并至少启动过一次（生成 profiles/desktop）；
#       Python 3.9+；managed 通道另需系统 Chrome（builtin 不需要）。
#
# 可选参数：
#   --profile <name>   装到指定 profile（desktop / web）；默认 desktop
#   --python <path>    指定 venv python3；不传则自动探测 → 自建
#   --check            只检查现状，不写任何东西（0=已装好 1=未装/需装）
#
# 环境变量：DSH_BRIDGE_PYTHON 替代 --python；PIP_INDEX_URL 走内网镜像。
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PLUGIN_NAME="dsh-browser-bridge"
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DSH_PROFILES="${DSH_PROFILES:-$HOME/.dsh/profiles}"
# 共享层（dsh 本体安装位置）与 profile 无关：peer 软链固定指向这里，不跟随 DSH_PROFILES。
SHARED_NODE_MODULES="${HOME}/.dsh/profiles/node_modules"
# 通用 venv 位置：与 lib/index.js 的 pythonBin 默认值保持一致。
# 所有机器都落到同一路径，装完无需逐台写 profile 覆盖。
BRIDGE_HOME="${HOME}/.dsh/browser-bridge"
DEFAULT_VENV_PY="${BRIDGE_HOME}/venv/bin/python3"

PROFILE="desktop"
PYTHON_BIN="${DSH_BRIDGE_PYTHON:-}"
CHECK_ONLY=0

usage() {
  sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --python) PYTHON_BIN="$2"; shift 2 ;;
    --check) CHECK_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1"; usage; exit 1 ;;
  esac
done

info() { printf '\033[36m[install]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[install]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[install]\033[0m %s\n' "$*"; exit 1; }

# ── 1. 探测 venv python（要能 import playwright）───────────────────────────
# 优先级：显式指定 > 通用 venv > 历史已有 venv。
# 全都没有时由 ensure_python() 用系统 python3 自动建一个（见 1b）。
# 显式指定（--python / DSH_BRIDGE_PYTHON）时严格校验：不可用就报错，不静默 fallback。
detect_python() {
  local c
  if [[ -n "${PYTHON_BIN:-}" ]]; then
    if [[ ! -x "$PYTHON_BIN" ]]; then
      echo "ERR:NOEXEC"
      return 1
    fi
    if ! "$PYTHON_BIN" -c "import playwright" >/dev/null 2>&1; then
      echo "ERR:NOPLAYWRIGHT"
      return 1
    fi
    echo "$PYTHON_BIN"
    return 0
  fi
  local candidates=(
    "$DEFAULT_VENV_PY"
    "${HOME}/.aiconfig/venv/bin/python3"
    "${HOME}/person/person-python/windowsPC/pythonPC/venv3/bin/python3"
  )
  for c in "${candidates[@]}"; do
    [[ -x "$c" ]] || continue
    if "$c" -c "import playwright" >/dev/null 2>&1; then
      echo "$c"; return 0
    fi
  done
  return 1
}

# ── 1b. 没有可用 venv 时自建（通用路径，幂等）──────────────────────────────
# 找系统 python3（要求 >= 3.9；playwright 需要 3.9+）
find_system_python() {
  local p
  for p in "$(command -v python3 2>/dev/null || true)" /usr/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
    [[ -n "$p" && -x "$p" ]] || continue
    if "$p" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
      echo "$p"; return 0
    fi
  done
  return 1
}

ensure_python() {
  local sys_py
  if ! sys_py="$(find_system_python)"; then
    warn "未找到 Python 3.9+（系统 python3 不存在或版本过低）"
    warn "macOS：brew install python@3.12　或　https://www.python.org/downloads/"
    return 1
  fi
  info "未发现可用 venv，用系统 Python 自建：${sys_py}"
  mkdir -p "$BRIDGE_HOME"
  if [[ ! -x "$DEFAULT_VENV_PY" ]]; then
    "$sys_py" -m venv "${BRIDGE_HOME}/venv" || { warn "创建 venv 失败：${BRIDGE_HOME}/venv"; return 1; }
    ok "venv 已创建：${BRIDGE_HOME}/venv"
  else
    info "复用已有 venv：${BRIDGE_HOME}/venv"
  fi
  info "安装 playwright（首次约 1-2 分钟）…"
  # 内网/国内网络慢：先 export PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
  if ! "$DEFAULT_VENV_PY" -m pip install --disable-pip-version-check -q playwright; then
    warn "playwright 安装失败。如在公司内网，设置镜像后重跑："
    warn "  export PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple"
    return 1
  fi
  ok "playwright 已安装：$("$DEFAULT_VENV_PY" -c 'import playwright; print(playwright.__version__ if hasattr(playwright,"__version__") else "ok")' 2>/dev/null || echo ok)"
  return 0
}

# ── 1c. 系统 Chrome 检测（只影响 managed 通道，builtin 不需要）──────────────
check_chrome() {
  local found=0
  if [[ "$(uname -s)" == "Darwin" ]]; then
    [[ -d "/Applications/Google Chrome.app" ]] && found=1
    [[ -d "${HOME}/Applications/Google Chrome.app" ]] && found=1
  else
    command -v google-chrome >/dev/null 2>&1 && found=1
    command -v google-chrome-stable >/dev/null 2>&1 && found=1
    command -v chromium >/dev/null 2>&1 && found=1
  fi
  if [[ $found -eq 1 ]]; then
    ok "系统 Chrome：已检测到（managed 通道可用）"
  else
    warn "未检测到 Chrome —— builtin（内置面板）不受影响，但 target=managed 会启动失败"
    warn "需要 managed 时装 Google Chrome 即可，不必跑 playwright install"
  fi
}

# ── 2. 检查插件自身 peerDeps 软链（cosmokit / dsh-tools / schemastery）──────
ensure_plugin_peer_links() {
  local pkg target src missing=0
  for pkg in cosmokit dsh-tools schemastery; do
    target="${PLUGIN_DIR}/node_modules/@deepseek-ai/${pkg}"
    src="${SHARED_NODE_MODULES}/@deepseek-ai/${pkg}"
    if [[ -L "$target" && "$(readlink "$target")" == "$src" ]]; then
      continue
    fi
    if [[ $CHECK_ONLY -eq 1 ]]; then
      if [[ -L "$target" ]]; then
        warn "peer 软链 ${pkg} 指向不对（应为 ${src}）"
      else
        warn "peer 软链 ${pkg} 缺失"
      fi
      missing=1
      continue
    fi
    if [[ ! -e "$src" ]]; then
      warn "共享层缺少 @deepseek-ai/${pkg}（${src} 不存在），跳过该软链——请确认已装过 dsh 本体"
      missing=1
      continue
    fi
    mkdir -p "${PLUGIN_DIR}/node_modules/@deepseek-ai"
    ln -sfn "$src" "$target"
    ok "peer 软链：@deepseek-ai/${pkg} → 共享层"
  done
  return $missing
}

# ── 3. 装到单个 profile：三处登记 + pythonBin 写入 cordis.patch.yml ─────────
install_profile() {
  local profile="$1"
  local node_modules_dir="${DSH_PROFILES}/${profile}/node_modules"
  local package_json="${DSH_PROFILES}/${profile}/package.json"
  local patch_yml="${DSH_PROFILES}/${profile}/cordis.patch.yml"

  info "目标 profile：${profile}"

  if [[ ! -d "${DSH_PROFILES}/${profile}" ]]; then
    warn "profile ${profile} 不存在（${DSH_PROFILES}/${profile}），跳过"
    return 1
  fi

  # 3a. node_modules 软链
  local link_path="${node_modules_dir}/${PLUGIN_NAME}"
  if [[ -L "$link_path" && "$(readlink "$link_path")" == "$PLUGIN_DIR" ]]; then
    ok "node_modules 软链已存在：${link_path}"
  else
    if [[ $CHECK_ONLY -eq 1 ]]; then
      if [[ -L "$link_path" ]]; then
        warn "node_modules 软链指向不对（应为 ${PLUGIN_DIR}）"
      else
        warn "node_modules 软链缺失"
      fi
      return 1
    fi
    mkdir -p "$node_modules_dir"
    ln -sfn "$PLUGIN_DIR" "$link_path"
    ok "node_modules 软链：${link_path}"
  fi

  # 3b. package.json：dependencies + bundles（用 node 做 JSON 合并，避免手拼破坏格式）
  if [[ -f "$package_json" ]]; then
    node -e '
      const fs = require("fs");
      const p = process.argv[1], link = process.argv[2], name = process.argv[3];
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      let changed = false;
      j.dependencies = j.dependencies || {};
      if (!j.dependencies[name]) { j.dependencies[name] = "link:" + link; changed = true; }
      j.dsh = j.dsh || {};
      j.dsh.profile = j.dsh.profile || {};
      j.dsh.profile.bundles = j.dsh.profile.bundles || [];
      if (!j.dsh.profile.bundles.includes(name)) { j.dsh.profile.bundles.push(name); changed = true; }
      if (changed) fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
    ' "$package_json" "$PLUGIN_DIR" "$PLUGIN_NAME"
    if node -e '
      const fs = require("fs");
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const hasDep = !!(j.dependencies && j.dependencies[process.argv[2]]);
      const hasBun = !!(j.dsh && j.dsh.profile && j.dsh.profile.bundles && j.dsh.profile.bundles.includes(process.argv[2]));
      process.exit((hasDep && hasBun) ? 0 : 1);
    ' "$package_json" "$PLUGIN_NAME"; then
      ok "package.json：dependencies + bundles 已登记"
    else
      if [[ $CHECK_ONLY -eq 1 ]]; then
        warn "package.json 缺登记（dependencies 或 bundles）"
        return 1
      fi
      fail "package.json 登记失败（请检查 ${package_json}）"
    fi
  else
    if [[ $CHECK_ONLY -eq 1 ]]; then
      warn "profile 无 package.json（${package_json}），无法登记"
      return 1
    fi
    node -e '
      const fs = require("fs");
      const p = process.argv[1], link = process.argv[2], name = process.argv[3];
      const j = {
        name: "dsh-profile",
        private: true,
        dependencies: { [name]: "link:" + link },
        dsh: { profile: { bundles: [name] } }
      };
      fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
    ' "$package_json" "$PLUGIN_DIR" "$PLUGIN_NAME"
    ok "package.json（新建）：dependencies + bundles 已登记"
  fi

  # 3c. cordis.patch.yml：browser-bridge 配置块（pythonBin + defaultTarget=builtin）
  # 注意：插件 bundle 自带的 cordis.patch.yml 已插入 `- id: browser-bridge`（用插件默认
  # pythonBin）。只有当「探测路径 ≠ 插件默认 pythonBin」时才需要 profile 层配置块覆盖；
  # 一致时 profile 层无需写（判为已配置）。
  # 插件默认值与安装脚本约定一致（lib/index.js 的 pythonBin 默认 = ~/.dsh/browser-bridge/venv）。
  # 不再从源码 grep 解析：默认值已改成跨平台表达式，文本匹配会失效。
  local default_python="$DEFAULT_VENV_PY"

  local has_block=0
  if [[ -f "$patch_yml" ]] && grep -q '^\- id: browser-bridge' "$patch_yml"; then
    has_block=1
  fi
  if [[ $has_block -eq 1 ]]; then
    if grep -q "pythonBin:.*${PYTHON_BIN}" "$patch_yml"; then
      ok "cordis.patch.yml：browser-bridge 配置块已含 pythonBin"
    elif [[ "$PYTHON_BIN" == "$default_python" ]]; then
      # profile 层块存在但没写 pythonBin，而插件默认值恰好一致 → 实际可用
      ok "cordis.patch.yml：browser-bridge 块存在（插件默认 pythonBin 即探测路径，无需覆盖）"
    else
      if [[ $CHECK_ONLY -eq 1 ]]; then
        warn "cordis.patch.yml：browser-bridge 块存在但 pythonBin 未指向探测路径（默认=${default_python}，探测=${PYTHON_BIN}）"
        return 1
      fi
      warn "browser-bridge 块已存在但 pythonBin 未覆盖为探测路径——请手动补 config.pythonBin（见 README 配置节）"
    fi
  else
    if [[ "$PYTHON_BIN" == "$default_python" ]]; then
      ok "cordis.patch.yml：无需配置块（插件默认 pythonBin 即探测路径，bundle 层自动生效）"
    else
      if [[ $CHECK_ONLY -eq 1 ]]; then
        warn "cordis.patch.yml 缺 browser-bridge 配置块（默认 pythonBin=${default_python} ≠ 探测 ${PYTHON_BIN}，需覆盖）"
        return 1
      fi
      cat >> "$patch_yml" <<EOF

# ── dsh-browser-bridge（install.sh 自动登记）────────────────────
- id: browser-bridge
  name: dsh-browser-bridge
  config:
    pythonBin: ${PYTHON_BIN}
    defaultTarget: builtin
EOF
      ok "cordis.patch.yml：已追加 browser-bridge 配置块（pythonBin=${PYTHON_BIN}）"
    fi
  fi
  return 0
}

# ── 主流程 ──────────────────────────────────────────────────────────────────
echo ""
info "dsh-browser-bridge 安装（插件目录：${PLUGIN_DIR}）"
info "DSH profiles 根：${DSH_PROFILES}"

# 探测 python（探测不到就自动建通用 venv，不再要人手动指定）
if ! PYTHON_BIN="$(detect_python)"; then
  case "${PYTHON_BIN:-}" in
    ERR:NOEXEC)
      warn "指定的 venv python 不可执行：${DSH_BRIDGE_PYTHON:-（--python 传入的路径）}"
      fail "请检查路径是否正确"
      ;;
    ERR:NOPLAYWRIGHT)
      warn "指定的 venv python 缺少 playwright：${DSH_BRIDGE_PYTHON:-（--python 传入的路径）}"
      fail "请先执行：<venv>/bin/pip install playwright（或去掉 --python 让脚本自建）"
      ;;
    *)
      if [[ $CHECK_ONLY -eq 1 ]]; then
        warn "未发现可用的 playwright venv（--check 模式不自动创建）"
        echo ""
        echo "检查结果：未装好（缺 venv；直接跑 ./install.sh 会自动创建）"
        exit 1
      fi
      info "未发现可用的 playwright venv，开始自动准备…"
      if ! ensure_python; then
        fail "自动准备 venv 失败。可手动指定：./install.sh --python <venv python3 路径>"
      fi
      PYTHON_BIN="$DEFAULT_VENV_PY"
      if ! "$PYTHON_BIN" -c "import playwright" >/dev/null 2>&1; then
        fail "venv 已存在但 playwright 仍不可用：${PYTHON_BIN}"
      fi
      ;;
  esac
fi
ok "venv python：${PYTHON_BIN}"

# Chrome 检测（软提示，不阻断安装：builtin 通道不需要 Chrome）
check_chrome

# peer 软链
INCOMPLETE=0
if ! ensure_plugin_peer_links; then
  INCOMPLETE=1
  if [[ $CHECK_ONLY -eq 1 ]]; then
    echo ""
    echo "检查结果：未完全装好（见上方 warn）"
    exit 1
  fi
fi

# profile 登记
if ! install_profile "$PROFILE"; then
  INCOMPLETE=1
  if [[ $CHECK_ONLY -eq 1 ]]; then
    echo ""
    echo "检查结果：未完全装好（见上方 warn）"
    exit 1
  fi
fi

if [[ $CHECK_ONLY -eq 1 ]]; then
  echo ""
  if [[ $INCOMPLETE -eq 1 ]]; then
    echo "检查结果：未完全装好（见上方 warn）"
    exit 1
  fi
  echo "检查结果：已装好 ✅（${PROFILE} profile）"
  exit 0
fi

echo ""
if [[ $INCOMPLETE -eq 0 ]]; then
  ok "安装完成 ✅"
else
  # 关键：登记写了一半但依赖缺失时，绝不能报成功——插件进程会装载失败，
  # 用户只会看到"工具没出现"，完全不知道差什么。
  warn "登记已完成，但上面有跳过项 → 插件当前**不会生效**"
  echo ""
  echo "最常见原因：DSH 桌面端还没装、或没启动过（缺少 ${SHARED_NODE_MODULES} 共享层）。"
  echo "处理：先启动一次 DSH 桌面端，再重跑本脚本（幂等，可直接重跑）。"
  echo ""
  echo "卸载：删除上面登记的软链 + package.json 两行 + cordis.patch.yml 配置块即可。"
  exit 2
fi
echo ""
echo "下一步："
echo "  1. 重启 DSH 桌面端（普通重启即可，无需任何带参）"
echo "  2. 开新会话（工具 schema 按会话快照，旧会话看不到新工具）"
echo "  3. 自检：新会话里让模型跑 browser_emulate(list=true)，能列出 46 款机型即生效"
echo ""
echo "卸载：删除上面登记的软链 + package.json 两行 + cordis.patch.yml 配置块即可。"
