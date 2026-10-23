#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# dsh-browser-bridge 一键安装脚本
#
# 用法：
#   ./install.sh [--profile desktop|web] [--python <venv python3 路径>] [--check]
#
# 默认安装到 desktop profile（DSH 桌面端内置浏览器面板的宿主，内置浏览器能力所在）。
# 会自动完成原本要手工做的三处登记：
#   1. profile 的 node_modules/dsh-browser-bridge → 软链到本插件目录
#   2. profile 的 package.json：dependencies 加 link: + dsh.profile.bundles 加包名
#   3. 插件自身 node_modules/@deepseek-ai/{cosmokit,dsh-tools,schemastery} → 软链到共享层
# 并把探测到的 venv python 写进 profile 的 cordis.patch.yml（browser-bridge 配置块的 pythonBin）。
#
# 可选参数：
#   --profile <name>   装到指定 profile（desktop / web）；默认 desktop
#   --python <path>    指定 venv python3 路径；不传则自动探测（见 detect_python 候选表）
#   --check            只检查现状，不做任何写操作（返回：0=已装好 1=未装/需装）
#
# 环境变量：DSH_BRIDGE_PYTHON 可替代 --python（CI / 批量装机场景）。
#
# 装完需要：重启 DSH 桌面端 + 开新会话（插件是 server 侧代码，进程启动时装载；
# 工具 schema 按会话快照）。自检：新会话里跑 browser_emulate(list=true)。
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PLUGIN_NAME="dsh-browser-bridge"
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DSH_PROFILES="${DSH_PROFILES:-$HOME/.dsh/profiles}"
# 共享层（dsh 本体安装位置）与 profile 无关：peer 软链固定指向这里，不跟随 DSH_PROFILES。
SHARED_NODE_MODULES="${HOME}/.dsh/profiles/node_modules"

PROFILE="desktop"
PYTHON_BIN="${DSH_BRIDGE_PYTHON:-}"
CHECK_ONLY=0

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
# 显式指定（--python / DSH_BRIDGE_PYTHON）时严格校验：不可用就报错，不静默 fallback；
# 未指定时遍历候选表取第一个可用者。
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
    "${HOME}/person/person-python/windowsPC/pythonPC/venv3/bin/python3"
    "${HOME}/.aiconfig/venv/bin/python3"
  )
  for c in "${candidates[@]}"; do
    [[ -x "$c" ]] || continue
    if "$c" -c "import playwright" >/dev/null 2>&1; then
      echo "$c"; return 0
    fi
  done
  return 1
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
  local default_python
  default_python="$(grep -o 'pythonBin: z.string().default("[^"]*")' "${PLUGIN_DIR}/lib/index.js" | sed 's/.*default("//; s/")//' | head -1)"
  if [[ -z "$default_python" ]]; then
    default_python="${HOME}/person/person-python/windowsPC/pythonPC/venv3/bin/python3"
  fi

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

# 探测 python
if ! PYTHON_BIN="$(detect_python)"; then
  case "${PYTHON_BIN:-}" in
    ERR:NOEXEC)
      warn "指定的 venv python 不可执行：${DSH_BRIDGE_PYTHON:-（--python 传入的路径）}"
      ;;
    ERR:NOPLAYWRIGHT)
      warn "指定的 venv python 存在但缺少 playwright：${DSH_BRIDGE_PYTHON:-（--python 传入的路径）}"
      warn "请先安装：<venv>/bin/pip install playwright"
      ;;
    *)
      warn "未能自动探测到可用的 venv python（需能 import playwright）。"
      warn "候选：${HOME}/person/person-python/windowsPC/pythonPC/venv3/bin/python3、${HOME}/.aiconfig/venv/bin/python3"
      ;;
  esac
  fail "请用 --python <路径> 指定一个装有 playwright 的 venv"
fi
ok "venv python：${PYTHON_BIN}"

# peer 软链
if ! ensure_plugin_peer_links; then
  if [[ $CHECK_ONLY -eq 1 ]]; then
    echo ""
    echo "检查结果：未完全装好（见上方 warn）"
    exit 1
  fi
fi

# profile 登记
if ! install_profile "$PROFILE"; then
  if [[ $CHECK_ONLY -eq 1 ]]; then
    echo ""
    echo "检查结果：未完全装好（见上方 warn）"
    exit 1
  fi
fi

if [[ $CHECK_ONLY -eq 1 ]]; then
  echo ""
  echo "检查结果：已装好 ✅（${PROFILE} profile）"
  exit 0
fi

echo ""
ok "安装完成 ✅"
echo ""
echo "下一步："
echo "  1. 重启 DSH 桌面端（普通重启即可，无需任何带参）"
echo "  2. 开新会话（工具 schema 按会话快照，旧会话看不到新工具）"
echo "  3. 自检：新会话里让模型跑 browser_emulate(list=true)，能列出 46 款机型即生效"
echo ""
echo "卸载：删除上面登记的软链 + package.json 两行 + cordis.patch.yml 配置块即可。"
