/* journal.js - the journal: named sessions, the trade page, the calendar with a note per day, the dashboard. Every
 * figure comes from the server (sessions.py), which replays the session's books with the broker - nothing here
 * estimates.
 *   Sessions         name, instrument, start (a moment), end (a date, optional), balance; "Start" sets the clock
 *                    to the start and makes the session the replay's id, so what is traded is booked under it;
 *                    "Delete" removes the session with its trades
 *   Trade page       a trade's figures, its moves (the log), note, tags, mistakes, a rating 1-5
 *   Calendar         a month grid, P/L and trades per day, a note per day
 *   Dashboard        totals, the equity curve, the distribution by hour, weekday, tag, mistake, exit
 * Opened from the right bar (the book icon) or the trading panel. */
(function () {
  const J = TV.Journal = { cur: null, tab: "dash", month: null };
  const el = TV.el;
  const fusd = v => v == null ? "–" : TV.fusd(v, true);
  const cls = v => v > 0 ? "up" : v < 0 ? "dn" : "";

  // ---------------------------------------------------------------- the page
  J.open = async function (tab) {
    if (tab) J.tab = tab;
    let page = TV.$("#journal");
    if (!page) { page = el("div"); page.id = "journal"; TV.$("#stage").append(page); }
    page.classList.remove("hidden");
    await J.render();
  };
  J.close = () => { const p = TV.$("#journal"); if (p) p.classList.add("hidden"); };
  J.toggle = () => { const p = TV.$("#journal"); if (p && !p.classList.contains("hidden")) J.close(); else J.open(); };

  J.render = async function () {
    const page = TV.$("#journal"); if (!page) return;
    page.replaceChildren();
    let list = [];
    try { list = (await TV.getJSON("/api/sessions")).sessions; } catch (e) { TV.toast("Sessions: " + e.message, "err"); }
    const active = RC.state && RC.state.replay && RC.state.replay.startsWith("s") ? RC.state.replay : null;
    if (!J.cur && list.length) J.cur = (list.find(s => s.id === active) || list[0]).id;
    const head = el("div.jhead", null,
      el("b", { text: "Journal" }),
      el("select.jsel", { onchange: e => { J.cur = e.target.value; J.render(); } }, ...list.map(s => el("option", { value: s.id, text: `${s.name} · ${s.inst} · from ${RC.fmtDate(s.start)}${s.end ? " to " + s.end : ""}${s.id === active ? " · running" : ""}`, selected: s.id === J.cur }))),
      el("button.btn", { text: "New session", onclick: () => J.newSession() }),
      el("span", { style: { flex: "1" } }),
      ...["dash", "cal", "trades", "sess"].map(t => el("button.jtab" + (J.tab === t ? ".on" : ""), { text: { dash: "Overview", cal: "Calendar", trades: "Trades", sess: "Session" }[t], onclick: () => { J.tab = t; J.render(); } })),
      el("button.lg-btn", { title: "Close (J)", onclick: J.close }, TV.iconSm("close", 18)));
    page.append(head);
    const body = el("div.jbody"); page.append(body);
    if (!J.cur) { body.append(el("div.jempty", { text: "No session yet. “New session” creates one: name, instrument, start point, starting balance." })); return; }
    let st;
    try { st = await TV.getJSON("/api/sessions?id=" + encodeURIComponent(J.cur)); } catch (e) { body.append(el("div.jempty", { text: e.message })); return; }
    J.st = st;
    ({ dash: J.dash, cal: J.calendar, trades: J.trades, sess: J.session })[J.tab](body, st, active === st.id);
  };

  // ---------------------------------------------------------------- sessions
  J.newSession = function () {
    const t = RC.now() || Math.floor(Date.now() / 1000);
    const f = { name: "", inst: TV.app.inst(), start: t, end: "", balance: 50000, note: "" };
    const dlg = TV.dialog({ title: "New session", width: 480, enter: () => create(),
      body: b => TV.form(b, [{ key: "name", label: "Name", type: "text" }, { key: "inst", label: "Instrument", type: "text" },
        { key: "start", label: "Start point", type: "time" }, { key: "end", label: "End (date, optional)", type: "text" },
        { key: "balance", label: "Starting balance $", type: "num", min: 0, max: 1e8 }, { key: "note", label: "Note", type: "text" }], f, () => {}),
      buttons: [{ label: "Cancel" }, { label: "Create and start", kind: "pri", action: () => create() }] });
    async function create() {
      try {
        const s = await TV.post("/api/sessions", Object.assign({ op: "create" }, f));
        dlg.close(); J.cur = s.id; await J.start(s); J.render();
      } catch (e) { TV.toast(e.message, "err"); return false; }
    }
  };
  J.start = async function (s) {
    await RC.send("inst", { inst: s.inst });
    await RC.send("session", { session: s.id, t: s.start });
    TV.toast(`Session “${s.name}” running: replay from ${RC.fmtFull(s.start)}`, "ok");
    if (TV.Trade) TV.Trade.refresh();
  };
  J.session = function (body, st, running) {
    const f = { name: st.name, end: st.end || "", balance: st.balance, note: st.note || "" };
    const box = el("div.jsess");
    box.append(el("div.jsub", { text: `${st.inst} · Start ${RC.fmtFull(st.start)} · angelegt ${RC.fmtDate(st.created)}` }));
    TV.form(box, [{ key: "name", label: "Name", type: "text" }, { key: "end", label: "End (date, optional)", type: "text" },
                  { key: "balance", label: "Starting balance $", type: "num", min: 0, max: 1e8 }, { key: "note", label: "Note", type: "text" }], f, () => {});
    box.append(el("div.jrow", null,
      el("button.btn.pri", { text: "Save", onclick: async () => { try { await TV.post("/api/sessions", Object.assign({ op: "update", id: st.id }, f)); TV.toast("Saved", "ok"); J.render(); } catch (e) { TV.toast(e.message, "err"); } } }),
      el("button.btn", { text: running ? "Running – to the chart" : "Start (replay from the start point)", onclick: async () => { if (running) J.close(); else { await J.start(st); J.render(); } } }),
      running ? el("button.btn", { text: "Continue from last", title: "Continue the replay at this session's last moment", onclick: () => { J.close(); } }) : null,
      el("span", { style: { flex: "1" } }),
      el("button.btn", { text: "Delete session", style: { color: "var(--down)" }, onclick: () => TV.dialog({ title: "Delete session?", width: 420,
        body: b => b.append(el("div", { text: `“${st.name}” with ${st.totals.trades} trades, notes and tags will be deleted.`, style: { color: "var(--text2)" } })),
        buttons: [{ label: "Cancel" }, { label: "Delete", kind: "pri", action: async () => { await TV.post("/api/sessions", { op: "delete", id: st.id }); if (running) await RC.send("live", { inst: TV.app.inst() }); J.cur = null; J.render(); } }] }) })));
    body.append(box);
  };

  // ---------------------------------------------------------------- dashboard
  J.dash = function (body, st) {
    const T = st.totals;
    const tile = (k, v, c) => el("div.jtile", null, el("small", { text: k }), el("b", { text: v, class: c || "" }));
    body.append(el("div.jtiles", null,
      tile("Equity", TV.fusd(T.equity), cls(T.equity - T.balance)), tile("Profit / loss", fusd(T.usd), cls(T.usd)),
      tile("Trades", String(T.trades)), tile("Win rate", T.win_rate == null ? "–" : T.win_rate + " %"),
      tile("Profitfaktor", T.profit_factor == null ? "–" : String(T.profit_factor)), tile("Expectancy / trade", fusd(T.expectancy), cls(T.expectancy)),
      tile("Ø win", fusd(T.avg_win), "up"), tile("Ø loss", fusd(T.avg_loss), "dn"),
      tile("Largest win", fusd(T.largest_win), "up"), tile("Largest loss", fusd(T.largest_loss), "dn"),
      tile("Max. drawdown", TV.fusd(T.max_drawdown), T.max_drawdown ? "dn" : ""), tile("Trading days", `${T.days} · ${T.green_days} green`)));
    body.append(el("div.jsub", { text: "Equity curve" }), equity(st.equity, st.balance));
    const row = el("div.jcharts");
    row.append(bars("By hour (NY)", st.by_hour, k => `${String(k).padStart(2, "0")}h`), bars("By weekday", st.by_weekday.slice().sort((a, b) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(a.key) - ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(b.key)), k => k),
      bars("By setup tag", st.by_tag), bars("By mistake", st.by_mistake), bars("By exit", st.by_exit, k => ({ sl: "Stop Loss", tp: "Take Profit", flatten: "Flattened", market: "Market", limit: "Limit", stop: "Stop" })[k] || k));
    body.append(row);
  };
  const sv = (tag, a) => { const e = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const k in a) { if (k === "text") e.textContent = a[k]; else e.setAttribute(k, a[k]); } return e; };
  function equity(pts, base) {
    const W = 900, H = 180, P = 28, svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, class: "jequity" });
    const ys = [base, ...pts.map(p => p[1])], lo = Math.min(...ys), hi = Math.max(...ys), span = (hi - lo) || 1;
    const x = i => P + (W - 2 * P) * (pts.length ? i / pts.length : 0), y = v => H - P - (H - 2 * P) * (v - lo) / span;
    let d = `M${x(0)} ${y(base)}`; pts.forEach((p, i) => { d += ` L${x(i + 1)} ${y(p[1])}`; });
    const baseY = y(base);
    svg.append(sv("line", { x1: P, x2: W - P, y1: baseY, y2: baseY, stroke: "var(--line2)", "stroke-dasharray": "4 4" }));
    svg.append(sv("path", { d, fill: "none", stroke: (pts.length ? pts[pts.length - 1][1] : base) >= base ? "var(--up)" : "var(--down)", "stroke-width": 2 }));
    svg.append(sv("text", { x: P, y: baseY - 4, fill: "var(--muted)", "font-size": 11, text: TV.fusd(base) }));
    if (pts.length) svg.append(sv("text", { x: W - P, y: y(pts[pts.length - 1][1]) - 6, fill: "var(--text)", "font-size": 11, "text-anchor": "end", text: TV.fusd(pts[pts.length - 1][1]) }));
    return svg;
  }
  function bars(title, rows, label) {
    const box = el("div.jbars", null, el("div.jsub", { text: title }));
    if (!rows || !rows.length) { box.append(el("div.jempty", { text: "–" })); return box; }
    const max = Math.max(...rows.map(r => Math.abs(r.usd)), 1);
    for (const r of rows) {
      const w = Math.abs(r.usd) / max * 100;
      box.append(el("div.jbar", { title: `${r.trades} Trades · ${r.wins} Gewinner` }, el("span.jl", { text: (label ? label(r.key) : String(r.key)) }),
        el("span.jb", null, el("span", { class: cls(r.usd) || "flat", style: { width: w.toFixed(1) + "%" } })),
        el("span.jv", { text: `${fusd(r.usd)} · ${r.trades}×${r.trades ? " · " + Math.round(r.wins / r.trades * 100) + " %" : ""}`, class: cls(r.usd) })));
    }
    return box;
  }

  // ---------------------------------------------------------------- calendar
  J.calendar = function (body, st) {
    const byDay = Object.fromEntries(st.days_list.map(d => [d.day, d]));
    const days = Object.keys(byDay).sort();
    const first = J.month || (days.length ? days[days.length - 1].slice(0, 7) : RC.fmtIso(RC.now() || Date.now() / 1000).slice(0, 7));
    J.month = first;
    const [Y, M] = first.split("-").map(Number);
    const nav = el("div.jrow", null,
      el("button.btn", { text: "‹", onclick: () => { const d = new Date(Date.UTC(Y, M - 2, 1)); J.month = d.toISOString().slice(0, 7); J.render(); } }),
      el("b", { text: new Date(Date.UTC(Y, M - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }), style: { minWidth: "160px", textAlign: "center" } }),
      el("button.btn", { text: "›", onclick: () => { const d = new Date(Date.UTC(Y, M, 1)); J.month = d.toISOString().slice(0, 7); J.render(); } }));
    body.append(nav);
    const grid = el("div.jcal");
    for (const w of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) grid.append(el("div.jwd", { text: w }));
    const start = new Date(Date.UTC(Y, M - 1, 1)), pad = (start.getUTCDay() + 6) % 7, n = new Date(Date.UTC(Y, M, 0)).getUTCDate();
    for (let i = 0; i < pad; i++) grid.append(el("div.jday.pad"));
    for (let d = 1; d <= n; d++) {
      const key = `${Y}-${String(M).padStart(2, "0")}-${String(d).padStart(2, "0")}`, e = byDay[key];
      const cell = el("div.jday" + (e ? (e.usd > 0 ? ".up" : e.usd < 0 ? ".dn" : ".flat") : "") + (st.days[key] && st.days[key].note ? ".noted" : ""), { onclick: () => J.dayPage(st, key, e) },
        el("span.jn", { text: String(d) }), e ? el("b", { text: fusd(e.usd) }) : null, e ? el("small", { text: `${e.trades} Trade${e.trades === 1 ? "" : "s"} · ${Math.round(e.wins / Math.max(1, e.trades) * 100)} %` }) : null);
      grid.append(cell);
    }
    body.append(grid);
  };
  J.dayPage = function (st, day, e) {
    const trades = st.trades_list.filter(t => t.day === day);
    const f = { note: (st.days[day] && st.days[day].note) || "" };
    TV.dialog({ title: `${RC.fmtDate(TV.epochOfDay ? TV.epochOfDay(day) : Date.parse(day) / 1000 + 43200)} · ${e ? fusd(e.usd) + " · " + e.trades + " trades" : "no trade"}`, width: 640, pad: false,
      body: b => {
        const list = el("table.grid");
        list.append(el("tr", null, ...["Entry", "Side", "Qty", "P&L", "Exit by", "Tags", "Note"].map(h => el("th", { text: h }))));
        for (const t of trades) list.append(el("tr", { style: { cursor: "pointer" }, onclick: () => J.tradePage(st, t) }, el("td", { text: RC.fmtTime(t.t_in, true) }), el("td", { text: t.side === "long" ? "Long" : "Short", class: t.side === "long" ? "side-buy" : "side-sell" }),
          el("td", { text: TV.fq(t.qty) }), el("td", { text: fusd(t.usd), class: cls(t.usd) }), el("td", { text: t.exit_by }), el("td", { text: (t.tags || []).join(", ") }), el("td", { text: t.rating ? "★".repeat(t.rating) : "" })));
        b.append(list);
        const nb = el("div", { style: { padding: "10px 12px" } });
        nb.append(el("div.jsub", { text: "Note for the day" }), el("textarea.jnote", { value: f.note, oninput: ev => { f.note = ev.target.value; } }));
        b.append(nb);
      },
      buttons: [{ label: "Cancel" }, { label: "Save", kind: "pri", action: async () => { try { await TV.post("/api/sessions", { op: "day", id: st.id, day, note: f.note }); J.render(); } catch (err) { TV.toast(err.message, "err"); return false; } } }] });
  };

  // ---------------------------------------------------------------- trades and the trade page
  J.trades = function (body, st) {
    const tbl = el("table.grid.jtrades");
    tbl.append(el("tr", null, ...["Day", "Entry", "Exit", "Side", "Qty", "In", "Out", "Ticks", "P&L", "By", "Duration", "Tags", "Mistakes", "Note"].map(h => el("th", { text: h }))));
    for (const t of st.trades_list.slice().reverse()) {
      const dur = t.t_out - t.t_in;
      tbl.append(el("tr", { style: { cursor: "pointer" }, onclick: () => J.tradePage(st, t) },
        el("td", { text: t.day }), el("td", { text: RC.fmtTime(t.t_in, true) }), el("td", { text: RC.fmtTime(t.t_out, true) }),
        el("td", { text: t.side === "long" ? "Long" : "Short", class: t.side === "long" ? "side-buy" : "side-sell" }), el("td", { text: TV.fq(t.qty) }),
        el("td", { text: TV.fp(t.entry, TV.tickOf(st.inst)) }), el("td", { text: TV.fp(t.exit, TV.tickOf(st.inst)) }), el("td", { text: (t.ticks >= 0 ? "+" : "") + t.ticks, class: cls(t.ticks) }),
        el("td", { text: fusd(t.usd), class: cls(t.usd) }), el("td", { text: t.exit_by }), el("td", { text: dur >= 3600 ? Math.floor(dur / 3600) + "h " + Math.floor(dur % 3600 / 60) + "m" : Math.floor(dur / 60) + "m " + Math.floor(dur % 60) + "s" }),
        el("td", { text: (t.tags || []).join(", ") }), el("td", { text: (t.mistakes || []).join(", "), class: t.mistakes && t.mistakes.length ? "dn" : "" }), el("td", { text: t.rating ? "★".repeat(t.rating) : "" })));
    }
    if (st.trades_list.length === 0) body.append(el("div.jempty", { text: "No trade in this session yet." }));
    body.append(tbl);
  };
  J.tradePage = function (st, t) {
    const f = { note: t.note || "", tags: (t.tags || []).slice(), mistakes: (t.mistakes || []).slice(), rating: t.rating || 0 };
    const tick = TV.tickOf(st.inst);
    const chips = (key, placeholder) => {
      const box = el("div.jchips");
      const draw = () => { box.replaceChildren(...f[key].map(x => el("span.jchip", null, el("span", { text: x }), el("button", { text: "×", onclick: () => { f[key] = f[key].filter(y => y !== x); draw(); } }))), inp); };
      const inp = el("input", { placeholder, list: "jtaglist", onkeydown: e => { if (e.key === "Enter" && inp.value.trim()) { e.preventDefault(); const v = inp.value.trim(); if (!f[key].includes(v)) f[key].push(v); inp.value = ""; draw(); } } });
      draw(); return box;
    };
    const dl = el("datalist", null, ...(st.tags || []).map(x => el("option", { value: x }))); dl.id = "jtaglist";
    const stars = el("div.jstars");
    const drawStars = () => { stars.replaceChildren(...[1, 2, 3, 4, 5].map(i => el("button", { text: i <= f.rating ? "★" : "☆", class: i <= f.rating ? "on" : "", onclick: () => { f.rating = f.rating === i ? 0 : i; drawStars(); } }))); };
    drawStars();
    TV.dialog({ title: `${t.side === "long" ? "Long" : "Short"} ${TV.fq(t.qty)} ${st.inst} · ${t.day} ${RC.fmtTime(t.t_in, true)} → ${RC.fmtTime(t.t_out, true)} · ${fusd(t.usd)}`, width: 760, pad: false,
      body: b => {
        const g = el("div.jtrade");
        const facts = el("div.jfacts", null, ...[["Entry", TV.fp(t.entry, tick)], ["Exit", TV.fp(t.exit, tick)], ["Ticks", (t.ticks >= 0 ? "+" : "") + t.ticks], ["P&L", fusd(t.usd)], ["Exit by", t.exit_by], ["Duration", Math.round((t.t_out - t.t_in) / 60) + " min"]].map(([k, v]) => el("div", null, el("small", { text: k }), el("b", { text: v }))));
        const notes = el("div.jnotes", null, dl,
          el("div.jsub", { text: "Setup tags" }), chips("tags", "Tag, Enter"),
          el("div.jsub", { text: "Mistakes" }), chips("mistakes", "Mistake, Enter"),
          el("div.jsub", { text: "Rating" }), stars,
          el("div.jsub", { text: "Note" }), el("textarea.jnote", { value: f.note, oninput: ev => { f.note = ev.target.value; } }));
        g.append(facts, notes); b.append(g);
      },
      buttons: [{ label: "Show in chart", action: () => { J.close(); if (TV.Trade) { TV.Trade.trace = t; TV.app.goTo(t.t_in); TV.Trade.render(); } } },
                { label: "Moves", action: () => { if (TV.Trade) TV.Trade.tradeLog(t); return false; } },
                { label: "Cancel" },
                { label: "Save", kind: "pri", action: async () => { try { await TV.post("/api/sessions", { op: "trade", id: st.id, trade: t.key, note: f.note, tags: f.tags, mistakes: f.mistakes, rating: f.rating }); J.render(); } catch (err) { TV.toast(err.message, "err"); return false; } } }] });
  };

  window.addEventListener("keydown", e => { if (TV.typing(e) || e.ctrlKey || e.metaKey) return; if ((e.key === "j" || e.key === "J") && !TV.dialogOpen()) { J.toggle(); } if (e.key === "Escape") J.close(); });
})();
