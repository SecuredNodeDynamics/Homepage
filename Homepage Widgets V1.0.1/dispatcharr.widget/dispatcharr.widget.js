/* =====================================================
   DISPATCHARR WIDGET
===================================================== */
(function () {
  const DSP_CONFIG = {
    groupName: "ARR - DISPATCHARR",
    url: "https://dispatcharr.example.com",
    fallbackUrl: null,
    username: "PLACEHOLDER_USERNAME",
    password: "PLACEHOLDER_PASSWORD",
    pollMs: 60_000,
    debug: false,
  };

  let _pollTimer = null;
  let _rendered = false;
  let _data = {};
  let _activeTab = "guide";
  let _token = null;
  let _tokenExpiry = 0;

  // Auth rate-limit backoff state
  let _authBackoffUntil = 0;
  let _authFailCount = 0;
  const AUTH_BACKOFF_BASE_MS = 30_000;   // 30 s minimum after first 429
  const AUTH_BACKOFF_MAX_MS = 600_000;  // cap at 10 min

  function normText(v) {
    return (v || "").replace(/\s+/g, " ").trim();
  }

  function escH(s = "") {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function asArray(v) {
    if (Array.isArray(v)) return v;
    if (Array.isArray(v?.results)) return v.results;
    if (Array.isArray(v?.data)) return v.data;
    return [];
  }

  function findGroupContainer(name) {
    const hd = Array.from(
      document.querySelectorAll("h2,h3,.group-title,.service-group-name")
    ).find(el => normText(el.textContent) === name);
    if (!hd) return null;
    return (
      hd.closest("section") ||
      hd.closest("div[class*='group']") ||
      hd.parentElement?.parentElement ||
      hd.parentElement
    );
  }

  function ensureHost(group) {
    let row = group.querySelector(".dsp-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "dsp-flex-row";
      group.appendChild(row);
    }
    let host = row.querySelector(".dsp-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "dsp-host";
    row.appendChild(host);
    return host;
  }

  /* ── Auth ──────────────────────────────────────── */
  let _tokenInFlight = null;

  async function ensureToken() {
    if (Date.now() < _authBackoffUntil) {
      const waitSec = Math.ceil((_authBackoffUntil - Date.now()) / 1000);
      throw new Error(`Dispatcharr auth rate-limited; retry in ${waitSec}s`);
    }
    if (_token && Date.now() < _tokenExpiry) return _token;

    // Dedupe: all concurrent callers share the same in-flight request
    if (_tokenInFlight) return _tokenInFlight;

    _tokenInFlight = (async () => {
      let res;
      try {
        res = await fetch(`${DSP_CONFIG.url}/api/accounts/token/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: DSP_CONFIG.username,
            password: DSP_CONFIG.password,
          }),
          signal: (() => {
            const c = new AbortController();
            setTimeout(() => c.abort(), 8000);
            return c.signal;
          })(),
        });
      } catch (err) {
        throw err;
      } finally {
        _tokenInFlight = null;
      }

      if (res.status === 429) {
        _authFailCount++;
        const backoff = Math.min(
          AUTH_BACKOFF_BASE_MS * Math.pow(2, _authFailCount - 1),
          AUTH_BACKOFF_MAX_MS
        );
        _authBackoffUntil = Date.now() + backoff;
        _token = null;
        console.warn(`[DispatcharrWidget] 429 on auth — backing off ${backoff / 1000}s (attempt ${_authFailCount})`);
        throw new Error(`Dispatcharr auth 429`);
      }

      if (!res.ok) throw new Error(`Dispatcharr auth ${res.status}`);

      _authFailCount = 0;
      _authBackoffUntil = 0;
      const j = await res.json();
      _token = j.access;
      _tokenExpiry = Date.now() + 4.5 * 60 * 1000;
      return _token;
    })();

    return _tokenInFlight;
  }

  async function dspFetch(path) {
    const token = await ensureToken();
    const res = await fetch(`${DSP_CONFIG.url}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: (() => {
        const c = new AbortController();
        setTimeout(() => c.abort(), 8000);
        return c.signal;
      })(),
    });
    if (res.status === 401) {
      _token = null; // force re-auth next call
      throw new Error(`Dispatcharr 401: ${path}`);
    }
    if (res.status === 405) {
      // Endpoint exists but method not allowed — return empty gracefully
      console.warn(`[DispatcharrWidget] 405 Method Not Allowed: ${path} — skipping`);
      return [];
    }
    if (!res.ok) throw new Error(`Dispatcharr ${res.status}: ${path}`);
    return res.json();
  }

  /* ── Data fetch ────────────────────────────────── */
  async function fetchAll() {
    const [recordings, series, recurring, channels, grid, epgdata, logos] = await Promise.allSettled([
      dspFetch("/api/channels/recordings/"),
      dspFetch("/api/channels/series-rules/"),
      dspFetch("/api/channels/recurring-rules/"),
      dspFetch("/api/channels/channels/?page_size=500"),
      dspFetch("/api/epg/grid/"),
      dspFetch("/api/epg/epgdata/?page_size=1000"),
      dspFetch("/api/channels/logos/?page_size=1000"),
    ]);

    _data = {
      recordings: recordings.status === "fulfilled" ? asArray(recordings.value) : [],
      series: series.status === "fulfilled" ? asArray(series.value) : [],
      recurring: recurring.status === "fulfilled" ? asArray(recurring.value) : [],
      channels: channels.status === "fulfilled" ? asArray(channels.value) : [],
      epg: grid.status === "fulfilled" ? asArray(grid.value) : [],
      epgdata: epgdata.status === "fulfilled" ? asArray(epgdata.value) : [],
      logos: logos.status === "fulfilled" ? asArray(logos.value) : [],
      error: !_token,
    };
  }

  /* ── Helpers ───────────────────────────────────── */
  function fmtDt(ts) {
    if (!ts) return "—";
    try {
      return new Date(ts).toLocaleString("en-US", {
        month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true,
      });
    } catch { return "—"; }
  }

  function fmtDate(ts) {
    if (!ts) return "—";
    try {
      return new Date(ts).toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric",
      });
    } catch { return "—"; }
  }

  function fmtTime(ts) {
    if (!ts) return "—";
    try {
      return new Date(ts).toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit", hour12: true,
      });
    } catch { return "—"; }
  }

  function statusColor(status = "") {
    const s = status.toLowerCase();
    if (["completed"].includes(s)) return "rgba(74,222,128,0.85)";
    if (["recording", "active"].includes(s)) return "rgba(251,146,60,0.85)";
    if (["scheduled"].includes(s)) return "rgba(96,165,250,0.85)";
    if (["interrupted", "failed"].includes(s)) return "rgba(251,113,133,0.85)";
    return "rgba(255,255,255,0.35)";
  }

  function statusDot(status = "") {
    return `<span class="dsp-dot" style="background:${statusColor(status)}"></span>`;
  }

  function recTitle(item) {
    return item.title || item.name || resolveChannelName(item) || String(item.id || "Unknown");
  }

  function resolveChannelName(item) {
    if (item.channel_name) return item.channel_name;
    if (typeof item.channel === "string") return item.channel;
    if (typeof item.channel === "number") {
      const ch = (_data.channels || []).find(c => c.id === item.channel);
      return ch ? ch.name : `Channel ${item.channel}`;
    }
    return "—";
  }

  /* ── Widget shell ──────────────────────────────── */
  function buildWidget() {
    const recs = _data.recordings || [];
    const activeRecs = recs.filter(r => (r.status || "").toLowerCase() === "recording");

    const inBackoff = Date.now() < _authBackoffUntil;
    const statusCls = inBackoff ? "dsp-status--offline" : "dsp-status--active";
    const statusTxt = inBackoff
      ? "Rate limited"
      : activeRecs.length > 0 ? `${activeRecs.length} Recording` : "Online";

    const TABS = [
      { id: "recordings", label: "Recordings" },
      { id: "scheduled", label: "Scheduled" },
      { id: "series", label: "Series" },
      { id: "recurring", label: "Recurring" },
      { id: "guide", label: "TV Guide" },
    ];

    return `
      <div class="dsp-shell">
        <div class="dsp-header">
          <div class="dsp-header-left">
            <img src="/icons/dispatcharr.png" alt="Dispatcharr" class="dsp-icon">
            <div class="dsp-title">Dispatcharr</div>
          </div>
          <div class="dsp-header-right">
            <div class="dsp-tabs">
              ${TABS.map(t => `
                <button class="dsp-tab ${_activeTab === t.id ? "dsp-tab--active" : ""}"
                        data-tab="${t.id}">${escH(t.label)}</button>
              `).join("")}
            </div>
            <span class="dsp-status ${statusCls}">${escH(statusTxt)}</span>
            <a class="dsp-open-link" href="${escH(DSP_CONFIG.url)}" target="_blank" rel="noopener">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              Open
            </a>
          </div>
        </div>

        <div class="dsp-body">${buildTabContent()}</div>

        <div class="dsp-footer">
          Updated ${new Date().toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
    })}
        </div>
      </div>
    `;
  }

  /* ── Tab: Recordings ─────────────────────────── */
  function buildRecordingsTab() {
    const recs = (_data.recordings || []).filter(r => {
      const s = (r.status || "").toLowerCase();
      return ["completed", "recording", "interrupted"].includes(s);
    });

    if (!recs.length) return `<div class="dsp-card"><div class="dsp-empty">No recordings found</div></div>`;

    return `
  <div class="dsp-card">
    <div class="dsp-card-title">Recordings — ${recs.length}</div>
    <div class="dsp-list">
      ${recs.map(item => {
      const status = item.status || "—";
      const end = item.end_time || item.end || item.stop || null;
      const ch = resolveChannelName(item);
      return `
          <div class="dsp-list-row">
            <div class="dsp-list-main">
              <div class="dsp-list-title">${statusDot(status)}${escH(recTitle(item))}</div>
              <div class="dsp-list-sub">${escH(ch)} · ${escH(status)}${end ? ` · ${fmtDt(end)}` : ""}</div>
            </div>
          </div>`;
    }).join("")}
    </div>
  </div>`;
  }

  /* ── Tab: Scheduled ──────────────────────────── */
  function buildScheduledTab() {
    const recs = (_data.recordings || []).filter(r => {
      const s = (r.status || "").toLowerCase();
      return ["scheduled", "pending", "queued"].includes(s);
    });

    if (!recs.length) return `<div class="dsp-card"><div class="dsp-empty">Nothing scheduled</div></div>`;

    return `
      <div class="dsp-card">
        <div class="dsp-card-title">Scheduled — ${recs.length}</div>
        <div class="dsp-list">
          ${recs.map(item => {
      const status = item.status || "scheduled";
      const start = item.start_time || item.start || item.startTime || null;
      const end = item.end_time || item.end || item.endTime || null;
      const ch = item.channel_name || item.channel || "—";
      return `
              <div class="dsp-list-row">
                <div class="dsp-list-main">
                  <div class="dsp-list-title">${statusDot(status)}${escH(recTitle(item))}</div>
                  <div class="dsp-list-sub">
                    ${escH(ch)}
                    ${start ? ` · ${fmtDt(start)}` : ""}
                    ${end ? ` – ${fmtTime(end)}` : ""}
                  </div>
                </div>
              </div>`;
    }).join("")}
        </div>
      </div>`;
  }

  /* ── Tab: Series rules ───────────────────────── */
  function buildSeriesTab() {
    const rules = _data.series || [];
    if (!rules.length) return `<div class="dsp-card"><div class="dsp-empty">No series rules</div></div>`;

    return `
      <div class="dsp-card">
        <div class="dsp-card-title">Series Rules — ${rules.length}</div>
        <div class="dsp-list">
          ${rules.map(rule => {
      const title = rule.title || rule.tvg_id || rule.name || "—";
      const tvgId = rule.tvg_id || "—";
      const mode = rule.mode || "—";
      return `
              <div class="dsp-list-row">
                <div class="dsp-list-main">
                  <div class="dsp-list-title">
                    <span class="dsp-dot" style="background:rgba(96,165,250,0.85)"></span>
                    ${escH(title)}
                  </div>
                  <div class="dsp-list-sub">${escH(tvgId)} · Mode: ${escH(mode)}</div>
                </div>
              </div>`;
    }).join("")}
        </div>
      </div>`;
  }

  /* ── Tab: Recurring rules ────────────────────── */
  function buildRecurringTab() {
    const rules = _data.recurring || [];
    if (!rules.length) return `<div class="dsp-card"><div class="dsp-empty">No recurring rules</div></div>`;

    const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    return `
      <div class="dsp-card">
        <div class="dsp-card-title">Recurring Rules — ${rules.length}</div>
        <div class="dsp-list">
          ${rules.map(rule => {
      const title = rule.title || rule.name || rule.channel_name || String(rule.id || "—");
      const start = rule.start_time || rule.startTime || "—";
      const end = rule.end_time || rule.endTime || "—";
      const days = Array.isArray(rule.days_of_week)
        ? rule.days_of_week.map(d => DAYS[d] || d).join(", ")
        : (rule.days_of_week || "Daily");
      return `
              <div class="dsp-list-row">
                <div class="dsp-list-main">
                  <div class="dsp-list-title">
                    <span class="dsp-dot" style="background:rgba(167,139,250,0.85)"></span>
                    ${escH(title)}
                  </div>
                  <div class="dsp-list-sub">${escH(days)} · ${escH(start)}–${escH(end)}</div>
                </div>
              </div>`;
    }).join("")}
        </div>
      </div>`;
  }

  /* ── Tab: TV Guide ───────────────────────────── */
  function buildGuideTab() {
    const programs = _data.epg || [];
    const channels = _data.channels || [];
    const logos = _data.logos || [];

    // Build logo_id → cache_url map
    const logoMap = {};
    logos.forEach(l => { logoMap[l.id] = l.cache_url; });

    // Build uuid → programs lookup (grid uses channel uuid as tvg_id)
    const byUuid = {};
    programs.forEach(p => {
      if (!p.tvg_id) return;
      if (!byUuid[p.tvg_id]) byUuid[p.tvg_id] = [];
      byUuid[p.tvg_id].push(p);
    });

    Object.values(byUuid).forEach(progs =>
      progs.sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
    );

    const now = Date.now();

    const rows = channels.map(ch => {
      const progs = byUuid[ch.uuid] || [];
      const current = progs.find(p => {
        const s = new Date(p.start_time).getTime();
        const e = new Date(p.end_time).getTime();
        return s <= now && e >= now;
      });
      const next = current
        ? progs.find(p => new Date(p.start_time).getTime() >= new Date(current.end_time).getTime())
        : progs.find(p => new Date(p.start_time).getTime() > now);
      return { ch, current, next };
    }).filter(r => r.current || r.next);

    if (!rows.length) return `
    <div class="dsp-card">
      <div class="dsp-empty">No program data available</div>
    </div>`;

    const nowStr = new Date().toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", hour12: true,
    });

    return `
    <div class="dsp-card">
      <div class="dsp-card-title">Now on Air — ${rows.length} channels</div>
      <div class="tg-now">Now: ${nowStr}</div>
      <div class="tg-guide">
        ${rows.map(({ ch, current, next }) => {
      const chName = ch.name || ch.tvg_id || "—";
      const chNum = ch.channel_number ? `CH ${Math.floor(ch.channel_number)}` : "";
      const logoUrl = ch.logo_id ? logoMap[ch.logo_id] : null;

      const chLeft = logoUrl ? `
          <div class="tg-ch-logo-wrap">
            <img class="tg-ch-logo"
                 src="${escH(logoUrl)}"
                 alt="${escH(chName)}"
                 onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
            <div class="tg-ch-logo-fallback" style="display:none">
              <div class="tg-ch-name">${escH(chName)}</div>
              ${chNum ? `<div class="tg-ch-num">${escH(chNum)}</div>` : ""}
            </div>
          </div>` : `
          <div class="tg-ch-name">${escH(chName)}</div>
          ${chNum ? `<div class="tg-ch-num">${escH(chNum)}</div>` : ""}`;

      let currentHtml = "";
      if (current) {
        const s = new Date(current.start_time).getTime();
        const e = new Date(current.end_time).getTime();
        const pct = Math.min(100, Math.max(0, Math.round(((now - s) / (e - s)) * 100)));
        const timeStr = `${fmtTime(current.start_time)} – ${fmtTime(current.end_time)}`;
        const epInfo = current.season && current.episode
          ? `<span class="tg-ep">S${current.season} E${current.episode}</span>` : "";
        const badges = [
          current.is_live ? `<span class="dsp-badge dsp-badge--live">LIVE</span>` : "",
          current.is_new ? `<span class="dsp-badge dsp-badge--new">NEW</span>` : "",
          current.is_premiere ? `<span class="dsp-badge dsp-badge--new">PREMIERE</span>` : "",
        ].join("");
        currentHtml = `
            <div class="tg-prog tg-prog--current">
              <div class="tg-prog-label tg-prog-label--now">Now</div>
              <div class="tg-prog-title">${escH(current.title)}${epInfo}${badges}</div>
              ${current.sub_title ? `<div class="tg-prog-sub">${escH(current.sub_title)}</div>` : ""}
              <div class="tg-bar-wrap">
                <div class="tg-bar"><div class="tg-fill" style="width:${pct}%"></div></div>
                <span class="tg-pct">${pct}%</span>
              </div>
              <div class="tg-prog-time">${escH(timeStr)}</div>
            </div>`;
      }

      let nextHtml = "";
      if (next) {
        const timeStr = `${fmtTime(next.start_time)} – ${fmtTime(next.end_time)}`;
        const epInfo = next.season && next.episode
          ? `<span class="tg-ep">S${next.season} E${next.episode}</span>` : "";
        nextHtml = `
            <div class="tg-prog tg-prog--next">
              <div class="tg-prog-label tg-prog-label--next">Up Next</div>
              <div class="tg-prog-title tg-prog-title--next">${escH(next.title)}${epInfo}</div>
              ${next.sub_title ? `<div class="tg-prog-sub tg-prog-sub--next">${escH(next.sub_title)}</div>` : ""}
              <div class="tg-prog-time">${escH(timeStr)}</div>
            </div>`;
      }

      return `
          <div class="tg-row">
            <div class="tg-ch">
              ${chLeft}
            </div>
            <div class="tg-progs">
              ${currentHtml}
              ${nextHtml}
            </div>
          </div>`;
    }).join("")}
      </div>
    </div>`;
  }

  function buildTabContent() {
    if (_activeTab === "recordings") return buildRecordingsTab();
    if (_activeTab === "scheduled") return buildScheduledTab();
    if (_activeTab === "series") return buildSeriesTab();
    if (_activeTab === "recurring") return buildRecurringTab();
    if (_activeTab === "guide") return buildGuideTab();
    return buildRecordingsTab();
  }

  /* ── Events ────────────────────────────────────── */
  function bindEvents(host) {
    host.querySelectorAll("[data-tab]").forEach(btn => {
      if (btn._bound) return;
      btn._bound = true;
      btn.addEventListener("click", () => {
        _activeTab = btn.dataset.tab;
        render(host);
      });
    });
  }

  /* ── Render ────────────────────────────────────── */
  function render(host) {
    if (!host) return;
    const scrollY = window.scrollY;
    host.innerHTML = buildWidget();
    bindEvents(host);
    _rendered = true;
    window.scrollTo({ top: scrollY, behavior: "instant" });
  }

  async function refresh() {
    const group = findGroupContainer(DSP_CONFIG.groupName);
    if (!group) return;
    const host = ensureHost(group);

    try {
      await fetchAll();
      render(host);
    } catch (err) {
      console.error("[DispatcharrWidget]", err);
      // Only wipe the UI if we haven't rendered successfully yet
      if (!_rendered) {
        host.innerHTML = `
          <div class="dsp-shell">
            <div class="dsp-card">
              <div class="dsp-empty">Unable to load Dispatcharr data.</div>
            </div>
          </div>`;
      }
    }
  }

  function startPolling() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(refresh, DSP_CONFIG.pollMs);
  }

  function init() {
    const boot = () => { refresh(); startPolling(); };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
      boot();
    }
    const mo = new MutationObserver(() => {
      const group = findGroupContainer(DSP_CONFIG.groupName);
      if (group && !_rendered) refresh();
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  init();
})();

