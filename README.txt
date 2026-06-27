PAISA — how to turn this into an Android app
=============================================

This folder is a complete, self-contained app. It saves data to your
phone's own storage, so it runs fully offline once installed.

NOTE: Don't judge it by opening index.html inside the Claude app — saving
only works in a real browser / installed app. Test it in Chrome instead.

------------------------------------------------------------------
EASIEST — no APK, app icon on home screen (5 minutes)
------------------------------------------------------------------
1. Put this folder online for free (any one works):
   - Netlify Drop: app.netlify.com/drop  (just drag the folder in)
   - GitHub Pages, Vercel, or Cloudflare Pages
2. Open the resulting https:// link in Chrome on your phone.
3. Chrome menu (3 dots) -> "Add to Home screen" / "Install app".
   Done. Opens full-screen with its own icon, works offline.

------------------------------------------------------------------
REAL .APK FILE (free) — via PWABuilder
------------------------------------------------------------------
1. Host the folder online over https (same as step 1 above).
2. Go to pwabuilder.com, paste your link, click Start.
3. Android section -> "Generate Package".
4. You get a .apk (for installing/testing) and .aab (for Play Store).
5. Email the .apk to your phone, tap it, allow "install from unknown
   sources", install.

------------------------------------------------------------------
NO-HOSTING shortcut
------------------------------------------------------------------
Some "website to APK" services accept a direct file/zip upload
(e.g. Median.co, WebIntoApp). Upload index.html / this zip and they
build an APK. Quality and free limits vary — fine for personal use.

------------------------------------------------------------------
FULL CONTROL (needs a computer + tools) — Capacitor
------------------------------------------------------------------
For a developer setup: install Node + Android Studio, then
capacitorjs.com -> wrap this "www" folder -> build a signed APK.
Most control, most setup.
