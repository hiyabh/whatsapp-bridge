# whatsapp-bridge

> גשר בין WhatsApp ל-myBrain. מחבר את הבוט האישי שלך לוואטסאפ כ-linked device.

---

## איך זה עובד

הברידג' רץ כ-linked device על המספר שלך. הוא מקשיב להודעות בצ'אט "הודעה לעצמי" (Message Yourself), מעביר אותן ל-myBrain API, ושולח את התשובה חזרה.

```
וואטסאפ (Message Yourself)
      |
      v
whatsapp-bridge (Baileys / Node.js)
      |  POST /whatsapp/incoming
      v
myBrain API (FastAPI :8080)
      |
      v
Claude + Skills (זיכרון, יומן, חיפוש)
      |
      v
תשובה חזרה לוואטסאפ
```

---

## מבנה הקבצים

```
whatsapp-bridge/
  src/
    index.ts         ← לוגיקה ראשית: Baileys + Express
    types.d.ts       ← type declarations
  auth_store/
    creds.json       ← session credentials (לא לשתף!)
    app-state-sync-key-*.json
  package.json
  tsconfig.json
  nixpacks.toml      ← הגדרות Railway build
  .gitignore
```

---

## משתני סביבה

| משתנה | תיאור | דוגמה |
|-------|-------|-------|
| `MYBRAIN_URL` | URL של myBrain API | `http://mybrain.railway.internal:8080` |
| `BRIDGE_SECRET` | סיסמה משותפת לאבטחה | מחרוזת רנדומלית |
| `MY_PHONE` | מספר הטלפון שלך | `972501234567` |
| `PORT` | פורט ה-Express (אוטומטי ב-Railway) | `3000` |

---

## חיבור ראשוני (QR scan)

1. **שכפל את הריפו:**
   ```bash
   git clone https://github.com/hiyabh/whatsapp-bridge
   cd whatsapp-bridge
   npm install
   ```

2. **הרץ מקומית:**
   ```bash
   npm run build && node dist/index.js
   ```

3. **סרוק QR** מהטרמינל דרך וואטסאפ → Settings → Linked Devices → Link a Device

4. **אחרי חיבור** - `auth_store/` נוצר. הוסף את הקבצים הנחוצים ל-git:
   ```bash
   git add auth_store/creds.json auth_store/app-state-sync-key-*
   git commit -m "add WhatsApp session"
   git push
   ```

5. Railway ידפלי עם ה-session - הברידג' יתחבר אוטומטית.

---

## הערות חשובות

**session persistence**: הברידג' מנקה קבצי session ישנים בכל הפעלה ומשחזר sessions חדשים עם שרתי WhatsApp. רק `creds.json` ו-`app-state-sync-key-*` נשמרים ב-git.

**self-chat only**: הברידג' מגיב **רק** להודעות בצ'אט "הודעה לעצמי" - לא מפריע להודעות לאנשים אחרים.

**anti-ban**: בין הודעות יש delay של 3-5 שניות עם jitter רנדומלי.

**אם ה-session פג**: מחק את ה-linked device מהטלפון (Settings → Linked Devices), מחק את `auth_store/creds.json` מ-git, ועשה QR scan מחדש.

---

## API endpoints

| Method | Path | תיאור |
|--------|------|-------|
| `GET` | `/health` | סטטוס הברידג' והחיבור |
| `POST` | `/send` | שליחת הודעה יזומה (עם `BRIDGE_SECRET`) |

---

## טכנולוגיות

- **[@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys)** - WhatsApp Web protocol
- **Express** - HTTP server
- **TypeScript** - שפת התכנות
- **Railway** - hosting
