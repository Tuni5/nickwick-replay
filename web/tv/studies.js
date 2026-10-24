/* studies.js - the indicators of tv.html, as TradingView lists them, computed by the server:
 *   Volumenprofil (Session)        per session RTH and overnight apart (or the whole session), up / down volume in
 *                                  TradingView's colours, value area brighter, POC red - /tl/amt (server/amt.py)
 *   Volumenprofil (sichtb. Bereich) the bars in view summed, at the right edge - /tl/profile
 *   Market Profile (TPO)           RTH, 30-minute periods A, B, C ... as letters when there is room, else blocks;
 *                                  value area, POC, IB, single prints, tails - /tl/amt + 30-minute bars
 *   VWAP                           RTH (09:30 NY) or session (18:00 NY), bands at 1 / 2 / 3 standard deviations
 *   Vortag VA/POC, Naked POCs, Initial Balance, Overnight Hoch/Tief, Wochenprofil, Volumen, SMA / EMA
 * Everything is cut at the replay clock like the bars: nothing after it. Whole minutes are exact (their levels),
 * only the forming minute comes from its 1-second bars (STATE.md, the rule). The TPO chart type (per session the
 * overnight volume profile, the RTH TPO and the RTH volume profile side by side) is drawn here too. */
(function () {
  const { el } = TV;
  const TICK = () => TV.TICK;
  const font = px => `${px}px ` + getComputedStyle(document.body).getPropertyValue("--font");

  // ================================================================ the auction data, shared by every pane
  const A = TV.Amt = { inst: null, eth: false, fin: new Map(), cur: null, naked: [], rev: 0, p30: new Map(), curP30: null,
                       busy: false, at: 0, need: true, lastT: null, users: new Map(), err: "" };
  A.want = (chart, from, o) => A.users.set(chart, Object.assign({ from }, o || {}));
  A.drop = chart => A.users.delete(chart);
  A.list = () => { const out = [...A.fin.values()]; if (A.cur) out.push(A.cur); return out.sort((a, b) => a.start - b.start); };
  A.byDate = d => A.fin.get(d) || (A.cur && A.cur.date === d ? A.cur : null);
  A.clear = () => { A.fin.clear(); A.cur = null; A.naked = []; A.p30.clear(); A.curP30 = null; A.rev++; };
  A.frame = function (now) {
    if (!A.users.size || A.busy) return;
    const t = RC.now(); if (t == null) return;
    const playing = RC.state && RC.state.playing;
    if (A.need ? now - A.at > 120 : (playing && now - A.at > 900 && (A.lastT == null || Math.abs(t - A.lastT) >= 1))) A.sync(t);
  };
  A.sync = async function (t) {
    A.busy = true; A.at = performance.now(); A.need = false;
    try {
      const inst = TV.app.inst();
      let eth = false, p30 = false, from = Infinity;
      for (const u of A.users.values()) { eth = eth || !!u.eth; p30 = p30 || !!u.p30; if (u.from != null) from = Math.min(from, u.from); }
      if (inst !== A.inst || (eth && !A.eth)) { A.inst = inst; A.eth = eth; A.clear(); }
      if (A.lastT != null && t < A.lastT) for (const [d, s] of A.fin) if (s.end > t) A.fin.delete(d);
      A.lastT = t;
      const SESS = await RP.sessions(inst); if (!SESS.length) return;
      const ci = idxAt(SESS, t);
      if (!isFinite(from)) from = SESS[Math.max(0, ci)].start;
      const miss = SESS.filter(s => s.end <= t && s.end > from && !A.fin.has(s.date));
      const q = (a, b, nk) => TV.getJSON(`/tl/amt?inst=${encodeURIComponent(inst)}&from=${a}&to=${b}&until=${t}&row=4&naked=${nk}&eth=${A.eth ? 1 : 0}`);
      if (miss.length) {
        for (let i = 0; i < miss.length; i += 12) {           // a few at a time: the first answer draws sooner
          const part = miss.slice(i, i + 12), j = await q(part[0].start, part[part.length - 1].end, 0);
          for (const s of j.sessions) if (s.end <= t) A.fin.set(s.date, s);
          A.rev++; TV.app.redrawAll();
        }
      }
      const cs = SESS[ci];
      if (cs && cs.end > t) { const j = await q(cs.start, cs.end, 20); A.cur = j.sessions.find(x => x.date === cs.date) || null; A.naked = j.naked || []; }
      else { A.cur = null; const j = await q(t - 60, t, 20); A.naked = j.naked || []; }
      if (p30) await syncP30(inst, t, from);
      A.err = ""; A.rev++;
    } catch (e) { A.err = e.message; }
    finally { A.busy = false; TV.app.redrawAll(); }
  };
  async function syncP30(inst, t, from) {                    // 30-minute bars of the regular hours (TPO letters)
    const get = (a, b) => TV.getJSON(`/tl/bars?inst=${encodeURIComponent(inst)}&tf=30&from=${a}&to=${b}&until=${t}`).then(j => j.bars || []);
    const miss = [...A.fin.values()].filter(s => s.rth && s.end > from && !A.p30.has(s.date)).sort((a, b) => a.start - b.start);
    if (miss.length) {
      const bars = await get(miss[0].rth.start, miss[miss.length - 1].rth.end);
      for (const s of miss) A.p30.set(s.date, bars.filter(b => b.t >= s.rth.start && b.t < s.rth.end));
    }
    if (A.cur && A.cur.rth) A.curP30 = { date: A.cur.date, bars: await get(A.cur.rth.start, A.cur.rth.end) };
    else A.curP30 = null;
  }
  A.periods = s => s && (A.p30.get(s.date) || (A.curP30 && A.curP30.date === s.date ? A.curP30.bars : null));
  const idxAt = (S, t) => { let lo = 0, hi = S.length - 1, a = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (S[m].start <= t) { a = m; lo = m + 1; } else hi = m - 1; } return a; };
  RC.on(() => { A.need = true; });

  // the profile of a range (VRVP, the fixed range tool): /tl/profile, cached by range and clock
  const PROF = new Map();
  TV.profile = async function (from, to, until) {
    const inst = TV.app.inst(), key = `${inst}|${Math.round(from)}|${Math.round(to)}|${Math.floor(until)}`;
    if (PROF.has(key)) return PROF.get(key);
    const j = await TV.getJSON(`/tl/profile?inst=${encodeURIComponent(inst)}&from=${from}&to=${to}&until=${until}`);
    const out = j.levels && j.levels.length ? { levels: j.levels.map(l => [l[0], l[1], (l[2] || 0) - (l[3] || 0)]), poc: j.poc, vah: j.vah, val: j.val, total: j.total } : null;
    PROF.set(key, out); if (PROF.size > 200) PROF.delete(PROF.keys().next().value);
    return out;
  };

  // ================================================================ drawing helpers
  function line(ctx, x0, x1, y, color, dash, w) {
    if (y == null || x0 == null || x1 == null) return;
    ctx.strokeStyle = color; ctx.lineWidth = w || 1; ctx.setLineDash(dash || []);
    const yy = Math.round(y) + ((w || 1) % 2 ? 0.5 : 0);
    ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke(); ctx.setLineDash([]);
  }
  function tag(ctx, x, y, text, color, align) {
    if (y == null || x == null) return;
    ctx.font = font(11); ctx.fillStyle = color; ctx.textAlign = align || "left"; ctx.textBaseline = "bottom"; ctx.fillText(text, x, y - 2); ctx.textAlign = "left";
  }
  const dashOf = s => s === "dashed" ? [6, 4] : s === "dotted" ? [2, 3] : [];
  /* a volume profile: levels [[price, vol, delta]] -> rows of >= minPx, from x0 towards dir (+1 right, -1 left),
     wmax at the largest row; up / down volume in two colours, value area brighter */
  function paintVp(c, ctx, vp, x0, wmax, dir, P, minPx, pass) {
    pass = pass || "both";                                   // "bars" below the candles, "numbers" above them
    if (!vp || !vp.levels || !vp.levels.length || x0 == null || wmax < 6) return null;
    const tk = TICK(), y0p = c.yOf(vp.poc), y1p = c.yOf(vp.poc + tk); if (y0p == null || y1p == null) return null;
    const pxTick = Math.abs(y0p - y1p) || 1, g = Math.max(1, Math.ceil((minPx || 2) / pxTick)), rows = new Map();
    for (const [p, v, d] of vp.levels) { const k = Math.floor(Math.round(p / tk) / g), r = rows.get(k) || [0, 0]; r[0] += v; r[1] += d || 0; rows.set(k, r); }
    let max = 0; for (const r of rows.values()) max = Math.max(max, r[0]);
    const split = P.split !== false, rowH = pxTick * g;
    const numbers = pass !== "bars" && P.numbers && P.numbers !== "off" && rowH >= 9, bars = pass !== "numbers";
    if (numbers) { ctx.font = `${Math.max(9, Math.min(12, Math.floor(rowH) - 2))}px Consolas, "Cascadia Mono", Menlo, monospace`; ctx.textBaseline = "middle"; }
    for (const [k, [v, d]] of rows) {
      const p0 = k * g * tk, p1 = p0 + g * tk, ya = c.yOf(p1), yb = c.yOf(p0); if (ya == null || yb == null) continue;
      const inVa = vp.val != null && p1 > vp.val + 1e-9 && p0 <= vp.vah + 1e-9;
      const len = Math.max(1, v / max * wmax), h = Math.max(1, yb - ya - (yb - ya > 3 ? 1 : 0));
      if (bars && split) {
        const up = Math.max(0, Math.min(v, (v + d) / 2)), lu = len * (v ? up / v : 0.5);
        ctx.fillStyle = inVa ? P.vaUp : P.up; ctx.fillRect(dir > 0 ? x0 : x0 - lu, ya, lu, h);
        ctx.fillStyle = inVa ? P.vaDown : P.down; ctx.fillRect(dir > 0 ? x0 + lu : x0 - len, ya, len - lu, h);
      } else if (bars) { ctx.fillStyle = inVa ? P.vaUp : P.up; ctx.fillRect(dir > 0 ? x0 : x0 - len, ya, len, h); }
      if (numbers) {
        const txt = (P.numbers === "short" ? TV.fv(v) : String(v)) + (P.numDelta ? ` ${d >= 0 ? "+" : ""}${P.numbers === "short" ? TV.fv(d) : d}` : "");
        ctx.textAlign = dir > 0 ? "left" : "right"; ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.75)"; ctx.lineJoin = "round";
        const xa = (dir > 0 ? Math.max(x0, 0) : Math.min(x0, c.pane().w)) + dir * 4;     // at the profile's edge, or the pane's when that lies outside
        ctx.strokeText(txt, xa, (ya + yb) / 2 + 0.5); ctx.fillStyle = "#e6e6e6"; ctx.fillText(txt, xa, (ya + yb) / 2 + 0.5);
      }
    }
    ctx.textAlign = "left";
    return { g, max };
  }

  // ================================================================ the indicators
  const VP_COLORS = { up: "rgba(41,98,255,0.30)", down: "rgba(251,192,45,0.30)", vaUp: "rgba(41,98,255,0.72)", vaDown: "rgba(251,192,45,0.72)" };
  const VP_GREY = { up: "rgba(120,123,134,0.45)", down: "rgba(120,123,134,0.45)", vaUp: "rgba(178,181,190,0.78)", vaDown: "rgba(178,181,190,0.78)" };
  const NUMBERS_SCHEMA = [{ key: "numbers", label: "Zahlen auf den Zeilen", type: "select", str: true, options: [["exact", "genau"], ["short", "gekürzt (2K)"], ["off", "aus"]], with: [{ key: "numDelta", type: "select", options: [[0, "Volumen"], [1, "Volumen und Delta"]] }] }];
  const COLOR_SCHEMA = [{ head: "Farben" }, { key: "split", label: "Auf-/Ab-Volumen getrennt", type: "bool" },
    { key: "vaUp", label: "Value Area: auf / ab", type: "color", with: [{ key: "vaDown", type: "color" }] },
    { key: "up", label: "Außerhalb VA: auf / ab", type: "color", with: [{ key: "down", type: "color" }] },
    { key: "poc", label: "POC", type: "color", with: [{ key: "pocW", type: "select", options: [[1, "1px"], [2, "2px"], [3, "3px"]] }] }];
  const PERIOD_COLORS = ["#2962ff", "#00bcd4", "#089981", "#4caf50", "#8bc34a", "#cddc39", "#ffeb3b", "#ffc107", "#ff9800", "#ff5722", "#f23645", "#e91e63", "#9c27b0", "#673ab7"];
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

  const DEFS = TV.STUDY_DEFS = {
    vol: {
      name: "Volumen", group: "Volumen", short: () => "Volumen",
      defaults: { up: "rgba(8,153,129,0.5)", down: "rgba(242,54,69,0.5)", ma: false, maLen: 20, maColor: "#2962ff", height: 18 },
      schema: [{ key: "up", label: "Steigend / fallend", type: "color", with: [{ key: "down", type: "color" }] },
               { key: "height", label: "Höhe (% des Charts)", type: "num", min: 5, max: 60 },
               { key: "ma", label: "Gleitender Durchschnitt", type: "bool", with: [{ key: "maLen", type: "num", min: 2, max: 400 }, { key: "maColor", type: "color" }] }],
      make: (S, st) => volStudy(S, st),
    },
    ma: {
      name: "Gleitender Durchschnitt", group: "Trend", short: p => `${p.kind} ${p.len}`,
      defaults: { kind: "EMA", len: 20, color: "#2962ff", width: 2 },
      schema: [{ key: "kind", label: "Typ", type: "select", str: true, options: [["SMA", "SMA (einfach)"], ["EMA", "EMA (exponentiell)"]] },
               { key: "len", label: "Länge", type: "num", min: 1, max: 1000 }, { key: "color", label: "Farbe", type: "color", with: [{ key: "width", type: "select", options: [[1, "1px"], [2, "2px"], [3, "3px"], [4, "4px"]] }] }],
      make: (S, st) => maStudy(S, st),
    },
    svp: {
      name: "Volumenprofil (Session)", group: "Volumenprofil", short: p => `VP Session · ${{ rthon: "RTH + Nacht", rth: "RTH", eth: "ganze Session" }[p.split3]}`,
      defaults: Object.assign({ split3: "eth", width: 42, minPx: 2, split: true, poc: "#f23645", pocW: 2, pocExtend: false, vaLines: false, vaLine: "#2962ff", onDim: true, numbers: "exact", numDelta: 0 }, VP_GREY),
      schema: [{ key: "split3", label: "Aufteilung", type: "select", str: true, options: [["rthon", "RTH und Nacht getrennt"], ["rth", "nur RTH (09:30–16:00 NY)"], ["eth", "ganze Session (18:00–17:00)"]] },
               { key: "width", label: "Breite (% der Session)", type: "num", min: 5, max: 100 }, { key: "minPx", label: "Zeilenhöhe min. (px)", type: "num", min: 1, max: 20 },
               { key: "onDim", label: "Nacht abgeschwächt", type: "bool" }, { key: "pocExtend", label: "POC nach rechts verlängern", type: "bool" },
               { key: "vaLines", label: "VAH / VAL als Linien", type: "bool", with: [{ key: "vaLine", type: "color" }]}].concat(NUMBERS_SCHEMA, COLOR_SCHEMA),
      eth: p => p.split3 === "eth",
      make: (S, st) => svpStudy(S, st),
    },
    vrvp: {
      name: "Volumenprofil (sichtbarer Bereich)", group: "Volumenprofil", short: () => "VRVP",
      defaults: Object.assign({ width: 28, rows: 0, side: "right", split: true, poc: "#f23645", pocW: 1, pocLine: true, numbers: "exact", numDelta: 0 }, VP_COLORS),
      schema: [{ key: "rows", label: "Zeilen (0 = fein)", type: "num", min: 0, max: 400 }, { key: "width", label: "Breite (% des Charts)", type: "num", min: 5, max: 100 },
               { key: "side", label: "Platzierung", type: "select", str: true, options: [["right", "rechts"], ["left", "links"]] },
               { key: "pocLine", label: "POC über den Chart", type: "bool" }].concat(NUMBERS_SCHEMA, COLOR_SCHEMA),
      make: (S, st) => vrvpStudy(S, st),
    },
    tpo: {
      name: "Market Profile (TPO)", group: "Volumenprofil", short: () => "TPO RTH",
      defaults: { mode: "auto", width: 45, colors: "period", block: "#9c9ff2", vaHi: true, poc: "#f23645", vaLines: true, vaLine: "rgba(255,255,255,0.55)", ib: true, ibColor: "#ff9800", singles: true, tails: true, row: 4 },
      schema: [{ key: "mode", label: "Darstellung", type: "select", str: true, options: [["auto", "Buchstaben, wenn Platz ist"], ["letters", "immer Buchstaben"], ["blocks", "Blöcke"]] },
               { key: "width", label: "Breite (% der RTH)", type: "num", min: 10, max: 100 },
               { key: "colors", label: "Farben", type: "select", str: true, options: [["period", "je Periode"], ["mono", "einfarbig"]], with: [{ key: "block", type: "color" }] },
               { key: "vaHi", label: "Value Area hervorheben", type: "bool" }, { key: "poc", label: "POC", type: "color" },
               { key: "vaLines", label: "VAH / VAL als Linien", type: "bool", with: [{ key: "vaLine", type: "color" }] },
               { key: "ib", label: "Initial Balance markieren", type: "bool", with: [{ key: "ibColor", type: "color" }] },
               { key: "singles", label: "Single Prints (magenta)", type: "bool" }, { key: "tails", label: "Tails (orange)", type: "bool" }],
      p30: true,
      make: (S, st) => tpoStudy(S, st),
    },
    vwap: {
      name: "VWAP", group: "Trend", short: p => `VWAP ${p.anchor === "eth" ? "Session" : "RTH"}`,
      defaults: { anchor: "rth", color: "#2962ff", width: 2, b1: true, b2: false, b3: false, m1: 1, m2: 2, m3: 3, bandColor: "#4caf50", fill: true, fillColor: "rgba(76,175,80,0.06)", label: true },
      schema: [{ key: "anchor", label: "Anker", type: "select", str: true, options: [["rth", "RTH (ab 09:30 NY)"], ["eth", "Session (ab 18:00 NY)"]] },
               { key: "color", label: "VWAP", type: "color", with: [{ key: "width", type: "select", options: [[1, "1px"], [2, "2px"], [3, "3px"]] }] },
               { key: "b1", label: "Band 1 (× σ)", type: "bool", with: [{ key: "m1", type: "num", min: 0.1, max: 10, step: 0.1 }] },
               { key: "b2", label: "Band 2 (× σ)", type: "bool", with: [{ key: "m2", type: "num", min: 0.1, max: 10, step: 0.1 }] },
               { key: "b3", label: "Band 3 (× σ)", type: "bool", with: [{ key: "m3", type: "num", min: 0.1, max: 10, step: 0.1 }] },
               { key: "bandColor", label: "Bänder", type: "color" }, { key: "fill", label: "Füllung Band 1", type: "bool", with: [{ key: "fillColor", type: "color" }] },
               { key: "label", label: "Wert auf der Preisachse", type: "bool" }],
      eth: p => p.anchor === "eth",
      make: (S, st) => vwapStudy(S, st),
    },
    prior: {
      name: "Vortag VAH / VAL / POC", group: "Level", short: () => "Vortag",
      defaults: { va: "#5b9cf6", poc: "#f23645", style: "solid", labels: true, extendAll: false },
      schema: [{ key: "va", label: "VAH / VAL", type: "color" }, { key: "poc", label: "POC", type: "color" },
               { key: "style", label: "Linienart", type: "select", str: true, options: [["solid", "durchgezogen"], ["dashed", "gestrichelt"], ["dotted", "gepunktet"]] },
               { key: "labels", label: "Beschriftung", type: "bool" }],
      make: (S, st) => priorStudy(S, st),
    },
    npoc: {
      name: "Naked POCs", group: "Level", short: () => "nPOC",
      defaults: { color: "#fbc02d", style: "dashed", touched: true, labels: true },
      schema: [{ key: "color", label: "Farbe", type: "color" }, { key: "style", label: "Linienart", type: "select", str: true, options: [["solid", "durchgezogen"], ["dashed", "gestrichelt"], ["dotted", "gepunktet"]] },
               { key: "touched", label: "Gehandelte bis zum Treffer zeigen", type: "bool" }, { key: "labels", label: "Beschriftung", type: "bool" }],
      make: (S, st) => npocStudy(S, st),
    },
    ib: {
      name: "Initial Balance", group: "Level", short: () => "IB",
      defaults: { color: "#b2b5be", style: "dashed", ext: false, extColor: "#787b86", fill: false, fillColor: "rgba(255,152,0,0.06)" },
      schema: [{ key: "color", label: "IBH / IBL", type: "color" }, { key: "style", label: "Linienart", type: "select", str: true, options: [["solid", "durchgezogen"], ["dashed", "gestrichelt"], ["dotted", "gepunktet"]] },
               { key: "ext", label: "Extensions 1,5× / 2× / 3×", type: "bool", with: [{ key: "extColor", type: "color" }] },
               { key: "fill", label: "IB-Bereich füllen", type: "bool", with: [{ key: "fillColor", type: "color" }] }],
      make: (S, st) => ibStudy(S, st),
    },
    onhl: {
      name: "Overnight Hoch / Tief", group: "Level", short: () => "ON H/L",
      defaults: { color: "#9598a1", style: "dotted", poc: false, pocColor: "#ff9800" },
      schema: [{ key: "color", label: "Farbe", type: "color" }, { key: "style", label: "Linienart", type: "select", str: true, options: [["solid", "durchgezogen"], ["dashed", "gestrichelt"], ["dotted", "gepunktet"]] },
               { key: "poc", label: "Overnight-POC", type: "bool", with: [{ key: "pocColor", type: "color" }] }],
      make: (S, st) => onStudy(S, st),
    },
    week: {
      name: "Wochenprofil", group: "Volumenprofil", short: () => "Woche",
      defaults: { color: "rgba(41,98,255,0.16)", va: "rgba(41,98,255,0.34)", poc: "rgba(242,54,69,0.7)", width: 60 },
      schema: [{ key: "va", label: "Value Area", type: "color" }, { key: "color", label: "Außerhalb", type: "color" }, { key: "poc", label: "POC", type: "color" },
               { key: "width", label: "Breite (% der Woche)", type: "num", min: 10, max: 100 }],
      eth: () => true,
      make: (S, st) => weekStudy(S, st),
    },
  };

  // ---- the panes' own layer (session breaks, RTH shading, the TPO chart type, the clock line)
  function baseLayer(S) {
    const c = S.c;
    return {
      draw(ctx, w, h) {
        const set = TV.app.settings, list = A.list(); if (!c.BARS.length) return;
        const vr = c.visibleT(); if (!vr) return;
        let lastLab = -1e9;
        for (const s of list) {
          if (s.end < vr[0] || s.start > vr[1]) continue;
          if (set.rthShade && s.rth && c.tf < 1440) { const a = c.xOf(s.rth.start), b = c.xOf(s.rth.end); if (a != null && b != null) { ctx.fillStyle = "rgba(255,255,255,0.022)"; ctx.fillRect(a, 0, b - a, h); } }
          if (set.breaks && c.tf < 1440) {
            const xs = c.xOf(s.start);
            if (xs != null && xs > 0) {
              ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(Math.round(xs) + 0.5, 0); ctx.lineTo(Math.round(xs) + 0.5, h); ctx.stroke(); ctx.setLineDash([]);
              if (xs - lastLab > 80) { lastLab = xs; ctx.font = font(11); ctx.fillStyle = "rgba(149,152,161,0.8)"; ctx.fillText(new Intl.DateTimeFormat("de-AT", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "2-digit" }).format(new Date(s.date + "T12:00:00Z")).replace(".,", ""), xs + 5, h - 6); }
            }
          }
        }
        if (c.cfg.type === "tpo") profileView(c, ctx, w, h, list, vr);
      },
    };
  }

  // ---------------------------------------------------------------- volume
  function volStudy(S, st) {
    const c = S.c, p = st.p;
    const ser = c.chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    let ma = null;
    const scale = () => c.chart.priceScale("vol").applyOptions({ scaleMargins: { top: 1 - p.height / 100, bottom: 0 }, visible: false });
    scale();
    const pt = b => ({ time: b.t, value: b.v, color: b.c >= b.o ? p.up : p.down });
    const maData = () => { const B = c.BARS, out = []; let s = 0; for (let i = 0; i < B.length; i++) { s += B[i].v; if (i >= p.maLen) s -= B[i - p.maLen].v; if (i >= p.maLen - 1) out.push({ time: B[i].t, value: s / p.maLen }); } return out; };
    const all = () => { ser.setData(c.BARS.map(pt)); if (ma) ma.setData(maData()); };
    const setMa = () => { if (p.ma && !ma) ma = c.chart.addLineSeries({ priceScaleId: "vol", color: p.maColor, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
                          if (!p.ma && ma) { c.chart.removeSeries(ma); ma = null; } if (ma) ma.applyOptions({ color: p.maColor }); };
    setMa(); all();
    return {
      onData(kind, k) { if (kind === "tail" && !ma) { try { for (let i = Math.max(0, k); i < c.BARS.length; i++) ser.update(pt(c.BARS[i])); } catch (e) { all(); } } else all(); },
      vals(i) { const b = c.BARS[i]; return b ? [{ text: TV.fv(b.v), color: TV.rgba(b.c >= b.o ? p.up : p.down, 1) }] : []; },
      changed() { scale(); setMa(); all(); },
      visible(on) { ser.applyOptions({ visible: on }); if (ma) ma.applyOptions({ visible: on }); },
      destroy() { c.chart.removeSeries(ser); if (ma) c.chart.removeSeries(ma); },
    };
  }
  // ---------------------------------------------------------------- moving averages
  function maStudy(S, st) {
    const c = S.c, p = st.p;
    const ser = c.chart.addLineSeries({ color: p.color, lineWidth: p.width, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
    let vals = [];
    const calc = () => {
      const B = c.BARS, n = p.len, out = []; vals = new Array(B.length).fill(null);
      if (p.kind === "SMA") { let s = 0; for (let i = 0; i < B.length; i++) { s += B[i].c; if (i >= n) s -= B[i - n].c; if (i >= n - 1) { vals[i] = s / n; out.push({ time: B[i].t, value: vals[i] }); } } }
      else { const k = 2 / (n + 1); let e = null, s = 0; for (let i = 0; i < B.length; i++) { if (i < n) { s += B[i].c; if (i === n - 1) e = s / n; } else e = B[i].c * k + e * (1 - k); if (e != null) { vals[i] = e; out.push({ time: B[i].t, value: e }); } } }
      ser.setData(out);
    };
    calc();
    return {
      onData() { calc(); },
      vals(i) { return vals[i] != null ? [{ text: TV.fp(vals[i], c.tick()), color: p.color }] : []; },
      changed() { ser.applyOptions({ color: p.color, lineWidth: p.width }); calc(); },
      visible(on) { ser.applyOptions({ visible: on }); },
      destroy() { c.chart.removeSeries(ser); },
    };
  }
  // ---------------------------------------------------------------- session volume profile
  function svpStudy(S, st) {
    const c = S.c, p = st.p;
    const draw = pass => (ctx, w, h) => {
        if (!st.on || c.cfg.type === "tpo") return;
        const vr = c.visibleT(); if (!vr) return;
        for (const s of A.list()) {
          if (s.end < vr[0] || s.start > vr[1]) continue;
          const parts = p.split3 === "eth" ? [[s.eth, 1]] : p.split3 === "rth" ? [[s.rth, 1]] : [[s.on, p.onDim ? 0.6 : 1], [s.rth, 1]];
          for (const [part, dim] of parts) {
            if (!part || !part.vp) continue;
            const x0 = c.xOf(part.start), x1 = c.xOf(part.end); if (x0 == null || x1 == null || x1 - x0 < 30 || x1 < 0 || x0 > w) continue;
            ctx.save(); ctx.globalAlpha = dim;
            const r = paintVp(c, ctx, part.vp, x0, (x1 - x0) * p.width / 100, 1, p, p.minPx, pass);
            ctx.restore();
            if (!r || pass === "numbers") continue;
            st._g = r.g;
            const tk = TICK(), xe = p.pocExtend ? (part.developing ? c.xOf(c.lastT) : w) : x1;
            line(ctx, x0, xe, c.yOf(part.vp.poc + tk / 2), TV.rgba(p.poc, TV.alphaOf(p.poc) * dim), [], p.pocW);
            if (p.vaLines) { line(ctx, x0, x1, c.yOf(part.vp.vah + tk), p.vaLine, [4, 3]); line(ctx, x0, x1, c.yOf(part.vp.val), p.vaLine, [4, 3]); }
          }
        }
    };
    const layer = c.addLayer("bottom", { draw: draw("bars") }), layer2 = c.addLayer("normal", { draw: draw("numbers") });
    return { destroy() { c.removeLayer(layer); c.removeLayer(layer2); },
             vals() { const s = A.cur || A.list().slice(-1)[0]; const part = s && (p.split3 === "eth" ? s.eth : s.rth || (p.split3 === "rthon" ? s.on : null));
                      return part && part.vp ? [{ text: "POC " + TV.fp(part.vp.poc, c.tick()), color: p.poc }, { text: `Zeile ${st._g || 1} Tick${(st._g || 1) > 1 ? "s" : ""}`, color: "var(--muted)" }] : []; } };
  }
  // ---------------------------------------------------------------- visible range volume profile
  function vrvpStudy(S, st) {
    const c = S.c, p = st.p;
    let vp = null, key = "", busy = false, at = 0, wantAt = 0;
    async function load(force) {
      const vr = c.visibleT(), t = c.lastT; if (!vr || t == null || busy) return;
      const k = `${Math.round(vr[0])}|${Math.round(vr[1])}|${Math.floor(t)}|${TV.app.inst()}`;
      if (k === key && !force) return;
      busy = true; at = performance.now();
      try { vp = await TV.profile(vr[0], Math.min(vr[1], t + 1), t); key = k; } catch (e) { vp = null; }
      busy = false; c.redraw();
    }
    const layer = c.addLayer("bottom", {
      draw(ctx, w) {
        if (!st.on || !vp) return;
        let lv = vp.levels;
        if (p.rows > 0) {                                        // a fixed number of rows over the range
          const lo = lv[0][0], hi = lv[lv.length - 1][0], tk = TICK(), n = Math.max(1, Math.ceil((hi - lo + tk) / tk / p.rows)), m = new Map();
          for (const [pr, v, d] of lv) { const kk = Math.floor((pr - lo) / tk / n), q = m.get(kk) || [lo + kk * n * tk, 0, 0]; q[1] += v; q[2] += d; m.set(kk, q); }
          lv = [...m.values()];
          const x0 = p.side === "right" ? w : 0, wmax = w * p.width / 100;
          paintRows(c, ctx, lv, n * tk, vp, x0, wmax, p.side === "right" ? -1 : 1, p);
        } else paintVp(c, ctx, vp, p.side === "right" ? w : 0, w * p.width / 100, p.side === "right" ? -1 : 1, p, 2, "bars");
        if (p.pocLine) line(ctx, 0, w, c.yOf(vp.poc + TICK() / 2), p.poc, [], p.pocW);
      },
    });
    const layer2 = c.addLayer("normal", { draw(ctx, w) { if (st.on && vp && !(p.rows > 0)) paintVp(c, ctx, vp, p.side === "right" ? w : 0, w * p.width / 100, p.side === "right" ? -1 : 1, p, 2, "numbers"); } });
    return {
      onRange() { wantAt = performance.now() + 220; },
      onData(kind) { if (kind !== "tail") wantAt = performance.now() + 50; },
      frame(now) { if (wantAt && now >= wantAt) { wantAt = 0; load(); } else if (RC.state && RC.state.playing && now - at > 1500) load(); },
      changed() { c.redraw(); },
      vals() { return vp ? [{ text: "POC " + TV.fp(vp.poc, c.tick()), color: p.poc }, { text: TV.fv(vp.total), color: "var(--text2)" }] : []; },
      destroy() { c.removeLayer(layer); c.removeLayer(layer2); },
    };
  }
  function paintRows(c, ctx, rows, rowH, vp, x0, wmax, dir, P) {   // rows of a fixed height (VRVP "Zeilen")
    let max = 0; for (const r of rows) max = Math.max(max, r[1]);
    for (const [p0, v, d] of rows) {
      const ya = c.yOf(p0 + rowH), yb = c.yOf(p0); if (ya == null || yb == null) continue;
      const inVa = p0 + rowH > vp.val && p0 <= vp.vah, len = Math.max(1, v / max * wmax), h = Math.max(1, yb - ya - 1);
      const up = Math.max(0, Math.min(v, (v + d) / 2)), lu = P.split !== false ? len * up / (v || 1) : len;
      ctx.fillStyle = inVa ? P.vaUp : P.up; ctx.fillRect(dir > 0 ? x0 : x0 - lu, ya, lu, h);
      if (P.split !== false) { ctx.fillStyle = inVa ? P.vaDown : P.down; ctx.fillRect(dir > 0 ? x0 + lu : x0 - len, ya, len - lu, h); }
    }
  }
  // ---------------------------------------------------------------- market profile (TPO) on the candles
  function tpoRows(s, row) {                                       // letters per row from the 30-minute bars
    const bars = A.periods(s); if (!bars || !s.rth) return null;
    const rp = row * TICK(), rows = new Map();
    for (const b of bars) {
      const k = Math.round((b.t - s.rth.start) / 1800);
      for (let r = Math.floor(b.l / rp + 1e-9); r <= Math.floor(b.h / rp + 1e-9); r++) { const a = rows.get(r) || []; a.push(k); rows.set(r, a); }
    }
    return rows;
  }
  function paintTpo(c, ctx, s, x0, wmax, p, opts) {
    const r0 = s.rth, tp = r0 && r0.tpo; if (!tp || !tp.levels.length || x0 == null) return 0;
    const rp = tp.row * TICK(), ya = c.yOf(tp.poc + rp), yb = c.yOf(tp.poc); if (ya == null || yb == null) return 0;
    const rowPx = Math.abs(yb - ya);
    let max = 0; for (const [, n] of tp.levels) max = Math.max(max, n);
    const inVa = pr => pr >= tp.val - 1e-9 && pr <= tp.vah + 1e-9;
    const rows = p.mode !== "blocks" ? tpoRows(s, tp.row) : null;
    const letterW = Math.max(5, Math.min(11, rowPx * 0.82));
    const letters = rows && (p.mode === "letters" || (rowPx >= 9 && wmax / max >= letterW * 0.95));
    const unit = letters ? Math.min(letterW, wmax / max) : Math.min(8, wmax / max);
    const col = k => p.colors === "mono" ? p.block : PERIOD_COLORS[k % PERIOD_COLORS.length];
    if (letters) {
      ctx.font = `600 ${Math.max(8, Math.min(12, Math.floor(rowPx * 0.8)))}px ` + "Consolas, 'Cascadia Mono', Menlo, monospace";
      ctx.textBaseline = "middle"; ctx.textAlign = "center";
      for (const [r, ks] of rows) {
        const y0 = c.yOf((r + 1) * rp), y1 = c.yOf(r * rp); if (y0 == null || y1 == null) continue;
        const va = !p.vaHi || inVa(r * rp);
        ks.forEach((k, i) => { ctx.fillStyle = TV.rgba(col(k), va ? 1 : 0.42); ctx.fillText(LETTERS[k % LETTERS.length], x0 + unit * (i + 0.5), (y0 + y1) / 2 + 0.5); });
      }
      ctx.textAlign = "left";
    } else {
      for (const [pr, n] of tp.levels) {
        const y0 = c.yOf(pr + rp), y1 = c.yOf(pr); if (y0 == null || y1 == null) continue;
        const va = !p.vaHi || inVa(pr), ks = rows && rows.get(Math.round(pr / rp));
        if (ks && p.colors !== "mono") ks.forEach((k, i) => { ctx.fillStyle = TV.rgba(col(k), va ? 0.85 : 0.38); ctx.fillRect(x0 + i * unit, y0, Math.max(1, unit - (unit > 3 ? 1 : 0)), Math.max(1, y1 - y0 - (y1 - y0 > 3 ? 1 : 0))); });
        else { ctx.fillStyle = TV.rgba(p.block, va ? 0.75 : 0.32); ctx.fillRect(x0, y0, n * unit, Math.max(1, y1 - y0 - (y1 - y0 > 3 ? 1 : 0))); }
      }
    }
    const wT = max * unit;
    line(ctx, x0, x0 + wT, c.yOf(tp.poc + rp / 2), p.poc, [], 1.5);
    if (p.vaLines) { line(ctx, x0, x0 + wT, c.yOf(tp.vah + rp), p.vaLine, [4, 3]); line(ctx, x0, x0 + wT, c.yOf(tp.val), p.vaLine, [4, 3]); }
    const mark = (lo, hi, color, dx) => { const y0 = c.yOf(hi), y1 = c.yOf(lo); if (y0 == null || y1 == null) return; ctx.fillStyle = color; ctx.fillRect(x0 - dx, y0, 3, y1 - y0); };
    if (p.singles) for (const [lo, hi] of tp.singles) mark(lo, hi, "#e040fb", 5);
    if (p.tails) { if (tp.tails.top) mark(tp.tails.top[0], tp.tails.top[1], "#ff9800", 5); if (tp.tails.bottom) mark(tp.tails.bottom[0], tp.tails.bottom[1], "#ff9800", 5); }
    if (p.ib && r0.ib) mark(r0.ib.low, r0.ib.high, p.ibColor, 9);
    return wT;
  }
  function tpoStudy(S, st) {
    const c = S.c, p = st.p;
    const layer = c.addLayer("bottom", {
      draw(ctx, w) {
        if (!st.on || c.cfg.type === "tpo") return;
        const vr = c.visibleT(); if (!vr) return;
        for (const s of A.list()) {
          const r0 = s.rth; if (!r0 || !r0.tpo || s.end < vr[0] || s.start > vr[1]) continue;
          const a = c.xOf(r0.start), b = c.xOf(r0.end); if (a == null || b == null || b - a < 40 || b < 0 || a > w) continue;
          let max = 0; for (const [, n] of r0.tpo.levels) max = Math.max(max, n);
          const rpx = Math.abs(c.yOf(r0.tpo.poc) - c.yOf(r0.tpo.poc + r0.tpo.row * TICK()));
          const lw = Math.max(5, Math.min(11, rpx * 0.82));
          if (r0.developing) {                                   // still forming: in the free space right of the newest bar
            const x0 = (c.xOf(c.lastT) ?? b) + 14, room = Math.min(w - x0 - 6, (b - a) * p.width / 100);
            if (room > 16) paintTpo(c, ctx, s, x0, room, p);
            continue;
          }
          const wmax = (b - a) * p.width / 100, unit = Math.min(p.mode === "blocks" ? 8 : Math.max(lw, 8), wmax / max);
          paintTpo(c, ctx, s, b - max * unit - 2, max * unit, p);
        }
      },
    });
    return { destroy() { c.removeLayer(layer); }, vals() { const s = A.cur && A.cur.rth ? A.cur : A.list().slice(-1)[0]; const tp = s && s.rth && s.rth.tpo; return tp ? [{ text: `POC ${TV.fp(tp.poc, c.tick())}  VA ${TV.fp(tp.val, c.tick())}–${TV.fp(tp.vah + tp.row * TICK(), c.tick())}`, color: "var(--text2)" }] : []; } };
  }
  // ---- the TPO chart type: per session overnight VP | RTH TPO (split by period while developing) | RTH VP
  const TPO_VIEW = { mode: "auto", colors: "period", block: "#d1d4dc", vaHi: true, poc: "#f23645", vaLines: true, vaLine: "rgba(255,255,255,0.55)", ib: true, ibColor: "#ff9800", singles: true, tails: true };
  function profileView(c, ctx, w, h, list, vr) {
    const now = c.lastT, tk = TICK();
    const grey = { up: "rgba(149,152,161,0.22)", down: "rgba(149,152,161,0.22)", vaUp: "rgba(149,152,161,0.45)", vaDown: "rgba(149,152,161,0.45)", split: false };
    for (const s of list) {
      if (s.end < vr[0] || s.start > vr[1]) continue;
      const on = s.on, r0 = s.rth;
      if (on && on.vp) { const a = c.xOf(on.start), b = c.xOf(on.end); if (a != null && b != null && b - a > 30) { paintVp(c, ctx, on.vp, a, (b - a) * 0.45, 1, grey, 2); line(ctx, a, a + (b - a) * 0.45, c.yOf(on.vp.poc + tk / 2), "rgba(242,54,69,0.6)", [], 1); } }
      if (!r0 || !r0.tpo) continue;
      const a = c.xOf(r0.start), b = c.xOf(r0.end); if (a == null || b == null || b - a < 20) continue;
      const W = b - a, tp = r0.tpo, rp = tp.row * tk;
      if (r0.developing) {                                        // split: every 30-minute period in its own column
        const bars = A.periods(s) || c.BARS.filter(x => x.t >= r0.start && x.t < r0.end);
        const rowPx = Math.abs(c.yOf(0) - c.yOf(rp));
        for (const bb of bars) {
          if (bb.t > now) continue;
          const k = Math.round((bb.t - r0.start) / 1800), x0 = c.xOf(bb.t), x1 = c.xOf(bb.t + 1800); if (x0 == null || x1 == null) continue;
          const colr = PERIOD_COLORS[k % PERIOD_COLORS.length], cw = x1 - x0;
          for (let r = Math.floor(bb.l / rp + 1e-9); r <= Math.floor(bb.h / rp + 1e-9); r++) {
            const y0 = c.yOf((r + 1) * rp), y1 = c.yOf(r * rp); if (y0 == null || y1 == null) continue;
            const va = r * rp >= tp.val - 1e-9 && r * rp <= tp.vah + 1e-9;
            if (rowPx >= 9 && cw >= 8) { ctx.font = `600 ${Math.min(12, Math.floor(rowPx * 0.8))}px Consolas, Menlo, monospace`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = TV.rgba(colr, va ? 1 : 0.45); ctx.fillText(LETTERS[k % LETTERS.length], (x0 + x1) / 2, (y0 + y1) / 2 + 0.5); ctx.textAlign = "left"; }
            else { ctx.fillStyle = TV.rgba(colr, va ? 0.85 : 0.4); ctx.fillRect(x0 + 1, y0, Math.max(1, cw - 2), Math.max(1, y1 - y0 - 1)); }
          }
        }
        const xr = c.xOf(Math.min(now, r0.end));
        line(ctx, a, xr, c.yOf(tp.poc + rp / 2), "#f23645", [], 1.4);
        line(ctx, a, xr, c.yOf(tp.vah + rp), "rgba(255,255,255,0.55)", [4, 3]); line(ctx, a, xr, c.yOf(tp.val), "rgba(255,255,255,0.55)", [4, 3]);
        if (r0.vp) paintVp(c, ctx, r0.vp, b + 4, W * 0.4, 1, Object.assign({ split: true }, VP_COLORS), 2);
      } else {
        const wT = paintTpo(c, ctx, s, a, W * 0.55, TPO_VIEW);
        if (r0.vp) { const x0 = a + Math.max(wT + 8, W * 0.58); paintVp(c, ctx, r0.vp, x0, W * 0.4, 1, Object.assign({ split: true }, VP_COLORS), 2); line(ctx, x0, x0 + W * 0.4, c.yOf(r0.vp.poc + tk / 2), "#f23645", [], 1.5); }
      }
    }
  }
  // ---------------------------------------------------------------- VWAP with bands
  function vwapStudy(S, st) {
    const c = S.c, p = st.p;
    const series = s => { const part = p.anchor === "eth" ? s.eth : s.rth; return part && part.vwap && part.vwap.length ? part.vwap : null; };
    let last = null;
    const layer = c.addLayer("normal", {
      draw(ctx, w) {
        last = null; if (!st.on) return;
        const vr = c.visibleT(); if (!vr) return;
        const bands = [[p.b1, p.m1], [p.b2, p.m2], [p.b3, p.m3]].filter(b => b[0]).map(b => b[1]);
        for (const s of A.list()) {
          const V = series(s); if (!V || s.end < vr[0] || s.start > vr[1]) continue;
          const pts = []; let lastX = -1e9;
          for (let i = 0; i < V.length; i++) { const x = c.xOf(V[i][0] + 30); if (x == null) continue; if (x - lastX < 1 && i < V.length - 1) continue; lastX = x; pts.push([x, V[i][1], V[i][2] || 0]); }
          if (pts.length < 2) continue;
          const path = k => { ctx.beginPath(); pts.forEach(([x, v, sd], i) => { const y = c.yOf(v + k * sd); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); };
          if (p.fill && bands.length) {
            const m = bands[0]; ctx.beginPath();
            pts.forEach(([x, v, sd], i) => { const y = c.yOf(v + m * sd); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
            for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i][0], c.yOf(pts[i][1] - m * pts[i][2]));
            ctx.closePath(); ctx.fillStyle = p.fillColor; ctx.fill();
          }
          ctx.lineWidth = 1; ctx.strokeStyle = p.bandColor;
          for (const m of bands) { path(m); ctx.stroke(); path(-m); ctx.stroke(); }
          ctx.lineWidth = p.width; ctx.strokeStyle = p.color; path(0); ctx.stroke();
          if (s === A.cur || s.end > (c.lastT || 0) - 1) last = V[V.length - 1];
        }
        if (!last) { const s = A.list().filter(x => series(x)).slice(-1)[0]; if (s) { const V = series(s); last = V[V.length - 1]; } }
      },
      axis() { return p.label && st.on && last ? [{ y: c.yOf(last[1]), text: TV.fp(last[1], c.tick()), bg: p.color }] : []; },
    });
    return {
      vals(i) {
        const t = c.BARS[i] ? Math.min(c.BARS[i].t + c.tfSec() - 60, c.lastT || Infinity) : null; if (t == null) return [];
        for (const s of A.list()) { const V = series(s); if (!V || t < V[0][0] || t > s.end) continue;
          let lo = 0, hi = V.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (V[m][0] <= t) { k = m; lo = m + 1; } else hi = m - 1; }
          if (k >= 0) { const out = [{ text: TV.fp(V[k][1], c.tick()), color: p.color }]; if (p.b1) out.push({ text: TV.fp(V[k][1] + p.m1 * V[k][2], c.tick()), color: p.bandColor }, { text: TV.fp(V[k][1] - p.m1 * V[k][2], c.tick()), color: p.bandColor }); return out; } }
        return [];
      },
      destroy() { c.removeLayer(layer); },
    };
  }
  // ---------------------------------------------------------------- levels
  function priorStudy(S, st) {
    const c = S.c, p = st.p;
    const layer = c.addLayer("normal", {
      draw(ctx, w) {
        if (!st.on) return;
        const vr = c.visibleT(); if (!vr) return;
        const list = A.list(), tk = TICK();
        for (let i = 1; i < list.length; i++) {
          const s = list[i]; if (s.end < vr[0] || s.start > vr[1]) continue;
          const prev = c.SESS.findIndex(x => x.date === s.date), pv = prev > 0 ? A.byDate(c.SESS[prev - 1].date) : null;
          const pr = pv && pv.rth && !pv.rth.developing ? pv.rth.vp : null; if (!pr) continue;
          const a = c.xOf(s.start), b = c.xOf(Math.min(s.end, c.lastT)); if (a == null || b == null) continue;
          const d = dashOf(p.style);
          line(ctx, a, b, c.yOf(pr.vah + tk / 2), p.va, d); line(ctx, a, b, c.yOf(pr.val + tk / 2), p.va, d); line(ctx, a, b, c.yOf(pr.poc + tk / 2), p.poc, d, 1.5);
          if (p.labels && b - a > 60) { tag(ctx, b - 4, c.yOf(pr.vah + tk / 2), "vVAH", p.va, "right"); tag(ctx, b - 4, c.yOf(pr.val + tk / 2), "vVAL", p.va, "right"); tag(ctx, b - 4, c.yOf(pr.poc + tk / 2), "vPOC", p.poc, "right"); }
        }
      },
    });
    return { destroy() { c.removeLayer(layer); } };
  }
  function npocStudy(S, st) {
    const c = S.c, p = st.p;
    const layer = c.addLayer("normal", {
      draw(ctx, w) {
        if (!st.on) return;
        const xr = c.xOf(c.lastT), tk = TICK(), d = dashOf(p.style);
        for (const n of A.naked) { const a = Math.max(0, c.xOf(n.since) ?? 0); line(ctx, a, xr, c.yOf(n.poc + tk / 2), p.color, d); if (p.labels) tag(ctx, Math.max(a + 4, (xr ?? w) - 120), c.yOf(n.poc + tk / 2), "nPOC " + n.date.slice(8, 10) + "." + n.date.slice(5, 7), p.color); }
        for (const s of A.list()) {
          const r0 = s.rth; if (!r0 || r0.developing || !r0.vp) continue;
          if (!r0.poc_touched) { const a = c.xOf(r0.end); line(ctx, a, xr, c.yOf(r0.vp.poc + tk / 2), p.color, d); if (p.labels && a != null) tag(ctx, Math.max(a + 4, (xr ?? w) - 120), c.yOf(r0.vp.poc + tk / 2), "nPOC " + s.date.slice(8, 10) + "." + s.date.slice(5, 7), p.color); }
          else if (p.touched && r0.poc_touched <= c.lastT && r0.poc_touched > r0.end + 60) line(ctx, c.xOf(r0.end), c.xOf(r0.poc_touched), c.yOf(r0.vp.poc + tk / 2), TV.rgba(p.color, 0.35), d);
        }
      },
    });
    return { destroy() { c.removeLayer(layer); } };
  }
  function ibStudy(S, st) {
    const c = S.c, p = st.p;
    const layer = c.addLayer("normal", {
      draw(ctx, w) {
        if (!st.on) return;
        const vr = c.visibleT(); if (!vr) return;
        for (const s of A.list()) {
          const r0 = s.rth; if (!r0 || !r0.ib || s.end < vr[0] || s.start > vr[1]) continue;
          const a = c.xOf(r0.start), b = c.xOf(r0.developing ? Math.max(c.lastT, r0.ib.end) : r0.end); if (a == null || b == null) continue;
          const yh = c.yOf(r0.ib.high), yl = c.yOf(r0.ib.low), d = dashOf(p.style);
          if (p.fill && yh != null && yl != null) { ctx.fillStyle = p.fillColor; ctx.fillRect(a, yh, c.xOf(r0.ib.end) - a, yl - yh); }
          line(ctx, a, b, yh, p.color, d); line(ctx, a, b, yl, p.color, d);
          if (b - a > 60) { tag(ctx, a + 4, yh, "IBH", p.color); tag(ctx, a + 4, yl + 14, "IBL", p.color); }
          if (p.ext && r0.ib.complete) {
            const rg = r0.ib.high - r0.ib.low;
            for (const k of [0.5, 1, 2]) { const yu = c.yOf(r0.ib.high + rg * k), yd = c.yOf(r0.ib.low - rg * k); line(ctx, a, b, yu, p.extColor, [2, 4]); line(ctx, a, b, yd, p.extColor, [2, 4]);
              if (b - a > 80) { tag(ctx, a + 4, yu, `${1 + k}×`, p.extColor); tag(ctx, a + 4, yd + 14, `${1 + k}×`, p.extColor); } }
          }
        }
      },
    });
    return { destroy() { c.removeLayer(layer); } };
  }
  function onStudy(S, st) {
    const c = S.c, p = st.p;
    const layer = c.addLayer("normal", {
      draw(ctx, w) {
        if (!st.on) return;
        const vr = c.visibleT(); if (!vr) return;
        for (const s of A.list()) {
          const on = s.on, r0 = s.rth; if (!on || !r0 || s.end < vr[0] || s.start > vr[1]) continue;
          const a = c.xOf(r0.start), b = c.xOf(r0.developing ? Math.max(c.lastT, r0.start) : r0.end); if (a == null || b == null) continue;
          const d = dashOf(p.style);
          line(ctx, a, b, c.yOf(on.high), p.color, d); line(ctx, a, b, c.yOf(on.low), p.color, d);
          if (b - a > 60) { tag(ctx, b - 4, c.yOf(on.high), "ONH", p.color, "right"); tag(ctx, b - 4, c.yOf(on.low) + 14, "ONL", p.color, "right"); }
          if (p.poc && on.vp) { line(ctx, a, b, c.yOf(on.vp.poc + TICK() / 2), p.pocColor, [4, 3]); if (b - a > 60) tag(ctx, b - 4, c.yOf(on.vp.poc + TICK() / 2), "ON POC", p.pocColor, "right"); }
        }
      },
    });
    return { destroy() { c.removeLayer(layer); } };
  }
  // ---------------------------------------------------------------- week profiles (behind the candles)
  const weekOf = td => { const d = new Date(td + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
  function weekStudy(S, st) {
    const c = S.c, p = st.p;
    const layer = c.addLayer("bottom", {
      draw(ctx, w, h) {
        if (!st.on) return;
        const weeks = new Map(), tk = TICK();
        for (const s of A.list()) {
          const parts = s.eth ? [s.eth] : [s.on, s.rth];
          const k = weekOf(s.date), wk = weeks.get(k) || { start: s.start, end: s.end, vol: new Map() };
          wk.start = Math.min(wk.start, s.start); wk.end = Math.max(wk.end, s.end);
          for (const pt of parts) if (pt && pt.vp) for (const [pr, v] of pt.vp.levels) wk.vol.set(pr, (wk.vol.get(pr) || 0) + v);
          weeks.set(k, wk);
        }
        for (const wk of weeks.values()) {
          if (!wk.vol.size) continue;
          const x0 = c.xOf(wk.start), x1 = c.xOf(Math.min(wk.end, c.lastT)); if (x0 == null || x1 == null || x1 < 0 || x0 > w || x1 - x0 < 20) continue;
          const rows = [...wk.vol.entries()].sort((a, b) => a[0] - b[0]);
          let tot = 0, pi = 0; rows.forEach((r, i) => { tot += r[1]; if (r[1] > rows[pi][1]) pi = i; });
          let lo = pi, hi = pi, acc = rows[pi][1];
          while (acc < tot * 0.7 && (lo > 0 || hi < rows.length - 1)) { const up = hi < rows.length - 1 ? rows[hi + 1][1] : -1, dn = lo > 0 ? rows[lo - 1][1] : -1; if (up >= dn) { hi++; acc += up; } else { lo--; acc += dn; } }
          const vp = { levels: rows.map(r => [r[0], r[1], 0]), poc: rows[pi][0], val: rows[lo][0], vah: rows[hi][0] };
          paintVp(c, ctx, vp, x0, (x1 - x0) * p.width / 100, 1, { split: false, up: p.color, vaUp: p.va }, 2);
          line(ctx, x0, x1, c.yOf(vp.poc + tk / 2), p.poc, [], 1);
        }
      },
    });
    return { destroy() { c.removeLayer(layer); } };
  }

  // ================================================================ the studies of one pane
  let seq = 0;
  TV.studyDefaults = type => Object.assign({}, DEFS[type].defaults, TV.store.get("study.defaults." + type, {}));   // built-in, then what the user saved as standard
  TV.newStudy = (type, p) => ({ id: "s" + Date.now().toString(36) + (seq++), type, on: true, p: Object.assign(TV.studyDefaults(type), p || {}) });
  TV.DEFAULT_STUDIES = () => [TV.newStudy("vol"), TV.newStudy("svp"), TV.newStudy("tpo"), TV.newStudy("vwap")];

  class Studies {
    constructor(c) {
      this.c = c; this.rt = new Map();
      if (!Array.isArray(c.cfg.studies)) c.cfg.studies = TV.DEFAULT_STUDIES();
      c.cfg.studies = c.cfg.studies.filter(s => DEFS[s.type]);
      for (const s of c.cfg.studies) s.p = Object.assign({}, DEFS[s.type].defaults, s.p);
      this.base = c.addLayer("bottom", baseLayer(this));
      for (const s of c.cfg.studies) this.start(s);
      this.need();
    }
    get list() { return this.c.cfg.studies; }
    start(s) { try { const r = DEFS[s.type].make(this, s); this.rt.set(s.id, r); if (r.visible) r.visible(s.on); } catch (e) { console.error(e); } }
    need() {                                                     // what the auction data has to carry for this pane
      const on = this.list.filter(s => s.on), d = this.c;
      const amt = d.cfg.type === "tpo" || on.some(s => !["vol", "ma", "vrvp"].includes(s.type)) || TV.app.settings.breaks || TV.app.settings.rthShade;
      if (!amt) { A.drop(d); return; }
      const from = d.BARS.length ? d.BARS[0].t : null;
      A.want(d, from, { eth: on.some(s => DEFS[s.type].eth && DEFS[s.type].eth(s.p)), p30: d.cfg.type === "tpo" || on.some(s => s.type === "tpo" && s.p.mode !== "blocks") });
      A.need = true;
    }
    add(type, p) {
      const s = TV.newStudy(type, p); this.list.push(s); this.start(s); this.need();
      this.c.legend(); TV.app.saveLayout(); this.c.redraw(); return s;
    }
    remove(id) {
      const r = this.rt.get(id); if (r && r.destroy) r.destroy(); this.rt.delete(id);
      this.c.cfg.studies = this.list.filter(s => s.id !== id); this.need(); this.c.legend(); TV.app.saveLayout(); this.c.redraw();
    }
    toggle(s) { s.on = !s.on; const r = this.rt.get(s.id); if (r && r.visible) r.visible(s.on); this.need(); this.c.legend(); TV.app.saveLayout(); this.c.redraw(); }
    changed(s) { const r = this.rt.get(s.id); if (r && r.changed) r.changed(); this.need(); this.c.legend(); TV.app.saveLayout(); this.c.redraw(); }
    onData(kind, k) { for (const r of this.rt.values()) if (r.onData) r.onData(kind, k); this.need(); }
    onRange() { for (const r of this.rt.values()) if (r.onRange) r.onRange(); }
    frame(now) { for (const r of this.rt.values()) if (r.frame) r.frame(now); }
    reset() { for (const r of this.rt.values()) if (r.onData) r.onData("reset", 0); }
    restyle() { for (const r of this.rt.values()) if (r.changed) r.changed(); }
    destroy() { for (const r of this.rt.values()) if (r.destroy) r.destroy(); this.rt.clear(); A.drop(this.c); }
    settings(s) {
      const def = DEFS[s.type], before = JSON.stringify(s.p);
      const render = () => { dlg.body.replaceChildren(); TV.form(dlg.body, def.schema, s.p, () => this.changed(s)); };
      const dlg = TV.dialog({ title: def.name, width: 500,
        body: b => TV.form(b, def.schema, s.p, () => this.changed(s)),
        buttons: [{ label: "Werkseinstellung", action: () => { s.p = Object.assign({}, def.defaults); this.changed(s); render(); return false; } },
                  { label: "Als Standard speichern", action: () => {                  // for every new one, and every pane's now
                      TV.store.set("study.defaults." + s.type, Object.assign({}, s.p));
                      for (const c of TV.app.charts) for (const x of c.studies.list) if (x.type === s.type && x !== s) { x.p = Object.assign({}, s.p); c.studies.changed(x); }
                      TV.toast(`${def.name}: als Standard gespeichert und in allen Charts übernommen`, "ok"); return false; } },
                  { label: "Abbrechen", action: () => { s.p = JSON.parse(before); this.changed(s); } }, { label: "OK", kind: "pri" }] });
    }
    legend(host) {
      this.rows = new Map();
      for (const s of this.list) {
        const def = DEFS[s.type];
        const vals = el("span.vals");
        const row = el("div.lg-row", null, el("span.lg-study" + (s.on ? "" : ".off"), null,
          el("span.nm", { text: def.short(s.p) }), vals,
          el("span.btns", null,
            el("button.lg-btn", { title: s.on ? "Ausblenden" : "Einblenden", onclick: () => this.toggle(s) }, TV.iconSm(s.on ? "eye" : "eyeoff")),
            el("button.lg-btn", { title: "Einstellungen", onclick: () => this.settings(s) }, TV.iconSm("gear")),
            el("button.lg-btn", { title: "Entfernen", onclick: () => this.remove(s.id) }, TV.iconSm("close")))));
        row.querySelector(".lg-study").addEventListener("dblclick", () => this.settings(s));
        host.append(row); this.rows.set(s.id, vals);
      }
    }
    legendValues(i) {
      if (!this.rows) return;
      for (const s of this.list) {
        const v = this.rows.get(s.id), r = this.rt.get(s.id); if (!v) continue;
        const items = s.on && r && r.vals ? r.vals(i) : [];
        const sig = JSON.stringify(items); if (v._sig === sig) continue; v._sig = sig;
        v.replaceChildren(...items.map(x => el("span", { text: x.text, style: { color: x.color } })));
      }
    }
  }
  TV.Studies = Studies;
  TV.paintVp = paintVp;                                    // the fixed range tool (draw.js) paints with it too
  // TradingView's indicator dialog
  TV.indicatorDialog = function (chart) {
    const types = Object.keys(DEFS);
    TV.dialog({ title: "Indikatoren", width: 560, pad: false, body: b => {
      const inp = el("input", { placeholder: "Suchen", autocomplete: "off" }), list = el("div.slist");
      b.append(el("div.search", { style: { paddingTop: "8px" } }, TV.iconSm("search", 20), inp), list);
      let hl = 0, shown = [];
      const render = () => {
        const q = inp.value.trim().toLowerCase(); list.replaceChildren(); shown = [];
        let g = null;
        for (const t of types.slice().sort((a, b) => DEFS[a].group.localeCompare(DEFS[b].group))) {
          const d = DEFS[t]; if (q && !(d.name + " " + d.group).toLowerCase().includes(q)) continue;
          if (d.group !== g) { g = d.group; list.append(el("div.grp", { text: g })); }
          const have = chart.studies.list.filter(s => s.type === t).length;
          const row = el("div.si" + (shown.length === hl ? ".hl" : ""), { onclick: () => { chart.studies.add(t); TV.toast(`${d.name} hinzugefügt`, "ok", 1800); render(); } },
            el("span.sd", { text: d.name }), el("span.sx", { text: have ? `${have}× im Chart` : "" }));
          list.append(row); shown.push(t);
        }
        if (!shown.length) list.append(el("div.empty", { text: "Nichts gefunden" }));
      };
      inp.oninput = () => { hl = 0; render(); };
      inp.onkeydown = e => { if (e.key === "ArrowDown") { hl = Math.min(shown.length - 1, hl + 1); render(); e.preventDefault(); } else if (e.key === "ArrowUp") { hl = Math.max(0, hl - 1); render(); e.preventDefault(); } else if (e.key === "Enter" && shown[hl]) { chart.studies.add(shown[hl]); TV.toast(`${DEFS[shown[hl]].name} hinzugefügt`, "ok", 1800); render(); } };
      render(); setTimeout(() => inp.focus(), 0);
    } });
  };
})();
