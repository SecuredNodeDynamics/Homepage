/* =====================================================
   JELLYFIN INJECTED WIDGET
   Fetches sessions + library stats from Jellyfin.
===================================================== */

(function () {
  const JF_CONFIG = {
    primaryBaseUrl: "http://YOUR_LOCAL_IP:PORT",
    fallbackBaseUrl: "https://YOUR_TUNNEL_URL", // or null if not using a tunnel
    activeBaseUrl: null,
    apiKey: "YOUR_API_KEY_HERE",
    primaryHref: "http://YOUR_LOCAL_IP:PORT",
    fallbackHref: "https://YOUR_TUNNEL_URL",
    pollMs: 30_000,
  };

  const GROUP_LABEL = "JELLYFIN - MEDIA";

  let _obsDelay = null;
  let _rendering = false;
  let _sessions = undefined;
  let _counts = undefined;
  let _libraries = undefined;
  let _syncOpen = false;
  let _syncState = {};

  let _messageOpen = {};
  let _messageDrafts = {};
  let _sessionActionState = {};
  let _sessionPlaybackOverride = {};

  let _groupMessageOpen = false;
  let _groupMessageDraft = "";
  let _groupMessageState = null;

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtMs(ms) {
    if (!ms || ms < 0) return "0:00";
    const totalSec = Math.floor(ms / 1e7);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function pct(pos, total) {
    if (!total || total <= 0) return 0;
    return Math.min(100, Math.round((pos / total) * 100));
  }

  function libIcon(collectionType) {
    const t = (collectionType || "").toLowerCase();
    if (t === "movies") return "🎬";
    if (t === "tvshows") return "📺";
    if (t === "music") return "🎵";
    if (t === "books") return "📚";
    if (t === "photos") return "🖼";
    if (t === "mixed") return "📁";
    return "📂";
  }

  function normText(v) {
    return (v || "").replace(/\s+/g, " ").trim();
  }

  function getBaseTargets() {
    const targets = [];
    if (JF_CONFIG.activeBaseUrl) targets.push(JF_CONFIG.activeBaseUrl);
    if (JF_CONFIG.primaryBaseUrl && JF_CONFIG.primaryBaseUrl !== JF_CONFIG.activeBaseUrl) {
      targets.push(JF_CONFIG.primaryBaseUrl);
    }
    if (JF_CONFIG.fallbackBaseUrl && JF_CONFIG.fallbackBaseUrl !== JF_CONFIG.activeBaseUrl) {
      targets.push(JF_CONFIG.fallbackBaseUrl);
    }
    return targets;
  }

  function getCurrentBaseUrl() {
    return JF_CONFIG.activeBaseUrl || JF_CONFIG.primaryBaseUrl || JF_CONFIG.fallbackBaseUrl || "";
  }

  function getCurrentHref() {
    if (JF_CONFIG.activeBaseUrl === JF_CONFIG.fallbackBaseUrl && JF_CONFIG.fallbackHref) {
      return JF_CONFIG.fallbackHref;
    }
    return JF_CONFIG.primaryHref || JF_CONFIG.fallbackHref || "#";
  }

  function findGroupContainer() {
    const hd = Array.from(document.querySelectorAll("h2,h3,.group-title,.service-group-name"))
      .find(el => normText(el.textContent) === GROUP_LABEL);
    if (!hd) return null;
    return hd.closest("section") || hd.closest("div[class*='group']") ||
      hd.parentElement?.parentElement || hd.parentElement;
  }

  function ensureHost(group) {
    let host = group.querySelector(".jf-monitor-host");
    if (host) return host;
    const list = group.querySelector("ul.services-list, ul");
    if (list) list.style.display = "none";
    host = document.createElement("div");
    host.className = "jf-monitor-host";
    group.appendChild(host);
    return host;
  }

  function getHost() {
    const group = findGroupContainer();
    return group ? group.querySelector(".jf-monitor-host") : null;
  }

  function getSessionIsPaused(session) {
    const override = _sessionPlaybackOverride[session.Id];
    if (typeof override === "boolean") return override;

    return !!session?.PlayState?.IsPaused ||
      String(session?.PlayState?.PlayState || "").toLowerCase().includes("pause");
  }

  function setSessionPausedOverride(sessionId, isPaused) {
    _sessionPlaybackOverride[sessionId] = isPaused;
    const host = getHost();
    if (host) updateHost(host);
  }

  function clearSessionPausedOverride(sessionId) {
    delete _sessionPlaybackOverride[sessionId];
  }

  function authHeaders(extra = {}) {
    return {
      "Authorization": `MediaBrowser Token="${JF_CONFIG.apiKey}"`,
      "Accept": "application/json",
      ...extra,
    };
  }

  async function apiFetch(path, method = "GET", body = undefined) {
    const opts = {
      method,
      headers: authHeaders(body ? { "Content-Type": "application/json" } : {}),
      signal: AbortSignal.timeout(10_000),
    };

    if (body !== undefined) {
      opts.body = typeof body === "string" ? body : JSON.stringify(body);
    }

    const targets = getBaseTargets();
    let lastErr = null;

    for (const baseUrl of targets) {
      try {
        const res = await fetch(`${baseUrl}${path}`, opts);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        JF_CONFIG.activeBaseUrl = baseUrl;

        if (res.status === 204 || res.headers.get("content-length") === "0") return null;
        const ct = res.headers.get("content-type") || "";
        return ct.includes("json") ? res.json() : null;
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr || new Error(`Request failed for ${path}`);
  }

  async function fetchSessions() {
    try {
      const data = await apiFetch("/Sessions");
      return (data || []).filter(s => s.NowPlayingItem);
    } catch (e) {
      console.warn("[JellyfinWidget] Sessions fetch failed:", e.message);
      return null;
    }
  }

  async function fetchLibraryCounts() {
    try {
      return await apiFetch("/Items/Counts");
    } catch (e) {
      console.warn("[JellyfinWidget] Counts fetch failed:", e.message);
      return null;
    }
  }

  async function fetchLibraries() {
    try {
      const data = await apiFetch("/Library/VirtualFolders");
      return (data || []).map(f => ({
        Id: f.ItemId,
        Name: f.Name,
        CollectionType: f.CollectionType || "mixed",
      }));
    } catch (e) {
      console.warn("[JellyfinWidget] Library fetch failed:", e.message);
      return null;
    }
  }

  async function syncAll(host) {
    const ids = (_libraries || []).map(l => l.Id);
    ids.forEach(id => { _syncState[id] = "syncing"; });
    _syncState["__all__"] = "syncing";
    renderSyncPanel(host);

    try {
      await apiFetch("/Library/Refresh", "POST");
      ids.forEach(id => { _syncState[id] = "ok"; });
      _syncState["__all__"] = "ok";
    } catch (e) {
      console.warn("[JellyfinWidget] Sync all failed:", e.message);
      ids.forEach(id => { _syncState[id] = "err"; });
      _syncState["__all__"] = "err";
    }

    renderSyncPanel(host);

    setTimeout(() => {
      ids.forEach(id => { _syncState[id] = "idle"; });
      _syncState["__all__"] = "idle";
      renderSyncPanel(host);
    }, 4000);
  }

  async function syncLibrary(id, host) {
    _syncState[id] = "syncing";
    renderSyncPanel(host);
    try {
      await apiFetch(`/Items/${id}/Refresh?Recursive=true&ImageRefreshMode=Default&MetadataRefreshMode=Default`, "POST");
      _syncState[id] = "ok";
    } catch (e) {
      console.warn(`[JellyfinWidget] Sync ${id} failed:`, e.message);
      _syncState[id] = "err";
    }
    renderSyncPanel(host);
    setTimeout(() => {
      _syncState[id] = "idle";
      renderSyncPanel(host);
    }, 4000);
  }

  function setSessionActionState(sessionId, state, label = "") {
    _sessionActionState[sessionId] = { state, label };
    const host = getHost();
    if (host) updateHost(host);
  }

  function clearSessionActionStateLater(sessionId, delay = 2500) {
    setTimeout(() => {
      delete _sessionActionState[sessionId];
      const host = getHost();
      if (host) updateHost(host);
    }, delay);
  }

  function setGroupMessageState(state, label = "") {
    _groupMessageState = { state, label };
    const host = getHost();
    if (host) updateHost(host);
  }

  function clearGroupMessageStateLater(delay = 3000) {
    setTimeout(() => {
      _groupMessageState = null;
      const host = getHost();
      if (host) updateHost(host);
    }, delay);
  }

  async function sessionCommand(sessionId, command) {
    const cmd = String(command || "").toLowerCase();

    if (cmd === "pause") setSessionPausedOverride(sessionId, true);
    if (cmd === "unpause") setSessionPausedOverride(sessionId, false);

    setSessionActionState(
      sessionId,
      "busy",
      cmd === "pause" ? "Pausing..." :
        cmd === "unpause" ? "Resuming..." :
          cmd === "stop" ? "Stopping..." :
            command
    );

    try {
      await apiFetch(`/Sessions/${sessionId}/Playing/${command}`, "POST");

      setSessionActionState(
        sessionId,
        "ok",
        cmd === "pause" ? "Paused" :
          cmd === "unpause" ? "Resumed" :
            cmd === "stop" ? "Stopped" :
              command
      );
      clearSessionActionStateLater(sessionId);

      const host = getHost();
      if (host) await refresh(host);

      clearSessionPausedOverride(sessionId);
    } catch (e) {
      console.warn(`[JellyfinWidget] Session ${command} failed:`, e.message);

      clearSessionPausedOverride(sessionId);
      setSessionActionState(sessionId, "err", e.message || command);
      clearSessionActionStateLater(sessionId, 4000);

      const host = getHost();
      if (host) updateHost(host);
    }
  }

  async function sendSessionMessage(sessionId) {
    const text = (_messageDrafts[sessionId] || "").trim();
    if (!text) {
      setSessionActionState(sessionId, "err", "Message required");
      clearSessionActionStateLater(sessionId, 2500);
      return;
    }

    setSessionActionState(sessionId, "busy", "message");

    try {
      await apiFetch(`/Sessions/${sessionId}/Message`, "POST", {
        Header: "Admin Message",
        Text: text,
      });

      _messageDrafts[sessionId] = "";
      _messageOpen[sessionId] = false;
      setSessionActionState(sessionId, "ok", "message sent");
      clearSessionActionStateLater(sessionId);
      const host = getHost();
      if (host) updateHost(host);
    } catch (e) {
      console.warn("[JellyfinWidget] Send message failed:", e.message);
      setSessionActionState(sessionId, "err", e.message || "message failed");
      clearSessionActionStateLater(sessionId, 4000);
    }
  }

  async function sendGroupMessage() {
    const text = (_groupMessageDraft || "").trim();
    const sessions = Array.isArray(_sessions) ? _sessions : [];

    if (!text) {
      setGroupMessageState("err", "Message required");
      clearGroupMessageStateLater(2500);
      return;
    }

    if (!sessions.length) {
      setGroupMessageState("err", "No active sessions");
      clearGroupMessageStateLater(2500);
      return;
    }

    setGroupMessageState("busy", `Sending to ${sessions.length}…`);

    const results = await Promise.allSettled(
      sessions.map(session =>
        apiFetch(`/Sessions/${session.Id}/Message`, "POST", {
          Header: "Admin Message",
          Text: text,
        })
      )
    );

    const okCount = results.filter(r => r.status === "fulfilled").length;
    const failCount = results.length - okCount;

    if (failCount === 0) {
      _groupMessageDraft = "";
      _groupMessageOpen = false;
      setGroupMessageState("ok", `Sent to ${okCount}/${results.length}`);
      clearGroupMessageStateLater(3500);
    } else {
      setGroupMessageState("err", `${okCount}/${results.length} sent`);
      clearGroupMessageStateLater(4500);
    }

    const host = getHost();
    if (host) updateHost(host);
  }

  function syncBtnIcon(state) {
    if (state === "syncing") return `<span class="jf-sync-spin">↻</span>`;
    if (state === "ok") return `✓`;
    if (state === "err") return `✗`;
    return `↻`;
  }

  function syncBtnCls(state) {
    if (state === "syncing") return "jf-sync-btn jf-sync-btn--busy";
    if (state === "ok") return "jf-sync-btn jf-sync-btn--ok";
    if (state === "err") return "jf-sync-btn jf-sync-btn--err";
    return "jf-sync-btn";
  }

  function actionBtnCls(kind) {
    return `jf-action-btn jf-action-btn--${kind}`;
  }

  function buildSyncPanel() {
    const libs = _libraries || [];
    const allState = _syncState["__all__"] || "idle";

    const libBtns = libs.map(lib => {
      const st = _syncState[lib.Id] || "idle";
      const cls = syncBtnCls(st);
      const ico = syncBtnIcon(st);
      const disabled = st === "syncing" ? "disabled" : "";
      return `
        <button class="${cls} jf-sync-lib-btn" data-lib-id="${esc(lib.Id)}" ${disabled}
                title="Scan ${esc(lib.Name)}">
          <span class="jf-sync-lib-icon">${libIcon(lib.CollectionType)}</span>
          <span class="jf-sync-lib-name">${esc(lib.Name)}</span>
          <span class="jf-sync-status-icon">${ico}</span>
        </button>`;
    }).join("");

    const allDisabled = allState === "syncing" ? "disabled" : "";

    return `
      <div class="jf-sync-panel" id="jf-sync-panel">
        <div class="jf-sync-header">
          <span class="jf-section-label" style="padding:0;">Library Sync</span>
          <button class="${syncBtnCls(allState)} jf-sync-all-btn" ${allDisabled}
                  id="jf-sync-all" title="Scan all libraries">
            ${syncBtnIcon(allState)} Sync All
          </button>
        </div>
        <div class="jf-sync-libs">
          ${libs.length === 0
        ? `<span class="jf-sync-loading">Loading libraries…</span>`
        : libBtns}
        </div>
      </div>`;
  }

  function buildGroupComposer(sessionCount) {
    if (!_groupMessageOpen) return "";

    let statusHtml = "";
    if (_groupMessageState?.state === "busy") {
      statusHtml = `<span class="jf-action-status jf-action-status--busy">${esc(_groupMessageState.label || "Sending…")}</span>`;
    } else if (_groupMessageState?.state === "ok") {
      statusHtml = `<span class="jf-action-status jf-action-status--ok">${esc(_groupMessageState.label || "Sent")}</span>`;
    } else if (_groupMessageState?.state === "err") {
      statusHtml = `<span class="jf-action-status jf-action-status--err">${esc(_groupMessageState.label || "Failed")}</span>`;
    }

    const busy = _groupMessageState?.state === "busy";

    return `
      <div class="jf-group-message">
        <div class="jf-group-message-top">
          <span class="jf-section-label" style="padding:0;">Group Message</span>
          <span class="jf-group-message-target">Send to ${sessionCount} active ${sessionCount === 1 ? "session" : "sessions"}</span>
        </div>
        <div class="jf-message-box">
          <textarea
            class="jf-message-input"
            id="jf-group-message-input"
            rows="2"
            maxlength="300"
            placeholder="Broadcast a message to all active Jellyfin sessions...">${esc(_groupMessageDraft)}</textarea>
          <div class="jf-message-actions">
            <div class="jf-message-actions-left">
              <span class="jf-message-count">${_groupMessageDraft.length}/300</span>
              ${statusHtml}
            </div>
            <div class="jf-message-actions-right">
              <button class="${actionBtnCls("ghost")}" id="jf-group-message-cancel" ${busy ? "disabled" : ""}>Cancel</button>
              <button class="${actionBtnCls("send")}" id="jf-group-message-send" ${busy ? "disabled" : ""}>Send to All</button>
            </div>
          </div>
        </div>
      </div>`;
  }

  function buildStatPills(counts) {
    if (!counts) return "";
    const pills = [
      { label: "Movies", value: counts.MovieCount ?? 0 },
      { label: "Episodes", value: counts.EpisodeCount ?? 0 },
      { label: "Songs", value: counts.SongCount ?? 0 },
      { label: "Albums", value: counts.AlbumCount ?? 0 },
    ].filter(p => p.value > 0);

    if (!pills.length) return "";

    return `<div class="jf-stats">
      ${pills.map(p => `
        <span class="jf-stat-pill">
          <span class="jf-stat-value">${p.value.toLocaleString()}</span>
          ${esc(p.label)}
        </span>`).join("")}
    </div>`;
  }

  function buildAvatarEl(session) {
    const uname = session.UserName || "?";
    const item = session.NowPlayingItem;
    const currentBase = getCurrentBaseUrl();

    if (item && currentBase) {
      // For episodes: use the Series poster. For everything else: use the item's own Primary image.
      const isEpisode = item.Type === "Episode";
      const imageItemId = isEpisode ? item.SeriesId : item.Id;
      const imageTag = isEpisode ? item.SeriesPrimaryImageTag : (item.ImageTags?.Primary);

      if (imageItemId && imageTag) {
        const src = `${currentBase}/Items/${imageItemId}/Images/Primary?maxHeight=120&maxWidth=80&tag=${imageTag}&quality=90`;
        return `<img class="jf-avatar jf-avatar--art" src="${esc(src)}" alt="${esc(item.SeriesName || item.Name || uname)}"
                     onerror="this.outerHTML='<div class=\\'jf-avatar-placeholder\\'>${esc(uname.charAt(0).toUpperCase())}</div>'" />`;
      }
    }

    return `<div class="jf-avatar-placeholder">${esc(uname.charAt(0).toUpperCase())}</div>`;
  }

  function buildStateLabel(session) {
    if (!session) return { text: "PLAYING", cls: "jf-state--playing" };

    const isPaused = getSessionIsPaused(session);
    if (isPaused) return { text: "PAUSED", cls: "jf-state--paused" };

    const ps = session.PlayState;
    const s = String(ps?.PlayState || "").toLowerCase();

    if (s.includes("stop")) return { text: "STOPPED", cls: "jf-state--stopped" };
    return { text: "PLAYING", cls: "jf-state--playing" };
  }

  function buildSessionControls(session) {
    const sessionId = session.Id;
    const isPaused = getSessionIsPaused(session);

    const action = _sessionActionState[sessionId];
    const busy = action?.state === "busy";
    const isOpen = !!_messageOpen[sessionId];
    const draft = _messageDrafts[sessionId] || "";

    let statusHtml = "";
    if (action?.state === "ok") {
      statusHtml = `<span class="jf-action-status jf-action-status--ok">${esc(action.label || "Done")}</span>`;
    } else if (action?.state === "err") {
      statusHtml = `<span class="jf-action-status jf-action-status--err">${esc(action.label || "Failed")}</span>`;
    } else if (action?.state === "busy") {
      statusHtml = `<span class="jf-action-status jf-action-status--busy">${esc(action.label || "Working…")}</span>`;
    }

    return `
      <div class="jf-session-actions">
        <div class="jf-session-actions-row">
          ${isPaused
        ? `<button class="${actionBtnCls("resume")}" data-action="unpause" data-session-id="${esc(sessionId)}" ${busy ? "disabled" : ""}>Resume</button>`
        : `<button class="${actionBtnCls("pause")}" data-action="pause" data-session-id="${esc(sessionId)}" ${busy ? "disabled" : ""}>Pause</button>`
      }
          <button class="${actionBtnCls("stop")}" data-action="stop" data-session-id="${esc(sessionId)}" ${busy ? "disabled" : ""}>Stop</button>
          <button class="${actionBtnCls("message")}" data-action="toggle-message" data-session-id="${esc(sessionId)}" ${busy ? "disabled" : ""}>
            ${isOpen ? "Close Message" : "Message"}
          </button>
          ${statusHtml}
        </div>

        ${isOpen ? `
          <div class="jf-message-box">
            <textarea
              class="jf-message-input"
              data-message-input="${esc(sessionId)}"
              rows="2"
              maxlength="300"
              placeholder="Send a message to ${esc(session.UserName || "user")}...">${esc(draft)}</textarea>
            <div class="jf-message-actions">
              <span class="jf-message-count">${draft.length}/300</span>
              <button class="${actionBtnCls("send")}" data-action="send-message" data-session-id="${esc(sessionId)}" ${busy ? "disabled" : ""}>
                Send
              </button>
            </div>
          </div>
        ` : ""}
      </div>`;
  }

  function buildSessionCard(session) {
    const item = session.NowPlayingItem;
    const ps = session.PlayState;
    let title = item.Name || "Unknown";

    if (item.Type === "Episode") {
      const show = item.SeriesName ? `${item.SeriesName} — ` : "";
      const epNum = (item.ParentIndexNumber != null && item.IndexNumber != null)
        ? `S${String(item.ParentIndexNumber).padStart(2, "0")}E${String(item.IndexNumber).padStart(2, "0")} `
        : "";
      title = `${show}${epNum}${item.Name}`;
    }

    const meta = [
      `<span class="jf-session-user">${esc(session.UserName || "")}</span>`,
      esc(session.Client),
      esc(session.DeviceName)
    ].filter(Boolean).join(" · ");

    const posMs = ps?.PositionTicks ?? 0;
    const totalMs = item.RunTimeTicks ?? 0;
    const stateInfo = buildStateLabel(session);

    return `
      <div class="jf-session" data-session-card="${esc(session.Id)}">
        ${buildAvatarEl(session)}
        <div class="jf-session-body">
          <div class="jf-session-top">
            <span class="jf-session-title" title="${esc(title)}">${esc(title)}</span>
            <span class="jf-state-badge ${stateInfo.cls}">${stateInfo.text}</span>
          </div>
          <div class="jf-session-meta">${meta}</div>
          ${totalMs > 0 ? `
          <div class="jf-progress-wrap">
            <div class="jf-progress-bar">
              <div class="jf-progress-fill" style="width:${pct(posMs, totalMs)}%"></div>
            </div>
            <span class="jf-progress-time">${fmtMs(posMs)} / ${fmtMs(totalMs)}</span>
          </div>` : ""}
          ${buildSessionControls(session)}
        </div>
      </div>`;
  }

  function buildShell(sessions, counts, isLoading) {
    const activeSessions = sessions || [];
    const sessionCount = activeSessions.length;
    const groupBusy = _groupMessageState?.state === "busy";

    return `
      <div class="jf-shell">
        <div class="jf-header">
          <div class="jf-header-left">
            <img class="jf-icon" src="/icons/Jellyfin.png" alt="Jellyfin" />
            <span class="jf-title">Jellyfin</span>
            ${sessionCount > 0
        ? `<span class="jf-stat-pill" style="padding:2px 8px;font-size:0.65rem;">
                   <span class="jf-stat-value">${sessionCount}</span>
                   ${sessionCount === 1 ? "stream" : "streams"}
                 </span>`
        : ""}
            ${!isLoading ? buildStatPills(counts) : ""}
          </div>
          <div class="jf-header-right">
            ${sessionCount > 0 ? `
              <button class="jf-group-toggle${_groupMessageOpen ? " jf-group-toggle--open" : ""}" id="jf-group-toggle" ${groupBusy ? "disabled" : ""} title="Message all active sessions">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                </svg>
                Group Message
              </button>
            ` : ""}
            <button class="jf-sync-toggle${_syncOpen ? " jf-sync-toggle--open" : ""}"
                    id="jf-sync-toggle" title="Library sync">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
                <path d="M23 4v6h-6M1 20v-6h6"/>
                <path d="M3.51 9a9 9 0 0114.36-3.36L23 10M1 14l5.13 4.36A9 9 0 0020.49 15"/>
              </svg>
              Sync
            </button>
            <a class="jf-open-link" href="${esc(getCurrentHref())}"
               target="_blank" rel="noopener" title="Open Jellyfin">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              Open
            </a>
          </div>
        </div>

        <div class="jf-sync-wrap${_syncOpen ? " jf-sync-wrap--open" : ""}" id="jf-sync-wrap">
          ${buildSyncPanel()}
        </div>

        ${!isLoading && sessionCount > 0 ? buildGroupComposer(sessionCount) : ""}

        ${isLoading
        ? `<div class="jf-skeleton-row"></div><div class="jf-skeleton-row" style="animation-delay:.1s"></div>`
        : ""}

        ${isLoading ? "" : (() => {
        if (sessions === null) return `<div class="jf-error">⚠ Could not reach Jellyfin</div>`;
        if (!activeSessions.length) return `<div class="jf-idle">💤 No active streams</div>`;
        return `
            <div class="jf-section-label">Now Playing</div>
            <div class="jf-sessions">${activeSessions.map(buildSessionCard).join("")}</div>`;
      })()}

        <div class="jf-footer">Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}</div>
      </div>`;
  }

  function renderSyncPanel(host) {
    if (!host) return;
    const wrap = host.querySelector("#jf-sync-wrap");
    if (wrap) wrap.innerHTML = buildSyncPanel();
    bindSyncButtons(host);
  }

  function bindSyncButtons(host) {
    const allBtn = host.querySelector("#jf-sync-all");
    if (allBtn && !allBtn._jfBound) {
      allBtn._jfBound = true;
      allBtn.addEventListener("click", () => syncAll(host));
    }

    host.querySelectorAll(".jf-sync-lib-btn").forEach(btn => {
      if (btn._jfBound) return;
      btn._jfBound = true;
      btn.addEventListener("click", () => {
        const id = btn.dataset.libId;
        if (id) syncLibrary(id, host);
      });
    });
  }

  function bindToggle(host) {
    const toggle = host.querySelector("#jf-sync-toggle");
    if (toggle && !toggle._jfBound) {
      toggle._jfBound = true;
      toggle.addEventListener("click", () => {
        _syncOpen = !_syncOpen;
        const wrap = host.querySelector("#jf-sync-wrap");
        const btn = host.querySelector("#jf-sync-toggle");
        wrap?.classList.toggle("jf-sync-wrap--open", _syncOpen);
        btn?.classList.toggle("jf-sync-toggle--open", _syncOpen);

        if (_syncOpen && _libraries === undefined) {
          fetchLibraries().then(libs => {
            _libraries = libs;
            renderSyncPanel(host);
            bindSyncButtons(host);
          });
        }
      });
    }

    const groupToggle = host.querySelector("#jf-group-toggle");
    if (groupToggle && !groupToggle._jfBound) {
      groupToggle._jfBound = true;
      groupToggle.addEventListener("click", () => {
        _groupMessageOpen = !_groupMessageOpen;
        const h = getHost();
        if (h) updateHost(h);
      });
    }

    const groupSend = host.querySelector("#jf-group-message-send");
    if (groupSend && !groupSend._jfBound) {
      groupSend._jfBound = true;
      groupSend.addEventListener("click", sendGroupMessage);
    }

    const groupCancel = host.querySelector("#jf-group-message-cancel");
    if (groupCancel && !groupCancel._jfBound) {
      groupCancel._jfBound = true;
      groupCancel.addEventListener("click", () => {
        _groupMessageOpen = false;
        const h = getHost();
        if (h) updateHost(h);
      });
    }

    const groupInput = host.querySelector("#jf-group-message-input");
    if (groupInput && !groupInput._jfBound) {
      groupInput._jfBound = true;
      groupInput.addEventListener("input", () => {
        _groupMessageDraft = groupInput.value.slice(0, 300);
        const count = groupInput.closest(".jf-message-box")?.querySelector(".jf-message-count");
        if (count) count.textContent = `${_groupMessageDraft.length}/300`;
      });

      groupInput.addEventListener("keydown", e => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          sendGroupMessage();
        }
      });
    }

    bindSyncButtons(host);
  }

  function bindSessionActions(host) {
    host.querySelectorAll("[data-action]").forEach(btn => {
      if (btn._jfBound) return;
      btn._jfBound = true;

      btn.addEventListener("click", async () => {
        const action = btn.dataset.action;
        const sessionId = btn.dataset.sessionId;
        if (!sessionId) return;

        if (action === "pause") {
          await sessionCommand(sessionId, "Pause");
          return;
        }

        if (action === "unpause") {
          await sessionCommand(sessionId, "Unpause");
          return;
        }

        if (action === "stop") {
          await sessionCommand(sessionId, "Stop");
          return;
        }

        if (action === "toggle-message") {
          _messageOpen[sessionId] = !_messageOpen[sessionId];
          const h = getHost();
          if (h) updateHost(h);
          return;
        }

        if (action === "send-message") {
          await sendSessionMessage(sessionId);
        }
      });
    });

    host.querySelectorAll("[data-message-input]").forEach(input => {
      if (input._jfBound) return;
      input._jfBound = true;

      input.addEventListener("input", () => {
        const sessionId = input.dataset.messageInput;
        _messageDrafts[sessionId] = input.value.slice(0, 300);

        const count = input.closest(".jf-message-box")?.querySelector(".jf-message-count");
        if (count) count.textContent = `${_messageDrafts[sessionId].length}/300`;
      });

      input.addEventListener("keydown", e => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          const sessionId = input.dataset.messageInput;
          if (sessionId) sendSessionMessage(sessionId);
        }
      });
    });
  }

  function updateHost(host) {
    const isLoading = _sessions === undefined || _counts === undefined;
    host.innerHTML = buildShell(_sessions, _counts, isLoading);
    bindToggle(host);
    bindSessionActions(host);
  }

  async function refresh(host) {
    const [sessions, counts] = await Promise.all([fetchSessions(), fetchLibraryCounts()]);
    _sessions = sessions;
    _counts = counts;
    if (host) updateHost(host);
  }

  async function render() {
    if (_rendering) return;
    _rendering = true;

    try {
      const group = findGroupContainer();
      if (!group) return;

      const host = ensureHost(group);

      if (!host.querySelector(".jf-shell")) {
        _sessions = undefined;
        _counts = undefined;
        updateHost(host);
      }

      if (_libraries === undefined) {
        fetchLibraries().then(libs => { _libraries = libs; });
      }

      await refresh(host);
    } catch (err) {
      console.error("[JellyfinWidget] Render error:", err);
    } finally {
      setTimeout(() => { _rendering = false; }, 1500);
    }
  }

  function init() {
    const POLL_ACTIVE = 10 * 1000;
    const POLL_IDLE = 30 * 1000;
    let _pollTimer = null;

    function scheduleNext() {
      if (_pollTimer) clearTimeout(_pollTimer);
      const delay = (_sessions && _sessions.length > 0) ? POLL_ACTIVE : POLL_IDLE;
      _pollTimer = setTimeout(async () => {
        const host = getHost();
        if (host) await refresh(host);
        scheduleNext();
      }, delay);
    }

    const start = () => {
      setTimeout(async () => {
        await render();
        scheduleNext();
      }, 1400);
    };

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        const host = getHost();
        if (host) refresh(host).then(scheduleNext);
      }
    });

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }

    new MutationObserver(() => {
      if (_obsDelay || document.querySelector(".jf-monitor-host .jf-shell")) return;
      _obsDelay = setTimeout(() => {
        _obsDelay = null;
        render();
      }, 700);
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();