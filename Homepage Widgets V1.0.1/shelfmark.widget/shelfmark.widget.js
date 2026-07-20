/* =====================================================
   SHELFMARK LIBRARY WIDGET
===================================================== */
(function () {
  const SM_CONFIG = {
    baseUrl: "https://YOUR_TUNNEL_HOSTNAME",
    fallbackUrl: "http://YOUR_LOCAL_IP:PORT",
    activeUrl: null,
    username: "YOUR_USERNAME",
    password: "PASTE_YOUR_PASSWORD_HERE",
    groupName: "SHELFMARK-LIBRARY",
    pollMs: 30 * 1000,
    listSize: 16,
    debug: false,
    // Deep-link completed books into Audiobookshelf when possible.
    library: {
      absBaseUrl: "https://YOUR_AUDIOBOOKSHELF_HOSTNAME",
      absFallbackUrl: "http://YOUR_LOCAL_IP:13378",
      absPathPrefix: "/audiobookshelf",
      absToken: "PASTE_YOUR_AUDIOBOOKSHELF_API_TOKEN_HERE",
    },
  };

  const ACTIVE_BUCKETS = new Set(["queued", "resolving", "locating", "downloading"]);
  const DONE_BUCKETS = new Set(["complete"]);
  const FAIL_BUCKETS = new Set(["error", "cancelled"]);

  let _currentTab = "overview";
  let _tabCache = {};
  let _sessionReady = false;
  let _absLibs = null;
  let _absActiveUrl = null;
  const _bookHrefCache = new Map();

  function log(...args) {
    if (SM_CONFIG.debug) console.log("[Homepage Shelfmark]", ...args);
  }

  function normText(v) { return (v || "").replace(/\s+/g, " ").trim(); }

  function escH(s = "") {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function openUrl() {
    return SM_CONFIG.activeUrl || SM_CONFIG.baseUrl;
  }

  function hasCredentials() {
    return !!(SM_CONFIG.username && SM_CONFIG.password
      && !SM_CONFIG.password.includes("PASTE_YOUR"));
  }

  function hasAbsLibraryLink() {
    const lib = SM_CONFIG.library || {};
    return !!(lib.absBaseUrl && lib.absToken
      && !String(lib.absToken).includes("PASTE_YOUR"));
  }

  function absWebBase() {
    const lib = SM_CONFIG.library || {};
    const base = (_absActiveUrl || lib.absBaseUrl || "").replace(/\/$/, "");
    const prefix = (lib.absPathPrefix || "").replace(/\/$/, "");
    if (!base) return "";
    return prefix ? `${base}${prefix.startsWith("/") ? prefix : `/${prefix}`}` : base;
  }

  function absUrlCandidates() {
    const lib = SM_CONFIG.library || {};
    const out = [];
    if (_absActiveUrl) out.push(_absActiveUrl);
    if (lib.absBaseUrl && !out.includes(lib.absBaseUrl)) out.push(lib.absBaseUrl);
    if (lib.absFallbackUrl && !out.includes(lib.absFallbackUrl)) out.push(lib.absFallbackUrl);
    return out;
  }

  async function absFetch(path) {
    const token = SM_CONFIG.library?.absToken;
    if (!token) throw new Error("ABS library token missing");
    let lastErr = null;
    for (const base of absUrlCandidates()) {
      try {
        const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
          signal: abortSignal(10000),
        });
        if (!res.ok) throw new Error(`Audiobookshelf ${res.status}`);
        _absActiveUrl = base;
        if (res.status === 204) return null;
        return res.json();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("Audiobookshelf lookup failed");
  }

  function normalizeMatch(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function titlesMatch(a, b) {
    const na = normalizeMatch(a);
    const nb = normalizeMatch(b);
    if (!na || !nb) return false;
    return na === nb || na.includes(nb) || nb.includes(na);
  }

  function authorSoftMatch(expected, actual) {
    const a = normalizeMatch(expected);
    const b = normalizeMatch(actual);
    if (!a || !b) return true;
    const aFirst = a.split(" ")[0];
    const bFirst = b.split(" ")[0];
    return a.includes(bFirst) || b.includes(aFirst) || a.includes(b) || b.includes(a);
  }

  async function findAbsItemId(title, author) {
    if (!hasAbsLibraryLink() || !normText(title)) return null;

    if (!_absLibs) {
      const data = await absFetch("/api/libraries");
      _absLibs = Array.isArray(data?.libraries)
        ? data.libraries
        : (Array.isArray(data) ? data : []);
    }

    const bookLibs = _absLibs.filter((lib) => (lib.mediaType || "book") === "book");
    const libs = bookLibs.length ? bookLibs : _absLibs;
    let fuzzyId = null;

    for (const lib of libs) {
      if (!lib?.id) continue;
      const results = await absFetch(
        `/api/libraries/${encodeURIComponent(lib.id)}/search?q=${encodeURIComponent(title)}&limit=12`
      );
      const books = results?.book || results?.books || [];
      for (const entry of books) {
        const item = entry?.libraryItem || entry;
        const meta = item?.media?.metadata || entry?.match?.metadata || {};
        const itemTitle = meta.title || item?.title || entry?.title || "";
        const itemAuthor = meta.authorName || meta.author || item?.author || "";
        if (!titlesMatch(itemTitle, title)) continue;
        if (!authorSoftMatch(author, itemAuthor)) continue;
        const id = item?.id || item?.libraryItemId || entry?.id;
        if (!id) continue;
        if (normalizeMatch(itemTitle) === normalizeMatch(title)) return id;
        if (!fuzzyId) fuzzyId = id;
      }
    }

    return fuzzyId;
  }

  async function itemHref(task) {
    const title = task?.title || "";
    const author = task?.author || "";
    const key = `${normalizeMatch(title)}|${normalizeMatch(author)}`;
    if (_bookHrefCache.has(key)) return _bookHrefCache.get(key);

    let href = openUrl();
    try {
      const id = await findAbsItemId(title, author);
      if (id) {
        const base = absWebBase();
        if (base) href = `${base}/item/${id}`;
      }
    } catch (err) {
      log("ABS item resolve failed", err);
    }

    _bookHrefCache.set(key, href);
    return href;
  }

  async function resolveHrefs(tasks) {
    const list = Array.isArray(tasks) ? tasks : [];
    const uniq = [];
    const seen = new Set();
    for (const task of list) {
      const key = `${normalizeMatch(task?.title)}|${normalizeMatch(task?.author)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(task);
    }

    const concurrency = 3;
    for (let i = 0; i < uniq.length; i += concurrency) {
      await Promise.all(uniq.slice(i, i + concurrency).map((task) => itemHref(task)));
    }

    for (const task of list) {
      const key = `${normalizeMatch(task?.title)}|${normalizeMatch(task?.author)}`;
      task._href = _bookHrefCache.get(key) || openUrl();
    }
    return list;
  }

  function abortSignal(ms) {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  }

  function isPrivateHost(hostname = "") {
    if (!hostname || hostname === "localhost" || hostname === "127.0.0.1") return true;
    const m = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return false;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }

  function urlCandidates() {
    const out = [];
    const pageIsHttps = typeof window !== "undefined" && window.location.protocol === "https:";
    const pageIsLan = typeof window !== "undefined" && isPrivateHost(window.location.hostname);
    const localUrl = SM_CONFIG.fallbackUrl;
    const remoteUrl = SM_CONFIG.baseUrl;
    const add = (url) => {
      if (!url || out.includes(url)) return;
      if (pageIsHttps && url.startsWith("http://")) return;
      out.push(url);
    };
    add(SM_CONFIG.activeUrl);
    if (pageIsLan) {
      add(localUrl);
      add(remoteUrl);
    } else {
      add(remoteUrl);
      add(localUrl);
    }
    return out;
  }

  function fetchErrorMessage(err, base) {
    const msg = String(err?.message || err || "Request failed");
    if (/failed to fetch|networkerror|network error|load failed/i.test(msg)) {
      if (typeof window !== "undefined" && window.location.protocol === "https:" && base?.startsWith("http://")) {
        return "Blocked mixed content: use an HTTPS Shelfmark URL when Homepage is HTTPS.";
      }
      if (typeof window !== "undefined" && isPrivateHost(window.location.hostname) && base?.startsWith("http://")) {
        return `CORS blocked ${base} — add ${window.location.origin} to Shelfmark CORS_ALLOWED_ORIGINS.`;
      }
      return `Network error reaching ${base || "Shelfmark"} (CORS, DNS, or tunnel).`;
    }
    return msg;
  }

  function fmtBytes(bytes) {
    if (bytes == null || bytes <= 0) return "—";
    if (bytes >= 1e12) return (bytes / 1e12).toFixed(2) + " TB";
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + " GB";
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
    return (bytes / 1e3).toFixed(0) + " KB";
  }

  function fmtPct(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.min(100, Math.max(0, Math.round(n)));
  }

  function fmtTime(ts) {
    if (!ts) return "";
    try {
      const d = new Date(typeof ts === "number" ? ts * 1000 : ts);
      return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch (_) { return ""; }
  }

  function coverUrl(preview) {
    if (!preview) return null;
    if (preview.startsWith("http")) return preview;
    const base = openUrl();
    return `${base}${preview.startsWith("/") ? preview : `/${preview}`}`;
  }

  function flattenTasks(statusObj) {
    const tasks = [];
    if (!statusObj || typeof statusObj !== "object") return tasks;
    for (const [bucket, items] of Object.entries(statusObj)) {
      if (!items || typeof items !== "object") continue;
      for (const task of Object.values(items)) {
        if (task && typeof task === "object") tasks.push({ ...task, bucket });
      }
    }
    return tasks;
  }

  function sortTasks(tasks) {
    return tasks.slice().sort((a, b) => (b.added_time || 0) - (a.added_time || 0));
  }

  function requestTitle(req) {
    const book = req?.book_data || {};
    const release = req?.release_data || {};
    return book.title || release.title || book.name || "Untitled request";
  }

  function requestAuthor(req) {
    const book = req?.book_data || {};
    const release = req?.release_data || {};
    return book.author || release.author || "";
  }

  async function ensureSession() {
    if (_sessionReady) return true;

    let lastErr = null;
    for (const base of urlCandidates()) {
      try {
        const checkRes = await fetch(`${base}/api/auth/check`, {
          credentials: "include",
          signal: abortSignal(8000),
        });
        if (!checkRes.ok) throw new Error(`Auth check ${checkRes.status}`);
        const check = await checkRes.json();

        if (check.auth_required === false || check.authenticated) {
          SM_CONFIG.activeUrl = base;
          _sessionReady = true;
          return true;
        }

        if (!hasCredentials()) return false;

        const loginRes = await fetch(`${base}/api/auth/login`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          signal: abortSignal(8000),
          body: JSON.stringify({
            username: SM_CONFIG.username,
            password: SM_CONFIG.password,
            remember_me: true,
          }),
        });
        const loginData = await loginRes.json().catch(() => ({}));
        if (!loginRes.ok || loginData.error) {
          throw new Error(loginData.error || `Login ${loginRes.status}`);
        }

        SM_CONFIG.activeUrl = base;
        _sessionReady = true;
        return true;
      } catch (err) {
        lastErr = new Error(fetchErrorMessage(err, base));
      }
    }

    throw lastErr || new Error("Could not authenticate with Shelfmark");
  }

  async function apiFetch(path, opts = {}) {
    await ensureSession();

    let lastErr = null;
    for (const base of urlCandidates()) {
      try {
        const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
        const res = await fetch(url, {
          ...opts,
          credentials: "include",
          headers: {
            Accept: "application/json",
            ...(opts.headers || {}),
          },
          signal: opts.signal || abortSignal(12000),
        });
        if (res.status === 401) {
          _sessionReady = false;
          throw new Error("Unauthorized — session cookie not shared across subdomains");
        }
        if (!res.ok) throw new Error(`Shelfmark ${res.status}`);
        SM_CONFIG.activeUrl = base;
        if (res.status === 204) return null;
        return res.json();
      } catch (err) {
        lastErr = new Error(fetchErrorMessage(err, base));
      }
    }
    throw lastErr || new Error("All URLs failed for Shelfmark");
  }

  async function loadSnapshot() {
    return apiFetch("/api/activity/snapshot");
  }

  function findGroupContainer() {
    const headings = Array.from(document.querySelectorAll("h2, h3, .group-title, .service-group-name"));
    const heading = headings.find(el => normText(el.textContent) === SM_CONFIG.groupName);
    if (!heading) { log("Group not found"); return null; }
    return heading.closest("section") || heading.closest("div[class*='group']")
      || heading.parentElement?.parentElement || heading.parentElement;
  }

  function ensureHost(group) {
    let row = group.querySelector(".hp-widget-row, .sm-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "hp-widget-row sm-flex-row";
      group.appendChild(row);
    }
    let host = row.querySelector(".sm-widget-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "sm-widget-host";
    row.appendChild(host);
    return host;
  }

  function bookCard(task, index, extra = {}) {
    const cover = coverUrl(task.preview);
    const title = escH(task.title || "Unknown");
    const author = escH(task.author || "");
    const type = escH((task.content_type || task.format || "").replace(/_/g, " "));
    const sub = [author, type, extra.sub].filter(Boolean).join(" · ");
    const pct = extra.progress != null ? fmtPct(extra.progress) : null;
    const href = task._href || openUrl();

    return `
      <a class="sm-card" href="${escH(href)}" target="_blank" rel="noopener noreferrer"
         style="animation-delay:${index * 35}ms" title="${title}">
        <div class="sm-card-art">
          ${cover
        ? `<img src="${escH(cover)}" alt="${title}" loading="lazy" decoding="async">`
        : `<div class="sm-card-placeholder"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></div>`
      }
          ${pct != null ? `<div class="sm-card-progress"><span style="width:${pct}%"></span></div>` : ""}
        </div>
        <div class="sm-card-meta">
          <div class="sm-card-title">${title}</div>
          ${sub ? `<div class="sm-card-sub">${sub}</div>` : ""}
        </div>
      </a>`;
  }

  function activeRow(task, index) {
    const cover = coverUrl(task.preview);
    const title = escH(task.title || "Unknown");
    const author = escH(task.author || "");
    const pct = fmtPct(task.progress);
    const status = escH(task.status_message || task.bucket || task.status || "active");
    const href = task._href || openUrl();

    return `
      <a class="sm-song-row sm-active-row" href="${escH(href)}" target="_blank" rel="noopener noreferrer"
         style="animation-delay:${index * 25}ms">
        <div class="sm-song-art">
          ${cover
        ? `<img src="${escH(cover)}" alt="${title}" loading="lazy">`
        : `<div class="sm-song-placeholder"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></div>`
      }
          <div class="sm-active-dot"></div>
        </div>
        <div class="sm-song-body">
          <div class="sm-song-title">${title}</div>
          <div class="sm-song-meta">${author || status}</div>
          <div class="sm-session-bar"><span style="width:${pct}%"></span></div>
        </div>
        <div class="sm-song-right">
          <span class="sm-status-pill sm-status-pill--${escH(task.bucket || "queued")}">${escH(task.bucket || "queued")}</span>
          <span class="sm-song-dur">${pct}%</span>
        </div>
      </a>`;
  }

  function requestRow(req, index) {
    const title = escH(requestTitle(req));
    const author = escH(requestAuthor(req));
    const status = escH(req.status || "pending");
    const delivery = escH(req.delivery_state || "");
    const when = fmtTime(req.created_at);
    const href = req._href || openUrl();

    return `
      <a class="sm-song-row" href="${escH(href)}" target="_blank" rel="noopener noreferrer"
         style="animation-delay:${index * 25}ms">
        <div class="sm-song-art">
          <div class="sm-song-placeholder"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></div>
        </div>
        <div class="sm-song-body">
          <div class="sm-song-title">${title}</div>
          <div class="sm-song-meta">${author || "Book request"}</div>
        </div>
        <div class="sm-song-right">
          <span class="sm-status-pill sm-status-pill--${status}">${status}</span>
          ${delivery ? `<span class="sm-song-dur">${delivery}</span>` : ""}
          ${when ? `<span class="sm-song-user">${when}</span>` : ""}
        </div>
      </a>`;
  }

  async function renderOverview() {
    const snap = await loadSnapshot();
    const tasks = sortTasks(flattenTasks(snap?.status));
    const requests = Array.isArray(snap?.requests) ? snap.requests : [];

    const active = tasks.filter(t => ACTIVE_BUCKETS.has(t.bucket)).length;
    const complete = tasks.filter(t => DONE_BUCKETS.has(t.bucket)).length;
    const failed = tasks.filter(t => FAIL_BUCKETS.has(t.bucket)).length;
    const pendingRequests = requests.filter(r => (r.status || "").toLowerCase() === "pending").length;

    const recent = await resolveHrefs(tasks.filter(t => DONE_BUCKETS.has(t.bucket)).slice(0, 6));

    return `
      <div class="sm-stats-grid">
        <div class="sm-stat-card">
          <div class="sm-stat-num">${active}</div>
          <div class="sm-stat-label">Active</div>
        </div>
        <div class="sm-stat-card">
          <div class="sm-stat-num">${complete}</div>
          <div class="sm-stat-label">Completed</div>
        </div>
        <div class="sm-stat-card">
          <div class="sm-stat-num">${failed}</div>
          <div class="sm-stat-label">Failed</div>
        </div>
        <div class="sm-stat-card">
          <div class="sm-stat-num">${pendingRequests}</div>
          <div class="sm-stat-label">Requests</div>
        </div>
      </div>
      ${recent.length ? `
        <div class="sm-section-label" style="margin-top:16px;">Recently Completed</div>
        <div class="sm-card-grid">${recent.map((item, i) => bookCard(item, i)).join("")}</div>` : `
        <div class="sm-empty" style="margin-top:16px;">No completed downloads yet</div>`}`;
  }

  async function renderActive() {
    const snap = await loadSnapshot();
    const tasks = await resolveHrefs(sortTasks(flattenTasks(snap?.status))
      .filter(t => ACTIVE_BUCKETS.has(t.bucket))
      .slice(0, SM_CONFIG.listSize));

    if (!tasks.length) {
      return `<div class="sm-empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        <div>No active downloads</div>
      </div>`;
    }

    return `<div class="sm-song-list">${tasks.map(activeRow).join("")}</div>`;
  }

  async function renderRecent() {
    const snap = await loadSnapshot();
    const tasks = await resolveHrefs(sortTasks(flattenTasks(snap?.status))
      .filter(t => DONE_BUCKETS.has(t.bucket))
      .slice(0, SM_CONFIG.listSize));

    if (!tasks.length) return `<div class="sm-empty">No completed downloads</div>`;
    return `<div class="sm-card-grid">${tasks.map((item, i) => bookCard(item, i)).join("")}</div>`;
  }

  async function renderRequests() {
    const snap = await loadSnapshot();
    const requests = (Array.isArray(snap?.requests) ? snap.requests : [])
      .slice(0, SM_CONFIG.listSize)
      .map((req) => ({
        ...req,
        title: requestTitle(req),
        author: requestAuthor(req),
      }));

    await resolveHrefs(requests);

    if (!requests.length) return `<div class="sm-empty">No book requests</div>`;
    return `<div class="sm-song-list">${requests.map(requestRow).join("")}</div>`;
  }

  const TABS = [
    { key: "overview", label: "Overview", render: renderOverview },
    { key: "active", label: "Active", render: renderActive },
    { key: "recent", label: "Recent", render: renderRecent },
    { key: "requests", label: "Requests", render: renderRequests },
  ];

  function buildShell() {
    const tabs = TABS.map((t, i) => `
      <button class="sm-tab${i === 0 ? " sm-tab--active" : ""}" data-tab="${t.key}" type="button" role="tab"
        aria-selected="${i === 0}">
        <span>${t.label}</span>
      </button>`).join("");

    return `
      <div class="sm-shell">
        <div class="sm-header">
          <div class="sm-header-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/shelfmark.webp"
              alt="Shelfmark" class="sm-icon" />
            <span class="sm-title">Shelfmark</span>
          </div>
          <div class="sm-header-right">
            <a class="sm-open-btn" href="${escH(openUrl())}" target="_blank" rel="noopener noreferrer">
              Open
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
            </a>
          </div>
        </div>
        <div class="sm-controls">
          <div class="sm-tabs" role="tablist">${tabs}</div>
        </div>
        <div class="sm-panel">
          <div class="sm-skeleton-wrap">${Array.from({ length: 5 }, () => `<div class="sm-skeleton-row"></div>`).join("")}</div>
        </div>
        <div class="sm-footer">Updated just now</div>
      </div>`;
  }

  function buildSetupShell() {
    return `
      <div class="sm-shell sm-shell--setup">
        <div class="sm-header">
          <div class="sm-header-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/shelfmark.webp"
              alt="Shelfmark" class="sm-icon" />
            <span class="sm-title">Shelfmark</span>
          </div>
        </div>
        <div class="sm-setup">
          Add your credentials in <span>SM_CONFIG.username</span> and <span>SM_CONFIG.password</span>
          <div class="sm-setup-sub">Shelfmark uses session login. Homepage and Shelfmark must be reachable from your browser (HTTPS pages need an HTTPS tunnel URL).</div>
        </div>
      </div>`;
  }

  function revealCards(panel) {
    requestAnimationFrame(() => {
      panel.querySelectorAll(".sm-card, .sm-song-row").forEach(el => {
        el.style.opacity = "1";
        el.style.transform = "translateY(0)";
      });
    });
  }

  async function switchTab(shell, key, force = false) {
    if (_currentTab === key && !force) return;
    _currentTab = key;

    shell.querySelectorAll(".sm-tab").forEach(t => {
      const active = t.dataset.tab === key;
      t.classList.toggle("sm-tab--active", active);
      t.setAttribute("aria-selected", String(active));
    });

    const panel = shell.querySelector(".sm-panel");
    const footer = shell.querySelector(".sm-footer");
    if (!panel) return;

    if (_tabCache[key] && !force) {
      panel.innerHTML = _tabCache[key];
      revealCards(panel);
      return;
    }

    panel.innerHTML = `<div class="sm-skeleton-wrap">${Array.from({ length: 5 }, () => `<div class="sm-skeleton-row"></div>`).join("")}</div>`;

    const tab = TABS.find(t => t.key === key);
    if (!tab) return;

    try {
      const html = await tab.render();
      _tabCache[key] = html;
      panel.innerHTML = html;
      revealCards(panel);
      if (footer) {
        footer.textContent = `Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}`;
      }
    } catch (err) {
      console.error("[Homepage Shelfmark]", err);
      _sessionReady = false;
      panel.innerHTML = `
        <div class="sm-error">
          <div class="sm-error-title">Failed to load</div>
          <div class="sm-error-msg">${escH(err.message)}</div>
        </div>`;
    }
  }

  async function renderSmWidget(force = false) {
    const group = findGroupContainer();
    if (!group) return;

    const host = ensureHost(group);
    let shell = host.querySelector(".sm-shell");

    if (!hasCredentials()) {
      if (!shell) host.innerHTML = buildSetupShell();
      return;
    }

    if (!shell) {
      host.innerHTML = buildShell();
      shell = host.querySelector(".sm-shell");
      shell.querySelectorAll(".sm-tab").forEach(tab => {
        tab.addEventListener("click", () => switchTab(shell, tab.dataset.tab));
      });
    }

    await switchTab(shell, _currentTab, force);
  }

  function startPolling() {
    setInterval(() => {
      _tabCache = {};
      _sessionReady = false;
      const shell = document.querySelector(".sm-widget-host .sm-shell:not(.sm-shell--setup)");
      if (shell) switchTab(shell, _currentTab, true);
    }, SM_CONFIG.pollMs);
  }

  HpWidgetBoot.watch("shelfmark", {
    ready: () => !!document.querySelector(".sm-widget-host .sm-shell"),
    setup: () => startPolling(),
    mount: () => renderSmWidget(true),
  });
})();
