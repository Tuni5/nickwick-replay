/* trade.js - orders in tv.html, laid out like TradingView's trading panel, simulated by the server's broker
 * (server/broker.py): every order acts from the replay clock's exact time at the click and fills against the day's
 * real prints - the bridge's tick export, else its 1-second bars (the order inside a second assumed; the panel says
 * which). The account is a pure function of what was done and the prints up to the clock, so it follows play, pause
 * and jumps; acting after a jump back drops what lay later (a new branch). One account per CME trade date.
 *   order ticket (right)   buy / sell, market / limit / stop, quantity, take profit and stop loss in ticks or price
 *                          (they ride on the order and become the position's bracket when it fills)
 *   quick buttons          SELL | qty | BUY in each chart's legend, market orders
 *   chart                  position, orders, TP / SL as lines with labels: drag to move, × to cancel / close; drag the
 *                          TP / SL buttons out of a position or a working order; executions as arrows; right-click or
 *                          the + at the price axis for orders at that price
 *   account manager        positions, orders, history, account (bottom panel) */
(function () {
  const { el } = TV;
  const TR = TV.Trade = { ST: null, err: "", feed: null, live: [], busy: false, drag: null, layout: new WeakMap() };
  const tk = () => (TR.ST && TR.ST.tick_size) || TV.spec(TV.app.inst()).tick;
  const pv = () => (TR.ST && TR.ST.point_value) || TV.spec(TV.app.inst()).pv;
  const snap = p => Math.round(p / tk()) * tk();
  const T = TR.ticket = Object.assign({ side: 1, type: "market", qty: 1, price: null, tpOn: false, tpTicks: 16, slOn: false, slTicks: 8, balance: 50000 }, TV.store.get("ticket", {}));
  const saveT = () => TV.store.set("ticket", Object.assign({}, T, { price: null }));
  const q1 = v => Math.round(Math.max(0.1, Math.min(100, +v || 0.1)) * 10) / 10;   // contracts in tenths: 0.1 ES is one MES
  TV.fq = v => (Math.round(v * 10) / 10).toString();
  // the size from the risk: with "Max. risk" on and a stop loss set, the contracts follow the risk (rounded down to a tenth)
  TR.sized = (tickV) => T.riskOn && T.slOn && T.slTicks > 0 && T.risk > 0 ? Math.max(0.1, Math.floor(T.risk / (T.slTicks * tickV) * 10) / 10) : null;
  TR.qty = () => q1(T.qty);
  const rootOf = s => { const m = /^([A-Z0-9]+?)[FGHJKMNQUVXZ]\d{1,2}$/.exec(s || ""); return m ? m[1] : s; };

  // ---------------------------------------------------------------- the account at the clock
  TR.feedNow = function () {
    const s = RC.state; if (!s || s.t == null) return null;
    const inst = TV.app.inst();
    if (s.live) { const f = TR.live.find(x => rootOf(x.instrument) === inst && !x.stale && !x.history); return f ? f.src : null; }
    return `${inst}.1m@${RC.tradeDate(RC.now())}`;
  };
  async function liveFeeds() { try { TR.live = (await TV.getJSON("/feeds")).filter(f => !f.history); } catch (e) {} }
  setInterval(() => { if (RC.state && RC.state.live) liveFeeds(); }, 3000); liveFeeds();
  TR.last = () => { if (TR.ST && TR.ST.last != null) return TR.ST.last; const c = TV.app.active; const B = c && c.BARS; return B && B.length ? B[B.length - 1].c : null; };
  let pollAt = 0, seq = 0;
  TR.refresh = async function () {
    const feed = TR.feedNow(), t = RC.now(), my = ++seq;
    if (!feed) { TR.ST = null; TR.feed = null; TR.err = RC.state && RC.state.live ? "Live: no feed with prints for " + TV.app.inst() : ""; TR.render(); return; }
    try {
      const st = await TV.getJSON(`/api/broker/state?feed=${encodeURIComponent(feed)}&until=${t}&session=${encodeURIComponent(TR.session())}`);
      if (my !== seq) return;
      TR.ST = st; TR.feed = feed; TR.err = "";
    } catch (e) { if (my !== seq) return; TR.ST = null; TR.feed = feed; TR.err = /orders need prints/.test(e.message) ? "No prints for this trading day (no tick export and no 1-second bars) – orders are not possible here." : e.message; }
    TR.render();
  };
  TR.frame = function (now) {
    const playing = RC.state && RC.state.playing;
    const every = TR.err ? 5000 : playing ? 350 : 1500;      // a day without prints: no point asking three times a second
    if (now - pollAt > every && !TR.busy) { pollAt = now; TR.refresh(); }
  };
  RC.on(() => { pollAt = 0; });
  TR.session = () => (RC.state && !RC.state.live && RC.state.replay) || "";       // the replay running: its accounts are its own
  async function post(op, body, quiet) {
    const feed = TR.feedNow(); if (!feed) { TV.toast("Pick a trading day in the replay first", "err"); return null; }
    TR.busy = true;
    try {
      const j = await TV.post(`/api/broker/${op}`, Object.assign({ feed, t: RC.now(), session: TR.session() }, body));
      if (j.dropped) TV.toast(`New branch from here: ${j.dropped} later action${j.dropped > 1 ? "s" : ""} dropped`, "", 4500);
      TR.ST = Object.assign({}, TR.ST || {}, j); TR.feed = feed; TR.err = "";
      if (!quiet) TR.render();
      return j;
    } catch (e) { TV.toast(e.message.includes("prints") ? "No prints for this trading day – orders are not possible here" : "Order refused: " + e.message, "err", 5000); return null; }
    finally { TR.busy = false; pollAt = 0; }
  }
  TR.post = post;
  const sideName = s => s > 0 ? "Buy" : "Sell";
  const typeName = t => ({ market: "Market", limit: "Limit", stop: "Stop" })[t];
  TR.market = (side, qty, extra) => post("order", Object.assign({ side, type: "market", qty: qty || TR.sized(tk() * pv()) || TR.qty() }, extra || {}));
  TR.order = (side, type, price, qty, extra) => post("order", Object.assign({ side, type, qty: qty || TR.sized(tk() * pv()) || TR.qty(), price: snap(price) }, extra || {}));
  // where a feed stands in live: a fresh one for the instrument, or none ("No Live Market Data")
  TR.liveFeedOk = () => { const inst = TV.app.inst(); return TR.live.some(f => rootOf(f.instrument) === inst && !f.stale); };
  TR.flatten = () => post("flatten", {});
  TR.cancelAll = () => post("cancel_all", {});
  TR.reverse = async () => { const st = TR.ST; if (!st || !st.pos) return; const n = Math.abs(st.pos), side = st.pos > 0 ? -1 : 1; await post("flatten", {}, true); await TR.market(side, n); };
  TR.typeAt = (price, side) => { const last = TR.last(); if (last == null) return "limit"; return side > 0 ? (price < last ? "limit" : "stop") : (price > last ? "limit" : "stop"); };
  TR.atPrice = (price, side) => TR.order(side, TR.typeAt(price, side), price);
  TR.fromTool = function (d) {
    const long = d.type === "long", side = long ? 1 : -1, entry = d.pts[0].p;
    TR.order(side, TR.typeAt(entry, side), entry, d.s.qty || 1, { tp: snap(d.pts[1].p), sl: snap(d.pts[2].p) })
      .then(j => { if (j) TV.toast(`${sideName(side)} ${d.s.qty || 1} @ ${TV.fp(entry, tk())} ${typeName(TR.typeAt(entry, side))} with TP ${TV.fp(d.pts[1].p, tk())} / SL ${TV.fp(d.pts[2].p, tk())}`, "ok"); });
  };
  // what an exit at price p would book for the open position (or a pending order's fill)
  const pnlAt = (p, entry, qty) => (p - entry) * qty * pv();

  // ---------------------------------------------------------------- quick buttons in the legend
  TR.quickBox = function (c) {
    const sp = el("span", { text: "–" }), bp = el("span", { text: "–" });
    const q = el("input.qq", { value: TV.fq(TR.sized(tk() * pv()) ?? TR.qty()), title: "Contracts (0.1 = one micro)" });
    q.addEventListener("mousedown", e => e.stopPropagation());
    q.addEventListener("keydown", e => e.stopPropagation());
    q.addEventListener("change", () => { T.qty = q1(q.value); q.value = TV.fq(T.qty); saveT(); TR.renderTicket(); TV.app.charts.forEach(x => x.legend()); });
    const box = el("div.qt", null,
      el("button.qs", { title: "Sell at market (Shift+S)", onclick: e => { e.stopPropagation(); TR.market(-1); } }, el("small", { text: "SELL" }), sp),
      q,
      el("button.qb", { title: "Buy at market (Shift+B)", onclick: e => { e.stopPropagation(); TR.market(1); } }, el("small", { text: "BUY" }), bp));
    box.addEventListener("mousedown", e => e.stopPropagation());
    c._qt = { sp, bp };
    return box;
  };
  TR.quickPrices = function (c) {
    if (!c._qt) return;
    const B = c.BARS, last = (TR.ST && TR.ST.last != null) ? TR.ST.last : B.length ? B[B.length - 1].c : null, txt = TV.fp(last, c.tick());
    if (c._qt.sp.textContent !== txt) { c._qt.sp.textContent = txt; c._qt.bp.textContent = txt; }
  };

  // ---------------------------------------------------------------- the lines in the chart
  const COL = { buy: "#2962ff", sell: "#f23645", tp: "#089981", sl: "#f23645", up: "#089981", dn: "#f23645", flat: "#787b86" };
  function items() {
    const st = TR.ST, out = []; if (!st) return out;
    const d = TR.drag;
    const at = (key, p) => d && d.key === key && d.price != null ? d.price : p;
    if (st.pos) {
      out.push({ key: "pos", kind: "pos", price: st.avg, qty: st.pos, color: st.open_usd > 0 ? COL.up : st.open_usd < 0 ? COL.dn : COL.flat, pnl: st.open_usd, ticks: st.open_ticks });
      for (const k of ["sl", "tp"]) if (st.bracket[k] != null) out.push({ key: k, kind: k, price: at(k, st.bracket[k]), qty: Math.abs(st.pos), color: COL[k], entry: st.avg, sign: Math.sign(st.pos) });
    }
    for (const o of st.orders) {
      if (o.role || o.type === "market") continue;
      out.push({ key: "o:" + o.id, kind: "ord", id: o.id, side: o.side, type: o.type, price: at("o:" + o.id, o.price), qty: o.qty, color: o.side > 0 ? COL.buy : COL.sell, o });
      const shift = at("o:" + o.id, o.price) - o.price;        // dragging the order takes its stop-loss and target along
      for (const k of ["sl", "tp"]) if (o[k] != null) out.push({ key: `o${k}:${o.id}`, kind: "o" + k, id: o.id, price: at(`o${k}:${o.id}`, o[k] + shift), qty: o.qty, color: COL[k], entry: at("o:" + o.id, o.price), sign: o.side, parent: o });
    }
    if (d && d.kind === "new" && d.price != null) out.push({ key: d.key, kind: d.what, id: d.id, price: d.price, qty: d.qty, color: COL[d.what.slice(-2)], entry: d.entry, sign: d.sign, preview: true });
    return out;
  }
  function labelParts(it) {
    const money = v => TV.fusd(v, true), t = tk();
    if (it.kind === "pos") return { head: `${it.qty > 0 ? "L" : "S"} ${TV.fq(Math.abs(it.qty))}`, body: T.unit === "ticks" ? `${it.ticks >= 0 ? "+" : "−"}${Math.abs(it.ticks)} T` : money(it.pnl), x: true, tpsl: [TR.ST.bracket.tp == null && "tp", TR.ST.bracket.sl == null && "sl"].filter(Boolean) };
    if (it.kind === "ord") return { head: `${it.side > 0 ? "KAUF" : "VERK"} ${it.type === "limit" ? "LMT" : "STP"}`, body: TV.fq(it.qty), x: true, tpsl: [it.o.tp == null && "tp", it.o.sl == null && "sl"].filter(Boolean) };
    const name = it.kind.endsWith("tp") ? "TP" : "SL", v = pnlAt(it.price, it.entry, it.qty * it.sign);
    return { head: name, body: (T.unit === "ticks" ? `${v >= 0 ? "+" : "−"}${Math.round(Math.abs(it.price - it.entry) / t)} T` : money(v)), x: !it.preview, tpsl: [] };
  }
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  TR.layer = c => ({
    draw(ctx, w, h) {
      const lay = []; TR.layout.set(c, lay);
      if (TV.app.settings.fills !== false) drawFills(c, ctx);
      drawTrace(c, ctx, w);
      if (!TR.ST || TV.app.settings.orders === false) return;
      const its = items(), F = getComputedStyle(document.body), surf = F.getPropertyValue("--surface").trim() || "#1e1e1e", fam = F.getPropertyValue("--font");
      const H = 20, right = TV.app.settings.labelsLeft ? null : w - 36;      // room for the + at the price axis
      const placed = [];
      for (const it of its) {
        const y = c.yOf(it.price); if (y == null) continue;
        const yc = Math.max(H / 2 + 1, Math.min(h - H / 2 - 1, y));
        const parts = labelParts(it);
        ctx.font = "600 12px " + fam; const wh = ctx.measureText(parts.head).width + 14;
        ctx.font = "12px " + fam; const wb = ctx.measureText(parts.body).width + 14;
        const wx = parts.x ? 20 : 0, wTot = wh + wb + wx;
        let x0 = right != null ? right - wTot : 60;
        for (const p of placed) if (Math.abs(p.y - yc) < H && x0 + wTot > p.x0 - 4 && x0 < p.x0 + p.w + 4) x0 = (right != null ? p.x0 - wTot - 6 : p.x0 + p.w + 6);
        placed.push({ y: yc, x0, w: wTot });
        // the line
        ctx.strokeStyle = it.color; ctx.lineWidth = 1; ctx.setLineDash(it.kind === "pos" ? [] : [6, 4]);
        if (it.kind.startsWith("o") && it.kind !== "ord") ctx.globalAlpha = 0.75;
        const yy = Math.round(y) + 0.5;
        if (y >= 0 && y <= h) { ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(x0, yy); ctx.moveTo(x0 + wTot, yy); ctx.lineTo(w, yy); ctx.stroke(); }
        ctx.setLineDash([]);
        // the label: head (filled) | body | ×
        const top = yc - H / 2;
        ctx.fillStyle = surf; roundRect(ctx, x0, top, wTot, H, 3); ctx.fill();
        ctx.fillStyle = it.color; roundRect(ctx, x0, top, wh, H, 3); ctx.fill(); ctx.fillRect(x0 + wh - 3, top, 3, H);
        ctx.strokeStyle = it.color; roundRect(ctx, x0 + 0.5, top + 0.5, wTot - 1, H - 1, 3); ctx.stroke();
        ctx.textBaseline = "middle"; ctx.font = "600 12px " + fam; ctx.fillStyle = "#fff"; ctx.fillText(parts.head, x0 + 7, yc + 0.5);
        ctx.font = "12px " + fam; ctx.fillStyle = it.kind === "pos" ? it.color : "#d1d4dc"; ctx.fillText(parts.body, x0 + wh + 7, yc + 0.5);
        if (parts.x) { ctx.strokeStyle = "rgba(209,212,220,0.6)"; ctx.beginPath(); ctx.moveTo(x0 + wh + wb, top + 3); ctx.lineTo(x0 + wh + wb, top + H - 3); ctx.stroke();
          ctx.strokeStyle = "#d1d4dc"; ctx.lineWidth = 1.3; const cx = x0 + wh + wb + 10; ctx.beginPath(); ctx.moveTo(cx - 3.5, yc - 3.5); ctx.lineTo(cx + 3.5, yc + 3.5); ctx.moveTo(cx + 3.5, yc - 3.5); ctx.lineTo(cx - 3.5, yc + 3.5); ctx.stroke(); ctx.lineWidth = 1; }
        ctx.globalAlpha = 1;
        const L = { it, y, label: [x0, top, wTot, H], x: parts.x ? [x0 + wh + wb, top, 20, H] : null, btn: [] };
        // TP / SL buttons to drag out
        let bx = x0 - 4;
        for (const k of parts.tpsl) {
          ctx.font = "600 11px " + fam; const bw = ctx.measureText(k.toUpperCase()).width + 12; bx -= bw;
          ctx.fillStyle = surf; roundRect(ctx, bx, top + 1, bw, H - 2, 3); ctx.fill();
          ctx.strokeStyle = COL[k]; roundRect(ctx, bx + 0.5, top + 1.5, bw - 1, H - 3, 3); ctx.stroke();
          ctx.fillStyle = COL[k]; ctx.fillText(k.toUpperCase(), bx + 6, yc + 0.5);
          L.btn.push({ k, r: [bx, top, bw, H] }); bx -= 4;
        }
        lay.push(L);
      }
    },
    axis() {
      if (!TR.ST || TV.app.settings.orders === false) return [];
      return items().map(it => ({ y: c.yOf(it.price), text: TV.fp(it.price, c.tick()), bg: it.color }));
    },
  });
  // the trace of one trade: from the actions of the book, the entry order's price, the stop-loss and the target as
  // steps over time (every move a step), from the first action before the entry to the exit
  TR.trace = null;
  TR.traceSteps = function (tr) {
    const A = (TR.ST && TR.ST.actions || []).filter(a => a.t <= tr.t_out && a.t >= tr.t_in - 4 * 3600).sort((x, y) => x.t - y.t);
    const steps = { entry: [], sl: [], tp: [] }, cur = { entry: null, sl: null, tp: null };
    const ids = new Set();
    for (const a of A) {
      if (a.op === "order" && a.type !== "market" && a.t <= tr.t_in) { ids.add(a.id); cur.entry = { t: a.t, p: a.price, id: a.id }; }
      if (a.op === "order" && a.t <= tr.t_in) { if (a.sl != null) cur.sl = { t: a.t, p: a.sl }; if (a.tp != null) cur.tp = { t: a.t, p: a.tp }; }
      if (a.op === "modify" && ids.has(a.id)) { if (a.price != null && cur.entry) { steps.entry.push({ t0: cur.entry.t, t1: a.t, p: cur.entry.p }); cur.entry = { t: a.t, p: a.price, id: a.id }; }
        for (const k of ["sl", "tp"]) if (k in a) { if (cur[k]) steps[k].push({ t0: cur[k].t, t1: a.t, p: cur[k].p }); cur[k] = a[k] == null ? null : { t: a.t, p: a[k] }; } }
      if (a.op === "bracket") for (const k of ["sl", "tp"]) if (k in a) { if (cur[k]) steps[k].push({ t0: cur[k].t, t1: a.t, p: cur[k].p }); cur[k] = a[k] == null ? null : { t: a.t, p: a[k] }; }
      if (a.op === "cancel" && (a.id === "sl" || a.id === "tp")) { const k = a.id; if (cur[k]) { steps[k].push({ t0: cur[k].t, t1: a.t, p: cur[k].p }); cur[k] = null; } }
      if (a.op === "cancel_all" || a.op === "flatten") for (const k of ["sl", "tp"]) if (cur[k]) { steps[k].push({ t0: cur[k].t, t1: a.t, p: cur[k].p }); cur[k] = null; }
    }
    if (cur.entry) steps.entry.push({ t0: cur.entry.t, t1: tr.t_in, p: cur.entry.p });
    for (const k of ["sl", "tp"]) if (cur[k]) steps[k].push({ t0: cur[k].t, t1: tr.t_out, p: cur[k].p });
    return { steps, actions: A };
  };
  function drawTrace(c, ctx, w) {
    const tr = TR.trace; if (!tr) return;
    const { steps } = TR.traceSteps(tr), cols = { entry: "#6e93ff", sl: "#f23645", tp: "#089981" };
    ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
    for (const k of ["entry", "sl", "tp"]) {
      ctx.strokeStyle = cols[k];
      let last = null;
      for (const st of steps[k]) {
        const x0 = c.xOf(st.t0), x1 = c.xOf(st.t1), y = c.yOf(st.p); if (x0 == null || x1 == null || y == null) continue;
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        if (last && last.x === x0) { ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(x0, last.y); ctx.lineTo(x0, y); ctx.stroke(); ctx.setLineDash([5, 4]); }   // the move
        last = { x: x1, y };
      }
    }
    ctx.setLineDash([]);
    const xi = c.xOf(tr.t_in), xo = c.xOf(tr.t_out), yi = c.yOf(tr.entry), yo = c.yOf(tr.exit);
    if (xi != null && xo != null) { ctx.strokeStyle = tr.usd >= 0 ? "#089981" : "#f23645"; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(xi, yi); ctx.lineTo(xo, yo); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = TV.rgba(tr.usd >= 0 ? "#089981" : "#f23645", 0.12); ctx.fillRect(Math.min(xi, xo), Math.min(yi, yo), Math.abs(xo - xi), Math.max(2, Math.abs(yo - yi))); }
  }
  TR.tradeLog = function (tr) {
    const { actions } = TR.traceSteps(tr), t = tk(), by = { market: "Market", limit: "Limit", stop: "Stop", sl: "Stop loss", tp: "Take profit", flatten: "Flatten" };
    const lines = [];
    for (const a of actions) {
      const when = RC.fmtTime(a.t, true);
      if (a.op === "order") lines.push([when, `${a.side > 0 ? "Buy" : "Sell"} ${by[a.type]} ${TV.fq(a.qty)}${a.price != null ? " @ " + TV.fp(a.price, t) : ""}${a.sl != null ? " · SL " + TV.fp(a.sl, t) : ""}${a.tp != null ? " · TP " + TV.fp(a.tp, t) : ""}`]);
      else if (a.op === "modify") lines.push([when, `Order changed${a.price != null ? ": price " + TV.fp(a.price, t) : ""}${"sl" in a ? (a.sl == null ? " · SL removed" : " · SL " + TV.fp(a.sl, t)) : ""}${"tp" in a ? (a.tp == null ? " · TP removed" : " · TP " + TV.fp(a.tp, t)) : ""}`]);
      else if (a.op === "bracket") lines.push([when, ["sl", "tp"].filter(k => k in a).map(k => `${k.toUpperCase()} ${a[k] == null ? "removed" : "→ " + TV.fp(a[k], t)}`).join(" · ")]);
      else if (a.op === "cancel") lines.push([when, `cancelled: ${a.id === "sl" ? "stop loss" : a.id === "tp" ? "take profit" : "order"}`]);
      else if (a.op === "cancel_all") lines.push([when, "all orders cancelled"]);
      else if (a.op === "flatten") lines.push([when, "flattened"]);
    }
    for (const f of (TR.ST && TR.ST.fills || [])) if (f.t >= tr.t_in - 1 && f.t <= tr.t_out + 1) lines.push([RC.fmtTime(f.t, true), `filled: ${f.side > 0 ? "buy" : "sell"} ${TV.fq(f.qty)} @ ${TV.fp(f.price, t)} (${by[f.role || f.type]})`, true]);
    lines.sort((x, y) => x[0].localeCompare(y[0]));
    TV.dialog({ title: `Trade ${tr.side === "long" ? "Long" : "Short"} ${TV.fq(tr.qty)} · ${TV.fusd(tr.usd, true)} · ${by[tr.exit_by] || tr.exit_by}`, width: 520, pad: false,
      body: b => { const tbl = el("table.grid"); for (const [w, txt, fill] of lines) tbl.append(el("tr", null, el("td", { text: w, style: { width: "90px", color: "var(--muted)" } }), el("td", { text: txt, style: fill ? { color: "var(--text)", fontWeight: 500 } : {} }))); b.append(tbl, el("div", { style: { padding: "10px 12px", color: "var(--muted)", fontSize: "12px" }, text: "Entry, stop loss and take profit stand as steps in the chart while the trade is selected." })); },
      buttons: [{ label: "Close", kind: "pri" }] });
  };
  function drawFills(c, ctx) {
    const st = TR.ST; if (!st || !st.fills) return;
    for (const f of st.fills) {
      const x = c.xOf(f.t), y = c.yOf(f.price); if (x == null || y == null) continue;
      const up = f.side > 0, s = 6;
      ctx.fillStyle = up ? "#2962ff" : "#f23645";
      ctx.beginPath();
      if (up) { ctx.moveTo(x, y + 3); ctx.lineTo(x - s, y + 3 + s * 1.4); ctx.lineTo(x + s, y + 3 + s * 1.4); }
      else { ctx.moveTo(x, y - 3); ctx.lineTo(x - s, y - 3 - s * 1.4); ctx.lineTo(x + s, y - 3 - s * 1.4); }
      ctx.closePath(); ctx.fill();
    }
  }
  const inR = (r, x, y) => r && x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3];
  function hitAt(c, x, y) {
    const lay = TR.layout.get(c) || [];
    for (let i = lay.length - 1; i >= 0; i--) {
      const L = lay[i];
      if (inR(L.x, x, y)) return { L, part: "x" };
      for (const b of L.btn) if (inR(b.r, x, y)) return { L, part: "new", k: b.k };
      if (inR(L.label, x, y)) return { L, part: "label" };
    }
    for (let i = lay.length - 1; i >= 0; i--) if (Math.abs(lay[i].y - y) < 4 && lay[i].it.kind !== "pos") return { L: lay[i], part: "line" };
    return null;
  }
  TR.handler = {
    down(c, x, y) {
      const h = hitAt(c, x, y); if (!h) return false;
      const it = h.L.it;
      if (h.part === "x") {
        if (it.kind === "pos") TR.flatten();
        else if (it.kind === "ord") post("cancel", { id: it.id });
        else if (it.kind === "sl" || it.kind === "tp") post("bracket", { [it.kind]: null });
        else if (it.kind === "osl" || it.kind === "otp") post("modify", { id: it.id, [it.kind.slice(1)]: null });
        return true;
      }
      if (h.part === "new") {
        const k = h.k;
        if (it.kind === "pos") TR.drag = { kind: "new", key: "new", what: k, entry: it.price, sign: Math.sign(it.qty), qty: Math.abs(it.qty), price: null, y0: y };
        else TR.drag = { kind: "new", key: "new", what: "o" + k, id: it.id, entry: it.price, sign: it.side, qty: it.qty, price: null, y0: y };
        return true;
      }
      if (it.kind === "pos") return true;
      TR.drag = { kind: "move", key: it.key, it, price: null, y0: y };
      return true;
    },
    move(c, x, y) {
      const d = TR.drag; if (!d) return;
      if (Math.abs(y - d.y0) < 2 && d.price == null) return;
      const p = c.pOfY(y); if (p == null) return;
      d.price = snap(p); TV.app.redrawAll();
    },
    up() {
      const d = TR.drag; TR.drag = null; TV.app.redrawAll();
      if (!d || d.price == null) return;
      const last = TR.last();
      if (d.kind === "new") {
        const k = d.what.slice(-2), ok = checkSide(k, d.price, d.sign, d.what.startsWith("o") ? d.entry : last);
        if (!ok) return;
        if (d.what.startsWith("o")) post("modify", { id: d.id, [k]: d.price }); else post("bracket", { [k]: d.price });
        return;
      }
      const it = d.it;
      if (it.kind === "ord") {
        const dp = d.price - it.price, body = { id: it.id, price: d.price };
        for (const k of ["sl", "tp"]) if (it.o[k] != null) body[k] = snap(it.o[k] + dp);
        post("modify", body);
      }
      else if (it.kind === "sl" || it.kind === "tp") { if (checkSide(it.kind, d.price, it.sign, last)) post("bracket", { [it.kind]: d.price }); }
      else if (it.kind === "osl" || it.kind === "otp") { const k = it.kind.slice(1); if (checkSide(k, d.price, it.sign, it.entry)) post("modify", { id: it.id, [k]: d.price }); }
    },
    hover(c, x, y) {
      const h = hitAt(c, x, y); if (!h) return null;
      if (h.part === "x") return "pointer";
      if (h.L.it.kind === "pos" && h.part !== "new") return "default";
      return "ns-resize";
    },
  };
  function checkSide(k, price, sign, ref) {                   // a stop below a long's market, a target above it
    if (ref == null) return true;
    const bad = k === "sl" ? (sign > 0 ? price >= ref : price <= ref) : (sign > 0 ? price <= ref : price >= ref);
    if (bad) TV.toast(k === "sl" ? `Stop loss on the wrong side (set it ${sign > 0 ? "below" : "above"} ${TV.fp(ref, tk())})` : `Take profit on the wrong side (set it ${sign > 0 ? "above" : "below"} ${TV.fp(ref, tk())})`, "err");
    return !bad;
  }

  // ---------------------------------------------------------------- orders at a price (right-click, the + button)
  TR.nearLine = function (c, y) {                             // an order or position line within 12 px of y
    for (const L of TR.layout.get(c) || []) if (Math.abs(L.y - y) < 12) return true;
    return false;
  };
  TR.priceItems = function (price) {
    const last = TR.last(), q = TV.fq(TR.sized(tk() * pv()) ?? TR.qty()), p = TV.fp(price, tk()), out = [];
    if (last == null) return out;
    const below = price < last;
    out.push({ label: `Buy ${q} @ ${p} ${below ? "Limit" : "Stop"}`, icon: "order", color: "#6e93ff", action: () => TR.order(1, below ? "limit" : "stop", price) });
    out.push({ label: `Sell ${q} @ ${p} ${below ? "Stop" : "Limit"}`, icon: "order", color: "#f7525f", action: () => TR.order(-1, below ? "stop" : "limit", price) });
    out.push({ label: `Buy ${q} at market`, hint: "Shift+B", action: () => TR.market(1) }, { label: `Sell ${q} at market`, hint: "Shift+S", action: () => TR.market(-1) });
    const st = TR.ST;
    if (st && st.pos) {
      const sgn = Math.sign(st.pos), isSl = sgn > 0 ? price < last : price > last, v = pnlAt(price, st.avg, st.pos);
      out.push({ sep: true }, { label: `${isSl ? "Stop-Loss" : "Take-Profit"} hier (${TV.fusd(v, true)})`, icon: "flag", action: () => post("bracket", { [isSl ? "sl" : "tp"]: price }) },
               { label: "Flatten position", action: () => TR.flatten() });
    }
    out.push({ label: "Order ticket with this price …", icon: "trade", action: () => { T.type = below ? "limit" : "stop"; T.price = price; TR.openTicket(true); } });
    return out;
  };

  // ---------------------------------------------------------------- the order ticket (right panel)
  TR.openTicket = function (on) { document.body.classList.toggle("ticket-open", on == null ? !document.body.classList.contains("ticket-open") : on); TV.store.set("ticketOpen", document.body.classList.contains("ticket-open")); TR.renderTicket(true); TV.app.rightBar(); };
  function num(value, step, onSet, unit, opt) {
    opt = opt || {};
    const inp = el("input", { value, inputmode: "decimal" });
    inp.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") inp.blur(); if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); onSet(+inp.value + (e.key === "ArrowUp" ? step : -step)); } });
    inp.addEventListener("change", () => onSet(+inp.value));
    const w = el("div.num-in" + (opt.dis ? ".tk-dis" : ""), null, inp, unit ? el("span.u", { text: unit }) : null,
      opt.bare ? null : el("button", { text: "−", tabindex: -1, onclick: () => onSet(+inp.value - step) }), opt.bare ? null : el("button", { text: "+", tabindex: -1, onclick: () => onSet(+inp.value + step) }));
    return w;
  }
  TR.renderTicket = function (force) {
    const box = TV.$("#ticket"); if (!box || !document.body.classList.contains("ticket-open")) return;
    if (!force && box.contains(document.activeElement) && document.activeElement.tagName === "INPUT") { updTicketPrices(); return; }
    const inst = TV.app.inst(), sp = TV.spec(inst), t = tk(), last = TR.last();
    if (T.type !== "market" && T.price == null && last != null) T.price = last;
    const ref = T.type === "market" ? last : T.price;
    const tpP = ref != null ? ref + T.side * T.tpTicks * t : null, slP = ref != null ? ref - T.side * T.slTicks * t : null;
    const tickV = t * pv(), sized = TR.sized(tickV), q = sized != null ? sized : TR.qty();
    box.replaceChildren(...[
      el("div.tk-head", null, el("div", null, el("div.ti", { text: inst }), el("div.sub", { text: sp.name + " · CME" })), el("button.dx.lg-btn", { title: "Close", onclick: () => TR.openTicket(false) }, TV.icon("close"))),
      el("div.tk-sides", null,
        el("button.tk-side.sell" + (T.side < 0 ? ".on" : ""), { onclick: () => { T.side = -1; saveT(); TR.renderTicket(true); } }, el("small", { text: "Sell" }), el("span.tkp", { text: TV.fp(last, t) })),
        el("button.tk-side.buy" + (T.side > 0 ? ".on" : ""), { onclick: () => { T.side = 1; saveT(); TR.renderTicket(true); } }, el("small", { text: "Buy" }), el("span.tkp", { text: TV.fp(last, t) }))),
      el("div.tk-tabs", null, ...["market", "limit", "stop"].map(k => el("button" + (T.type === k ? ".on" : ""), { text: typeName(k), onclick: () => { T.type = k; T.price = k === "market" ? null : (last != null ? last : T.price); saveT(); TR.renderTicket(true); } }))),
      T.type !== "market" ? el("div.tk-sec", null, el("div.tk-lab", null, el("span", { text: T.type === "limit" ? "Limitpreis" : "Stoppreis" }), el("span", { text: last != null ? `Market ${TV.fp(last, t)}` : "" })),
        num(TV.fp(T.price, t), t, v => { T.price = snap(v); TR.renderTicket(true); })) : null,
      el("div.tk-sec", null, el("div.tk-lab", null, el("span", { text: "Contracts (0.1 = one micro)" }), el("span", { text: `Tick value ${TV.fusd(tickV)}` })),
        num(TV.fq(q), 0.1, v => { T.qty = q1(v); saveT(); TR.renderTicket(true); TV.app.charts.forEach(c => c.legend()); }, null, { dis: sized != null }),
        el("label.tk-chk", { style: { marginTop: "8px" } }, el("input", { type: "checkbox", checked: !!T.riskOn, onchange: e => { T.riskOn = e.target.checked; saveT(); TR.renderTicket(true); TV.app.charts.forEach(c => c.legend()); } }), el("span", { text: "Max. risk – contracts from the amount and the stop loss" })),
        el("div.tk-row" + (T.riskOn ? "" : ".tk-dis"), { style: { marginTop: "6px" } }, num(T.risk || 250, 50, v => { T.risk = Math.max(0, Math.round(v)); saveT(); TR.renderTicket(true); TV.app.charts.forEach(c => c.legend()); }, "$")),
        T.riskOn && !T.slOn ? el("div.tk-lab", { style: { marginTop: "4px" }, text: "The stop loss below has to be on for that" }) : null),
      bracketSec("tp", "Take profit", tpP, tickV * q), bracketSec("sl", "Stop loss", slP, tickV * q),
      el("div.tk-info", null,
        el("span", { text: "Contracts" }), el("span", { text: TV.fq(q) + (sized != null ? " (from risk)" : "") }),
        el("span", { text: "Risk" }), el("span", { text: T.slOn ? TV.fusd(T.slTicks * tickV * q) : "–" }),
        el("span", { text: "Profit target" }), el("span", { text: T.tpOn ? TV.fusd(T.tpTicks * tickV * q) : "–" }),
        el("span", { text: "Reward / risk" }), el("span", { text: T.tpOn && T.slOn ? (T.tpTicks / T.slTicks).toFixed(2) : "–" })),
      el("div.tk-err", { text: TR.err || "" }),
      goButton(inst, ref, tpP, slP),
      el("div.tk-acts", null, el("button", { text: "Flatten", onclick: () => TR.flatten() }), el("button", { text: "Reverse", onclick: () => TR.reverse() }), el("button", { text: "Cancel all", onclick: () => TR.cancelAll() })),
      el("div.tk-note", { text: `Simulated against the day's real prints · one account per trading day${TR.ST && TR.ST.fills_from ? " · fills: " + fillsText(TR.ST.fills_from) : ""}` })].filter(Boolean));
    function bracketSec(k, name, price, perTick) {
      const on = T[k + "On"], ticks = T[k + "Ticks"];
      return el("div.tk-sec", null,
        el("label.tk-chk", null, el("input", { type: "checkbox", checked: on, onchange: e => { T[k + "On"] = e.target.checked; saveT(); TR.renderTicket(true); } }), el("span", { text: name })),
        el("div.tk-row" + (on ? "" : ".tk-dis"), { style: { marginTop: "6px" } },
          num(ticks, 1, v => { T[k + "Ticks"] = Math.max(1, Math.round(v || 1)); saveT(); TR.renderTicket(true); }, "Ticks"),
          num(TV.fp(price, t), t, v => { if (ref == null) return; T[k + "Ticks"] = Math.max(1, Math.round(Math.abs(v - ref) / t)); saveT(); TR.renderTicket(true); }, "Price", { bare: true })),
        el("div.tk-lab", { style: { marginTop: "4px", marginBottom: 0 } }, el("span", { text: "" }), el("span", { text: on ? TV.fusd((k === "tp" ? 1 : -1) * ticks * perTick, true) : "" })));
    }
    function goButton(inst, ref, tpP, slP) {
      const s = T.side, kind = T.type, extra = [];
      if (T.tpOn && tpP != null) extra.push("TP " + TV.fp(tpP, t)); if (T.slOn && slP != null) extra.push("SL " + TV.fp(slP, t));
      return el("button.tk-go." + (s > 0 ? "buy" : "sell"), { onclick: () => {
        const ex = {}; if (T.tpOn && tpP != null) ex.tp = snap(tpP); if (T.slOn && slP != null) ex.sl = snap(slP);
        if (kind === "market") TR.market(s, q, ex);
        else {
          if (kind === "stop" && last != null && (s > 0 ? T.price <= last : T.price >= last)) { TV.toast(`Set the stop order ${s > 0 ? "above" : "below"} the market (${TV.fp(last, t)})`, "err"); return; }
          TR.order(s, kind, T.price, q, ex);
        }
      } }, `${sideName(s)} ${TV.fq(q)} ${inst} @ ${kind === "market" ? "Market" : TV.fp(T.price, t) + " " + typeName(kind)}`, el("small", { text: extra.join(" · ") || (kind === "limit" ? "Limit order" : kind === "stop" ? "Stop order" : "Market order") }));
    }
  };
  function updTicketPrices() { const l = TR.last(); TV.$$("#ticket .tkp").forEach(x => x.textContent = TV.fp(l, tk())); }
  const fillsText = s => /1-second/.test(s) ? "1-second bars (the order within a second assumed)" : /tick export/.test(s) ? "Tick export (every trade)" : /live/.test(s) ? "Live-Prints" : s;

  // ---------------------------------------------------------------- the account manager (bottom panel)
  const B = TR.bottom = { open: TV.store.get("bottom.open", innerWidth > 500), tab: TV.store.get("bottom.tab", "pos"), h: TV.store.get("bottom.h", 210) };
  TR.renderBottom = function () {
    const box = TV.$("#bottom"); if (!box) return;
    const st = TR.ST, sp = TV.spec(TV.app.inst()), t = tk();
    const allTrades = st ? (st.session_trades || st.trades) : [];
    const n = { pos: st && st.pos ? 1 : 0, ord: st ? st.orders.filter(o => !o.role || o.role === "sl" || o.role === "tp").length : 0, hist: allTrades.length };
    box.classList.toggle("open", B.open);
    box.style.height = B.open ? B.h + "px" : "";
    const tab = (k, name) => el("button.btab" + (B.open && B.tab === k ? ".on" : ""), { onclick: () => { if (B.open && B.tab === k) B.open = false; else { B.open = true; B.tab = k; } TV.store.set("bottom.open", B.open); TV.store.set("bottom.tab", B.tab); TR.renderBottom(); } }, name);
    const realized = st ? (st.session_realized_usd != null ? st.session_realized_usd : st.realized_usd) : 0;
    const base = st && st.session_balance != null ? st.session_balance : T.balance;         // a named session has its own starting balance
    const bal = base + realized, eq = bal + (st ? st.open_usd : 0);
    const sum = el("div.bsum", null,
      el("span", null, "Balance ", el("b", { text: TV.fusd(bal) })), el("span", null, "Equity ", el("b", { text: TV.fusd(eq) })),
      el("span", null, "Realized ", el("b", { text: TV.fusd(realized, true), class: realized < 0 ? "dn" : realized > 0 ? "up" : "" })),
      el("span", null, "Open ", el("b", { text: TV.fusd(st ? st.open_usd : 0, true), class: st && st.open_usd < 0 ? "dn" : st && st.open_usd > 0 ? "up" : "" })));
    const head = el("div.bhead", null, el("span", { text: "Replay trading", style: { fontWeight: 600, padding: "0 10px 0 6px" } }),
      tab("pos", `Positions${n.pos ? " (" + n.pos + ")" : ""}`), tab("ord", `Orders${n.ord ? " (" + n.ord + ")" : ""}`), tab("hist", `History${n.hist ? " (" + n.hist + ")" : ""}`), tab("acct", "Account"),
      el("span.grow"), sum,
      el("button.lg-btn", { title: B.open ? "Collapse panel" : "Expand panel", style: { width: "28px", height: "28px" }, onclick: () => { B.open = !B.open; TV.store.set("bottom.open", B.open); TR.renderBottom(); } }, TV.iconSm(B.open ? "down" : "down", 22)));
    if (!B.open) head.lastChild.style.transform = "rotate(180deg)";
    const rz = el("div.resize", { title: "Drag height" });
    rz.addEventListener("mousedown", e => {
      e.preventDefault(); const y0 = e.clientY, h0 = B.h;
      const mv = ev => { B.h = Math.max(90, Math.min(innerHeight * 0.7, h0 - (ev.clientY - y0))); box.style.height = B.h + "px"; };
      const upf = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", upf); TV.store.set("bottom.h", B.h); };
      window.addEventListener("mousemove", mv); window.addEventListener("mouseup", upf);
    });
    const body = el("div.bbody");
    if (B.open) body.append(tableFor(B.tab, st, sp, t));
    box.replaceChildren(...(B.open ? [rz] : []), head, body);
  };
  function tableFor(tab, st, sp, t) {
    const inst = TV.app.inst(), wrap = el("div");
    const note = el("div", { style: { padding: "6px 12px", color: "var(--muted)", fontSize: "11px", display: "flex", gap: "14px", alignItems: "center" } },
      el("span", { text: TR.feed ? (st && st.session ? (st.session.startsWith("s") ? `Session “${st.session_name || ""}” · ${inst} · kept · trading day ${TR.feed.split("@")[1] || ""}` : `Replay account ${inst} · until the replay ends · trading day ${TR.feed.split("@")[1] || ""}`) : `Day account ${inst} · trading day ${TR.feed.split("@")[1] || ""}${st && st.live ? " · LIVE (paper)" : ""}`) : "No trading day" }),
      st && st.session && st.session.startsWith("s") ? el("button.btn", { text: "Journal", style: { height: "26px", padding: "0 10px" }, onclick: () => TV.Journal.open() }) : null,
      st && st.fills_from ? el("span", { text: "Fills: " + fillsText(st.fills_from) }) : null,
      TR.err ? el("span", { text: TR.err, style: { color: "#ffb74d" } }) : null, el("span.grow"),
      el("button.btn", { text: "Reset day account", style: { height: "24px", fontSize: "11px", padding: "0 10px" }, onclick: async () => {
        if (!TR.feed || !confirm(`Delete all orders and trades of ${inst} on ${TR.feed.split("@")[1]}?`)) return;
        try { await TV.post("/api/broker/reset", { feed: TR.feed }); TV.toast("Day account reset", "ok"); } catch (e) { TV.toast(e.message, "err"); } TR.refresh(); } }));
    if (!st) { wrap.append(el("div.empty", { text: TR.err || "The account appears once the replay stands on a trading day with prints." }), note); return wrap; }
    const tbl = (cols, rows, empty) => {
      if (!rows.length) return el("div.empty", { text: empty });
      return el("table.grid", null, el("thead", null, el("tr", null, ...cols.map(c => el("th", { text: c[0], class: c[1] || "" })))), el("tbody", null, ...rows));
    };
    const cell = (v, cls) => el("td", { class: cls || "" }, v);
    const xCell = (title, fn) => el("td.x", { title, onclick: fn, text: "×" });
    if (tab === "pos") {
      const rows = [];
      if (st.pos) rows.push(el("tr", null, cell(inst), cell(st.pos > 0 ? "Long" : "Short", st.pos > 0 ? "side-buy" : "side-sell"), cell(TV.fq(Math.abs(st.pos)), "num"),
        cell(TV.fp(st.avg, t), "num"), cell(st.bracket.tp != null ? TV.fp(st.bracket.tp, t) : "–", "num"), cell(st.bracket.sl != null ? TV.fp(st.bracket.sl, t) : "–", "num"),
        cell(TV.fp(st.last, t), "num"), cell(`${st.open_ticks >= 0 ? "+" : ""}${st.open_ticks}`, "num " + (st.open_usd >= 0 ? "up" : "dn")), cell(TV.fusd(st.open_usd, true), "num " + (st.open_usd >= 0 ? "up" : "dn")),
        xCell("Close position", () => TR.flatten())));
      wrap.append(tbl([["Symbol"], ["Side"], ["Qty", "num"], ["Ø price", "num"], ["Take profit", "num"], ["Stop loss", "num"], ["Last", "num"], ["P&L ticks", "num"], ["P&L", "num"], [""]], rows, "No open position"));
    } else if (tab === "ord") {
      const rows = st.orders.filter(o => o.role !== "flatten").map(o => el("tr", null, cell(inst), cell(o.role === "sl" ? "SL" : o.role === "tp" ? "TP" : o.side > 0 ? "Buy" : "Sell", o.side > 0 ? "side-buy" : "side-sell"),
        cell(typeName(o.type)), cell(TV.fq(o.qty), "num"), cell(o.price != null ? TV.fp(o.price, t) : "–", "num"), cell(o.tp != null ? TV.fp(o.tp, t) : "–", "num"), cell(o.sl != null ? TV.fp(o.sl, t) : "–", "num"),
        cell(o.role ? "Bracket" : "Working"), cell(o.t ? RC.fmtTime(o.t, true) : ""),
        xCell("Stornieren", () => o.role ? post("bracket", { [o.role]: null }) : post("cancel", { id: o.id }))));
      wrap.append(tbl([["Symbol"], ["Side"], ["Type"], ["Qty", "num"], ["Price", "num"], ["TP", "num"], ["SL", "num"], ["Status"], ["Time"], [""]], rows, "No working orders"));
    } else if (tab === "hist") {
      const by = { market: "Market", limit: "Limit", stop: "Stop", sl: "Stop loss", tp: "Take profit", flatten: "Flattened" };
      const rows = (st.session_trades || st.trades).slice().reverse().map(x => el("tr", { style: { cursor: "pointer", background: TR.trace && TR.trace.t_in === x.t_in ? "var(--blue-bg)" : "" }, title: "Click: this trade's moves in the chart · double-click: the log",
          onclick: () => { TR.trace = TR.trace && TR.trace.t_in === x.t_in ? null : x; sig = ""; TR.render(); if (TR.trace) TV.app.goTo(x.t_in); },
          ondblclick: async () => { const sid = TR.session(); if (sid && sid.startsWith("s") && TV.Journal) { try { const st = await TV.getJSON("/api/sessions?id=" + sid); const t = st.trades_list.find(y => Math.abs(y.t_in - x.t_in) < 0.01 && Math.abs(y.t_out - x.t_out) < 0.01); if (t) { TV.Journal.tradePage(st, t); return; } } catch (e) {} } TR.tradeLog(x); } },
        cell(RC.fmtFull(x.t_in)), cell(RC.fmtTime(x.t_out, true)), cell(x.side === "long" ? "Long" : "Short", x.side === "long" ? "side-buy" : "side-sell"),
        cell(TV.fq(x.qty), "num"), cell(TV.fp(x.entry, t), "num"), cell(TV.fp(x.exit, t), "num"), cell(`${x.ticks >= 0 ? "+" : ""}${x.ticks}`, "num " + (x.usd >= 0 ? "up" : "dn")),
        cell(TV.fusd(x.usd, true), "num " + (x.usd >= 0 ? "up" : "dn")), cell(by[x.exit_by] || x.exit_by), cell(TV.fdur(x.t_out - x.t_in))));
      wrap.append(tbl([["Entry"], ["Exit"], ["Side"], ["Qty", "num"], ["Entry price", "num"], ["Exit price", "num"], ["Ticks", "num"], ["P&L", "num"], ["Exit by"], ["Duration"]], rows, "No closed trades on this day yet"));
    } else {
      const tr = st.session_trades || st.trades, wins = tr.filter(x => x.usd > 0), loss = tr.filter(x => x.usd < 0), gw = wins.reduce((a, x) => a + x.usd, 0), gl = -loss.reduce((a, x) => a + x.usd, 0);
      const tile = (k, v, cls) => el("div", null, el("small", { text: k }), el("b", { text: v, class: cls || "" }));
      const rz = st.session_realized_usd != null ? st.session_realized_usd : st.realized_usd, bal = (st.session_balance != null ? st.session_balance : T.balance) + rz;
      const balIn = el("input", { type: "number", value: T.balance, step: 1000, style: { width: "110px", height: "26px", background: "var(--bg)", border: "1px solid var(--line2)", borderRadius: "4px", padding: "0 6px" }, onchange: e => { T.balance = Math.max(0, +e.target.value || 0); saveT(); TR.renderBottom(); } });
      wrap.append(el("div.sumgrid", null,
        tile("Balance", TV.fusd(bal)), tile("Equity", TV.fusd(bal + st.open_usd)), tile(st.session ? "Realized (replay)" : "Realized (day)", TV.fusd(rz, true), rz >= 0 ? "up" : "dn"),
        tile("Open", TV.fusd(st.open_usd, true), st.open_usd >= 0 ? "up" : "dn"), tile("Trades", String(tr.length)), tile("Win rate", tr.length ? Math.round(wins.length / tr.length * 100) + " %" : "–"),
        tile("Profit factor", gl ? (gw / gl).toFixed(2) : wins.length ? "∞" : "–"), tile("Ø win / loss", `${wins.length ? TV.fusd(gw / wins.length) : "–"} / ${loss.length ? TV.fusd(-gl / loss.length) : "–"}`),
        tile("Largest win", wins.length ? TV.fusd(Math.max(...wins.map(x => x.usd)), true) : "–", "up"), tile("Largest loss", loss.length ? TV.fusd(Math.min(...loss.map(x => x.usd))) : "–", "dn")),
        el("div", { style: { padding: "8px 12px", display: "flex", gap: "10px", alignItems: "center", color: "var(--text2)", fontSize: "12px" } }, "Starting balance", balIn,
          el("span", { text: "· show in", style: { color: "var(--muted)" } }),
          el("select", { style: { height: "26px", background: "var(--bg)", border: "1px solid var(--line2)", borderRadius: "4px" }, onchange: e => { T.unit = e.target.value; saveT(); TV.app.redrawAll(); } },
            el("option", { value: "usd", text: "$", selected: T.unit !== "ticks" }), el("option", { value: "ticks", text: "Ticks", selected: T.unit === "ticks" }))));
    }
    wrap.append(note);
    return wrap;
  }

  // ---------------------------------------------------------------- render everything that shows the account
  let sig = "";
  TR.render = function () {
    const st = TR.ST, s = JSON.stringify([st && [st.pos, st.avg, st.open_usd, st.realized_usd, st.orders, st.bracket, st.trades.length, st.last, st.fills.length, st.session, st.session_realized_usd, (st.session_trades || []).length], TR.err, TR.feed, B.open, B.tab]);
    TV.app.redrawAll(); TV.app.charts.forEach(c => TR.quickPrices(c));
    if (s === sig) { updTicketPrices(); return; }
    sig = s; TR.renderBottom(); TR.renderTicket();
  };
  window.addEventListener("keydown", e => {
    if (TV.typing(e) || TV.dialogOpen() || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === "B") { TR.market(1); e.preventDefault(); } else if (e.key === "S") { TR.market(-1); e.preventDefault(); }
  });
})();
