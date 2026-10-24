/* ui.js - what every module of tv.html shares: the namespace TV, a small store in localStorage, an event bus,
 * number formats, the instrument table, the icons (28 px line icons in TradingView's manner), menus, dialogs, the
 * colour picker with TradingView's palette, forms for settings and toasts. */
(function () {
  const TV = window.TV = {};

  // ---------------------------------------------------------------- DOM
  TV.$ = (s, r) => (r || document).querySelector(s);
  TV.$$ = (s, r) => [...(r || document).querySelectorAll(s)];
  TV.el = function (tag, a, ...kids) {
    const [name, ...cls] = tag.split(".");
    const e = document.createElement(name || "div");
    if (cls.length) e.className = cls.join(" ");
    if (a) for (const k in a) {
      const v = a[k];
      if (v == null || v === false) continue;
      if (k === "text") e.textContent = v;
      else if (k === "html") e.innerHTML = v;
      else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
      else if (k === "class") e.className += " " + v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(e.dataset, v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return e;
  };

  // ---------------------------------------------------------------- store and bus
  TV.store = {
    get(k, d) { try { const v = localStorage.getItem("tv." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("tv." + k, JSON.stringify(v)); } catch (e) {} },
  };
  const subs = {};
  TV.on = (n, fn) => (subs[n] = subs[n] || []).push(fn);
  TV.emit = (n, ...a) => { for (const fn of subs[n] || []) { try { fn(...a); } catch (e) { console.error(e); } } };

  // ---------------------------------------------------------------- instruments (as server/broker.py)
  TV.SPECS = {
    ES: { tick: 0.25, pv: 50, name: "E-mini S&P 500" }, MES: { tick: 0.25, pv: 5, name: "Micro E-mini S&P 500" },
    NQ: { tick: 0.25, pv: 20, name: "E-mini Nasdaq-100" }, MNQ: { tick: 0.25, pv: 2, name: "Micro E-mini Nasdaq-100" },
    YM: { tick: 1, pv: 5, name: "E-mini Dow" }, MYM: { tick: 1, pv: 0.5, name: "Micro E-mini Dow" },
    RTY: { tick: 0.1, pv: 50, name: "E-mini Russell 2000" }, M2K: { tick: 0.1, pv: 5, name: "Micro E-mini Russell 2000" },
    CL: { tick: 0.01, pv: 1000, name: "Crude Oil" }, MCL: { tick: 0.01, pv: 100, name: "Micro Crude Oil" },
    GC: { tick: 0.1, pv: 100, name: "Gold" }, MGC: { tick: 0.1, pv: 10, name: "Micro Gold" },
  };
  TV.spec = inst => TV.SPECS[inst] || { tick: 0.25, pv: 50, name: inst };
  TV.setSpecs = specs => { for (const r in specs) TV.SPECS[r] = { tick: specs[r].tick, pv: specs[r].pv, name: specs[r].name }; TV.TICK = TV.spec(TV.app && TV.app.inst ? TV.app.inst() : "ES").tick; };
  TV.TICK = 0.25;                                        // the active instrument's tick (the server's specs.py; kept current by app.js)

  // ---------------------------------------------------------------- numbers
  TV.dec = tick => { const t = tick || 0.25; for (let d = 0; d <= 7; d++) if (Math.abs(Math.round(t * 10 ** d) - t * 10 ** d) < 1e-9) return d; return 7; };   // decimals a tick needs (0.25 → 2, 0.01 → 2, 0.1 → 1, 1/64 → 7)
  TV.fp = (p, tick) => p == null || !isFinite(p) ? "–" : (+p).toFixed(TV.dec(tick || TV.TICK));
  TV.fv = v => { v = +v || 0; const a = Math.abs(v); return a >= 1e6 ? (v / 1e6).toFixed(2) + "M" : a >= 1e4 ? (v / 1e3).toFixed(1) + "K" : a >= 1e3 ? (v / 1e3).toFixed(2) + "K" : String(Math.round(v)); };
  const usd = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  TV.fusd = (v, sign) => (sign && v > 0 ? "+" : v < 0 ? "−" : "") + usd.format(Math.abs(v || 0)) + " $";
  TV.fdur = s => { s = Math.max(0, Math.round(s)); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return d ? `${d}T ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`; };
  TV.clock = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60, p = n => String(n).padStart(2, "0");
    return h ? `${p(h)}:${p(m)}:${p(x)}` : `${p(m)}:${p(x)}`; };

  // ---------------------------------------------------------------- colours
  TV.parseColor = function (c) {
    if (!c) return { r: 0, g: 0, b: 0, a: 1 };
    if (c[0] === "#") { const h = c.length === 4 ? c.slice(1).split("").map(x => x + x).join("") : c.slice(1, 7); const n = parseInt(h, 16);
      return { r: n >> 16 & 255, g: n >> 8 & 255, b: n & 255, a: c.length === 9 ? parseInt(c.slice(7, 9), 16) / 255 : 1 }; }
    const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return { r: 0, g: 0, b: 0, a: 1 };
    const p = m[1].split(",").map(x => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  TV.rgba = (c, a) => { const x = TV.parseColor(c); return `rgba(${x.r},${x.g},${x.b},${a == null ? x.a : a})`; };
  TV.alphaOf = c => TV.parseColor(c).a;
  TV.hex = c => { const x = TV.parseColor(c); return "#" + [x.r, x.g, x.b].map(v => Math.round(v).toString(16).padStart(2, "0")).join(""); };
  const mix = (a, b, f) => { const x = TV.parseColor(a), y = TV.parseColor(b); return TV.hex(`rgb(${x.r + (y.r - x.r) * f},${x.g + (y.g - x.g) * f},${x.b + (y.b - x.b) * f})`); };
  const BASE = ["#f23645", "#ff9800", "#ffeb3b", "#4caf50", "#089981", "#00bcd4", "#2962ff", "#673ab7", "#9c27b0", "#e91e63"];
  TV.PALETTE = [["#ffffff", "#d1d4dc", "#b2b5be", "#9598a1", "#787b86", "#5d606b", "#434651", "#2a2e39", "#131722", "#000000"], BASE]
    .concat([0.8, 0.6, 0.4, 0.2].map(f => BASE.map(c => mix(c, "#ffffff", f))))
    .concat([0.25, 0.5].map(f => BASE.map(c => mix(c, "#000000", f))));

  // ---------------------------------------------------------------- icons (28 x 28, 1 px lines)
  const S = (inner, vb) => `<svg width="28" height="28" viewBox="${vb || "0 0 28 28"}" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const dot = (x, y) => `<circle cx="${x}" cy="${y}" r="2" fill="var(--panel)"/>`;
  const I = TV.ICONS = {
    book: S(`<path d="M7 5h12a2 2 0 0 1 2 2v16H9a2 2 0 0 1-2-2z"/><path d="M7 5v16a2 2 0 0 0 2 2M11 9h7M11 13h7"/>`),
    cross: S(`<path d="M14 5v18M5 14h18"/>`),
    dot: S(`<circle cx="14" cy="14" r="2.5" fill="currentColor"/>`),
    arrow: S(`<path d="M10 6.5v14l3.6-3.6 2.6 5.8 2.2-1-2.6-5.7h5.1z"/>`),
    eraser: S(`<path d="M7.5 18.5l9-9.5 5 5-7 7.5h-4.5z"/><path d="M12 13.5l5 5M14.5 21.5h7"/>`),
    trend: S(`<path d="M8 20L20 8"/>${dot(7, 21)}${dot(21, 7)}`),
    ray: S(`<path d="M8 20L24 4"/>${dot(7, 21)}${dot(15, 13)}`),
    extended: S(`<path d="M3 25L25 3"/>${dot(10, 18)}${dot(18, 10)}`),
    hline: S(`<path d="M4 14h20"/>${dot(14, 14)}`),
    hray: S(`<path d="M10 14h15"/>${dot(8, 14)}`),
    vline: S(`<path d="M14 4v20"/>${dot(14, 14)}`),
    crossline: S(`<path d="M14 4v20M4 14h20"/>${dot(14, 14)}`),
    channel: S(`<path d="M5 17L17 5M11 23L23 11"/><path d="M8 20l12-12" stroke-dasharray="2 2"/>${dot(5, 17)}${dot(17, 5)}${dot(23, 11)}`),
    fib: S(`<path d="M4 6h20M4 11h20M4 16h20M4 22h20"/><path d="M6 22L22 6" stroke-dasharray="2 2"/>`),
    rect: S(`<rect x="6" y="8" width="16" height="12" rx="0.5"/>${dot(6, 8)}${dot(22, 20)}`),
    brush: S(`<path d="M5 21c3-1 3-5 6-6s4 2 6 0 2-6 6-7"/><circle cx="5" cy="21" r="1.2" fill="currentColor"/>`),
    highlighter: S(`<path d="M16.5 5.5l6 6-9 9h-6v-6z"/><path d="M7.5 14.5l6 6M5 23.5h7"/><path d="M13 9l6 6" opacity=".6"/>`),
    arrowline: S(`<path d="M6 22L21 7"/><path d="M14 7h7v7"/>`),
    text: S(`<path d="M8 7.5h12M14 7.5V22M11.5 22h5"/>`),
    note: S(`<path d="M5 6.5h18v11H13l-4.5 4v-4H5z"/><path d="M9 10.5h10M9 13.5h6"/>`),
    pricelabel: S(`<path d="M5 9.5h12.5l5 4.5-5 4.5H5z"/><path d="M8 14h7"/>`),
    long: S(`<rect x="6" y="5" width="16" height="9" fill="rgba(8,153,129,.35)" stroke="none"/><rect x="6" y="14" width="16" height="9" fill="rgba(242,54,69,.35)" stroke="none"/><path d="M6 14h16"/><path d="M14 11V7m-2 2l2-2 2 2"/>`),
    short: S(`<rect x="6" y="5" width="16" height="9" fill="rgba(242,54,69,.35)" stroke="none"/><rect x="6" y="14" width="16" height="9" fill="rgba(8,153,129,.35)" stroke="none"/><path d="M6 14h16"/><path d="M14 17v4m-2-2l2 2 2-2"/>`),
    pricerange: S(`<path d="M6 6h16M6 22h16M14 8v12"/><path d="M11.5 10.5L14 8l2.5 2.5M11.5 17.5L14 20l2.5-2.5"/>`),
    daterange: S(`<path d="M6 6v16M22 6v16M8 14h12"/><path d="M10.5 11.5L8 14l2.5 2.5M17.5 11.5L20 14l-2.5 2.5"/>`),
    datepricerange: S(`<rect x="6" y="6" width="16" height="16" stroke-dasharray="2 2"/><path d="M9 19L19 9"/><path d="M14 9h5v5"/>`),
    frvp: S(`<path d="M6 5v18"/><path d="M6 7h6M6 10h10M6 13h14M6 16h9M6 19h5M6 22h3" stroke-width="2"/>`),
    ruler: S(`<path d="M4.5 18.5l14-14 5 5-14 14z"/><path d="M8 15l2 2M11 12l3 3M14 9l2 2M17 6l3 3"/>`),
    zoom: S(`<circle cx="12" cy="12" r="6.5"/><path d="M17 17l6 6M9.5 12h5M12 9.5v5"/>`),
    magnet: S(`<path d="M8 6v8a6 6 0 0012 0V6h-4v8a2 2 0 01-4 0V6z"/><path d="M8 9h4M16 9h4"/>`),
    staydraw: S(`<path d="M7 21l1-4 10-10 3 3-10 10z"/><path d="M15.5 9.5l3 3"/><rect x="17" y="18" width="7" height="5" rx="1"/><path d="M18.5 18v-1.5a2 2 0 014 0V18"/>`),
    lock: S(`<rect x="8" y="12.5" width="12" height="9" rx="1.5"/><path d="M10.5 12.5V10a3.5 3.5 0 017 0v2.5"/>`),
    unlock: S(`<rect x="8" y="12.5" width="12" height="9" rx="1.5"/><path d="M10.5 12.5V10a3.5 3.5 0 016.8-1.2"/>`),
    eye: S(`<path d="M4 14s4-6.5 10-6.5S24 14 24 14s-4 6.5-10 6.5S4 14 4 14z"/><circle cx="14" cy="14" r="3"/>`),
    eyeoff: S(`<path d="M4 14s4-6.5 10-6.5S24 14 24 14s-4 6.5-10 6.5S4 14 4 14z"/><circle cx="14" cy="14" r="3"/><path d="M5 23L23 5"/>`),
    trash: S(`<path d="M7 9h14M11.5 9V7h5v2M9 9l1 13h8l1-13M12.5 12v7M15.5 12v7"/>`),
    gear: S(`<path d="M22.37 10.69 L23.00 13.85 L20.97 13.36 L20.19 17.26 L22.26 17.58 L20.47 20.26 L19.38 18.48 L16.08 20.69 L17.31 22.37 L14.15 23.00 L14.64 20.97 L10.74 20.19 L10.42 22.26 L7.74 20.47 L9.52 19.38 L7.31 16.08 L5.63 17.31 L5.00 14.15 L7.03 14.64 L7.81 10.74 L5.74 10.42 L7.53 7.74 L8.62 9.52 L11.92 7.31 L10.69 5.63 L13.85 5.00 L13.36 7.03 L17.26 7.81 L17.58 5.74 L20.26 7.53 L18.48 8.62 L20.69 11.92Z"/><circle cx="14" cy="14" r="3"/>`),
    camera: S(`<path d="M5 10h4l2-3h6l2 3h4v11H5z"/><circle cx="14" cy="15" r="3.5"/>`),
    full: S(`<path d="M6 11V6h5M17 6h5v5M22 17v5h-5M11 22H6v-5"/>`),
    layout: S(`<rect x="5" y="6" width="18" height="16" rx="1"/><path d="M14 6v16M5 14h18"/>`),
    candles: S(`<path d="M10 5v4M10 19v4M18 7v3M18 18v3"/><rect x="8" y="9" width="4" height="10" fill="currentColor"/><rect x="16" y="10" width="4" height="8"/>`),
    hollow: S(`<path d="M10 5v4M10 19v4M18 7v3M18 18v3"/><rect x="8" y="9" width="4" height="10"/><rect x="16" y="10" width="4" height="8" fill="currentColor"/>`),
    bars: S(`<path d="M10 6v16M7 9h3M10 18h3M18 8v13M15 12h3M18 17h3"/>`),
    line: S(`<path d="M4 20l6-7 5 4 9-11"/>`),
    area: S(`<path d="M4 20l6-7 5 4 9-11v17H4z" fill="currentColor" fill-opacity=".25"/>`),
    heikin: S(`<path d="M10 6v3M10 19v3M18 6v4M18 18v4"/><rect x="8" y="9" width="4" height="10" rx="1"/><rect x="16" y="10" width="4" height="8" rx="1" fill="currentColor"/>`),
    footprint: S(`<path d="M8 5v18"/><rect x="6.5" y="9" width="3" height="9" fill="currentColor"/><path d="M12 8h4M18 8h4M12 11h5M18 11h3M12 14h3M18 14h5M12 17h4M18 17h2M12 20h2M18 20h3" stroke-width="1.6"/>`),
    folder: S(`<path d="M4.5 8.5V21h19V10.5H13l-2-2z"/><path d="M4.5 8.5V7h6l2 1.5"/>`),
    datawin: S(`<rect x="5" y="6" width="18" height="16" rx="1.5"/><path d="M5 10.5h18M9 14h4M15 14h4M9 17.5h4M15 17.5h4"/>`),
    tpo: S(`<path d="M6 6v16"/><path d="M8 8h3M8 11h7M8 14h11M8 17h6M8 20h3" stroke-width="2"/>`),
    fx: S(`<path d="M12.5 7.5c-2 0-2.5 1-2.8 3l-1.6 10c-.3 1.8-.9 2.5-2.6 2.5M7 12h6M15 12l6 8M21 12l-6 8"/>`),
    replay: S(`<path d="M6 14a8 8 0 108-8"/><path d="M6 8v6h6" /><path d="M12 11v6l5-3z" fill="currentColor"/>`),
    undo: S(`<path d="M9 11h9a5 5 0 010 10h-6"/><path d="M12 7l-4 4 4 4"/>`),
    redo: S(`<path d="M19 11h-9a5 5 0 000 10h6"/><path d="M16 7l4 4-4 4"/>`),
    search: S(`<circle cx="12.5" cy="12.5" r="6"/><path d="M17 17l5 5"/>`),
    down: S(`<path d="M10 12l4 4 4-4"/>`, "0 0 28 28"), up: S(`<path d="M10 16l4-4 4 4"/>`, "0 0 28 28"),
    close: S(`<path d="M8 8l12 12M20 8L8 20"/>`),
    plus: S(`<path d="M14 7v14M7 14h14"/>`),
    play: S(`<path d="M10 7.5v13l11-6.5z" fill="currentColor"/>`),
    pause: S(`<path d="M10 7v14M18 7v14" stroke-width="2.5"/>`),
    stepf: S(`<path d="M8 8v12l8-6z" fill="currentColor"/><path d="M19 8v12" stroke-width="2"/>`),
    stepb: S(`<path d="M20 8v12l-8-6z" fill="currentColor"/><path d="M9 8v12" stroke-width="2"/>`),
    start: S(`<path d="M8 7v14" stroke-width="2"/><path d="M21 8v12l-8-6z" fill="currentColor"/>`),
    next: S(`<path d="M7 8v12l7-6zM14 8v12l7-6z" fill="currentColor"/>`),
    cal: S(`<rect x="5.5" y="7" width="17" height="15" rx="1.5"/><path d="M5.5 11.5h17M10 5v4M18 5v4M9 15h2M13 15h2M17 15h2M9 18h2M13 18h2"/>`),
    left: S(`<path d="M16 8l-6 6 6 6"/>`), right: S(`<path d="M12 8l6 6-6 6"/>`),
    trade: S(`<path d="M5 19l5-5 4 3 9-9"/><path d="M17 8h6v6"/>`),
    tree: S(`<path d="M6 7h6M9 7v14M9 12h6M9 17h6"/><rect x="15" y="10" width="7" height="4" rx="1"/><rect x="15" y="15" width="7" height="4" rx="1"/>`),
    kbd: S(`<rect x="4" y="8" width="20" height="12" rx="2"/><path d="M8 12h1M12 12h1M16 12h1M20 12h0M9 16h10"/>`),
    more: S(`<circle cx="8" cy="14" r="1.3" fill="currentColor"/><circle cx="14" cy="14" r="1.3" fill="currentColor"/><circle cx="20" cy="14" r="1.3" fill="currentColor"/>`),
    grip: S(`<circle cx="11" cy="8" r="1.2" fill="currentColor"/><circle cx="17" cy="8" r="1.2" fill="currentColor"/><circle cx="11" cy="14" r="1.2" fill="currentColor"/><circle cx="17" cy="14" r="1.2" fill="currentColor"/><circle cx="11" cy="20" r="1.2" fill="currentColor"/><circle cx="17" cy="20" r="1.2" fill="currentColor"/>`),
    clone: S(`<rect x="9" y="9" width="12" height="12" rx="1"/><path d="M7 18V7h11"/>`),
    order: S(`<path d="M5 14h18" stroke-dasharray="3 2"/><rect x="5" y="10" width="9" height="8" rx="1"/>`),
    flag: S(`<path d="M8 23V6M8 7h11l-3 4 3 4H8"/>`),
    bell: S(`<path d="M9 19V13a5 5 0 0110 0v6l2 2H7zM12 23h4"/>`),
    help: S(`<circle cx="14" cy="14" r="9"/><path d="M11.5 11.5a2.5 2.5 0 115 .3c0 1.7-2.5 2-2.5 3.7M14 19v.5"/>`),
    sun: S(`<circle cx="14" cy="14" r="4"/><path d="M14 4v3M14 21v3M4 14h3M21 14h3M7 7l2 2M19 19l2 2M7 21l2-2M19 9l2-2"/>`),
  };
  TV.icon = (n, cls) => { const s = document.createElement("span"); s.className = "ico" + (cls ? " " + cls : ""); s.innerHTML = I[n] || ""; s.style.display = "inline-flex"; return s; };
  TV.iconSm = (n, px) => { const s = TV.icon(n); const svg = s.firstChild; if (svg) { svg.setAttribute("width", px || 18); svg.setAttribute("height", px || 18); } return s; };

  // ---------------------------------------------------------------- menus
  let openMenu = null;
  TV.closeMenus = () => { if (openMenu) { const m = openMenu; openMenu = null; m.remove(); if (m._onClose) m._onClose(); } };
  /* items: {label, icon, hint, checked, on, disabled, action, sep, head, color, keep} */
  TV.menu = function (at, items, opt) {
    TV.closeMenus();
    opt = opt || {};
    const m = TV.el("div.menu" + (opt.cls ? "." + opt.cls : ""));
    const anyIcon = items.some(it => it && (it.icon || it.swatch));
    for (const it of items) {
      if (!it) continue;
      if (it.sep) { m.append(TV.el("div.ms")); continue; }
      if (it.head) { m.append(TV.el("div.mh", { text: it.head })); continue; }
      const row = TV.el("div.mi" + (it.disabled ? ".dis" : "") + (it.on ? ".on" : ""));
      if (opt.checks) row.append(TV.el("span.ck", { text: it.checked ? "✓" : "" }));
      if (it.icon) { const ic = TV.el("span.ic"); ic.append(typeof it.icon === "string" && I[it.icon] ? TV.icon(it.icon) : it.icon); row.append(ic); }
      else if (it.swatch) row.append(TV.el("span.ic", null, TV.el("i", { style: { width: "14px", height: "14px", borderRadius: "3px", background: it.swatch, display: "block" } })));
      else if (anyIcon) row.append(TV.el("span.ic"));
      const lb = TV.el("span.lb", { text: it.label }); if (it.color) lb.style.color = it.color; row.append(lb);
      if (it.hint) row.append(TV.el("span.hk", { text: it.hint }));
      row.addEventListener("mousedown", e => e.stopPropagation());
      row.addEventListener("click", e => { e.stopPropagation(); if (!it.keep) TV.closeMenus(); if (it.action) it.action(e); });
      m.append(row);
    }
    document.body.append(m);
    let x, y;
    if (at instanceof Element) { const r = at.getBoundingClientRect(); x = opt.right ? r.right : opt.side ? r.right + 4 : r.left; y = opt.side ? r.top : r.bottom + 4; if (opt.right) x -= m.offsetWidth; }
    else { x = at.x; y = at.y; }
    const W = innerWidth, H = innerHeight;
    if (x + m.offsetWidth > W - 4) x = Math.max(4, W - m.offsetWidth - 4);
    if (y + m.offsetHeight > H - 4) y = Math.max(4, (at instanceof Element ? at.getBoundingClientRect().top - m.offsetHeight - 4 : H - m.offsetHeight - 4));
    m.style.left = x + "px"; m.style.top = y + "px";
    m.addEventListener("mousedown", e => e.stopPropagation());
    m._onClose = opt.onClose;
    openMenu = m;
    return m;
  };
  window.addEventListener("mousedown", () => TV.closeMenus());
  window.addEventListener("blur", () => TV.closeMenus());
  window.addEventListener("keydown", e => { if (e.key === "Escape" && openMenu) { TV.closeMenus(); e.stopImmediatePropagation(); } }, true);

  // ---------------------------------------------------------------- dialogs
  let dlgOpen = 0;
  TV.dialogOpen = () => dlgOpen > 0;
  TV.dialog = function (o) {
    TV.closeMenus();
    const veil = TV.el("div.veil"), d = TV.el("div.dlg");
    if (o.width) d.style.width = o.width + "px";
    const close = () => { if (!veil.isConnected) return; veil.remove(); dlgOpen--; document.removeEventListener("keydown", key, true); if (o.onClose) o.onClose(); };
    const head = TV.el("div.dh", null, TV.el("span", { text: o.title || "" }), TV.el("button.dx", { title: "Close", onclick: close }, TV.icon("close")));
    d.append(head);
    const body = TV.el("div.db");
    if (o.tabs) {
      const bar = TV.el("div.dtabs"); let cur = o.tab || 0;
      const show = i => { cur = i; bar.querySelectorAll("button").forEach((b, k) => b.classList.toggle("on", k === i)); body.replaceChildren(); o.tabs[i].render(body); };
      o.tabs.forEach((t, i) => bar.append(TV.el("button", { text: t.name, onclick: () => show(i) })));
      d.append(bar, body); show(cur);
    } else if (o.body) { if (o.pad === false) body.style.padding = "0"; d.append(body); o.body(body, close); }
    if (o.buttons && o.buttons.length) {
      const f = TV.el("div.df");
      for (const b of o.buttons) f.append(TV.el("button.btn" + (b.kind ? "." + b.kind : ""), { text: b.label, onclick: () => { if (b.action && b.action() === false) return; if (b.close !== false) close(); } }));
      d.append(f);
    }
    veil.append(d);
    veil.addEventListener("mousedown", e => { if (e.target === veil) close(); });
    const key = e => { if (e.key === "Escape") { e.stopImmediatePropagation(); e.preventDefault(); close(); } else if (e.key === "Enter" && o.enter && !(e.target && e.target.tagName === "TEXTAREA")) { e.preventDefault(); if (o.enter() !== false) close(); } };
    document.addEventListener("keydown", key, true);
    document.body.append(veil); dlgOpen++;
    const first = d.querySelector("input:not([type=checkbox]):not([type=range]), select"); if (first && o.focus !== false) setTimeout(() => first.focus(), 0);
    return { close, el: d, body };
  };

  // ---------------------------------------------------------------- the colour picker (TradingView's grid, opacity)
  TV.pickColor = function (anchor, value, cb, opt) {
    TV.closeMenus();
    opt = opt || {};
    const p = TV.el("div.picker"), grid = TV.el("div.pg");
    let cur = TV.hex(value), a = Math.round(TV.alphaOf(value) * 100);
    const emit = () => cb(a >= 100 ? cur : TV.rgba(cur, a / 100));
    for (const row of TV.PALETTE) for (const c of row) {
      const cell = TV.el("div.pc" + (c.toLowerCase() === cur.toLowerCase() ? ".on" : ""), { style: { background: c }, title: c });
      cell.onclick = () => { cur = c; grid.querySelectorAll(".pc").forEach(x => x.classList.toggle("on", x === cell)); emit(); };
      grid.append(cell);
    }
    p.append(grid);
    if (opt.alpha !== false) {
      const lab = TV.el("span", { text: a + "%" });
      const r = TV.el("input", { type: "range", min: 0, max: 100, value: a, oninput: e => { a = +e.target.value; lab.textContent = a + "%"; emit(); } });
      p.append(TV.el("div.po", null, TV.el("span", { text: "Deckkraft" }), r, lab));
    }
    p.addEventListener("mousedown", e => e.stopPropagation());
    document.body.append(p);
    const rr = anchor.getBoundingClientRect();
    let x = rr.left, y = rr.bottom + 6;
    if (x + p.offsetWidth > innerWidth - 4) x = innerWidth - p.offsetWidth - 4;
    if (y + p.offsetHeight > innerHeight - 4) y = rr.top - p.offsetHeight - 6;
    p.style.left = x + "px"; p.style.top = Math.max(4, y) + "px";
    const off = e => { if (!p.contains(e.target)) { p.remove(); window.removeEventListener("mousedown", off, true); } };
    setTimeout(() => window.addEventListener("mousedown", off, true), 0);
    p._fake = true; openMenu = { remove: () => { p.remove(); window.removeEventListener("mousedown", off, true); } };
    return p;
  };
  TV.swatch = function (value, cb, opt) {
    const i = TV.el("i", { style: { background: value } });
    const b = TV.el("button.swatch", { type: "button" }, i);
    b.onclick = e => { e.stopPropagation(); TV.pickColor(b, value, c => { value = c; i.style.background = c; cb(c); }, opt); };
    return b;
  };

  // ---------------------------------------------------------------- forms: schema -> rows; changes go straight to obj
  TV.form = function (host, schema, obj, changed) {
    for (const f of schema) {
      if (f.show && !f.show(obj)) continue;
      if (f.head) { host.append(TV.el("div.fhead", { text: f.head })); continue; }
      const ctl = TV.el("div.ctl");
      const set = v => { obj[f.key] = v; if (changed) changed(f.key, v); if (f.rerender) f.rerender(); };
      if (f.type === "bool") ctl.append(TV.el("input", { type: "checkbox", checked: !!obj[f.key], onchange: e => set(e.target.checked) }));
      else if (f.type === "num") ctl.append(TV.el("input", { type: "number", value: obj[f.key], min: f.min, max: f.max, step: f.step || 1, onchange: e => { let v = +e.target.value; if (f.min != null) v = Math.max(f.min, v); if (f.max != null) v = Math.min(f.max, v); e.target.value = v; set(v); } }));
      else if (f.type === "text") ctl.append(TV.el("input", { type: "text", value: obj[f.key] || "", style: { width: "100%" }, oninput: e => set(e.target.value) }));
      else if (f.type === "time") {                           // an epoch, shown and edited as New York date and time
        const toLocal = t => { const d = new Date(t * 1000), p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d), g = k => p.find(x => x.type === k).value; return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`; };
        ctl.append(TV.el("input", { type: "datetime-local", value: obj[f.key] ? toLocal(obj[f.key]) : "", onchange: e => { const v = e.target.value; if (!v) return; const [d, hm] = v.split("T"); const t = RC.zoned(d, hm, "America/New_York"); if (t) set(t); } }), TV.el("span", { text: " New York", style: { color: "var(--muted)", marginLeft: "6px" } }));
      }
      else if (f.type === "textarea") ctl.append(TV.el("textarea", { style: { width: "100%", minHeight: "70px", background: "var(--bg)", border: "1px solid var(--line2)", borderRadius: "4px", padding: "6px" }, oninput: e => set(e.target.value) }, obj[f.key] || ""));
      else if (f.type === "select") { const s = TV.el("select", { onchange: e => set(isNaN(+e.target.value) || f.str ? e.target.value : +e.target.value) }); for (const [v, l] of f.options) s.append(TV.el("option", { value: v, text: l, selected: String(obj[f.key]) === String(v) })); ctl.append(s); }
      else if (f.type === "color") ctl.append(TV.swatch(obj[f.key], set, { alpha: f.alpha !== false }));
      if (f.with) for (const w of f.with) {                    // a second control on the same row (colour next to a switch)
        if (w.type === "color") ctl.append(TV.swatch(obj[w.key], v => { obj[w.key] = v; if (changed) changed(w.key, v); }, { alpha: w.alpha !== false }));
        if (w.type === "num") ctl.append(TV.el("input", { type: "number", value: obj[w.key], min: w.min, max: w.max, step: w.step || 1, onchange: e => { obj[w.key] = +e.target.value; if (changed) changed(w.key, +e.target.value); } }));
        if (w.type === "select") { const s = TV.el("select", { onchange: e => { obj[w.key] = isNaN(+e.target.value) || w.str ? e.target.value : +e.target.value; if (changed) changed(w.key, obj[w.key]); } }); for (const [v, l] of w.options) s.append(TV.el("option", { value: v, text: l, selected: String(obj[w.key]) === String(v) })); ctl.append(s); }
      }
      if (f.note) ctl.append(TV.el("span", { text: f.note, style: { color: "var(--muted)", fontSize: "12px" } }));
      host.append(TV.el("div.frow", null, TV.el("label", { text: f.label }), ctl));
    }
  };

  // ---------------------------------------------------------------- toasts
  TV.toast = function (text, kind, ms) {
    const t = TV.el("div.toast" + (kind ? "." + kind : ""), { text });
    TV.$("#toasts").append(t);
    setTimeout(() => t.remove(), ms || 3800);
  };

  // ---------------------------------------------------------------- requests to the server
  TV.tickOf = root => TV.spec(root).tick;
  TV.getJSON = async function (url) {
    const r = await fetch(url, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      // the server was started anew: every run has its own token, the page's is from the run before - reload
      if (r.status === 403 && /token/.test(j.error || "") && !TV._reloading) {
        TV._reloading = true;
        TV.toast("The server was restarted – the page reloads in 3 seconds", "err", 3000);
        setTimeout(() => location.reload(), 3000);
      }
      throw new Error(j.error || ("HTTP " + r.status));
    }
    return j;
  };
  TV.post = async function (url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Replay-Token": window.REPLAY_TOKEN || "" }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      // the server was started anew: every run has its own token, the page's is from the run before - reload
      if (r.status === 403 && /token/.test(j.error || "") && !TV._reloading) {
        TV._reloading = true;
        TV.toast("The server was restarted – the page reloads in 3 seconds", "err", 3000);
        setTimeout(() => location.reload(), 3000);
      }
      throw new Error(j.error || ("HTTP " + r.status));
    }
    return j;
  };
  TV.typing = e => { const t = e.target; return t && (t.isContentEditable || /INPUT|SELECT|TEXTAREA/.test(t.tagName)) && t.type !== "range" && t.type !== "checkbox"; };
})();
