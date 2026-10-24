/* app.js - tv.html put together: the settings, the layout of one to four charts (each with its own timeframe,
 * chart type and indicators, all on the one replay clock and one instrument), the top bar (symbol, timeframes, chart
 * type, indicators, replay, undo, layout, settings, snapshot, trading), the bar under the charts (ranges, go to, time
 * zone, %, log, auto), the right bar, menus, the keyboard and the frame loop. */
(function () {
  const { el } = TV;
  const DEF_SET = { theme: "neu", up: "#089981", down: "#f23645", lineColor: "#2962ff", bg: "", grid: true, breaks: true, rthShade: true, countdown: true,
                    plus: true, qt: true, orders: true, fills: true, syncCross: true, quickbar: true, crossWindows: true };
  const LAYOUTS = {
    "1": { n: 1, cols: "1fr", rows: "1fr", name: "1 Chart" },
    "2h": { n: 2, cols: "1fr 1fr", rows: "1fr", name: "2 nebeneinander" },
    "2v": { n: 2, cols: "1fr", rows: "1fr 1fr", name: "2 übereinander" },
    "3l": { n: 3, cols: "1.7fr 1fr", rows: "1fr 1fr", areas: '"a b" "a c"', name: "1 groß + 2" },
    "3h": { n: 3, cols: "1fr 1fr 1fr", rows: "1fr", name: "3 nebeneinander" },
    "4": { n: 4, cols: "1fr 1fr", rows: "1fr 1fr", name: "2 × 2" },
    "4l": { n: 4, cols: "1.9fr 1fr", rows: "1fr 1fr 1fr", areas: '"a b" "a c" "a d"', name: "1 groß + 3" },
  };
  const NEW_TFS = [5, 30, 240, 1440, 15, 60];
  const FAV = TV.store.get("tf.fav", [1, 5, 15, 30, 60, 240, 1440]);

  const app = TV.app = {
    settings: Object.assign({}, DEF_SET, TV.store.get("settings", {})),
    charts: [], active: null, handlers: [],
    layout: TV.store.get("layout", null),
  };
  app.inst = () => (RC.state && RC.state.inst) || app._inst || "ES";
  app.saveSettings = () => TV.store.set("settings", app.settings);
  app.saveLayout = () => { if (!app.layout) return; app.layout.panes = app.charts.map(c => c.cfg); app.layout.active = app.charts.indexOf(app.active); TV.store.set("layout", app.layout); };
  app.redrawAll = () => { for (const c of app.charts) c.redraw(); };
  app.defaultCursor = () => TV.Replay.selecting ? "col-resize" : ({ cross: "crosshair", dot: "none", arrow: "default", eraser: "default" })[TV.Draw.cursor] || "crosshair";

  // ---------------------------------------------------------------- panes
  app.buildCharts = function () {
    const host = TV.$("#charts");
    for (const c of app.charts) c.destroy();
    app.charts = [];
    if (!app.layout || !LAYOUTS[app.layout.name]) app.layout = { name: "1", panes: [{ tf: 5, type: "candles", studies: TV.DEFAULT_STUDIES(), scale: { auto: true } }], active: 0 };
    const L = LAYOUTS[app.layout.name];
    host.style.gridTemplateColumns = L.cols; host.style.gridTemplateRows = L.rows; host.style.gridTemplateAreas = L.areas || "";
    host.classList.toggle("single", L.n === 1);
    while (app.layout.panes.length < L.n) {
      const tf = NEW_TFS[app.layout.panes.length] || 15;
      app.layout.panes.push({ tf, type: "candles", studies: tf >= 1440 ? [TV.newStudy("vol"), TV.newStudy("prior"), TV.newStudy("npoc")] : tf >= 240 ? [TV.newStudy("vol"), TV.newStudy("week"), TV.newStudy("npoc")] : TV.DEFAULT_STUDIES(), scale: { auto: true } });
    }
    app.layout.panes.slice(0, L.n).forEach((cfg, i) => {
      const c = new TV.Chart(app, host, cfg);
      if (L.areas) c.el.style.gridArea = "abcd"[i];
      c.addLayer("normal", TV.FP.layer(c));
      c.addLayer("top", TV.Draw.layer(c));
      c.addLayer("top", TV.Trade.layer(c));
      c.addLayer("top", countdownLayer(c));
      c.addLayer("top", TV.Replay.layer(c));
      app.charts.push(c);
    });
    app.active = app.charts[Math.min(app.layout.active || 0, app.charts.length - 1)] || app.charts[0];
    app.charts.forEach(c => c.el.classList.toggle("active", c === app.active));
    app.applyCursor();
    const t = RC.now(); if (t != null) for (const c of app.charts) c.sync(t);
    app.saveLayout(); app.topState(); app.bottomBar();
  };
  app.setLayout = function (name) { app.saveLayout(); app.layout.name = name; app.buildCharts(); };
  app.activate = function (c) {
    if (app.active === c) return;
    app.active = c; app.charts.forEach(x => x.el.classList.toggle("active", x === c)); app.saveLayout(); app.topState(); app.bottomBar();
  };
  const crossCh = ("BroadcastChannel" in window) ? new BroadcastChannel("tv-cross") : null;
  let crossAt = 0, remoteCross = null;
  app.crossSync = function (src, cross) {
    if (app.settings.syncCross) for (const c of app.charts) if (c !== src) c.setCross(cross);
    if (crossCh && app.settings.crossWindows) {                  // the other windows see this cursor (a few times a second)
      const now = performance.now();
      if (!cross || now - crossAt > 40) { crossAt = now; crossCh.postMessage({ inst: app.inst(), cross: cross ? { t: cross.t, p: cross.p } : null }); }
    }
  };
  if (crossCh) crossCh.onmessage = e => {
    if (!app.settings.crossWindows || !e.data || e.data.inst !== app.inst()) return;
    remoteCross = e.data.cross;
    if (app.charts.some(c => c.cross)) return;                   // this window's own mouse wins
    for (const c of app.charts) c.setCross(remoteCross);
  };
  app.applyCursor = function () {
    const m = TV.Draw.cursor, lines = m === "cross", labels = m !== "arrow" && m !== "eraser";
    const pick = TV.Replay.selecting, draw = TV.Draw.busy();   // choosing a bar or drawing: the chart's own crosshair gives way
    for (const c of app.charts) c.chart.applyOptions({ crosshair: { vertLine: { visible: lines && !pick && !draw, labelVisible: labels && !pick && !draw }, horzLine: { visible: lines && !draw, labelVisible: labels && !draw } } });
  };
  app.goTo = function (t) {
    const c = app.active; if (!c || !c.BARS.length) return;
    const i = c.idxOf(t); if (i < 0) { TV.toast("Diese Zeit ist nicht geladen – nach links scrollen lädt ältere Sessions"); return; }
    const r = c.chart.timeScale().getVisibleLogicalRange(), w = r ? r.to - r.from : 150;
    c.chart.timeScale().setVisibleLogicalRange({ from: i - w / 2, to: i + w / 2 });
  };
  function countdownLayer(c) {
    return { axis() {
      if (!app.settings.countdown || c.cfg.type === "tpo") return [];
      const B = c.BARS, now = RC.now(); if (!B.length || now == null) return [];
      const b = B[B.length - 1], rem = b.t + c.tfSec() - now; if (rem <= 0 || rem > c.tfSec()) return [];
      const y = c.yOf(b.c); if (y == null) return [];
      return [{ y: y + 19, text: TV.clock(rem), bg: b.c >= b.o ? app.settings.up : app.settings.down }];
    } };
  }

  // ---------------------------------------------------------------- the top bar
  const tb = (cls, title, content, fn) => { const b = el("button.tb" + (cls ? "." + cls : ""), { title, onclick: e => { e.stopPropagation(); fn(b, e); } }); if (Array.isArray(content)) b.append(...content); else b.append(content); return b; };
  app.top = function () {
    const top = TV.$("#top"); top.replaceChildren();
    app.symBtn = tb("sym", "Symbol suchen", [TV.iconSm("search", 20), el("span", { text: app.inst() })], () => symbolSearch());
    top.append(app.symBtn, el("span.sep"));
    app.tfBox = el("span", { style: { display: "inline-flex", gap: "1px" } }); top.append(app.tfBox);
    top.append(tb("", "Weitere Zeiteinheiten", TV.iconSm("down", 20), b => TV.menu(b, [{ head: "Minuten / Stunden" }].concat(TV.TFS.map(([m, n, long]) => ({ label: long, hint: FAV.includes(m) ? "★" : "☆", on: app.active.cfg.tf === m,
      action: () => app.active.setTf(m) })), [{ sep: true }, { label: "Favoriten bearbeiten …", action: favDialog }]))));
    top.append(el("span.sep"));
    app.typeBtn = tb("", "Chart-Typ", TV.icon("candles"), b => TV.menu(b, TV.CHART_TYPES.map(([k, n, ic]) => ({ label: n, icon: ic, on: app.active.cfg.type === k, action: () => app.active.setType(k) }))));
    top.append(app.typeBtn, el("span.sep"));
    top.append(tb("", "Indikatoren (/)", [TV.icon("fx"), el("span.cap", { text: "Indikatoren" })], () => TV.indicatorDialog(app.active)));
    top.append(el("span.sep"));
    app.replayBtn = tb("", "Replay: einen Bar im Chart wählen, ab dort läuft die Uhr · im Replay: zurück zu Live", [TV.icon("replay"), el("span.cap", { text: "Replay" })], () => TV.Replay.toggle());
    top.append(app.replayBtn, el("span.sep"),
      tb("", "Rückgängig (Strg+Z)", TV.icon("undo"), () => TV.Draw.doUndo()), tb("", "Wiederholen (Strg+Y)", TV.icon("redo"), () => TV.Draw.doRedo()));
    top.append(el("span.grow"));
    app.clockEl = el("span.clockchip", { title: "Replay-Zeit" }); top.append(app.clockEl);
    top.append(tb("", "Layout: mehrere Charts", TV.icon("layout"), b => layoutMenu(b)),
      tb("", "Einstellungen", TV.icon("gear"), () => settingsDialog()),
      tb("", "Vollbild (F11)", TV.icon("full"), () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); }),
      tb("", "Snapshot (Alt+S)", TV.icon("camera"), b => TV.menu(b, [
        { label: "Bild herunterladen", icon: "camera", action: () => shot("download") },
        { label: "Bild kopieren", icon: "clone", hint: "Alt+S", action: () => shot("copy") },
        { label: "In den Screenshot-Ordner speichern", icon: "camera", action: () => shot("server") }], { right: true })),
      tb("trade", "Order-Ticket ein-/ausblenden", el("span", { text: "Handeln" }), () => TV.Trade.openTicket()));
    app.topState();
  };
  app.topState = function () {
    if (!app.tfBox || !app.active) return;
    const c = app.active;
    app.tfBox.replaceChildren(...FAV.map(m => { const b = tb("tf" + (c.cfg.tf === m ? ".on" : ""), (TV.TFS.find(x => x[0] === m) || [0, 0, m + " Minuten"])[2], el("span", { text: TV.tfName(m) }), () => c.setTf(m)); if (c.cfg.type === "tpo" && m !== 30) b.disabled = true; return b; }));
    const ty = TV.CHART_TYPES.find(x => x[0] === c.cfg.type) || TV.CHART_TYPES[0];
    app.typeBtn.replaceChildren(TV.icon(ty[2])); app.typeBtn.title = "Chart-Typ: " + ty[1];
    app.symBtn.lastChild.textContent = app.inst();
    app.replayBtn.classList.toggle("on", TV.Replay.selecting || !TV.Replay.isLive());
  };
  function favDialog() {
    TV.dialog({ title: "Favoriten (Zeiteinheiten in der Leiste)", width: 360, body: b => {
      for (const [m, n, long] of TV.TFS) b.append(el("label.tk-chk", { style: { padding: "5px 0" } }, el("input", { type: "checkbox", checked: FAV.includes(m), onchange: e => {
        if (e.target.checked) { if (!FAV.includes(m)) FAV.push(m); } else FAV.splice(FAV.indexOf(m), 1);
        FAV.sort((a, b) => a - b); TV.store.set("tf.fav", FAV); app.topState(); } }), el("span", { text: long })));
    }, buttons: [{ label: "Fertig", kind: "pri" }] });
  }
  function layoutMenu(anchor) {
    TV.closeMenus();
    const m = TV.menu(anchor, Object.entries(LAYOUTS).map(([k, L]) => ({ label: L.name, on: app.layout.name === k, icon: preview(L), action: () => app.setLayout(k) })).concat([
      { sep: true }, { label: "Fadenkreuz synchronisieren", on: app.settings.syncCross, action: () => { app.settings.syncCross = !app.settings.syncCross; app.saveSettings(); } },
      { label: "Layout zurücksetzen", action: () => { if (confirm("Layout, Zeiteinheiten und Indikatoren aller Charts auf den Anfang setzen?")) { app.layout = null; TV.store.set("layout", null); app.buildCharts(); } } }]), { right: true });
    return m;
  }
  function preview(L) {
    const g = el("span", { style: { display: "grid", width: "22px", height: "16px", gap: "1px", gridTemplateColumns: L.cols, gridTemplateRows: L.rows, gridTemplateAreas: L.areas || "" } });
    for (let i = 0; i < L.n; i++) g.append(el("span", { style: { border: "1px solid currentColor", borderRadius: "1px", gridArea: L.areas ? "abcd"[i] : "" } }));
    return g;
  }
  async function symbolSearch() {
    const insts = await RP.instruments().catch(() => []);
    TV.dialog({ title: "Symbolsuche", width: 520, pad: false, body: (b, close) => {
      const inp = el("input", { placeholder: "Symbol, z. B. ES", autocomplete: "off" }), list = el("div.slist");
      b.append(el("div.search", { style: { paddingTop: "8px" } }, TV.iconSm("search", 20), inp), list);
      let hl = 0, shown = [];
      const pick = s => { RC.send("inst", { inst: s, t: RC.now() }); close(); };
      const render = () => {
        const q = inp.value.trim().toUpperCase(); shown = insts.filter(s => !q || s.includes(q) || TV.spec(s).name.toUpperCase().includes(q));
        list.replaceChildren(el("div.grp", { text: "Im Archiv" }), ...shown.map((s, i) => el("div.si" + (i === hl ? ".hl" : ""), { onclick: () => pick(s) },
          el("span.sn", { text: s }), el("span.sd", { text: TV.spec(s).name + " Futures" }), el("span.sx", { text: "CME · Futures" }))));
        if (!shown.length) list.append(el("div.empty", { text: "Kein Symbol im Archiv" }));
      };
      inp.oninput = () => { hl = 0; render(); };
      inp.onkeydown = e => { if (e.key === "ArrowDown") { hl = Math.min(shown.length - 1, hl + 1); render(); e.preventDefault(); } else if (e.key === "ArrowUp") { hl = Math.max(0, hl - 1); render(); e.preventDefault(); } else if (e.key === "Enter" && shown[hl]) pick(shown[hl]); };
      render(); setTimeout(() => inp.focus(), 0);
    } });
  }

  // ---------------------------------------------------------------- the bar under the charts
  app.bottomBar = function () {
    const bar = TV.$("#cbar"); bar.replaceChildren();
    for (const [n, name] of [[1, "1T"], [3, "3T"], [5, "5T"], [10, "10T"], [20, "1M"]]) bar.append(tb("", `${n} Handelstag${n > 1 ? "e" : ""} zeigen`, el("span", { text: name }), () => app.active.showDays(n)));
    bar.append(el("span.sep"), tb("", "Gehe zu … (Datum und Uhrzeit)", TV.iconSm("cal", 18), b => TV.Replay.calendar(b)));
    bar.append(el("span.grow"));
    app.tzBtn = tb("tz", "Zeitzone der Anzeige (in allen Fenstern)", el("span", { text: "" }), b => TV.menu(b, [["NY", "New York (UTC−5/−4)"], ["Wien", "Wien (UTC+1/+2)"]].map(([k, n]) => ({ label: n, on: RC.tz() === k, action: () => RC.setTz(k) })), { right: true }));
    bar.append(app.tzBtn, el("span.sep"));
    const s = (app.active && app.active.cfg.scale) || {};
    const scaleBtn = (k, name, title) => tb(s[k] || (k === "auto" && s.auto !== false) ? "on" : "", title, el("span", { text: name }), () => {
      const c = app.active, sc = c.cfg.scale = Object.assign({ auto: true }, c.cfg.scale);
      if (k === "auto") sc.auto = !(sc.auto !== false); else { sc[k] = !sc[k]; if (sc[k]) sc[k === "log" ? "pct" : "log"] = false; }
      c.applyScale(); app.saveLayout(); app.bottomBar();
    });
    bar.append(scaleBtn("pct", "%", "Prozentskala"), scaleBtn("log", "log", "Logarithmische Skala"), scaleBtn("auto", "auto", "Automatische Skalierung"));
  };

  // ---------------------------------------------------------------- the floating tool bar on the chart (as TradingView's)
  const QUICK = ["trend", "ray", "hline", "vline", "rect", "brush", "highlighter", "text", "note", "long", "short", "pricerange", "measure"];
  app.quickBar = function () {
    let bar = TV.$("#quickbar");
    if (!app.settings.quickbar) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = el("div.stylebar"); bar.id = "quickbar"; bar.style.display = "flex"; bar.style.transform = "none";
      const pos = TV.store.get("quickbar.pos", null); bar.style.left = (pos ? pos.x : 420) + "px"; bar.style.top = (pos ? pos.y : 48) + "px";
      TV.$("#stage").append(bar);
    }
    bar.replaceChildren();
    const grip = el("span.grip", { title: "Verschieben" }, TV.iconSm("grip", 18));
    grip.addEventListener("pointerdown", e => {
      e.preventDefault(); const st = TV.$("#stage").getBoundingClientRect(), r0 = bar.getBoundingClientRect(), dx = e.clientX - r0.left, dy = e.clientY - r0.top;
      const mv = ev => { const x = Math.max(0, Math.min(st.width - r0.width, ev.clientX - st.left - dx)), y = Math.max(0, Math.min(st.height - r0.height, ev.clientY - st.top - dy)); bar.style.left = x + "px"; bar.style.top = y + "px"; };
      const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); TV.store.set("quickbar.pos", { x: parseFloat(bar.style.left), y: parseFloat(bar.style.top) }); };
      window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
    });
    bar.append(grip);
    for (const t of QUICK) {
      const def = TV.DRAW_TOOLS[t];
      bar.append(el("button" + (TV.Draw.tool === t ? ".on" : ""), { title: def.name + (def.key ? ` (${def.key})` : ""), onclick: e => { e.stopPropagation(); TV.Draw.setTool(TV.Draw.tool === t ? TV.Draw.cursor : t); } }, TV.iconSm(def.icon, 20)));
    }
    bar.append(el("button", { title: "Leiste ausblenden (Einstellungen → Erscheinung)", onclick: () => { app.settings.quickbar = false; app.saveSettings(); app.quickBar(); } }, TV.iconSm("close", 16)));
  };
  TV.on("tool", () => app.quickBar());

  // ---------------------------------------------------------------- the right bar
  app.rightBar = function () {
    const r = TV.$("#right"); r.replaceChildren();
    const w = (icon, title, on, fn) => r.append(el("button.wb" + (on ? ".on" : ""), { title, onclick: fn }, TV.icon(icon)));
    w("trade", "Order-Ticket", document.body.classList.contains("ticket-open"), () => TV.Trade.openTicket());
    w("order", "Handelspanel (Positionen, Orders, Historie)", TV.Trade.bottom.open, () => { TV.Trade.bottom.open = !TV.Trade.bottom.open; TV.store.set("bottom.open", TV.Trade.bottom.open); TV.Trade.renderBottom(); app.rightBar(); });
    w("datawin", "Datenfenster: Bar und Level unter dem Cursor (Volumen, Bid, Ask, Delta)", !!TV.FP.dw, () => TV.FP.dwToggle());
    w("tree", "Objektbaum (Zeichnungen)", false, () => TV.Draw.tree());
    w("fx", "Indikatoren", false, () => TV.indicatorDialog(app.active));
    r.append(el("span", { style: { flex: 1 } }));
    w("folder", "Einstellungen: Archiv-Ordner, was das Archiv enthält, Live-Daten (neuer Tab)", false, () => window.open("/config.html", "_blank"));
    w("kbd", "Tastenkürzel", false, () => keysDialog());
    w("help", "Was ist was", false, () => helpDialog());
  };

  // ---------------------------------------------------------------- menus in the chart
  app.contextMenu = function (c, x, y, e, inPane) {
    app.activate(c);
    const at = { x: e.clientX, y: e.clientY };
    if (!inPane) {
      const sc = c.cfg.scale = Object.assign({ auto: true }, c.cfg.scale);
      TV.menu(at, [{ label: "Automatische Skalierung", on: sc.auto !== false, action: () => { sc.auto = !(sc.auto !== false); c.applyScale(); app.saveLayout(); app.bottomBar(); } },
        { label: "Logarithmisch", on: !!sc.log, action: () => { sc.log = !sc.log; sc.pct = false; c.applyScale(); app.saveLayout(); app.bottomBar(); } },
        { label: "Prozent", on: !!sc.pct, action: () => { sc.pct = !sc.pct; sc.log = false; c.applyScale(); app.saveLayout(); app.bottomBar(); } },
        { sep: true }, { label: "Chart zurücksetzen", hint: "Alt+R", action: () => c.fit() }]);
      return;
    }
    const h = TV.Draw.hitAt(c, x, y); if (h) { TV.Draw.sel = h.d.id; TV.Draw.styleBar(); app.redrawAll(); TV.Draw.menuFor(h.d, at); return; }
    const p = c.pOfY(y); if (p == null) return;
    const price = Math.round(p / c.tick()) * c.tick();
    const bi = c.cross && c.cross.t != null ? c.idxOf(c.cross.t) : -1;
    const fpItems = [{ sep: true }, { label: bi >= 0 ? `Footprint des Bars ${RC.fmtTime(c.BARS[bi].t)} kopieren (CSV)` : "Footprint kopieren (CSV)", icon: "footprint", disabled: bi < 0, action: () => TV.FP.csv(c, bi) }];
    if (c.cfg.type === "footprint") fpItems.push({ label: "Footprint-Einstellungen …", icon: "gear", action: () => TV.FP.settings(c) });
    TV.menu(at, TV.Trade.priceItems(price).concat(drawItems(c, price), fpItems, [{ sep: true },
      { label: "Chart zurücksetzen", hint: "Alt+R", action: () => c.fit() },
      { label: "Indikatoren …", icon: "fx", hint: "/", action: () => TV.indicatorDialog(c) },
      { label: "Objektbaum …", icon: "tree", action: () => TV.Draw.tree() },
      { label: "Zeichnungen entfernen …", icon: "trash", action: () => TV.Draw.removeAllMenu({ getBoundingClientRect: () => ({ left: at.x, right: at.x, top: at.y, bottom: at.y }) }) },
      { sep: true }, { label: "Einstellungen …", icon: "gear", action: () => settingsDialog() }]));
  };
  function drawItems(c, price) {
    const mk = (type, extra) => { const D = TV.Draw; D.snap(); const d = { id: Date.now().toString(36), type, pts: [{ t: c.lastT, p: price }], s: Object.assign(JSON.parse(JSON.stringify(TV.DRAW_TOOLS[type].def)), TV.store.get("draw.style." + type, {}), extra || {}), locked: false, hidden: false }; D.list.push(d); D.sel = d.id; D.save(); };
    return [{ sep: true }, { label: `Horizontale Linie bei ${TV.fp(price, c.tick())}`, icon: "hline", hint: "Alt+H", action: () => mk("hline") },
            { label: `Alarm bei ${TV.fp(price, c.tick())} (Replay anhalten)`, icon: "bell", action: () => { mk("hline", { alert: true, color: "#ff9800" }); TV.toast("Alarm gesetzt – das Replay hält an, wenn der Preis die Linie kreuzt"); } }];
  }
  app.priceMenu = function (c, price, at) { TV.menu(at, TV.Trade.priceItems(price).concat(drawItems(c, price))); };

  // ---------------------------------------------------------------- settings
  function settingsDialog() {
    const S = app.settings, apply = () => { app.saveSettings(); document.body.className = document.body.className.replace(/th-\w+/, "th-" + S.theme); for (const c of app.charts) { c.restyle(); c.legend(); c.studies.need(); } app.quickBar(); };
    TV.dialog({ title: "Chart-Einstellungen", width: 560, tabs: [
      { name: "Symbol", render: b => TV.form(b, [{ key: "up", label: "Kerzen steigend", type: "color", alpha: false }, { key: "down", label: "Kerzen fallend", type: "color", alpha: false },
                                                  { key: "lineColor", label: "Linie / Fläche", type: "color", alpha: false }], S, apply) },
      { name: "Erscheinung", render: b => TV.form(b, [{ key: "theme", label: "Design", type: "select", str: true, options: [["neu", "TradingView dunkel (neu, schwarz)"], ["klassik", "TradingView dunkel (klassisch, blau-grau)"]] },
                                                       { key: "grid", label: "Gitternetz", type: "bool" }, { key: "breaks", label: "Sessiongrenzen (18:00 NY) mit Datum", type: "bool" },
                                                       { key: "rthShade", label: "RTH (09:30–16:00 NY) hervorheben", type: "bool" }, { key: "syncCross", label: "Fadenkreuz über alle Charts", type: "bool" },
                                                       { key: "crossWindows", label: "Fadenkreuz auch in anderen Fenstern", type: "bool" }, { key: "quickbar", label: "Schwebende Zeichenleiste im Chart", type: "bool" }], S, apply) },
      { name: "Skalen", render: b => TV.form(b, [{ key: "countdown", label: "Countdown bis zum Kerzenschluss", type: "bool" }, { key: "plus", label: "+ an der Preisachse (Order / Linie)", type: "bool" }], S, apply) },
      { name: "Handel", render: b => TV.form(b, [{ key: "qt", label: "Kaufen / Verkaufen im Chart", type: "bool" }, { key: "orders", label: "Positionen und Orders im Chart", type: "bool" },
                                                  { key: "fills", label: "Ausführungen als Pfeile", type: "bool" }], S, apply) },
    ], buttons: [{ label: "Standard", action: () => { Object.assign(S, DEF_SET); apply(); return true; } }, { label: "OK", kind: "pri" }] });
  }
  function keysDialog() {
    const K = [["Abspielen / Pause", "Leertaste"], ["Eine Sekunde vor / zurück (halten spult, bis zu 1 min pro Sekunde)", "→ / ←"], ["Eine Minute / ein Bar", "Shift / Alt + → ←"], ["Ein Bar vor / zurück", "« » in der Leiste"], ["Vortag / Folgetag (gleiche Uhrzeit)", "Bild ↑ / Bild ↓"],
      ["Sessionbeginn", "Pos1"], ["Nächste Eröffnung", "N"], ["Zeiteinheit tippen", "z. B. 5 ⏎, 15s ⏎, 1h ⏎, D ⏎"], ["Trendlinie", "Alt+T"], ["Horizontale Linie / Strahl", "Alt+H / Alt+J"],
      ["Vertikale Linie / Kreuzlinie", "Alt+V / Alt+C"], ["Fib Retracement", "Alt+F"], ["Rechteck", "Alt+Shift+R"], ["Lineal", "Shift + Ziehen"], ["Punkt an Hoch / Tief der Kerze docken", "Strg halten"], ["Linie gerade (0°, 45°, 90°)", "Shift halten beim Ziehen"], ["Chart seitlich schieben", "Shift + Mausrad"],
      ["Zeichnung löschen", "Entf"], ["Rückgängig / Wiederholen", "Strg+Z / Strg+Y"], ["Abbrechen, Auswahl aufheben", "Esc"], ["Kaufen / Verkaufen zum Markt", "Shift+B / Shift+S"],
      ["Indikatoren", "/"], ["Chart zurücksetzen", "Alt+R"], ["Snapshot kopieren", "Alt+S"]];
    TV.dialog({ title: "Tastenkürzel", width: 520, body: b => { const g = el("div.kbd"); for (const [a, k] of K) g.append(el("span", { text: a }), el("span", { text: k })); b.append(g); } });
  }
  function helpDialog() {
    const P = [["Volumenprofil (Session)", "Pro Session RTH (09:30–16:00 NY) und Nacht getrennt: blau das Volumen der Käufer, gelb das der Verkäufer, Value Area (70 %) kräftiger, POC rot. Exakt aus den Preisleveln jeder Minute."],
      ["Market Profile (TPO)", "Die RTH in 30-Minuten-Perioden A, B, C … – Buchstaben, sobald Platz ist, sonst Blöcke. Magenta: Single Prints, orange: Tails, links die Initial Balance."],
      ["VWAP", "Ab 09:30 NY (RTH) oder ab 18:00 NY (Session) mit Bändern im Abstand der volumengewichteten Standardabweichung."],
      ["Replay", "Standard ist Live. „Replay“ oben: einen Bar im Chart anklicken oder die Linie ziehen, ab dort läuft die Uhr; × in der Leiste beendet das Replay. Eine Uhr im Server für alle Charts und Fenster; nichts nach der Uhr existiert."],
      ["Orders", "Simuliert gegen die echten Prints des Tages ab der genauen Replay-Zeit des Klicks. Wer nach einem Sprung zurück handelt, beginnt einen neuen Zweig."],
      ["Alarm", "Eine horizontale Linie mit Alarm hält das Replay an, sobald der Preis sie kreuzt."],
      ["Footprint", "Chart-Typ „Footprint“: je Bar Volumen pro Preis, Bid (Verkäufer) × Ask (Käufer), POC gerahmt, diagonale Imbalances fett, darunter Volumen, Delta und Session-Delta. Zahlen erscheinen beim Hineinzoomen; „Ticks je Zeile“ 1 zeigt jeden Tick. Rechtsklick kopiert einen Bar als CSV."],
      ["Datenfenster", "Rechte Leiste: der Bar unter dem Cursor (OHLC, Volumen, Käufer, Verkäufer, Delta) und seine Level – Σ der Level gegen das Bar-Volumen (✓ oder ≠), dazu der Preis am Cursor mit Bid × Ask."]];
    TV.dialog({ title: "Was ist was", width: 600, body: b => { for (const [h, t] of P) b.append(el("div", { style: { marginBottom: "12px" } }, el("b", { text: h, style: { fontWeight: 500 } }), el("div", { text: t, style: { color: "var(--text2)", marginTop: "2px" } }))); } });
  }

  // ---------------------------------------------------------------- snapshot of every pane as placed
  async function shot(how) {
    const host = TV.$("#charts"), hr = host.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const out = document.createElement("canvas"); out.width = Math.round(hr.width * dpr); out.height = Math.round(hr.height * dpr);
    const g = out.getContext("2d"); g.fillStyle = getComputedStyle(document.body).getPropertyValue("--line"); g.fillRect(0, 0, out.width, out.height);
    for (const c of app.charts) { const r = c.box.getBoundingClientRect(), s = c.snapshot(); g.drawImage(s, (r.left - hr.left) * dpr, (r.top - hr.top) * dpr, r.width * dpr, r.height * dpr); }
    const name = RC.shotName(app.inst(), app.charts.map(c => TV.tfName(c.cfg.tf)).join("-"));
    if (how === "server") { const r = await RC.saveShot(out, name); TV.toast(r ? "Gespeichert: " + r.path : "Speichern fehlgeschlagen: " + (RC.error || ""), r ? "ok" : "err", 5000); }
    else if (how === "copy") { try { const blob = await new Promise(r => out.toBlob(r, "image/png")); await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); TV.toast("Bild in die Zwischenablage kopiert", "ok"); } catch (e) { TV.toast("Kopieren nicht möglich – „Bild herunterladen“ geht immer", "err"); } }
    else { const a = el("a", { href: out.toDataURL("image/png"), download: name }); document.body.append(a); a.click(); a.remove(); }
  }

  // ---------------------------------------------------------------- keys: timeframe typing, shortcuts
  let tfBuf = "", tfTimer = null, tfTip = null;
  function tfApply() {
    const s = tfBuf.trim().toLowerCase(); tfBuf = ""; if (tfTip) { tfTip.remove(); tfTip = null; } clearTimeout(tfTimer);
    let m = null; const n = parseInt(s, 10);
    if (/^\d+$/.test(s)) m = n; else if (/^\d+s$/.test(s)) m = n / 60; else if (/^\d+h$/.test(s)) m = n * 60; else if (/^(1?d)$/.test(s)) m = 1440;
    const hit = m && TV.TFS.find(x => Math.abs(x[0] - m) < 1e-9);
    if (hit) app.active.setTf(hit[0]); else if (s) TV.toast(`Zeiteinheit „${s}“ gibt es hier nicht (${TV.TFS.map(x => x[1]).join(", ")})`, "err");
  }
  window.addEventListener("keydown", e => {
    if (TV.typing(e) || TV.dialogOpen()) return;
    if (e.altKey && !e.ctrlKey && e.key.toLowerCase() === "r") { e.preventDefault(); app.active.fit(); return; }
    if (e.altKey && !e.ctrlKey && e.key.toLowerCase() === "s") { e.preventDefault(); shot("copy"); return; }
    if (e.key === "/" && !e.ctrlKey) { e.preventDefault(); TV.indicatorDialog(app.active); return; }
    if (!e.ctrlKey && !e.altKey && !e.metaKey && (/^[0-9]$/.test(e.key) || (tfBuf && /^[hHdDsS]$/.test(e.key)) || (!tfBuf && /^[dD]$/.test(e.key)))) {
      tfBuf += e.key; e.preventDefault();
      if (!tfTip) { tfTip = el("div.toast", { style: { position: "fixed", left: "50%", top: "40%", transform: "translate(-50%,-50%)", fontSize: "22px", zIndex: 1300 } }); document.body.append(tfTip); }
      tfTip.textContent = "Zeiteinheit: " + tfBuf; clearTimeout(tfTimer); tfTimer = setTimeout(tfApply, 1600); return;
    }
    if (tfBuf && e.key === "Enter") { e.preventDefault(); tfApply(); return; }
    if (tfBuf && e.key === "Escape") { tfBuf = ""; if (tfTip) { tfTip.remove(); tfTip = null; } return; }
    if (tfBuf && e.key === "Backspace") { tfBuf = tfBuf.slice(0, -1); if (tfTip) tfTip.textContent = "Zeiteinheit: " + tfBuf; e.preventDefault(); }
  });

  // ---------------------------------------------------------------- the frame loop
  let lastPx = null, lastInst = null, lastTitle = "";
  function frame(now) {
    for (const c of app.charts) c.frame(now);
    TV.Amt.frame(now); TV.Trade.frame(now); TV.Replay.update();
    const t = RC.now();
    if (app.clockEl) {
      const live = TV.Replay.isLive(), feed = live && TV.Trade.liveFeedOk();
      const txt = t == null ? "" : live ? (feed ? "LIVE · " + RC.fmtFull(t) : "No Live Market Data · " + RC.fmtFull(t)) : "REPLAY · " + RC.fmtFull(t);
      if (app.clockEl.textContent !== txt) { app.clockEl.textContent = txt; app.clockEl.style.color = live ? (feed ? "var(--down)" : "var(--muted)") : "var(--text2)"; app.clockEl.title = live && !feed ? "Live, aber die Rithmic Bridge sendet gerade nichts für " + app.inst() : "Replay-Zeit"; }
    }
    if (app.tzBtn && t != null) { const txt = RC.fmtTime(t, true) + (RC.tz() === "NY" ? " (New York)" : " (Wien)"); if (app.tzBtn.textContent !== txt) app.tzBtn.firstChild.textContent = txt; }
    const c = app.active, B = c && c.BARS, px = B && B.length ? B[B.length - 1].c : null;
    if (px != null && c.lastT != null) { if (lastPx != null && px !== lastPx) TV.Draw.checkAlerts(lastPx, px); lastPx = px; }
    const title = `${app.inst()} ${px != null ? TV.fp(px, c.tick()) : ""} · Replay`; if (title !== lastTitle) { lastTitle = title; document.title = title; }
    requestAnimationFrame(frame);
  }
  RC.on(s => {
    const inst = app.inst();
    if (inst !== lastInst) { lastInst = inst; lastPx = null; TV.Draw.load(inst); for (const c of app.charts) c.legend(); app.topState(); TV.Trade.refresh(); }
    const tt = RC.now(); if (tt != null) for (const c of app.charts) { if (!s.playing || Math.abs((c.lastT || 0) - tt) > 2) c.sync(tt); }
    if (lastPx != null && app.active && app.active.lastT != null && tt != null && tt < app.active.lastT - 1) lastPx = null;   // a jump back: no alarm from it
  });
  RC.onTz(() => { for (const c of app.charts) { c.chart.applyOptions({ timeScale: { tickMarkFormatter: (t, k) => c.tickFmt(t, k) } }); c.redraw(); } });

  // ---------------------------------------------------------------- start
  function start() {
    document.body.className = "th-" + (app.settings.theme || "neu");
    if (TV.store.get("ticketOpen", false)) document.body.classList.add("ticket-open");
    app.handlers = [TV.Replay.pickHandler, TV.Draw.createHandler, TV.Trade.handler, TV.Draw.selectHandler];
    TV.Replay.mount();
    app.top(); app.rightBar();
    TV.Draw.load(app.inst()); TV.Draw.bar();
    app.buildCharts(); app.quickBar();
    TV.Trade.renderBottom(); TV.Trade.renderTicket(true);
    if (TV.store.get("dw", false)) TV.FP.dwToggle(true);
    RC.connect(); TV.Replay.init();
    requestAnimationFrame(frame);
    window.addEventListener("error", e => TV.toast("Fehler: " + (e.message || e), "err", 6000));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
