#!/usr/bin/env bash
#
# GoldenKey 服务端一键前置部署（环境准备 + 从零建表，正式环境单套）
# ============================================================
# 在目标服务器（Ubuntu / Debian）上一次性完成：
#   1. 基础工具 + Node.js + MySQL/MariaDB + PM2（各自可用 SKIP_* 跳过）
#   2. 数据库 goldenkey 与最小权限账号 goldenkey（只授权它自己的库）
#   3. 从零建表：DROP 当前库全部表 → 按同目录 schema.sql 重建 → 建管理员账号
#      GoldenKey 开发阶段不做增量迁移，表结构永远以 schema.sql 为准；
#      重跑本脚本会清空业务数据，请只在初始化/重置时执行。
#   4. 生成 AUTH_SECRET / ADMIN_PASSWORD 并持久化（重跑沿用旧值，无需反复改 GitHub）
#   5. 创建部署目录 /opt/GoldenKeyServer 并统一 chown 给部署用户
#   6. 打印需要填入 GitHub Secrets 的清单（只有正式环境；留空项需自行填写）
#
# 适用系统：Ubuntu 20.04/22.04、Debian 11/12
# 运行要求：以 root 或具备 sudo 权限的用户执行
#
# 用法示例（先把本脚本和 schema.sql 传到服务器同一目录）：
#   scp server-setup.sh schema.sql root@YOUR_ECS:/tmp/
#   sudo bash /tmp/server-setup.sh
#   sudo MYSQL_ROOT_PASSWORD='既有root密码' bash /tmp/server-setup.sh
#   sudo SKIP_NODE=1 SKIP_PM2=1 bash /tmp/server-setup.sh
#   sudo SKIP_MYSQL=1 MYSQL_HOST=x MYSQL_USER=u MYSQL_PASSWORD=p MYSQL_DATABASE=d bash /tmp/server-setup.sh
#
# 可选环境变量：
#   NODE_VERSION        Node 版本，默认 20（与 deploy.yml 一致）
#   MYSQL_ROOT_PASSWORD MySQL root 密码；既有数据库传原密码，新装可不传（自动生成）
#   MYSQL_HOST / MYSQL_PORT     默认 127.0.0.1 / 3306
#   MYSQL_DATABASE     库名，默认 goldenkey
#   MYSQL_USER         应用账号，默认 goldenkey
#   MYSQL_PASSWORD     应用账号密码；不传则自动生成（重跑沿用旧值）
#   AUTH_SECRET        token 签名密钥；不传则自动生成（重跑沿用旧值）
#   ADMIN_USERNAME     后台管理员账号，默认 admin
#   ADMIN_PASSWORD     后台管理员口令；不传则自动生成（重跑沿用旧值）
#   DEPLOY_USER        部署目录属主（GitHub Actions 的 SSH 用户），默认 $SUDO_USER
#   DEPLOY_PATH        部署目录，默认 /opt/GoldenKeyServer
#   SCHEMA_FILE        schema.sql 路径，默认脚本同目录
#   SKIP_NODE=1        跳过 Node.js 安装
#   SKIP_MYSQL=1       跳过 MySQL 安装及建库建账号（外部托管数据库时用，仍会执行建表）
#   SKIP_PM2=1         跳过 PM2 安装
#   SKIP_DB_INIT=1     跳过 DROP + 建表（只想装环境时用）
#
# 安全说明：
#   - 既有数据库绝不重装、不改 root 密码/认证方式（保护服务器上其他服务）
#   - 应用账号只授权自己的库，不给全局权限
#   - 口令/令牌不在终端回显明文，只输出长度；明文统一存 ${SECRET_FILE}（权限 600）
#   - 本脚本会 DROP 业务表，属于破坏性初始化；执行前请确认目标库无误
# ============================================================

set -euo pipefail

# ---------- 颜色输出（非终端时关闭）----------
if [[ -t 1 ]]; then
  C_RED='\033[0;31m'; C_GREEN='\033[0;32m'; C_YELLOW='\033[1;33m'; C_CYAN='\033[0;36m'; C_RESET='\033[0m'
else
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''; C_RESET=''
fi
log()  { echo -e "${C_GREEN}[INFO]${C_RESET} $*"; }
warn() { echo -e "${C_YELLOW}[WARN]${C_RESET} $*" >&2; }
err()  { echo -e "${C_RED}[ERROR]${C_RESET} $*" >&2; }
step() { echo -e "${C_CYAN}==>${C_RESET} $*"; }

# ---------- 参数 ----------
NODE_VERSION="${NODE_VERSION:-20}"
MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-}"
MYSQL_HOST="${MYSQL_HOST:-127.0.0.1}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
DB_NAME="${MYSQL_DATABASE:-goldenkey}"
DB_USER="${MYSQL_USER:-goldenkey}"
DB_PASSWORD="${MYSQL_PASSWORD:-}"
AUTH_SECRET="${AUTH_SECRET:-}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
DEPLOY_USER="${DEPLOY_USER:-${SUDO_USER:-$(whoami)}}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/GoldenKeyServer}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA_FILE="${SCHEMA_FILE:-$SCRIPT_DIR/schema.sql}"
SECRET_FILE="/root/.goldenkey_secrets"
SKIP_NODE="${SKIP_NODE:-0}"
SKIP_MYSQL="${SKIP_MYSQL:-0}"
SKIP_PM2="${SKIP_PM2:-0}"
SKIP_DB_INIT="${SKIP_DB_INIT:-0}"

export DEBIAN_FRONTEND=noninteractive

# ---------- 工具函数 ----------
is_installed() { command -v "$1" >/dev/null 2>&1; }
mask_len() { if [[ -n "$1" ]]; then printf 'len=%s' "${#1}"; else printf '未设置'; fi; }

gen_pwd() {
  if is_installed openssl; then
    openssl rand -base64 18 2>/dev/null | tr -dc 'A-Za-z0-9' | head -c 24
  else
    date +%s%N | sha256sum | head -c 24
  fi
}
gen_secret() {
  if is_installed openssl; then
    openssl rand -base64 48
  else
    date +%s%N | sha256sum | head -c 64
  fi
}

# set -euo pipefail 下 grep 无匹配返回 1，必须 || true 兜底
secret_val() { { grep "^$1=" "$SECRET_FILE" 2>/dev/null || true; } | tail -1 | cut -d= -f2-; }

upsert_secret() {
  local key="$1" val="$2" line found=0 tmp
  tmp="$(mktemp)"
  if [[ -f "$SECRET_FILE" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      case "$line" in
        "$key="*) printf '%s\n' "$key=$val" >>"$tmp"; found=1 ;;
        *)        printf '%s\n' "$line" >>"$tmp" ;;
      esac
    done <"$SECRET_FILE"
  fi
  [[ "$found" == "1" ]] || printf '%s\n' "$key=$val" >>"$tmp"
  mv "$tmp" "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
}

# SQL 单引号转义（管理员口令允许包含特殊字符）
sql_quote() {
  local s="${1//\\/\\\\}"
  s="${s//\'/\'\'}"
  printf "'%s'" "$s"
}

# ---------- 前置断言 ----------
if [[ $EUID -ne 0 ]]; then
  err "请以 root 或使用 sudo 运行此脚本（例如：sudo bash server-setup.sh）"
  exit 1
fi
if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="$ID"
else
  err "无法识别的 Linux 发行版（缺少 /etc/os-release）"
  exit 1
fi
case "$OS_ID" in
  ubuntu|debian) : ;;
  *) warn "本脚本主要面向 Ubuntu/Debian 编写，当前系统为 '$OS_ID'，如需运行可能需手动调整" ;;
esac

if [[ "$SKIP_DB_INIT" != "1" && ! -s "$SCHEMA_FILE" ]]; then
  err "找不到 schema.sql：$SCHEMA_FILE（请把本脚本与 schema.sql 放在同一目录，或用 SCHEMA_FILE= 指定）"
  exit 1
fi

# 令牌/管理员口令：显式环境变量 > secret 文件里的旧值（重跑沿用，本次后面再补生成）
[[ -n "$AUTH_SECRET" ]] || AUTH_SECRET="$(secret_val AUTH_SECRET)"
[[ -n "$ADMIN_PASSWORD" ]] || ADMIN_PASSWORD="$(secret_val ADMIN_PASSWORD)"

# ---------- 1. 基础工具 ----------
step "1/6 安装基础工具"
apt-get update -y
apt-get install -y -q curl gnupg ca-certificates openssl

# ---------- 2. Node.js ----------
step "2/6 Node.js 运行环境"
if [[ "$SKIP_NODE" == "1" ]]; then
  warn "已设置 SKIP_NODE=1，跳过 Node.js 安装"
elif is_installed node && node -v 2>/dev/null | grep -q "v${NODE_VERSION}"; then
  log "Node.js 已满足版本要求（$(node -v)），跳过"
else
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh || true
  apt-get install -y -q nodejs
  rm -f /tmp/nodesource_setup.sh
  log "Node.js 安装完成：$(node -v)，npm $(npm -v)"
fi

# ---------- 3~4. MySQL + 账号 ----------
if [[ "$SKIP_MYSQL" == "1" ]]; then
  warn "已设置 SKIP_MYSQL=1，跳过 MySQL 安装及建库建账号（下方 Secrets 的 MYSQL_* 请填外部数据库现有值）"
  [[ -n "$DB_PASSWORD" ]] || { err "SKIP_MYSQL=1 时必须显式提供 MYSQL_PASSWORD（外部数据库现有口令）"; exit 1; }
else
  step "3/6 MySQL/MariaDB 安装与检测"

  # 重跑幂等：未显式传密码时沿用上次生成的密码
  [[ -n "$MYSQL_ROOT_PASSWORD" ]] || MYSQL_ROOT_PASSWORD="$(secret_val MYSQL_ROOT_PASSWORD)"
  [[ -n "$DB_PASSWORD" ]] || DB_PASSWORD="$(secret_val MYSQL_PASSWORD)"

  DB_BIN=""
  if is_installed mysqld; then DB_BIN=mysqld
  elif is_installed mariadbd; then DB_BIN=mariadbd
  elif is_installed mysql; then DB_BIN=mysql
  fi

  DB_WAS_EXISTING=0
  if [[ -n "$DB_BIN" ]]; then
    DB_WAS_EXISTING=1
    log "检测到既有数据库（${DB_BIN}），跳过重装（保留服务器上其他依赖该库的服务）"
  else
    apt-get install -y -q mysql-server
  fi

  systemctl enable mysql 2>/dev/null || systemctl enable mariadb 2>/dev/null || true
  systemctl start mysql 2>/dev/null || systemctl start mariadb 2>/dev/null || true

  # 等待 socket 就绪（必须在探测 root 连接方式之前）
  for i in $(seq 1 30); do
    if [[ -S /var/run/mysqld/mysqld.sock ]] || systemctl is-active --quiet mysql 2>/dev/null || systemctl is-active --quiet mariadb 2>/dev/null; then break; fi
    sleep 1
  done

  if mysql -V 2>/dev/null | grep -qi mariadb; then DB_FLAVOR="mariadb"; else DB_FLAVOR="mysql"; fi
  log "检测到数据库类型：${DB_FLAVOR}"

  # root 连接方式：先探测 socket 免密（Ubuntu root/sudo 通常可用），避免非交互环境卡在 read
  ROOT_BY_SOCKET=0
  ROOT_CONN=( -u root )
  if mysql -u root -e "SELECT 1" >/dev/null 2>&1; then
    ROOT_BY_SOCKET=1
    log "MySQL root 免密连接成功（socket 认证），无需输入密码"
  else
    if [[ -z "$MYSQL_ROOT_PASSWORD" ]]; then
      if [[ -t 0 ]]; then
        printf '请输入既有 MySQL 的 root 密码（输入不回显）: ' >&2
        read -r -s MYSQL_ROOT_PASSWORD || true
        printf '\n' >&2
      fi
      if [[ -z "$MYSQL_ROOT_PASSWORD" ]]; then
        err "无法免密连接 MySQL root 且未提供密码。请显式传参重跑：sudo MYSQL_ROOT_PASSWORD='原密码' bash server-setup.sh（脚本不会修改既有 root 密码）。"
        exit 1
      fi
    fi
    ROOT_CONN=( -u root -p"${MYSQL_ROOT_PASSWORD}" )
    if ! mysql "${ROOT_CONN[@]}" -e "SELECT 1" >/dev/null 2>&1; then
      err "MYSQL_ROOT_PASSWORD 连接失败，请检查密码是否正确。"
      exit 1
    fi
  fi

  if [[ "$DB_WAS_EXISTING" == "1" ]]; then
    log "已连接既有数据库 root（保持原密码/认证不变，以保护其他依赖服务）"
  elif [[ "$ROOT_BY_SOCKET" == "1" ]]; then
    # 新装库：把 root 从 socket 认证切成密码认证，与打印的 secret 保持一致
    [[ -n "$MYSQL_ROOT_PASSWORD" ]] || { MYSQL_ROOT_PASSWORD="$(gen_pwd)"; warn "已自动生成 MySQL root 密码"; }
    if [[ "$DB_FLAVOR" == "mariadb" ]]; then
      SQL_ROOT_AUTH="IDENTIFIED BY '${MYSQL_ROOT_PASSWORD}'"
    else
      SQL_ROOT_AUTH="IDENTIFIED WITH mysql_native_password BY '${MYSQL_ROOT_PASSWORD}'"
    fi
    mysql -u root <<SQL || true
ALTER USER 'root'@'localhost' ${SQL_ROOT_AUTH};
FLUSH PRIVILEGES;
SQL
    ROOT_CONN=( -u root -p"${MYSQL_ROOT_PASSWORD}" )
    if ! mysql "${ROOT_CONN[@]}" -e "SELECT 1" >/dev/null 2>&1; then
      err "设置 root 密码后连接失败，请检查数据库配置。"
      exit 1
    fi
  fi

  # 先补齐应用账号密码，再构造认证语法（避免空密码被写进 SQL）
  [[ -n "$DB_PASSWORD" ]] || { DB_PASSWORD="$(gen_pwd)"; warn "已自动生成应用账号密码"; }
  if [[ "$DB_FLAVOR" == "mariadb" ]]; then
    AUTH_DB="IDENTIFIED BY '${DB_PASSWORD}'"
  else
    AUTH_DB="IDENTIFIED WITH mysql_native_password BY '${DB_PASSWORD}'"
  fi

  step "4/6 创建数据库与最小权限账号"
  mysql "${ROOT_CONN[@]}" <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' ${AUTH_DB};
ALTER USER '${DB_USER}'@'localhost' ${AUTH_DB};
GRANT SELECT,INSERT,UPDATE,DELETE,CREATE,ALTER,DROP,INDEX ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL
  log "数据库就绪：${DB_NAME}/${DB_USER}（应用账号仅有自己的库的 DDL/DML 权限）"
fi

# ---------- 5. 从零建表 ----------
if [[ "$SKIP_DB_INIT" == "1" ]]; then
  warn "已设置 SKIP_DB_INIT=1，跳过 DROP 与建表"
else
  step "5/6 从零建表（DROP 全部表 → source schema.sql → 建管理员）"
  if [[ "$MYSQL_HOST" == "localhost" || "$MYSQL_HOST" == "127.0.0.1" ]]; then
    APP_CONN=( -h localhost -P "$MYSQL_PORT" -u "$DB_USER" -p"$DB_PASSWORD" )
  else
    APP_CONN=( -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$DB_USER" -p"$DB_PASSWORD" )
  fi
  if ! mysql "${APP_CONN[@]}" -e "SELECT 1" >/dev/null 2>&1; then
    err "应用账号连接数据库失败：${DB_USER}@${MYSQL_HOST}:${MYSQL_PORT}/${DB_NAME}（密码不显示）"
    exit 1
  fi

  # 关外键检查后 DROP 当前库全部表；information_schema 拼出 DROP 语句，避免依赖表名顺序
  DROP_SQL="$(mysql "${APP_CONN[@]}" -N -B -e \
    "SELECT CONCAT('DROP TABLE IF EXISTS \`', TABLE_NAME, '\`;') FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DB_NAME' AND TABLE_TYPE='BASE TABLE'" 2>/dev/null || true)"
  mysql "${APP_CONN[@]}" "$DB_NAME" <<SQL
SET FOREIGN_KEY_CHECKS = 0;
${DROP_SQL}
SET FOREIGN_KEY_CHECKS = 1;
SQL
  TABLE_COUNT="$(mysql "${APP_CONN[@]}" -N -B -e \
    "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DB_NAME' AND TABLE_TYPE='BASE TABLE'" 2>/dev/null || echo 0)"
  log "已 DROP 当前库全部表（原 ${TABLE_COUNT} 张）"

  # 按 schema.sql 重建结构
  mysql "${APP_CONN[@]}" "$DB_NAME" < "$SCHEMA_FILE"

  # 管理员账号（系统可登录的最低要求，不属于演示数据）
  [[ -n "$ADMIN_PASSWORD" ]] || ADMIN_PASSWORD="$(gen_pwd)"
  mysql "${APP_CONN[@]}" "$DB_NAME" -e \
    "INSERT INTO admin_users (username, password, role) VALUES ($(sql_quote "$ADMIN_USERNAME"), $(sql_quote "$ADMIN_PASSWORD"), 'admin')"

  NEW_COUNT="$(mysql "${APP_CONN[@]}" -N -B -e \
    "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DB_NAME' AND TABLE_TYPE='BASE TABLE'" 2>/dev/null || echo 0)"
  log "已按 schema.sql 重建 ${NEW_COUNT} 张表，并创建管理员账号 ${ADMIN_USERNAME}"
  warn "业务数据已被清空（教师/课程/学员/排课等请在后台重新录入）"
fi

# ---------- 6. 令牌/口令持久化 + PM2 + 部署目录 ----------
step "6/6 PM2 与部署目录"

# 旧值已在开头读取；这里只处理本次仍为空的情况
[[ -n "$AUTH_SECRET" ]] || { AUTH_SECRET="$(gen_secret)"; warn "已自动生成 AUTH_SECRET"; }
[[ -n "$ADMIN_PASSWORD" ]] || { ADMIN_PASSWORD="$(gen_pwd)"; warn "已自动生成 ADMIN_PASSWORD"; }

# 持久化（含数据库口令），供下次重跑沿用；明文不回显
upsert_secret MYSQL_ROOT_PASSWORD "$MYSQL_ROOT_PASSWORD"
upsert_secret MYSQL_HOST "$MYSQL_HOST"
upsert_secret MYSQL_PORT "$MYSQL_PORT"
upsert_secret MYSQL_DATABASE "$DB_NAME"
upsert_secret MYSQL_USER "$DB_USER"
upsert_secret MYSQL_PASSWORD "$DB_PASSWORD"
upsert_secret AUTH_SECRET "$AUTH_SECRET"
upsert_secret ADMIN_USERNAME "$ADMIN_USERNAME"
upsert_secret ADMIN_PASSWORD "$ADMIN_PASSWORD"
log "口令/令牌已保存到 ${SECRET_FILE}（权限 600），下次重跑不会变化"

if [[ "$SKIP_PM2" == "1" ]]; then
  warn "已设置 SKIP_PM2=1，跳过 PM2 安装"
elif is_installed pm2; then
  log "PM2 已安装（$(pm2 -v)），跳过"
else
  npm install -g pm2
  log "PM2 安装完成：$(pm2 -v)"
  warn "部署用户首次请执行 'pm2 startup' 注册开机自启（部署工作流已包含 pm2 save）"
fi

mkdir -p "$DEPLOY_PATH"
chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$DEPLOY_PATH"
chmod 755 "$DEPLOY_PATH"
log "部署目录 ${DEPLOY_PATH} 已就绪，属主 ${DEPLOY_USER}"

echo ""
echo -e "${C_GREEN}========== 环境准备完成 ==========${C_RESET}"
echo "Node.js : $(node -v 2>/dev/null || echo '未安装')"
echo "MySQL   : $(mysql -V 2>/dev/null | head -1 || echo '未安装')"
echo "PM2     : $(pm2 -v 2>/dev/null || echo '未安装')"
echo "数据库  : ${DB_USER}@${MYSQL_HOST}:${MYSQL_PORT}/${DB_NAME}"
echo "密码备份: ${SECRET_FILE}（权限 600；含 root/应用账号口令与令牌）"
echo "口令长度（明文不回显）: MYSQL_ROOT_PASSWORD=$(mask_len "$MYSQL_ROOT_PASSWORD") MYSQL_PASSWORD=$(mask_len "$DB_PASSWORD") AUTH_SECRET=$(mask_len "$AUTH_SECRET") ADMIN_PASSWORD=$(mask_len "$ADMIN_PASSWORD")"

cat <<EOF

================================================================
请把下面这些值填到 GitHub 仓库 Settings → Secrets and variables → Actions
（GoldenKey 只有正式环境，全部填仓库级 Secrets 即可）
================================================================
口令/令牌不在此处回显明文，仅显示长度；明文统一保存在 ${SECRET_FILE}（权限 600）。
查看方式：sudo grep '^键名=' ${SECRET_FILE}  或  sudo cat ${SECRET_FILE}

【需自行填写（脚本无法生成）】
ECS_HOST       = 服务器公网 IP
ECS_USER       = SSH 用户名（须与部署目录属主 ${DEPLOY_USER} 一致）
ECS_PORT       = SSH 端口，留空走默认 22
ECS_SSH_KEY    = SSH 私钥全文（-----BEGIN OPENSSH PRIVATE KEY----- ...）
WX_APPID       = 小程序 AppID（不填则微信一键登录不可用）
WX_SECRET      = 小程序 AppSecret（同上）

【脚本已生成，按长度核对后填入】
MYSQL_HOST     = ${MYSQL_HOST}
MYSQL_PORT     = ${MYSQL_PORT}
MYSQL_DATABASE = ${DB_NAME}
MYSQL_USER     = ${DB_USER}
MYSQL_PASSWORD = $(mask_len "$DB_PASSWORD")   # 明文键 MYSQL_PASSWORD
AUTH_SECRET    = $(mask_len "$AUTH_SECRET")   # 明文键 AUTH_SECRET
ADMIN_USERNAME = ${ADMIN_USERNAME}
ADMIN_PASSWORD = $(mask_len "$ADMIN_PASSWORD")  # 明文键 ADMIN_PASSWORD

================================================================
校验命令（部署后）：
  curl https://你的域名/goldenkey/api/health
  pm2 list                       # 应看到 goldenkey-server 进程
  mysql -u${DB_USER} -p -e 'SHOW TABLES' ${DB_NAME}
================================================================
EOF
