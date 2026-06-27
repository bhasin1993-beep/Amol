/* ============================================================================
   paisa-invest.js — Investments & mutual-fund tracking for Paisa
   ----------------------------------------------------------------------------
   Log where you invest (fund, platform, units, amount), then track live daily
   NAVs from AMFI via the free mfapi.in feed. Computes current value, total
   gain, and day change. Fully integrated with the rest of Paisa; the Coach
   module reads the totals from here for advice and corpus projections.

   Storage:  paisa_holdings  -> [ {id,name,code,platform,units,invested,
                                    nav,prevNav,navDate,startDate,addedTs} ]
   ========================================================================== */
(function () {
  "use strict";

  var K = "paisa_holdings";
  var SEARCH_URL = "https://api.mfapi.in/mf/search?q=";
  var FUND_URL = "https://api.mfapi.in/mf/";   // + code  (full history)

  var holdings = load();
  var refreshing = false;
  var lastRefresh = 0;

  function load() {
    try { return JSON.parse(localStorage.getItem(K)) || []; } catch (e) { return []; }
  }
  function save() { try { localStorage.setItem(K, JSON.stringify(holdings)); } catch (e) {} }

  function inr(n) { return "₹" + Math.round(n || 0).toLocaleString("en-IN"); }
  function inrSigned(n) { return (n < 0 ? "-₹" : "+₹") + Math.abs(Math.round(n || 0)).toLocaleString("en-IN"); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /* ---------------------------------------------------------- math / totals */
  function valueOf(h) { return (+h.units || 0) * (+h.nav || 0); }
  function totals() {
    var invested = 0, value = 0, day = 0;
    holdings.forEach(function (h) {
      invested += (+h.invested || 0);
      var v = valueOf(h);
      value += v;
      if (h.prevNav) day += (+h.units || 0) * ((+h.nav || 0) - (+h.prevNav || 0));
    });
    return { invested: invested, value: value, gain: value - invested, day: day };
  }
  // public snapshot used by the Coach module
  function snapshot() {
    var t = totals();
    return {
      invested: t.invested, value: t.value, gain: t.gain, dayChange: t.day,
      count: holdings.length,
      funds: holdings.map(function (h) {
        return { name: h.name, platform: h.platform, invested: +h.invested || 0, value: valueOf(h) };
      })
    };
  }

  /* ------------------------------------------------------------ live NAVs */
  function parseNavDate(s) { // "dd-mm-yyyy" -> Date
    var p = (s || "").split("-"); if (p.length !== 3) return null;
    return new Date(+p[2], +p[1] - 1, +p[0]);
  }

  async function refreshOne(h) {
    if (!h.code) return;
    try {
      var r = await fetch(FUND_URL + h.code, { cache: "no-store" });
      if (!r.ok) return;
      var j = await r.json();
      var d = j && j.data;
      if (d && d.length) {
        h.nav = parseFloat(d[0].nav) || h.nav;
        h.navDate = d[0].date || h.navDate;
        if (d[1]) h.prevNav = parseFloat(d[1].nav) || h.prevNav;
        if (j.meta && j.meta.scheme_name && !h.name) h.name = j.meta.scheme_name;
      }
    } catch (e) { /* offline — keep last known NAV */ }
  }

  async function refreshAll(force) {
    if (refreshing) return;
    if (!holdings.length) return;
    if (!force && Date.now() - lastRefresh < 60 * 1000) return; // throttle
    refreshing = true;
    try {
      for (var i = 0; i < holdings.length; i++) await refreshOne(holdings[i]);
      lastRefresh = Date.now();
      save();
      if (typeof curView !== "undefined" && curView === "invest" && typeof render === "function") render();
    } finally { refreshing = false; }
  }

  /* ------------------------------------------------------- fund search UI */
  var searchTimer = null;
  async function doSearch(q) {
    var box = document.getElementById("pi-results");
    if (!box) return;
    if (!q || q.trim().length < 3) { box.innerHTML = '<div class="pi-hint">Type at least 3 letters…</div>'; return; }
    box.innerHTML = '<div class="pi-hint">Searching…</div>';
    try {
      var r = await fetch(SEARCH_URL + encodeURIComponent(q.trim()));
      var list = await r.json();
      if (!Array.isArray(list) || !list.length) { box.innerHTML = '<div class="pi-hint">No funds found.</div>'; return; }
      box.innerHTML = list.slice(0, 20).map(function (f) {
        return '<button class="pi-res" data-code="' + f.schemeCode + '" data-name="' +
          esc(f.schemeName) + '">' + esc(f.schemeName) + "</button>";
      }).join("");
      box.querySelectorAll(".pi-res").forEach(function (b) {
        b.onclick = function () {
          var nm = document.getElementById("pi-name");
          nm.value = b.getAttribute("data-name");
          nm.setAttribute("data-code", b.getAttribute("data-code"));
          box.innerHTML = '<div class="pi-hint">Selected ✓ — fill amount &amp; units below.</div>';
        };
      });
    } catch (e) { box.innerHTML = '<div class="pi-hint">Search needs internet. You can still add a fund manually below.</div>'; }
  }

  /* ------------------------------------------------------------- add / del */
  async function addHolding() {
    var nameEl = document.getElementById("pi-name");
    var name = nameEl.value.trim();
    var code = nameEl.getAttribute("data-code") || "";
    var platform = document.getElementById("pi-platform").value.trim();
    var invested = parseFloat(document.getElementById("pi-invested").value) || 0;
    var units = parseFloat(document.getElementById("pi-units").value) || 0;
    var navManual = parseFloat(document.getElementById("pi-nav").value) || 0;
    if (!name) { toastMsg("Pick or type a fund"); return; }
    if (invested <= 0) { toastMsg("Enter amount invested"); return; }
    var h = {
      id: "h" + Date.now() + Math.random().toString(36).slice(2, 5),
      name: name, code: code, platform: platform,
      units: units, invested: invested,
      nav: navManual || 0, prevNav: 0, navDate: "", addedTs: Date.now()
    };
    holdings.unshift(h);
    save();
    closeForm();
    if (typeof render === "function") render();
    if (code) { await refreshOne(h); if (!h.units && h.nav) h.units = invested / h.nav; save(); if (typeof render === "function") render(); }
  }

  function delHolding(id) {
    holdings = holdings.filter(function (h) { return h.id !== id; });
    save();
    if (typeof render === "function") render();
  }

  function toastMsg(m) { if (typeof toast === "function") toast(m); }

  /* ------------------------------------------------------------------ view */
  function styles() {
    if (document.getElementById("pi-css")) return;
    var s = document.createElement("style");
    s.id = "pi-css";
    s.textContent =
      ".pi-sum{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:4px 0 14px}" +
      ".pi-tile{background:var(--surf2,#1E2A41);border:1px solid var(--line,rgba(255,255,255,.08));border-radius:16px;padding:13px 14px}" +
      ".pi-tile .l{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted,#8B97AD)}" +
      ".pi-tile .v{font-family:var(--mono,monospace);font-size:21px;font-weight:600;margin-top:3px}" +
      ".pi-tile.span{grid-column:1/3}" +
      ".pos{color:var(--teal,#4FB6A4)}.neg{color:var(--coral,#E8765C)}" +
      ".pi-card{background:var(--surf,#172134);border:1px solid var(--line,rgba(255,255,255,.08));border-radius:16px;padding:13px 14px;margin-bottom:10px}" +
      ".pi-card .nm{font-weight:600;font-size:15px}" +
      ".pi-card .meta{color:var(--muted,#8B97AD);font-size:12px;margin-top:2px}" +
      ".pi-card .row{display:flex;justify-content:space-between;align-items:flex-end;margin-top:8px}" +
      ".pi-card .cur{font-family:var(--mono,monospace);font-size:17px;font-weight:600}" +
      ".pi-del{background:none;border:none;color:var(--faint,#5C6880);font-size:12px;cursor:pointer;margin-top:6px}" +
      ".pi-add{width:100%;background:var(--brass,#E0A75E);color:#1c1303;border:none;border-radius:13px;padding:13px;font-family:var(--disp,sans-serif);font-weight:600;font-size:15px;cursor:pointer;margin-top:4px}" +
      ".pi-inp{width:100%;background:var(--surf2,#1E2A41);color:var(--ink,#ECE8DF);border:1px solid var(--line2,rgba(255,255,255,.14));border-radius:11px;padding:11px;font-size:14px;margin:5px 0;font-family:var(--body,sans-serif)}" +
      ".pi-res{display:block;width:100%;text-align:left;background:var(--surf2,#1E2A41);color:var(--ink,#ECE8DF);border:1px solid var(--line,rgba(255,255,255,.08));border-radius:10px;padding:9px 11px;margin-bottom:6px;font-size:13px;cursor:pointer}" +
      ".pi-hint{color:var(--faint,#5C6880);font-size:12px;padding:6px 2px}" +
      ".pi-lbl{font-size:12px;color:var(--muted,#8B97AD);margin:8px 2px 0}" +
      ".pi-empty{text-align:center;color:var(--muted,#8B97AD);padding:26px 12px}" +
      ".pi-day{font-size:12px;font-family:var(--mono,monospace)}";
    document.head.appendChild(s);
  }

  function holdingCard(h) {
    var val = valueOf(h);
    var gain = val - (+h.invested || 0);
    var pct = h.invested ? (gain / h.invested * 100) : 0;
    var day = h.prevNav ? (+h.units || 0) * ((+h.nav || 0) - (+h.prevNav || 0)) : 0;
    var navLine = h.nav ? ("NAV " + (+h.nav).toFixed(2) + (h.navDate ? " · " + h.navDate : "")) : "NAV pending…";
    return '<div class="pi-card">' +
      '<div class="nm">' + esc(h.name) + '</div>' +
      '<div class="meta">' + (h.platform ? esc(h.platform) + " · " : "") +
        (h.units ? (+h.units).toFixed(3) + " units · " : "") + esc(navLine) + '</div>' +
      '<div class="row"><div>' +
        '<div class="meta">Invested ' + inr(h.invested) + '</div>' +
        '<div class="' + (gain >= 0 ? "pos" : "neg") + ' pi-day">' + inrSigned(gain) + " (" + (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%)" + '</div>' +
      '</div><div class="cur">' + inr(val) + '</div></div>' +
      (h.prevNav ? '<div class="' + (day >= 0 ? "pos" : "neg") + ' pi-day">Today ' + inrSigned(day) + '</div>' : '') +
      '<button class="pi-del" onclick="PaisaInvest.del(\'' + h.id + '\')">Remove</button>' +
      '</div>';
  }

  function view() {
    styles();
    var t = totals();
    var head = '<div class="app-sub" style="padding:2px 4px 6px"><h2 style="font-family:var(--disp,sans-serif);font-size:20px;margin:0">Investments</h2>' +
      '<div style="color:var(--muted,#8B97AD);font-size:13px;margin-top:2px">Live mutual-fund tracking</div></div>';

    if (!holdings.length) {
      return head +
        '<div class="pi-empty">No investments yet.<br>Add your mutual funds to track them with daily NAVs.</div>' +
        '<button class="pi-add" onclick="PaisaInvest.openForm()">+ Add a mutual fund</button>';
    }

    var gpct = t.invested ? (t.gain / t.invested * 100) : 0;
    var sum =
      '<div class="pi-sum">' +
        '<div class="pi-tile"><div class="l">Invested</div><div class="v">' + inr(t.invested) + '</div></div>' +
        '<div class="pi-tile"><div class="l">Current value</div><div class="v">' + inr(t.value) + '</div></div>' +
        '<div class="pi-tile span"><div class="l">Total gain</div>' +
          '<div class="v ' + (t.gain >= 0 ? "pos" : "neg") + '">' + inrSigned(t.gain) +
          '  <span style="font-size:14px">(' + (gpct >= 0 ? "+" : "") + gpct.toFixed(1) + '%)</span></div>' +
          (t.day ? '<div class="pi-day ' + (t.day >= 0 ? "pos" : "neg") + '" style="margin-top:4px">Today ' + inrSigned(t.day) + '</div>' : '') +
        '</div>' +
      '</div>';

    return head + sum +
      holdings.map(holdingCard).join("") +
      (refreshing ? '<div class="pi-hint">Updating NAVs…</div>' : '') +
      '<button class="pi-add" onclick="PaisaInvest.openForm()">+ Add a mutual fund</button>';
  }

  function afterRender() { refreshAll(false); }

  /* ------------------------------------------------------------ add form */
  function openForm() {
    styles();
    var scrim = document.getElementById("scrim");
    if (!scrim) return;
    scrim.innerHTML =
      '<div class="sheet" style="background:var(--surf,#172134);border-radius:22px 22px 0 0;border:1px solid var(--line,rgba(255,255,255,.08));max-width:520px;width:100%;padding:16px 16px 28px;max-height:86vh;overflow:auto">' +
      '<h3 style="font-family:var(--disp,sans-serif);font-size:18px;margin:2px 2px 10px">Add mutual fund</h3>' +
      '<div class="pi-lbl">Search fund (NAV auto-tracked)</div>' +
      '<input class="pi-inp" id="pi-search" placeholder="e.g. Parag Parikh Flexi Cap" autocomplete="off">' +
      '<div id="pi-results"><div class="pi-hint">Type at least 3 letters…</div></div>' +
      '<div class="pi-lbl">Fund name</div>' +
      '<input class="pi-inp" id="pi-name" placeholder="Selected fund appears here">' +
      '<div class="pi-lbl">Platform / app (where you invest)</div>' +
      '<input class="pi-inp" id="pi-platform" placeholder="e.g. Groww, Zerodha Coin, Kuvera">' +
      '<div class="pi-lbl">Amount invested (₹)</div>' +
      '<input class="pi-inp" id="pi-invested" type="number" inputmode="decimal" placeholder="e.g. 50000">' +
      '<div class="pi-lbl">Units held <span style="color:var(--faint,#5C6880)">(optional — auto-estimated if blank)</span></div>' +
      '<input class="pi-inp" id="pi-units" type="number" inputmode="decimal" placeholder="e.g. 812.34">' +
      '<div class="pi-lbl">Current NAV <span style="color:var(--faint,#5C6880)">(optional — only if not auto-tracked)</span></div>' +
      '<input class="pi-inp" id="pi-nav" type="number" inputmode="decimal" placeholder="auto from market">' +
      '<button class="pi-add" onclick="PaisaInvest.add()">Add investment</button>' +
      '<button class="pi-del" style="display:block;margin:10px auto 0" onclick="PaisaInvest.closeForm()">Cancel</button>' +
      '</div>';
    scrim.classList.add("on");
    var si = document.getElementById("pi-search");
    si.addEventListener("input", function () {
      clearTimeout(searchTimer);
      var v = si.value;
      searchTimer = setTimeout(function () { doSearch(v); }, 350);
    });
    setTimeout(function () { si.focus(); }, 120);
  }
  function closeForm() {
    var scrim = document.getElementById("scrim");
    if (scrim) { scrim.classList.remove("on"); scrim.innerHTML = ""; }
  }

  window.PaisaInvest = {
    view: view, afterRender: afterRender,
    openForm: openForm, closeForm: closeForm, add: addHolding, del: delHolding,
    refresh: function () { refreshAll(true); },
    snapshot: snapshot
  };
})();
