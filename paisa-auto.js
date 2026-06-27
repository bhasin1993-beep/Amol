/* ============================================================================
   paisa-auto.js — UPI / card auto-detection layer for Paisa
   ----------------------------------------------------------------------------
   Reads bank / UPI / credit-card transaction SMS through a native Capacitor
   plugin (Android only), parses them into expenses, guesses a category, and
   lets the user confirm them into the normal Paisa transaction list.

   On the web (PWA / Claude preview) the native plugin is absent, so this layer
   stays dormant except for the manual "Paste SMS" fallback. It never touches
   the budgeting logic directly — it only calls the same model the manual
   "Add expense" flow uses (TX / S.balance / saveTx / saveSettings / render),
   so detected items behave exactly like hand-entered ones.
   ========================================================================== */
(function () {
  "use strict";

  /* ----- storage keys ----- */
  var K_SEEN = "paisa_auto_seen";     // de-dupe fingerprints of processed SMS
  var K_LASTTS = "paisa_auto_lastts"; // last inbox scan high-water mark (ms)
  var K_ENABLED = "paisa_auto_enabled";
  var SEEN_CAP = 600;                 // keep the de-dupe set bounded

  /* pending = parsed debits awaiting the user's confirm/dismiss decision */
  var pending = [];

  /* ---------------------------------------------------------------- helpers */
  function lsGet(k, fallback) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  function isNative() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  }
  function plugin() {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SmsReader) || null;
  }

  function fingerprint(sms) {
    // address + first 80 chars of body + day bucket — stable across rescans
    var body = (sms.body || "").replace(/\s+/g, " ").trim().slice(0, 80);
    var day = sms.date ? new Date(+sms.date).toISOString().slice(0, 10) : "";
    return (sms.address || "") + "|" + day + "|" + body;
  }

  function tsToDateStr(ms) {
    var d = ms ? new Date(+ms) : new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
           "-" + String(d.getDate()).padStart(2, "0");
  }

  /* ============================================================ SMS PARSER */
  // Returns null when the SMS is not a spend, otherwise:
  //   { amount, type:"debit", merchant, account, ts, category, raw, address }

  // Hard skips — never an expense. NOTE: balance phrases like "Avl bal" are
  // intentionally NOT here, because genuine debit SMS routinely append them.
  var SKIP = /\b(otp|one[\s-]?time pass|is your|will be (?:debited|credited)|has been requested|requested money|has requested|collect request|failed|declined|unsuccessful|reversed|e-?mandate|autopay (?:set|reg)|min(?:imum)? (?:amt|amount)? ?due|amount due|due on|e-?statement|reward points|do not share|never share)\b/i;

  var CREDIT = /\b(credited|received|deposited|refund(?:ed)?|cashback|salary|reversal|added to)\b/i;
  var DEBIT  = /\b(debited|spent|paid|sent|withdrawn|withdrawal|purchase[d]?|deducted|charged|txn of|transaction of|payment of|debit)\b/i;

  // ₹ / Rs / INR  + number (with optional commas / decimals)
  var AMT = /(?:rs|inr|₹|mrp)\.?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i;
  var AMT2 = /([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:rs|inr|₹)\b/i;

  function parseAmount(body) {
    var m = body.match(AMT) || body.match(AMT2);
    if (!m) return 0;
    var n = parseFloat(m[1].replace(/,/g, ""));
    return isFinite(n) ? n : 0;
  }

  function parseAccount(body) {
    var m =
      body.match(/(?:a\/?c|acct|account|card)(?:\s*(?:no\.?|number|ending| end(?:ing)? with|xx+|x+))?\s*[:#]?\s*([x*\d]{0,6}\d{3,6})/i) ||
      body.match(/\b(?:xx+|x{2,})(\d{3,6})\b/i);
    if (!m) return "";
    var digits = (m[1] || "").replace(/\D/g, "");
    return digits ? "••" + digits.slice(-4) : "";
  }

  function cleanMerchant(s) {
    if (!s) return "";
    s = s.replace(/\b(on|via|ref|upi|imps|neft|rtgs|txn|dated?|info|using|through|a\/?c|account|towards)\b.*$/i, "");
    s = s.replace(/\d{2}[-/]\d{2}[-/]\d{2,4}.*$/, "");   // trailing dates
    s = s.replace(/[*#:.\-_/]+$/g, "").replace(/^\W+/, "").trim();
    // a bare VPA like name@okhdfc -> "name"
    var vpa = s.match(/^([a-z0-9._-]+)@[a-z]+$/i);
    if (vpa) s = vpa[1].replace(/[._-]+/g, " ");
    return s.replace(/\s{2,}/g, " ").trim().slice(0, 40);
  }

  function parseMerchant(body) {
    var m =
      body.match(/\b(?:to|at|towards|in favou?r of|paid to|sent to)\s+([A-Za-z0-9][A-Za-z0-9 &@._'\-]{1,40})/i) ||
      body.match(/\bVPA\s+([a-z0-9._-]+@[a-z]+)/i) ||
      body.match(/\b(?:info|narration)[:\-]\s*([A-Za-z0-9][A-Za-z0-9 &@._'\-]{1,40})/i) ||
      // fallback: "...; INDIAN OIL on 08-Jun" / "...- BIGBAZAAR dated"
      body.match(/[;,\-]\s*([A-Z][A-Za-z0-9 &.'\-]{2,30}?)\s+(?:on|dated|dt)\b/);
    return m ? cleanMerchant(m[1]) : "";
  }

  /* ----- keyword -> Paisa category (ids must match CATS in index.html) ----- */
  var CAT_RULES = [
    ["food",    /\b(swiggy|zomato|eatfit|dominos|domino's|pizza|kfc|mcdonald|burger|restaurant|cafe|coffee|starbucks|chai|food|dineout|eat|bakery|biryani|hotel)\b/i],
    ["grocery", /\b(bigbasket|blinkit|zepto|dunzo|grofers|dmart|d-mart|reliance fresh|jiomart|grocery|supermarket|kirana|more retail|spencer|instamart)\b/i],
    ["fuel",    /\b(petrol|diesel|fuel|hpcl|hp pay|iocl|indian oil|bharat petroleum|bpcl|shell|fastag|toll)\b/i],
    ["shop",    /\b(amazon|flipkart|myntra|ajio|meesho|nykaa|tatacliq|tata cliq|snapdeal|lifestyle|shoppers stop|pantaloons|decathlon|ikea|croma|reliance digital|shop)\b/i],
    ["bills",   /\b(electricity|recharge|airtel|jio|vodafone|vi |bsnl|broadband|wifi|gas|water bill|postpaid|bescom|bill pay|billpay|tata power|adani|dth|tatasky|utility)\b/i],
    ["health",  /\b(pharm|apollo|medplus|1mg|netmeds|hospital|clinic|doctor|diagnostic|lab|medicine|health|practo|cult)\b/i],
    ["fun",     /\b(netflix|hotstar|prime video|spotify|bookmyshow|pvr|inox|cinema|movie|game|gaming|youtube premium|disney|sony liv|zee5)\b/i],
    ["edu",     /\b(udemy|coursera|byju|unacademy|vedantu|upgrad|school|college|tuition|course|book|education|fees)\b/i],
    ["travel",  /\b(uber|ola|rapido|irctc|makemytrip|goibibo|ixigo|cleartrip|indigo|vistara|air india|spicejet|redbus|metro|namma|railway|flight|cab|travel|yatra|oyo|airbnb)\b/i]
  ];
  function guessCategory(merchant, body) {
    var hay = ((merchant || "") + " " + (body || ""));
    for (var i = 0; i < CAT_RULES.length; i++) if (CAT_RULES[i][1].test(hay)) return CAT_RULES[i][0];
    return "other";
  }

  function parseSMS(sms) {
    var body = (sms.body || "").replace(/\s+/g, " ").trim();
    if (!body) return null;
    if (SKIP.test(body)) return null;

    var amount = parseAmount(body);
    if (!amount || amount <= 0) return null;

    var debit = DEBIT.test(body);
    var credit = CREDIT.test(body);
    if (credit && !debit) return null;     // money in — not an expense
    if (!debit) return null;               // no clear spend verb

    var merchant = parseMerchant(body);
    var account = parseAccount(body);
    return {
      amount: Math.round(amount * 100) / 100,
      type: "debit",
      merchant: merchant,
      account: account,
      ts: sms.date ? +sms.date : Date.now(),
      category: guessCategory(merchant, body),
      address: sms.address || "",
      raw: body
    };
  }
  // exposed for the manual paste fallback / debugging
  function parseText(text, when) {
    return parseSMS({ body: text, date: when || Date.now(), address: "manual" });
  }

  /* ====================================================== DE-DUPE / INTAKE */
  function seenSet() { return lsGet(K_SEEN, []); }
  function markSeen(fps) {
    var set = seenSet();
    var merged = set.concat(fps);
    if (merged.length > SEEN_CAP) merged = merged.slice(merged.length - SEEN_CAP);
    lsSet(K_SEEN, merged);
  }

  // Accept raw SMS objects {address, body, date}; queue new debits as pending.
  function intake(messages) {
    var seen = seenSet();
    var seenIdx = {}; seen.forEach(function (f) { seenIdx[f] = 1; });
    var pendIdx = {}; pending.forEach(function (p) { pendIdx[p._fp] = 1; });
    var maxTs = lsGet(K_LASTTS, 0);
    var added = 0;

    (messages || []).forEach(function (sms) {
      var fp = fingerprint(sms);
      if (sms.date && +sms.date > maxTs) maxTs = +sms.date;
      if (seenIdx[fp] || pendIdx[fp]) return;
      var parsed = parseSMS(sms);
      if (!parsed) { return; }           // non-spend SMS: ignore, don't requeue
      parsed._fp = fp;
      parsed._id = "d" + parsed.ts + Math.random().toString(36).slice(2, 6);
      pending.push(parsed);
      pendIdx[fp] = 1;
      added++;
    });

    lsSet(K_LASTTS, maxTs);
    if (added > 0) { pending.sort(function (a, b) { return b.ts - a.ts; }); renderBadge(); }
    return added;
  }

  /* ============================================== CONFIRM -> REAL EXPENSE */
  // Mirrors commitAdd() in index.html so detected items are identical to manual.
  function confirm(detected, overrides) {
    overrides = overrides || {};
    var cat = overrides.category || detected.category || "other";
    var note = overrides.note != null ? overrides.note
             : (detected.merchant || (detected.account ? "Card " + detected.account : "UPI payment"));
    var t = {
      id: "t" + Date.now() + Math.random().toString(36).slice(2, 6),
      amount: Math.round(detected.amount * 100) / 100,
      category: cat,
      note: note,
      date: tsToDateStr(detected.ts),
      ts: detected.ts || Date.now(),
      auto: true
    };
    if (typeof TX === "undefined") return; // app not booted
    TX.push(t);
    S.balance = (+S.balance || 0) - t.amount;
    saveTx(); saveSettings();
    dismiss(detected, true);
    if (typeof render === "function") render();
  }

  function dismiss(detected, silent) {
    pending = pending.filter(function (p) { return p._fp !== detected._fp; });
    markSeen([detected._fp]);          // never resurface this SMS
    renderBadge();
    if (!silent) renderSheet();
  }

  function confirmAll() {
    // copy because confirm() mutates `pending`
    pending.slice().forEach(function (p) { confirm(p); });
    renderSheet();
  }

  /* ======================================================== REVIEW UI ===== */
  function injectStyles() {
    if (document.getElementById("paisa-auto-css")) return;
    var css = document.createElement("style");
    css.id = "paisa-auto-css";
    css.textContent =
      "#pa-badge{position:fixed;left:50%;transform:translateX(-50%);bottom:96px;z-index:60;" +
      "background:var(--brass,#E0A75E);color:#1c1303;border:none;border-radius:999px;" +
      "padding:11px 18px;font-family:var(--disp,sans-serif);font-weight:600;font-size:14px;" +
      "box-shadow:0 8px 24px rgba(0,0,0,.4);display:none;align-items:center;gap:8px;cursor:pointer}" +
      "#pa-badge.on{display:inline-flex;animation:pa-pop .25s ease}" +
      "#pa-badge.idle{background:var(--surf2,#1E2A41);color:var(--muted,#8B97AD);" +
      "border:1px solid var(--line2,rgba(255,255,255,.14));box-shadow:none}" +
      ".pa-paste{width:100%;min-height:74px;background:var(--surf2,#1E2A41);color:var(--ink,#ECE8DF);" +
      "border:1px solid var(--line2,rgba(255,255,255,.14));border-radius:12px;padding:10px;font-size:13px;" +
      "font-family:var(--body,sans-serif);resize:vertical;margin:4px 0 8px}" +
      ".pa-note{color:var(--faint,#5C6880);font-size:12px;margin:10px 2px 2px;line-height:1.5}" +
      "@keyframes pa-pop{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}}" +
      "#pa-scrim{position:fixed;inset:0;z-index:70;background:rgba(6,10,18,.6);backdrop-filter:blur(2px);" +
      "display:none;align-items:flex-end;justify-content:center}" +
      "#pa-scrim.on{display:flex}" +
      "#pa-sheet{width:100%;max-width:520px;max-height:82vh;overflow:auto;background:var(--surf,#172134);" +
      "border:1px solid var(--line,rgba(255,255,255,.08));border-bottom:none;border-radius:22px 22px 0 0;" +
      "padding:16px 16px 28px;animation:pa-up .28s ease}" +
      "@keyframes pa-up{from{transform:translateY(30px);opacity:.4}to{transform:none;opacity:1}}" +
      "#pa-sheet h3{font-family:var(--disp,sans-serif);font-size:18px;margin:2px 2px 2px}" +
      ".pa-sub{color:var(--muted,#8B97AD);font-size:13px;margin:0 2px 12px}" +
      ".pa-item{background:var(--surf2,#1E2A41);border:1px solid var(--line,rgba(255,255,255,.08));" +
      "border-radius:16px;padding:12px 13px;margin-bottom:10px}" +
      ".pa-row{display:flex;align-items:center;gap:10px}" +
      ".pa-amt{font-family:var(--mono,monospace);font-size:18px;font-weight:600;margin-left:auto}" +
      ".pa-mer{font-weight:600;font-size:15px}" +
      ".pa-meta{color:var(--muted,#8B97AD);font-size:12px;margin-top:2px}" +
      ".pa-cats{display:flex;gap:6px;overflow-x:auto;margin:10px -2px 0;padding:2px}" +
      ".pa-cat{flex:0 0 auto;border:1px solid var(--line2,rgba(255,255,255,.14));background:transparent;" +
      "color:var(--ink,#ECE8DF);border-radius:999px;padding:6px 11px;font-size:12px;cursor:pointer;white-space:nowrap}" +
      ".pa-cat.sel{background:var(--surf3,#243352);border-color:var(--brass,#E0A75E);color:var(--brass,#E0A75E)}" +
      ".pa-acts{display:flex;gap:8px;margin-top:11px}" +
      ".pa-btn{flex:1;border-radius:11px;padding:10px;font-family:var(--disp,sans-serif);font-weight:600;" +
      "font-size:14px;cursor:pointer;border:1px solid var(--line2,rgba(255,255,255,.14));background:transparent;color:var(--ink,#ECE8DF)}" +
      ".pa-btn.add{background:var(--teal,#4FB6A4);border-color:var(--teal,#4FB6A4);color:#06201c}" +
      ".pa-top{display:flex;gap:8px;margin:6px 2px 14px}" +
      ".pa-top .pa-btn{flex:1}" +
      ".pa-x{background:none;border:none;color:var(--muted,#8B97AD);font-size:22px;line-height:1;cursor:pointer;margin-left:auto}" +
      ".pa-empty{color:var(--muted,#8B97AD);text-align:center;padding:26px 10px}";
    document.head.appendChild(css);
  }

  function catList() {
    return (typeof CATS !== "undefined" && CATS) ? CATS :
      [{ id: "other", e: "•", n: "Other" }];
  }

  function ensureNodes() {
    injectStyles();
    if (!document.getElementById("pa-badge")) {
      var b = document.createElement("button");
      b.id = "pa-badge";
      b.addEventListener("click", openSheet);
      document.body.appendChild(b);
    }
    if (!document.getElementById("pa-scrim")) {
      var scrim = document.createElement("div");
      scrim.id = "pa-scrim";
      scrim.innerHTML = '<div id="pa-sheet"></div>';
      scrim.addEventListener("click", function (e) { if (e.target === scrim) closeSheet(); });
      document.body.appendChild(scrim);
    }
  }

  function renderBadge() {
    ensureNodes();
    var b = document.getElementById("pa-badge");
    if (!b) return;
    if (pending.length > 0) {
      b.innerHTML = "✨ " + pending.length + " payment" + (pending.length > 1 ? "s" : "") + " detected";
      b.classList.add("on");
      b.classList.remove("idle");
    } else if (!isNative()) {
      // web / preview: keep a quiet launcher so the paste-fallback is reachable
      b.innerHTML = "✨ Auto-detect";
      b.classList.add("on", "idle");
    } else {
      b.classList.remove("on", "idle");
    }
    var sc = document.getElementById("pa-scrim");
    if (sc && sc.classList.contains("on")) renderSheet();
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function rupee(n) {
    return "₹" + Math.round(n || 0).toLocaleString("en-IN");
  }

  function renderSheet() {
    ensureNodes();
    var sheet = document.getElementById("pa-sheet");
    if (!sheet) return;
    var cats = catList();

    if (!pending.length) {
      var scanBtn = (isNative() && plugin())
        ? '<button class="pa-btn" id="pa-scan">Scan messages now</button>' : '';
      sheet.innerHTML =
        '<div class="pa-row"><h3>Auto-detect</h3>' +
        '<button class="pa-x" id="pa-close">×</button></div>' +
        '<div class="pa-empty">No payments waiting to be added.</div>' +
        (scanBtn ? '<div class="pa-top">' + scanBtn + '</div>' : '') +
        '<p class="pa-sub" style="margin-top:10px">Paste a bank / UPI SMS to add it manually:</p>' +
        '<textarea class="pa-paste" id="pa-paste" placeholder="e.g. Rs.250 debited from a/c XX1234 to SWIGGY via UPI..."></textarea>' +
        '<div class="pa-top"><button class="pa-btn add" id="pa-parse">Read SMS</button></div>' +
        (isNative()
          ? '<p class="pa-note">On Android, payments are read from your bank / UPI messages automatically and pop up here to confirm.</p>'
          : '<p class="pa-note">Install the Android app to detect UPI &amp; card payments automatically. In this preview you can paste an SMS to test.</p>');
      document.getElementById("pa-close").onclick = closeSheet;
      var scan = document.getElementById("pa-scan");
      if (scan) scan.onclick = async function () { scan.textContent = "Scanning…"; await scanInbox(); renderSheet(); };
      document.getElementById("pa-parse").onclick = function () {
        var txt = document.getElementById("pa-paste").value || "";
        if (!txt.trim()) return;
        var n = intake([{ address: "manual", body: txt, date: Date.now() }]);
        if (n > 0) { renderSheet(); }
        else { if (typeof toast === "function") toast("No payment found in that text"); }
      };
      return;
    }

    var html =
      '<div class="pa-row"><h3>Detected payments</h3>' +
      '<button class="pa-x" id="pa-close">×</button></div>' +
      '<p class="pa-sub">From your bank / UPI messages. Tap a category, then add.</p>' +
      '<div class="pa-top">' +
      '<button class="pa-btn add" id="pa-all">Add all (' + pending.length + ')</button>' +
      '<button class="pa-btn" id="pa-dismissall">Dismiss all</button></div>';

    pending.forEach(function (p) {
      var when = new Date(p.ts);
      var meta = [];
      if (p.account) meta.push(p.account);
      meta.push(when.toLocaleDateString("en-IN", { day: "numeric", month: "short" }) +
               " " + when.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }));
      var catChips = cats.map(function (c) {
        return '<button class="pa-cat ' + (c.id === p.category ? "sel" : "") +
          '" data-id="' + p._id + '" data-c="' + c.id + '">' +
          (c.e ? c.e + " " : "") + escapeHtml(c.n) + "</button>";
      }).join("");
      html +=
        '<div class="pa-item" data-id="' + p._id + '">' +
          '<div class="pa-row">' +
            '<div><div class="pa-mer">' + escapeHtml(p.merchant || "UPI payment") + '</div>' +
            '<div class="pa-meta">' + escapeHtml(meta.join(" · ")) + '</div></div>' +
            '<div class="pa-amt">' + rupee(p.amount) + '</div>' +
          '</div>' +
          '<div class="pa-cats">' + catChips + '</div>' +
          '<div class="pa-acts">' +
            '<button class="pa-btn add" data-act="add" data-id="' + p._id + '">Add expense</button>' +
            '<button class="pa-btn" data-act="skip" data-id="' + p._id + '">Not an expense</button>' +
          '</div>' +
        '</div>';
    });

    sheet.innerHTML = html;
    document.getElementById("pa-close").onclick = closeSheet;
    document.getElementById("pa-all").onclick = function () { confirmAll(); };
    document.getElementById("pa-dismissall").onclick = function () {
      pending.slice().forEach(function (p) { dismiss(p, true); });
      renderSheet();
    };
    // category selection
    sheet.querySelectorAll(".pa-cat").forEach(function (chip) {
      chip.onclick = function () {
        var id = chip.getAttribute("data-id"), c = chip.getAttribute("data-c");
        var p = pending.find(function (x) { return x._id === id; });
        if (p) p.category = c;
        sheet.querySelectorAll('.pa-cat[data-id="' + id + '"]').forEach(function (el) {
          el.classList.toggle("sel", el.getAttribute("data-c") === c);
        });
      };
    });
    // per-item actions
    sheet.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.onclick = function () {
        var id = btn.getAttribute("data-id"), act = btn.getAttribute("data-act");
        var p = pending.find(function (x) { return x._id === id; });
        if (!p) return;
        if (act === "add") confirm(p); else dismiss(p);
        renderSheet();
      };
    });
  }

  function openSheet() { ensureNodes(); document.getElementById("pa-scrim").classList.add("on"); renderSheet(); }
  function closeSheet() { var s = document.getElementById("pa-scrim"); if (s) s.classList.remove("on"); }

  /* ============================================================ NATIVE WIRE */
  function setEnabled(on) { lsSet(K_ENABLED, !!on); if (on) startNative(); }
  function enabled() { return lsGet(K_ENABLED, true); }   // opt-out, not opt-in

  async function scanInbox() {
    var p = plugin();
    if (!p || !p.readInbox) return 0;
    try {
      var since = lsGet(K_LASTTS, 0);
      // first run: look back 30 days; later: only since high-water mark
      var lookback = since > 0 ? since : (Date.now() - 30 * 24 * 3600 * 1000);
      var res = await p.readInbox({ since: lookback, max: 500 });
      return intake((res && res.messages) || []);
    } catch (e) { return 0; }
  }

  async function startNative() {
    var p = plugin();
    if (!p) return;
    try {
      if (p.requestPermissions) {
        var perm = await p.requestPermissions();
        if (perm && perm.sms && perm.sms !== "granted") return; // user declined
      }
      // live incoming SMS
      if (p.addListener) {
        p.addListener("smsReceived", function (sms) {
          if (!enabled()) return;
          var n = intake([sms]);
          if (n > 0 && typeof toast === "function") toast("Payment detected");
        });
      }
      if (p.startWatch) { try { await p.startWatch(); } catch (e) {} }
      await scanInbox();
    } catch (e) { /* permission denied or plugin missing */ }
  }

  /* ================================================================= INIT */
  function init() {
    ensureNodes();
    renderBadge();
    if (isNative() && enabled()) {
      startNative();
      // rescan when the app returns to the foreground
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
        try {
          window.Capacitor.Plugins.App.addListener("appStateChange", function (st) {
            if (st && st.isActive) scanInbox();
          });
        } catch (e) {}
      }
    }
  }

  /* public surface (used by index.html + manual paste fallback) */
  window.PaisaAuto = {
    init: init,
    open: openSheet,
    parseText: parseText,        // (text, whenMs) -> parsed | null
    intake: intake,              // ([{address,body,date}]) -> count queued
    confirm: confirm,
    pendingCount: function () { return pending.length; },
    scanInbox: scanInbox,
    setEnabled: setEnabled,
    isEnabled: enabled,
    isNative: isNative
  };

  /* self-start: this script is loaded after the main app script, so TX/S/CATS
     already exist by the time we run. */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
