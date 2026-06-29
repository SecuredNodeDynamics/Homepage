/* =====================================================
   PLEX CONTROLLER WIDGET
   Live sessions + library stats + scan controls
   Group name: PLEX-MEDIA
===================================================== */
(function () {
  const PLX_CONFIG = {
    groupName: "PLEX-MEDIA",
    primaryBaseUrl: "http://YOUR_PLEX_IP:32400",
    fallbackBaseUrl: "https://YOUR_PLEX_TUNNEL_URL", // or null if not using a tunnel
    activeBaseUrl: null,
    token: "YOUR_PLEX_TOKEN",
    primaryHref: "http://YOUR_PLEX_IP:32400/web",
    fallbackHref: "https://YOUR_PLEX_TUNNEL_URL/web",
    pollMs: 30_000,
    debug: false
  };

  let _host = null;
  let _rendering = false;
  let _lastUpdated = null;
  let _sessions = [];
  let _sections = [];
  let _serverName = "Plex";
  const _scanState = {};

  function log(...a) { if (PLX_CONFIG.debug) console.log("[PlexWidget]", ...a); }
  function esc(s = "") {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function normText(v) { return (v || "").replace(/\s+/g, " ").trim(); }

  function getTargets() {
    const targets = [];
    if (PLX_CONFIG.activeBaseUrl) targets.push(PLX_CONFIG.activeBaseUrl);
    if (PLX_CONFIG.primaryBaseUrl && PLX_CONFIG.primaryBaseUrl !== PLX_CONFIG.activeBaseUrl) targets.push(PLX_CONFIG.primaryBaseUrl);
    if (PLX_CONFIG.fallbackBaseUrl && PLX_CONFIG.fallbackBaseUrl !== PLX_CONFIG.activeBaseUrl) targets.push(PLX_CONFIG.fallbackBaseUrl);
    return targets;
  }

  function getCurrentHref() {
    if (PLX_CONFIG.activeBaseUrl === PLX_CONFIG.fallbackBaseUrl && PLX_CONFIG.fallbackHref) return PLX_CONFIG.fallbackHref;
    return PLX_CONFIG.primaryHref || PLX_CONFIG.fallbackHref || "#";
  }

  function tokenPath(path) {
    const joiner = path.includes("?") ? "&" : "?";
    return `${path}${joiner}X-Plex-Token=${encodeURIComponent(PLX_CONFIG.token)}`;
  }

  function mediaArtUrl(item = {}) {
    const artPath = item.thumb || item.grandparentThumb || item.parentThumb || item.art || "";
    if (!artPath) return "";
    const baseUrl = PLX_CONFIG.activeBaseUrl || PLX_CONFIG.primaryBaseUrl || PLX_CONFIG.fallbackBaseUrl || "";
    if (!baseUrl) return "";
    return `${baseUrl}${tokenPath(artPath)}`;
  }

  async function plexFetch(path, options = {}, timeout = 10_000) {
    const targets = getTargets();
    let lastErr = null;

    for (const baseUrl of targets) {
      try {
        const res = await fetch(`${baseUrl}${tokenPath(path)}`, {
          ...options,
          headers: {
            Accept: "application/json",
            ...(options.headers || {})
          },
          signal: AbortSignal.timeout(timeout)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        PLX_CONFIG.activeBaseUrl = baseUrl;
        if (res.status === 204 || res.headers.get("content-length") === "0") return null;
        const ct = res.headers.get("content-type") || "";
        return ct.includes("json") ? res.json() : null;
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr || new Error(`Plex request failed for ${path}`);
  }

  function findGroupContainer() {
    const hd = Array.from(document.querySelectorAll("h2,h3,.group-title,.service-group-name"))
      .find(el => normText(el.textContent) === PLX_CONFIG.groupName);
    if (!hd) return null;
    return hd.closest("section") || hd.closest("div[class*='group']") ||
      hd.parentElement?.parentElement || hd.parentElement;
  }

  function ensureHost(group) {
    let row = group.querySelector(".hp-widget-row, .plex-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "hp-widget-row plex-flex-row";
      group.appendChild(row);
    } else {
      row.classList.add("hp-widget-row", "plex-flex-row");
    }

    let host = row.querySelector(".plex-monitor-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "plex-monitor-host";
    row.appendChild(host);
    return host;
  }

  function fmtMs(ms) {
    if (!ms || ms < 0) return "0:00";
    const total = Math.floor(Number(ms) / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function pct(pos, total) {
    if (!total || total <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round((Number(pos || 0) / Number(total)) * 100)));
  }

  function sectionIcon(type) {
    if (type === "movie") return "🎬";
    if (type === "show") return "📺";
    if (type === "artist") return "🎵";
    if (type === "photo") return "🖼";
    return "📁";
  }

  function normalizeSession(item = {}) {
    const session = item.Session || {};
    const user = item.User || {};
    const player = item.Player || {};
    const title = item.type === "episode"
      ? `${item.grandparentTitle || "Unknown"} · ${item.title || ""}`.replace(/\s+·\s*$/, "")
      : item.title || "Unknown";
    const subtitle = item.type === "episode"
      ? [item.parentTitle, item.year].filter(Boolean).join(" · ")
      : [item.type, item.year].filter(Boolean).join(" · ");

    return {
      id: session.id || item.ratingKey || title,
      sessionId: session.id || "",
      title,
      subtitle,
      user: user.title || user.username || "Unknown user",
      player: player.title || player.product || player.platform || "Unknown player",
      state: (player.state || "").toLowerCase(),
      viewOffset: Number(item.viewOffset || 0),
      duration: Number(item.duration || 0),
      type: item.type || "media",
      transcode: !!item.TranscodeSession,
      artUrl: mediaArtUrl(item)
    };
  }

  async function fetchIdentity() {
    const data = await plexFetch("/");
    const mc = data?.MediaContainer || {};
    _serverName = mc.friendlyName || mc.machineIdentifier || "Plex";
  }

  async function fetchSessions() {
    const data = await plexFetch("/status/sessions");
    const videos = data?.MediaContainer?.Metadata || [];
    return (Array.isArray(videos) ? videos : [videos]).filter(Boolean).map(normalizeSession);
  }

  async function fetchSections() {
    const data = await plexFetch("/library/sections");
    const dirs = data?.MediaContainer?.Directory || [];
    const list = (Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean);
    const enriched = await Promise.all(list.map(async (section) => {
      const key = section.key;
      let count = Number(section.count || 0);
      try {
        const detail = await plexFetch(`/library/sections/${key}/all?X-Plex-Container-Start=0&X-Plex-Container-Size=0`);
        count = Number(detail?.MediaContainer?.totalSize ?? detail?.MediaContainer?.size ?? count);
      } catch (_) { }
      return {
        key,
        title: section.title || "Library",
        type: section.type || "",
        count
      };
    }));
    return enriched;
  }

  async function scanSection(key) {
    _scanState[key] = "scanning";
    updateHost();
    try {
      await plexFetch(`/library/sections/${key}/refresh`, { method: "GET" });
      _scanState[key] = "ok";
    } catch (err) {
      console.warn("[PlexWidget] scan failed:", key, err.message);
      _scanState[key] = "err";
    }
    updateHost();
    setTimeout(() => {
      _scanState[key] = "idle";
      updateHost();
    }, 4000);
  }

  async function scanAll() {
    const keys = _sections.map(s => s.key);
    keys.forEach(key => { _scanState[key] = "scanning"; });
    _scanState.__all__ = "scanning";
    updateHost();
    await Promise.allSettled(keys.map(scanSection));
    _scanState.__all__ = "ok";
    updateHost();
    setTimeout(() => {
      _scanState.__all__ = "idle";
      updateHost();
    }, 4000);
  }

  function buildSessionRow(session) {
    const progress = pct(session.viewOffset, session.duration);
    const status = session.state === "paused" ? "Paused" : session.state === "playing" ? "Playing" : session.state || "Active";
    return `
      <div class="plex-session">
        <div class="plex-session-art">
          ${session.artUrl
        ? `<img src="${esc(session.artUrl)}" alt="" loading="lazy">`
        : `<span>${sectionIcon(session.type)}</span>`}
        </div>
        <div class="plex-session-main">
          <div class="plex-session-top">
            <span class="plex-session-title">${esc(session.title)}</span>
            <span class="plex-badge ${session.state === "paused" ? "plex-badge--paused" : "plex-badge--playing"}">${esc(status)}</span>
          </div>
          <div class="plex-session-sub">${esc(session.subtitle || session.type)} · ${esc(session.user)} · ${esc(session.player)}</div>
          <div class="plex-progress">
            <span style="width:${progress}%"></span>
          </div>
          <div class="plex-session-meta">
            <span>${esc(fmtMs(session.viewOffset))} / ${esc(fmtMs(session.duration))}</span>
            <span>${session.transcode ? "Transcoding" : "Direct"}</span>
          </div>
        </div>
      </div>`;
  }

  function buildSessionsPanel() {
    if (!_sessions.length) return `<div class="plex-empty">No active streams</div>`;
    return `<div class="plex-sessions">${_sessions.map(buildSessionRow).join("")}</div>`;
  }

  function buildLibrariesPanel() {
    if (!_sections.length) return `<div class="plex-empty">No libraries found</div>`;
    return `
      <div class="plex-libraries">
        ${_sections.map(section => {
      const state = _scanState[section.key] || "idle";
      const label = state === "scanning" ? "Scanning" : state === "ok" ? "Done" : state === "err" ? "Failed" : "Scan";
      return `
          <div class="plex-library">
            <div class="plex-library-left">
              <span class="plex-library-icon">${sectionIcon(section.type)}</span>
              <div>
                <div class="plex-library-title">${esc(section.title)}</div>
                <div class="plex-library-sub">${esc(section.type || "library")} · ${Number(section.count || 0).toLocaleString()} items</div>
              </div>
            </div>
            <button class="plex-scan-btn" data-section-key="${esc(section.key)}" ${state === "scanning" ? "disabled" : ""}>${esc(label)}</button>
          </div>`;
    }).join("")}
      </div>`;
  }

  function buildShell() {
    const ts = _lastUpdated
      ? _lastUpdated.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })
      : "Loading";
    const allState = _scanState.__all__ || "idle";
    const allLabel = allState === "scanning" ? "Scanning" : allState === "ok" ? "Done" : "Scan all";
    return `
      <div class="plex-shell">
        <div class="plex-header">
          <div class="plex-header-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/plex.webp" alt="Plex" class="plex-icon">
            <div>
              <div class="plex-title">Plex</div>
              <div class="plex-subtitle">${esc(_serverName)} · ${_sessions.length} active</div>
            </div>
          </div>
          <div class="plex-header-actions">
            <button class="plex-action-btn plex-scan-all" ${allState === "scanning" ? "disabled" : ""}>${esc(allLabel)}</button>
            <a class="plex-open-link" href="${esc(getCurrentHref())}" target="_blank" rel="noopener noreferrer">Open</a>
          </div>
        </div>

        <div class="plex-stats">
          <div class="plex-stat"><span>${_sessions.length}</span><small>Streams</small></div>
          <div class="plex-stat"><span>${_sections.length}</span><small>Libraries</small></div>
          <div class="plex-stat"><span>${_sections.reduce((sum, s) => sum + Number(s.count || 0), 0).toLocaleString()}</span><small>Items</small></div>
        </div>

        <div class="plex-grid">
          <section>
            <div class="plex-section-title">Now Playing</div>
            ${buildSessionsPanel()}
          </section>
          <section>
            <div class="plex-section-title">Libraries</div>
            ${buildLibrariesPanel()}
          </section>
        </div>

        <div class="plex-footer">Updated ${esc(ts)}</div>
      </div>`;
  }

  function buildError(message) {
    return `
      <div class="plex-shell">
        <div class="plex-header">
          <div class="plex-header-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/plex.webp" alt="Plex" class="plex-icon">
            <div>
              <div class="plex-title">Plex</div>
              <div class="plex-subtitle">Connection failed</div>
            </div>
          </div>
          <a class="plex-open-link" href="${esc(getCurrentHref())}" target="_blank" rel="noopener noreferrer">Open</a>
        </div>
        <div class="plex-empty plex-empty--error">${esc(message)}</div>
      </div>`;
  }

  function bind(host) {
    host.querySelector(".plex-scan-all")?.addEventListener("click", scanAll);
    host.querySelectorAll(".plex-scan-btn").forEach(btn => {
      btn.addEventListener("click", () => scanSection(btn.dataset.sectionKey));
    });
  }

  function updateHost() {
    if (!_host) return;
    _host.innerHTML = buildShell();
    bind(_host);
  }

  async function refresh() {
    if (_rendering) return;
    const group = findGroupContainer();
    if (!group) return;
    _host = ensureHost(group);
    _rendering = true;

    try {
      if (!PLX_CONFIG.token || PLX_CONFIG.token === "YOUR_PLEX_TOKEN") {
        _host.innerHTML = buildError("Set your Plex token in PLX_CONFIG.token");
        return;
      }
      if (!_host.querySelector(".plex-shell")) {
        _host.innerHTML = `<div class="plex-shell"><div class="plex-empty">Loading Plex</div></div>`;
      }
      await fetchIdentity().catch(err => log("identity", err.message));
      const [sessions, sections] = await Promise.all([
        fetchSessions(),
        fetchSections()
      ]);
      _sessions = sessions;
      _sections = sections;
      _lastUpdated = new Date();
      updateHost();
    } catch (err) {
      console.error("[PlexWidget]", err);
      if (_host) _host.innerHTML = buildError(err.message || "Failed to load Plex");
    } finally {
      _rendering = false;
    }
  }

  function init() {
    const start = () => {
      setTimeout(refresh, 1600);
      setInterval(() => { if (!document.hidden) refresh(); }, PLX_CONFIG.pollMs);
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }

    new MutationObserver(() => {
      if (!document.querySelector(".plex-monitor-host .plex-shell")) {
        setTimeout(refresh, 500);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
