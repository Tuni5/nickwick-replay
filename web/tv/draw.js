/* draw.js - the drawing tools of tv.html, as in TradingView: the tool bar on the left with its groups and
 * flyouts, lines (trend, ray, extended, horizontal line and ray, vertical, cross, parallel channel, arrow), Fib
 * retracement, rectangle, brush and highlighter, text, note, price label, long / short position, price / date range,
 * fixed range volume profile, the ruler (Shift + drag). Click a drawing to select it: handles, moving, the floating
 * style bar (colour, fill, width, style, text, settings, lock, delete); double-click for its settings; right-click for
 * its menu. Points are {t, p} - time and price - so a drawing stands in every timeframe and every pane at once.
 * Kept per instrument in the browser (localStorage "tv.draw.v1.<inst>"); other windows follow (BroadcastChannel).
 * Undo / redo: Ctrl+Z / Ctrl+Y. A horizontal line can carry an alarm: when the replay crosses it, the clock pauses. */
(function () {
  const { el } = TV;
  const fontOf = (px, w) => `${w || 400} ${px}px ` + getComputedStyle(document.body).getPropertyValue("--font");
  const dashOf = s => s === "dashed" ? [6, 4] : s === "dotted" ? [2, 3] : [];
  const FIB = [[0, "#787b86", true], [0.236, "#f23645", true], [0.382, "#ff9800", true], [0.5, "#4caf50", true], [0.618, "#089981", true],
               [0.786, "#00bcd4", true], [1, "#787b86", true], [1.618, "#2962ff", false], [2.618, "#f23645", false], [-0.272, "#9c27b0", false]];
  const LINE = { color: "#2962ff", width: 2, style: "solid", extendL: false, extendR: false, text: "", textColor: "#2962ff" };
  const T = TV.DRAW_TOOLS = {
    trend: { name: "Trendlinie", icon: "trend", key: "Alt+T", n: 2, def: Object.assign({}, LINE) },
    ray: { name: "Strahl", icon: "ray", n: 2, as: "trend", def: Object.assign({}, LINE, { extendR: true }) },
    extended: { name: "Erweiterte Linie", icon: "extended", n: 2, as: "trend", def: Object.assign({}, LINE, { extendL: true, extendR: true }) },
    hline: { name: "Horizontale Linie", icon: "hline", key: "Alt+H", n: 1, def: { color: "#2962ff", width: 1, style: "solid", showPrice: true, text: "", textColor: "#2962ff", alert: false } },
    hray: { name: "Horizontaler Strahl", icon: "hray", key: "Alt+J", n: 1, def: { color: "#2962ff", width: 1, style: "solid", showPrice: true, text: "", textColor: "#2962ff", alert: false } },
    vline: { name: "Vertikale Linie", icon: "vline", key: "Alt+V", n: 1, def: { color: "#2962ff", width: 1, style: "solid", showTime: true } },
    crossline: { name: "Kreuzlinie", icon: "crossline", key: "Alt+C", n: 1, def: { color: "#2962ff", width: 1, style: "solid", showPrice: true, showTime: true } },
    channel: { name: "Paralleler Kanal", icon: "channel", n: 3, def: { color: "#2962ff", width: 1, style: "solid", fill: true, fillColor: "rgba(41,98,255,0.12)", mid: true, extendL: false, extendR: false } },
    arrowline: { name: "Pfeil", icon: "arrowline", n: 2, def: { color: "#2962ff", width: 2, style: "solid" } },
    fib: { name: "Fib Retracement", icon: "fib", key: "Alt+F", n: 2, def: { color: "#787b86", width: 1, style: "solid", fill: true, labels: true, extendR: false, levels: FIB.map(x => ({ v: x[0], color: x[1], on: x[2] })) } },
    rect: { name: "Rechteck", icon: "rect", key: "Alt+Shift+R", n: 2, def: { color: "#9c27b0", width: 1, style: "solid", fill: true, fillColor: "rgba(156,39,176,0.2)", extendR: false, text: "", textColor: "#d1d4dc" } },
    brush: { name: "Pinsel", icon: "brush", n: "free", def: { color: "#2962ff", width: 2, style: "solid" } },
    highlighter: { name: "Textmarker", icon: "highlighter", n: "free", def: { color: "rgba(255,235,59,0.38)", width: 14, style: "solid" } },
    text: { name: "Text", icon: "text", n: 1, def: { text: "", textColor: "#2962ff", fontSize: 14, bold: false, bg: false, fillColor: "rgba(41,98,255,0.15)" } },
    note: { name: "Notiz", icon: "note", n: 2, def: { text: "", textColor: "#ffffff", fontSize: 13, color: "#2962ff", fillColor: "rgba(41,98,255,0.9)" } },
    pricelabel: { name: "Preisbeschriftung", icon: "pricelabel", n: 1, def: { color: "#2962ff", textColor: "#ffffff", fontSize: 12 } },
    long: { name: "Long-Position", icon: "long", n: "pos", def: { qty: 1, up: "rgba(8,153,129,0.22)", down: "rgba(242,54,69,0.22)", labels: true } },
    short: { name: "Short-Position", icon: "short", n: "pos", def: { qty: 1, up: "rgba(8,153,129,0.22)", down: "rgba(242,54,69,0.22)", labels: true } },
    pricerange: { name: "Preisspanne", icon: "pricerange", n: 2, def: { color: "#2962ff", fillColor: "rgba(41,98,255,0.15)" } },
    daterange: { name: "Datumsbereich", icon: "daterange", n: 2, def: { color: "#2962ff", fillColor: "rgba(41,98,255,0.15)" } },
    datepricerange: { name: "Datums- und Preisbereich", icon: "datepricerange", n: 2, def: { color: "#2962ff", fillColor: "rgba(41,98,255,0.15)" } },
    frvp: { name: "Volumenprofil (fester Bereich)", icon: "frvp", n: 2, def: { width: 40, split: true, up: "rgba(41,98,255,0.30)", down: "rgba(251,192,45,0.30)", vaUp: "rgba(41,98,255,0.72)", vaDown: "rgba(251,192,45,0.72)", poc: "#f23645", pocExtend: false, box: true, color: "#2962ff", numbers: "exact", numDelta: 0 } },
    measure: { name: "Lineal (Shift + Ziehen)", icon: "ruler", n: 2, temp: true, def: {} },
  };
  const GROUPS = [
    { id: "cursor", tools: ["cross", "dot", "arrow", "eraser"] },
    { id: "lines", tools: ["trend", "ray", "extended", "hline", "hray", "vline", "crossline", "channel"] },
    { id: "fib", tools: ["fib"] },
    { id: "shapes", tools: ["brush", "highlighter", "rect", "arrowline"] },
    { id: "text", tools: ["text", "note", "pricelabel"] },
    { id: "forecast", tools: ["long", "short", "pricerange", "daterange", "datepricerange", "frvp"] },
  ];
  const CURSORS = { cross: ["Kreuz", "cross"], dot: ["Punkt", "dot"], arrow: ["Pfeil", "arrow"], eraser: ["Radierer", "eraser"] };
  const nameOf = t => T[t] ? T[t].name : CURSORS[t] ? CURSORS[t][0] : t;
  const iconOf = t => T[t] ? T[t].icon : CURSORS[t] ? CURSORS[t][1] : "cross";

  const D = TV.Draw = { tool: null, cursor: TV.store.get("draw.cursor", "cross"), magnet: TV.store.get("draw.magnet", "off"), stay: false,
                        lockAll: false, hidden: false, list: [], sel: null, make: null, drag: null, hover: null, undo: [], redo: [], inst: null,
                        last: TV.store.get("draw.last", {}), measure: null };
  const ch = ("BroadcastChannel" in window) ? new BroadcastChannel("tv-draw") : null;
  const key = () => "draw.v1." + (D.inst || "ES"), delKey = () => "draw.del." + (D.inst || "ES");
  // Several windows share the drawings of an instrument through localStorage. Each window keeps what it last saw of
  // every drawing (its JSON); saving stamps changed drawings with the time (u), remembers deleted ids with the time,
  // merges with what is in storage (newer stamp wins, a deletion beats an older stamp) and writes the merge - so two
  // windows never overwrite each other's work, whichever saves last.
  let seen = new Map();
  const dels = () => { const d = TV.store.get(delKey(), {}), cut = Date.now() - 86400000; for (const k in d) if (d[k] < cut) delete d[k]; return d; };
  function merge(local, remote, deleted) {
    const out = new Map();
    for (const r of remote) out.set(r.id, r);
    for (const l of local) { const r = out.get(l.id); if (!r || (l.u || 0) >= (r.u || 0)) out.set(l.id, l); }
    for (const id of Object.keys(deleted)) { const d = out.get(id); if (d && (d.u || 0) <= deleted[id]) out.delete(id); }
    return [...out.values()];
  }
  D.load = function (inst) { D.inst = inst; D.list = TV.store.get(key(), []); seen = new Map(D.list.map(d => [d.id, JSON.stringify(strip(d))])); D.sel = null; D.undo = []; D.redo = []; TV.app && TV.app.redrawAll(); D.styleBar(); };
  let gone = new Set();                                       // ids deleted here since the last save (explicit, not inferred)
  const mine = new Set();                                     // ids this window deleted itself: its undo may bring those back
  let known = {};                                             // deletions other windows told us about (localStorage lags between windows)
  D.forget = ids => { for (const id of ids) { gone.add(id); mine.add(id); } };
  D.save = function () {
    const now = Date.now(), deleted = Object.assign(dels(), known);
    for (const d of D.list) { const j = JSON.stringify(strip(d)); if (seen.get(d.id) !== j) { d.u = now; } }
    for (const id of seen.keys()) if (!D.list.some(d => d.id === id)) deleted[id] = now;
    for (const id of gone) if (!D.list.some(d => d.id === id)) deleted[id] = now;
    gone = new Set();
    const keep = new Map(D.list.filter(d => d === D.make || (D.drag && D.drag.d === d)).map(d => [d.id, d]));
    D.list = merge(D.list.map(strip), TV.store.get(key(), []), deleted).map(d => keep.get(d.id) || d);
    seen = new Map(D.list.map(d => [d.id, JSON.stringify(strip(d))]));
    TV.store.set(key(), D.list.map(strip)); TV.store.set(delKey(), deleted); known = deleted;
    if (ch) ch.postMessage({ inst: D.inst, list: D.list.map(strip), deleted });    // the data ride along: another window's localStorage may lag
    TV.app.redrawAll(); D.styleBar(); if (D.treeOpen) D.treeOpen();
  };
  if (ch) ch.onmessage = e => {
    if (!e.data || e.data.inst !== D.inst || !e.data.list) return;
    known = Object.assign(known, e.data.deleted || {});
    const busy = new Map(D.list.filter(d => d === D.make || (D.drag && D.drag.d === d)).map(d => [d.id, d]));
    D.list = merge(D.list.map(strip), e.data.list, Object.assign(dels(), known)).map(d => busy.get(d.id) || d);
    seen = new Map(D.list.map(d => [d.id, JSON.stringify(strip(d))]));
    if (!D.list.some(d => d.id === D.sel)) D.sel = null;
    TV.app.redrawAll(); D.styleBar();
  };
  const strip = d => { const o = Object.assign({}, d); delete o._vp; delete o._vpKey; delete o._vpBusy; delete o._box; return o; };
  D.snap = function () { D.undo.push(JSON.stringify(D.list.map(strip))); if (D.undo.length > 100) D.undo.shift(); D.redo = []; };
  const restore = j => {
    const before = D.list, others = Object.assign(dels(), known);
    D.list = JSON.parse(j).filter(d => mine.has(d.id) || !(d.id in others) || before.some(x => x.id === d.id));   // not what another window deleted
    const now = Date.now(); for (const d of D.list) d.u = now;
    const dropped = before.filter(x => !D.list.some(d => d.id === x.id)).map(x => x.id); for (const id of dropped) mine.add(id);
    D.forget(dropped); D.sel = null; D.save();
  };
  D.doUndo = function () { if (!D.undo.length) return; D.redo.push(JSON.stringify(D.list.map(strip))); restore(D.undo.pop()); };
  D.doRedo = function () { if (!D.redo.length) return; D.undo.push(JSON.stringify(D.list.map(strip))); restore(D.redo.pop()); };
  D.selected = () => D.list.find(d => d.id === D.sel) || null;
  const nid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ---------------------------------------------------------------- tools
  D.setTool = function (t) {
    if (CURSORS[t]) { D.tool = null; if (t !== D.cursor) { D.cursor = t; TV.store.set("draw.cursor", t); TV.app.applyCursor(); } }
    else { D.tool = t; const g = GROUPS.find(x => x.tools.includes(t)); if (g) { D.last[g.id] = t; TV.store.set("draw.last", D.last); } }
    D.make = null; D.measure = null; D.bar(); D.syncCross(); TV.app.redrawAll(); TV.emit("tool");
  };
  D.done = function () { if (!D.stay) D.tool = null; D.bar(); D.syncCross(); TV.emit("tool"); };

  // ---------------------------------------------------------------- geometry
  const X = (c, q) => c.xOf(q.t), Y = (c, q) => c.yOf(q.p);
  function extend(ax, ay, bx, by, eL, eR, w, h) {
    if (!eL && !eR) return [ax, ay, bx, by];
    if (Math.abs(bx - ax) < 1e-6) return [ax, eL ? (ay < by ? -h : 2 * h) : ay, bx, eR ? (by > ay ? 2 * h : -h) : by];
    const k = (by - ay) / (bx - ax), dir = bx > ax ? 1 : -1;
    let x0 = ax, x1 = bx;
    if (eL) x0 = dir > 0 ? -w : 2 * w; if (eR) x1 = dir > 0 ? 2 * w : -w;
    return [x0, ay + k * (x0 - ax), x1, ay + k * (x1 - ax)];
  }
  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let u = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; u = Math.max(0, Math.min(1, u));
    return Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
  }
  const kindOf = d => T[d.type] && T[d.type].as ? T[d.type].as : d.type;
  function channelPts(c, d) {                                  // the base line and its parallel, on screen
    const a = d.pts[0], b = d.pts[1], off = d.pts[2] ? d.pts[2].p - (a.p + (b.p - a.p) * ((d.pts[2].t - a.t) / ((b.t - a.t) || 1))) : 0;
    return { a, b, off };
  }
  function handles(c, d) {
    const k = kindOf(d), pn = c.pane(), P = d.pts;
    const xy = q => [X(c, q), Y(c, q)];
    if (k === "hline") return [[Math.max(30, Math.min(pn.w - 30, X(c, P[0]) ?? pn.w / 2)), Y(c, P[0])]];
    if (k === "vline") return [[X(c, P[0]), pn.h / 2]];
    if (k === "rect" || k === "datepricerange" || k === "frvp") { const [a, b] = P; return [xy(a), [X(c, b), Y(c, a)], [X(c, a), Y(c, b)], xy(b)]; }
    if (k === "channel") { const { a, b, off } = channelPts(c, d); return [xy(a), xy(b), [(X(c, a) + X(c, b)) / 2, c.yOf((a.p + b.p) / 2 + off)]]; }
    if (k === "long" || k === "short") return [xy(P[0]), [X(c, P[0]), Y(c, P[1])], [X(c, P[0]), Y(c, P[2])], [X(c, P[1]), Y(c, P[0])]];
    if (k === "brush" || k === "highlighter") return [];
    return P.map(xy);
  }
  function hit(c, d, x, y) {
    if (d.hidden) return null;
    const k = kindOf(d), pn = c.pane(), P = d.pts, s = d.s, tol = 6;
    if (D.sel === d.id && !d.locked) { const hs = handles(c, d); for (let i = 0; i < hs.length; i++) if (hs[i][0] != null && hs[i][1] != null && Math.hypot(hs[i][0] - x, hs[i][1] - y) < 8) return { d, h: i }; }
    const ax = X(c, P[0]), ay = Y(c, P[0]);
    if (k === "hline") return ay != null && Math.abs(ay - y) < tol ? { d, h: null } : null;
    if (k === "hray") return ay != null && ax != null && Math.abs(ay - y) < tol && x >= ax - tol ? { d, h: null } : null;
    if (k === "vline") return ax != null && Math.abs(ax - x) < tol ? { d, h: null } : null;
    if (k === "crossline") return (ax != null && Math.abs(ax - x) < tol) || (ay != null && Math.abs(ay - y) < tol) ? { d, h: null } : null;
    if (ax == null || ay == null) return null;
    if (k === "trend" || k === "arrowline") { const bx = X(c, P[1]), by = Y(c, P[1]); if (bx == null || by == null) return null; const [x0, y0, x1, y1] = extend(ax, ay, bx, by, s.extendL, s.extendR, pn.w, pn.h); return segDist(x, y, x0, y0, x1, y1) < tol ? { d, h: null } : null; }
    if (k === "rect" || k === "pricerange" || k === "daterange" || k === "datepricerange" || k === "frvp" || k === "fib") {
      const bx = X(c, P[1]), by = Y(c, P[1]); if (bx == null || by == null) return null;
      let l = Math.min(ax, bx), r = Math.max(ax, bx), t = Math.min(ay, by), b = Math.max(ay, by);
      if (k === "fib") { r = s.extendR ? pn.w : r; return x >= l - tol && x <= r + tol && y >= t - tol && y <= b + tol ? { d, h: null } : null; }
      if (k === "rect" && s.extendR) r = pn.w;
      const filled = k !== "rect" || s.fill;
      return x >= l - tol && x <= r + tol && y >= t - tol && y <= b + tol && (filled || x <= l + tol || x >= r - tol || y <= t + tol || y >= b - tol) ? { d, h: null } : null;
    }
    if (k === "channel") {
      const { a, b, off } = channelPts(c, d), bx = X(c, b), by = Y(c, b); if (bx == null) return null;
      const y2a = c.yOf(a.p + off), y2b = c.yOf(b.p + off);
      if (segDist(x, y, ax, ay, bx, by) < tol || segDist(x, y, ax, y2a, bx, y2b) < tol) return { d, h: null };
      if (x >= Math.min(ax, bx) && x <= Math.max(ax, bx)) { const u = (x - ax) / ((bx - ax) || 1), y1 = ay + u * (by - ay), y2 = y2a + u * (y2b - y2a); if (y >= Math.min(y1, y2) && y <= Math.max(y1, y2)) return { d, h: null }; }
      return null;
    }
    if (k === "brush" || k === "highlighter") { for (let i = 1; i < P.length; i++) { const a = [X(c, P[i - 1]), Y(c, P[i - 1])], b = [X(c, P[i]), Y(c, P[i])]; if (a[0] != null && b[0] != null && segDist(x, y, a[0], a[1], b[0], b[1]) < Math.max(tol, s.width / 2)) return { d, h: null }; } return null; }
    if (k === "text") { const r = d._box; return r && x >= r[0] - 3 && x <= r[0] + r[2] + 3 && y >= r[1] - 3 && y <= r[1] + r[3] + 3 ? { d, h: null } : null; }
    if (k === "note" || k === "pricelabel") { const r = d._box; if (r && x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3]) return { d, h: null }; return Math.hypot(ax - x, ay - y) < 7 ? { d, h: null } : null; }
    if (k === "long" || k === "short") { const bx = X(c, P[1]), yt = Y(c, P[1]), ys = Y(c, P[2]); if (bx == null) return null; return x >= Math.min(ax, bx) && x <= Math.max(ax, bx) && y >= Math.min(yt, ys) && y <= Math.max(yt, ys) ? { d, h: null } : null; }
    return null;
  }
  function hitAny(c, x, y) {
    if (D.hidden) return null;
    const sel = D.selected(); if (sel) { const h = hit(c, sel, x, y); if (h) return h; }
    for (let i = D.list.length - 1; i >= 0; i--) { const h = hit(c, D.list[i], x, y); if (h) return h; }
    return null;
  }

  // ---------------------------------------------------------------- points from the mouse (magnet)
  // the point under the mouse. Ctrl held (as TradingView): the point docks at the bar's extreme - its high or its
  // low, whichever is nearer. The magnet button: the nearest of open, high, low, close (weak: when within 14 px).
  function pt(c, x, y, e) {
    let t = c.tOfX(x), p = c.pOfY(y); if (t == null || p == null) return null;
    const ctrl = e && (e.ctrlKey || e.metaKey), mg = ctrl ? "strong" : D.magnet;
    if (mg !== "off") {
      const b = c.barAtX(x);
      if (b) {
        let best = null; for (const v of (ctrl ? [b.h, b.l] : [b.o, b.h, b.l, b.c])) { const dd = Math.abs(c.yOf(v) - y); if (!best || dd < best.d) best = { v, d: dd }; }
        if (best && (mg === "strong" || best.d < 14)) { p = best.v; t = b.t + c.tfSec() / 2; }
      }
    }
    const tk = c.tick(); p = Math.round(p / tk) * tk;
    return { t, p };
  }
  // Shift held while a line's second point moves: the line snaps to 0, 45 or 90 degrees on screen
  function straight(c, a, q, e) {
    if (!(e && e.shiftKey) || !a || !q) return q;
    const ax = c.xOf(a.t), ay = c.yOf(a.p), bx = c.xOf(q.t), by = c.yOf(q.p); if ([ax, ay, bx, by].some(v => v == null)) return q;
    const dx = bx - ax, dy = by - ay, ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
    const nx = ax + len * Math.cos(ang), ny = ay + len * Math.sin(ang);
    const t = Math.abs(Math.cos(ang)) < 1e-6 ? a.t : c.tOfX(nx), p0 = Math.abs(Math.sin(ang)) < 1e-6 ? a.p : c.pOfY(ny);
    if (t == null || p0 == null) return q;
    const tk = c.tick();
    return { t, p: Math.round(p0 / tk) * tk };
  }
  const LINES = new Set(["trend", "ray", "extended", "arrowline", "channel", "fib", "pricerange", "daterange", "datepricerange", "measure"]);

  // ---------------------------------------------------------------- painting
  function paintAll(c, ctx, w, h) {
    if (D.hidden) { if (D.make) paint(c, ctx, D.make, true, w, h); return; }
    for (const d of D.list) if (!d.hidden) { try { paint(c, ctx, d, d.id === D.sel, w, h, D.hover === d.id); } catch (e) { console.error(e); } }
    if (D.make) paint(c, ctx, D.make, true, w, h);
    if (D.measure) paint(c, ctx, D.measure, false, w, h);
  }
  function stroke(ctx, s) { ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1; ctx.setLineDash(dashOf(s.style)); }
  function L(ctx, x0, y0, x1, y1) { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }
  function label(ctx, x, y, text, bg, fg, align, px) {
    ctx.font = fontOf(px || 12); const tw = ctx.measureText(text).width, padX = 6, hh = (px || 12) + 8;
    let x0 = align === "center" ? x - tw / 2 - padX : align === "right" ? x - tw - 2 * padX : x;
    ctx.fillStyle = bg; roundRect(ctx, x0, y - hh / 2, tw + 2 * padX, hh, 3); ctx.fill();
    ctx.fillStyle = fg || "#fff"; ctx.textBaseline = "middle"; ctx.fillText(text, x0 + padX, y + 0.5);
    return [x0, y - hh / 2, tw + 2 * padX, hh];
  }
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function paint(c, ctx, d, sel, w, h, hov) {
    const k = kindOf(d), s = d.s, P = d.pts, tk = c.tick();
    const ax = X(c, P[0]), ay = Y(c, P[0]);
    ctx.save();
    if (k === "hline" || k === "hray") {
      if (ay == null) { ctx.restore(); return; }
      stroke(ctx, s); L(ctx, k === "hray" ? (ax ?? 0) : 0, Math.round(ay) + 0.5, w, Math.round(ay) + 0.5);
      if (s.text) { ctx.setLineDash([]); ctx.font = fontOf(12); ctx.fillStyle = s.textColor || s.color; ctx.textAlign = "right"; ctx.textBaseline = "bottom"; ctx.fillText(s.text, w - 8, ay - 3); ctx.textAlign = "left"; }
      if (s.alert) { ctx.setLineDash([]); ctx.font = fontOf(12); ctx.fillStyle = s.color; ctx.fillText("⏰", (k === "hray" ? (ax ?? 0) : 4) + 4, ay - 4); }
    } else if (k === "vline") { if (ax != null) { stroke(ctx, s); L(ctx, Math.round(ax) + 0.5, 0, Math.round(ax) + 0.5, h); } }
    else if (k === "crossline") { stroke(ctx, s); if (ax != null) L(ctx, Math.round(ax) + 0.5, 0, Math.round(ax) + 0.5, h); if (ay != null) L(ctx, 0, Math.round(ay) + 0.5, w, Math.round(ay) + 0.5); }
    else if (ax != null && ay != null) {
      if (k === "trend" || k === "arrowline") {
        const bx = X(c, P[1]), by = Y(c, P[1]);
        if (bx != null && by != null) {
          stroke(ctx, s); const [x0, y0, x1, y1] = extend(ax, ay, bx, by, s.extendL, s.extendR, w, h); L(ctx, x0, y0, x1, y1);
          if (k === "arrowline") { ctx.setLineDash([]); const an = Math.atan2(by - ay, bx - ax), al = 10 + s.width * 2; ctx.beginPath(); ctx.moveTo(bx - al * Math.cos(an - 0.45), by - al * Math.sin(an - 0.45)); ctx.lineTo(bx, by); ctx.lineTo(bx - al * Math.cos(an + 0.45), by - al * Math.sin(an + 0.45)); ctx.stroke(); }
          if (s.text) { ctx.setLineDash([]); ctx.save(); ctx.translate((ax + bx) / 2, (ay + by) / 2); let an = Math.atan2(by - ay, bx - ax); if (an > Math.PI / 2 || an < -Math.PI / 2) an += Math.PI; ctx.rotate(an); ctx.font = fontOf(13); ctx.fillStyle = s.textColor || s.color; ctx.textAlign = "center"; ctx.textBaseline = "bottom"; ctx.fillText(s.text, 0, -4); ctx.restore(); }
        }
      } else if (k === "rect") {
        const bx = X(c, P[1]), by = Y(c, P[1]);
        if (bx != null && by != null) {
          const l = Math.min(ax, bx), r = s.extendR ? w : Math.max(ax, bx), t = Math.min(ay, by), b = Math.max(ay, by);
          if (s.fill) { ctx.fillStyle = s.fillColor; ctx.fillRect(l, t, r - l, b - t); }
          stroke(ctx, s); ctx.strokeRect(Math.round(l) + 0.5, Math.round(t) + 0.5, Math.round(r - l), Math.round(b - t));
          if (s.text) { ctx.setLineDash([]); ctx.font = fontOf(13); ctx.fillStyle = s.textColor; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(s.text, (l + r) / 2, (t + b) / 2); ctx.textAlign = "left"; }
        }
      } else if (k === "channel") {
        const { a, b, off } = channelPts(c, d), bx = X(c, b), by = Y(c, b);
        if (bx != null && by != null) {
          const [x0, y0, x1, y1] = extend(ax, ay, bx, by, s.extendL, s.extendR, w, h);
          const [u0, v0, u1, v1] = extend(ax, c.yOf(a.p + off), bx, c.yOf(b.p + off), s.extendL, s.extendR, w, h);
          if (s.fill) { ctx.fillStyle = s.fillColor; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineTo(u1, v1); ctx.lineTo(u0, v0); ctx.closePath(); ctx.fill(); }
          stroke(ctx, s); L(ctx, x0, y0, x1, y1); if (P.length > 2 || D.make === d) L(ctx, u0, v0, u1, v1);
          if (s.mid && P.length > 2) { ctx.setLineDash([4, 4]); L(ctx, x0, (y0 + v0) / 2, x1, (y1 + v1) / 2); }
        }
      } else if (k === "fib") {
        const bx = X(c, P[1]), by = Y(c, P[1]);
        if (bx != null && by != null) {
          const l = Math.min(ax, bx), r = s.extendR ? w : Math.max(ax, bx), lv = s.levels.filter(x => x.on).sort((a, b) => a.v - b.v);
          const yOfLv = v => c.yOf(P[1].p + (P[0].p - P[1].p) * v);
          if (s.fill) for (let i = 1; i < lv.length; i++) { const y0 = yOfLv(lv[i - 1].v), y1 = yOfLv(lv[i].v); ctx.fillStyle = TV.rgba(lv[i].color, 0.1); ctx.fillRect(l, Math.min(y0, y1), r - l, Math.abs(y1 - y0)); }
          for (const x of lv) {
            const yy = Math.round(yOfLv(x.v)) + 0.5; ctx.strokeStyle = x.color; ctx.lineWidth = s.width; ctx.setLineDash(dashOf(s.style)); L(ctx, l, yy, r, yy);
            if (s.labels) { ctx.setLineDash([]); ctx.font = fontOf(11); ctx.fillStyle = x.color; ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillText(`${x.v} (${TV.fp(P[1].p + (P[0].p - P[1].p) * x.v, tk)})`, l - 4, yy); ctx.textAlign = "left"; }
          }
          ctx.strokeStyle = "rgba(149,152,161,0.6)"; ctx.setLineDash([3, 3]); ctx.lineWidth = 1; L(ctx, ax, ay, bx, by);
        }
      } else if (k === "brush" || k === "highlighter") {
        ctx.strokeStyle = s.color; ctx.lineWidth = s.width; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.setLineDash([]);
        ctx.beginPath(); let st = false;
        for (const q of P) { const x = X(c, q), y = Y(c, q); if (x == null || y == null) continue; if (!st) { ctx.moveTo(x, y); st = true; } else ctx.lineTo(x, y); }
        ctx.stroke();
      } else if (k === "text") {
        const lines = (s.text || (D.make === d || sel ? "Text" : "")).split("\n");
        ctx.font = fontOf(s.fontSize, s.bold ? 600 : 400); const lh = s.fontSize * 1.3;
        const tw = Math.max(...lines.map(t => ctx.measureText(t).width));
        d._box = [ax, ay - s.fontSize, tw, lh * lines.length];
        if (s.bg) { ctx.fillStyle = s.fillColor; roundRect(ctx, ax - 5, ay - s.fontSize - 4, tw + 10, lh * lines.length + 6, 3); ctx.fill(); }
        ctx.fillStyle = s.text ? s.textColor : TV.rgba(s.textColor, 0.5); ctx.textBaseline = "alphabetic";
        lines.forEach((t, i) => ctx.fillText(t, ax, ay + i * lh));
      } else if (k === "note") {
        const bx = X(c, P[1]) ?? ax + 40, by = Y(c, P[1]) ?? ay - 40, lines = (s.text || "Notiz").split("\n");
        ctx.font = fontOf(s.fontSize); const lh = s.fontSize * 1.35, tw = Math.max(...lines.map(t => ctx.measureText(t).width));
        const bw = tw + 16, bh = lh * lines.length + 10, bxL = bx - bw / 2, byT = by - bh / 2;
        ctx.fillStyle = s.fillColor; ctx.strokeStyle = s.color; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx - 6, by); ctx.lineTo(bx + 6, by); ctx.closePath(); ctx.fill();
        roundRect(ctx, bxL, byT, bw, bh, 4); ctx.fill();
        ctx.beginPath(); ctx.arc(ax, ay, 3, 0, 7); ctx.fill();
        ctx.fillStyle = s.textColor; ctx.textBaseline = "top"; lines.forEach((t, i) => ctx.fillText(t, bxL + 8, byT + 5 + i * lh + 1));
        d._box = [bxL, byT, bw, bh];
      } else if (k === "pricelabel") {
        const text = TV.fp(P[0].p, tk); ctx.font = fontOf(s.fontSize); const tw = ctx.measureText(text).width, bw = tw + 14, bh = s.fontSize + 10, bx = ax + 10, by = ay - bh - 8;
        ctx.fillStyle = s.color; roundRect(ctx, bx, by, bw, bh, 3); ctx.fill(); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx + 4, by + bh); ctx.lineTo(bx + 14, by + bh); ctx.closePath(); ctx.fill();
        ctx.fillStyle = s.textColor; ctx.textBaseline = "middle"; ctx.fillText(text, bx + 7, by + bh / 2 + 0.5); d._box = [bx, by, bw, bh];
      } else if (k === "long" || k === "short") paintPosition(c, ctx, d, w);
      else if (k === "pricerange" || k === "daterange" || k === "datepricerange" || k === "measure") paintRange(c, ctx, d, k);
      else if (k === "frvp") paintFrvp(c, ctx, d, w, sel);
    }
    ctx.setLineDash([]);
    if ((sel || hov) && !d.temp) {
      for (const [hx, hy] of handles(c, d)) { if (hx == null || hy == null) continue; ctx.beginPath(); ctx.arc(hx, hy, sel ? 5 : 4, 0, 7); ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--bg"); ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = d.locked ? "#787b86" : (s.color && !String(s.color).startsWith("rgba(255,235") ? TV.rgba(s.color, 1) : "#2962ff"); ctx.stroke(); }
    }
    ctx.restore();
  }
  function paintPosition(c, ctx, d, w) {
    const P = d.pts, s = d.s, long = d.type === "long", tk = c.tick(), sp = c.spec();
    const x0 = X(c, P[0]), x1 = X(c, P[1]), ye = Y(c, P[0]), yt = Y(c, P[1]), ys = Y(c, P[2]);
    if ([x0, x1, ye, yt, ys].some(v => v == null)) return;
    const l = Math.min(x0, x1), r = Math.max(x0, x1);
    ctx.fillStyle = s.up; ctx.fillRect(l, Math.min(ye, yt), r - l, Math.abs(yt - ye));
    ctx.fillStyle = s.down; ctx.fillRect(l, Math.min(ye, ys), r - l, Math.abs(ys - ye));
    ctx.strokeStyle = "rgba(149,152,161,0.9)"; ctx.lineWidth = 1; L(ctx, l, Math.round(ye) + 0.5, r, Math.round(ye) + 0.5);
    // the result as the replay went on: the first bar after the entry that reached the target or the stop
    const res = outcome(c, d);
    if (res && res.x != null) {
      ctx.fillStyle = res.kind === "tp" ? "rgba(8,153,129,0.25)" : res.kind === "sl" ? "rgba(242,54,69,0.25)" : "rgba(149,152,161,0.12)";
      const ex = Math.min(r, res.x), yx = Y(c, { p: res.price });
      ctx.fillRect(l, Math.min(ye, yx), ex - l, Math.abs(yx - ye));
      ctx.strokeStyle = "rgba(209,212,220,0.7)"; ctx.setLineDash([3, 3]); L(ctx, x0, ye, ex, yx); ctx.setLineDash([]);
    }
    if (!s.labels) return;
    const tvOf = pts => Math.round(Math.abs(pts) / tk), money = pts => pts / tk * tk * sp.pv * s.qty;
    const dT = P[1].p - P[0].p, dS = P[2].p - P[0].p, pct = v => (Math.abs(v) / P[0].p * 100).toFixed(2);
    const cx = (l + r) / 2;
    label(ctx, cx, Math.min(yt, ye) - 12 + (yt < ye ? 0 : Math.abs(yt - ye) + 24), `Ziel: ${TV.fp(Math.abs(dT), tk)} (${pct(dT)}%) ${tvOf(dT)} T, Betrag: ${TV.fusd(Math.abs(money(dT)))}`, "#089981", "#fff", "center", 11);
    label(ctx, cx, Math.max(ys, ye) + 12 - (ys > ye ? 0 : Math.abs(ys - ye) + 24), `Stopp: ${TV.fp(Math.abs(dS), tk)} (${pct(dS)}%) ${tvOf(dS)} T, Betrag: ${TV.fusd(Math.abs(money(dS)))}`, "#f23645", "#fff", "center", 11);
    const rr = Math.abs(dS) ? (Math.abs(dT) / Math.abs(dS)).toFixed(2) : "–";
    let mid = `Menge: ${s.qty} · R:R ${rr}`;
    if (res) mid = res.kind === "tp" ? `Ziel erreicht ${TV.fusd(Math.abs(money(dT)), true)} · R:R ${rr}` : res.kind === "sl" ? `Stopp erreicht ${TV.fusd(-Math.abs(money(dS)))} · R:R ${rr}`
      : `Offen ${TV.fusd(money((res.price - P[0].p) * (long ? 1 : -1)), true)} · R:R ${rr}`;
    label(ctx, cx, ye, mid, res && res.kind === "tp" ? "#089981" : res && res.kind === "sl" ? "#f23645" : "#434651", "#fff", "center", 11);
  }
  function outcome(c, d) {
    const P = d.pts, long = d.type === "long", B = c.BARS, t0 = P[0].t, t1 = Math.min(P[1].t, c.lastT || P[1].t);
    if (!B.length || c.lastT == null || c.lastT < t0) return null;
    let i = c.idxOf(t0); if (i < 0) i = 0;
    const tp = P[1].p, sl = P[2].p;
    for (; i < B.length && B[i].t < t1; i++) {
      const b = B[i]; if (b.t + c.tfSec() <= t0) continue;
      const hitS = long ? b.l <= sl : b.h >= sl, hitT = long ? b.h >= tp : b.l <= tp;
      if (hitS) return { kind: "sl", price: sl, x: c.xOf(b.t + c.tfSec() / 2), t: b.t };      // both in one bar: the stop (conservative)
      if (hitT) return { kind: "tp", price: tp, x: c.xOf(b.t + c.tfSec() / 2), t: b.t };
    }
    const j = Math.min(i, B.length) - 1; if (j < 0) return null;
    return { kind: "open", price: B[j].c, x: c.xOf(Math.min(B[j].t + c.tfSec(), c.lastT)) };
  }
  function paintRange(c, ctx, d, k) {
    const P = d.pts, s = d.s, tk = c.tick();
    const ax = X(c, P[0]), ay = Y(c, P[0]), bx = X(c, P[1]), by = Y(c, P[1]); if ([ax, ay, bx, by].some(v => v == null)) return;
    const up = P[1].p >= P[0].p, col = k === "measure" ? (up ? "#2962ff" : "#f23645") : s.color;
    const l = Math.min(ax, bx), r = Math.max(ax, bx), t = Math.min(ay, by), b = Math.max(ay, by);
    ctx.fillStyle = k === "measure" ? TV.rgba(col, 0.18) : s.fillColor;
    if (k === "pricerange") ctx.fillRect(l, t, r - l, b - t); else if (k === "daterange") ctx.fillRect(l, Math.min(t, b - 40), r - l, Math.max(40, b - t)); else ctx.fillRect(l, t, r - l, b - t);
    ctx.strokeStyle = col; ctx.lineWidth = 1;
    const arrow = (x0, y0, x1, y1) => { L(ctx, x0, y0, x1, y1); const an = Math.atan2(y1 - y0, x1 - x0); ctx.beginPath(); ctx.moveTo(x1 - 7 * Math.cos(an - 0.5), y1 - 7 * Math.sin(an - 0.5)); ctx.lineTo(x1, y1); ctx.lineTo(x1 - 7 * Math.cos(an + 0.5), y1 - 7 * Math.sin(an + 0.5)); ctx.stroke(); };
    if (k !== "daterange") arrow((l + r) / 2, ay, (l + r) / 2, by);
    if (k !== "pricerange") arrow(ax, (t + b) / 2, bx, (t + b) / 2);
    const dp = P[1].p - P[0].p, parts = [];
    if (k !== "daterange") parts.push(`${dp >= 0 ? "" : "−"}${TV.fp(Math.abs(dp), tk)} (${(dp / P[0].p * 100).toFixed(2)}%) ${Math.round(dp / tk)} T`);
    if (k !== "pricerange") {
      const i0 = c.idxOf(Math.min(P[0].t, P[1].t)), i1 = c.idxOf(Math.max(P[0].t, P[1].t));
      let vol = 0; for (let i = Math.max(0, i0); i <= i1 && i < c.BARS.length; i++) vol += c.BARS[i].v;
      parts.push(`${Math.max(0, i1 - i0)} Bars, ${TV.fdur(Math.abs(P[1].t - P[0].t))}`); parts.push(`Vol ${TV.fv(vol)}`);
    }
    const ly = up || k === "daterange" ? t - 16 : b + 16;
    ctx.font = fontOf(12); const lines = parts, lw = Math.max(...lines.map(x => ctx.measureText(x).width)) + 16, lh = 17 * lines.length + 6;
    const bx0 = (l + r) / 2 - lw / 2, by0 = up || k === "daterange" ? ly - lh + 10 : ly - 10;
    ctx.fillStyle = col; roundRect(ctx, bx0, by0, lw, lh, 4); ctx.fill(); ctx.fillStyle = "#fff"; ctx.textBaseline = "top"; ctx.textAlign = "center";
    lines.forEach((x, i) => ctx.fillText(x, (l + r) / 2, by0 + 4 + i * 17)); ctx.textAlign = "left";
  }
  function paintFrvp(c, ctx, d, w, sel) {
    const P = d.pts, s = d.s, t0 = Math.min(P[0].t, P[1].t), t1 = Math.max(P[0].t, P[1].t), until = c.lastT;
    if (until == null) return;
    const x0 = c.xOf(t0), x1 = c.xOf(t1); if (x0 == null || x1 == null) return;
    const k = `${t0}|${t1}|${Math.floor(Math.min(until, t1))}`;
    if (d._vpKey !== k && !d._vpBusy && t0 < until) { d._vpBusy = true; TV.profile(t0, Math.min(t1, until + 1), until).then(v => { d._vp = v; d._vpKey = k; }).catch(() => { d._vp = null; d._vpKey = k; }).finally(() => { d._vpBusy = false; TV.app.redrawAll(); }); }
    const vp = d._vp;
    if (!vp) { ctx.strokeStyle = TV.rgba(s.color, 0.6); ctx.setLineDash([4, 4]); L(ctx, x0, 0, x0, c.pane().h); L(ctx, x1, 0, x1, c.pane().h); return; }
    const lo = vp.levels[0][0], hi = vp.levels[vp.levels.length - 1][0] + TV.TICK, yt = c.yOf(hi), yb = c.yOf(lo);
    if (s.box || sel) { ctx.fillStyle = TV.rgba(s.color, 0.06); ctx.fillRect(x0, yt, x1 - x0, yb - yt); ctx.strokeStyle = TV.rgba(s.color, sel ? 0.8 : 0.35); ctx.lineWidth = 1; ctx.strokeRect(Math.round(x0) + 0.5, Math.round(yt) + 0.5, Math.round(x1 - x0), Math.round(yb - yt)); }
    TV.paintVp(c, ctx, vp, x0, (x1 - x0) * s.width / 100, 1, s, 2);
    const yp = c.yOf(vp.poc + TV.TICK / 2); ctx.strokeStyle = s.poc; ctx.lineWidth = 2; L(ctx, x0, Math.round(yp) + 0.5, s.pocExtend ? w : x1, Math.round(yp) + 0.5);
  }

  // ---------------------------------------------------------------- the pointer
  function newDrawing(type, pts) {
    const tdef = T[type], s = JSON.parse(JSON.stringify(Object.assign({}, tdef.def, TV.store.get("draw.style." + type, {}))));
    return { id: nid(), type, pts, s, locked: false, hidden: false };
  }
  function finish(c) {
    const d = D.make; D.make = null; if (!d) return;
    if (T[d.type].temp) { D.measure = d; D.done(); TV.app.redrawAll(); return; }
    D.snap(); D.list.push(d); D.sel = d.id; D.save(); D.done();
    if ((d.type === "text" || d.type === "note") && !d.s.text) editText(c, d, true);
  }
  D.createHandler = {
    down(c, x, y, e) {
      if (D.measure) { D.measure = null; TV.app.redrawAll(); if (!D.tool && !e.shiftKey) return true; }
      const tool = D.tool || (e.shiftKey && D.cursor !== "eraser" ? "measure" : null);
      if (!tool) {
        if (D.cursor === "eraser") { const h = hitAny(c, x, y); if (h && !h.d.locked && !D.lockAll) { D.remove(h.d); } return true; }
        return false;
      }
      const q = pt(c, x, y, e); if (!q) return true;
      const n = T[tool].n;
      if (D.make) {                                           // a further click of a two- or three-click drawing
        if (n === 3 && D.make.pts.length === 2 && D.make._stage === 1) { D.make._stage = 2; D.make.pts.push({ t: q.t, p: q.p }); return true; }
        if (n === 3 && D.make._stage === 2) { finish(c); return true; }
        D.make.pts[1] = LINES.has(D.make.type) ? straight(c, D.make.pts[0], q, e) : q; finish(c); return true;   // the placing click, straight too with Shift
      }
      if (n === 1) { D.make = newDrawing(tool, [q]); finish(c); return true; }
      if (n === "pos") {
        const vr = c.pane(), span = Math.abs(c.pOfY(0) - c.pOfY(vr.h)) * 0.06, tk = c.tick(), dd = Math.max(tk * 4, Math.round(span / tk) * tk);
        const long = tool === "long", tEnd = q.t + c.tfSec() * 24;
        D.make = newDrawing(tool, [q, { t: tEnd, p: q.p + (long ? 2 : -2) * dd }, { t: tEnd, p: q.p - (long ? 1 : -1) * dd }]); finish(c); return true;
      }
      if (n === "free") { D.make = newDrawing(tool, [q]); D.drag = { kind: "free", x, y }; return true; }
      D.make = newDrawing(tool, [q, Object.assign({}, q)]); if (tool === "measure") D.make.temp = true;
      if (n === 3) D.make._stage = 1;
      D.drag = { kind: "make", x, y };
      return true;
    },
    move(c, x, y, e) {
      if (!D.make) return;
      let q = pt(c, x, y, e); if (!q) return;
      D.setSnap(c, q);
      if (D.drag && D.drag.kind === "free") { const lq = D.make.pts[D.make.pts.length - 1]; if (Math.hypot(c.xOf(lq.t) - x, c.yOf(lq.p) - y) > 2) D.make.pts.push(q); }
      else if (D.make._stage === 2) D.make.pts[2] = q; else { if (LINES.has(D.make.type)) q = straight(c, D.make.pts[0], q, e); D.make.pts[1] = q; D.setSnap(c, q); }
      TV.app.redrawAll();
    },
    up(c, x, y) {
      if (!D.make) return;
      if (D.drag && D.drag.kind === "free") { D.drag = null; if (D.make.pts.length > 1) finish(c); else D.make = null; return; }
      if (D.drag && D.drag.kind === "make" && Math.hypot(x - D.drag.x, y - D.drag.y) > 4) { D.drag = null; if (D.make._stage === 1) { D.make._stage = 2; D.make.pts.push(Object.assign({}, D.make.pts[1])); } else finish(c); return; }
      D.drag = null;
    },
    hover(c, x, y, e) {
      if (D.make) { D.createHandler.move(c, x, y, e); return "crosshair"; }
      if (D.tool) { D.setSnap(c, pt(c, x, y, e)); TV.app.redrawAll(); return "crosshair"; }
      if (D.cursor === "eraser") { const h = hitAny(c, x, y); D.setHover(h ? h.d.id : null); return h ? "pointer" : "default"; }
      return null;
    },
  };
  D.selectHandler = {
    down(c, x, y, e) {
      const h = hitAny(c, x, y);
      if (!h) { if (D.sel) { D.sel = null; D.styleBar(); TV.app.redrawAll(); } return false; }
      D.sel = h.d.id; D.styleBar(); TV.app.redrawAll();
      if (h.d.locked || D.lockAll) return true;
      D.drag = { kind: h.h == null ? "move" : "handle", d: h.d, h: h.h, start: pt(c, x, y, e) || { t: c.tOfX(x), p: c.pOfY(y) }, orig: JSON.parse(JSON.stringify(h.d.pts)), snapped: false, x, y };
      D.syncCross();
      return true;
    },
    move(c, x, y, e) {
      const g = D.drag; if (!g || !g.d) return;
      if (!g.snapped) { if (Math.hypot(x - g.x, y - g.y) < 3) return; D.snap(); g.snapped = true; }
      const q = pt(c, x, y, e); if (!q) return;
      const d = g.d, k = kindOf(d), o = g.orig, tk = c.tick();
      if (g.kind === "move") { const dt = q.t - g.start.t, dp = q.p - g.start.p; d.pts = o.map(a => ({ t: a.t + dt, p: Math.round((a.p + dp) / tk) * tk })); }
      else if (k === "rect" || k === "datepricerange" || k === "frvp") { const p = JSON.parse(JSON.stringify(o)), i = g.h; if (i === 0 || i === 2) p[0].t = q.t; else p[1].t = q.t; if (i === 0 || i === 1) p[0].p = q.p; else p[1].p = q.p; d.pts = p; }
      else if (k === "channel" && g.h === 2) { const p = JSON.parse(JSON.stringify(o)), mid = (o[0].t + o[1].t) / 2; p[2] = { t: mid, p: q.p }; d.pts = p; }
      else if (k === "long" || k === "short") {
        const p = JSON.parse(JSON.stringify(o));
        if (g.h === 0) { const dp = q.p - o[0].p; p[0] = { t: q.t, p: q.p }; p[1].p = o[1].p + dp; p[2].p = o[2].p + dp; }
        else if (g.h === 1) p[1].p = q.p; else if (g.h === 2) p[2].p = q.p; else if (g.h === 3) { p[1].t = q.t; p[2].t = q.t; }
        d.pts = p;
      }
      else if (k === "hline" || k === "hray" || k === "vline" || k === "crossline") d.pts = [k === "hline" ? { t: o[0].t, p: q.p } : k === "vline" ? { t: q.t, p: o[0].p } : q];
      else {
        let qq = q;
        if (LINES.has(k) && o.length >= 2 && g.h < 2) qq = straight(c, o[1 - g.h], q, e);     // against the other end
        d.pts = o.map((a, i) => i === g.h ? qq : a);
        D.setSnap(c, qq);
      }
      if (g.kind === "move") D.setSnap(c, null);
      TV.app.redrawAll();
    },
    up() { const g = D.drag; D.drag = null; D.syncCross(); if (g && g.snapped) D.save(); },
    hover(c, x, y) {
      const h = hitAny(c, x, y); D.setHover(h ? h.d.id : null);
      if (!h) return null;
      return h.h != null ? "move" : "pointer";
    },
    dbl(c, x, y) {
      const h = hitAny(c, x, y); if (!h) return false;
      if (["text", "note"].includes(h.d.type)) editText(c, h.d); else D.settings(h.d);
      return true;
    },
  };
  D.setHover = id => { if (D.hover !== id) { D.hover = id; TV.app.redrawAll(); } };
  // while a drawing is made or a point dragged, the chart's crosshair hides and one is drawn at the snapped point
  // (magnet, Ctrl, Shift) with its price and time on the axes - so you see where the point will land
  D.busy = () => !!(D.tool || D.make || (D.drag && D.drag.d));
  D.snapPt = null;
  D.syncCross = function () { const on = D.busy(); if (on !== D._crossOff) { D._crossOff = on; TV.app.applyCursor(); } if (!on) D.snapPt = null; };
  D.setSnap = (c, q) => { D.snapPt = q ? { c, t: q.t, p: q.p } : null; };
  D.hitAt = (c, x, y) => hitAny(c, x, y);

  // ---------------------------------------------------------------- text in place
  function editText(c, d, fresh) {
    const P = d.pts, x = c.xOf((d.type === "note" ? P[1] : P[0]).t), y = c.yOf((d.type === "note" ? P[1] : P[0]).p);
    const ta = el("textarea.textedit", { rows: 2 }); ta.value = d.s.text || "";
    ta.style.left = Math.max(4, (x || 40) - (d.type === "note" ? 80 : 4)) + "px"; ta.style.top = Math.max(4, (y || 40) - (d.type === "note" ? 20 : d.s.fontSize + 6)) + "px";
    c.el.append(ta); ta.focus(); ta.select();
    let closed = false;
    const done = ok => {
      if (closed) return; closed = true; ta.remove();
      if (ok) { D.snap(); d.s.text = ta.value; if (!d.s.text.trim() && fresh) { D.list = D.list.filter(x => x !== d); D.forget([d.id]); } }
      else if (fresh && !d.s.text) { D.list = D.list.filter(x => x !== d); D.forget([d.id]); }
      D.save();
    };
    ta.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); done(true); } if (e.key === "Escape") { e.preventDefault(); done(false); } });
    ta.addEventListener("blur", () => done(true));
  }

  // ---------------------------------------------------------------- the layer of every pane: drawings, axis labels
  D.layer = c => ({
    draw(ctx, w, h) {
      paintAll(c, ctx, w, h);
      if (D.cursor === "dot" && c.cross && !D.tool) { ctx.fillStyle = "#d1d4dc"; ctx.beginPath(); ctx.arc(c.cross.x, c.cross.y, 2.5, 0, 7); ctx.fill(); }
      if (D.busy() && D.snapPt && D.snapPt.c === c) {           // the crosshair at the snapped point
        const x = c.xOf(D.snapPt.t), y = c.yOf(D.snapPt.p); if (x == null || y == null) return;
        ctx.strokeStyle = "#9598a1"; ctx.lineWidth = 1; ctx.setLineDash([6, 6]);
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = "#d1d4dc"; ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
      }
    },
    axis() {
      if (D.hidden) return [];
      const out = [], tk = c.tick();
      if (D.busy() && D.snapPt && D.snapPt.c === c) out.push({ y: c.yOf(D.snapPt.p), text: TV.fp(D.snapPt.p, tk), bg: "#363a45", fg: "#fff" });
      for (const d of D.list) {
        if (d.hidden) continue;
        const k = kindOf(d), sel = d.id === D.sel || (D.make && D.make === d);
        if ((k === "hline" || k === "hray" || k === "crossline") && d.s.showPrice) out.push({ y: c.yOf(d.pts[0].p), text: TV.fp(d.pts[0].p, tk), bg: TV.rgba(d.s.color, 1) });
        else if (sel && !["brush", "highlighter", "vline"].includes(k)) for (const q of d.pts) out.push({ y: c.yOf(q.p), text: TV.fp(q.p, tk), bg: "#2962ff" });
      }
      const m = D.make || D.measure; if (m && !["brush", "highlighter"].includes(m.type)) for (const q of m.pts) out.push({ y: c.yOf(q.p), text: TV.fp(q.p, tk), bg: "#2962ff" });
      return out;
    },
    time() {
      if (D.hidden) return [];
      const out = [];
      if (D.busy() && D.snapPt && D.snapPt.c === c) out.push({ x: c.xOf(D.snapPt.t), text: TV.fmtCross(D.snapPt.t, c.tf), bg: "#363a45", fg: "#fff" });
      for (const d of D.list) {
        if (d.hidden) continue;
        const k = kindOf(d), sel = d.id === D.sel;
        if ((k === "vline" || k === "crossline") && d.s.showTime) out.push({ x: c.xOf(d.pts[0].t), text: TV.fmtCross(d.pts[0].t, c.tf), bg: TV.rgba(d.s.color, 1) });
        else if (sel && !["brush", "highlighter", "hline", "hray"].includes(k)) for (const q of d.pts.slice(0, 2)) out.push({ x: c.xOf(q.t), text: TV.fmtCross(q.t, c.tf), bg: "#2962ff" });
      }
      return out;
    },
  });

  // ---------------------------------------------------------------- alarms: a horizontal line the replay crosses
  D.checkAlerts = function (prev, now) {
    if (prev == null || now == null || prev === now) return;
    for (const d of D.list) {
      if (!d.s.alert || d.hidden || (d.type !== "hline" && d.type !== "hray")) continue;
      const p = d.pts[0].p, t = RC.now();
      if (d.type === "hray" && t < d.pts[0].t) continue;
      if ((prev < p && now >= p) || (prev > p && now <= p)) {
        d.s.alert = false; D.save();
        if (RC.state && RC.state.playing) RC.play(false);
        TV.toast(`Alarm: Preis kreuzt ${TV.fp(p, TV.spec(D.inst).tick)}${d.s.text ? " – " + d.s.text : ""} · Replay angehalten`, "err", 6000);
      }
    }
  };

  // ---------------------------------------------------------------- the left tool bar
  D.bar = function () {
    const b = TV.$("#left"); if (!b) return; b.replaceChildren();
    const btn = (icon, title, on, fn, more) => {
      const x = el("button.tool" + (on ? ".on" : ""), { title, onclick: fn }, TV.icon(icon));
      if (more) { const m = el("span.more", { title: "Mehr", onclick: e => { e.stopPropagation(); more(x); } }, TV.iconSm("right", 10)); x.append(m); x.classList.add("flag"); }
      b.append(x); return x;
    };
    for (const g of GROUPS) {
      const cur = g.id === "cursor" ? D.cursor : (D.tool && g.tools.includes(D.tool) ? D.tool : (D.last[g.id] || g.tools[0]));
      const on = g.id === "cursor" ? !D.tool : D.tool === cur;
      const k = T[cur] && T[cur].key;
      btn(iconOf(cur), nameOf(cur) + (k ? ` (${k})` : ""), on, () => D.setTool(on && g.id !== "cursor" ? D.cursor : cur), g.tools.length > 1 ? anchor => {
        TV.menu(anchor, g.tools.map(t => ({ label: nameOf(t), icon: iconOf(t), hint: T[t] && T[t].key, on: t === cur, action: () => D.setTool(t) })), { side: true, cls: "tools" });
      } : null);
    }
    btn("ruler", "Lineal (Shift + Ziehen im Chart)", D.tool === "measure", () => D.setTool(D.tool === "measure" ? D.cursor : "measure"));
    b.append(el("div.lsep"));
    const mg = btn("magnet", { off: "Magnet aus", weak: "Magnet schwach (nahe O/H/L/C)", strong: "Magnet stark (immer O/H/L/C)" }[D.magnet] + " · Strg hält ihn kurz um", D.magnet !== "off",
      () => { D.magnet = D.magnet === "off" ? "weak" : "off"; TV.store.set("draw.magnet", D.magnet); D.bar(); },
      anchor => TV.menu(anchor, [["off", "Magnet aus"], ["weak", "Schwacher Magnet"], ["strong", "Starker Magnet"]].map(([v, l]) => ({ label: l, icon: "magnet", on: D.magnet === v, action: () => { D.magnet = v; TV.store.set("draw.magnet", v); D.bar(); } })), { side: true }));
    if (D.magnet === "strong") mg.style.color = "#ff9800";
    btn("staydraw", "Im Zeichenmodus bleiben", D.stay, () => { D.stay = !D.stay; D.bar(); });
    btn(D.lockAll ? "lock" : "unlock", D.lockAll ? "Alle Zeichnungen entsperren" : "Alle Zeichnungen sperren", D.lockAll, () => { D.lockAll = !D.lockAll; D.bar(); });
    btn(D.hidden ? "eyeoff" : "eye", D.hidden ? "Zeichnungen einblenden" : "Alle Zeichnungen ausblenden", D.hidden, () => { D.hidden = !D.hidden; D.sel = null; D.styleBar(); D.bar(); TV.app.redrawAll(); });
    btn("trash", "Entfernen", false, () => D.removeAllMenu(b.lastChild), null);
  };
  D.removeAllMenu = anchor => TV.menu(anchor, [
    { label: `${D.list.length} Zeichnung${D.list.length === 1 ? "" : "en"} entfernen`, icon: "trash", disabled: !D.list.length, action: () => { D.snap(); D.forget(D.list.map(d => d.id)); D.list = []; D.sel = null; D.save(); TV.toast("Alle Zeichnungen entfernt – Strg+Z holt sie zurück", "", 3000); } },
    { label: "Indikatoren dieses Charts entfernen", icon: "fx", action: () => { const c = TV.app.active; for (const s of c.studies.list.slice()) c.studies.remove(s.id); } },
  ], { side: true });

  // ---------------------------------------------------------------- the floating style bar of a selection
  D.styleBar = function () {
    const sb = D.sbEl || (D.sbEl = el("div.stylebar")); if (!sb.isConnected) { const st = TV.$("#stage"); if (!st) return; st.append(sb); }
    const d = D.selected(); sb.style.display = d && !D.hidden ? "flex" : "none"; sb.replaceChildren(); if (!d) return;
    const k = kindOf(d), s = d.s;
    const B = (content, title, fn, on) => { const b = el("button" + (on ? ".on" : ""), { title, onclick: e => { e.stopPropagation(); fn(b); } }); b.append(content); sb.append(b); return b; };
    sb.append(el("span.grip", { title: T[d.type] ? T[d.type].name : "" }, TV.iconSm("grip", 18)));
    const colorBtn = (icon, prop, title) => B(el("span", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: "1px" } }, TV.iconSm(icon, 18), el("i.sw", { style: { background: s[prop] } })), title,
      b => TV.pickColor(b, s[prop], v => { if (!b._snap) { D.snap(); b._snap = 1; } s[prop] = v; TV.store.set("draw.style." + d.type, styleMemo(d)); D.save(); }));
    if ("color" in s && !["text", "long", "short", "frvp"].includes(k)) colorBtn(k === "highlighter" || k === "brush" ? k : "trend", "color", "Linienfarbe");
    if ("fillColor" in s && ["rect", "channel", "note", "pricerange", "daterange", "datepricerange", "text"].includes(k)) colorBtn("rect", "fillColor", "Füllfarbe");
    if ("textColor" in s && ["text", "note", "rect", "hline", "hray", "trend", "pricelabel"].includes(k)) colorBtn("text", "textColor", "Textfarbe");
    if ("width" in s && !["frvp"].includes(k)) B(el("span", { text: s.width + "px" }), "Linienstärke", b => TV.menu(b, (k === "highlighter" ? [6, 10, 14, 20, 28] : [1, 2, 3, 4]).map(v => ({ label: v + "px", on: s.width === v, action: () => { D.snap(); s.width = v; TV.store.set("draw.style." + d.type, styleMemo(d)); D.save(); } }))));
    if ("style" in s && !["brush", "highlighter"].includes(k)) B(el("span", { text: { solid: "━━", dashed: "╍╍", dotted: "┅┅" }[s.style] }), "Linienart", b => TV.menu(b, [["solid", "Durchgezogen"], ["dashed", "Gestrichelt"], ["dotted", "Gepunktet"]].map(([v, l]) => ({ label: l, on: s.style === v, action: () => { D.snap(); s.style = v; D.save(); } }))));
    if ("text" in s) B(TV.iconSm("text", 18), "Text", () => { const c = TV.app.active; if (["text", "note"].includes(k)) editText(c, d); else { const v = prompt("Text:", s.text || ""); if (v != null) { D.snap(); s.text = v; D.save(); } } });
    if (k === "hline" || k === "hray") B(TV.iconSm("bell", 18), s.alert ? "Alarm aktiv – entfernen" : "Alarm: Replay anhalten, wenn der Preis die Linie kreuzt", () => { D.snap(); s.alert = !s.alert; D.save(); TV.toast(s.alert ? "Alarm gesetzt – das Replay hält an, wenn der Preis die Linie kreuzt" : "Alarm entfernt"); }, s.alert);
    if (k === "long" || k === "short") B(TV.iconSm("order", 18), "Als Order platzieren: Limit am Einstieg mit TP und SL", () => TV.Trade && TV.Trade.fromTool(d));
    B(TV.iconSm("gear", 18), "Einstellungen", () => D.settings(d));
    B(TV.iconSm(d.locked ? "lock" : "unlock", 18), d.locked ? "Entsperren" : "Sperren", () => { d.locked = !d.locked; D.save(); }, d.locked);
    B(TV.iconSm("trash", 18), "Entfernen (Entf)", () => D.remove(d));
    B(TV.iconSm("more", 18), "Mehr", b => D.menuFor(d, b));
  };
  const styleMemo = d => { const o = {}; for (const k of ["color", "width", "style", "fillColor", "textColor"]) if (k in d.s) o[k] = d.s[k]; return o; };
  D.remove = function (d) { D.snap(); D.list = D.list.filter(x => x !== d); D.forget([d.id]); if (D.sel === d.id) D.sel = null; D.save(); };
  D.clone = function (d) { D.snap(); const n = JSON.parse(JSON.stringify(strip(d))); n.id = nid(); const c = TV.app.active; const dt = c.tfSec() * 4; n.pts = n.pts.map(q => ({ t: q.t + dt, p: q.p })); D.list.push(n); D.sel = n.id; D.save(); };
  D.menuFor = function (d, at) {
    const items = [
      { label: "Einstellungen …", icon: "gear", action: () => D.settings(d) },
      { label: "Klonen", icon: "clone", action: () => D.clone(d) },
      { label: d.locked ? "Entsperren" : "Sperren", icon: d.locked ? "unlock" : "lock", action: () => { d.locked = !d.locked; D.save(); } },
      { label: "Ausblenden", icon: "eyeoff", action: () => { d.hidden = true; if (D.sel === d.id) D.sel = null; D.save(); } },
      { sep: true },
      { label: "In den Vordergrund", action: () => { D.snap(); D.list = D.list.filter(x => x !== d).concat([d]); D.save(); } },
      { label: "In den Hintergrund", action: () => { D.snap(); D.list = [d].concat(D.list.filter(x => x !== d)); D.save(); } },
    ];
    if (d.type === "hline" || d.type === "hray") items.push({ sep: true }, { label: d.s.alert ? "Alarm entfernen" : "Alarm hinzufügen (Replay anhalten)", icon: "bell", action: () => { D.snap(); d.s.alert = !d.s.alert; D.save(); } });
    if ((d.type === "hline" || d.type === "hray") && TV.Trade) items.push({ label: `Kaufen ${TV.Trade.qty()} @ ${TV.fp(d.pts[0].p)} …`, icon: "order", action: () => TV.Trade.atPrice(d.pts[0].p, 1) }, { label: `Verkaufen ${TV.Trade.qty()} @ ${TV.fp(d.pts[0].p)} …`, icon: "order", action: () => TV.Trade.atPrice(d.pts[0].p, -1) });
    if ((d.type === "long" || d.type === "short") && TV.Trade) items.push({ sep: true }, { label: "Als Order platzieren (Limit + TP/SL)", icon: "order", action: () => TV.Trade.fromTool(d) });
    items.push({ sep: true }, { label: "Entfernen", icon: "trash", hint: "Entf", color: "var(--down)", action: () => D.remove(d) });
    TV.menu(at, items);
  };

  // ---------------------------------------------------------------- the settings of a drawing
  D.settings = function (d) {
    const k = kindOf(d), s = d.s, before = JSON.stringify(d);
    const LS = [["solid", "durchgezogen"], ["dashed", "gestrichelt"], ["dotted", "gepunktet"]], W = [[1, "1px"], [2, "2px"], [3, "3px"], [4, "4px"]];
    const style = [];
    if ("color" in s && !["long", "short"].includes(k)) style.push({ key: "color", label: k === "frvp" ? "Rahmen" : "Linie", type: "color", with: "width" in s && k !== "frvp" ? [{ key: "width", type: "select", options: k === "highlighter" ? [[6, "6px"], [10, "10px"], [14, "14px"], [20, "20px"], [28, "28px"]] : W }].concat("style" in s && !["brush", "highlighter"].includes(k) ? [{ key: "style", type: "select", str: true, options: LS }] : []) : [] });
    if ("fill" in s && k !== "fib") style.push({ key: "fill", label: "Hintergrund", type: "bool", with: [{ key: "fillColor", type: "color" }] });
    if (k === "text") style.push({ key: "bg", label: "Hintergrund", type: "bool", with: [{ key: "fillColor", type: "color" }] });
    if ("extendL" in s) style.push({ key: "extendL", label: "Nach links verlängern", type: "bool" });
    if ("extendR" in s) style.push({ key: "extendR", label: "Nach rechts verlängern", type: "bool" });
    if ("mid" in s) style.push({ key: "mid", label: "Mittellinie", type: "bool" });
    if ("showPrice" in s) style.push({ key: "showPrice", label: "Preis auf der Achse", type: "bool" });
    if ("showTime" in s) style.push({ key: "showTime", label: "Zeit auf der Achse", type: "bool" });
    if ("alert" in s) style.push({ key: "alert", label: "Alarm (Replay anhalten)", type: "bool" });
    if ("text" in s) style.push({ key: "text", label: "Text", type: k === "text" || k === "note" ? "textarea" : "text" });
    if ("textColor" in s) style.push({ key: "textColor", label: "Textfarbe", type: "color", with: "fontSize" in s ? [{ key: "fontSize", type: "select", options: [[10, "10"], [11, "11"], [12, "12"], [13, "13"], [14, "14"], [16, "16"], [20, "20"], [24, "24"], [28, "28"]] }] : [] });
    if (k === "text") style.push({ key: "bold", label: "Fett", type: "bool" });
    if (k === "fib") style.push({ key: "fill", label: "Hintergrund", type: "bool" }, { key: "labels", label: "Beschriftung", type: "bool" });
    if (k === "long" || k === "short") style.push({ key: "qty", label: "Kontrakte", type: "num", min: 1, max: 100 }, { key: "up", label: "Ziel / Stopp", type: "color", with: [{ key: "down", type: "color" }] }, { key: "labels", label: "Beschriftung", type: "bool" });
    if (k === "frvp") style.push({ key: "width", label: "Breite (% des Bereichs)", type: "num", min: 5, max: 100 }, { key: "split", label: "Auf-/Ab-Volumen", type: "bool" },
      { key: "vaUp", label: "Value Area auf / ab", type: "color", with: [{ key: "vaDown", type: "color" }] }, { key: "up", label: "Außerhalb auf / ab", type: "color", with: [{ key: "down", type: "color" }] },
      { key: "poc", label: "POC", type: "color" }, { key: "pocExtend", label: "POC nach rechts verlängern", type: "bool" }, { key: "box", label: "Rahmen zeigen", type: "bool" },
      { key: "numbers", label: "Zahlen auf den Zeilen", type: "select", str: true, options: [["exact", "genau"], ["short", "gekürzt"], ["off", "aus"]] });
    const tabs = [{ name: "Stil", render: b => TV.form(b, style, s, () => D.save()) }];
    if (k === "fib") tabs.push({ name: "Level", render: b => { for (const lv of s.levels) b.append(el("div.frow", null, el("label", { text: String(lv.v) }), el("div.ctl", null, el("input", { type: "checkbox", checked: lv.on, onchange: e => { lv.on = e.target.checked; D.save(); } }), TV.swatch(lv.color, v => { lv.color = v; D.save(); }), el("input", { type: "number", step: 0.001, value: lv.v, onchange: e => { lv.v = +e.target.value; D.save(); } })))); } });
    tabs.push({ name: "Koordinaten", render: b => {
      d.pts.forEach((q, i) => {
        const pin = el("input", { type: "number", step: TV.spec(D.inst).tick, value: TV.fp(q.p, TV.spec(D.inst).tick), onchange: e => { q.p = +e.target.value; D.save(); } });
        b.append(el("div.frow", null, el("label", { text: `Punkt ${i + 1}` }), el("div.ctl", null, pin, el("span", { text: TV.fmtCross(q.t, 1), style: { color: "var(--muted)" } }))));
      });
    } });
    D.snap();
    TV.dialog({ title: T[d.type] ? T[d.type].name : "Zeichnung", width: 500, tabs,
      buttons: [{ label: "Als Standard", action: () => { TV.store.set("draw.style." + d.type, styleMemo(d)); TV.toast("Als Standard für " + T[d.type].name + " gespeichert", "ok", 2000); return false; } },
                { label: "Abbrechen", action: () => { const o = JSON.parse(before); Object.assign(d, o); D.undo.pop(); D.save(); } }, { label: "OK", kind: "pri" }] });
  };

  // ---------------------------------------------------------------- the object tree (right bar)
  D.tree = function () {
    let dlg;
    const render = b => {
      b.replaceChildren();
      if (!D.list.length) { b.append(el("div.empty", { text: "Keine Zeichnungen für " + D.inst })); return; }
      const box = el("div.objtree");
      for (const d of D.list.slice().reverse()) {
        const s = d.s, col = s.color || s.textColor || "#2962ff";
        box.append(el("div.oi", null, TV.iconSm(iconOf(d.type), 20), el("i", { style: { background: col } }),
          el("span.on", { text: (T[d.type] ? T[d.type].name : d.type) + (s.text ? ` · ${s.text.slice(0, 24)}` : d.pts[0] ? ` · ${TV.fp(d.pts[0].p, TV.spec(D.inst).tick)}` : ""), style: { cursor: "pointer" }, onclick: () => { D.sel = d.id; d.hidden = false; D.save(); TV.app.goTo(d.pts[0].t); } }),
          el("button.lg-btn", { title: d.hidden ? "Einblenden" : "Ausblenden", onclick: () => { d.hidden = !d.hidden; D.save(); render(b); } }, TV.iconSm(d.hidden ? "eyeoff" : "eye")),
          el("button.lg-btn", { title: d.locked ? "Entsperren" : "Sperren", onclick: () => { d.locked = !d.locked; D.save(); render(b); } }, TV.iconSm(d.locked ? "lock" : "unlock")),
          el("button.lg-btn", { title: "Entfernen", onclick: () => { D.remove(d); render(b); } }, TV.iconSm("trash"))));
      }
      b.append(box);
    };
    dlg = TV.dialog({ title: "Objektbaum · " + D.inst, width: 460, pad: false, body: b => render(b), onClose: () => { D.treeOpen = null; } });
    D.treeOpen = () => render(dlg.body);
  };

  // ---------------------------------------------------------------- keys
  window.addEventListener("keydown", e => {
    if (TV.typing(e) || TV.dialogOpen()) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z" && !e.shiftKey) { D.doUndo(); e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && (k === "y" || (k === "z" && e.shiftKey))) { D.doRedo(); e.preventDefault(); return; }
    if ((e.key === "Delete" || e.key === "Backspace") && D.sel) { const d = D.selected(); if (d) D.remove(d); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (e.key === "Escape") { if (D.make || D.tool || D.sel || D.measure) { D.make = null; D.measure = null; D.tool = null; D.sel = null; D.bar(); D.styleBar(); TV.app.redrawAll(); e.stopImmediatePropagation(); } return; }
    if (e.altKey && !e.ctrlKey) {
      const m = e.shiftKey ? { r: "rect" } : { t: "trend", h: "hline", j: "hray", v: "vline", c: "crossline", f: "fib" };
      if (m[k]) { D.setTool(m[k]); e.preventDefault(); e.stopImmediatePropagation(); }
    }
  }, true);
})();
