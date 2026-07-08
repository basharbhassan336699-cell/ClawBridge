#!/data/data/com.termux/files/usr/bin/bash
# ══════════════════════════════════════════════════════════════════
#  CoBWeaverClaw — Claude Code + Web Bridge Installer
#  يثبّت Claude Code ثم يشغّل واجهة الويب تلقائياً
# ══════════════════════════════════════════════════════════════════

set -euo pipefail

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { printf "${CYAN}[info]${NC}  %s\n" "$1"; }
ok()    { printf "${GREEN}[✓]${NC}    %s\n" "$1"; }
warn()  { printf "${YELLOW}[!]${NC}    %s\n" "$1"; }
fail()  { printf "${RED}[✗]${NC}    %s\n" "$1" >&2; exit 1; }

CBW_DIR="$HOME/.cobweaverclaw"
CBW_SERVER="$CBW_DIR/cbw-server.js"
CBW_UI="$CBW_DIR/claude-code-ui.html"
CBW_ENV="$CBW_DIR/.env"
CBW_PORT="${CBW_PORT:-7979}"

mkdir -p "$CBW_DIR"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║     CoBWeaverClaw — Claude Code Web Bridge           ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Step 1: تحقق من Termux ────────────────────────────────────────
[ -z "${PREFIX:-}" ] && fail "شغّل هذا السكريبت داخل Termux"
[ "$(uname -m)" = "aarch64" ] || fail "يتطلب جهاز aarch64 (ARM64)"

# ── Step 2: تحديث الحزم الأساسية ─────────────────────────────────
info "تحديث الحزم..."
pkg update -y -q 2>/dev/null || true
pkg install -y -q nodejs curl git 2>/dev/null || fail "فشل تثبيت المتطلبات"
ok "المتطلبات الأساسية جاهزة"

# ── Step 3: تثبيت Claude Code ─────────────────────────────────────
if command -v claude >/dev/null 2>&1; then
  ok "Claude Code موجود بالفعل: $(claude --version 2>&1 | head -1)"
else
  info "تثبيت Claude Code على Termux..."
  info "جاري تنزيل سكريبت التثبيت..."

  INSTALL_SCRIPT="$CBW_DIR/claude-install.sh"

  curl -fsSL \
    "https://raw.githubusercontent.com/ferrumclaudepilgrim/claude-code-android/main/install.sh" \
    -o "$INSTALL_SCRIPT" 2>/dev/null \
    || fail "فشل تنزيل سكريبت التثبيت — تحقق من الاتصال"

  chmod +x "$INSTALL_SCRIPT"
  info "بدء تثبيت Claude Code (5-10 دقائق)..."
  bash "$INSTALL_SCRIPT" || fail "فشل تثبيت Claude Code"

  # Reload PATH
  export PATH="$PATH:$HOME/.local/bin"
  hash -r 2>/dev/null || true

  command -v claude >/dev/null 2>&1 || fail "التثبيت انتهى لكن claude غير موجود في PATH"
  ok "Claude Code جاهز: $(claude --version 2>&1 | head -1)"
fi

# ── Step 4: نسخ ملفات البريدج ─────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# cbw-server.js
if [ -f "$SCRIPT_DIR/cbw-server.js" ]; then
  cp "$SCRIPT_DIR/cbw-server.js" "$CBW_SERVER"
  ok "cbw-server.js نُسخ"
elif [ ! -f "$CBW_SERVER" ]; then
  fail "cbw-server.js غير موجود. ضعه في نفس مجلد هذا السكريبت"
fi

# claude-code-ui.html
if [ -f "$SCRIPT_DIR/claude-code-ui.html" ]; then
  cp "$SCRIPT_DIR/claude-code-ui.html" "$CBW_UI"
  ok "claude-code-ui.html نُسخ"
elif [ ! -f "$CBW_UI" ]; then
  fail "claude-code-ui.html غير موجود. ضعه في نفس مجلد هذا السكريبت"
fi

# ── Step 5: إنشاء أمر التشغيل ─────────────────────────────────────
LAUNCHER="$PREFIX/bin/cbw"
cat > "$LAUNCHER" << LAUNCHER_EOF
#!/data/data/com.termux/files/usr/bin/bash
# CoBWeaverClaw Web Bridge Launcher
export PATH="\$PATH:\$HOME/.local/bin"
export CBW_PORT="\${CBW_PORT:-7979}"
cd "$CBW_DIR"
exec node "$CBW_SERVER" "\$@"
LAUNCHER_EOF
chmod +x "$LAUNCHER"
ok "أمر التشغيل: cbw"

# ── Step 6: تشغيل السيرفر مباشرة ─────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
ok "التثبيت اكتمل!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  لتشغيل الواجهة في أي وقت:"
echo "  $ cbw"
echo ""
echo "═══════════════════════════════════════════════════════"
echo ""

# ── تشغيل فوري ────────────────────────────────────────────────────
read -r -p "هل تريد تشغيل الواجهة الآن؟ [Y/n] " LAUNCH
case "${LAUNCH,,}" in
  n|no) echo "شغّلها لاحقاً بـ: cbw" ;;
  *)
    export PATH="$PATH:$HOME/.local/bin"
    export CBW_PORT="$CBW_PORT"
    cd "$CBW_DIR"
    exec node "$CBW_SERVER"
    ;;
esac
