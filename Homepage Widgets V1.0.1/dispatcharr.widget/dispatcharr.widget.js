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
    let _activeTab = "recordings";
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
        const [recordings, series, recurring, channels] = await Promise.allSettled([
            dspFetch("/api/dvr/recordings/"),
            dspFetch("/api/series-rules/"),
            dspFetch("/api/dvr/recurring-rules/"),
            dspFetch("/api/channels/channels/?page_size=500"),
        ]);

        _data = {
            recordings: recordings.status === "fulfilled" ? asArray(recordings.value) : [],
            series: series.status === "fulfilled" ? asArray(series.value) : [],
            recurring: recurring.status === "fulfilled" ? asArray(recurring.value) : [],
            channels: channels.status === "fulfilled" ? asArray(channels.value) : [],
            epg: [],
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
        return item.title || item.name || item.channel_name || String(item.id || "Unknown");
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
            const ch = item.channel_name || item.channel || "—";
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

        const chMap = {};
        channels.forEach(c => { chMap[c.id] = c.name || c.channel_name || String(c.id); });

        if (!programs.length) return `
      <div class="dsp-card">
        <div class="dsp-empty">No current program data</div>
      </div>`;

        const now = Date.now();

        return `
      <div class="dsp-card">
        <div class="dsp-card-title">Now on Air — ${programs.length} channels</div>
        <div class="dsp-list">
          ${programs.map(prog => {
            const chName = chMap[prog.channel_id] || prog.channel_name || prog.channel || "—";
            const title = prog.title || prog.name || prog.program_title || "—";
            const start = prog.start || prog.start_time || prog.startTime || null;
            const stop = prog.stop || prog.end_time || prog.endTime || null;

            let pct = 0;
            if (start && stop) {
                const s = new Date(start).getTime();
                const e = new Date(stop).getTime();
                pct = Math.min(100, Math.max(0, Math.round(((now - s) / (e - s)) * 100)));
            }

            const timeStr = start && stop ? `${fmtTime(start)} – ${fmtTime(stop)}` : "—";

            return `
              <div class="dsp-list-row dsp-list-row--guide">
                <div class="dsp-list-main">
                  <div class="dsp-guide-ch">${escH(chName)}</div>
                  <div class="dsp-list-title" style="margin-top:3px">${escH(title)}</div>
                  <div class="dsp-progress-wrap">
                    <div class="dsp-progress-bar">
                      <div class="dsp-progress-fill" style="width:${pct}%"></div>
                    </div>
                    <span class="dsp-progress-pct">${pct}%</span>
                  </div>
                  <div class="dsp-list-sub">${escH(timeStr)}</div>
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