# העלאה לאינטרנט

המערכת היא אפליקציית Node.js שמגישה גם את האתר וגם את ה-API. לכן צריך אחסון שתומך בהרצת Node.js, לא אחסון סטטי בלבד.

## פרטי כניסה לאתר

ברירת מחדל:

- שם משתמש: `ECC`
- סיסמה: `180056700`

בשרת אינטרנט מומלץ להגדיר את הפרטים כמשתני סביבה:

```powershell
APP_USERNAME=ECC
APP_PASSWORD=180056700
```

אפשר לשנות אותם בכל רגע בלי לערוך קוד.

## הפעלה מקומית

```powershell
npm install
npm run build
npm start
```

ברירת המחדל נפתחת ב:

```text
http://localhost:4177
```

## אפשרות 1: שרת Windows או VPS

1. מתקינים Node.js.
2. מעלים את כל תיקיית הפרויקט לשרת.
3. מריצים:

```powershell
npm install
npm run build
$env:PORT="80"
$env:APP_USERNAME="ECC"
$env:APP_PASSWORD="180056700"
npm start
```

4. מחברים את הדומיין ל-IP של השרת.
5. מומלץ לשים Cloudflare או Reverse Proxy עם HTTPS לפני האפליקציה.

## אפשרות 2: שירות ענן שתומך Node.js

שירותים מתאימים: Render, Railway, Fly.io, VPS מנוהל, או כל אחסון Node.js.

הגדרות כלליות:

- Build command: `npm install && npm run build`
- Start command: `npm start`
- Environment variables:
  - `APP_USERNAME=ECC`
  - `APP_PASSWORD=180056700`
  - `CRG_PASSWORD` אם רוצים לשמור את סיסמת CRG מחוץ לקובץ ההגדרות
  - `PORT` לפי מה שהשירות מספק, אם נדרש

## הערות חשובות

- קובץ `data/supplier-config.json` מכיל פרטי ספקים וסיסמאות ולכן הוא לא מיועד ל-Git ציבורי.
- עבור שימוש ציבורי אמיתי מומלץ להפעיל HTTPS.
- הספקים CMS ו-CRG קיימים במסך ההגדרות, אבל צריך להזין להם פרטי כניסה וכתובות קטגוריה לפני חיבור סקרייפר ייעודי.
