#!/usr/bin/env bash
#
# TestBench 一键安装脚本（macOS / Linux）
#
#   ./install.sh                # 安装全部工具链（推荐）
#   ./install.sh --no-jmeter    # 跳过 JMeter
#   ./install.sh --no-venv      # 直接装到当前 Python 环境，不创建 .venv
#   ./install.sh --with-perf    # 额外安装 evalscope[perf]，用于采集时延/吞吐指标
#   ./install.sh --check        # 只做环境自检，不安装任何东西
#
# 安装内容：
#   - Python 虚拟环境 .venv（项目内，无需 sudo，不影响系统 Python）
#   - Locust    负载测试
#   - EvalScope LLM 评测
#   - Apache JMeter（优先包管理器，失败则下载到 ./tools/）
#
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

JMETER_VERSION="${JMETER_VERSION:-5.6.3}"
TOOLS_DIR="$PROJECT_DIR/tools"
VENV_DIR="$PROJECT_DIR/.venv"

INSTALL_LOCUST=1
INSTALL_EVALSCOPE=1
INSTALL_JMETER=1
USE_VENV=1
WITH_PERF=0
CHECK_ONLY=0

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
  RED=$'\033[31m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; CYAN=""; RESET=""
fi

step()  { printf '\n%s==>%s %s\n' "$CYAN" "$RESET" "$(printf '%s' "$1" | sed 's/^/  /')"; }
info()  { printf '    %s\n' "$1"; }
dim()   { printf '    %s%s%s\n' "$DIM" "$1" "$RESET"; }
ok()    { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn()  { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
fail()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"; }
die()   { fail "$1"; exit 1; }

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

for arg in "$@"; do
  case "$arg" in
    --no-locust)    INSTALL_LOCUST=0 ;;
    --no-evalscope) INSTALL_EVALSCOPE=0 ;;
    --no-jmeter)    INSTALL_JMETER=0 ;;
    --no-venv)      USE_VENV=0 ;;
    --with-perf)    WITH_PERF=1 ;;
    --check)        CHECK_ONLY=1 ;;
    --strict)       STRICT=1 ;;
    -h|--help)      usage ;;
    *) die "未知参数：${arg}（使用 --help 查看说明）" ;;
  esac
done

printf '\n%sTestBench 安装程序%s\n' "$BOLD" "$RESET"
dim "项目目录：$PROJECT_DIR"

# --------------------------------------------------------------------- 前置检查
step "检查基础依赖"

command -v node >/dev/null 2>&1 || die "未找到 node，请先安装 Node.js 18+（https://nodejs.org）"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node.js 版本过低（当前 $(node -v)），需要 18 或更高"
fi
ok "Node.js $(node -v)"

PYTHON_BIN=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then
    if "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
      PYTHON_BIN="$candidate"
      break
    fi
  fi
done
if [ -z "$PYTHON_BIN" ]; then
  warn "未找到 Python 3.10+，Locust 与 EvalScope 将无法安装"
  warn "macOS: brew install python@3.12   Ubuntu: sudo apt install python3 python3-venv"
  INSTALL_LOCUST=0
  INSTALL_EVALSCOPE=0
else
  ok "Python $("$PYTHON_BIN" -V 2>&1 | awk '{print $2}')（${PYTHON_BIN}）"
fi

if command -v java >/dev/null 2>&1; then
  ok "Java $(java -version 2>&1 | head -1 | sed 's/.*version //;s/"//g')"
  HAVE_JAVA=1
else
  HAVE_JAVA=0
  [ "$INSTALL_JMETER" = "1" ] && warn "未找到 Java，JMeter 安装后仍无法运行（需 JDK 8+）"
fi

mkdir -p "$TOOLS_DIR"

if [ "$CHECK_ONLY" = "1" ]; then
  step "仅执行环境自检"
  node scripts/doctor.mjs ${STRICT:+--strict}
  exit $?
fi

# ------------------------------------------------------------- Python 工具链
if [ "$INSTALL_LOCUST" = "1" ] || [ "$INSTALL_EVALSCOPE" = "1" ]; then
  if [ "$USE_VENV" = "1" ]; then
    step "准备 Python 虚拟环境"
    if [ -x "$VENV_DIR/bin/python" ]; then
      ok "复用已有虚拟环境 $VENV_DIR"
    else
      info "创建 $VENV_DIR"
      "$PYTHON_BIN" -m venv "$VENV_DIR" || die "虚拟环境创建失败，请确认已安装 python3-venv"
      ok "虚拟环境已创建"
    fi
    PIP="$VENV_DIR/bin/pip"
    info "升级 pip"
    "$PIP" install --quiet --upgrade pip setuptools wheel || warn "pip 升级失败，继续使用现有版本"
  else
    PIP="$PYTHON_BIN -m pip"
    warn "未使用虚拟环境，将直接安装到系统 Python（可能触发 externally-managed-environment 限制）"
  fi

  if [ "$INSTALL_LOCUST" = "1" ]; then
    step "安装 Locust"
    $PIP install --quiet --upgrade locust && ok "Locust 安装完成" || fail "Locust 安装失败"
  fi

  if [ "$INSTALL_EVALSCOPE" = "1" ]; then
    step "安装 EvalScope"
    SPEC="evalscope"
    [ "$WITH_PERF" = "1" ] && SPEC="evalscope[perf]"
    if $PIP install --quiet --upgrade "$SPEC"; then
      ok "EvalScope 安装完成（${SPEC}）"
    else
      fail "EvalScope 安装失败（可尝试 --no-venv 或手动安装）"
    fi
  fi
fi

# -------------------------------------------------------------------- JMeter
if [ "$INSTALL_JMETER" = "1" ]; then
  step "安装 Apache JMeter"

  if command -v jmeter >/dev/null 2>&1; then
    ok "已存在 jmeter：$(command -v jmeter)"
  elif [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    info "使用 Homebrew 安装"
    if brew install jmeter; then ok "JMeter 安装完成"; else warn "Homebrew 安装失败，尝试下载便携版"; fi
  fi

  if ! command -v jmeter >/dev/null 2>&1 && [ ! -x "$TOOLS_DIR/jmeter/bin/jmeter" ]; then
    if command -v apt-get >/dev/null 2>&1 && [ "$(id -u)" = "0" ]; then
      step "使用 apt 安装 JMeter"
      apt-get update -qq && apt-get install -y -qq jmeter && ok "JMeter 安装完成" || warn "apt 安装失败，尝试下载便携版"
    elif command -v dnf >/dev/null 2>&1 && [ "$(id -u)" = "0" ]; then
      step "使用 dnf 安装 JMeter"
      dnf install -y -q jmeter && ok "JMeter 安装完成" || warn "dnf 安装失败，尝试下载便携版"
    fi
  fi

  if ! command -v jmeter >/dev/null 2>&1 && [ ! -x "$TOOLS_DIR/jmeter/bin/jmeter" ]; then
    step "下载 JMeter ${JMETER_VERSION} 便携版到 ./tools"
    ARCHIVE="$TOOLS_DIR/apache-jmeter-${JMETER_VERSION}.tgz"
    URL="https://archive.apache.org/dist/jmeter/binaries/apache-jmeter-${JMETER_VERSION}.tgz"
    if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then
      dim "$URL"
      if { command -v curl >/dev/null 2>&1 && curl -fL --retry 2 -o "$ARCHIVE" "$URL"; } ||
         { command -v wget >/dev/null 2>&1 && wget -q -O "$ARCHIVE" "$URL"; }; then
        tar -xzf "$ARCHIVE" -C "$TOOLS_DIR" && rm -f "$ARCHIVE"
        ln -sfn "apache-jmeter-${JMETER_VERSION}" "$TOOLS_DIR/jmeter"
        ok "JMeter 已解压到 tools/jmeter"
      else
        warn "下载失败（离线环境属正常），可稍后手动安装或再次运行本脚本"
      fi
    else
      warn "缺少 curl/wget，跳过下载"
    fi
  fi

  if [ "$HAVE_JAVA" = "0" ]; then
    warn "JMeter 已就位但缺少 Java 运行时，安装 JDK 8+ 后即可使用"
  fi
fi

# --------------------------------------------------------------------- 数据目录
step "初始化数据目录"
mkdir -p "$PROJECT_DIR/data/runs" "$PROJECT_DIR/data/datasets"
ok "data/ 已就绪"

# ----------------------------------------------------------------------- 自检
step "环境自检"
node scripts/doctor.mjs || true

printf '\n%s安装流程结束%s\n\n' "$BOLD" "$RESET"
printf '  启动服务：  %snpm start%s\n' "$CYAN" "$RESET"
printf '  局域网访问： %sHOST=0.0.0.0 PORT=4399 npm start%s\n' "$CYAN" "$RESET"
printf '  端到端测试： %snpm run smoke%s\n' "$CYAN" "$RESET"
if [ "$USE_VENV" = "1" ] && [ -x "$VENV_DIR/bin/python" ]; then
  printf '  手动使用虚拟环境： %ssource .venv/bin/activate%s\n' "$DIM" "$RESET"
fi
printf '\n  说明：未安装的工具会以「演示模式」运行（合成数据，不会伪装成真实测量）。\n\n'
