/* ============================================================================
   paisa-cards.js — Credit-card spend & bill tracking for Paisa
   ----------------------------------------------------------------------------
   The accounting model (deliberate, to avoid double-counting):

     • A card SWIPE is a real expense -> it counts in your monthly budget
       (handled in index.html: TX item with method:"card") and adds to that
       card's OUTSTANDING. It does NOT reduce your bank balance yet.
     • Card EMIs (Home theatre, gym, …) live in your PLAN as fixed costs and
       are NOT logged here again — so they're never deducted twice.
     • Paying the card BILL is a SETTLEMENT, not an expense: it reduces the
       card's outstanding and your bank balance, and is excluded from spending
       (TX item with settle:true).

   Storage:  paisa_cards -> [ {id,name,last4,dueDay,addedTs} ]
   Card spend / outstanding are derived from TX (single source of truth).
   ========================================================================== */
(function () {
  "use strict";

  var K = "paisa_cards";
  var cards = load();

  function load() { try { return JSON.parse(localStorage.getItem(K)) || []; } catch (e) { return []; } }
  function save() { try { localStorage.setItem(K, JSON.stringify(cards)); } catch (e) {} }

  function inr(n) { return "₹" + Math.round(n || 0).toLocaleString("en-IN"); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function toastMsg(m) { if (typeof toast === "function") toast(m); }
  function txs() { return (typeof TX !== "undefined" && TX) ? TX : []; }
  function mk(d) { return (typeof monthKey === "function") ? monthKey(d) : String(d || "").slice(0, 7); }
  function today() { return (typeof todayStr === "function") ? todayStr() : new Date().toISOString().slice(0, 10); }

  /* ----------------------------------------------------------- derived $$ */
  // swipes on a card (real spends, exclude settlements)
  function swipes(cardId) {
    return txs().filter(function (t) { return t.method === "card" && (t.cardId || "") === cardId && !t.settle; });
  }
  function settlements(cardId) {
    return txs().filter(function (t) { return t.settle && (t.cardId || "") === cardId; });
  }
  function sum(arr) { return arr.reduce(function (a, t) { return a + (+t.amount || 0); }, 0); }

  function outstanding(cardId) { return sum(swipes(cardId)) - sum(settlements(cardId)); }
  function spendThisMonth(cardId) {
    var m = mk(today());
    return sum(swipes(cardId).filter(function (t) { return mk(t.date) === m; }));
  }
  // all card spend this month across every card (incl. swipes with no card set)
  function totalCardSpendMonth() {
    var m = mk(today());
    return sum(txs().filter(function (t) { return t.method === "card" && !t.settle && mk(t.date) === m; }));
  }
  function totalOutstanding() {
    var all = sum(txs().filter(function (t) { return t.method === "card" && !t.settle; }))
      - sum(txs().filter(function (t) { return t.settle; }));
    return all;
  }

  function nextDue(dueDay) {
    if (!dueDay) return "";
    var d = new Date(), day = Math.min(Math.max(+dueDay, 1), 28);
    var due = new Date(d.getFullYear(), d.getMonth(), day);
    if (due < new Date(d.getFullYear(), d.getMonth(), d.getDate())) due = new Date(d.getFullYear(), d.getMonth() + 1, day);
    return due.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  }

  /* --------------------------------------------------------------- styles */
  function styles() {
    if (document.getElementById("pcard-css")) return;
    var s = document.createElement("style");
    s.id = "pcard-css";
    s.textContent =
      ".pcd-sum{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:4px 0 14px}" +
      ".pcd-tile{background:var(--surf2,#1E2A41);border:1px solid var(--line,rgba(255,255,255,.08));border-radius:16px;padding:13px 14px}" +
      ".pcd-tile .l{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted,#8B97AD)}" +
      ".pcd-tile .v{font-family:var(--mono,monospace);font-size:21px;font-weight:600;margin-top:3px}" +
      ".pcd-card{background:var(--surf,#172134);border:1px solid var(--line,rgba(255,255,255,.08));border-radius:16px;padding:14px;margin-bottom:10px}" +
      ".pcd-card .nm{font-weight:600;font-size:16px}" +
      ".pcd-card .meta{color:var(--muted,#8B97AD);font-size:12px;margin-top:2px}" +
      ".pcd-row{display:flex;justify-content:space-between;margin-top:10px}" +
      ".pcd-row .l{color:var(--muted,#8B97AD);font-size:12px}" +
      ".pcd-row .v{font-family:var(--mono,monospace);font-weight:600}" +
      ".pcd-act{display:flex;gap:8px;margin-top:12px}" +
      ".pcd-btn{flex:1;border-radius:11px;padding:10px;font-family:var(--disp,sans-serif);font-weight:600;font-size:14px;cursor:pointer;border:1px solid var(--line2,rgba(255,255,255,.14));background:transparent;color:var(--ink,#ECE8DF)}" +
      ".pcd-btn.pay{background:var(--teal,#4FB6A4);border-color:var(--teal,#4FB6A4);color:#06201c}" +
      ".pcd-add{width:100%;background:var(--brass,#E0A75E);color:#1c1303;border:none;border-radius:13px;padding:13px;font-family:var(--disp,sans-serif);font-weight:600;font-size:15px;cursor:pointer;margin-top:4px}" +
      ".pcd-inp{width:100%;background:var(--surf2,#1E2A41);color:var(--ink,#ECE8DF);border:1px solid var(--line2,rgba(255,255,255,.14));border-radius:11px;padding:11px;font-size:14px;margin:5px 0;font-family:var(--body,sans-serif)}" +
      ".pcd-lbl{font-size:12px;color:var(--muted,#8B97AD);margin:8px 2px 0}" +
      ".pcd-del{background:none;border:none;color:var(--faint,#5C6880);font-size:12px;cursor:pointer}" +
      ".pcd-empty{text-align:center;color:var(--muted,#8B97AD);padding:22px 12px}" +
      ".pcd-note{color:var(--faint,#5C6880);font-size:12px;margin:6px 2px 14px;line-height:1.5}";
    document.head.appendChild(s);
  }

  /* ----------------------------------------------------------------- view */
  function cardBlock(c) {
    var out = outstanding(c.id);
    var mspend = spendThisMonth(c.id);
    var due = nextDue(c.dueDay);
    return '<div class="pcd-card">' +
      '<div class="nm">' + esc(c.name) + (c.last4 ? ' <span class="meta">•• ' + esc(c.last4) + '</span>' : '') + '</div>' +
      (due ? '<div class="meta">Bill due ~' + esc(due) + '</div>' : '') +
      '<div class="pcd-row"><span class="l">Spent this month</span><span class="v">' + inr(mspend) + '</span></div>' +
      '<div class="pcd-row"><span class="l">Outstanding (unpaid swipes)</span><span class="v">' + inr(Math.max(out, 0)) + '</span></div>' +
      '<div class="pcd-act">' +
        '<button class="pcd-btn pay" onclick="PaisaCards.payBill(\'' + c.id + '\')">Pay bill</button>' +
        '<button class="pcd-btn" onclick="PaisaCards.remove(\'' + c.id + '\')">Remove</button>' +
      '</div></div>';
  }

  function view() {
    styles();
    var head = '<div style="padding:2px 4px 6px"><h2 style="font-family:var(--disp,sans-serif);font-size:20px;margin:0">Credit cards</h2>' +
      '<div style="color:var(--muted,#8B97AD);font-size:13px;margin-top:2px">Spends, bills &amp; outstanding</div></div>';

    var sum =
      '<div class="pcd-sum">' +
        '<div class="pcd-tile"><div class="l">Card spend · month</div><div class="v">' + inr(totalCardSpendMonth()) + '</div></div>' +
        '<div class="pcd-tile"><div class="l">Total outstanding</div><div class="v">' + inr(Math.max(totalOutstanding(), 0)) + '</div></div>' +
      '</div>' +
      '<div class="pcd-note">Card swipes count in your spending budget but only leave your bank balance when you tap <b>Pay bill</b>. Your card EMIs stay in the Plan tab and are never counted twice.</div>';

    if (!cards.length) {
      return head + sum +
        '<div class="pcd-empty">No cards yet. Add a card to track its spend, outstanding and bill.</div>' +
        '<button class="pcd-add" onclick="PaisaCards.openForm()">+ Add a credit card</button>';
    }
    return head + sum + cards.map(cardBlock).join("") +
      '<button class="pcd-add" onclick="PaisaCards.openForm()">+ Add a credit card</button>';
  }

  /* --------------------------------------------------------- add-card form */
  function openForm() {
    styles();
    var scrim = document.getElementById("scrim");
    if (!scrim) return;
    scrim.innerHTML =
      '<div class="sheet">' +
      '<h3>Add credit card <button class="x" onclick="PaisaCards.closeForm()">✕</button></h3>' +
      '<div class="pcd-lbl">Card name</div>' +
      '<input class="pcd-inp" id="pcd-name" placeholder="e.g. HDFC Millennia">' +
      '<div class="pcd-lbl">Last 4 digits <span style="color:var(--faint,#5C6880)">(optional, helps auto-match SMS)</span></div>' +
      '<input class="pcd-inp" id="pcd-last4" inputmode="numeric" maxlength="4" placeholder="1234">' +
      '<div class="pcd-lbl">Bill due day of month <span style="color:var(--faint,#5C6880)">(optional)</span></div>' +
      '<input class="pcd-inp" id="pcd-due" inputmode="numeric" placeholder="e.g. 5">' +
      '<button class="pcd-add" onclick="PaisaCards.add()">Add card</button>' +
      '<button class="pcd-del" style="display:block;margin:10px auto 0" onclick="PaisaCards.closeForm()">Cancel</button>' +
      '</div>';
    scrim.classList.add("on");
    setTimeout(function () { var e = document.getElementById("pcd-name"); if (e) e.focus(); }, 120);
  }
  function closeForm() { var s = document.getElementById("scrim"); if (s) { s.classList.remove("on"); s.innerHTML = ""; } }

  function add() {
    var name = (document.getElementById("pcd-name").value || "").trim();
    if (!name) { toastMsg("Enter a card name"); return; }
    var last4 = (document.getElementById("pcd-last4").value || "").replace(/\D/g, "").slice(-4);
    var due = parseInt(document.getElementById("pcd-due").value, 10) || 0;
    cards.push({ id: "c" + Date.now() + Math.random().toString(36).slice(2, 5), name: name, last4: last4, dueDay: due, addedTs: Date.now() });
    save(); closeForm(); if (typeof render === "function") render();
  }

  function remove(id) {
    cards = cards.filter(function (c) { return c.id !== id; });
    save(); if (typeof render === "function") render();
  }

  /* ---------------------------------------------------------- pay the bill */
  function payBill(id) {
    styles();
    var c = cards.find(function (x) { return x.id === id; });
    if (!c) return;
    var def = Math.max(outstanding(id), 0);
    var scrim = document.getElementById("scrim");
    if (!scrim) return;
    scrim.innerHTML =
      '<div class="sheet">' +
      '<h3>Pay ' + esc(c.name) + ' bill <button class="x" onclick="PaisaCards.closeForm()">✕</button></h3>' +
      '<div class="pcd-note" style="margin-top:2px">This reduces your bank balance and the card\'s outstanding. It is a settlement, not a new expense — it won\'t affect your spending budget.</div>' +
      '<div class="pcd-lbl">Amount paid (₹)</div>' +
      '<input class="pcd-inp" id="pcd-pay" type="number" inputmode="decimal" value="' + (def || "") + '" placeholder="e.g. ' + (def || 5000) + '">' +
      '<div class="pcd-lbl">Date</div>' +
      '<input class="pcd-inp" id="pcd-date" type="date" value="' + today() + '">' +
      '<button class="pcd-add" onclick="PaisaCards.confirmPay(\'' + id + '\')">Record payment</button>' +
      '<button class="pcd-del" style="display:block;margin:10px auto 0" onclick="PaisaCards.closeForm()">Cancel</button>' +
      '</div>';
    scrim.classList.add("on");
  }

  async function confirmPay(id) {
    var amt = parseFloat(document.getElementById("pcd-pay").value);
    if (!amt || amt <= 0) { toastMsg("Enter the amount paid"); return; }
    var date = document.getElementById("pcd-date").value || today();
    var c = cards.find(function (x) { return x.id === id; });
    var t = {
      id: "s" + Date.now() + Math.random().toString(36).slice(2, 6),
      amount: Math.round(amt * 100) / 100,
      category: "ccpay", note: "Card payment" + (c ? " · " + c.name : ""),
      date: date, ts: Date.now(),
      method: "settle", settle: true, cardId: id
    };
    if (typeof TX !== "undefined") TX.push(t);
    if (typeof S !== "undefined") S.balance = (+S.balance || 0) - t.amount;   // money leaves the bank now
    if (typeof saveTx === "function") await saveTx();
    if (typeof saveSettings === "function") await saveSettings();
    closeForm();
    toastMsg(inr(t.amount) + " bill paid");
    if (typeof render === "function") render();
  }

  window.PaisaCards = {
    view: view,
    list: function () { return cards.map(function (c) { return { id: c.id, name: c.name, last4: c.last4 }; }); },
    byLast4: function (l4) { var c = cards.find(function (x) { return x.last4 && x.last4 === String(l4).slice(-4); }); return c ? c.id : ""; },
    openForm: openForm, closeForm: closeForm, add: add, remove: remove,
    payBill: payBill, confirmPay: confirmPay,
    outstanding: outstanding, spendThisMonth: spendThisMonth
  };
})();
