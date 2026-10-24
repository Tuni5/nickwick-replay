/* replay.js - the replay as TradingView does it: the chart is live by default (the clock is the wall clock, the
 * charts show the day as the bridge brings it in); "Replay" in the top bar starts "Bar wählen" - a line follows the
 * mouse over the chart, a click or a drag sets the clock there, and the replay bar appears under the charts. The ×
 * of the bar ends the replay: back to live. Live and replay never exist at once: the clock is one or the other.
 * Every control moves the server's one clock (server/clock.py, clock.js), so every chart and every other replay
 * window follow. The clock runs to the second; the forming bar is built from the prints or the 1-second bars.
 *   Bar wählen      the line over the chart; click sets the clock to that bar's start, dragging winds (Esc cancels)
 *   date            a calendar of the trade dates in the archive, then a moment of that day
 *   ◀ ▶             the trade date before / after at the same time of day (PageUp / PageDown)
 *   ⏮ « ▶ »         session start (Home), one bar of the active chart back / forward (Shift: a minute), play /
 *                   pause (space); the arrow keys step one second, held down they wind faster the longer they are
 *                   held, as audio players do, up to a minute of replay per second (Shift a minute, Alt a bar)
 *   speed           0.25x - 600x
 *   Asia London NY IB Close ▸    the opens of the trade date, "next open" (N)
 *   the line        the trade date from 18:00 to 17:00 New York, click or drag to go there */
(function () {
  const { el } = TV;
  const R = TV.Replay = { drag: false, selecting: false, hover: null };
  const SPEEDS = [0.25, 0.5, 1, 2, 3, 5, 10, 20, 30, 60, 120, 300, 600];
  const barSec = () => (TV.app.active ? TV.app.active.tfSec() : 60);
  R.step = function (dir, e) {                              // the « » buttons: one bar of the active chart (Shift: a minute)
    const t = RC.now(); if (t == null) return; const s = e && e.shiftKey ? 60 : barSec();
    RC.seek(dir > 0 ? (Math.floor(t / s) + 1) * s : (Math.ceil(t / s) - 1) * s);
  };
  // the arrow keys: one second per press. Held down, the clock winds - by real time, not by key repeats: 5 replay
  // seconds per second at first, doubling about every 1.3 s of holding, at most one minute of replay per second;
  // the clock follows a few times a second (one request per flush). Shift: a minute per press, Alt: one bar.
  let target = null, flush = null, held = null, lastRep = 0;
  R.nudge = function (dir, e) {
    const now = performance.now();
    const base = target != null ? target : RC.now(); if (base == null) return;
    let s;
    if (e && e.altKey) s = barSec();
    else if (e && e.shiftKey) s = 60;
    else if (!(e && e.repeat) || held == null) { held = now; lastRep = now; s = 1; }
    else { const rate = Math.min(60, 5 * Math.pow(2, (now - held) / 1300)), dt = Math.min(0.25, (now - lastRep) / 1000); lastRep = now; s = rate * dt; }
    target = Math.max(0, base + dir * s);
    if (!flush) flush = setTimeout(() => { flush = null; const x = target; target = null; if (x != null) RC.seek(Math.round(x)); }, 70);
  };
  window.addEventListener("keyup", e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") held = null; });
  R.at = k => { const t = RC.now(); if (t != null) RC.seek(RC.opens(RC.tradeDate(t))[k]); };
  R.nextOpen = function () {
    const t = RC.now(); if (t == null) return;
    const o = RC.opens(RC.tradeDate(t)), n = [o.asia, o.london, o.ny].find(x => x > t + 1);
    if (n) return RC.seek(n);
    RP.neighbour(1).then(s => { if (s) RC.seek(RC.opens(s.date).asia); });
  };
  R.live = () => RC.send("live", { inst: TV.app.inst() });

  R.mount = function () {
    const box = TV.$("#replay"); box.replaceChildren();
    const b = (cls, title, content, fn) => { const x = el("button.rb" + (cls ? "." + cls : ""), { title, onclick: e => { e.stopPropagation(); fn(e, x); } }); x.append(content); return x; };
    R.pickBtn = b("", "Bar wählen: eine Linie folgt der Maus über dem Chart, Klick setzt das Replay dorthin, Ziehen spult (Esc bricht ab)", el("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px" } }, TV.iconSm("vline", 20), el("span", { text: "Bar wählen" })), () => R.pick(!R.selecting));
    R.dayBtn = b("", "Handelstag wählen (CME: 18:00 New York am Vorabend bis 17:00)", el("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px" } }, TV.iconSm("cal", 20), R.dayTxt = el("span", { text: "–" })), (e, x) => R.calendar(x));
    R.playBtn = b("play", "Abspielen / Pause (Leertaste)", TV.iconSm("play", 22), () => RC.toggle());
    R.speedBtn = b("", "Geschwindigkeit", R.speedTxt = el("span", { text: "10×" }), (e, x) => TV.menu(x, SPEEDS.map(v => ({ label: v + "×", on: RC.state && RC.state.speed === v, action: () => RC.speed(v) }))));
    R.timeEl = el("span.rtime", { title: "Replay-Zeit" });
    const row = el("div.rrow", null, R.pickBtn, el("span.rsep"), R.dayBtn,
      b("", "Vortag, gleiche Uhrzeit (Bild ↑)", TV.iconSm("left", 20), () => RP.dayJump(-1)), b("", "Folgetag, gleiche Uhrzeit (Bild ↓)", TV.iconSm("right", 20), () => RP.dayJump(1)),
      el("span.rsep"),
      b("", "Sessionbeginn 18:00 NY (Pos1)", TV.iconSm("start", 20), () => R.at("session")),
      b("", "Einen Bar zurück (Shift: eine Minute) · Pfeiltasten: eine Sekunde, gedrückt halten spult", TV.iconSm("stepb", 20), e => R.step(-1, e)),
      R.playBtn,
      b("", "Einen Bar vor (Shift: eine Minute) · Pfeiltasten: eine Sekunde, gedrückt halten spult", TV.iconSm("stepf", 20), e => R.step(1, e)),
      R.speedBtn, el("span.rsep"), R.timeEl, el("span.rsep"),
      b("", "Asia, 00:00 Wien", el("span", { text: "Asia" }), () => R.at("asia")), b("", "London, 09:00 Wien", el("span", { text: "London" }), () => R.at("london")),
      b("", "New York Open, 09:30 NY", el("span", { text: "NY" }), () => R.at("ny")), b("", "Ende der Initial Balance, 10:30 NY", el("span", { text: "IB" }), () => R.at("ib")),
      b("", "RTH-Schluss, 16:00 NY", el("span", { text: "Close" }), () => R.at("close")), b("", "Nächste Eröffnung (N)", TV.iconSm("next", 20), () => R.nextOpen()),
      el("span.rsep"), R.msg = el("span.rmsg"),
      b("", "Replay beenden: zurück zu Live (die Uhr folgt der echten Zeit, die Charts zeigen den Tag, wie er von der Bridge kommt)", TV.iconSm("close", 18), () => R.live()));
    R.prog = el("div.rprog", { title: "Der Handelstag von 18:00 bis 17:00 New York – klicken oder ziehen" }, el("div.track"), R.fill = el("div.fill"), R.knob = el("div.knob"));
    box.append(R.prog, row);
    // scrubbing the day
    const tAt = ev => { const r = R.prog.getBoundingClientRect(), o = R.o; if (!o) return null; return o.session + Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * (o.end - o.session); };
    let lastSeek = 0;
    R.prog.addEventListener("pointerdown", e => { R.drag = true; R.prog.setPointerCapture(e.pointerId); const t = tAt(e); if (t) { R.dragT = t; RC.seek(t); } });
    R.prog.addEventListener("pointermove", e => { if (!R.drag) return; const t = tAt(e); if (!t) return; R.dragT = t; const now = performance.now(); if (now - lastSeek > 120) { lastSeek = now; RC.seek(t); } });
    R.prog.addEventListener("pointerup", e => { if (!R.drag) return; R.drag = false; const t = tAt(e); if (t) RC.seek(t); });
    box.classList.add("hidden");
    // keys
    window.addEventListener("keydown", e => {
      if (TV.typing(e) || TV.dialogOpen() || e.ctrlKey || e.metaKey) return;
      const k = e.key;
      if (k === "Escape" && R.selecting) { R.pick(false); e.stopImmediatePropagation(); return; }
      if (RC.state && RC.state.live) return;                 // live: the keys belong to the chart
      if (k === " ") RC.toggle();
      else if (k === "ArrowLeft") R.nudge(-1, e);
      else if (k === "ArrowRight") R.nudge(1, e);
      else if (k === "PageUp") RP.dayJump(-1);
      else if (k === "PageDown") RP.dayJump(1);
      else if (k === "Home") R.at("session");
      else if ((k === "n" || k === "N") && !e.shiftKey && !e.altKey) R.nextOpen();
      else return;
      e.preventDefault();
    });
  };
  // live or replay - the clock says which; the bar shows in replay and while a bar is being chosen
  R.isLive = () => !!(RC.state && RC.state.live);
  R.toggle = function () { if (R.selecting) R.pick(false); else if (R.isLive()) R.pick(true); else R.live(); };
  R.pick = function (on) { R.selecting = !!on; R.hover = null; if (R.pickBtn) R.pickBtn.classList.toggle("on", R.selecting); TV.app.applyCursor(); TV.app.redrawAll(); TV.app.topState(); R.update(); };
  R.live = function () { R.pick(false); return RC.send("live", { inst: TV.app.inst() }); };
  let lastPick = 0, pickT = null;
  const seekPick = (t, force) => { pickT = t; const now = performance.now(); if (force || now - lastPick > 120) { lastPick = now; RC.seek(Math.round(t)); pickT = null; } };
  const barStart = (c, x) => { const b = c.barAtX(x); const t = b ? b.t : c.tOfX(x); return t == null ? null : Math.max(0, Math.floor(t)); };
  R.pickHandler = {                                          // first of the chart's pointer handlers (app.js)
    down(c, x, y, e) { if (!R.selecting) return false; const t = barStart(c, x); if (t == null) return true; R.hover = { c, x, t }; R.dragging = true; seekPick(t, true); return true; },
    move(c, x, y) { if (!R.dragging) return; const t = barStart(c, x); if (t == null) return; R.hover = { c, x, t }; seekPick(t); TV.app.redrawAll(); },
    up(c, x) { if (!R.dragging) return; R.dragging = false; if (pickT != null) RC.seek(Math.round(pickT)); pickT = null; R.pick(false); },
    hover(c, x) { if (!R.selecting) return null; const t = barStart(c, x); R.hover = t == null ? null : { c, x, t }; TV.app.redrawAll(); return "col-resize"; },
  };
  R.layer = c => ({                                          // the line that follows the mouse while a bar is chosen
    draw(ctx, w, h) {
      if (!R.selecting || !R.hover || R.hover.c !== c) return;
      const x = Math.round(c.xOf(R.hover.t) ?? R.hover.x) + 0.5;
      ctx.strokeStyle = "#2962ff"; ctx.lineWidth = 1; ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    },
    time() { if (!R.selecting || !R.hover || R.hover.c !== c) return []; return [{ x: c.xOf(R.hover.t) ?? R.hover.x, text: "Replay ab " + TV.fmtCross(R.hover.t, c.tf), bg: "#2962ff" }]; },
  });

  R.update = function () {
    const s = RC.state, t = RC.now();
    if (!R.playBtn) return;
    const show = R.selecting || (s && s.t != null && !s.live), box = TV.$("#replay");
    if (box.classList.contains("hidden") === !!show) box.classList.toggle("hidden", !show);
    const playing = !!(s && s.playing);
    if (R._pl !== playing) { R._pl = playing; R.playBtn.replaceChildren(TV.iconSm(playing ? "pause" : "play", 22)); R.playBtn.classList.toggle("on", playing); }
    if (s) R.speedTxt.textContent = (s.live ? 1 : s.speed) + "×";
    R.msg.textContent = RC.error ? "Uhr: " + RC.error : "";
    if (t == null) { R.timeEl.textContent = "–"; return; }
    const td = RC.tradeDate(t); R.o = RC.opens(td);
    const dtxt = new Intl.DateTimeFormat("de-AT", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "2-digit", year: "2-digit" }).format(new Date(td + "T12:00:00Z"));
    if (R.dayTxt.textContent !== dtxt) R.dayTxt.textContent = dtxt;
    const tt = RC.fmtTime(t, true) + " " + (RC.tz() === "NY" ? "NY" : "Wien");
    if (R.timeEl.textContent !== tt) R.timeEl.textContent = tt;
    const f = Math.max(0, Math.min(1, (((R.drag && R.dragT) || t) - R.o.session) / (R.o.end - R.o.session)));
    R.fill.style.width = (f * 100) + "%"; R.knob.style.left = (f * 100) + "%";
    const sigM = td + RC.tz();
    if (R._marks !== sigM) {
      R._marks = sigM; R.prog.querySelectorAll(".mk").forEach(x => x.remove());
      for (const [k, name] of [["asia", "Asia"], ["london", "LDN"], ["ny", "NY"], ["ib", "IB"], ["close", "16:00"]]) {
        const m = el("div.mk", { style: { left: ((R.o[k] - R.o.session) / (R.o.end - R.o.session) * 100) + "%" }, title: name }, el("span", { text: name }));
        R.prog.append(m);
      }
    }
  };

  // ---- the calendar: trade dates of the archive, then a moment of the day
  R.calendar = async function (anchor) {
    const inst = TV.app.inst(), list = await RP.sessions(inst), have = new Set(list.map(s => s.date));
    const t = RC.now(), cur = t != null ? RC.tradeDate(t) : (list.length ? list[list.length - 1].date : null);
    if (!cur) { TV.toast("Keine Handelstage im Archiv – die Ordner in den Einstellungen prüfen", "err"); return; }
    let ym = cur.slice(0, 7), pick = cur;
    let dlg = null;
    dlg = TV.dialog({ title: "Gehe zu", width: 360, body: b => {
      const wrap = el("div.cal"); b.append(wrap);
      const render = () => {
        wrap.replaceChildren();
        const [y, m] = ym.split("-").map(Number), first = new Date(Date.UTC(y, m - 1, 1)), days = new Date(Date.UTC(y, m, 0)).getUTCDate(), lead = (first.getUTCDay() + 6) % 7;
        const mname = new Intl.DateTimeFormat("de-AT", { timeZone: "UTC", month: "long", year: "numeric" }).format(first);
        const shift = k => { const d = new Date(Date.UTC(y, m - 1 + k, 1)); ym = d.toISOString().slice(0, 7); render(); };
        wrap.append(el("div.cm", null, el("button.lg-btn", { onclick: () => shift(-1), title: "Voriger Monat" }, TV.iconSm("left")), el("b", { text: mname }), el("button.lg-btn", { onclick: () => shift(1), title: "Nächster Monat" }, TV.iconSm("right"))));
        const g = el("div.cg"); for (const w of ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]) g.append(el("div.wd", { text: w }));
        for (let i = 0; i < lead; i++) g.append(el("div"));
        for (let d = 1; d <= days; d++) {
          const ds = `${ym}-${String(d).padStart(2, "0")}`, ok = have.has(ds);
          g.append(el("div.d" + (ok ? ".has" : "") + (ds === pick ? ".sel" : ""), { text: d, title: ok ? "" : "keine Daten", onclick: ok ? () => { pick = ds; render(); } : null, ondblclick: ok ? () => { RP.goDate(ds); dlg.close(); } : null }));
        }
        wrap.append(g);
        const at = (k, name) => el("button", { text: name, onclick: () => { const o = RC.opens(pick); RC.seek(k === "pre" ? o.ny - 1800 : o[k]); dlg.close(); } });
        wrap.append(el("div", { style: { marginTop: "12px", color: "var(--text2)" }, text: new Intl.DateTimeFormat("de-AT", { timeZone: "UTC", weekday: "long", day: "2-digit", month: "long", year: "numeric" }).format(new Date(pick + "T12:00:00Z")) }),
          el("div.times", null, at("session", "18:00 Session"), at("asia", "Asia"), at("london", "London"), at("pre", "09:00 NY"), at("ny", "NY 09:30"), at("ib", "IB 10:30"), at("close", "16:00")));
        const nav = el("div", { style: { display: "flex", gap: "8px", marginTop: "12px" } },
          el("button.btn", { text: "Neuester Tag", onclick: () => { pick = list[list.length - 1].date; ym = pick.slice(0, 7); render(); } }),
          el("button.btn", { text: "Zufälliger Tag", title: "Ein zufälliger Handelstag – blind üben", onclick: () => { pick = list[Math.floor(Math.random() * list.length)].date; ym = pick.slice(0, 7); render(); } }));
        wrap.append(nav);
      };
      render();
    } });
  };

  // ---- the first window of a fresh server sets the clock
  R.init = async function () {
    const insts = await RP.instruments().catch(() => []);
    const wait = Date.now() + 1500;
    while (!RC.state && Date.now() < wait) await new Promise(r => setTimeout(r, 50));
    if (!RC.state || RC.state.t == null) {                   // a fresh server: live, as TradingView opens
      const inst = (RC.state && RC.state.inst) || insts[0] || "ES";
      await RC.send("live", { inst });
      if (!insts.length) TV.toast("Keine Handelstage im Archiv gefunden – Ordner in den Einstellungen (/config.html) prüfen", "err", 8000);
    }
  };
})();
