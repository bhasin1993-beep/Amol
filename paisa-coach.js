/* ============================================================================
   paisa-coach.js — Financial planner, coach & AI expert for Paisa
   ----------------------------------------------------------------------------
   Three things in one tab:
     1. Overspend prompts  — alerts (and a phone notification on Android) when
        you cross your safe-to-spend / monthly budget.
     2. Built-in coach     — offline, rule-based guidance: emergency fund,
        asset allocation, savings rate, SIP step-up, corpus projection, and a
        goal-gap calculator (required SIP to hit a target corpus).
     3. Ask the expert     — an AI chat (Claude) that answers using a snapshot
        of YOUR Paisa data. Your API key is stored only on this device.

   Reads (does not modify) the app globals S / compute() and PaisaInvest.
   Storage:  paisa_coach -> {age,risk,retireAge,expReturn,goals[],aiKey,aiModel}
   ========================================================================== */
(function () {
  "use strict";

  var K = "paisa_coach";
  var C = loadCfg();
  var chat = [];            // {role:"user"|"assistant", text}
  var busy = false;
  var lastOverspendDay = null;

  function loadCfg() {
    var d = { age: 30, risk: "balanced", retireAge: 60, expReturn: 12, goals: [], aiKey: "", aiModel: "claude-opus-4-8" };
    try { return Object.assign(d, JSON.parse(localStorage.getItem(K)) || {}); } catch (e) { return d; }
  }
  function saveCfg() { try { localStorage.setItem(K, JSON.stringify(C)); } catch (e) {} }

  function inr(n) { return "₹" + Math.round(n || 0).toLocaleString("en-IN"); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function toastMsg(m) { if (typeof toast === "function") toast(m); }

  /* ===================================================== SNAPSHOT of data */
  function invest() {
    return (window.PaisaInvest && PaisaInvest.snapshot)
      ? PaisaInvest.snapshot()
      : { invested: 0, value: 0, gain: 0, dayChange: 0, count: 0, funds: [] };
  }
  function snapshot() {
    var c = (typeof compute === "function") ? compute() : null;
    var s = (typeof S !== "undefined" && S) ? S : {};
    var iv = invest();
    var emis = (s.emis || []).filter(function (e) { return (+e.amount || 0) > 0; });
    return {
      monthlyIncome: c ? Math.round(c.income) : 0,
      fixedMonthly: c ? Math.round(c.fixed) : 0,
      discretionary: c ? Math.round(c.discretionary) : 0,
      spentThisMonth: c ? Math.round(c.spentMonth) : 0,
      safeToSpendToday: c ? Math.round(c.safeToday) : 0,
      savingsGoalMonthly: +s.savingsGoal || 0,
      cashBalance: Math.round(+s.balance || 0),
      liquidSavings: Math.round(+s.savings || 0),
      epfBalance: Math.round(+s.pfBalance || 0),
      epfMonthly: Math.round(+s.pfMonthly || 0),
      emis: emis.map(function (e) { return { name: e.name || "EMI", amount: +e.amount || 0, endsMonth: e.end || null }; }),
      insurance: (s.insurance || []).filter(function (x) { return (+x.premium || 0) > 0 || x.name; })
        .map(function (x) { return { name: x.name, cover: +x.cover || 0, premium: +x.premium || 0, freq: x.freq }; }),
      investments: { invested: iv.invested, currentValue: iv.value, gain: iv.gain, funds: iv.funds },
      profile: { age: C.age, riskAppetite: C.risk, retireAge: C.retireAge, expectedReturnPct: C.expReturn },
      goals: C.goals
    };
  }

  /* ============================================ FUTURE-VALUE / CORPUS MATH */
  function fv(currentCorpus, monthlySIP, years, annualPct) {
    var r = (annualPct / 100) / 12, n = years * 12;
    var growCur = currentCorpus * Math.pow(1 + r, n);
    var growSIP = r > 0 ? monthlySIP * ((Math.pow(1 + r, n) - 1) / r) * (1 + r) : monthlySIP * n;
    return growCur + growSIP;
  }
  // monthly SIP needed to reach `target` in `years`, given current corpus
  function requiredSIP(target, currentCorpus, years, annualPct) {
    var r = (annualPct / 100) / 12, n = years * 12;
    var fromCur = currentCorpus * Math.pow(1 + r, n);
    var need = target - fromCur;
    if (need <= 0) return 0;
    var factor = r > 0 ? ((Math.pow(1 + r, n) - 1) / r) * (1 + r) : n;
    return need / factor;
  }
  function currentCorpus() {
    var iv = invest();
    var s = (typeof S !== "undefined" && S) ? S : {};
    return (iv.value || 0) + (+s.savings || 0) + (+s.pfBalance || 0);
  }

  /* =================================================== RULE-BASED ADVICE */
  function advice() {
    var out = [];
    var snap = snapshot();
    var income = snap.monthlyIncome;
    var iv = snap.investments;

    // 1. Emergency fund
    var monthlyNeed = snap.fixedMonthly + Math.max(snap.spentThisMonth, snap.discretionary * 0.6);
    var target = monthlyNeed * 6;
    var have = snap.liquidSavings + Math.max(snap.cashBalance, 0);
    if (monthlyNeed > 0) {
      if (have < target) {
        out.push({ icon: "🛟", tone: "warn", title: "Build your emergency fund",
          body: "Aim for ~6 months of expenses (" + inr(target) + "). You have about " + inr(have) +
            ". Park the gap in a liquid fund or sweep-in FD before investing more aggressively." });
      } else {
        out.push({ icon: "✅", tone: "good", title: "Emergency fund looks healthy",
          body: "You're around " + inr(have) + ", covering ~6 months. Keep it liquid and separate from investments." });
      }
    }

    // 2. Savings rate
    if (income > 0) {
      var saved = income - snap.spentThisMonth - snap.fixedMonthly + 0; // rough
      var rate = Math.round((income - snap.spentThisMonth) / income * 100);
      out.push({ icon: "📈", tone: rate >= 20 ? "good" : "warn", title: "Savings rate ≈ " + rate + "%",
        body: rate >= 20 ? "Solid — a 20%+ savings rate compounds fast. Consider a step-up SIP to put it to work."
          : "Try to push toward 20%+. Automate a SIP on payday so saving happens before spending." });
    }

    // 3. Asset allocation (rule of thumb by age + risk)
    var equityTarget = Math.max(30, Math.min(80, 100 - C.age + (C.risk === "aggressive" ? 10 : C.risk === "cautious" ? -10 : 0)));
    var equityNow = iv.currentValue;
    var debtish = snap.liquidSavings + snap.epfBalance;
    var totalInv = equityNow + debtish;
    if (totalInv > 0) {
      var eqPct = Math.round(equityNow / totalInv * 100);
      out.push({ icon: "⚖️", tone: "info", title: "Equity allocation ≈ " + eqPct + "% (target ~" + equityTarget + "%)",
        body: eqPct < equityTarget - 10 ? "You're light on equity for your age/risk. Direct new SIPs to diversified equity funds."
          : eqPct > equityTarget + 10 ? "You're equity-heavy. Make sure you have enough debt/EPF cushion for near-term goals."
          : "Allocation is roughly in line with your age and risk appetite." });
    }

    // 4. Term + health insurance
    var hasTerm = snap.insurance.some(function (x) { return /term|life/i.test(x.name || ""); });
    var hasHealth = snap.insurance.some(function (x) { return /health|medi|mediclaim/i.test(x.name || ""); });
    if (income > 0 && !hasTerm) out.push({ icon: "🛡️", tone: "warn", title: "Add term life cover",
      body: "If anyone depends on your income, a pure term plan of ~10–15× annual income (" + inr(income * 12 * 12) + "+) is cheap and essential." });
    if (!hasHealth) out.push({ icon: "🏥", tone: "warn", title: "Get health insurance",
      body: "A standalone health policy (₹5–10L cover) protects your savings from a medical shock — separate from any employer cover." });

    // 5. Corpus projection to retirement
    var yrs = Math.max(1, C.retireAge - C.age);
    var monthlySIPnow = (iv.invested > 0 ? Math.max(snap.savingsGoalMonthly, 0) : snap.savingsGoalMonthly) || snap.discretionary * 0.2;
    var projected = fv(currentCorpus(), monthlySIPnow, yrs, C.expReturn);
    out.push({ icon: "🌱", tone: "info", title: "Retirement corpus projection",
      body: "At " + C.expReturn + "%/yr for " + yrs + " years, your current corpus plus ~" + inr(monthlySIPnow) +
        "/mo could grow to about " + inr(projected) + ". Increase the SIP ~10% yearly to beat inflation." });

    return out;
  }

  /* ====================================================== OVERSPEND PROMPT */
  async function nativeNotify(title, body) {
    var p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
    if (p) {
      try {
        if (p.requestPermissions) { var perm = await p.requestPermissions(); if (perm && perm.display && perm.display !== "granted") return; }
        await p.schedule({ notifications: [{ id: Date.now() % 100000, title: title, body: body, schedule: { at: new Date(Date.now() + 300) } }] });
        return;
      } catch (e) { /* fall through to web */ }
    }
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try { new Notification(title, { body: body }); } catch (e) {}
    }
  }

  // Called by index.html commitAdd() and by the auto-detect confirm flow.
  function onSpend(t) {
    var c = (typeof compute === "function") ? compute() : null;
    if (!c) return;
    var today = (typeof todayStr === "function") ? todayStr() : new Date().toDateString();
    if (c.safeToday < 0) {
      var over = Math.abs(Math.round(c.safeToday));
      toastMsg("⚠️ " + inr(over) + " over today's safe spend");
      if (lastOverspendDay !== today) {       // one phone nudge per day
        lastOverspendDay = today;
        nativeNotify("Over budget today",
          "You're " + inr(over) + " past your safe-to-spend. " +
          (c.remainingMonth > 0 ? "₹" + Math.round(c.remainingMonth).toLocaleString("en-IN") + " left for the month." : "You've used up this month's budget."));
      }
    } else if (c.discretionary > 0 && c.spentMonth > c.discretionary) {
      toastMsg("⚠️ Monthly budget exceeded");
    }
  }

  /* ============================================================ AI EXPERT */
  function aiConfigured() { return !!(C.aiKey && C.aiKey.trim()); }

  async function askExpert(question) {
    if (!aiConfigured()) { toastMsg("Add your API key first"); return; }
    chat.push({ role: "user", text: question });
    busy = true; renderChat();
    var sys =
      "You are Paisa's in-app financial coach for an Indian user. Give practical, specific, India-aware " +
      "personal-finance guidance (SIPs, mutual funds, EPF/PPF/NPS, term & health insurance, emergency fund, " +
      "tax under Indian rules, debt payoff). Be concise and use ₹. When you suggest specific investments, add a " +
      "one-line note that this is educational, not SEBI-registered advice. Use the user's data below; if something " +
      "is missing, say what they should add in the app.\n\nUSER DATA (JSON):\n" + JSON.stringify(snapshot());
    var msgs = chat.map(function (m) { return { role: m.role, content: m.text }; });
    try {
      var r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": C.aiKey.trim(),
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({ model: C.aiModel || "claude-opus-4-8", max_tokens: 1200, system: sys, messages: msgs })
      });
      var j = await r.json();
      if (!r.ok) {
        var em = (j && j.error && j.error.message) || ("HTTP " + r.status);
        chat.push({ role: "assistant", text: "⚠️ " + em + (r.status === 401 ? " — check your API key in settings." : "") });
      } else {
        var text = (j.content || []).filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join("\n").trim();
        chat.push({ role: "assistant", text: text || "(no answer)" });
      }
    } catch (e) {
      chat.push({ role: "assistant", text: "⚠️ Couldn't reach the AI service. Check your internet connection." });
    }
    busy = false; renderChat();
  }

  /* ================================================================ VIEW */
  function styles() {
    if (document.getElementById("pc-css")) return;
    var s = document.createElement("style");
    s.id = "pc-css";
    s.textContent =
      ".pc-h{font-family:var(--disp,sans-serif);font-size:20px;margin:2px 4px}" +
      ".pc-sub{color:var(--muted,#8B97AD);font-size:13px;margin:2px 4px 12px}" +
      ".pc-tabs{display:flex;gap:6px;margin:0 0 12px}" +
      ".pc-tab{flex:1;border:1px solid var(--line2,rgba(255,255,255,.14));background:transparent;color:var(--ink,#ECE8DF);border-radius:11px;padding:9px;font-family:var(--disp,sans-serif);font-weight:600;font-size:13px;cursor:pointer}" +
      ".pc-tab.on{background:var(--surf3,#243352);border-color:var(--brass,#E0A75E);color:var(--brass,#E0A75E)}" +
      ".pc-card{background:var(--surf,#172134);border:1px solid var(--line,rgba(255,255,255,.08));border-radius:16px;padding:13px 14px;margin-bottom:10px}" +
      ".pc-card.warn{border-color:rgba(232,118,92,.5)}.pc-card.good{border-color:rgba(79,182,164,.45)}" +
      ".pc-card .t{font-weight:600;font-size:15px;margin-bottom:3px}" +
      ".pc-card .b{color:var(--muted,#8B97AD);font-size:13px;line-height:1.5}" +
      ".pc-inp{width:100%;background:var(--surf2,#1E2A41);color:var(--ink,#ECE8DF);border:1px solid var(--line2,rgba(255,255,255,.14));border-radius:11px;padding:11px;font-size:14px;margin:5px 0;font-family:var(--body,sans-serif)}" +
      ".pc-lbl{font-size:12px;color:var(--muted,#8B97AD);margin:8px 2px 0}" +
      ".pc-btn{width:100%;background:var(--brass,#E0A75E);color:#1c1303;border:none;border-radius:12px;padding:12px;font-family:var(--disp,sans-serif);font-weight:600;font-size:14px;cursor:pointer;margin-top:6px}" +
      ".pc-btn.alt{background:var(--surf2,#1E2A41);color:var(--ink,#ECE8DF);border:1px solid var(--line2,rgba(255,255,255,.14))}" +
      ".pc-row2{display:flex;gap:8px}.pc-row2>*{flex:1}" +
      ".pc-msg{padding:10px 12px;border-radius:14px;margin-bottom:8px;font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word}" +
      ".pc-msg.u{background:var(--surf3,#243352);margin-left:32px}" +
      ".pc-msg.a{background:var(--surf,#172134);border:1px solid var(--line,rgba(255,255,255,.08));margin-right:16px}" +
      ".pc-chatwrap{min-height:120px;max-height:46vh;overflow:auto;margin:6px 0 8px}" +
      ".pc-big{font-family:var(--mono,monospace);font-size:24px;font-weight:600;margin:4px 0}" +
      ".pc-hint{color:var(--faint,#5C6880);font-size:12px;margin:8px 2px}" +
      ".pc-goal{display:flex;justify-content:space-between;align-items:center;background:var(--surf2,#1E2A41);border:1px solid var(--line,rgba(255,255,255,.08));border-radius:12px;padding:10px 12px;margin-bottom:8px;font-size:13px}";
    document.head.appendChild(s);
  }

  var sub = "coach"; // coach | corpus | expert

  function view() {
    styles();
    var head = '<div class="pc-h">Financial coach</div><div class="pc-sub">Your planner, expert &amp; overspend alerts</div>' +
      '<div class="pc-tabs">' +
      '<button class="pc-tab ' + (sub === "coach" ? "on" : "") + '" onclick="PaisaCoach.tab(\'coach\')">Coach</button>' +
      '<button class="pc-tab ' + (sub === "corpus" ? "on" : "") + '" onclick="PaisaCoach.tab(\'corpus\')">Corpus</button>' +
      '<button class="pc-tab ' + (sub === "expert" ? "on" : "") + '" onclick="PaisaCoach.tab(\'expert\')">Ask expert</button>' +
      '</div>';
    if (sub === "corpus") return head + corpusView();
    if (sub === "expert") return head + expertView();
    return head + coachView();
  }

  function coachView() {
    var profile =
      '<div class="pc-card"><div class="t">Your profile</div>' +
      '<div class="pc-row2"><div><div class="pc-lbl">Age</div><input class="pc-inp" id="pc-age" type="number" value="' + C.age + '"></div>' +
      '<div><div class="pc-lbl">Retire at</div><input class="pc-inp" id="pc-ret" type="number" value="' + C.retireAge + '"></div></div>' +
      '<div class="pc-lbl">Risk appetite</div>' +
      '<select class="pc-inp" id="pc-risk">' +
        ['cautious', 'balanced', 'aggressive'].map(function (x) { return '<option value="' + x + '"' + (C.risk === x ? ' selected' : '') + '>' + x[0].toUpperCase() + x.slice(1) + '</option>'; }).join("") +
      '</select>' +
      '<button class="pc-btn" onclick="PaisaCoach.saveProfile()">Save &amp; refresh advice</button></div>';
    var cards = advice().map(function (a) {
      return '<div class="pc-card ' + (a.tone === "warn" ? "warn" : a.tone === "good" ? "good" : "") + '">' +
        '<div class="t">' + a.icon + ' ' + esc(a.title) + '</div><div class="b">' + esc(a.body) + '</div></div>';
    }).join("");
    return profile + cards;
  }

  function corpusView() {
    var cc = currentCorpus();
    var goalsHTML = (C.goals || []).map(function (g, i) {
      var req = requiredSIP(g.target, cc, g.years, C.expReturn);
      return '<div class="pc-goal"><div><b>' + esc(g.name) + '</b><br><span style="color:var(--muted,#8B97AD)">' +
        inr(g.target) + " in " + g.years + "y · need " + inr(req) + "/mo</span></div>" +
        '<button class="pc-btn alt" style="width:auto;margin:0;padding:6px 10px" onclick="PaisaCoach.delGoal(' + i + ')">✕</button></div>';
    }).join("");
    return '<div class="pc-card"><div class="t">Corpus today</div>' +
      '<div class="pc-big">' + inr(cc) + '</div>' +
      '<div class="b">Investments + savings + EPF. Set your expected return and add goals to see the SIP needed.</div>' +
      '<div class="pc-lbl">Expected return (%/yr)</div>' +
      '<input class="pc-inp" id="pc-er" type="number" value="' + C.expReturn + '" onchange="PaisaCoach.saveER()"></div>' +
      '<div class="pc-card"><div class="t">Goal planner</div>' +
      (goalsHTML || '<div class="pc-hint">No goals yet — add one below.</div>') +
      '<div class="pc-lbl">Goal name</div><input class="pc-inp" id="pc-gn" placeholder="e.g. Child education">' +
      '<div class="pc-row2"><div><div class="pc-lbl">Target ₹</div><input class="pc-inp" id="pc-gt" type="number" placeholder="3000000"></div>' +
      '<div><div class="pc-lbl">Years</div><input class="pc-inp" id="pc-gy" type="number" placeholder="10"></div></div>' +
      '<button class="pc-btn" onclick="PaisaCoach.addGoal()">Add goal</button></div>';
  }

  function expertView() {
    if (!aiConfigured()) {
      return '<div class="pc-card"><div class="t">🔑 Connect the AI expert</div>' +
        '<div class="b">Paste your Anthropic API key to chat with an AI financial expert that knows your Paisa data. ' +
        'The key is stored only on this device and sent directly to Anthropic. Get one at console.anthropic.com.</div>' +
        '<div class="pc-lbl">Anthropic API key</div><input class="pc-inp" id="pc-key" placeholder="sk-ant-..." type="password">' +
        '<div class="pc-lbl">Model</div><select class="pc-inp" id="pc-model">' +
          [['claude-opus-4-8', 'Opus 4.8 — most capable'], ['claude-sonnet-4-6', 'Sonnet 4.6 — balanced, cheaper'], ['claude-haiku-4-5', 'Haiku 4.5 — fastest, cheapest']]
            .map(function (m) { return '<option value="' + m[0] + '"' + (C.aiModel === m[0] ? ' selected' : '') + '>' + m[1] + '</option>'; }).join("") +
        '</select>' +
        '<button class="pc-btn" onclick="PaisaCoach.saveKey()">Save &amp; start chatting</button></div>';
    }
    return '<div class="pc-card"><div class="t">💬 Ask the expert</div>' +
      '<div id="pc-chat" class="pc-chatwrap">' + chatHTML() + '</div>' +
      '<textarea class="pc-inp" id="pc-q" rows="2" placeholder="e.g. Where should I invest my next ₹10,000/month?"></textarea>' +
      '<button class="pc-btn" id="pc-send" onclick="PaisaCoach.send()"' + (busy ? ' disabled' : '') + '>' + (busy ? "Thinking…" : "Ask") + '</button>' +
      '<button class="pc-btn alt" onclick="PaisaCoach.settings()">Change key / model</button>' +
      '<div class="pc-hint">Educational guidance, not SEBI-registered advice.</div></div>';
  }

  function chatHTML() {
    if (!chat.length) return '<div class="pc-hint">Ask anything about your money — budgeting, SIPs, insurance, taxes, goals. I can see your Paisa numbers.</div>';
    return chat.map(function (m) {
      return '<div class="pc-msg ' + (m.role === "user" ? "u" : "a") + '">' + esc(m.text) + '</div>';
    }).join("") + (busy ? '<div class="pc-msg a">…</div>' : "");
  }
  function renderChat() {
    var el = document.getElementById("pc-chat");
    if (el) { el.innerHTML = chatHTML(); el.scrollTop = el.scrollHeight; }
    var b = document.getElementById("pc-send");
    if (b) { b.disabled = busy; b.textContent = busy ? "Thinking…" : "Ask"; }
  }

  /* ------------------------------------------------------------ handlers */
  function tab(t) { sub = t; if (typeof render === "function") render(); }
  function saveProfile() {
    C.age = Math.max(15, Math.min(90, +document.getElementById("pc-age").value || C.age));
    C.retireAge = Math.max(C.age + 1, Math.min(99, +document.getElementById("pc-ret").value || C.retireAge));
    C.risk = document.getElementById("pc-risk").value || C.risk;
    saveCfg(); toastMsg("Saved"); if (typeof render === "function") render();
  }
  function saveER() { var v = +document.getElementById("pc-er").value; if (v > 0) { C.expReturn = v; saveCfg(); } }
  function addGoal() {
    var n = document.getElementById("pc-gn").value.trim();
    var t = +document.getElementById("pc-gt").value || 0;
    var y = +document.getElementById("pc-gy").value || 0;
    if (!n || t <= 0 || y <= 0) { toastMsg("Fill goal, target and years"); return; }
    C.goals.push({ name: n, target: t, years: y }); saveCfg(); if (typeof render === "function") render();
  }
  function delGoal(i) { C.goals.splice(i, 1); saveCfg(); if (typeof render === "function") render(); }
  function saveKey() {
    var k = document.getElementById("pc-key").value.trim();
    var m = document.getElementById("pc-model").value;
    if (!k) { toastMsg("Paste a key"); return; }
    C.aiKey = k; C.aiModel = m; saveCfg(); if (typeof render === "function") render();
  }
  function settings() { C.aiKey = ""; saveCfg(); if (typeof render === "function") render(); }
  function send() {
    var q = document.getElementById("pc-q");
    var v = (q.value || "").trim();
    if (!v || busy) return;
    q.value = "";
    askExpert(v);
  }

  function afterRender() {
    var el = document.getElementById("pc-chat");
    if (el) el.scrollTop = el.scrollHeight;
  }

  window.PaisaCoach = {
    view: view, afterRender: afterRender, onSpend: onSpend,
    tab: tab, saveProfile: saveProfile, saveER: saveER, addGoal: addGoal, delGoal: delGoal,
    saveKey: saveKey, settings: settings, send: send
  };
})();
