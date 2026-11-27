// @description Shows viewers of your own Discord stream. Experimental Phoenix port.
// @version 0.1.0-alpha.1
// @author feve
// @gateway ready streamCreate streamUpdate streamDelete voiceStateUpdate
// @discord GET /users/@me
// @stores
// SPDX-License-Identifier: GPL-3.0-or-later
// Experimental: call tiles and voice rows are not implemented.

(function viewerEyes(phoenix) {
  "use strict";
  const validId = v => typeof v === "string" && /^\d{15,20}$/.test(v);
  const parseKey = key => {
    if (typeof key !== "string") return null;
    const p = key.split(":");
    if (p[0] === "guild" && p.length === 4 && p.slice(1).every(validId))
      return { key, guild: p[1], channel: p[2], owner: p[3] };
    if (p[0] === "call" && p.length === 3 && p.slice(1).every(validId))
      return { key, guild: null, channel: p[1], owner: p[2] };
    return null;
  };
  const counts = { streamCreate: 0, streamUpdate: 0, streamDelete: 0, voiceStateUpdate: 0, ready: 0 };
  const available = {};
  let self = null, active = null, viewers = new Set(), known = false;
  let disposed = false, revision = 0, page = null, button = null, decoration = null;
  let opening = 0, identityEpoch = 0;
  const cleanup = [];
  const text = (en, es) => settings.language === "es" ? es : en;
  function closePage() {
    if (page) { try { page.close(); } catch {} page = null; }
  }
  function syncUi(old) {
    revision++;
    if (button) {
      try { button.update({ label: known ? `ViewerEyes · ${viewers.size}` : "ViewerEyes" }); } catch {}
    }
    if (decoration) {
      for (const id of new Set([...old, ...viewers])) {
        try { decoration.update?.(id); } catch {}
      }
    }
  }
  function clear() {
    const old = viewers;
    active = null; viewers = new Set(); known = false;
    closePage();
    syncUi(old);
  }
  function setSelf(id) {
    if (!validId(id)) return;
    if (id !== self) { clear(); self = id; }
  }
  function stream(kind, p) {
    if (disposed || !p || typeof p !== "object") return;
    const info = parseKey(p.stream_key);
    if (!info || !self || info.owner !== self) return;
    if (kind === "streamDelete") {
      if (active?.key === info.key) clear();
      return;
    }
    const old = viewers;
    if (active?.key !== info.key) {
      closePage();
      viewers = new Set(); known = false;
    }
    active = info;
    if (Array.isArray(p.viewer_ids)) {
      viewers = new Set(p.viewer_ids.filter(id => validId(id) && id !== self).slice(0, 250));
      known = true;
    } else if (kind === "streamUpdate") {
      // An incomplete update must never be represented as a confirmed empty audience.
      viewers = new Set(); known = false;
    }
    syncUi(old);
  }
  function voice(p) {
    if (!active || p?.user_id !== self) return;
    if (Object.prototype.hasOwnProperty.call(p, "channel_id") && p.channel_id !== active.channel) clear();
    else if (p.self_stream === false) clear();
  }
  function hook(name, fn) {
    try {
      const sig = phoenix.gateway[name];
      if (!sig) { available[name] = false; return; }
      phoenix.on(sig, p => {
        if (disposed) return;
        counts[name]++;
        try { fn(p); } catch { phoenix.log.warn("ViewerEyes: handler failed", name); }
      });
      available[name] = true;
    } catch { available[name] = false; }
  }
  function status() {
    return [
      `ViewerEyes 0.1.0-alpha.1`,
      `Identity: ${self ? "ready" : "unavailable"}`,
      `Active own stream: ${active ? "yes" : "not observed"}`,
      `Audience: ${known ? viewers.size : "unknown"}`,
      ...Object.keys(counts).map(k => `${k}: ${available[k] ? "available" : "unavailable"}; events=${counts[k]}`),
      `Member decoration: ${decoration ? "enabled (general member/DM list)" : "disabled"}`,
      "Call tiles / voice rows: not implemented"
    ].join("\n");
  }
  const eye = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M12 4C6 4 2.1 9.1 1 12c1.1 2.9 5 8 11 8s9.9-5.1 11-8C21.9 9.1 18 4 12 4Zm0 3a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/></svg>';
  function syncDecoration(on) {
    if (!on && decoration) { try { decoration(); } catch {} decoration = null; }
    if (on && !decoration && typeof phoenix.ui.addMemberDecoration === "function") {
      try {
        decoration = phoenix.ui.addMemberDecoration({
          render: ({ userId }) => known && viewers.has(userId) ?
            { text: "👁", icons: [{ svg: eye, color: 0xffb5bac1 }] } : null
        });
      } catch { phoenix.log.warn("ViewerEyes: member decoration unavailable"); }
    }
  }
  async function cachedName(id, guild) {
    if (!phoenix.stores?.sql) return null;
    const pad = x => x.padStart(20, "0");
    if (guild) {
      try {
        const rows = await phoenix.stores.sql("SELECT CAST(v AS TEXT) AS v FROM members WHERE k = ? LIMIT 1", `${pad(guild)}:${pad(id)}`);
        const m = rows[0] ? JSON.parse(rows[0].v) : null;
        const n = m?.nick || m?.user?.global_name || m?.user?.username;
        if (typeof n === "string" && n) return n.slice(0, 100);
      } catch {}
    }
    return null;
  }
  async function showAudience() {
    const request = ++opening;
    closePage();
    const snapshot = revision;
    const ids = known ? [...viewers] : [];
    const guild = active?.guild;
    let names = [];
    if (ids.length) {
      // Read only the already-cached members of the current stream's guild.
      names = await Promise.all(ids.slice(0, 50).map(async (id, i) =>
        (await cachedName(id, guild)) || text(`Viewer ${i+1} (name not cached)`, `Espectador ${i+1} (nombre no disponible)`)));
    }
    if (disposed || request !== opening) return;
    if (snapshot !== revision) {
      phoenix.ui.toast(text("Audience changed. Open ViewerEyes again.", "La audiencia ha cambiado. Vuelve a abrir ViewerEyes."));
      return;
    }
    let summary = !known ? text("Audience unavailable. Start a new stream after enabling the plugin.", "Audiencia no disponible. Inicia una retransmisión nueva después de activar el plugin.") :
      ids.length ? `${ids.length} ${text("viewers", "espectadores")}` : text("No viewers", "Sin espectadores");
    if (ids.length > names.length) names.push(`+${ids.length - names.length}`);
    page = phoenix.ui.openPage({ title: "ViewerEyes", sections: [
      { type: "text", title: summary, text: names.join("\n") || summary },
      { type: "buttons", buttons: [{ label: text("Refresh", "Actualizar"), onPress: () => { void showAudience(); } }] }
    ] });
  }
  function showDiagnostics() {
    ++opening;
    closePage();
    page = phoenix.ui.openPage({ title: "ViewerEyes · Diagnostics", sections: [
      { type: "code", text: status(), monospace: true },
      { type: "buttons", buttons: [{ label: text("Copy diagnostics", "Copiar diagnóstico"), onPress: () => phoenix.ui.copy(status()) }] }
    ] });
  }
  const settings = phoenix.settings.define({
    language: { type: "select", title: "Language / Idioma", default: "en", options: [{value:"en",label:"English"},{value:"es",label:"Español"}] },
    memberEyes: { type: "switch", title: "Experimental member list eyes / Ojos experimentales", description: "General member/DM list only; not voice rows or call tiles.", default: false, onChange: syncDecoration },
    audience: { type: "button", title: "Open audience / Abrir espectadores", onPress: () => { void showAudience().catch(() => phoenix.ui.toast("ViewerEyes: UI unavailable")); } },
    diagnostics: { type: "button", title: "Diagnostics / Diagnóstico", onPress: showDiagnostics }
  });
  hook("ready", p => { identityEpoch++; clear(); self = null; setSelf(p?.user?.id); });
  hook("streamCreate", p => stream("streamCreate", p));
  hook("streamUpdate", p => stream("streamUpdate", p));
  hook("streamDelete", p => stream("streamDelete", p));
  hook("voiceStateUpdate", voice);
  try {
    const epoch = identityEpoch;
    phoenix.discord.me().then(me => {
      if (!disposed && epoch === identityEpoch) setSelf(me?.id);
    }).catch(() => {});
  } catch {}
  try {
    button = phoenix.ui.addHeaderButton({
      icon: "res://ic_mana_panel_open",
      label: "ViewerEyes",
      onPress(ctx) {
        if (!self) setSelf(ctx?.currentUserId);
        void showAudience().catch(() => phoenix.ui.toast("ViewerEyes: UI unavailable"));
      }
    });
    cleanup.push(() => button?.());
  } catch { phoenix.log.warn("ViewerEyes: header button unavailable"); }
  syncDecoration(settings.memberEyes);
  phoenix.onUnload(() => {
    disposed = true; opening++;
    closePage();
    for (const remove of cleanup) { try { remove(); } catch {} }
    if (decoration) { try { decoration(); } catch {} decoration = null; }
    viewers.clear(); active = null; self = null;
  });
  phoenix.log.info("ViewerEyes 0.1.0-alpha.1 loaded", Object.keys(available).filter(k => available[k]).join(", "));
})(phoenix);
