#!/data/data/com.termux/files/usr/bin/bash
# ══════════════════════════════════════════════════════════════════
#  ClawBridge — Claude Code + Web Bridge Installer
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

CBW_DIR="$HOME/.clawbridge"
CBW_SERVER="$CBW_DIR/server.js"
CBW_UI="$CBW_DIR/index.html"
CBW_ENV="$CBW_DIR/.env"
CBW_PORT="${CBW_PORT:-7979}"

# مصدر الملفات عند التثبيت السريع (curl | bash)
RAW_BASE="${CLAWBRIDGE_RAW_BASE:-https://raw.githubusercontent.com/basharbhassan336699-cell/ClawBridge/main}"

mkdir -p "$CBW_DIR"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║            ClawBridge — Claude Code Web Bridge        ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Step 1: تحقق من Termux ────────────────────────────────────────
[ -z "${PREFIX:-}" ] && fail "شغّل هذا السكريبت داخل Termux"
[ "$(uname -m)" = "aarch64" ] || fail "يتطلب جهاز aarch64 (ARM64)"

# ── Step 2: تحديث الحزم الأساسية ─────────────────────────────────
info "تحديث الحزم..."
pkg update -y -q 2>/dev/null || true
pkg install -y -q nodejs curl git wget aria2 2>/dev/null || fail "فشل تثبيت المتطلبات"
ok "المتطلبات الأساسية جاهزة"

# ── Step 3: تثبيت Claude Code ─────────────────────────────────────
if command -v claude >/dev/null 2>&1; then
  ok "Claude Code موجود بالفعل: $(claude --version 2>&1 | head -1)"
else
  info "تثبيت Claude Code على Termux..."
  info "جاري تنزيل سكريبت التثبيت..."

  INSTALL_SCRIPT="$CBW_DIR/claude-install.sh"
  INSTALL_URL="https://raw.githubusercontent.com/ferrumclaudepilgrim/claude-code-android/main/install.sh"

  # تنزيل باستئناف تلقائي (wget -c) مع إعادة محاولة حتى 10 مرات،
  # لإكمال التنزيل عند انقطاع الاتصال بدل البدء من الصفر.
  dl_ok=0
  for attempt in $(seq 1 10); do
    if wget -c -q -O "$INSTALL_SCRIPT" "$INSTALL_URL"; then
      dl_ok=1
      break
    fi
    warn "فشلت محاولة التنزيل $attempt/10 — إعادة المحاولة..."
    sleep $(( attempt < 6 ? attempt * 2 : 12 ))
  done
  [ "$dl_ok" = 1 ] || fail "فشل تنزيل سكريبت التثبيت بعد 10 محاولات — تحقق من الاتصال"

  # ── حلّ جذري لتنزيل الملف الكبير (233MB) ───────────────────────────
  # السكربت الأصلي:
  #   • ينزّل الثنائي بأمر curl واحد بلا استئناف (--max-time 300) → يفشل
  #     كلياً عند أي انقطاع.
  #   • يجلب الـ manifest بـ --max-time 10 (مهلة قصيرة) → يفشل بـ
  #     "could not read checksum" على اتصال غير مستقر.
  # نرقّعه ليستخدم aria2c (تنزيل مجزّأ 16 وصلة + شريط تقدّم % + استئناف)،
  # ونطيل مهل جلب الـ manifest/الإصدار مع إعادة محاولة. تحقّق الـ
  # checksum الأصلي يبقى كما هو ويضمن سلامة الملف النهائي.
  if node -e '
    const fs = require("fs"), f = process.argv[1];
    let s = fs.readFileSync(f, "utf8");
    const marker = `curl -fsSL --max-time 300 "$DL_BASE/linux-arm64/claude" -o "$BINARY.tmp"`;
    if (!s.includes(marker)) process.exit(3);
    const helper = [
      "_cbw_dl_binary() {",
      "  local url=\"$1\" out=\"$2\" a dir base",
      "  dir=\"$(dirname \"$out\")\"; base=\"$(basename \"$out\")\"",
      "  if command -v aria2c >/dev/null 2>&1; then",
      "    aria2c -c -x 16 -s 16 -k 1M --file-allocation=none --max-tries=10 --retry-wait=5 --summary-interval=1 --console-log-level=warn -d \"$dir\" -o \"$base\" \"$url\" && return 0",
      "    return 1",
      "  fi",
      "  for a in 1 2 3 4 5 6 7 8 9 10; do",
      "    wget -c -q --show-progress --tries=1 --timeout=60 -O \"$out\" \"$url\" && return 0",
      "    printf \"[!] binary download attempt %s/10 failed, resuming...\\n\" \"$a\" >&2",
      "    sleep $(( a < 6 ? a * 3 : 15 ))",
      "  done",
      "  return 1",
      "}",
      ""
    ].join("\n");
    const call = `_cbw_dl_binary "$DL_BASE/linux-arm64/claude" "$BINARY.tmp"`;
    s = s.replace(marker, () => helper + call);
    // مهل أطول + إعادة محاولة لجلب الـ manifest والإصدار (كانت --max-time 10)
    s = s.split("--max-time 10 ").join("--retry 5 --retry-delay 3 --retry-all-errors --connect-timeout 30 --max-time 120 ");
    fs.writeFileSync(f, s);
  ' "$INSTALL_SCRIPT" 2>/dev/null; then
    ok "تم تفعيل التنزيل المجزّأ (aria2c) مع شريط تقدّم واستئناف تلقائي"
  else
    warn "تعذّر ترقيع سطر التنزيل (ربما تغيّر السكربت الأصلي) — سيُستخدم كما هو"
  fi

  chmod +x "$INSTALL_SCRIPT"
  info "بدء تثبيت Claude Code (5-10 دقائق)..."

  # سكربت تثبيت Claude Code تفاعلي (يطرح أسئلة y/n). عند التشغيل عبر
  # 'curl | bash' يكون stdin هو أنبوب السكربت لا الطرفية، فتلتهم أوامر
  # read أسطر هذا السكربت وتفشل. نوجّه إدخاله إلى الطرفية الحقيقية.
  if [ -r /dev/tty ]; then
    bash "$INSTALL_SCRIPT" < /dev/tty || fail "فشل تثبيت Claude Code"
  else
    warn "لا توجد طرفية تفاعلية (/dev/tty) — قد يفشل التثبيت التفاعلي."
    warn "إن فشل، استنسخ المستودع وشغّل: bash install.sh"
    bash "$INSTALL_SCRIPT" || fail "فشل تثبيت Claude Code"
  fi

  # Reload PATH
  export PATH="$PATH:$HOME/.local/bin"
  hash -r 2>/dev/null || true

  command -v claude >/dev/null 2>&1 || fail "التثبيت انتهى لكن claude غير موجود في PATH"
  ok "Claude Code جاهز: $(claude --version 2>&1 | head -1)"
fi

# ── Step 4: تجهيز ملفات البريدج ───────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ينزّل ملفاً من المستودع عند غيابه محلياً (حالة curl | bash)
fetch_file() {
  local name="$1" dest="$2"
  info "تنزيل $name من المستودع..."
  curl -fsSL "$RAW_BASE/$name" -o "$dest" \
    || fail "فشل تنزيل $name — تحقق من الاتصال"
}

# server.js
if [ -f "$SCRIPT_DIR/server.js" ]; then
  cp "$SCRIPT_DIR/server.js" "$CBW_SERVER"
  ok "server.js نُسخ"
else
  fetch_file "server.js" "$CBW_SERVER"
  ok "server.js جاهز"
fi

# index.html
if [ -f "$SCRIPT_DIR/index.html" ]; then
  cp "$SCRIPT_DIR/index.html" "$CBW_UI"
  ok "index.html نُسخ"
else
  fetch_file "index.html" "$CBW_UI"
  ok "index.html جاهز"
fi

# ── Step 5: إنشاء أمر التشغيل ─────────────────────────────────────
LAUNCHER="$PREFIX/bin/clawbridge"
cat > "$LAUNCHER" << LAUNCHER_EOF
#!/data/data/com.termux/files/usr/bin/bash
# ClawBridge Web Bridge Launcher
export PATH="\$PATH:\$HOME/.local/bin"
export CBW_PORT="\${CBW_PORT:-7979}"
cd "$CBW_DIR"
exec node "$CBW_SERVER" "\$@"
LAUNCHER_EOF
chmod +x "$LAUNCHER"
ok "أمر التشغيل: clawbridge"

# ── Step 6: تشغيل السيرفر مباشرة ─────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
ok "التثبيت اكتمل!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  لتشغيل الواجهة في أي وقت:"
echo "  $ clawbridge"
echo ""
echo "═══════════════════════════════════════════════════════"
echo ""

# ── تشغيل فوري (فقط إن كانت الجلسة تفاعلية) ───────────────────────
if [ -t 0 ]; then
  read -r -p "هل تريد تشغيل الواجهة الآن؟ [Y/n] " LAUNCH
  case "${LAUNCH,,}" in
    n|no) echo "شغّلها لاحقاً بـ: clawbridge" ;;
    *)
      export PATH="$PATH:$HOME/.local/bin"
      export CBW_PORT="$CBW_PORT"
      cd "$CBW_DIR"
      exec node "$CBW_SERVER"
      ;;
  esac
else
  echo "شغّلها بـ: clawbridge"
fi
