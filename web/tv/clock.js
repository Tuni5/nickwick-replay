/* clock.js - the replay clock as every window sees it (RC), and the trade dates of the archive (RP). The clock lives
 * in the server (server/clock.py): a reference point (replay time t at server time wall, speed, playing). Each window
 * computes the time itself, so playing costs no traffic; changes arrive over /api/clock/stream (one stream for the
 * whole browser: clock-worker.js) and go out through POST /api/clock (with the page's token). Several replay windows
 * (one per monitor) therefore run on the same clock.
 * Also here: the time zone of the display (New York or Vienna, switched in one window, switched in all), time
 * formatting, the CME trade date and the session opens of a day. The page sets window.REPLAY_TOKEN. */
(function () {
  const RC = window.RC = {};
  RC.origin = Math.random().toString(36).slice(2, 10);
  RC.state = null;                    // the last state from the server
  let offsetMs = 0;                   // server clock - this clock
  const subs = [];

  RC.now = function () {              // the replay time now, epoch seconds (null: no time set yet)
    const s = RC.state;
    if (!s || s.t == null) return null;
    if (!s.playing) return s.t;
    return s.t + ((Date.now() + offsetMs) / 1000 - s.wall) * s.speed;
  };
  RC.on = fn => { subs.push(fn); if (RC.state) fn(RC.state, false); };
  function take(s) {
    if (s && s.cross) { if (TV.app && TV.app.remoteCross && s.cross.origin !== RC.origin) TV.app.remoteCross(s.cross); return; }   // another window's cursor
    if (s && s.ws) { if (TV.Draw && TV.Draw.remoteChanged) TV.Draw.remoteChanged(s.ws); if (TV.WS) TV.WS.refresh(); return; }       // another window's drawings
    // the server runs on this machine (it listens on 127.0.0.1 only): its clock is this clock, offsetMs stays 0
    RC.state = s;
    const own = s.origin === RC.origin;
    for (const fn of subs) { try { fn(s, own); } catch (e) { console.error(e); } }
  }
  RC.connect = function () {
    if (RC.es || RC.worker) return;
    if ("SharedWorker" in window) {        // one stream for every window of this browser (clock-worker.js)
      try {
        RC.worker = new SharedWorker("/tv/clock-worker.js", { name: "nickwick-clock" });
        RC.worker.port.onmessage = e => { try { take(JSON.parse(e.data)); } catch (x) {} };
        RC.worker.port.start();
        window.addEventListener("pagehide", () => { try { RC.worker.port.postMessage("bye"); } catch (x) {} });
        RC.connected = true;
        return;
      } catch (e) { RC.worker = null; }
    }
    if (!("EventSource" in window)) { poll(); return; }
    RC.es = new EventSource("/api/clock/stream");
    RC.es.onmessage = e => { try { take(JSON.parse(e.data)); } catch (x) {} };
    RC.es.onerror = () => { RC.connected = false; };
    RC.es.onopen = () => { RC.connected = true; };
  };
  async function poll() {               // without EventSource: ask every half second
    try { const r = await fetch("/api/clock", { cache: "no-store" }); if (r.ok) { const s = await r.json(); if (!RC.state || s.rev !== RC.state.rev) take(s); } } catch (e) {}
    setTimeout(poll, 500);
  }
  RC.send = async function (action, extra) {
    const body = Object.assign({ action, origin: RC.origin }, extra || {});
    try {
      const r = await fetch("/api/clock", { method: "POST", headers: { "Content-Type": "application/json", "X-Replay-Token": window.REPLAY_TOKEN || "" },
                                             body: JSON.stringify(body) });
      const s = await r.json();
      if (!r.ok) throw new Error(s.error || r.status);
      take(s);
      return s;
    } catch (e) { RC.error = String(e.message || e); return null; }
  };
  RC.seek = (t, extra) => RC.send("seek", Object.assign({ t }, extra || {}));
  RC.play = on => RC.send(on ? "play" : "pause", { t: RC.now() });
  RC.toggle = () => RC.play(!(RC.state && RC.state.playing));
  RC.speed = v => RC.send("speed", { speed: v, t: RC.now() });

  // ---- screenshots: a picture into the server's screenshot folder (POST /api/screenshot, SCREENSHOT_DIR)
  RC.saveShot = async function (canvas, name) {
    try {
      const r = await fetch("/api/screenshot", { method: "POST", headers: { "Content-Type": "application/json", "X-Replay-Token": window.REPLAY_TOKEN || "" },
                                                 body: JSON.stringify({ name, png: canvas.toDataURL("image/png") }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j;
    } catch (e) { RC.error = String(e.message || e); return null; }
  };
  RC.shotName = function (inst, what) {         // ES_5m_2026-10-08_1230NY.png - the replay time, not the wall clock
    const t = RC.now() != null ? RC.now() : Date.now() / 1000;
    const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t * 1000)).replace(":", "");
    return `${inst || "ES"}_${what}_${RC.tradeDate(t)}_${hm}NY.png`.replace(/[^A-Za-z0-9._-]/g, "-");
  };
  RC.toast = function (el, msg) { if (!el) return; el.textContent = msg; el.classList.add("show"); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), 3500); };

  // ---- time zone of the display: New York or Vienna, the same in every window
  const TZ = { NY: "America/New_York", Wien: "Europe/Vienna" };
  let tz = "NY";
  try { tz = localStorage.getItem("replay.tz") || "NY"; } catch (e) {}
  const tzCh = ("BroadcastChannel" in window) ? new BroadcastChannel("nickwick-replay-tz") : null;
  const tzSubs = [];
  RC.tz = () => tz;
  RC.zone = () => TZ[tz];
  RC.onTz = fn => tzSubs.push(fn);
  RC.setTz = (v, quiet) => {
    if (!TZ[v] || v === tz) return;
    tz = v; try { localStorage.setItem("replay.tz", v); } catch (e) {}
    if (!quiet && tzCh) tzCh.postMessage(v);
    for (const fn of tzSubs) fn(v);
  };
  if (tzCh) tzCh.onmessage = e => RC.setTz(e.data, true);

  const fmts = {};
  const fmt = (opts, zone) => { const k = zone + JSON.stringify(opts); return fmts[k] || (fmts[k] = new Intl.DateTimeFormat("en-GB", Object.assign({ timeZone: zone }, opts))); };
  RC.fmtTime = (t, sec) => fmt({ hour: "2-digit", minute: "2-digit", ...(sec ? { second: "2-digit" } : {}) }, RC.zone()).format(new Date(t * 1000));
  RC.fmtDay = t => fmt({ weekday: "short", day: "2-digit", month: "2-digit", year: "2-digit" }, RC.zone()).format(new Date(t * 1000));
  RC.fmtFull = t => RC.fmtDay(t) + " " + RC.fmtTime(t, true) + " " + (tz === "NY" ? "NY" : "Vienna");
  RC.fmtDate = t => RC.fmtDay(t);
  RC.fmtIso = t => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t * 1000));

  // ---- wall times in a zone, the CME trade date, the opens
  function zoneOffset(t, zone) {        // seconds the zone is ahead of UTC at t
    const p = fmt({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }, zone)
      .formatToParts(new Date(t * 1000)).reduce((a, x) => (a[x.type] = x.value, a), {});
    return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000) - Math.floor(t);
  }
  RC.zoned = function (ymd, hhmm, zone) {   // "2026-09-03", "09:30", "America/New_York" -> epoch seconds
    const [y, m, d] = ymd.split("-").map(Number), [h, mi] = hhmm.split(":").map(Number);
    const guess = Date.UTC(y, m - 1, d, h, mi) / 1000;
    let t = guess - zoneOffset(guess, zone);
    t = guess - zoneOffset(t, zone);        // once more across a switch
    return t;
  };
  RC.nyYmd = t => { const p = fmt({ year: "numeric", month: "2-digit", day: "2-digit" }, TZ.NY).formatToParts(new Date(t * 1000)).reduce((a, x) => (a[x.type] = x.value, a), {}); return `${p.year}-${p.month}-${p.day}`; };
  RC.tradeDate = function (t) {             // 18:00 New York starts the next trade date
    const ymd = RC.nyYmd(t), six = RC.zoned(ymd, "18:00", TZ.NY);
    if (t < six) return ymd;
    const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  };
  RC.opens = function (td) {                // the marks of a trade date, epoch seconds
    const prev = new Date(td + "T12:00:00Z"); prev.setUTCDate(prev.getUTCDate() - 1);
    const p = prev.toISOString().slice(0, 10);
    return {
      session: RC.zoned(p, "18:00", TZ.NY),
      asia: RC.zoned(td, "00:00", TZ.Wien),
      london: RC.zoned(td, "09:00", TZ.Wien),
      ny: RC.zoned(td, "09:30", TZ.NY),
      ib: RC.zoned(td, "10:30", TZ.NY),
      close: RC.zoned(td, "16:00", TZ.NY),
      end: RC.zoned(td, "17:00", TZ.NY),
    };
  };
})();

/* RP - the trade dates of an instrument as the timeline has them (/tl/sessions), and moving the clock between them.
 * Asked again after a minute: in live mode today's session appears. */
(function () {
  const RP = window.RP = {};
  const SESS = {}, AT = {};
  let INSTS = [];
  RP.cached = inst => SESS[inst] || null;                   // the sessions list as last fetched, without waiting (null before the first fetch)
  RP.sessions = async function (inst) {
    if (SESS[inst] && Date.now() - AT[inst] < 60000) return SESS[inst];
    const j = await (await fetch(`/tl/sessions?inst=${encodeURIComponent(inst)}`, { cache: "no-store" })).json();
    INSTS = j.instruments || INSTS;
    if (j.specs) TV.setSpecs(j.specs);                        // the symbols' ticks and point values, from the server
    SESS[inst] = j.sessions || []; AT[inst] = Date.now();
    return SESS[inst];
  };
  RP.instruments = async function () { if (!INSTS.length) await RP.sessions("ES").catch(() => {}); return INSTS; };
  RP.inst = () => (RC.state && RC.state.inst) || INSTS[0] || "ES";
  // the trade date before / after the clock's that has data
  RP.neighbour = async function (dir) {
    const list = await RP.sessions(RP.inst()), t = RC.now(); if (t == null || !list.length) return null;
    const td = RC.tradeDate(t);
    if (dir < 0) { for (let i = list.length - 1; i >= 0; i--) if (list[i].date < td) return list[i]; }
    else { for (const s of list) if (s.date > td) return s; }
    return null;
  };
  // the same wall time (New York) on the other day; before the data starts: its 09:00
  RP.dayJump = async function (dir) {
    const s = await RP.neighbour(dir), t = RC.now(); if (!s) return;
    const off = t - RC.opens(RC.tradeDate(t)).session;
    RC.seek(Math.min(s.end - 60, s.start + Math.max(0, off)));
  };
  RP.goDate = async function (td, at) {
    const o = RC.opens(td);
    RC.seek(at ? o[at] : o.ny - 1800);                    // a day picked from the list: 09:00 New York, before the open
  };
})();
