/* workspace.js - workspaces, as TradingView's layouts: a named place with its own chart layout and its own drawings
 * per instrument, kept on the server (server/workspaces.py) so every window and device sees the same. Which
 * workspace a window shows is the window's own choice (localStorage), so two windows can show two workspaces.
 *   TV.WS.cur        the current workspace's id
 *   TV.WS.ready()    resolves once the list is loaded and a current one exists (the first run makes "Default" from
 *                    the browser's old layout and drawings)
 *   TV.WS.menu(at)   the top bar's menu: switch, new, rename, duplicate, delete
 *   TV.WS.switch(id) saves nothing here (layout and drawings are saved as they change) - loads the other one */
(function () {
  const W = TV.WS = { cur: TV.store.get("workspace.id", null), list: [], _ready: null };
  const el = TV.el;

  W.ready = function () {
    if (W._ready) return W._ready;
    W._ready = (async () => {
      try { W.list = (await TV.getJSON("/api/workspaces")).workspaces; } catch (e) { W.list = []; }
      if (!W.list.length) {                                   // the first run: the browser's old state becomes "Default"
        const drawings = {};
        for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); const m = /^tv\.draw\.v1\.([A-Za-z0-9]+)$/.exec(k); if (m) { try { drawings[m[1]] = JSON.parse(localStorage.getItem(k)) || []; } catch (e) {} } }
        const w = await TV.post("/api/workspaces", { op: "create", name: "Default", layout: TV.store.get("layout", null) || undefined, drawings });
        W.list = [{ id: w.id, name: w.name, created: w.created, updated: w.updated, drawings: {}, layout: !!w.layout }];
      }
      if (!W.cur || !W.list.some(w => w.id === W.cur)) { W.cur = W.list[0].id; TV.store.set("workspace.id", W.cur); }
    })();
    return W._ready;
  };
  W.current = () => W.list.find(w => w.id === W.cur) || null;
  W.name = () => { const w = W.current(); return w ? w.name : "Workspace"; };
  W.refresh = async () => { try { W.list = (await TV.getJSON("/api/workspaces")).workspaces; } catch (e) {} if (TV.app) TV.app.topState(); };

  W.switch = async function (id) {
    if (id === W.cur) return;
    W.cur = id; TV.store.set("workspace.id", id);
    let w = null;
    try { w = await TV.getJSON("/api/workspaces?id=" + encodeURIComponent(id)); } catch (e) { TV.toast("Workspace: " + e.message, "err"); return; }
    TV.app.layout = w.layout || null;
    TV.app.buildCharts();                                    // the panes, timeframes and indicators of that workspace
    TV.Draw.load(TV.app.inst());                              // and its drawings
    TV.app.topState();
    TV.toast(`Workspace “${w.name}”`, "", 1500);
  };
  W.create = function () {
    const f = { name: "" };
    const dlg = TV.dialog({ title: "New workspace", width: 420, enter: () => go(),
      body: b => TV.form(b, [{ key: "name", label: "Name", type: "text" }, { key: "copy", label: "Take the current layout along", type: "bool" }], f, () => {}),
      buttons: [{ label: "Cancel" }, { label: "Create", kind: "pri", action: () => go() }] });
    async function go() {
      try { const w = await TV.post("/api/workspaces", { op: "create", name: f.name || "Workspace", layout: f.copy ? TV.app.layout : undefined }); dlg.close(); await W.refresh(); await W.switch(w.id); }
      catch (e) { TV.toast(e.message, "err"); return false; }
    }
  };
  W.rename = function () {
    const w = W.current(); if (!w) return;
    const f = { name: w.name };
    const dlg = TV.dialog({ title: "Rename workspace", width: 420, enter: () => go(), body: b => TV.form(b, [{ key: "name", label: "Name", type: "text" }], f, () => {}),
      buttons: [{ label: "Cancel" }, { label: "Rename", kind: "pri", action: () => go() }] });
    async function go() { try { await TV.post("/api/workspaces", { op: "rename", id: w.id, name: f.name }); dlg.close(); await W.refresh(); } catch (e) { TV.toast(e.message, "err"); return false; } }
  };
  W.duplicate = async function () {
    const w = W.current(); if (!w) return;
    try { const d = await TV.post("/api/workspaces", { op: "duplicate", id: w.id, name: w.name + " copy" }); await W.refresh(); await W.switch(d.id); } catch (e) { TV.toast(e.message, "err"); }
  };
  W.remove = function () {
    const w = W.current(); if (!w) return;
    if (W.list.length < 2) { TV.toast("The last workspace stays – create another one first", "err"); return; }
    TV.dialog({ title: "Delete workspace?", width: 420, body: b => b.append(el("div", { text: `“${w.name}” with its layout and all its drawings will be deleted.`, style: { color: "var(--text2)" } })),
      buttons: [{ label: "Cancel" }, { label: "Delete", kind: "pri", action: async () => { await TV.post("/api/workspaces", { op: "delete", id: w.id }); await W.refresh(); await W.switch(W.list[0].id); } }] });
  };
  W.menu = function (at) {
    TV.menu(at, [
      ...W.list.map(w => ({ label: w.name + (Object.values(w.drawings || {}).reduce((a, b) => a + b, 0) ? ` · ${Object.values(w.drawings).reduce((a, b) => a + b, 0)} drawings` : ""), on: w.id === W.cur, action: () => W.switch(w.id) })),
      { sep: true },
      { label: "New workspace …", icon: "plus", action: W.create },
      { label: "Rename …", icon: "text", action: W.rename },
      { label: "Duplicate", icon: "clone", action: W.duplicate },
      { label: "Delete …", icon: "trash", action: W.remove },
    ]);
  };
})();
