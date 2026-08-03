#!/bin/bash
# Stop hook: เตือนว่ามีงานที่ยังไม่ได้ส่งขึ้น Notion Session Log
#
# ทำไมต้องมี: Notion เป็นกระดานกลางที่ Claude chat (เลขา AI) อ่านเป็นสถานะโปรเจกต์
#   ถ้าไม่ส่งขึ้นไป ฝั่งแชทจะเข้าใจว่างานหยุดอยู่ที่วันสุดท้ายที่มีแถว (เคยค้าง 9 วันมาแล้ว)
#   Klui สั่งไว้ 2026-08-04: "ถ้าผมลืมก็แจ้งด้วย"
#
# ตัวส่งจริงคือ skill /notion-sync (Claude คุย Notion ผ่าน connector — ไม่ใช้ token)
# hook ตัวนี้ทำหน้าที่ "เคาะเตือน" อย่างเดียว ไม่ยุ่งกับ Notion เอง
#
# ⚠️ แยกไฟล์จาก clasp-autopush.sh โดยตั้งใจ — ถ้าตัวนี้พัง auto push ขึ้น GAS ต้องไม่กระทบ
#    จบด้วย exit 0 ทุกทางเสมอ
#
# หมายเหตุ: ไฟล์ .last-notion-sync เป็นแค่ตัวช่วยของ "ตัวเตือน" เท่านั้น
#   ที่คั่นหน้าตัวจริงคือแถว 💻 ล่าสุดใน Notion ซึ่ง skill จะไปอ่านเอง
#   → ไฟล์นี้ต่างกันในแต่ละเครื่องได้ ไม่ทำให้ข้อมูลซ้ำ/ขาด
set -uo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$PROJECT_DIR" 2>/dev/null || exit 0
command -v git >/dev/null 2>&1 || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

THROTTLE=2700   # วินาที = 45 นาที (ยาวกว่าตัวเตือน hygiene เพราะงานนี้ไม่เร่ง)
STAMP=".claude/.last-notion-reminder"
MARKER=".claude/.last-notion-sync"

NOW="$(date +%s 2>/dev/null || echo 0)"
LAST="$(cat "$STAMP" 2>/dev/null || echo 0)"
if [ "$NOW" -ne 0 ] && [ "$LAST" -ne 0 ] && [ $((NOW - LAST)) -lt "$THROTTLE" ]; then
  exit 0   # เพิ่งเตือนไป ยังไม่ถึงรอบใหม่
fi

SINCE="$(cat "$MARKER" 2>/dev/null || echo '')"

# กันกรณี hash ในไฟล์ใช้ไม่ได้แล้ว (rebase / clone ใหม่ / กิ่งถูกลบ)
if [ -n "$SINCE" ] && ! git cat-file -e "${SINCE}^{commit}" 2>/dev/null; then
  SINCE=""
fi

# ไม่มี marker / ว่าง / hash ใช้ไม่ได้ → บอกให้ตั้งจุดเริ่ม
# (ห้ามเงียบ ไม่งั้นตัวเตือนตายไปเฉยๆ โดยไม่มีใครรู้)
if [ -z "$SINCE" ]; then
  mkdir -p .claude
  [ "$NOW" -ne 0 ] && printf '%s' "$NOW" > "$STAMP"
  echo "📮 ยังไม่รู้ว่าซิงค์ Notion ถึงไหน — พิมพ์ \`/notion-sync\` สักครั้งเพื่อตั้งจุดเริ่ม"
  exit 0
fi

# นับเฉพาะ commit ที่เป็นงานจริง — chore(stamp) เป็นของ Stop hook ปั๊มเอง ไม่ใช่งาน
COUNT="$(git rev-list --count --invert-grep --grep='^chore(stamp)' "${SINCE}..HEAD" 2>/dev/null || echo 0)"
FIRST_DATE="$(git log --reverse --date=short --format='%ad' --invert-grep --grep='^chore(stamp)' "${SINCE}..HEAD" 2>/dev/null | head -1)"

[ "${COUNT:-0}" -ge 1 ] || exit 0

mkdir -p .claude
[ "$NOW" -ne 0 ] && printf '%s' "$NOW" > "$STAMP"

echo "📮 มี ${COUNT} commit ที่ยังไม่ขึ้น Notion${FIRST_DATE:+ (ตั้งแต่ ${FIRST_DATE})} — ถ้าจะจบเซสชันแล้ว พิมพ์ \`/notion-sync\` เพื่อให้ Claude chat เห็นงานล่าสุดด้วย"
exit 0
