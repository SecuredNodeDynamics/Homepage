/* =====================================================
   BAZARR WIDGET
   Media Tab → group: ARR — BAZARR
===================================================== */
(function () {

  const BZR_CONFIG = {
    groupName: "ARR -- PROWLARR.BAZARR",
    url: "https://bazarr.janzenmediagroup.com",
    fallbackUrl: "http://10.128.1.62:6767",
    activeUrl: null,
    key: "cf3fe7e55472e3c82d4dc4de651c3704",
    pollMs: 60 * 1000,
  };

  /* ── Utilities ─────────────────────────────────── */
  function normText(v) { return (v || "").replace(/\s+/g, " ").trim(); }
  function escH(s = "") {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  function fmtTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d) ? "—" : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  function fmtNum(n) { return n == null ? "—" : Number(n).toLocaleString(); }

  function findGroup(name) {
    const hd = Array.from(document.querySelectorAll(
      "h2,h3,.group-title,.service-group-name"
    )).find(el => normText(el.textContent) === name);
    if (!hd) return null;
    return hd.closest("section") ||
      hd.closest("div[class*='group']") ||
      hd.parentElement?.parentElement ||
      hd.parentElement;
  }

  function ensureHost(group) {
    let row = group.querySelector(".arr-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "arr-flex-row";
      group.appendChild(row);
    }
    let host = row.querySelector(".bzr-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "bzr-host";
    row.appendChild(host);
    return host;
  }

  /* ── API ───────────────────────────────────────── */
  async function bzrFetch(path) {
    const candidates = [];
    if (BZR_CONFIG.activeUrl) candidates.push(BZR_CONFIG.activeUrl);
    if (!candidates.includes(BZR_CONFIG.url)) candidates.push(BZR_CONFIG.url);
    if (BZR_CONFIG.fallbackUrl && !candidates.includes(BZR_CONFIG.fallbackUrl)) candidates.push(BZR_CONFIG.fallbackUrl);

    const separator = path.includes("?") ? "&" : "?";
    let lastErr = null;

    for (const base of candidates) {
      try {
        const res = await fetch(`${base}${path}${separator}apikey=${BZR_CONFIG.key}`, {
          signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })(),
        });
        if (!res.ok) throw new Error(`Bazarr ${res.status}: ${path}`);
        BZR_CONFIG.activeUrl = base;
        return res.json();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error(`All URLs failed for Bazarr`);
  }

  async function fetchAll() {
    const [movies, series, wantedMovies, wantedEpisodes, histEpisodes, histMovies] = await Promise.allSettled([
      bzrFetch("/api/movies?start=0&length=10"),
      bzrFetch("/api/series?start=0&length=10"),
      bzrFetch("/api/movies/wanted?start=0&length=20"),
      bzrFetch("/api/episodes/wanted?start=0&length=20"),
      bzrFetch("/api/episodes/history?start=0&length=15"),
      bzrFetch("/api/movies/history?start=0&length=15"),
    ]);

    console.log("[Bazarr histEpisodes]", histEpisodes.status,
      histEpisodes.status === "fulfilled" ? JSON.stringify(histEpisodes.value).slice(0, 300) : histEpisodes.reason?.message);
    console.log("[Bazarr histMovies]", histMovies.status,
      histMovies.status === "fulfilled" ? JSON.stringify(histMovies.value).slice(0, 300) : histMovies.reason?.message);

    const episodeHistory = histEpisodes.status === "fulfilled"
      ? (histEpisodes.value?.data || histEpisodes.value?.results || []).map(h => ({ ...h, _type: "series" }))
      : [];
    const movieHistory = histMovies.status === "fulfilled"
      ? (histMovies.value?.data || histMovies.value?.results || []).map(h => ({ ...h, _type: "movie" }))
      : [];

    return {
      movies: movies.status === "fulfilled" ? movies.value : null,
      series: series.status === "fulfilled" ? series.value : null,
      wantedMovies: wantedMovies.status === "fulfilled" ? (wantedMovies.value?.data || []) : [],
      wantedEpisodes: wantedEpisodes.status === "fulfilled" ? (wantedEpisodes.value?.data || []) : [],
      history: [...episodeHistory, ...movieHistory]
        .sort((a, b) => new Date(b.timestamp || b.date || 0) - new Date(a.timestamp || a.date || 0)),
    };
  }

  /* ── State ─────────────────────────────────────── */
  let _tab = "overview";
  let _data = { movies: null, series: null, wantedMovies: [], wantedEpisodes: [], history: [] };
  let _host = null;
  let _rendering = false;
  let _lastUpdated = null;

  /* ── Shell ─────────────────────────────────────── */
  function buildShell(contentHtml, loading) {
    const tabs = [
      { key: "overview", label: "Overview" },
      { key: "movies", label: "Movies" },
      { key: "series", label: "Series" },
      { key: "wanted", label: "Wanted" },
      { key: "history", label: "History" },
    ];

    const tabsHtml = tabs.map(t => {
      const wantedCount = _data.wantedMovies.length + _data.wantedEpisodes.length;
      const badge = t.key === "wanted" && wantedCount
        ? ` <span class="bzr-tab-badge">${wantedCount}</span>` : "";
      return `
        <button class="bzr-tab ${_tab === t.key ? "bzr-tab--active" : ""}" data-tab="${t.key}">
          ${t.label}${badge}
        </button>`;
    }).join("");

    const updatedStr = _lastUpdated ? _lastUpdated.toLocaleTimeString() : "";

    return `
      <div class="bzr-shell">
        <div class="bzr-hdr">
          <div class="bzr-hdr-left">
            <img src="/icons/bazarr.png" alt="Bazarr" class="bzr-icon">
            <span class="bzr-title">Bazarr</span>
          </div>
          <div class="bzr-hdr-right">
            <div class="bzr-tabs">${tabsHtml}</div>
            <a class="bzr-open-link" href="${escH(BZR_CONFIG.url)}" target="_blank" rel="noopener">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              Open
            </a>
          </div>
        </div>
        <div class="bzr-body">
          ${loading
        ? `<div class="bzr-loading">
                <svg class="bzr-spin" width="16" height="16" viewBox="0 0 24 24" fill="none"
                     stroke="rgba(234,179,8,0.8)" stroke-width="2">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg> Loading…</div>`
        : `<div class="bzr-scroll">${contentHtml}</div>`}
        </div>
        <div class="bzr-footer">Bazarr · ${updatedStr}</div>
      </div>`;
  }

  /* ── Overview ──────────────────────────────────── */
  function buildOverview() {
    const m = _data.movies;
    const s = _data.series;
    const wantedTotal = _data.wantedMovies.length + _data.wantedEpisodes.length;

    const movieTotal = m?.total ?? 0;
    const movieSubbed = m?.data?.filter(x => x.subtitles?.length > 0).length ?? 0;
    const seriesTotal = s?.total ?? 0;

    return `
      <div class="bzr-stat-grid">
        <div class="bzr-stat">
          <div class="bzr-stat-value">${fmtNum(movieTotal)}</div>
          <div class="bzr-stat-label">Movies</div>
        </div>
        <div class="bzr-stat">
          <div class="bzr-stat-value">${fmtNum(seriesTotal)}</div>
          <div class="bzr-stat-label">Series</div>
        </div>
        <div class="bzr-stat bzr-stat--warn">
          <div class="bzr-stat-value">${fmtNum(_data.wantedMovies.length)}</div>
          <div class="bzr-stat-label">Movies Wanted</div>
        </div>
        <div class="bzr-stat bzr-stat--warn">
          <div class="bzr-stat-value">${fmtNum(_data.wantedEpisodes.length)}</div>
          <div class="bzr-stat-label">Episodes Wanted</div>
        </div>
        <div class="bzr-stat bzr-stat--active">
          <div class="bzr-stat-value">${fmtNum(wantedTotal)}</div>
          <div class="bzr-stat-label">Total Wanted</div>
        </div>
        <div class="bzr-stat bzr-stat--good">
          <div class="bzr-stat-value">${fmtNum(_data.history.length)}</div>
          <div class="bzr-stat-label">Recent Activity</div>
        </div>
      </div>`;
  }

  /* ── Movies ────────────────────────────────────── */
  function buildMovies() {
    const movies = _data.movies?.data || [];
    if (!movies.length) return `<div class="bzr-empty">No movies found</div>`;

    return movies.map(m => {
      const hasSubtitles = m.subtitles?.length > 0;
      const missing = m.missing_subtitles?.length > 0;
      const dotCls = hasSubtitles ? "bzr-dot--good" : missing ? "bzr-dot--warn" : "bzr-dot--neutral";
      const langs = (m.subtitles || []).map(s => s.name || s.code2 || s.language || "").filter(Boolean);

      return `
        <div class="bzr-row">
          <span class="bzr-dot ${dotCls}"></span>
          <div class="bzr-row-body">
            <div class="bzr-row-title">${escH(m.title || "Unknown")}</div>
            <div class="bzr-row-sub">${m.year ? escH(String(m.year)) : ""}${langs.length ? ` · ${escH(langs.join(", "))}` : ""}</div>
          </div>
          <div class="bzr-row-meta">
            ${missing
          ? `<span class="bzr-badge bzr-badge--warn">Missing</span>`
          : hasSubtitles
            ? `<span class="bzr-badge bzr-badge--good">OK</span>`
            : `<span class="bzr-badge bzr-badge--neutral">—</span>`}
          </div>
        </div>`;
    }).join("");
  }

  /* ── Series ────────────────────────────────────── */
  function buildSeries() {
    const series = _data.series?.data || [];
    if (!series.length) return `<div class="bzr-empty">No series found</div>`;

    return series.map(s => {
      const hasSubtitles = (s.subtitles?.length > 0) || (s.episodeFileCount > 0);
      const missing = s.missing_subtitles?.length > 0 || s.episodeMissingCount > 0;
      const dotCls = missing ? "bzr-dot--warn" : hasSubtitles ? "bzr-dot--good" : "bzr-dot--neutral";

      return `
      <div class="bzr-row">
        <span class="bzr-dot ${dotCls}"></span>
        <div class="bzr-row-body">
          <div class="bzr-row-title">${escH(s.title || s.seriesTitle || "Unknown")}</div>
          <div class="bzr-row-sub">${s.year ? escH(String(s.year)) : ""}${s.episodeFileCount != null ? ` · ${s.episodeFileCount} episodes` : ""}</div>
        </div>
        <div class="bzr-row-meta">
          ${missing
          ? `<span class="bzr-badge bzr-badge--warn">Missing</span>`
          : `<span class="bzr-badge bzr-badge--good">OK</span>`}
        </div>
      </div>`;
    }).join("");
  }

  /* ── Wanted ────────────────────────────────────── */
  function buildWanted() {
    const movies = _data.wantedMovies;
    const episodes = _data.wantedEpisodes;

    if (!movies.length && !episodes.length) {
      return `<div class="bzr-empty">Nothing wanted — all subtitles found!</div>`;
    }

    const movieRows = movies.map(m => `
      <div class="bzr-row">
        <span class="bzr-dot bzr-dot--warn"></span>
        <div class="bzr-row-body">
          <div class="bzr-row-title">${escH(m.title || "Unknown")}</div>
          <div class="bzr-row-sub">Movie · ${escH((m.missing_subtitles || []).map(s => s.name || s.code2 || "").filter(Boolean).join(", ") || "Unknown language")}</div>
        </div>
        <div class="bzr-row-meta">
          <span class="bzr-badge bzr-badge--warn">Movie</span>
        </div>
      </div>`).join("");

    const episodeRows = episodes.map(ep => {
      const epNum = ep.season_number != null && ep.episode_number != null
        ? `S${String(ep.season_number).padStart(2, "0")}E${String(ep.episode_number).padStart(2, "0")}` : "";
      return `
      <div class="bzr-row">
        <span class="bzr-dot bzr-dot--warn"></span>
        <div class="bzr-row-body">
          <div class="bzr-row-title">${escH(ep.seriesTitle || ep.title || "Unknown")}${epNum ? ` <span class="bzr-ep">${escH(epNum)}</span>` : ""}</div>
          <div class="bzr-row-sub">Episode · ${escH((ep.missing_subtitles || []).map(s => s.name || s.code2 || "").filter(Boolean).join(", ") || "Unknown language")}</div>
        </div>
        <div class="bzr-row-meta">
          <span class="bzr-badge bzr-badge--warn">Episode</span>
        </div>
      </div>`;
    }).join("");

    return movieRows + episodeRows;
  }

  /* ── History ───────────────────────────────────── */
  function buildHistory() {
    const history = _data.history;
    if (!history.length) return `<div class="bzr-empty">No history found</div>`;

    return history.map(h => {
      const lang = h.language?.name || h.language_code || h.language || "";
      const provider = h.provider || "";
      const title = h.title || h.seriesTitle || h.video_path?.split("/").pop() || "Unknown";
      const isMovie = h._type === "movie";

      return `
        <div class="bzr-row">
          <span class="bzr-dot bzr-dot--good"></span>
          <div class="bzr-row-body">
            <div class="bzr-row-title">${escH(title)}</div>
            <div class="bzr-row-sub">${escH(lang)}${provider ? ` · ${escH(provider)}` : ""} · ${fmtDate(h.timestamp || h.date)}</div>
          </div>
          <div class="bzr-row-meta">
            <span class="bzr-badge ${isMovie ? "bzr-badge--movie" : "bzr-badge--series"}">${isMovie ? "Movie" : "Episode"}</span>
            <span class="bzr-time">${fmtTime(h.timestamp || h.date)}</span>
          </div>
        </div>`;
    }).join("");
  }

  /* ── Render ────────────────────────────────────── */
  function renderContent() {
    if (_tab === "overview") return buildOverview();
    if (_tab === "movies") return buildMovies();
    if (_tab === "series") return buildSeries();
    if (_tab === "wanted") return buildWanted();
    if (_tab === "history") return buildHistory();
    return buildOverview();
  }

  function paint(loading = false) {
    if (!_host) return;
    _host.innerHTML = buildShell(loading ? "" : renderContent(), loading);
    if (!loading && (_tab === "history" || _tab === "wanted" || _tab === "movies" || _tab === "series")) {
      const scroll = _host.querySelector(".bzr-scroll");
      if (scroll) scroll.classList.add("bzr-scroll--scrollable");
    }
    bindEvents();
  }

  function bindEvents() {
    if (!_host) return;
    _host.querySelectorAll(".bzr-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        _tab = btn.dataset.tab;
        paint();
      });
    });
  }

  async function refresh() {
    if (_rendering) return;
    _rendering = true;
    paint(true);
    try {
      _data = await fetchAll();
      _lastUpdated = new Date();
      paint(false);
    } catch (err) {
      console.error("[BazarrWidget]", err);
      if (_host) _host.innerHTML = buildShell(
        `<div class="bzr-empty" style="color:#f87171">Failed to load Bazarr data</div>`, false);
    } finally {
      _rendering = false;
    }
  }

  /* ── Init ──────────────────────────────────────── */
  function init() {
    const start = () => setTimeout(() => {
      const group = findGroup(BZR_CONFIG.groupName);
      if (!group) return;
      _host = ensureHost(group);
      refresh();
      setInterval(() => {
        if (document.hidden) return;
        refresh();
      }, BZR_CONFIG.pollMs);
    }, 1400);

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }

    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        if (!document.querySelector(".bzr-host .bzr-shell")) {
          const group = findGroup(BZR_CONFIG.groupName);
          if (!group) return;
          _host = ensureHost(group);
          refresh();
        }
      }, 700);
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();

