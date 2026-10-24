/* footprint.js - the footprint chart of tv.html, and the data window: every bar's volume per price, split into
 * the sellers' (bid) and the buyers' (ask) aggression, straight from the server (/tl/levels - the archive's levels per
 * minute, summed per bar of the pane's timeframe, cut at the replay clock like everything else; the forming minute
 * from its 1-second bars). Meant to be checked against ATAS / the bridge's export number by number:
 *   chart type "Footprint"   per bar a thin candle and the cluster beside it: Bid × Ask (as ATAS), Bid | Ask as two
 *                            histograms (as TradingView), delta, or volume; the bar's POC framed, diagonal imbalances
 *                            highlighted (ask against the bid one row lower, bid against the ask one row higher). Bar
 *                            length = the
 *                            level's volume against the largest level of all bars in view (as ATAS). Rows of
 *                            one tick, or several when zoomed out ("Auto"); zoomed out further, the normal candles.
 *   data window              the bar and the level under the cursor in every chart type: O H L C, volume, buyers,
 *                            sellers, delta, the levels' sum against the bar's volume (≠ when they differ), the bar's
 *                            POC, and at the cursor's price bid, ask, volume, delta.
 *   right-click              "Footprint dieses Bars kopieren (CSV)" - the levels of one bar for a spreadsheet. */
(function () {
  const { el } = TV;
  const FP = TV.FP = {};
  const MIN_COL = 14;                                        // narrower columns: the normal candles
  FP.DEF = { mode: "bidask", row: 0, imb: true, ratio: 300, imbMin: 5, poc: true, candle: true, va: false };
  FP.MODES = [["bidask", "Bid × Ask (wie ATAS)"], ["split", "Bid | Ask als Histogramme (wie TradingView)"], ["delta", "Delta je Preis"], ["volume", "Volumen je Preis"]];
  const cfgOf = c => (c.cfg.fp = Object.assign({}, FP.DEF, TV.store.get("fp.defaults", {}), c.cfg.fp || {}));
  const font = (px, w) => `${w || 400} ${px}px Consolas, "Cascadia Mono", Menlo, monospace`;

  // ---------------------------------------------------------------- the levels of the bars, per pane
  const ST = new WeakMap();
  const state = c => {
    let s = ST.get(c); const key = `${c.inst}|${c.cfg.tf}`;
    if (!s || s.key !== key) { s = { key, map: new Map(), busy: false, at: 0, miss: null }; ST.set(c, s); }
    return s;
  };
  FP.onData = function (c, kind) {
    const s = state(c);
    if (kind === "reset") s.map.clear();
    else if (kind === "back") for (const [t, e] of s.map) if (t + c.tfSec() > c.lastT || !e.fin) { e.fin = false; e.until = null; }   // stale, kept on screen until the new one is here
  };
  FP.levels = (c, i) => { const b = c.BARS[i]; if (!b) return null; const e = state(c).map.get(b.t); return e ? e.lv : null; };
  // fetch what bars i0..i1 lack: finished bars once, the forming one again when the clock moved
  FP.ensure = function (c, i0, i1) {
    const s = state(c), B = c.BARS; if (!B.length || c.lastT == null) return;
    i0 = Math.max(0, i0); i1 = Math.min(B.length - 1, i1);
    let a = -1, b = -1;
    for (let i = i0; i <= i1; i++) { const e = s.map.get(B[i].t); if (!e || (!e.fin && e.until !== c.lastT)) { if (a < 0) a = i; b = i; } }
    if (a < 0 || s.busy) return;
    const now = performance.now(), onlyForming = a === b && b === B.length - 1 && s.map.has(B[b].t);
    if (onlyForming && now - s.at < (RC.state && RC.state.playing ? 300 : 120)) return;   // the forming bar: a few times a second
    s.busy = true; s.at = now;
    const from = B[a].t, to = B[b].t + c.tfSec(), until = c.lastT, key = s.key, tf = c.cfg.tf;
    TV.getJSON(`/tl/levels?inst=${encodeURIComponent(c.inst)}&tf=${tf}&from=${from}&to=${to}&until=${until}`).then(j => {
      if (state(c).key !== key) return;
      const lv = j.levels || {};
      for (let i = a; i <= b && i < c.BARS.length; i++) {
        const t = c.BARS[i].t;
        s.map.set(t, { lv: (lv[t] || lv[String(t)] || []).slice().sort((x, y) => x[0] - y[0]), fin: t + tf * 60 <= until, until });
      }
      c.redraw(); if (FP.dw) FP.dwUpdate();
    }).catch(() => {}).finally(() => { s.busy = false; });
  };

  // ---------------------------------------------------------------- rows: levels summed into rows of n ticks
  function rowsOf(lv, n, tick) {
    const m = new Map();
    for (const [p, v, buy, sell] of lv) {                    // a level: price, volume, bought at the ask, sold at the bid
      const k = Math.floor(Math.round(p / tick) / n + 1e-9), e = m.get(k) || { k, v: 0, b: 0, a: 0 };
      e.v += v; e.b += sell; e.a += buy; m.set(k, e);
    }
    return m;
  }
  function geometry(c) {                                      // column width, one tick in px
    const ts = c.chart.timeScale(), B = c.BARS; if (B.length < 2) return null;
    const r = ts.getVisibleLogicalRange(); if (!r) return null;
    const x0 = ts.logicalToCoordinate(B.length - 2), x1 = ts.logicalToCoordinate(B.length - 1);
    const ref = B[B.length - 1].c, y0 = c.yOf(ref), y1 = c.yOf(ref + TV.TICK);
    if (x0 == null || x1 == null || y0 == null || y1 == null) return null;
    return { colW: x1 - x0, tickPx: Math.abs(y0 - y1), k0: Math.max(0, Math.floor(r.from)), k1: Math.min(B.length - 1, Math.ceil(r.to)) };
  }

  // ---------------------------------------------------------------- the chart type: switching candles and clusters
  const CLEAR = "rgba(0,0,0,0)";
  FP.frame = function (c) {
    const on = c.cfg.type === "footprint" && TV.app.settings && (() => { const g = geometry(c); return g && g.colW >= MIN_COL && g.tickPx * 1 >= 0.6; })();
    if (on !== !!c.fpOn) {
      c.fpOn = on;
      const S = TV.app.settings;
      if (on) c.series.applyOptions({ upColor: CLEAR, downColor: CLEAR, borderUpColor: CLEAR, borderDownColor: CLEAR, wickUpColor: CLEAR, wickDownColor: CLEAR, lastValueVisible: false, priceLineVisible: false });
      else c.series.applyOptions({ upColor: S.up, downColor: S.down, borderUpColor: S.up, borderDownColor: S.down, wickUpColor: S.up, wickDownColor: S.down, lastValueVisible: true, priceLineVisible: true });
      c.redraw();
    }
    if (on) { const g = geometry(c); if (g) FP.ensure(c, g.k0, g.k1); }
    FP.legendValues(c);
  };
  FP.rowTicks = function (c, g) {
    const p = cfgOf(c); if (p.row > 0) return p.row;
    for (const n of [1, 2, 4, 5, 8, 10, 20, 40, 80, 160]) if (g.tickPx * n >= 11) return n;
    return 160;
  };

  FP.layer = c => ({
    draw(ctx, w, h) {
      if (c.cfg.type !== "footprint" || !c.fpOn) return;
      const g = geometry(c); if (!g) return;
      const p = cfgOf(c), B = c.BARS, tick = TV.TICK, n = FP.rowTicks(c, g), rowP = n * tick, rowH = g.tickPx * n;
      const S = TV.app.settings, cs = getComputedStyle(document.body), txt = cs.getPropertyValue("--text2").trim() || "#b2b5be";
      const ph = h;
      // rows of every bar in view, the largest row of them all (the reference for every bar's length)
      const rows = new Map(); let vmax = 1, dmax = 1;
      for (let i = g.k0; i <= g.k1; i++) { const lv = FP.levels(c, i); if (!lv) continue; const m = rowsOf(lv, n, tick); rows.set(i, m); for (const e of m.values()) { vmax = Math.max(vmax, e.v); dmax = Math.max(dmax, Math.abs(e.a - e.b)); } }
      const digits = String(vmax).length, fsz = Math.max(8, Math.min(12, Math.floor(rowH) - 1)), cw0 = fsz * 0.6;
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, ph); ctx.clip();
      for (let i = g.k0; i <= g.k1; i++) {
        const b = B[i], xc = c.lx(i); if (xc == null) continue;
        const left = xc - g.colW / 2 + 1, right = Math.min(xc + g.colW / 2 - 1, w - 2); if (right < 0 || left > w) continue;
        const up = b.c >= b.o, col = up ? S.up : S.down;
        let cl = left;
        if (p.candle) {                                          // the bar itself, thin, at the left of its column
          const cx = Math.round(left + 3) + 0.5, yH = c.yOf(b.h), yL = c.yOf(b.l), yO = c.yOf(b.o), yC = c.yOf(b.c);
          ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, yH); ctx.lineTo(cx, yL); ctx.stroke();
          ctx.fillStyle = col; ctx.fillRect(cx - 2, Math.min(yO, yC), 4, Math.max(1, Math.abs(yO - yC)));
          cl = left + 8;
        }
        const m = rows.get(i), cwid = right - cl; if (!m || cwid < 6) continue;
        let poc = null, kmin = Infinity, kmax = -Infinity; for (const e of m.values()) { if (!poc || e.v > poc.v) poc = e; kmin = Math.min(kmin, e.k); kmax = Math.max(kmax, e.k); }
        const yTop = c.yOf((kmax + 1) * rowP), yBot = c.yOf(kmin * rowP);
        ctx.strokeStyle = "rgba(120,123,134,0.28)"; ctx.lineWidth = 1; ctx.strokeRect(Math.round(cl) - 0.5, Math.round(yTop) + 0.5, Math.round(cwid) + 1, Math.round(yBot - yTop));
        const need = p.mode === "bidask" || p.mode === "split" ? 2 * digits * cw0 + 16 : (digits + 1) * cw0 + 4;
        const text = rowH >= 9 && cwid >= need;
        let va = null;
        if (p.va) va = valueArea(m);
        for (const e of m.values()) {
          const y0 = c.yOf((e.k + 1) * rowP), y1 = c.yOf(e.k * rowP); if (y0 == null || y1 == null) continue;
          const hh = Math.max(1, y1 - y0 - (y1 - y0 > 3 ? 1 : 0)), ym = (y0 + y1) / 2, dlt = e.a - e.b;
          const below = m.get(e.k - 1), above = m.get(e.k + 1);
          // diagonal, as ATAS: the buyers at a price against the sellers one row lower, the sellers against the buyers one higher
          const imbA = p.imb && !!below && e.a >= p.imbMin && e.a * 100 >= p.ratio * below.b;
          const imbB = p.imb && !!above && e.b >= p.imbMin && e.b * 100 >= p.ratio * above.a;
          if (p.mode === "split") {
            const mid = cl + cwid / 2, half = cwid / 2 - 1;
            ctx.fillStyle = TV.rgba(S.down, 0.45); ctx.fillRect(mid - half * e.b / vmax, y0, half * e.b / vmax, hh);
            ctx.fillStyle = TV.rgba(S.up, 0.45); ctx.fillRect(mid, y0, half * e.a / vmax, hh);
          } else if (p.mode === "delta") {
            ctx.fillStyle = TV.rgba(dlt >= 0 ? S.up : S.down, 0.12 + 0.6 * Math.abs(dlt) / dmax); ctx.fillRect(cl, y0, cwid, hh);
          } else {
            const dom = e.b > e.a ? S.down : S.up, isPoc = e === poc;
            ctx.fillStyle = TV.rgba(dom, isPoc ? 0.75 : 0.32); ctx.fillRect(cl, y0, Math.max(1, cwid * e.v / vmax), hh);
          }
          if (va && e.k >= va[0] && e.k <= va[1]) { ctx.fillStyle = "rgba(255,255,255,0.05)"; ctx.fillRect(cl, y0, cwid, hh); }
          if (!text) { if (imbA || imbB) { ctx.fillStyle = imbA ? "#00e5a8" : "#ff4d5e"; ctx.fillRect(imbA ? right - 3 : cl, y0, 2, hh); } continue; }
          ctx.textBaseline = "middle";
          if (p.mode === "bidask" || p.mode === "split") {
            const mid = cl + cwid / 2;
            ctx.font = font(fsz, imbB ? 700 : 400); ctx.textAlign = "right"; ctx.fillStyle = imbB ? "#ff4d5e" : e.b > e.a ? "#ff8a80" : txt; ctx.fillText(String(e.b), mid - 5, ym + 0.5);
            ctx.font = font(fsz); ctx.textAlign = "center"; ctx.fillStyle = "rgba(120,123,134,0.9)"; ctx.fillText(p.mode === "split" ? "|" : "x", mid, ym + 0.5);
            ctx.font = font(fsz, imbA ? 700 : 400); ctx.textAlign = "left"; ctx.fillStyle = imbA ? "#00e5a8" : e.a > e.b ? "#7ee2c4" : txt; ctx.fillText(String(e.a), mid + 5, ym + 0.5);
          } else {
            const v = p.mode === "delta" ? (dlt > 0 ? "+" : "") + dlt : String(e.v);
            ctx.font = font(fsz, imbA || imbB ? 700 : 400); ctx.textAlign = "center";
            ctx.fillStyle = p.mode === "delta" ? (dlt >= 0 ? "#7ee2c4" : "#ff8a80") : txt; ctx.fillText(v, cl + cwid / 2, ym + 0.5);
          }
        }
        if (p.poc && poc) { const y0 = c.yOf((poc.k + 1) * rowP), y1 = c.yOf(poc.k * rowP); ctx.strokeStyle = "#ffeb3b"; ctx.lineWidth = 1; ctx.strokeRect(Math.round(cl) + 0.5, Math.round(y0) + 0.5, Math.round(cwid) - 1, Math.max(1, Math.round(y1 - y0) - 1)); }
      }
      ctx.restore(); ctx.textAlign = "left";
      const lb = B[B.length - 1], yl = c.yOf(lb.c);                     // the last price, dashed across the chart
      if (yl != null) { ctx.strokeStyle = lb.c >= lb.o ? S.up : S.down; ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, Math.round(yl) + 0.5); ctx.lineTo(w, Math.round(yl) + 0.5); ctx.stroke(); ctx.setLineDash([]); }
    },
    axis() {                                                   // the last price, as the hidden series would show it
      if (c.cfg.type !== "footprint" || !c.fpOn || !c.BARS.length) return [];
      const b = c.BARS[c.BARS.length - 1]; return [{ y: c.yOf(b.c), text: TV.fp(b.c, c.tick()), bg: b.c >= b.o ? TV.app.settings.up : TV.app.settings.down }];
    },
  });
  function valueArea(m) {                                    // 70 % of the bar's volume around its POC, in row keys
    const ks = [...m.keys()].sort((a, b) => a - b), v = ks.map(k => m.get(k).v), tot = v.reduce((a, x) => a + x, 0);
    let pi = 0; v.forEach((x, i) => { if (x > v[pi]) pi = i; });
    let lo = pi, hi = pi, acc = v[pi];
    while (acc < tot * 0.7 && (lo > 0 || hi < v.length - 1)) { const u = hi < v.length - 1 ? v[hi + 1] : -1, d = lo > 0 ? v[lo - 1] : -1; if (u >= d) { hi++; acc += u; } else { lo--; acc += d; } }
    return [ks[lo], ks[hi]];
  }
  function sessionDelta(c, i) {                               // the delta of the session up to bar i (bars loaded from its start)
    const B = c.BARS, si = c.sessIdx(B[i].t), s0 = si >= 0 ? c.SESS[si].start : -Infinity;
    let d = 0; for (let k = i; k >= 0 && B[k].t >= s0; k--) d += B[k].delta;
    return d;
  }

  // ---------------------------------------------------------------- legend row and settings
  FP.legendRow = function (c) {
    if (c.cfg.type !== "footprint") return null;
    const p = cfgOf(c), vals = el("span.vals");
    const row = el("div.lg-row", null, el("span.lg-study", null, el("span.nm", { text: "Footprint · " + FP.MODES.find(m => m[0] === p.mode)[1].split(" (")[0] }), vals,
      el("span.btns", null, el("button.lg-btn", { title: "Footprint-Einstellungen", onclick: () => FP.settings(c) }, TV.iconSm("gear")))));
    c._fpVals = vals; return row;
  };
  FP.legendValues = function (c) {
    if (!c._fpVals || c.cfg.type !== "footprint") return;
    const g = geometry(c); let t = "";
    if (!c.fpOn) t = "zum Lesen hineinzoomen";
    else if (g) { const n = FP.rowTicks(c, g); t = `Zeile ${n} Tick${n > 1 ? "s" : ""}`; }
    if (c._fpVals.textContent !== t) c._fpVals.textContent = t;
  };
  FP.settings = function (c) {
    const p = cfgOf(c), before = JSON.stringify(p);
    const changed = () => { TV.app.saveLayout(); c.legend(); c.redraw(); };
    TV.dialog({ title: "Footprint", width: 500, body: b => TV.form(b, [
      { key: "mode", label: "Darstellung", type: "select", str: true, options: FP.MODES },
      { key: "row", label: "Ticks je Zeile (0 = automatisch)", type: "num", min: 0, max: 400 },
      { key: "imb", label: "Imbalances (diagonal)", type: "bool" }, { key: "ratio", label: "Imbalance ab (%)", type: "num", min: 110, max: 2000, step: 10 },
      { key: "imbMin", label: "… mit mindestens (Kontrakte)", type: "num", min: 0, max: 10000 },
      { key: "poc", label: "POC je Bar umrahmen", type: "bool" }, { key: "va", label: "Value Area je Bar aufhellen", type: "bool" },
      { key: "candle", label: "Kerze links in der Spalte", type: "bool" }], p, changed),
      buttons: [{ label: "Werkseinstellung", action: () => { c.cfg.fp = Object.assign({}, FP.DEF); changed(); } },
                { label: "Als Standard speichern", action: () => { TV.store.set("fp.defaults", Object.assign({}, p)); for (const x of TV.app.charts) if (x !== c) { x.cfg.fp = Object.assign({}, p); x.legend(); x.redraw(); } TV.app.saveLayout(); TV.toast("Footprint: als Standard gespeichert", "ok"); return false; } },
                { label: "Abbrechen", action: () => { c.cfg.fp = JSON.parse(before); changed(); } }, { label: "OK", kind: "pri" }] });
  };
  FP.zoomIn = function (c) {                                 // wide enough columns for the numbers right away
    const n = c.BARS.length; if (!n) return;
    const w = c.chart.timeScale().width(), cols = Math.max(6, Math.floor(w / 120));
    c.chart.timeScale().setVisibleLogicalRange({ from: n - cols + 2, to: n + 2 });
  };

  // ---------------------------------------------------------------- copying one bar
  FP.csv = async function (c, i) {
    const b = c.BARS[i]; if (!b) return;
    FP.ensure(c, i, i);
    for (let k = 0; k < 40 && !FP.levels(c, i); k++) await new Promise(r => setTimeout(r, 50));
    const lv = FP.levels(c, i); if (!lv) { TV.toast("Keine Level für diesen Bar", "err"); return; }
    const iso = new Date(b.t * 1000).toISOString().replace(".000", "");
    const lines = ["bar_start_utc;bar_start_ny;timeframe_min;price;volume;bid_sellers;ask_buyers;delta"];
    const ny = RC.fmtFull(b.t);
    for (const [p, v, buy, sell] of lv.slice().sort((x, y) => y[0] - x[0])) lines.push([iso, ny, c.cfg.tf, TV.fp(p, c.tick()), v, sell, buy, buy - sell].join(";"));
    const sv = lv.reduce((a, x) => a + x[1], 0), sa = lv.reduce((a, x) => a + x[2], 0), sb = lv.reduce((a, x) => a + x[3], 0);
    lines.push(["", "", "", "Summe Level", sv, sb, sa, sa - sb].join(";"), ["", "", "", "Bar (/tl/bars)", b.v, b.sell, b.buy, b.delta].join(";"));
    const text = lines.join("\n");
    try { await navigator.clipboard.writeText(text); TV.toast(`Footprint ${RC.fmtTime(b.t)} kopiert (${lv.length} Level) – in eine Tabelle einfügen`, "ok"); }
    catch (e) { const a = el("a", { href: "data:text/csv;charset=utf-8," + encodeURIComponent(text), download: `footprint_${c.inst}_${TV.tfName(c.cfg.tf)}_${iso.replace(/[:]/g, "")}.csv` }); document.body.append(a); a.click(); a.remove(); }
  };

  // ---------------------------------------------------------------- the data window
  FP.dwToggle = function (on) {
    FP.dw = on == null ? !FP.dw : on; TV.store.set("dw", FP.dw);
    let box = TV.$("#dwin");
    if (FP.dw && !box) { box = el("div"); box.id = "dwin"; TV.$("#stage").append(box); }
    if (box) box.style.display = FP.dw ? "block" : "none";
    FP.dwUpdate(); TV.app.rightBar();
  };
  FP.dwUpdate = function () {
    const box = TV.$("#dwin"); if (!box || !FP.dw) return;
    const c = FP.dwChart || TV.app.active; if (!c || !c.BARS.length) { box.replaceChildren(); return; }
    let i = c.BARS.length - 1, price = null;
    if (c.cross && c.cross.t != null) { i = c.idxOf(c.cross.t); price = c.cross.p; }
    const b = c.BARS[i]; if (!b) return;
    const tk = c.tick(), lv = FP.levels(c, i); if (!lv) FP.ensure(c, i, i);
    const S = TV.app.settings, colr = v => v >= 0 ? S.up : S.down, sgn = v => (v > 0 ? "+" : "") + v;
    const rows = [["head", `${c.inst} · ${TV.tfName(c.cfg.tf)}`], ["Zeit", TV.fmtCross(b.t, c.cfg.tf) + (b.forming ? " (läuft)" : "") + (b.approx ? " · aus 1s-Bars" : "")],
      ["Eröffnung", TV.fp(b.o, tk)], ["Hoch", TV.fp(b.h, tk)], ["Tief", TV.fp(b.l, tk)], ["Schluss", TV.fp(b.c, tk), b.c >= b.o ? S.up : S.down],
      ["Volumen", String(b.v)], ["Käufer (Ask)", String(b.buy)], ["Verkäufer (Bid)", String(b.sell)], ["Delta", sgn(b.delta), colr(b.delta)],
      ["Delta %", b.v ? (b.delta / b.v * 100).toFixed(1) + " %" : "–", colr(b.delta)], ["Δ Session", sgn(sessionDelta(c, i)), colr(sessionDelta(c, i))]];
    if (lv) {
      const sv = lv.reduce((a, x) => a + x[1], 0), sa = lv.reduce((a, x) => a + x[2], 0), sb = lv.reduce((a, x) => a + x[3], 0);
      let poc = lv[0]; for (const x of lv) if (x[1] > poc[1]) poc = x;
      rows.push(["sep"], ["head", "Level des Bars"], ["Anzahl", String(lv.length)], ["Σ Volumen", String(sv) + (sv === b.v ? "  ✓" : `  ≠ ${b.v}`), sv === b.v ? null : "#ff9800"],
        ["Σ Ask / Σ Bid", `${sa} / ${sb}` + (sa === b.buy && sb === b.sell ? "  ✓" : "  ≠"), sa === b.buy && sb === b.sell ? null : "#ff9800"], ["POC", `${TV.fp(poc[0], tk)} (${poc[1]})`]);
      if (price != null) {
        const pr = Math.round(price / TV.TICK) * TV.TICK, x = lv.find(l => Math.abs(l[0] - pr) < 1e-9);
        rows.push(["sep"], ["head", "Am Cursor " + TV.fp(pr, tk)]);
        if (x) rows.push(["Bid × Ask", `${x[3]} × ${x[2]}`], ["Volumen", String(x[1])], ["Delta", sgn(x[2] - x[3]), colr(x[2] - x[3])]);
        else rows.push(["", "nicht gehandelt"]);
      }
    } else rows.push(["sep"], ["", "Level werden geladen …"]);
    const sig = JSON.stringify(rows); if (box._sig === sig) return; box._sig = sig;
    box.replaceChildren(...rows.map(r => r[0] === "sep" ? el("div.dsep") : r[0] === "head" ? el("div.dh2", { text: r[1] }) : el("div.dr", null, el("span", { text: r[0] }), el("b", { text: r[1], style: r[2] ? { color: r[2] } : null }))));
  };
})();
