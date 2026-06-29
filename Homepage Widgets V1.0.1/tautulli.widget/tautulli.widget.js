/* =====================================================
   TAUTULLI MONITOR WIDGET
   Live streams + server/library stats + recent history
   Group name: TAUTULLI-MONITOR
===================================================== */
(function () {
  const TAU_CONFIG = {
    groupName: "TAUTULLI-MONITOR",
    primaryBaseUrl: "http://YOUR_TAUTULLI_IP:8181",
    fallbackBaseUrl: "https://YOUR_TAUTULLI_TUNNEL_URL", // or null
    activeBaseUrl: null,
    apiKey: "YOUR_TAUTULLI_API_KEY",
    primaryHref: "http://YOUR_TAUTULLI_IP:8181",
    fallbackHref: "https://YOUR_TAUTULLI_TUNNEL_URL",
    pollMs: 30_000,
    debug: false
  };

  let _host = null;
  let _rendering = false;
  let _lastUpdated = null;
  let _activity = [];
  let _libraries = [];
  let _history = [];
  let _serverInfo = {};
  let _stats = {};

  function log(...a) { if (TAU_CONFIG.debug) console.log("[TautulliWidget]", ...a); }
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
    if (TAU_CONFIG.activeBaseUrl) targets.push(TAU_CONFIG.activeBaseUrl);
    if (TAU_CONFIG.primaryBaseUrl && TAU_CONFIG.primaryBaseUrl !== TAU_CONFIG.activeBaseUrl) targets.push(TAU_CONFIG.primaryBaseUrl);
    if (TAU_CONFIG.fallbackBaseUrl && TAU_CONFIG.fallbackBaseUrl !== TAU_CONFIG.activeBaseUrl) targets.push(TAU_CONFIG.fallbackBaseUrl);
    return targets;
  }

  function getHref() {
    if (TAU_CONFIG.activeBaseUrl === TAU_CONFIG.fallbackBaseUrl && TAU_CONFIG.fallbackHref) return TAU_CONFIG.fallbackHref;
    return TAU_CONFIG.primaryHref || TAU_CONFIG.fallbackHref || "#";
  }

  async function tauFetch(cmd, params = {}, timeout = 10_000) {
    const qs = new URLSearchParams({
      apikey: TAU_CONFIG.apiKey,
      cmd,
      ...params
    });
    const targets = getTargets();
    let lastErr = null;

    for (const baseUrl of targets) {
      try {
        const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v2?${qs}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(timeout)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json?.response?.result === "error") {
          throw new Error(json?.response?.message || `${cmd} failed`);
        }
        TAU_CONFIG.activeBaseUrl = baseUrl;
        return json?.response?.data ?? json?.response ?? json;
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr || new Error(`Tautulli request failed for ${cmd}`);
  }

  function findGroupContainer() {
    const hd = Array.from(document.querySelectorAll("h2,h3,.group-title,.service-group-name"))
      .find(el => normText(el.textContent) === TAU_CONFIG.groupName);
    if (!hd) return null;
    return hd.closest("section") || hd.closest("div[class*='group']") ||
      hd.parentElement?.parentElement || hd.parentElement;
  }

  function ensureHost(group) {
    let row = group.querySelector(".hp-widget-row, .tau-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "hp-widget-row tau-flex-row";
      group.appendChild(row);
    } else {
      row.classList.add("hp-widget-row", "tau-flex-row");
    }

    let host = row.querySelector(".tau-monitor-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "tau-monitor-host";
    row.appendChild(host);
    return host;
  }

  function num(v) {
    const n = Number(v || 0);
    return Number.isFinite(n) ? n : 0;
  }

  function fmtInt(v) { return num(v).toLocaleString(); }

  function fmtDuration(sec) {
    const s = num(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function mediaIcon(type) {
    const t = String(type || "").toLowerCase();
    if (t.includes("movie")) return "🎬";
    if (t.includes("episode") || t.includes("show")) return "📺";
    if (t.includes("track") || t.includes("artist") || t.includes("album")) return "🎵";
    return "▶";
  }

  function streamState(row) {
    const state = String(row.state || row.player_state || "").toLowerCase();
    if (state.includes("pause")) return { label: "Paused", cls: "tau-badge--paused" };
    if (state.includes("buffer")) return { label: "Buffering", cls: "tau-badge--warn" };
    return { label: "Playing", cls: "tau-badge--playing" };
  }

  function streamTitle(row) {
    if (row.media_type === "episode") {
      return `${row.grandparent_title || row.full_title || "Unknown"} · ${row.title || ""}`.replace(/\s+·\s*$/, "");
    }
    if (row.full_title) return row.full_title;
    return row.title || row.title_sort || "Unknown";
  }

  function streamSubtitle(row) {
    return [
      row.user || row.username || row.friendly_name,
      row.product || row.player,
      row.quality_profile || row.video_full_resolution || row.video_resolution
    ].filter(Boolean).join(" · ");
  }

  function progressPct(row) {
    const progress = num(row.progress_percent);
    if (progress) return Math.max(0, Math.min(100, progress));
    const view = num(row.view_offset);
    const dur = num(row.duration);
    if (!dur) return 0;
    return Math.max(0, Math.min(100, Math.round((view / dur) * 100)));
  }

  async function fetchAll() {
    const [activity, libraries, history, serverInfo, homeStats] = await Promise.all([
      tauFetch("get_activity").catch(() => ({})),
      tauFetch("get_libraries").catch(() => ({})),
      tauFetch("get_history", { length: "8", order_column: "date", order_dir: "desc" }).catch(() => ({})),
      tauFetch("get_server_info").catch(() => ({})),
      tauFetch("get_home_stats", { grouping: "1", time_range: "30" }).catch(() => ({}))
    ]);

    const sessions = activity.sessions || activity.data || [];
    const libs = libraries.data || libraries.libraries || libraries || [];
    const hist = history.data || history.history || history || [];

    _activity = Array.isArray(sessions) ? sessions : [];
    _libraries = Array.isArray(libs) ? libs : [];
    _history = Array.isArray(hist) ? hist : [];
    _serverInfo = serverInfo || {};
    _stats = Array.isArray(homeStats) ? { homeStats } : (homeStats || {});
    _lastUpdated = new Date();
  }

  function buildStats() {
    const streamCount = _activity.length;
    const transcodes = _activity.filter(s => String(s.transcode_decision || s.stream_video_decision || "").toLowerCase().includes("transcode")).length;
    const direct = _activity.filter(s => {
      const d = String(s.transcode_decision || s.stream_video_decision || "").toLowerCase();
      return d.includes("direct") || d.includes("copy");
    }).length;
    const users = new Set(_activity.map(s => s.user || s.username).filter(Boolean)).size;

    return `
      <div class="tau-stats">
        <div class="tau-stat"><span>${fmtInt(streamCount)}</span><small>Streams</small></div>
        <div class="tau-stat"><span>${fmtInt(transcodes)}</span><small>Transcodes</small></div>
        <div class="tau-stat"><span>${fmtInt(direct)}</span><small>Direct</small></div>
        <div class="tau-stat"><span>${fmtInt(users)}</span><small>Users</small></div>
      </div>`;
  }

  function buildActivity() {
    if (!_activity.length) return `<div class="tau-empty">No active Plex streams</div>`;
    return `
      <div class="tau-streams">
        ${_activity.map(row => {
      const state = streamState(row);
      const pct = progressPct(row);
      const decision = row.transcode_decision || row.stream_video_decision || row.stream_decision || "Stream";
      return `
          <div class="tau-stream">
            <div class="tau-stream-icon">${mediaIcon(row.media_type)}</div>
            <div class="tau-stream-body">
              <div class="tau-stream-top">
                <span class="tau-stream-title">${esc(streamTitle(row))}</span>
                <span class="tau-badge ${state.cls}">${esc(state.label)}</span>
              </div>
              <div class="tau-stream-sub">${esc(streamSubtitle(row))}</div>
              <div class="tau-progress"><span style="width:${pct}%"></span></div>
              <div class="tau-stream-meta">
                <span>${esc(decision)}</span>
                <span>${esc(row.bandwidth || row.stream_bandwidth || "")}${row.bandwidth || row.stream_bandwidth ? " kbps" : ""}</span>
              </div>
            </div>
          </div>`;
    }).join("")}
      </div>`;
  }

  function buildLibraries() {
    if (!_libraries.length) return `<div class="tau-empty">No library data</div>`;
    return `
      <div class="tau-libraries">
        ${_libraries.slice(0, 8).map(lib => `
          <div class="tau-library">
            <span>${mediaIcon(lib.section_type || lib.media_type)}</span>
            <div>
              <div class="tau-library-title">${esc(lib.section_name || lib.library_name || lib.name || "Library")}</div>
              <div class="tau-library-sub">${esc(lib.section_type || lib.media_type || "library")} · ${fmtInt(lib.count || lib.parent_count || lib.child_count || 0)} items</div>
            </div>
          </div>`).join("")}
      </div>`;
  }

  function buildHistory() {
    if (!_history.length) return `<div class="tau-empty">No recent history</div>`;
    return `
      <div class="tau-history">
        ${_history.slice(0, 8).map(row => `
          <div class="tau-history-row">
            <span class="tau-history-icon">${mediaIcon(row.media_type)}</span>
            <div class="tau-history-main">
              <div class="tau-history-title">${esc(streamTitle(row))}</div>
              <div class="tau-history-sub">${esc([row.user || row.username, row.date ? new Date(num(row.date) * 1000).toLocaleDateString() : "", row.stopped ? fmtDuration(num(row.stopped) - num(row.started)) : ""].filter(Boolean).join(" · "))}</div>
            </div>
          </div>`).join("")}
      </div>`;
  }

  function buildShell() {
    const ts = _lastUpdated
      ? _lastUpdated.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })
      : "Loading";
    const serverName = _serverInfo.pms_name || _serverInfo.server_name || _serverInfo.friendly_name || "Tautulli";
    return `
      <div class="tau-shell">
        <div class="tau-header">
          <div class="tau-header-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/tautulli.webp" alt="Tautulli" class="tau-icon">
            <div>
              <div class="tau-title">Tautulli</div>
              <div class="tau-subtitle">${esc(serverName)} · Plex analytics</div>
            </div>
          </div>
          <a class="tau-open-link" href="${esc(getHref())}" target="_blank" rel="noopener noreferrer">Open</a>
        </div>

        ${buildStats()}

        <div class="tau-grid">
          <section class="tau-activity-section">
            <div class="tau-section-title">Now Playing</div>
            ${buildActivity()}
          </section>
          <section class="tau-libraries-section">
            <div class="tau-section-title">Libraries</div>
            ${buildLibraries()}
          </section>
          <section class="tau-history-section">
            <div class="tau-section-title">Recent History</div>
            ${buildHistory()}
          </section>
        </div>

        <div class="tau-footer">Updated ${esc(ts)}</div>
      </div>`;
  }

  function buildError(message) {
    return `
      <div class="tau-shell">
        <div class="tau-header">
          <div class="tau-header-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/tautulli.webp" alt="Tautulli" class="tau-icon">
            <div>
              <div class="tau-title">Tautulli</div>
              <div class="tau-subtitle">Connection failed</div>
            </div>
          </div>
          <a class="tau-open-link" href="${esc(getHref())}" target="_blank" rel="noopener noreferrer">Open</a>
        </div>
        <div class="tau-empty tau-empty--error">${esc(message)}</div>
      </div>`;
  }

  function updateHost() {
    if (_host) _host.innerHTML = buildShell();
  }

  async function refresh() {
    if (_rendering) return;
    const group = findGroupContainer();
    if (!group) return;
    _host = ensureHost(group);
    _rendering = true;
    try {
      if (!TAU_CONFIG.apiKey || TAU_CONFIG.apiKey === "YOUR_TAUTULLI_API_KEY") {
        _host.innerHTML = buildError("Set your Tautulli API key in TAU_CONFIG.apiKey");
        return;
      }
      if (!_host.querySelector(".tau-shell")) {
        _host.innerHTML = `<div class="tau-shell"><div class="tau-empty">Loading Tautulli</div></div>`;
      }
      await fetchAll();
      updateHost();
    } catch (err) {
      console.error("[TautulliWidget]", err);
      if (_host) _host.innerHTML = buildError(err.message || "Failed to load Tautulli");
    } finally {
      _rendering = false;
    }
  }

  function init() {
    const start = () => {
      setTimeout(refresh, 1600);
      setInterval(() => { if (!document.hidden) refresh(); }, TAU_CONFIG.pollMs);
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
    new MutationObserver(() => {
      if (!document.querySelector(".tau-monitor-host .tau-shell")) {
        setTimeout(refresh, 500);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
