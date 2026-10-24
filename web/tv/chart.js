/* chart.js - one chart pane of the replay. Bars come from the server's timeline in the pane's own timeframe
 * (/tl/bars), cut at the shared replay clock - nothing after it exists here. Loading follows what is visible: a few
 * sessions around the clock, the next older ones when the view nears the left edge, while playing
 * only the tail. Everything drawn on top of the bars (profiles, VWAP, drawings, orders) goes through layers: the
 * chart library's series primitives (v4.1 plugins), so it scrolls with the chart and can put labels on the price and
 * time axes like TradingView. Layers: chart.layers.bottom / normal / top, each {draw(ctx, w, h), axis(), time()}. */
(function () {
  const { el } = TV;
  TV.TFS = [[5 / 60, "5s", "5 seconds"], [15 / 60, "15s", "15 seconds"], [30 / 60, "30s", "30 seconds"], [1, "1m", "1 minute"], [2, "2m", "2 minutes"], [3, "3m", "3 minutes"], [5, "5m", "5 minutes"], [10, "10m", "10 minutes"],
            [15, "15m", "15 minutes"], [30, "30m", "30 minutes"], [45, "45m", "45 minutes"], [60, "1h", "1 hour"], [120, "2h", "2 hours"],
            [240, "4h", "4 hours"], [1440, "D", "1 day (session)"]];
  TV.tfName = tf => (TV.TFS.find(x => x[0] === tf) || [0, tf + "m"])[1];
  TV.tfShort = tf => tf < 1 ? Math.round(tf * 60) + "s" : tf < 60 ? String(tf) : tf < 1440 ? tf / 60 + "h" : "1D";
  const VIEWN = tf => ({ 1: 240, 2: 220, 3: 200, 5: 200, 10: 170, 15: 150, 30: 120, 45: 110, 60: 110, 120: 100, 240: 90, 1440: 40 })[tf] || 150;
  TV.CHART_TYPES = [["candles", "Candles", "candles"], ["hollow", "Hollow candles", "hollow"], ["bars", "Bars (OHLC)", "bars"], ["heikin", "Heikin Ashi", "heikin"],
                    ["line", "Line", "line"], ["area", "Area", "area"], ["footprint", "Footprint (Bid × Ask)", "footprint"], ["tpo", "Market Profile (TPO chart)", "tpo"]];

  // ---- the series primitive that carries a chart's layers (one per z-order)
  class Prim {
    constructor(c, z) {
      this.c = c; this.z = z; this.req = null;
      const self = this;
      this.pv = [{ zOrder: () => z, renderer: () => ({ draw: target => target.useMediaCoordinateSpace(s => self.c.drawLayers(z, s.context, s.mediaSize.width, s.mediaSize.height)) }) }];
    }
    attached(p) { this.req = p.requestUpdate; }
    detached() { this.req = null; }
    updateAllViews() {}
    paneViews() { return this.pv; }
    priceAxisViews() { return this.z === "top" ? this.c.axisViews() : []; }
    timeAxisViews() { return this.z === "top" ? this.c.timeViews() : []; }
  }
  const axisView = l => ({ coordinate: () => l.y, text: () => l.text, textColor: () => l.fg || "#fff", backColor: () => l.bg, visible: () => true, tickVisible: () => true });
  const timeView = l => ({ coordinate: () => l.x, text: () => l.text, textColor: () => l.fg || "#fff", backColor: () => l.bg, visible: () => true, tickVisible: () => true });

  // ---- time labels in the display's zone (New York or Vienna, clock.js)
  const fmts = {};
  const zf = opts => { const k = RC.zone() + JSON.stringify(opts); return fmts[k] || (fmts[k] = new Intl.DateTimeFormat("en-GB", Object.assign({ timeZone: RC.zone() }, opts))); };
  const parts = (f, t) => f.formatToParts(new Date(t * 1000)).reduce((a, x) => (a[x.type] = x.value, a), {});
  TV.fmtCross = (t, tf) => {
    if (tf >= 1440) { const p = parts(new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "short", year: "2-digit" }), Date.parse(RC.tradeDate(t + 1) + "T12:00:00Z") / 1000);
      return `${p.weekday.replace(".", "")} ${p.day} ${p.month.replace(".", "")} '${p.year}`; }
    const p = parts(zf({ weekday: "short", day: "2-digit", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }), t);
    return `${p.weekday.replace(".", "")} ${p.day} ${p.month.replace(".", "")} '${p.year}   ${p.hour}:${p.minute}${tf < 1 ? ":" + p.second : ""}`;
  };

  class Chart {
    constructor(app, host, cfg) {
      this.app = app; this.cfg = cfg;
      this.el = el("div.pane"); host.append(this.el);
      this.box = el("div.cbox"); this.el.append(this.box);
      this.legendEl = el("div.legend"); this.el.append(this.legendEl);
      this.msgEl = el("div.msg"); this.el.append(this.msgEl);
      this.plusEl = el("div.plus", { text: "+", title: "Order or line at this price" }); this.el.append(this.plusEl);
      this.layers = { bottom: [], normal: [], top: [] };
      this.prims = ["bottom", "normal", "top"].map(z => new Prim(this, z));
      this.BARS = []; this.SESS = []; this.inst = null; this.from = null; this.lastT = null; this.needT = null; this.needFrom = null;
      this.busy = false; this.rev = 0; this.lastReq = 0; this.msg = "";
      this.cross = null;                                      // {t, p, x, y} under the mouse, null when outside
      if (cfg.type === "tpo") cfg.tf = 30;
      this.chart = LightweightCharts.createChart(this.box, this.options());
      this.series = null; this.makeSeries();
      this.studies = new TV.Studies(this);
      this.legend();
      this.wire();
      this.applyScale();
    }
    get tf() { return this.cfg.tf; }
    tfSec() { return this.cfg.tf * 60; }
    spec() { return TV.spec(this.inst || this.app.inst()); }
    tick() { return this.spec().tick; }

    options() {
      const S = this.app.settings, cs = getComputedStyle(document.body);
      const v = n => cs.getPropertyValue(n).trim();
      return {
        autoSize: true,
        layout: { background: { type: "solid", color: S.bg || v("--bg") }, textColor: v("--text2"), fontSize: 12, fontFamily: v("--font") },
        grid: { vertLines: { color: v("--grid"), visible: S.grid }, horzLines: { color: v("--grid"), visible: S.grid } },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.14 }, entireTextOnly: true },
        timeScale: { borderVisible: true, borderColor: v("--line"), timeVisible: true, secondsVisible: this.cfg.tf < 1, rightOffset: 12, barSpacing: 7,
                     minBarSpacing: 0.4, tickMarkFormatter: (t, k) => this.tickFmt(t, k) },
        localization: { locale: "en-GB", timeFormatter: t => TV.fmtCross(t, this.cfg.tf), priceFormatter: p => TV.fp(p, this.tick()) },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal,
                     vertLine: { color: "#9598a1", width: 1, style: LightweightCharts.LineStyle.LargeDashed, labelBackgroundColor: v("--line2") },
                     horzLine: { color: "#9598a1", width: 1, style: LightweightCharts.LineStyle.LargeDashed, labelBackgroundColor: v("--line2") } },
        handleScale: { axisPressedMouseMove: { time: true, price: true } },
        kineticScroll: { mouse: false, touch: true },
      };
    }
    restyle() { this.chart.applyOptions(this.options()); this.makeSeries(true); this.studies.restyle(); this.redraw(); }
    tickFmt(t, type) {
      const d = new Date(t * 1000);
      if (type === 0) return zf({ year: "numeric" }).format(d);
      if (type === 1) return zf({ month: "short" }).format(d).replace(".", "");
      if (this.cfg.tf >= 1440) { const td = RC.tradeDate(t + 1); return String(+td.slice(8, 10)); }
      if (this.cfg.tf < 1 && type >= 3) return zf({ hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(d);
      const hm = zf({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
      if (type === 2 && hm === "00:00") return String(+parts(zf({ day: "2-digit" }), t).day);
      return hm;
    }

    // ---------------------------------------------------------------- series
    makeSeries(keep) {
      const S = this.app.settings, type = this.cfg.type, tick = this.tick();
      const keepRange = this.series && this.BARS.length ? this.chart.timeScale().getVisibleLogicalRange() : null;
      if (this.series) { for (const p of this.prims) this.series.detachPrimitive(p); this.chart.removeSeries(this.series); this.series = null; }
      const pf = { type: "price", precision: TV.dec(tick), minMove: tick };
      const base = { priceFormat: pf, priceLineStyle: LightweightCharts.LineStyle.Dashed, priceLineWidth: 1, lastValueVisible: true, priceLineVisible: true };
      let s;
      if (type === "line") s = this.chart.addLineSeries(Object.assign({ color: S.lineColor, lineWidth: 2, crosshairMarkerRadius: 4 }, base));
      else if (type === "area") s = this.chart.addAreaSeries(Object.assign({ lineColor: S.lineColor, topColor: TV.rgba(S.lineColor, 0.28), bottomColor: TV.rgba(S.lineColor, 0.02), lineWidth: 2 }, base));
      else if (type === "bars") s = this.chart.addBarSeries(Object.assign({ upColor: S.up, downColor: S.down, thinBars: false, openVisible: true }, base));
      else if (type === "tpo") s = this.chart.addCandlestickSeries(Object.assign({}, base, { upColor: "rgba(0,0,0,0)", downColor: "rgba(0,0,0,0)", borderVisible: false, wickVisible: false, priceLineVisible: false }));
      else {
        const hollow = type === "hollow";
        s = this.chart.addCandlestickSeries(Object.assign({ upColor: hollow ? "rgba(0,0,0,0)" : S.up, downColor: S.down, borderVisible: true,
          borderUpColor: S.up, borderDownColor: S.down, wickUpColor: S.up, wickDownColor: S.down }, base));
      }
      this.series = s; this.fpOn = false;                     // a new series shows candles until footprint.js switches
      for (const p of this.prims) s.attachPrimitive(p);
      if (keep !== false && this.BARS.length) { s.setData(this.display(this.BARS)); if (keepRange) this.chart.timeScale().setVisibleLogicalRange(keepRange); }
    }
    setType(type) {
      const wasTpo = this.cfg.type === "tpo", wasFp = this.cfg.type === "footprint";
      this.cfg.type = type;
      if (type === "tpo" && this.cfg.tf !== 30) { this.cfg.tf = 30; this.makeSeries(false); this.reset(); }
      else if (wasTpo && type !== "tpo") { this.makeSeries(false); this.reset(); }
      else this.makeSeries();
      if (type === "footprint" && TV.FP) TV.FP.zoomIn(this);
      else if (wasFp && type !== "footprint") this.fit();          // back from the footprint's wide columns
      this.app.saveLayout(); this.app.topState(); this.legend(); this.redraw();
    }
    setTf(tf) {
      if (this.cfg.type === "tpo" && tf !== 30) this.cfg.type = "candles", this.makeSeries(false);
      this.cfg.tf = tf; this.chart.applyOptions({ timeScale: { secondsVisible: tf < 1 } }); this.app.saveLayout(); this.app.topState(); this.legend(); this.reset();
    }
    display(bars) {                                             // bars -> what the series takes; a gap slot (a missing day) is whitespace
      const type = this.cfg.type;
      if (type === "line" || type === "area") return bars.map(b => b.gap ? { time: b.t } : { time: b.t, value: b.c });
      if (type === "heikin") {
        const out = []; let po = null, pc = null;
        for (const b of bars) {
          if (b.gap) { out.push({ time: b.t }); continue; }
          const c = (b.o + b.h + b.l + b.c) / 4, o = po == null ? (b.o + b.c) / 2 : (po + pc) / 2;
          out.push({ time: b.t, open: o, high: Math.max(b.h, o, c), low: Math.min(b.l, o, c), close: c }); po = o; pc = c;
        }
        return out;
      }
      return bars.map(b => b.gap ? { time: b.t } : { time: b.t, open: b.o, high: b.h, low: b.l, close: b.c });
    }
    pushTail(k, fresh, oldLen) {
      // only the last bar changed or bars were appended: update in place (no flicker). Replacing the last bar with
      // the same time is an update too - so winding back inside a bar does not reset the whole series.
      if (this.cfg.type === "heikin" || k !== oldLen - 1 || !fresh.length || fresh[0].t !== this.BARS[k].t) return false;
      for (const x of this.display(fresh)) this.series.update(x);
      return true;
    }

    // ---------------------------------------------------------------- data on the clock
    // The pane keeps the bars of a run of whole sessions (this.from = index of the oldest loaded session) up to the
    // clock (this.lastT). What it should have is a "need" (needFrom, needT); the frame loop serves one step of it at a
    // time whenever no request is running - loading older sessions when the view nears the left edge, the tail when
    // the clock moved, everything anew when the instrument, the timeframe or the clock's day changed. A need is never
    // lost: a scroll or a jump during a request is served by the next step.
    sessIdx(t) { const S = this.SESS; let lo = 0, hi = S.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (S[m].start <= t) { a = m; lo = m + 1; } else hi = m - 1; } return a; }
    sessionsPerStep() { return Math.max(1, Math.min(60, Math.ceil(150 / Math.max(1, 1380 / this.cfg.tf)))); }
    async getBars(from, to, until) {
      const j = await TV.getJSON(`/tl/bars?inst=${encodeURIComponent(this.inst)}&tf=${this.cfg.tf}&from=${from}&to=${to}&until=${until}`);
      return j.bars || [];
    }
    sync(t) { this.needT = t; }                                 // the clock moved: wanted at t
    wantOlder() { if (this.from != null && this.from > 0) this.needFrom = Math.max(0, this.from - this.sessionsPerStep()); }
    reset() { this.BARS = []; this.series.setData([]); this.from = null; this.lastT = null; this.needFrom = null; this.studies.reset(); const t = RC.now(); if (t != null) this.needT = t; }
    async step() {
      if (this.busy) return;
      const t = this.needT;
      const inst = this.app.inst();
      try {
        if (inst !== this.inst) { this.inst = inst; this.SESS = []; this.BARS = []; this.from = null; }
        if (!this.SESS.length && t != null) { this.busy = true; this.SESS = await RP.sessions(inst); this.busy = false; if (!this.SESS.length) { this.msg = "No trading days in the archive – check the folders in the settings"; this.needT = null; return; } }
        else if (t != null && Date.now() - (this._sessAt || 0) > 60000) { this._sessAt = Date.now(); RP.sessions(inst).then(l => { if (l.length) this.SESS = l; }).catch(() => {}); }
        if (t != null && this.lastT != null && t === this.lastT && this.needT === t) this.needT = null;
        if (this.needT != null) { this.busy = true; const x = this.needT; this.needT = null; await this.tail(x); return; }
        if (this.needFrom != null && this.from != null && this.needFrom < this.from && this.lastT != null) { this.busy = true; const f = this.needFrom; this.needFrom = null; await this.older(f); }
        this.fails = 0; if (this.msg.startsWith("Error")) this.msg = "";
      } catch (e) {
        this.fails = (this.fails || 0) + 1;                  // a request that failed: the next step tries again, the message only after three
        if (this.fails >= 3) this.msg = "Error: " + e.message + (e.message === "Failed to fetch" ? " – the server does not answer (restarted? check the console window)" : "");
        if (t != null && this.needT == null) this.needT = t;
        await new Promise(r => setTimeout(r, 400));
      }
      finally { this.busy = false; }
    }
    async reload(t) {
      const i = Math.max(0, this.sessIdx(t)), from = Math.max(0, i - this.sessionsPerStep() + 1), tf = this.cfg.tf;
      this.msg = "Loading candles …";
      const bars = await this.getBars(this.SESS[from].start, t + 1, t);
      if (tf !== this.cfg.tf) return;
      this.BARS = bars; this.from = from; this.series.setData(this.display(bars)); this.lastT = t;
      if (!bars.length) { const nxt = this.SESS.find(s => s.start > t); this.msg = `${this.inst}: no data up to this time` + (nxt ? ` – first trading day after: ${nxt.date}` : ""); }
      else this.msg = "";
      const n = bars.length;
      if (this.cfg.type === "footprint" && TV.FP) TV.FP.zoomIn(this);
      else this.chart.timeScale().setVisibleLogicalRange({ from: n - VIEWN(tf), to: n + 12 });
      this.rev++; if (TV.FP) TV.FP.onData(this, "reset"); this.studies.onData("reset", 0); this.legend(); this.redraw();
    }
    async tail(t) {
      const B = this.BARS;
      if (!B.length || this.from == null || t < this.SESS[this.from].start) return this.reload(t);
      const iNow = this.sessIdx(t), iLast = this.sessIdx(B[B.length - 1].t);
      if (iNow - iLast > this.sessionsPerStep() + 1) return this.reload(t);
      let k = B.length; while (k > 0 && B[k - 1].t > t - this.tfSec()) k--;
      if (k === B.length) k = B.length - 1;
      const oldLen = B.length, tf = this.cfg.tf;
      const fresh = await this.getBars(B[k].t, t + 1, t);
      if (tf !== this.cfg.tf || B !== this.BARS) return;
      const back = this.lastT != null && t < this.lastT;
      const newBars = B.slice(0, k).concat(fresh);
      let pushed = false;
      try { pushed = this.pushTail(k, fresh, oldLen); } catch (e) { pushed = false; }   // the library refuses an update behind its last bar: set everything
      this.BARS = newBars; this.lastT = t;
      if (!pushed) {
        const r = this.chart.timeScale().getVisibleLogicalRange();
        this.series.setData(this.display(this.BARS));
        // appended bars: keep the distance to the right edge; bars gone (wound back past a bar): keep the view as it is
        if (r && this.BARS.length > oldLen) { const off = r.to - (oldLen - 1), w = r.to - r.from; this.chart.timeScale().setVisibleLogicalRange({ from: this.BARS.length - 1 + off - w, to: this.BARS.length - 1 + off }); }
        else if (r) this.chart.timeScale().setVisibleLogicalRange(r);
      }
      this.rev++; if (TV.FP) TV.FP.onData(this, back ? "back" : "tail"); this.studies.onData(pushed ? "tail" : "back", k); if (!this.cross) this.legendValues();
      this.redraw();
    }
    async older(f) {
      const tf = this.cfg.tf, B = this.BARS, from = this.from;
      const older = await this.getBars(this.SESS[f].start, this.SESS[from].start, this.lastT);
      if (tf !== this.cfg.tf || B !== this.BARS) return;
      this.from = f;
      if (!older.length) return;
      const r = this.chart.timeScale().getVisibleLogicalRange();
      this.BARS = older.concat(B); this.series.setData(this.display(this.BARS));
      if (r) this.chart.timeScale().setVisibleLogicalRange({ from: r.from + older.length, to: r.to + older.length });
      this.rev++; this.studies.onData("older", older.length); this.redraw();
      if (this._showDays) { const n = this._showDays; this._showDays = null; this.showDays(n); }
    }
    frame(now) {                                                // every animation frame (app.js)
      const s = RC.state;
      if (s && s.playing) {
        const t = RC.now();
        if (t != null && now - this.lastReq > 200 && (this.lastT == null || Math.abs(t - this.lastT) >= 1)) { this.lastReq = now; this.needT = t; }
      }
      const r = this.chart.timeScale().getVisibleLogicalRange();
      if (r && r.from < 20 && this.from != null && this.from > 0 && this.needFrom == null && !this.busy) this.wantOlder();
      if ((this.needT != null || this.needFrom != null) && !this.busy) this.step();
      this.studies.frame(now);
      if (TV.FP && (this.cfg.type === "footprint" || this.fpOn)) TV.FP.frame(this);
      if (this._amtRev !== TV.Amt.rev) { this._amtRev = TV.Amt.rev; if (!this.cross) this.legendValues(); }
      const sec = Math.floor((RC.now() || 0));
      if (sec !== this._sec) { this._sec = sec; this.redraw(); }      // the countdowns tick once a second
      if (this.msgEl.textContent !== this.msg) this.msgEl.textContent = this.msg;
    }
    // ---- a range of trade dates in view (the bottom bar's 1T 3T 5T ...)
    showDays(n) {
      if (!this.BARS.length || this.lastT == null) return;
      const i = this.sessIdx(this.lastT), want = Math.max(0, i - n + 1);
      if (want < this.from) { this.needFrom = want; this._showDays = n; return; }
      const first = this.SESS[want];
      let k = this.BARS.findIndex(b => b.t >= first.start); if (k < 0) k = 0;
      this.chart.timeScale().setVisibleLogicalRange({ from: k - 1, to: this.BARS.length + 8 });
    }

    // ---------------------------------------------------------------- coordinates
    lx(L) {                                                     // the library maps whole logical indices only (v4.1)
      const ts = this.chart.timeScale(), n = this.BARS.length - 1;
      const i = Math.max(0, Math.min(n - 1, Math.floor(L)));
      const a = ts.logicalToCoordinate(i), b = ts.logicalToCoordinate(i + 1);
      if (a == null || b == null) return null;
      return a + (L - i) * (b - a);
    }
    idxOf(t) { const B = this.BARS; let lo = 0, hi = B.length - 1, i = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (B[m].t <= t) { i = m; lo = m + 1; } else hi = m - 1; } return i; }
    xOf(t) {
      const B = this.BARS; if (B.length < 2 || t == null) return null;
      if (t < B[0].t) return this.lx(-0.5 - (B[0].t - t) / this.tfSec());
      const i = this.idxOf(t);
      let f = (t - B[i].t) / this.tfSec();
      if (i < B.length - 1) f = Math.min(1, f);
      return this.lx(i - 0.5 + f);
    }
    xBar(t) { const i = this.idxOf(t); if (i < 0) return null; return this.lx(i); }     // the centre of the bar holding t
    tOfX(x) {
      const B = this.BARS; if (B.length < 2) return null;
      const L0 = this.chart.timeScale().coordinateToLogical(x); if (L0 == null) return null;
      const i = Math.max(0, Math.min(B.length - 2, Math.floor(L0))), a = this.lx(i), b = this.lx(i + 1);
      if (a == null || b == null || b === a) return null;
      const L = i + (x - a) / (b - a), j = Math.max(0, Math.min(B.length - 1, Math.round(L)));
      return B[j].t + (L - (j - 0.5)) * this.tfSec();
    }
    yOf(p) { return this.series ? this.series.priceToCoordinate(p) : null; }
    pOfY(y) { return this.series ? this.series.coordinateToPrice(y) : null; }
    barAtX(x) { const t = this.tOfX(x); if (t == null) return null; const i = this.idxOf(t); const b = i >= 0 && t < this.BARS[i].t + this.tfSec() ? this.BARS[i] : null; return b && !b.gap ? b : null; }
    lastBar() { const B = this.BARS; for (let i = B.length - 1; i >= 0; i--) if (!B[i].gap) return B[i]; return null; }
    pane() { return { w: this.chart.timeScale().width(), h: this.box.clientHeight - this.chart.timeScale().height() }; }
    visibleT() {                                                // [t from, t to] of the bars in view
      const r = this.chart.timeScale().getVisibleLogicalRange(), B = this.BARS; if (!r || !B.length) return null;
      const a = Math.max(0, Math.min(B.length - 1, Math.floor(r.from))), b = Math.max(0, Math.min(B.length - 1, Math.ceil(r.to)));
      return [B[a].t, B[b].t + this.tfSec()];
    }

    // ---------------------------------------------------------------- layers
    addLayer(z, layer) { this.layers[z].push(layer); this.redraw(); return layer; }
    removeLayer(layer) { for (const z in this.layers) { const i = this.layers[z].indexOf(layer); if (i >= 0) this.layers[z].splice(i, 1); } this.redraw(); }
    drawLayers(z, ctx, w, h) {
      for (const l of this.layers[z]) { if (!l.draw) continue; ctx.save(); try { l.draw(ctx, w, h); } catch (e) { console.error(e); } ctx.restore(); }
    }
    axisViews() {
      const out = [];
      for (const z in this.layers) for (const l of this.layers[z]) if (l.axis) { try { for (const a of l.axis() || []) if (a && a.y != null && isFinite(a.y)) out.push(axisView(a)); } catch (e) { console.error(e); } }
      return out;
    }
    timeViews() {
      const out = [];
      for (const z in this.layers) for (const l of this.layers[z]) if (l.time) { try { for (const a of l.time() || []) if (a && a.x != null && isFinite(a.x)) out.push(timeView(a)); } catch (e) { console.error(e); } }
      return out;
    }
    redraw() { for (const p of this.prims) if (p.req) p.req(); }

    // ---------------------------------------------------------------- legend (top left, as TradingView)
    legend() {
      const L = this.legendEl; L.replaceChildren();
      const inst = this.inst || this.app.inst(), sp = TV.spec(inst);
      const title = el("div.lg-row");
      title.append(el("span.lg-title", { title: sp.name }, el("b", { text: inst }), el("span.ex", { text: ` · ${TV.tfShort(this.cfg.tf)} · CME` })));
      this.ohlcEl = el("span.lg-ohlc"); title.append(this.ohlcEl);
      L.classList.toggle("folded", !!this.cfg.legendFolded);
      L.append(title);
      // the indicator rows fold behind a chevron, as TradingView: folded, it sits under the title with the count;
      // unfolded, it sits under the last indicator row
      const n = (this.cfg.studies || []).length, folded = !!this.cfg.legendFolded;
      const fold = el("button.lg-fold", { title: folded ? "Show indicators" : "Hide indicators", onclick: () => { this.cfg.legendFolded = !this.cfg.legendFolded; this.app.saveLayout(); this.legend(); } },
        TV.iconSm(folded ? "right" : "up", 18), folded ? el("span", { text: `${n} indicator${n === 1 ? "" : "s"}` }) : null);
      this._foldBtn = fold;
      if (TV.Trade && this.app.settings.qt) { const q = TV.Trade.quickBox(this); if (q) L.append(q); }
      this.studyRows = el("div", { style: { display: folded ? "none" : "flex", flexDirection: "column", gap: "1px" } });
      if (folded) L.append(this._foldBtn, this.studyRows);     // folded: right under the quick box, with the count
      else L.append(this.studyRows, this._foldBtn);            // open: under the last indicator row
      if (TV.FP) { const r = TV.FP.legendRow(this); if (r) this.studyRows.append(r); }
      this.studies.legend(this.studyRows);
      this.legendValues();
    }
    legendValues() {
      const B = this.BARS; if (!this.ohlcEl) return;
      let i = B.length - 1;
      if (this.cross && this.cross.t != null) i = this.idxOf(this.cross.t);
      const b = B[i]; this.ohlcEl.replaceChildren();
      if (b && b.gap) { this.ohlcEl.append(el("span", null, el("b", { text: "NO DATA · " + b.day, style: { color: "var(--down)", fontWeight: 500 } }))); for (const s of this.studies.list) s.row && s.row.vals && s.row.vals([]); return; }
      if (b) {
        const prev = i > 0 ? B[i - 1].c : b.o, ch = b.c - prev, col = b.c >= b.o ? "var(--up)" : "var(--down)", tk = this.tick();
        const v = (k, x) => el("span", null, el("i", { text: k }), el("b", { text: TV.fp(x, tk), style: { color: col, fontWeight: 400 } }));
        this.ohlcEl.append(v("O", b.o), v("H", b.h), v("L", b.l), v("C", b.c),
          el("span", { text: `${ch >= 0 ? "+" : "−"}${TV.fp(Math.abs(ch), tk)} (${ch >= 0 ? "+" : "−"}${(Math.abs(ch) / prev * 100).toFixed(2)}%)`, style: { color: ch >= 0 ? "var(--up)" : "var(--down)" } }));
      }
      this.studies.legendValues(i);
      if (TV.FP) { TV.FP.legendValues(this); if (TV.FP.dw && (this.crossOwn || TV.FP.dwChart === this || !TV.FP.dwChart)) { if (this.crossOwn) TV.FP.dwChart = this; TV.FP.dwUpdate(); } }
      if (TV.Trade) TV.Trade.quickPrices(this);
    }

    // ---------------------------------------------------------------- events
    wire() {
      const ts = this.chart.timeScale();
      ts.subscribeVisibleLogicalRangeChange(r => { if (r && r.from < 20) this.wantOlder(); this.studies.onRange(); });
      this.chart.subscribeCrosshairMove(p => {
        if (!p || !p.point || p.point.x < 0) { this.cross = null; this.plusHide(); }
        else {
          const pr = this.pOfY(p.point.y);
          this.cross = { x: p.point.x, y: p.point.y, t: this.tOfX(p.point.x), p: pr };
          const pn = this.pane();
          if (pr != null && this.app.settings.plus && p.point.y < pn.h - 4 && !this.plusHover && !(TV.Trade && TV.Trade.nearLine(this, p.point.y))) { clearTimeout(this.plusTimer); this.plusTimer = null; this.plusEl.style.display = "flex"; this.plusEl.style.left = (pn.w - 22) + "px"; this.plusEl.style.top = (p.point.y - 9) + "px"; this.plusPrice = pr; }
          else if (!this.plusHover) this.plusHide();
        }
        // the mouse is here (a user event), not a crosshair set from another pane (that one arrives without sourceEvent)
        const own = !!(p && p.sourceEvent) || (!p || !p.point);
        this.crossOwn = own && !!this.cross;
        this.legendValues();
        if (own && !this._syncing) this.app.crossSync(this, this.cross);
      });
      // the mouse crossing from the chart onto the + leaves the chart first: hide only after a moment, and not while hovered
      this.plusHide = () => { if (this.plusHover || this.plusTimer) return; this.plusTimer = setTimeout(() => { this.plusTimer = null; if (!this.plusHover) this.plusEl.style.display = "none"; }, 350); };
      this.plusEl.addEventListener("mouseenter", () => { this.plusHover = true; clearTimeout(this.plusTimer); this.plusTimer = null; });
      this.plusEl.addEventListener("mouseleave", () => { this.plusHover = false; this.plusHide(); });
      this.plusEl.addEventListener("mousedown", e => e.stopPropagation());
      this.plusEl.addEventListener("click", e => { e.stopPropagation(); const r = this.plusEl.getBoundingClientRect(); this.app.priceMenu(this, Math.round(this.plusPrice / this.tick()) * this.tick(), { x: r.right + 2, y: r.top }); });
      this.el.addEventListener("mousedown", () => this.app.activate(this), true);
      // pointer: order lines first, then drawings; whoever takes a press gets the drag, the chart does not pan
      const loc = e => { const r = this.box.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
      const inPane = (x, y) => { const pn = this.pane(); return x >= 0 && y >= 0 && x < pn.w && y < pn.h; };
      this.box.addEventListener("pointerdown", e => {
        if (e.button !== 0) return;
        const { x, y } = loc(e); if (!inPane(x, y)) return;
        for (const h of this.app.handlers) { if (h.down && h.down(this, x, y, e)) { this.grab = h; e.preventDefault(); e.stopPropagation(); return; } }
      }, true);
      this.box.addEventListener("mousedown", e => { if (this.grab) { e.preventDefault(); e.stopPropagation(); } }, true);
      window.addEventListener("pointermove", e => {
        const { x, y } = loc(e);
        if (this.grab) { e.preventDefault(); e.stopPropagation(); if (this.grab.move) this.grab.move(this, x, y, e); return; }
        if (e.target && !this.box.contains(e.target)) return;
        let cur = "";
        if (inPane(x, y)) { for (const h of this.app.handlers) { const c = h.hover && h.hover(this, x, y, e); if (c) { cur = c; break; } } if (!cur) cur = this.app.defaultCursor(); }
        if (cur !== this._cur) { this._cur = cur; this.box.style.cursor = cur; }
      }, true);
      window.addEventListener("pointerup", e => {
        if (!this.grab) return;
        const { x, y } = loc(e), h = this.grab; this.grab = null; e.stopPropagation();
        if (h.up) h.up(this, x, y, e);
      }, true);
      this.box.addEventListener("wheel", e => {                 // Shift + wheel: the chart slides left / right instead of zooming
        if (!e.shiftKey) return;
        e.preventDefault(); e.stopPropagation();
        const ts = this.chart.timeScale(), d = (e.deltaY || e.deltaX), bars = d / Math.max(1, ts.options().barSpacing);
        ts.scrollToPosition(ts.scrollPosition() + bars, false);
      }, { capture: true, passive: false });
      this.box.addEventListener("dblclick", e => {
        const { x, y } = loc(e); if (!inPane(x, y)) return;
        for (const h of this.app.handlers) if (h.dbl && h.dbl(this, x, y, e)) { e.preventDefault(); e.stopPropagation(); return; }
      }, true);
      this.box.addEventListener("contextmenu", e => {
        e.preventDefault();
        const { x, y } = loc(e);
        this.app.contextMenu(this, x, y, e, inPane(x, y));
      });
      new ResizeObserver(() => this.redraw()).observe(this.box);
    }
    setCross(c) {                                               // the crosshair of another pane, at its time and price
      if (!c || c.t == null || !this.BARS.length) { this._syncing = true; this.chart.clearCrosshairPosition(); this._syncing = false; if (!this.crossOwn) { this.cross = null; this.legendValues(); } return; }
      const i = this.idxOf(c.t); if (i < 0) return;
      this._syncing = true;
      try { this.chart.setCrosshairPosition(c.p != null ? c.p : this.BARS[i].c, this.BARS[i].t, this.series); } catch (e) {}
      this._syncing = false;
    }
    applyScale() {
      const s = this.cfg.scale || {};
      this.chart.priceScale("right").applyOptions({ mode: s.log ? 1 : s.pct ? 2 : 0, autoScale: s.auto !== false });
    }
    fit() { this.cfg.scale = Object.assign({}, this.cfg.scale, { auto: true }); this.applyScale(); const n = this.BARS.length; this.chart.timeScale().setVisibleLogicalRange({ from: n - VIEWN(this.cfg.tf), to: n + 12 }); this.app.saveLayout(); }
    snapshot() {
      const c = this.chart.takeScreenshot(), out = document.createElement("canvas"); out.width = c.width; out.height = c.height;
      const g = out.getContext("2d"); g.drawImage(c, 0, 0);
      const k = c.width / Math.max(1, this.box.clientWidth), label = `${this.inst || ""} · ${TV.tfName(this.cfg.tf)} · ${this.lastT != null ? RC.fmtFull(this.lastT) : ""}`;
      g.save(); g.scale(k, k); g.font = "500 13px " + getComputedStyle(document.body).getPropertyValue("--font"); const w = g.measureText(label).width + 16;
      g.fillStyle = "rgba(0,0,0,0.65)"; g.fillRect(6, 6, w, 22); g.fillStyle = "#e6e6e6"; g.fillText(label, 14, 21); g.restore();
      return out;
    }
    destroy() { this.studies.destroy(); this.chart.remove(); this.el.remove(); }
  }
  TV.Chart = Chart;
})();
