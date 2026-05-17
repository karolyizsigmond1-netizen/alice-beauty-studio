# Deploy Guide — Alice Beauty Booking Backend

This is the full deploy procedure. **First time: do it under your own Google account (the demo).** Later, when handing off to Alice, repeat the same steps under hers.

---

## Time required: ~10 minutes

You'll end up with:
- A Google Sheet that auto-tracks slots and bookings
- A web URL that the booking widget on the website talks to
- A separate admin URL Alice (or you) bookmarks on her phone

---

## Step 1 — Create the Apps Script project (2 min)

1. Open **https://script.google.com/** and sign in with the Google account that will own the bookings.
2. Click **"New project"** (top-left).
3. The script editor opens with a default `Code.gs` containing `function myFunction() { … }`. Select all that boilerplate and delete it.
4. Open `apps-script/Code.gs` from this repo. Copy the entire file contents. Paste into the script editor where you just deleted the default code.
5. In the left sidebar of the script editor, click the **`+`** next to "Files" → **HTML** → name it exactly `Admin` (no extension). Delete the default content of that new `Admin.html` file. Open `apps-script/Admin.html` from this repo, copy everything, paste into the editor.
6. Top-left, click the project name ("Untitled project") and rename it to **"Alice Beauty Booking"** or similar. Save with **Ctrl/Cmd + S**.

---

## Step 2 — Run `setup` to create the sheet (1 min)

1. In the editor, top bar: pick the function **`setup`** from the dropdown next to the Run/Debug buttons.
2. Click **▶ Run**.
3. Google asks for permission ("This app isn't verified by Google"):
   - Click **Review permissions**
   - Pick your Google account
   - Click **Advanced** (small link at the bottom of the warning) → **Go to Alice Beauty Booking (unsafe)** — this is normal for your own scripts; the only thing it does is access *your own* sheets and Gmail.
   - Click **Allow**.
4. The Execution log at the bottom should show `OK · sheet ready · https://docs.google.com/spreadsheets/...` — that's the auto-created Google Sheet.

---

## Step 3 — Deploy as Web App (3 min)

1. Top-right, click **Deploy** → **New deployment**.
2. Click the gear icon ⚙ next to "Select type" → choose **Web app**.
3. Fill in:
   - **Description:** `Alice Beauty Booking v1` (any text)
   - **Execute as:** **Me (your-email@gmail.com)**  ← critical, sends emails through your Gmail
   - **Who has access:** **Anyone**  ← critical, so visitors of the public site can book
4. Click **Deploy**.
5. Copy the **Web app URL** — looks like:
   ```
   https://script.google.com/macros/s/AKfycbxxxxxxxxxxxxxxx/exec
   ```

> **If you ever change the code:** re-run **Deploy → Manage deployments → ✎ edit → Version: New version → Deploy.** The URL stays the same.

---

## Step 4 — Wire the URL into the website (30 sec)

1. Open `index.html` in this repo.
2. Find `window.BK_CONFIG = window.BK_CONFIG || { backendUrl: '' };` near the booking modal `<script>` block.
3. Paste the URL between the quotes:
   ```js
   window.BK_CONFIG = window.BK_CONFIG || {
     backendUrl: 'https://script.google.com/macros/s/AKfycbxxxxxxx/exec'
   };
   ```
4. Save → commit → push. GitHub Pages will redeploy.

---

## Step 5 — Open the admin page (10 sec)

The admin URL is your deploy URL + `?admin`:
```
https://script.google.com/macros/s/AKfycbxxxxxxx/exec?admin
```

1. Open it on your phone or laptop.
2. Default password is `alice2026` (set in `CONFIG.adminPassword` at the top of `Code.gs`). Change it before sharing with Alice.
3. On phone: tap browser menu → "Add to Home Screen" — it becomes an icon like an app.

---

## Step 6 — Test end-to-end (2 min)

1. **Admin:** open the admin URL → tap any future weekday → click **"+ Hét napjai (9–17)"** preset → 9 slots appear. Refresh.
2. **Booking widget:** open the public site → click "Foglalás" → pick a service → pick the day you just populated → pick a time → fill in the form (use your own email) → confirm.
3. Check your Gmail — you should have **two emails**: one as the client ("Köszönöm a foglalást"), one as the owner ("Új foglalás").
4. Refresh the admin page — the booking shows up in the **Foglalások** tab; the slot is gone from **Időpontok**.

---

## Step 7 — Hand-off to Alice (when ready)

When you're ready to give her the live version:

1. Repeat Steps 1-3 under **her** Google account (you screen-share, she taps "Allow" on the OAuth prompt — that's the one step she has to do herself).
2. In `Code.gs` change `businessEmail` from `karolyi.zsigmond1@gmail.com` to her address.
3. Change `adminPassword` to a fresh value, share it with her.
4. Paste her new deploy URL into the snippet on her website.
5. Send her: admin URL + password + 90-second video showing how to add slots.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Widget says "Foglalási hiba" with no detail | Open browser devtools → Network → check the POST response. Most common: deploy "Who has access" is set to "Only myself" — re-deploy with "Anyone". |
| Calendar shows all days struck through | No slots exist yet. Open admin and add some. |
| No email arrived | Check Apps Script → Executions tab → look for the run, check logs. Usually MailApp quota (100 emails/day for free Google accounts) or a typo in `businessEmail`. |
| Admin says "Hibás jelszó" | Password lives in `CONFIG.adminPassword` at the top of `Code.gs`. Edit, save, redeploy. |
| Code edit didn't take effect | You forgot to redeploy. Deploy → Manage deployments → edit → New version → Deploy. |

---

## Architecture in one diagram

```
  ┌────────────────────────────────┐
  │ Customer's browser             │
  │ (the public website)           │
  └──────────┬─────────────────────┘
             │ fetch JSON
             ▼
  ┌────────────────────────────────┐         ┌──────────────────┐
  │ Apps Script Web App (Code.gs)  │ ◀──────│ Admin page (HTML)│
  │ - doGet / doPost API           │ google. │ (same script,    │
  │ - reads/writes sheet           │ script. │  ?admin URL)     │
  │ - sends mail via her Gmail     │ run     │                  │
  └──────────┬──────────┬──────────┘         └──────────────────┘
             │          │
             ▼          ▼
   ┌──────────────┐  ┌──────────────┐
   │ Google Sheet │  │ Gmail        │
   │ (her drive)  │  │ (her inbox)  │
   └──────────────┘  └──────────────┘
```

No servers. No monthly fees. Everything runs under her Google account.
