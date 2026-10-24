/* clock-worker.js - one connection to the replay clock for the whole browser. Chrome allows six open connections per
 * host; with a stream per window, a few replay windows would use them up and the next could no longer load. This
 * shared worker keeps the one stream (/api/clock/stream) and hands every change to all replay windows (clock.js). */
let es = null, last = null;
const ports = [];
function start() {
  es = new EventSource("/api/clock/stream");
  es.onmessage = e => { last = e.data; for (const p of ports) p.postMessage(e.data); };
}
onconnect = e => {
  const port = e.ports[0];
  ports.push(port);
  port.onmessage = m => { if (m.data === "bye") { const i = ports.indexOf(port); if (i >= 0) ports.splice(i, 1); } };
  port.start();
  if (!es) start(); else if (last) port.postMessage(last);
};
