/* ============================================================================
   paisa-backup.js — Backup & Restore for Paisa
   ----------------------------------------------------------------------------
   Exports every Paisa data key (settings, transactions, cards, investments,
   coach config, auto-detect state) to a single JSON file so nothing is lost
   when you reinstall or switch phones, and restores it back.

   On Android the export is written to a file and opened in the share sheet
   (save to Drive / Files / email). On the web it downloads. A copy-to-text
   fallback always works. Restore accepts a picked file or pasted text.
   Everything stays on the device — there is no server.
   ========================================================================== */
(function () {
  "use strict";

  function toastMsg(m) { if (typeof toast === "function") toast(m); else alert(m); }

  function collect() {
    var data = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf("paisa_") === 0) data[k] = localStorage.getItem(k);
    }
    return { app: "paisa", v: 1, exportedAt: new Date().toISOString(), data: data };
  }
  function payload() { return JSON.stringify(collect(), null, 2); }
  function filename() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, "0"); };
    return "paisa-backup-" + d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + ".json";
  }

  function plugins() { return (window.Capacitor && window.Capacitor.Plugins) || {}; }
  function isNative() { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); }

  /* ------------------------------------------------------------- EXPORT */
  async function exportData() {
    var json = payload();
    var name = filename();

    // Android: write a real file and open the share sheet
    if (isNative() && plugins().Filesystem && plugins().Share) {
      try {
        var Filesystem = plugins().Filesystem, Share = plugins().Share;
        var res = await Filesystem.writeFile({ path: name, data: json, directory: "CACHE", encoding: "utf8" });
        var uri = (res && res.uri) ? res.uri : null;
        if (!uri && Filesystem.getUri) { var g = await Filesystem.getUri({ path: name, directory: "CACHE" }); uri = g && g.uri; }
        await Share.share({ title: "Paisa backup", text: "Your Paisa data backup", url: uri, dialogTitle: "Save your Paisa backup" });
        toastMsg("Backup ready — save it somewhere safe");
        return;
      } catch (e) { /* fall through to download / copy */ }
    }

    // Web: download
    try {
      var blob = new Blob([json], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 500);
      toastMsg("Backup downloaded");
      return;
    } catch (e) { /* fall through to copy sheet */ }

    showTextSheet(json);
  }

  function showTextSheet(json) {
    var scrim = document.getElementById("scrim"); if (!scrim) return;
    scrim.innerHTML =
      '<div class="sheet"><h3>Copy your backup <button class="x" onclick="PaisaBackup.close()">✕</button></h3>' +
      '<div style="color:var(--muted);font-size:13px;margin-bottom:8px">Couldn\'t save a file here. Copy this text and paste it into Notes / a file you keep safe.</div>' +
      '<textarea id="pb-out" class="inp" style="height:160px;font-family:var(--mono);font-size:11px" readonly></textarea>' +
      '<button class="save-btn" onclick="PaisaBackup.copy()">Copy to clipboard</button></div>';
    scrim.classList.add("on");
    var ta = document.getElementById("pb-out"); if (ta) ta.value = json;
  }
  async function copy() {
    var ta = document.getElementById("pb-out");
    var text = ta ? ta.value : payload();
    try { await navigator.clipboard.writeText(text); toastMsg("Copied"); }
    catch (e) { if (ta) { ta.select(); document.execCommand && document.execCommand("copy"); toastMsg("Selected — long-press Copy"); } }
  }

  /* ------------------------------------------------------------- RESTORE */
  function openRestore() {
    var scrim = document.getElementById("scrim"); if (!scrim) return;
    scrim.innerHTML =
      '<div class="sheet"><h3>Restore backup <button class="x" onclick="PaisaBackup.close()">✕</button></h3>' +
      '<div style="color:var(--coral);font-size:13px;margin-bottom:10px">This replaces all current data in the app with the backup. Make sure you picked the right file.</div>' +
      '<label class="save-btn" style="display:block;text-align:center;background:var(--surf2);color:var(--ink);border:1px solid var(--line2);margin:0 0 10px">Choose backup file' +
        '<input type="file" id="pb-file" accept="application/json,.json" style="display:none"></label>' +
      '<div style="color:var(--muted);font-size:12px;margin:6px 2px">…or paste backup text:</div>' +
      '<textarea id="pb-in" class="inp" style="height:120px;font-family:var(--mono);font-size:11px" placeholder=\'{"app":"paisa",...}\'></textarea>' +
      '<button class="save-btn" onclick="PaisaBackup.restorePaste()">Restore from text</button></div>';
    scrim.classList.add("on");
    var fi = document.getElementById("pb-file");
    if (fi) fi.addEventListener("change", function () {
      var f = fi.files && fi.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () { applyRestore(String(r.result)); };
      r.onerror = function () { toastMsg("Couldn't read that file"); };
      r.readAsText(f);
    });
  }
  function restorePaste() {
    var ta = document.getElementById("pb-in");
    var v = ta ? ta.value.trim() : "";
    if (!v) { toastMsg("Paste your backup text first"); return; }
    applyRestore(v);
  }

  function applyRestore(text) {
    var obj;
    try { obj = JSON.parse(text); } catch (e) { toastMsg("That isn't valid backup data"); return; }
    if (!obj || obj.app !== "paisa" || !obj.data) { toastMsg("Not a Paisa backup file"); return; }
    var keys = Object.keys(obj.data);
    if (!keys.length) { toastMsg("Backup is empty"); return; }
    try {
      // clear existing paisa_* keys, then write the backup
      var existing = [];
      for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf("paisa_") === 0) existing.push(k); }
      existing.forEach(function (k) { localStorage.removeItem(k); });
      keys.forEach(function (k) { localStorage.setItem(k, obj.data[k]); });
    } catch (e) { toastMsg("Restore failed — storage error"); return; }
    toastMsg("Restored! Reloading…");
    setTimeout(function () { location.reload(); }, 700);
  }

  function close() { var s = document.getElementById("scrim"); if (s) { s.classList.remove("on"); s.innerHTML = ""; } }

  window.PaisaBackup = {
    exportData: exportData, openRestore: openRestore, restorePaste: restorePaste,
    copy: copy, close: close
  };
})();
