# FEATURE_MAP.md: แผนที่หน้าจอของ notes-site (เผยแพร่โน้ตที่เลือกขึ้นเว็บ)

กติกา: ทุกครั้งที่เพิ่มหรือแก้หน้าจอหรือทางเข้า ต้องอัปเดตไฟล์นี้ (แกนกลาง `.claude/rules/klui-core.md` หัวข้อ 8) ระบุทางเข้าด้วยสิ่งที่ผู้ใช้เห็น ข้อที่ยังไม่ได้เปิดของจริงดูติด [ยังไม่ยืนยัน]
ฉบับแรก 2026-11-02 เขียนจาก README และรายชื่อไฟล์ ยังไม่ได้เปิดของจริง

คัดโน้ตจาก vault Obsidian ที่ติดป้าย publish ขึ้น GitHub Pages ด้วย Quartz

| ฟีเจอร์ | ไฟล์หลัก | ทางเข้า | ตรรกะหรือข้อมูลที่เกี่ยว |
|---|---|---|---|
| เว็บ | https://klui2543.github.io/notes-site/ สร้างจาก `content/` (generated ห้ามแก้มือ) | เปิดเว็บ | `quartz.config.yaml` |
| ตัวคัดโน้ต | `scripts/sync.mjs`, `scripts/fetch-vault.mjs`, `scripts/tag-publish.mjs` | รันในเครื่องที่ mount vault หรือผ่าน workflow `sync.yml` |  |
| ภาพวาด Excalidraw และ Canvas | `scripts/render-drawings.mjs`, `scripts/lib/excalidraw.mjs`, `drawings-src/` | ผ่าน workflow `deploy.yml` |  |

วิธีตรวจ: `node scripts/sync.mjs` แล้วอ่านรายงาน (ไฟล์ที่เผยแพร่ ถูกกัน และลิงก์ที่ตัด) ก่อน push และ `npx quartz build --serve` ดูก่อน
กติกาที่สำคัญที่สุดอยู่ CLAUDE.md ของ repo: โน้ตขึ้นเว็บได้ต่อเมื่อบอกเอง
