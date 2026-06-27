# Paisa — Android app with UPI / card auto-detection

This turns the Paisa PWA into a real **native Android app** (via Capacitor) that
can **read your bank / UPI / credit-card transaction SMS on the device and
auto-log them as expenses** — you just tap to confirm the category.

> The web version (GitHub Pages / Netlify) keeps working as before. SMS
> auto-detection only runs in the installed Android app, because browsers
> aren't allowed to read SMS.

---

## How it works

| Piece | File |
|-------|------|
| Native SMS reader plugin | `android/app/src/main/java/com/paisa/app/SmsReaderPlugin.java` |
| Plugin registration | `android/app/src/main/java/com/paisa/app/MainActivity.java` |
| SMS permissions | `android/app/src/main/AndroidManifest.xml` (`READ_SMS`, `RECEIVE_SMS`) |
| Parser + categorizer + review UI | `paisa-auto.js` |
| App wiring | `<script src="paisa-auto.js">` in `index.html` |

Flow:

1. On launch (and each time you reopen it) the app scans recent SMS.
2. While open, new payment SMS are caught live.
3. Each message is parsed into `{ amount, merchant, account, category }`.
   Non-spends (OTPs, credits/salary, balance checks, future EMIs) are ignored.
4. A **"✨ N payments detected"** pill appears. Tap it to review, adjust the
   category, and **Add** — it becomes a normal Paisa expense
   (same `TX` / balance logic as a manual entry).

**Privacy:** SMS are read and parsed entirely on your phone. Nothing is
uploaded — there is no server. Data stays in the app's local storage, exactly
like the manual tracker.

---

## Get the APK (no Android Studio needed)

A GitHub Actions workflow builds the installable APK in the cloud.

1. Push to the `claude/app-development-angjyf` branch (already done), **or** go
   to the repo's **Actions** tab → **Build Android APK** → **Run workflow**.
2. Wait for the green check (~3–5 min).
3. Open the finished run → **Artifacts** → download **`paisa-debug-apk`**.
4. Unzip → email/transfer `app-debug.apk` to your phone.
5. Tap it → allow **"Install from unknown sources"** → **Install**.
6. Open Paisa → when it asks, **Allow** the SMS permission.

> It's a *debug* APK — perfect for personal use. It can't go on the Play Store
> (Google restricts SMS permission), which is expected for this kind of app.

### Build locally instead (optional)

Needs Node + Android Studio / Android SDK:

```bash
npm install
npm run sync                 # copy web files into www/ and into the android project
cd android && ./gradlew assembleDebug
# APK at android/app/build/outputs/apk/debug/app-debug.apk
```

---

## Editing the app

The web files at the repo root are the source of truth. After changing
`index.html` / `paisa-auto.js` etc., run `npm run sync` to copy them into the
Android project before rebuilding. (CI does this automatically.)

---

## Known limitations

- **Live capture works while the app is open**; anything that arrives while it's
  closed is picked up by the inbox scan next time you open it.
- Parsing covers common Indian bank / UPI / card SMS formats. Unusual wordings
  may be missed — you can still add those manually (there's a **Paste SMS** box
  in the detected-payments sheet), and the parser rules in `paisa-auto.js`
  (`CAT_RULES`, `parseMerchant`, etc.) are easy to extend.
- Only transactions your bank actually sends an SMS for can be detected.
