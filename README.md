# whatsapp-bridge

> גשר בין WhatsApp ל-[myBrain](https://github.com/hiyabh/myBrain). מחבר את הבוט האישי לוואטסאפ כ-linked device — תומך בטקסט, תמונות והקלטות קוליות.

---

## איך זה עובד

הברידג' רץ כ-linked device על המספר שלך. הוא מקשיב להודעות בצ'אט "הודעה לעצמי" (Message Yourself בלבד), מעביר אותן ל-myBrain API, ושולח את התשובה חזרה.

```
וואטסאפ → "Message Yourself"
        |
        v
whatsapp-bridge (Node.js + Baileys)
        |
        | POST /whatsapp/incoming
        | { phone, text?, media_type?, media_data? }
        v
myBrain API (FastAPI :8080)
        |
        v
Claude + Skills (זיכרון / יומן / חיפוש / Vision / Whisper)
        |
        v
תשובה חזרה לוואטסאפ
```

---

## סוגי הודעות נתמכים

| סוג | מה קורה |
|-----|---------|
| 💬 טקסט | מועבר ישירות ל-myBrain |
| 🖼️ תמונה | הורד → base64 → myBrain → GPT-4o Vision מחלץ טקסט |
| 🎙️ הקלטה קולית | הורד → base64 → myBrain → Whisper מתמלל |

---

## ארכיטקטורה פנימית

```
src/index.ts
  ├── restoreSessionFromAPI()   ← בהפעלה: משחזר session files מה-DB
  ├── connectWhatsApp()         ← Baileys connection + event handlers
  │     ├── messages.upsert     ← מסנן self-chat, מוריד מדיה, מעביר ל-API
  │     └── creds.update        ← שומר + מגבה ל-DB
  ├── backupSessionToAPI()      ← מגבה auth_store/ ל-myBrain DB
  ├── queueMessage()            ← anti-ban: delay 3-5s בין הודעות
  └── Express :PORT             ← GET /health, POST /send
```

---

## מבנה הקבצים

```
whatsapp-bridge/
├── src/
│   └── index.ts          ← לוגיקה ראשית
├── auth_store/            ← session credentials (נשמרים ב-git + DB)
│   ├── creds.json
│   ├── app-state-sync-key-*.json
│   ├── pre-key-*.json
│   └── session-*.json
├── nixpacks.toml          ← הגדרות Railway build
├── package.json
└── tsconfig.json
```

---

## משתני סביבה

| משתנה | תיאור | דוגמה |
|-------|-------|-------|
| `MYBRAIN_URL` | URL של myBrain API | `http://mybrain.railway.internal:8080` |
| `BRIDGE_SECRET` | סיסמה משותפת לאבטחה | מחרוזת רנדומלית |
| `MY_PHONE` | מספר הטלפון שלך (ספרות בלבד) | `972501234567` |
| `PORT` | פורט Express (אוטומטי ב-Railway) | `3000` |

---

## התקנה מאפס

### שלב 1 — הכן את myBrain

וודא ש-myBrain רץ ב-Railway עם `BRIDGE_SECRET` ו-`WHATSAPP_USER_ID` מוגדרים.

### שלב 2 — Deploy את הברידג' ל-Railway

1. Fork/clone את הריפו הזה
2. Railway → New Project → Deploy from GitHub → בחר `whatsapp-bridge`
3. הוסף משתני סביבה: `MYBRAIN_URL`, `BRIDGE_SECRET`, `MY_PHONE`
4. Railway יבנה ויריץ אוטומטית

### שלב 3 — QR Scan (פעם אחת בלבד)

```bash
# שכפל מקומית
git clone https://github.com/hiyabh/whatsapp-bridge
cd whatsapp-bridge
npm install
npm run build
node dist/index.js
```

תראה בטרמינל:
```
[AUTH] Fetching session backup from DB...
[AUTH] No session backup found, will show QR code

[QR CODE] Scan with WhatsApp:
█████████████████
...
[QR CODE] Waiting for scan...
```

בוואטסאפ בפלאפון: **Settings → Linked Devices → Link a Device** → סרוק את ה-QR.

אחרי חיבור תראה:
```
[CONNECTED] WhatsApp bridge is ready!
[AUTH] Backed up 200+ session files to DB ✅
```

עצור עם `Ctrl+C`. זהו — לא תצטרך לסרוק שוב!

### שלב 4 — דחוף auth_store ל-git (backup נוסף)

```bash
git add auth_store/
git commit -m "add WhatsApp session files"
git push
```

---

## Session Persistence — איך זה עובד

בעיה: Railway filesystem הוא ephemeral — session files נמחקים בכל deploy.

פתרון: **שמירה כפולה** — git + PostgreSQL.

```
QR Scan מקומי
      │
      ├─→ auth_store/ (קבצים מקומיים)
      │        │
      │        ├─→ git push → Railway מקבל קבצים ראשוניים
      │        │
      │        └─→ POST /whatsapp/session-backup → DB (200+ קבצים)
      │
Railway Deploy
      │
      ├─→ Git: auth_store/ (קבצים ראשוניים)
      │
      └─→ restoreSessionFromAPI() → DB מחליף קבצי git
                │
                └─→ [CONNECTED] ← אין Bad MAC errors!
```

**בכל `creds.update`** (שינוי session): קבצים נשמרים ומגובים ל-DB אוטומטית.
**כל 5 דקות**: backup נוסף כ-safety net.

---

## API Endpoints

| Method | Path | תיאור |
|--------|------|-------|
| `GET` | `/health` | סטטוס: `{ connected: true/false }` |
| `POST` | `/send` | שליחת הודעה יזומה (דורש `X-Bridge-Secret`) |

---

## פתרון בעיות

### Bad MAC errors אחרי deploy
**תסמין:** `Session error: Bad MAC` בלוגים, הבוט לא מגיב.
**סיבה:** session files ישנים ב-git לא תואמים למה שהיה בריצה הקודמת.
**פתרון:** המתן 2-3 דקות — הברידג' משחזר מה-DB ומרנגש sessions עם WhatsApp.
**אם נמשך מעל 10 דקות:** בצע QR scan מחדש (ראה למטה).

### QR Scan מחדש (אם הוצרך)
```bash
# הסר את ה-linked device מהפלאפון:
# WhatsApp → Settings → Linked Devices → [long press] → Remove

# מקומית:
rmdir /s /q auth_store   # Windows
rm -rf auth_store        # Mac/Linux
node dist/index.js       # סרוק QR
# אחרי Backed up → Ctrl+C
git add auth_store/ && git commit -m "refresh session" && git push
```

### הברידג' מגיב להודעות לאנשים אחרים
→ וודא שמשתנה `MY_PHONE` מוגדר ב-Railway.

### `[API ERROR] 500`
→ בדוק logs ב-Railway → myBrain → שגיאת Python.
→ וודא שה-`BRIDGE_SECRET` זהה בשני השירותים.
→ וודא ש-`MYBRAIN_URL` הוא **internal** URL (לא public).

### הורדת מדיה תקועה
→ הוגדר timeout של 30 שניות — אם פג, הבוט שולח תשובה ללא המדיה.

---

## טכנולוגיות

- **[@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys)** — WhatsApp Web protocol (Signal)
- **Express** — HTTP server לתקשורת עם myBrain
- **TypeScript** — שפת התכנות
- **Railway** — hosting עם ephemeral filesystem

---

## הגדרות אנטי-בן

| הגדרה | ערך |
|-------|-----|
| Delay בין הודעות | 3-5 שניות (עם jitter ±30%) |
| Self-chat בלבד | `MY_PHONE !== chatPhone → skip` |
| Deduplication | Set של message IDs האחרונים |
| Bot loop prevention | Set של IDs שהבוט שלח |
