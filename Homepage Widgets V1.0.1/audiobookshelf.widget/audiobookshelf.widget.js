/* =====================================================
   AUDIOBOOKSHELF LIBRARY WIDGET
===================================================== */
(function () {
  const ABS_CONFIG = {
    baseUrl: "https://YOUR_TUNNEL_URL",
    fallbackUrl: "http://YOUR_LOCAL_IP:PORT",
    pathPrefix: "/audiobookshelf",
    activeUrl: null,
    token: "PASTE_YOUR_AUDIOBOOKSHELF_API_TOKEN_HERE",
    username: "",
    password: "",
    groupName: "AUDIOBOOKSHELF-LIBRARY",
    pollMs: 60 * 1000,
    listSize: 16,
    debug: false,
  };

  let _currentTab = "library";
  let _currentLibraryId = null;
  let _tabCache = {};
  let _libraries = null;

  function log(...args) {
    if (ABS_CONFIG.debug) console.log("[Homepage ABS]", ...args);
  }

  function normText(v) { return (v || "").replace(/\s+/g, " ").trim(); }

  function escH(s = "") {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function openUrl() {
    return ABS_CONFIG.activeUrl || ABS_CONFIG.baseUrl;
  }

  function webBase() {
    const base = openUrl().replace(/\/$/, "");
    const prefix = (ABS_CONFIG.pathPrefix || "").replace(/\/$/, "");
    return prefix ? `${base}${prefix.startsWith("/") ? prefix : `/${prefix}`}` : base;
  }

  function tabCacheKey(key) {
    return `${key}:${_currentLibraryId || "all"}`;
  }

  function libsForView() {
    if (!_libraries?.length) return [];
    if (!_currentLibraryId) return _libraries;
    return _libraries.filter(lib => lib.id === _currentLibraryId);
  }

  function hasToken() {
    return ABS_CONFIG.token && !ABS_CONFIG.token.includes("PASTE_YOUR_AUDIOBOOKSHELF");
  }

  function fmtDuration(secs) {
    if (!secs || secs <= 0) return "—";
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (h >= 1) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function fmtBytes(bytes) {
    if (bytes == null || bytes <= 0) return "—";
    if (bytes >= 1e12) return (bytes / 1e12).toFixed(2) + " TB";
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + " GB";
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
    return (bytes / 1e3).toFixed(0) + " KB";
  }

  function fmtPct(current, total) {
    if (!total || total <= 0) return 0;
    return Math.min(100, Math.round((current / total) * 100));
  }

  async function ensureToken() {
    if (hasToken()) return ABS_CONFIG.token;
    if (!ABS_CONFIG.username || !ABS_CONFIG.password) return null;

    const candidates = urlCandidates();
    let lastErr = null;
    for (const base of candidates) {
      try {
        const res = await fetch(`${base}/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abortSignal(8000),
          body: JSON.stringify({
            username: ABS_CONFIG.username,
            password: ABS_CONFIG.password,
          }),
        });
        if (!res.ok) throw new Error(`Login ${res.status}`);
        const data = await res.json();
        if (!data?.user?.token) throw new Error("Login response missing token");
        ABS_CONFIG.token = data.user.token;
        ABS_CONFIG.activeUrl = base;
        return ABS_CONFIG.token;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("Login failed");
  }

  function abortSignal(ms) {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  }

  function urlCandidates() {
    const out = [];
    if (ABS_CONFIG.activeUrl) out.push(ABS_CONFIG.activeUrl);
    if (!out.includes(ABS_CONFIG.baseUrl)) out.push(ABS_CONFIG.baseUrl);
    if (ABS_CONFIG.fallbackUrl && !out.includes(ABS_CONFIG.fallbackUrl)) out.push(ABS_CONFIG.fallbackUrl);
    return out;
  }

  async function apiFetch(path, opts = {}) {
    const token = await ensureToken();
    if (!token) throw new Error("Add your API token in ABS_CONFIG.token (Audiobookshelf → Config → Users)");

    let lastErr = null;
    for (const base of urlCandidates()) {
      try {
        const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
        const res = await fetch(url, {
          ...opts,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(opts.headers || {}),
          },
          signal: opts.signal || abortSignal(10000),
        });
        if (!res.ok) throw new Error(`AudioBookshelf ${res.status}`);
        ABS_CONFIG.activeUrl = base;
        if (res.status === 204) return null;
        return res.json();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("All URLs failed for AudioBookshelf");
  }

  function coverUrl(itemId, width = 400) {
    if (!itemId || !hasToken()) return null;
    const base = openUrl();
    const token = encodeURIComponent(ABS_CONFIG.token);
    return `${base}/api/items/${itemId}/cover?width=${width}&token=${token}`;
  }

  function itemHref(item) {
    const base = webBase();
    const id = item?.id || item?.libraryItemId;
    if (!id) return base;
    const type = item?.mediaType || item?.media?.mediaType || "book";
    if (type === "podcast") return `${base}/podcast/${id}`;
    return `${base}/item/${id}`;
  }

  function libraryHref(lib) {
    const base = webBase();
    if (!lib?.id) return base;
    return `${base}/library/${lib.id}/bookshelf`;
  }

  function itemTitle(item) {
    return item?.media?.metadata?.title
      || item?.mediaMetadata?.title
      || item?.displayTitle
      || item?.title
      || "Unknown";
  }

  function itemAuthor(item) {
    return item?.media?.metadata?.authorName
      || item?.media?.metadata?.author
      || item?.mediaMetadata?.author
      || item?.displayAuthor
      || "";
  }

  function itemDuration(item) {
    return item?.media?.duration
      || item?.duration
      || item?.mediaMetadata?.duration
      || 0;
  }

  function findGroupContainer() {
    const headings = Array.from(document.querySelectorAll("h2, h3, .group-title, .service-group-name"));
    const heading = headings.find(el => normText(el.textContent) === ABS_CONFIG.groupName);
    if (!heading) { log("Group not found"); return null; }
    return heading.closest("section") || heading.closest("div[class*='group']")
      || heading.parentElement?.parentElement || heading.parentElement;
  }

  function ensureHost(group) {
    let row = group.querySelector(".hp-widget-row, .abs-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "hp-widget-row abs-flex-row";
      group.appendChild(row);
    }
    let host = row.querySelector(".abs-widget-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "abs-widget-host";
    row.appendChild(host);
    return host;
  }

  function bookCard(item, index, extra = {}) {
    const id = item.id || item.libraryItemId;
    const cover = coverUrl(id);
    const title = escH(itemTitle(item));
    const author = escH(itemAuthor(item));
    const dur = fmtDuration(itemDuration(item));
    const series = item?.media?.metadata?.seriesName;
    const sub = [author, series, dur, extra.sub].filter(Boolean).join(" · ");
    const href = escH(itemHref(item));
    const progress = extra.progress;

    return `
      <a class="abs-card" href="${href}" target="_blank" rel="noopener noreferrer"
         style="animation-delay:${index * 35}ms" title="${title}">
        <div class="abs-card-art">
          ${cover
        ? `<img src="${cover}" alt="${title}" loading="lazy" decoding="async">`
        : `<div class="abs-card-placeholder"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></div>`
      }
          ${progress != null ? `<div class="abs-card-progress"><span style="width:${progress}%"></span></div>` : ""}
        </div>
        <div class="abs-card-meta">
          <div class="abs-card-title">${title}</div>
          ${sub ? `<div class="abs-card-sub">${sub}</div>` : ""}
        </div>
      </a>`;
  }

  function sessionRow(session, index) {
    const id = session.libraryItemId;
    const cover = coverUrl(id, 120);
    const title = escH(session.displayTitle || itemTitle(session));
    const author = escH(session.displayAuthor || itemAuthor(session));
    const user = escH(session.user?.username || session.username || "");
    const pct = fmtPct(session.currentTime, session.duration);
    const href = escH(itemHref(session));

    return `
      <a class="abs-song-row abs-now-playing-row" href="${href}" target="_blank" rel="noopener noreferrer"
         style="animation-delay:${index * 25}ms">
        <div class="abs-song-art">
          ${cover
        ? `<img src="${cover}" alt="${title}" loading="lazy">`
        : `<div class="abs-song-placeholder"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></div>`
      }
          <div class="abs-playing-dot"></div>
        </div>
        <div class="abs-song-body">
          <div class="abs-song-title">${title}</div>
          <div class="abs-song-meta">${author}</div>
          <div class="abs-session-bar"><span style="width:${pct}%"></span></div>
        </div>
        <div class="abs-song-right">
          ${user ? `<span class="abs-song-user">${user}</span>` : ""}
          <span class="abs-song-dur">${pct}%</span>
          <div class="abs-equalizer" aria-label="Now playing"><span></span><span></span><span></span></div>
        </div>
      </a>`;
  }

  async function loadLibraries() {
    if (_libraries) return _libraries;
    const data = await apiFetch("/api/libraries");
    _libraries = data?.libraries || [];
    if (!_currentLibraryId && _libraries.length) {
      const preferred = _libraries.find(lib => /ebook/i.test(lib.name || ""))
        || _libraries.find(lib => !/audio/i.test(lib.name || ""))
        || _libraries[0];
      _currentLibraryId = preferred.id;
    }
    return _libraries;
  }

  function libSwitcherHtml(libs, statsById = {}) {
    if (!libs.length) return "";
    return `
      <div class="abs-section-label">Libraries</div>
      <div class="abs-lib-grid">${libs.map(lib => {
        const s = statsById[lib.id] || {};
        const active = _currentLibraryId === lib.id;
        return `
        <button type="button" class="abs-lib-card abs-lib-card--btn${active ? " abs-lib-card--active" : ""}"
          data-library-id="${escH(lib.id)}" aria-pressed="${active}">
          <div class="abs-lib-name">${escH(lib.name)}</div>
          <div class="abs-lib-meta">${escH(lib.mediaType || "library")} · ${(s.totalItems || 0).toLocaleString()} items</div>
        </button>`;
      }).join("")}</div>`;
  }

  async function renderLibrary() {
    const libs = await loadLibraries();
    if (!libs.length) return `<div class="abs-empty">No libraries found</div>`;

    const statsResults = await Promise.allSettled(
      libs.map(lib => apiFetch(`/api/libraries/${lib.id}/stats`))
    );

    const statsById = {};
    let totalItems = 0;
    let totalAuthors = 0;
    let totalDuration = 0;
    let totalSize = 0;
    const viewLibs = libsForView();

    statsResults.forEach((res, i) => {
      const lib = libs[i];
      if (res.status !== "fulfilled") return;
      const s = res.value || {};
      statsById[lib.id] = s;
      if (!viewLibs.some(v => v.id === lib.id)) return;
      totalItems += s.totalItems || 0;
      totalAuthors += s.totalAuthors || 0;
      totalDuration += s.totalDuration || 0;
      totalSize += s.totalSize || 0;
    });

    const recentSections = await Promise.allSettled(
      viewLibs.map(lib => apiFetch(`/api/libraries/${lib.id}/personalized`))
    );

    let recentItems = [];
    recentSections.forEach(res => {
      if (res.status !== "fulfilled" || !Array.isArray(res.value)) return;
      const section = res.value.find(s => s.id === "recently-added");
      if (section?.entities?.length) recentItems = recentItems.concat(section.entities);
    });
    recentItems = recentItems.slice(0, 8);

    return `
      <div class="abs-stats-grid">
        <div class="abs-stat-card">
          <div class="abs-stat-num">${totalItems.toLocaleString()}</div>
          <div class="abs-stat-label">Books & Shows</div>
        </div>
        <div class="abs-stat-card">
          <div class="abs-stat-num">${totalAuthors.toLocaleString()}</div>
          <div class="abs-stat-label">Authors</div>
        </div>
        <div class="abs-stat-card">
          <div class="abs-stat-num">${fmtDuration(totalDuration)}</div>
          <div class="abs-stat-label">Total Duration</div>
        </div>
        <div class="abs-stat-card">
          <div class="abs-stat-num">${fmtBytes(totalSize)}</div>
          <div class="abs-stat-label">Library Size</div>
        </div>
      </div>
      ${recentItems.length ? `
        <div class="abs-section-label" style="margin-top:16px;">Recently Added</div>
        <div class="abs-card-grid">${recentItems.map((item, i) => bookCard(item, i)).join("")}</div>` : ""}`;
  }

  async function renderPersonalizedSection(sectionId, emptyMsg) {
    const libs = libsForView();
    let items = [];
    for (const lib of libs) {
      try {
        const sections = await apiFetch(`/api/libraries/${lib.id}/personalized`);
        if (!Array.isArray(sections)) continue;
        const section = sections.find(s => s.id === sectionId);
        if (section?.entities?.length) items = items.concat(section.entities);
      } catch (_) { /* skip library */ }
    }
    items = items.slice(0, ABS_CONFIG.listSize);
    if (!items.length) return `<div class="abs-empty">${emptyMsg}</div>`;
    return `<div class="abs-card-grid">${items.map((item, i) => bookCard(item, i)).join("")}</div>`;
  }

  async function renderContinue() {
    return renderPersonalizedSection("continue-listening", "Nothing in progress");
  }

  async function renderRecent() {
    return renderPersonalizedSection("recently-added", "No recently added items");
  }

  async function renderNowPlaying() {
    const data = await apiFetch("/api/users/online");
    const sessions = data?.openSessions || [];
    if (!sessions.length) {
      return `<div class="abs-empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
        <div>Nothing playing right now</div>
      </div>`;
    }
    return `<div class="abs-song-list">${sessions.map(sessionRow).join("")}</div>`;
  }

  const TABS = [
    { key: "library", label: "Library", render: renderLibrary },
    { key: "continue", label: "Continue", render: renderContinue },
    { key: "recent", label: "Recent", render: renderRecent },
    { key: "playing", label: "Now Playing", render: renderNowPlaying },
  ];

  async function refreshLibrarySwitcher(shell) {
    const slot = shell.querySelector(".abs-lib-switcher");
    if (!slot) return;
    try {
      const libs = await loadLibraries();
      const statsResults = await Promise.allSettled(
        libs.map(lib => apiFetch(`/api/libraries/${lib.id}/stats`))
      );
      const statsById = {};
      statsResults.forEach((res, i) => {
        if (res.status === "fulfilled") statsById[libs[i].id] = res.value || {};
      });
      slot.innerHTML = libSwitcherHtml(libs, statsById);
      bindLibrarySwitcher(shell);
    } catch (err) {
      slot.innerHTML = "";
      log("Library switcher failed", err);
    }
  }

  function buildShell() {
    const tabs = TABS.map((t, i) => `
      <button class="abs-tab${i === 0 ? " abs-tab--active" : ""}" data-tab="${t.key}" type="button" role="tab"
        aria-selected="${i === 0}">
        <span>${t.label}</span>
      </button>`).join("");

    return `
      <div class="abs-shell">
        <div class="abs-header">
          <div class="abs-header-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/audiobookshelf.webp"
              alt="Audiobookshelf" class="abs-icon" />
            <span class="abs-title">Audiobookshelf</span>
          </div>
          <div class="abs-header-right">
            <a class="abs-open-btn" href="${escH(webBase())}" target="_blank" rel="noopener noreferrer">
              Open
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
            </a>
          </div>
        </div>
        <div class="abs-controls">
          <div class="abs-tabs" role="tablist">${tabs}</div>
        </div>
        <div class="abs-lib-switcher"></div>
        <div class="abs-panel">
          <div class="abs-skeleton-wrap">${Array.from({ length: 5 }, () => `<div class="abs-skeleton-row"></div>`).join("")}</div>
        </div>
        <div class="abs-footer">Updated just now</div>
      </div>`;
  }

  function buildSetupShell() {
    return `
      <div class="abs-shell abs-shell--setup">
        <div class="abs-header">
          <div class="abs-header-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/audiobookshelf.webp"
              alt="Audiobookshelf" class="abs-icon" />
            <span class="abs-title">Audiobookshelf</span>
          </div>
        </div>
        <div class="abs-setup">
          Add your API token in <span>ABS_CONFIG.token</span>
          <div class="abs-setup-sub">Audiobookshelf → Config → Users → your account → copy API token</div>
        </div>
      </div>`;
  }

  function revealCards(panel) {
    requestAnimationFrame(() => {
      panel.querySelectorAll(".abs-card, .abs-song-row").forEach(el => {
        el.style.opacity = "1";
        el.style.transform = "translateY(0)";
      });
    });
  }

  function bindLibrarySwitcher(shell) {
    shell.querySelectorAll("[data-library-id]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.libraryId;
        if (!id || id === _currentLibraryId) return;
        _currentLibraryId = id;
        _tabCache = {};
        refreshLibrarySwitcher(shell);
        switchTab(shell, _currentTab, true);
      });
    });
  }

  async function switchTab(shell, key, force = false) {
    if (_currentTab === key && !force) return;
    _currentTab = key;

    shell.querySelectorAll(".abs-tab").forEach(t => {
      const active = t.dataset.tab === key;
      t.classList.toggle("abs-tab--active", active);
      t.setAttribute("aria-selected", String(active));
    });

    const panel = shell.querySelector(".abs-panel");
    const footer = shell.querySelector(".abs-footer");
    if (!panel) return;

    const cacheKey = tabCacheKey(key);
    if (_tabCache[cacheKey] && !force) {
      panel.innerHTML = _tabCache[cacheKey];
      revealCards(panel);
      bindLibrarySwitcher(shell);
      return;
    }

    panel.innerHTML = `<div class="abs-skeleton-wrap">${Array.from({ length: 5 }, () => `<div class="abs-skeleton-row"></div>`).join("")}</div>`;

    const tab = TABS.find(t => t.key === key);
    if (!tab) return;

    try {
      const html = await tab.render();
      _tabCache[cacheKey] = html;
      panel.innerHTML = html;
      revealCards(panel);
      bindLibrarySwitcher(shell);
      if (footer) {
        footer.textContent = `Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}`;
      }
    } catch (err) {
      console.error("[Homepage ABS]", err);
      panel.innerHTML = `
        <div class="abs-error">
          <div class="abs-error-title">Failed to load</div>
          <div class="abs-error-msg">${escH(err.message)}</div>
        </div>`;
    }
  }

  async function renderAbsWidget(force = false) {
    const group = findGroupContainer();
    if (!group) return;

    const host = ensureHost(group);
    let shell = host.querySelector(".abs-shell");

    if (!hasToken() && !ABS_CONFIG.username) {
      if (!shell) host.innerHTML = buildSetupShell();
      return;
    }

    if (!shell) {
      host.innerHTML = buildShell();
      shell = host.querySelector(".abs-shell");
      shell.querySelectorAll(".abs-tab").forEach(tab => {
        tab.addEventListener("click", () => switchTab(shell, tab.dataset.tab));
      });
    }

    await refreshLibrarySwitcher(shell);
    await switchTab(shell, _currentTab, force);
  }

  function startPolling() {
    setInterval(() => {
      _tabCache = {};
      _libraries = null;
      const shell = document.querySelector(".abs-widget-host .abs-shell:not(.abs-shell--setup)");
      if (shell) switchTab(shell, _currentTab, true);
    }, ABS_CONFIG.pollMs);
  }

  HpWidgetBoot.watch("audiobookshelf", {
    ready: () => !!document.querySelector(".abs-widget-host .abs-shell"),
    setup: () => startPolling(),
    mount: () => renderAbsWidget(true),
  });
})();
