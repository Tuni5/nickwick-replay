/* app.js - tv.html put together: the settings, the layout of one to four charts (each with its own timeframe,
 * chart type and indicators, all on the one replay clock and one instrument), the top bar (symbol, timeframes, chart
 * type, indicators, replay, undo, layout, settings, snapshot, trading), the bar under the charts (ranges, go to, time
 * zone, %, log, auto), the right bar, menus, the keyboard and the frame loop. */
(function () {
  const { el } = TV;
  const DEF_SET = { theme: "neu", up: "#089981", down: "#f23645", lineColor: "#2962ff", bg: "", grid: true, breaks: true, rthShade: true, countdown: true,
                    plus: true, qt: true, orders: true, fills: true, syncCross: true, quickbar: true, crossWindows: true, hideFuture: true, alertSound: true };
  const LAYOUTS = {
    "1": { n: 1, cols: "1fr", rows: "1fr", name: "1 Chart" },
    "2h": { n: 2, cols: "1fr 1fr", rows: "1fr", name: "2 side by side" },
    "2v": { n: 2, cols: "1fr", rows: "1fr 1fr", name: "2 stacked" },
    "3l": { n: 3, cols: "1.7fr 1fr", rows: "1fr 1fr", areas: '"a b" "a c"', name: "1 large + 2" },
    "3h": { n: 3, cols: "1fr 1fr 1fr", rows: "1fr", name: "3 side by side" },
    "4": { n: 4, cols: "1fr 1fr", rows: "1fr 1fr", name: "2 × 2" },
    "4l": { n: 4, cols: "1.9fr 1fr", rows: "1fr 1fr 1fr", areas: '"a b" "a c" "a d"', name: "1 large + 3" },
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
  let layoutTimer = null;
  app.saveLayout = () => {
    if (!app.layout) return;
    app.layout.panes = app.charts.map(c => c.cfg); app.layout.active = app.charts.indexOf(app.active); TV.store.set("layout", app.layout);
    if (TV.WS && TV.WS.cur) { clearTimeout(layoutTimer); layoutTimer = setTimeout(() => TV.post("/api/workspaces", { op: "layout", id: TV.WS.cur, layout: app.layout }).catch(() => {}), 600); }   // to the workspace, a moment later
  };
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
      c.addLayer("normal", gapLayer(c));
      c.addLayer("bottom", noSecondsLayer(c));
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
  // the cursor in the other windows: through the server's stream (/api/cross), so it reaches every window and every
  // device - a few times a second, the own mouse wins
  let crossAt = 0, crossSent = null;
  app.crossSync = function (src, cross) {
    if (app.settings.syncCross) for (const c of app.charts) if (c !== src) c.setCross(cross);
    if (!app.settings.crossWindows) return;
    const now = performance.now(), body = cross ? { inst: app.inst(), t: cross.t, p: cross.p, origin: RC.origin } : { origin: RC.origin };
    if (cross && now - crossAt < 50) return;
    crossAt = now;
    const key = JSON.stringify(body); if (key === crossSent) return; crossSent = key;
    TV.post("/api/cross", body).catch(() => {});
  };
  app.remoteCross = function (m) {
    if (!app.settings.crossWindows || !m || (m.inst && m.inst !== app.inst())) return;
    if (app.charts.some(c => c.crossOwn)) return;                // this window's own mouse wins (a cursor set from outside leaves cross set, but not crossOwn)
    const cross = m.t != null ? { t: m.t, p: m.p } : null;
    for (const c of app.charts) c.setCross(cross);
  };
  app.applyCursor = function () {
    const m = TV.Draw.cursor, lines = m === "cross", labels = m !== "arrow" && m !== "eraser";
    const pick = TV.Replay.selecting, draw = TV.Draw.busy();   // choosing a bar or drawing: the chart's own crosshair gives way
    for (const c of app.charts) c.chart.applyOptions({ crosshair: { vertLine: { visible: lines && !pick && !draw, labelVisible: labels && !pick && !draw }, horzLine: { visible: lines && !draw, labelVisible: labels && !draw } } });
  };
  app.goTo = function (t) {
    const c = app.active; if (!c || !c.BARS.length) return;
    const i = c.idxOf(t); if (i < 0) { TV.toast("This time is not loaded – scrolling left loads older sessions"); return; }
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
    app.symBtn = tb("sym", "Search symbol", [TV.iconSm("search", 20), el("span", { text: app.inst() })], () => symbolSearch());
    top.append(app.symBtn, el("span.sep"));
    app.tfBox = el("span", { style: { display: "inline-flex", gap: "1px" } }); top.append(app.tfBox);
    top.append(tb("", "More timeframes", TV.iconSm("down", 20), b => TV.menu(b, [{ head: "Minutes / hours" }].concat(TV.TFS.map(([m, n, long]) => ({ label: long, hint: FAV.includes(m) ? "★" : "☆", on: app.active.cfg.tf === m,
      action: () => app.active.setTf(m) })), [{ sep: true }, { label: "Edit favorites …", action: favDialog }]))));
    top.append(el("span.sep"));
    app.typeBtn = tb("", "Chart type", TV.icon("candles"), b => TV.menu(b, TV.CHART_TYPES.map(([k, n, ic]) => ({ label: n, icon: ic, on: app.active.cfg.type === k, action: () => app.active.setType(k) }))));
    top.append(app.typeBtn, el("span.sep"));
    top.append(tb("", "Indicators (/)", [TV.icon("fx"), el("span.cap", { text: "Indicators" })], () => TV.indicatorDialog(app.active)));
    top.append(el("span.sep"));
    app.replayBtn = tb("", "Replay: pick a bar in the chart, the clock runs from there · in a replay: back to live", [TV.icon("replay"), el("span.cap", { text: "Replay" })], () => TV.Replay.toggle());
    top.append(app.replayBtn, el("span.sep"),
      tb("", "Undo (Ctrl+Z)", TV.icon("undo"), () => TV.Draw.doUndo()), tb("", "Redo (Ctrl+Y)", TV.icon("redo"), () => TV.Draw.doRedo()));
    top.append(el("span.grow"));
    app.clockEl = el("span.clockchip", { title: "Replay time" }); top.append(app.clockEl);
    app.wsBtn = tb("", "Workspace: its own chart layout and drawings · switch, new, rename, duplicate, delete", [TV.icon("folder"), el("span.cap", { text: "Workspace" })], b => TV.WS.menu(b));
    top.append(app.wsBtn, tb("", "Layout: several charts", TV.icon("layout"), b => layoutMenu(b)),
      tb("", "Settings", TV.icon("gear"), () => settingsDialog()),
      tb("", "Full screen (F11)", TV.icon("full"), () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); }),
      tb("", "Snapshot (Alt+S)", TV.icon("camera"), b => TV.menu(b, [
        { label: "Download image", icon: "camera", action: () => shot("download") },
        { label: "Copy image", icon: "clone", hint: "Alt+S", action: () => shot("copy") },
        { label: "Save to the screenshot folder", icon: "camera", action: () => shot("server") }], { right: true })),
      tb("trade", "Show / hide the order ticket", el("span", { text: "Trade" }), () => TV.Trade.openTicket()));
    app.topState();
  };
  app.topState = function () {
    if (!app.tfBox || !app.active) return;
    const c = app.active;
    app.tfBox.replaceChildren(...FAV.map(m => { const b = tb("tf" + (c.cfg.tf === m ? ".on" : ""), (TV.TFS.find(x => x[0] === m) || [0, 0, m + " minutes"])[2], el("span", { text: TV.tfName(m) }), () => c.setTf(m)); if (c.cfg.type === "tpo" && m !== 30) b.disabled = true; return b; }));
    const ty = TV.CHART_TYPES.find(x => x[0] === c.cfg.type) || TV.CHART_TYPES[0];
    app.typeBtn.replaceChildren(TV.icon(ty[2])); app.typeBtn.title = "Chart type: " + ty[1];
    app.symBtn.lastChild.textContent = app.inst();
    app.replayBtn.classList.toggle("on", TV.Replay.selecting || !TV.Replay.isLive());
    if (app.wsBtn && TV.WS) { const cap = app.wsBtn.querySelector(".cap"); if (cap && cap.textContent !== TV.WS.name()) cap.textContent = TV.WS.name(); }
  };
  function favDialog() {
    TV.dialog({ title: "Favorites (timeframes in the bar)", width: 360, body: b => {
      for (const [m, n, long] of TV.TFS) b.append(el("label.tk-chk", { style: { padding: "5px 0" } }, el("input", { type: "checkbox", checked: FAV.includes(m), onchange: e => {
        if (e.target.checked) { if (!FAV.includes(m)) FAV.push(m); } else FAV.splice(FAV.indexOf(m), 1);
        FAV.sort((a, b) => a - b); TV.store.set("tf.fav", FAV); app.topState(); } }), el("span", { text: long })));
    }, buttons: [{ label: "Done", kind: "pri" }] });
  }
  function layoutMenu(anchor) {
    TV.closeMenus();
    const m = TV.menu(anchor, Object.entries(LAYOUTS).map(([k, L]) => ({ label: L.name, on: app.layout.name === k, icon: preview(L), action: () => app.setLayout(k) })).concat([
      { sep: true }, { label: "Sync crosshair", on: app.settings.syncCross, action: () => { app.settings.syncCross = !app.settings.syncCross; app.saveSettings(); } },
      { label: "Reset layout", action: () => { if (confirm("Reset the layout, timeframes and indicators of all charts?")) { app.layout = null; TV.store.set("layout", null); app.buildCharts(); } } }]), { right: true });
    return m;
  }
  function preview(L) {
    const g = el("span", { style: { display: "grid", width: "22px", height: "16px", gap: "1px", gridTemplateColumns: L.cols, gridTemplateRows: L.rows, gridTemplateAreas: L.areas || "" } });
    for (let i = 0; i < L.n; i++) g.append(el("span", { style: { border: "1px solid currentColor", borderRadius: "1px", gridArea: L.areas ? "abcd"[i] : "" } }));
    return g;
  }
  async function symbolSearch() {
    const insts = await RP.instruments().catch(() => []);
    TV.dialog({ title: "Symbol search", width: 520, pad: false, body: (b, close) => {
      const inp = el("input", { placeholder: "Symbol, z. B. ES", autocomplete: "off" }), list = el("div.slist");
      b.append(el("div.search", { style: { paddingTop: "8px" } }, TV.iconSm("search", 20), inp), list);
      let hl = 0, shown = [];
      const pick = s => { RC.send("inst", { inst: s, t: RC.now() }); close(); };
      const render = () => {
        const q = inp.value.trim().toUpperCase(); shown = insts.filter(s => !q || s.includes(q) || TV.spec(s).name.toUpperCase().includes(q));
        list.replaceChildren(el("div.grp", { text: "In the archive" }), ...shown.map((s, i) => el("div.si" + (i === hl ? ".hl" : ""), { onclick: () => pick(s) },
          el("span.sn", { text: s }), el("span.sd", { text: TV.spec(s).name + " Futures" }), el("span.sx", { text: "CME · Futures" }))));
        if (!shown.length) list.append(el("div.empty", { text: "No symbol in the archive" }));
      };
      inp.oninput = () => { hl = 0; render(); };
      inp.onkeydown = e => { if (e.key === "ArrowDown") { hl = Math.min(shown.length - 1, hl + 1); render(); e.preventDefault(); } else if (e.key === "ArrowUp") { hl = Math.max(0, hl - 1); render(); e.preventDefault(); } else if (e.key === "Enter" && shown[hl]) pick(shown[hl]); };
      render(); setTimeout(() => inp.focus(), 0);
    } });
  }

  // ---------------------------------------------------------------- the bar under the charts
  app.bottomBar = function () {
    const bar = TV.$("#cbar"); bar.replaceChildren();
    for (const [n, name] of [[1, "1D"], [3, "3D"], [5, "5D"], [10, "10D"], [20, "1M"]]) bar.append(tb("", `Show ${n} trading day${n > 1 ? "s" : ""}`, el("span", { text: name }), () => app.active.showDays(n)));
    bar.append(el("span.sep"), tb("", "Go to … (date and time)", TV.iconSm("cal", 18), b => TV.Replay.calendar(b)));
    bar.append(el("span.grow"));
    app.tzBtn = tb("tz", "Time zone of the display (in all windows)", el("span", { text: "" }), b => TV.menu(b, [["NY", "New York (UTC−5/−4)"], ["Vienna", "Vienna (UTC+1/+2)"]].map(([k, n]) => ({ label: n, on: RC.tz() === k, action: () => RC.setTz(k) })), { right: true }));
    bar.append(app.tzBtn, el("span.sep"));
    const s = (app.active && app.active.cfg.scale) || {};
    const scaleBtn = (k, name, title) => tb(s[k] || (k === "auto" && s.auto !== false) ? "on" : "", title, el("span", { text: name }), () => {
      const c = app.active, sc = c.cfg.scale = Object.assign({ auto: true }, c.cfg.scale);
      if (k === "auto") sc.auto = !(sc.auto !== false); else { sc[k] = !sc[k]; if (sc[k]) sc[k === "log" ? "pct" : "log"] = false; }
      c.applyScale(); app.saveLayout(); app.bottomBar();
    });
    bar.append(scaleBtn("pct", "%", "Percent scale"), scaleBtn("log", "log", "Logarithmic scale"), scaleBtn("auto", "auto", "Auto scale"));
  };

  // ---------------------------------------------------------------- missing days: the gap slots the server sends (timeline.py) are
  // empty on the chart - a red hatched box over them, as wide as the missing day, NO DATA in the middle
  // a day the archive has, but without 1-second bars and without a tick export: its candles stay, the empty room above
  // and below them over the day's width is hatched in gold with "NO 1s DATA" - the day is there, just not to the second
  function hatch(ctx, x0, y0, W, H, fill, line, step) {
    if (W <= 0 || H <= 0) return;
    ctx.fillStyle = fill; ctx.fillRect(x0, y0, W, H);
    ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, W, H); ctx.clip();
    ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.beginPath();
    for (let y = y0 - W; y < y0 + H + W; y += step) { ctx.moveTo(x0, y); ctx.lineTo(x0 + W, y + W); }
    ctx.stroke(); ctx.restore();
  }
  function plate(ctx, cx, cy, title, sub, color, font) {
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = `700 14px ${font}`; const tw = Math.max(ctx.measureText(title).width, ctx.measureText(sub).width) + 24;
    ctx.fillStyle = "rgba(20,22,30,0.92)"; ctx.fillRect(cx - tw / 2, cy - 24, tw, 48);
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.strokeRect(cx - tw / 2 + 0.5, cy - 24 + 0.5, tw - 1, 47);
    ctx.fillStyle = color; ctx.fillText(title, cx, cy - 9);
    ctx.font = `12px ${font}`; ctx.fillStyle = "var(--text2)"; ctx.fillText(sub, cx, cy + 10);
  }
  const dayName = day => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "2-digit", year: "2-digit" }).format(new Date(day + "T12:00:00Z"));
  function noSecondsLayer(c) {
    return {
      draw(ctx, w, h) {
        const B = c.BARS, S = c.SESS; if (!B.length || !S || !S.length) return;
        const bs = c.chart.timeScale().options().barSpacing, font = getComputedStyle(document.body).getPropertyValue("--font");
        const GOLD = "#f0b429";
        // the days without seconds in view, with their x range and highest high
        const days = [];
        for (const sx of S) {
          if (sx.seconds || sx.ticks || sx.seconds == null) continue;
          let i0 = c.idxOf(sx.start); if (i0 < 0 || B[i0].t < sx.start) i0++;
          if (i0 < 0 || i0 >= B.length || B[i0].t >= sx.end) continue;
          let i1 = i0, hi = -Infinity;
          for (let i = i0; i < B.length && B[i].t < sx.end; i++) { if (B[i].gap) continue; i1 = i; hi = Math.max(hi, B[i].h); }
          if (!isFinite(hi)) continue;
          const xa = c.lx(i0), xb = c.lx(i1); if (xa == null || xb == null) continue;
          const x0 = Math.round(xa - bs / 2), x1 = Math.round(xb + bs / 2);
          if (x1 < 0 || x0 > w || x1 - x0 < 2) continue;
          days.push({ x0, x1, hi, date: sx.date });
        }
        if (!days.length) return;
        // one band along the top edge, the same for every such day: at least a day's width above the highest of
        // their candles, never deeper than 40 % of the pane, never thinner than 24 px
        const W = Math.max(...days.map(d => d.x1 - d.x0));
        let yb = Math.min(...days.map(d => c.yOf(d.hi))) - W;
        yb = Math.max(36, Math.min(h * 0.4, yb));
        ctx.save();
        for (const d of days) {
          hatch(ctx, d.x0, 0, d.x1 - d.x0, yb, "rgba(240,180,41,0.08)", "rgba(240,180,41,0.35)", 9);
          ctx.strokeStyle = "rgba(240,180,41,0.55)"; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(d.x0 + 0.5, 0); ctx.lineTo(d.x0 + 0.5, yb); ctx.moveTo(d.x1 - 0.5, 0); ctx.lineTo(d.x1 - 0.5, yb); ctx.stroke();
          const txt = `NO 1s DATA · ${dayName(d.date)}`;
          ctx.font = `700 11px ${font}`; ctx.fillStyle = GOLD; ctx.textBaseline = "middle";
          const cx = Math.max(d.x0, 0) / 2 + Math.min(d.x1, w) / 2;
          const wide = d.x1 - d.x0 >= ctx.measureText(txt).width + 16, short = "NO 1s";
          if (wide) { ctx.textAlign = "center"; ctx.fillText(txt, cx, Math.min(yb - 12, 16)); }                      // across, when the day is wide
          else if (yb >= 150) { ctx.save(); ctx.translate(cx + 4, 8); ctx.rotate(Math.PI / 2); ctx.textAlign = "left"; ctx.fillText(txt, 0, 0); ctx.restore(); }   // upright, when the band is tall
          else if (d.x1 - d.x0 >= ctx.measureText(short).width + 8) { ctx.textAlign = "center"; ctx.fillText(short, cx, Math.min(yb - 12, 16)); }
        }
        ctx.strokeStyle = "rgba(240,180,41,0.6)"; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(Math.max(0, Math.min(...days.map(d => d.x0))), yb + 0.5); ctx.lineTo(Math.min(w, Math.max(...days.map(d => d.x1))), yb + 0.5); ctx.stroke(); ctx.setLineDash([]);
        ctx.restore();
      },
    };
  }
  function gapLayer(c) {
    return {
      draw(ctx, w, h) {
        const B = c.BARS; if (!B.length) return;
        const bs = c.chart.timeScale().options().barSpacing;
        ctx.save();
        for (let i = 0; i < B.length; i++) {
          if (!B[i].gap) continue;
          let j = i; while (j + 1 < B.length && B[j + 1].gap && B[j + 1].day === B[i].day) j++;
          const xa = c.lx(i), xb = c.lx(j);
          if (xa != null && xb != null) {
            const x0 = Math.round(xa - bs / 2), x1 = Math.round(xb + bs / 2), W = Math.max(2, x1 - x0);
            if (x1 >= 0 && x0 <= w) {
              ctx.fillStyle = "rgba(242,54,69,0.08)"; ctx.fillRect(x0, 0, W, h);
              ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, W, h); ctx.clip();
              ctx.strokeStyle = "rgba(242,54,69,0.35)"; ctx.lineWidth = 1; ctx.beginPath();
              for (let y = -W; y < h + W; y += 9) { ctx.moveTo(x0, y); ctx.lineTo(x0 + W, y + W); }
              ctx.stroke(); ctx.restore();
              ctx.strokeStyle = "rgba(242,54,69,0.55)"; ctx.strokeRect(x0 + 0.5, 0.5, W - 1, h - 1);
              const d = new Date(B[i].day + "T12:00:00Z"), label = "NO DATA", sub = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "2-digit", year: "2-digit" }).format(d);
              const font = getComputedStyle(document.body).getPropertyValue("--font"), cx = Math.max(x0, 0) / 2 + Math.min(x1, w) / 2, cy = h / 2;
              ctx.textAlign = "center"; ctx.textBaseline = "middle";
              if (W >= 70) {                                     // the label on a plate in the middle, clear of the hatching
                ctx.font = `700 14px ${font}`; const tw = Math.max(ctx.measureText(label).width, ctx.measureText(sub).width) + 24;
                ctx.fillStyle = "rgba(20,22,30,0.92)"; ctx.fillRect(cx - tw / 2, cy - 24, tw, 48);
                ctx.strokeStyle = "rgba(242,54,69,0.7)"; ctx.strokeRect(cx - tw / 2 + 0.5, cy - 24 + 0.5, tw - 1, 47);
                ctx.fillStyle = "#f23645"; ctx.fillText(label, cx, cy - 9);
                ctx.font = `12px ${font}`; ctx.fillStyle = "var(--text2)"; ctx.fillText(sub, cx, cy + 10);
              } else {                                           // a narrow gap: the label stands upright beside it
                ctx.save(); ctx.translate(x1 + 10, 14); ctx.rotate(Math.PI / 2); ctx.font = `700 11px ${font}`; ctx.fillStyle = "#f23645"; ctx.textAlign = "left";
                ctx.fillText(`NO DATA · ${sub}`, 0, 0); ctx.restore();
              }
            }
          }
          i = j;
        }
        ctx.restore();
      },
    };
  }

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
    const grip = el("span.grip", { title: "Move" }, TV.iconSm("grip", 18));
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
    bar.append(el("button", { title: "Hide the bar (Settings → Appearance)", onclick: () => { app.settings.quickbar = false; app.saveSettings(); app.quickBar(); } }, TV.iconSm("close", 16)));
  };
  TV.on("tool", () => app.quickBar());

  // ---------------------------------------------------------------- the right bar
  app.rightBar = function () {
    const r = TV.$("#right"); r.replaceChildren();
    const w = (icon, title, on, fn) => r.append(el("button.wb" + (on ? ".on" : ""), { title, onclick: fn }, TV.icon(icon)));
    w("trade", "Order ticket", document.body.classList.contains("ticket-open"), () => TV.Trade.openTicket());
    w("order", "Trading panel (positions, orders, history)", TV.Trade.bottom.open, () => { TV.Trade.bottom.open = !TV.Trade.bottom.open; TV.store.set("bottom.open", TV.Trade.bottom.open); TV.Trade.renderBottom(); app.rightBar(); });
    w("datawin", "Data window: the bar and level under the cursor (volume, bid, ask, delta)", !!TV.FP.dw, () => TV.FP.dwToggle());
    w("tree", "Object tree (drawings)", false, () => TV.Draw.tree());
    w("fx", "Indicators", false, () => TV.indicatorDialog(app.active));
    w("book", "Journal: sessions, trades, calendar, overview (J)", false, () => TV.Journal.toggle());
    r.append(el("span", { style: { flex: 1 } }));
    w("folder", "Settings: archive folder, what the archive holds, live data (new tab)", false, () => window.open("/config.html", "_blank"));
    w("kbd", "Keyboard shortcuts", false, () => keysDialog());
    w("help", "What is what", false, () => helpDialog());
  };

  // ---------------------------------------------------------------- menus in the chart
  app.contextMenu = function (c, x, y, e, inPane) {
    app.activate(c);
    const at = { x: e.clientX, y: e.clientY };
    if (!inPane) {
      const sc = c.cfg.scale = Object.assign({ auto: true }, c.cfg.scale);
      TV.menu(at, [{ label: "Auto scale", on: sc.auto !== false, action: () => { sc.auto = !(sc.auto !== false); c.applyScale(); app.saveLayout(); app.bottomBar(); } },
        { label: "Logarithmic", on: !!sc.log, action: () => { sc.log = !sc.log; sc.pct = false; c.applyScale(); app.saveLayout(); app.bottomBar(); } },
        { label: "Percent", on: !!sc.pct, action: () => { sc.pct = !sc.pct; sc.log = false; c.applyScale(); app.saveLayout(); app.bottomBar(); } },
        { sep: true }, { label: "Reset chart", hint: "Alt+R", action: () => c.fit() }]);
      return;
    }
    const h = TV.Draw.hitAt(c, x, y); if (h) { TV.Draw.sel = h.d.id; TV.Draw.styleBar(); app.redrawAll(); TV.Draw.menuFor(h.d, at); return; }
    const p = c.pOfY(y); if (p == null) return;
    const price = Math.round(p / c.tick()) * c.tick();
    const bi = c.cross && c.cross.t != null ? c.idxOf(c.cross.t) : -1;
    const fpItems = c.cfg.type === "footprint" ? [{ sep: true }, { label: "Footprint settings …", icon: "gear", action: () => TV.FP.settings(c) }] : [];   // the CSV copy lives in the data window
    TV.menu(at, TV.Trade.priceItems(price).concat(drawItems(c, price), fpItems, [{ sep: true },
      { label: "Reset chart", hint: "Alt+R", action: () => c.fit() },
      { label: "Indicators …", icon: "fx", hint: "/", action: () => TV.indicatorDialog(c) },
      { label: "Object tree …", icon: "tree", action: () => TV.Draw.tree() },
      { label: "Delete all drawings …", icon: "trash", action: () => TV.Draw.removeAllMenu() },
      ...(app.settings.quickbar ? [] : [{ label: "Open drawing bar", icon: "trend", action: () => { app.settings.quickbar = true; app.saveSettings(); app.quickBar(); } }]),
      { sep: true }, { label: "Settings …", icon: "gear", action: () => settingsDialog() }]));
  };
  function drawItems(c, price) {
    const mk = (type, extra) => { const D = TV.Draw; D.snap(); const d = { id: Date.now().toString(36), type, pts: [{ t: c.lastT, p: price }], s: Object.assign(JSON.parse(JSON.stringify(TV.DRAW_TOOLS[type].def)), TV.store.get("draw.style." + type, {}), extra || {}), locked: false, hidden: false }; D.list.push(d); D.sel = d.id; D.save(); };
    return [{ sep: true }, { label: `Horizontal line at ${TV.fp(price, c.tick())}`, icon: "hline", hint: "Alt+H", action: () => mk("hline") },
            { label: `Alert at ${TV.fp(price, c.tick())} (stop the replay)`, icon: "bell", action: () => { mk("hline", { alert: true, color: "#ff9800" }); TV.toast("Alert set – the replay stops when the price crosses the line"); } }];
  }
  app.priceMenu = function (c, price, at) { TV.menu(at, TV.Trade.priceItems(price).concat(drawItems(c, price))); };

  // ---------------------------------------------------------------- settings
  function settingsDialog() {
    const S = app.settings, apply = () => { app.saveSettings(); document.body.className = document.body.className.replace(/th-\w+/, "th-" + S.theme); for (const c of app.charts) { c.restyle(); c.legend(); c.studies.need(); } app.quickBar(); };
    TV.dialog({ title: "Chart settings", width: 560, tabs: [
      { name: "Symbol", render: b => TV.form(b, [{ key: "up", label: "Candles up", type: "color", alpha: false }, { key: "down", label: "Candles down", type: "color", alpha: false },
                                                  { key: "lineColor", label: "Line / area", type: "color", alpha: false }], S, apply) },
      { name: "Appearance", render: b => TV.form(b, [{ key: "theme", label: "Design", type: "select", str: true, options: [["neu", "TradingView dark (new, black)"], ["klassik", "TradingView dark (classic, blue-grey)"]] },
                                                       { key: "grid", label: "Grid", type: "bool" }, { key: "breaks", label: "Session borders (18:00 NY) with date", type: "bool" },
                                                       { key: "rthShade", label: "Highlight RTH (09:30–16:00 NY)", type: "bool" }, { key: "syncCross", label: "Crosshair across all charts", type: "bool" },
                                                       { key: "crossWindows", label: "Crosshair in other windows too", type: "bool" }, { key: "quickbar", label: "Floating drawing bar in the chart", type: "bool" },
                                                       { key: "hideFuture", label: "Show drawings only from the replay time they were made at", type: "bool" },
                                                       { key: "alertSound", label: "Sound on alert", type: "bool" }], S, apply) },
      { name: "Scales", render: b => TV.form(b, [{ key: "countdown", label: "Countdown to the bar close", type: "bool" }, { key: "plus", label: "+ at the price axis (order / line)", type: "bool" }], S, apply) },
      { name: "Trading", render: b => TV.form(b, [{ key: "qt", label: "Buy / sell in the chart", type: "bool" }, { key: "orders", label: "Positions and orders in the chart", type: "bool" },
                                                  { key: "fills", label: "Fills as arrows", type: "bool" }], S, apply) },
    ], buttons: [{ label: "Default", action: () => { Object.assign(S, DEF_SET); apply(); return true; } }, { label: "OK", kind: "pri" }] });
  }
  function keysDialog() {
    const K = [["Play / pause", "Space"], ["One second × speed forward / back (hold to wind, up to 1 min × speed per second)", "→ / ←"], ["One minute / one bar", "Shift / Alt + → ←"], ["One bar forward / back", "« » in the bar"], ["Previous / next day (same time)", "PageUp / PageDown"],
      ["Session start", "Home"], ["Next open", "N"], ["Type a timeframe", "e.g. 5 ⏎, 15s ⏎, 1h ⏎, D ⏎"], ["Trend line", "Alt+T"], ["Horizontal line / ray", "Alt+H / Alt+J"],
      ["Vertical line / cross line", "Alt+V / Alt+C"], ["Fib Retracement", "Alt+F"], ["Rectangle", "Alt+Shift+R"], ["Ruler", "Shift + drag"], ["Dock a point at the bar's high / low", "Hold Ctrl"], ["Straight line (0°, 45°, 90°)", "Hold Shift while dragging"], ["Slide the chart sideways", "Shift + mouse wheel"],
      ["Delete drawing", "Del"], ["Undo / redo", "Ctrl+Z / Ctrl+Y"], ["Cancel, clear the selection", "Esc"], ["Buy / sell at market", "Shift+B / Shift+S"],
      ["Indicators", "/"], ["Reset chart", "Alt+R"], ["Copy snapshot", "Alt+S"]];
    TV.dialog({ title: "Keyboard shortcuts", width: 520, body: b => { const g = el("div.kbd"); for (const [a, k] of K) g.append(el("span", { text: a }), el("span", { text: k })); b.append(g); } });
  }
  function helpDialog() {
    const P = [["Volume profile (session)", "Per session, RTH (09:30–16:00 NY) and overnight apart: blue the buyers' volume, yellow the sellers', value area (70 %) stronger, POC red. Exact from every minute's price levels."],
      ["Market Profile (TPO)", "The RTH in 30-minute periods A, B, C … – letters when there is room, blocks otherwise. Magenta: single prints, orange: tails, the initial balance on the left."],
      ["VWAP", "From 09:30 NY (RTH) or from 18:00 NY (session) with bands at the volume-weighted standard deviation."],
      ["Replay", "Live by default. “Replay” at the top: click a bar in the chart or drag the line, the clock runs from there; × in the bar ends the replay. One clock in the server for all charts and windows; nothing after the clock exists."],
      ["Orders", "Simulated against the day's real prints from the exact replay time of the click. Trading after a jump back starts a new branch."],
      ["Alert", "A line with an alert stops the replay when the price crosses it."],
      ["Footprint", "Chart type “Footprint”: per bar the volume per price, bid (sellers) × ask (buyers), POC framed, diagonal imbalances bold. Numbers appear when zoomed in; “ticks per row” 1 shows every tick. Right-click copies a bar as CSV."],
      ["Data window", "Right side: the bar under the cursor (OHLC, volume, buyers, sellers, delta) and its levels – Σ of the levels against the bar's volume (✓ or ≠), plus the price at the cursor with bid × ask."]];
    TV.dialog({ title: "What is what", width: 600, body: b => { for (const [h, t] of P) b.append(el("div", { style: { marginBottom: "12px" } }, el("b", { text: h, style: { fontWeight: 500 } }), el("div", { text: t, style: { color: "var(--text2)", marginTop: "2px" } }))); } });
  }

  // ---------------------------------------------------------------- snapshot of every pane as placed
  async function shot(how) {
    const host = TV.$("#charts"), hr = host.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const out = document.createElement("canvas"); out.width = Math.round(hr.width * dpr); out.height = Math.round(hr.height * dpr);
    const g = out.getContext("2d"); g.fillStyle = getComputedStyle(document.body).getPropertyValue("--line"); g.fillRect(0, 0, out.width, out.height);
    for (const c of app.charts) { const r = c.box.getBoundingClientRect(), s = c.snapshot(); g.drawImage(s, (r.left - hr.left) * dpr, (r.top - hr.top) * dpr, r.width * dpr, r.height * dpr); }
    const name = RC.shotName(app.inst(), app.charts.map(c => TV.tfName(c.cfg.tf)).join("-"));
    if (how === "server") { const r = await RC.saveShot(out, name); TV.toast(r ? "Saved: " + r.path : "Saving failed: " + (RC.error || ""), r ? "ok" : "err", 5000); }
    else if (how === "copy") { try { const blob = await new Promise(r => out.toBlob(r, "image/png")); await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); TV.toast("Image copied to the clipboard", "ok"); } catch (e) { TV.toast("Copy not possible – “Download image” always works", "err"); } }
    else { const a = el("a", { href: out.toDataURL("image/png"), download: name }); document.body.append(a); a.click(); a.remove(); }
  }

  // ---------------------------------------------------------------- keys: timeframe typing, shortcuts
  let tfBuf = "", tfTimer = null, tfTip = null;
  function tfApply() {
    const s = tfBuf.trim().toLowerCase(); tfBuf = ""; if (tfTip) { tfTip.remove(); tfTip = null; } clearTimeout(tfTimer);
    let m = null; const n = parseInt(s, 10);
    if (/^\d+$/.test(s)) m = n; else if (/^\d+s$/.test(s)) m = n / 60; else if (/^\d+h$/.test(s)) m = n * 60; else if (/^(1?d)$/.test(s)) m = 1440;
    const hit = m && TV.TFS.find(x => Math.abs(x[0] - m) < 1e-9);
    if (hit) app.active.setTf(hit[0]); else if (s) TV.toast(`Timeframe “${s}” does not exist here (${TV.TFS.map(x => x[1]).join(", ")})`, "err");
  }
  window.addEventListener("keydown", e => {
    if (TV.typing(e) || TV.dialogOpen()) return;
    if (e.altKey && !e.ctrlKey && e.key.toLowerCase() === "r") { e.preventDefault(); app.active.fit(); return; }
    if (e.altKey && !e.ctrlKey && e.key.toLowerCase() === "s") { e.preventDefault(); shot("copy"); return; }
    if (e.key === "/" && !e.ctrlKey) { e.preventDefault(); TV.indicatorDialog(app.active); return; }
    if (!e.ctrlKey && !e.altKey && !e.metaKey && (/^[0-9]$/.test(e.key) || (tfBuf && /^[hHdDsS]$/.test(e.key)) || (!tfBuf && /^[dD]$/.test(e.key)))) {
      tfBuf += e.key; e.preventDefault();
      if (!tfTip) { tfTip = el("div.toast", { style: { position: "fixed", left: "50%", top: "40%", transform: "translate(-50%,-50%)", fontSize: "22px", zIndex: 1300 } }); document.body.append(tfTip); }
      tfTip.textContent = "Timeframe: " + tfBuf; clearTimeout(tfTimer); tfTimer = setTimeout(tfApply, 1600); return;
    }
    if (tfBuf && e.key === "Enter") { e.preventDefault(); tfApply(); return; }
    if (tfBuf && e.key === "Escape") { tfBuf = ""; if (tfTip) { tfTip.remove(); tfTip = null; } return; }
    if (tfBuf && e.key === "Backspace") { tfBuf = tfBuf.slice(0, -1); if (tfTip) tfTip.textContent = "Timeframe: " + tfBuf; e.preventDefault(); }
  });

  // ---------------------------------------------------------------- the frame loop
  let lastPx = null, lastInst = null, lastTitle = "", lastMode = null;
  function frame(now) {
    for (const c of app.charts) c.frame(now);
    TV.Amt.frame(now); TV.Trade.frame(now); TV.Replay.update();
    const t = RC.now();
    if (app.clockEl) {
      const live = TV.Replay.isLive(), feed = live && TV.Trade.liveFeedOk();
      // replay on a day without a 1-second file (and no tick export): the forming minute and fills are not there - say so
      let miss = "";
      if (!live && t != null) { const list = RP.cached(app.inst()), td = RC.tradeDate(t), sx = list && list.find(x => x.date === td); if (sx && !sx.seconds && !sx.ticks) miss = " · 1s Data is missing"; }
      const txt = t == null ? "" : live ? (feed ? "LIVE · " + RC.fmtFull(t) : "No Live Market Data · " + RC.fmtFull(t)) : "REPLAY · " + RC.fmtFull(t) + miss;
      if (app.clockEl.textContent !== txt) {
        app.clockEl.textContent = txt; app.clockEl.style.color = live ? (feed ? "var(--down)" : "var(--muted)") : miss ? "#f0b429" : "var(--text2)";
        app.clockEl.title = live && !feed ? "Live, but the Rithmic Bridge is not sending anything for " + app.inst() : miss ? "This day has no 1-second bars and no tick export: the forming minute appears at the minute's end, orders do not fill" : "Replay time";
      }
    }
    if (app.tzBtn && t != null) { const txt = RC.fmtTime(t, true) + (RC.tz() === "NY" ? " (New York)" : " (Vienna)"); if (app.tzBtn.textContent !== txt) app.tzBtn.firstChild.textContent = txt; }
    const c = app.active, B = c && c.BARS, px = B && B.length ? B[B.length - 1].c : null;
    if (px != null && c.lastT != null) { if (lastPx != null && px !== lastPx) TV.Draw.checkAlerts(lastPx, px); lastPx = px; }
    const title = `${app.inst()} ${px != null ? TV.fp(px, c.tick()) : ""} · Replay`; if (title !== lastTitle) { lastTitle = title; document.title = title; }
    requestAnimationFrame(frame);
  }
  RC.on(s => {
    const inst = app.inst();
    if (inst !== lastInst) { lastInst = inst; lastPx = null; TV.TICK = TV.spec(inst).tick; TV.Draw.load(inst); for (const c of app.charts) { c.legend(); c.restyle(); } app.topState(); TV.Trade.refresh(); }
    const mode = (s.live ? "live" : "replay") + ":" + (s.replay || "");             // another window started or ended a replay: this one follows
    if (mode !== lastMode) { lastMode = mode; app.topState(); TV.Trade.refresh(); app.redrawAll(); }
    const tt = RC.now(); if (tt != null) for (const c of app.charts) { if (!s.playing || Math.abs((c.lastT || 0) - tt) > 2) c.sync(tt); }
    if (lastPx != null && app.active && app.active.lastT != null && tt != null && tt < app.active.lastT - 1) lastPx = null;   // a jump back: no alarm from it
  });
  RC.onTz(() => { for (const c of app.charts) { c.chart.applyOptions({ timeScale: { tickMarkFormatter: (t, k) => c.tickFmt(t, k) } }); c.redraw(); } });

  // ---------------------------------------------------------------- start
  async function start() {
    document.body.className = "th-" + (app.settings.theme || "neu");
    if (TV.store.get("ticketOpen", false)) document.body.classList.add("ticket-open");
    app.handlers = [TV.Replay.pickHandler, TV.Draw.createHandler, TV.Trade.handler, TV.Draw.selectHandler];
    TV.Replay.mount();
    app.top(); app.rightBar();
    await TV.WS.ready();                                       // the workspace: its layout and its drawings
    try { const w = await TV.getJSON("/api/workspaces?id=" + encodeURIComponent(TV.WS.cur)); if (w.layout) app.layout = w.layout; } catch (e) {}
    TV.Draw.load(app.inst()); TV.Draw.bar();
    app.buildCharts(); app.quickBar();
    TV.Trade.renderBottom(); TV.Trade.renderTicket(true);
    if (TV.store.get("dw", false)) TV.FP.dwToggle(true);
    RC.connect(); TV.Replay.init();
    requestAnimationFrame(frame);
    window.addEventListener("error", e => TV.toast("Error: " + (e.message || e), "err", 6000));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
