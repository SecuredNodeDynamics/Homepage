/* =====================================================
   WIZARR WIDGET
   Media Tab → group: ARR — WIZARR
===================================================== */
(function () {

  const WZR_CONFIG = {
    groupName: "ARR — WIZARR",
    url: "http://YOUR_LOCAL_IP:PORT",
    internalUrl: "https://YOUR_TUNNEL_URL", // or null if not using a tunnel
    key: "YOUR_API_KEY_HERE",
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
  function fmtNum(n) { return n == null ? "—" : Number(n).toLocaleString(); }
  function timeUntil(iso) {
    if (!iso) return "Never";
    const diff = new Date(iso) - Date.now();
    if (diff <= 0) return "Expired";
    const days = Math.floor(diff / 86400000);
    const hrs = Math.floor((diff % 86400000) / 3600000);
    if (days > 0) return `${days}d ${hrs}h`;
    const mins = Math.floor((diff % 3600000) / 60000);
    if (hrs > 0) return `${hrs}h ${mins}m`;
    return `${mins}m`;
  }

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
    let row = group.querySelector(".hp-widget-row, .wzr-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "hp-widget-row wzr-flex-row";
      group.appendChild(row);
    } else {
      row.classList.add("hp-widget-row", "wzr-flex-row");
    }
    let host = row.querySelector(".wzr-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "wzr-host";
    row.appendChild(host);
    return host;
  }

  /* ── API ───────────────────────────────────────── */
  async function wzrFetch(path, options = {}) {
    const res = await fetch(`${WZR_CONFIG.internalUrl}${path}`, {
      ...options,
      headers: {
        "X-API-KEY": WZR_CONFIG.key,
        "Accept": "application/json",
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })(),
    });
    console.log(`[Wizarr] ${path} → ${res.status}`);
    if (!res.ok) throw new Error(`Wizarr ${res.status}: ${path}`);
    const text = await res.text();
    return JSON.parse(text);
  }

  async function fetchAll() {
    const [users, invitations, servers] = await Promise.allSettled([
      wzrFetch("/api/users"),
      wzrFetch("/api/invitations"),
      wzrFetch("/api/servers"),
    ]);

    return {
      users: users.status === "fulfilled"
        ? (users.value?.users || users.value?.data || []) : [],
      invitations: invitations.status === "fulfilled"
        ? (invitations.value?.invitations || invitations.value?.data || []) : [],
      servers: servers.status === "fulfilled"
        ? (servers.value?.servers || servers.value?.data || []) : [],
    };
  }

  /* ── State ─────────────────────────────────────── */
  let _tab = "overview";
  let _data = { users: [], invitations: [], servers: [] };
  let _host = null;
  let _rendering = false;
  let _lastUpdated = null;

  /* ── Modal ─────────────────────────────────────── */
  function openCreateModal() {
    // Remove existing modal if any
    document.getElementById("wzr-modal-overlay")?.remove();

    const servers = _data.servers;
    const serverOptions = servers.map(s =>
      `<option value="${escH(String(s.id))}">${escH(s.name)}</option>`
    ).join("");

    const overlay = document.createElement("div");
    overlay.id = "wzr-modal-overlay";
    overlay.className = "wzr-modal-overlay";
    overlay.innerHTML = `
      <div class="wzr-modal" role="dialog" aria-modal="true">
        <div class="wzr-modal-hdr">
          <span class="wzr-modal-title">Create Invitation</span>
          <button class="wzr-modal-close" id="wzr-modal-close-btn" aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div class="wzr-modal-body">

          <div class="wzr-field">
            <label class="wzr-label">Server</label>
            <select class="wzr-input" id="wzr-f-server">
              ${serverOptions || '<option value="">No servers found</option>'}
            </select>
          </div>

          <div class="wzr-field">
            <label class="wzr-label">Invitation Label <span class="wzr-label-hint">(optional)</span></label>
            <input class="wzr-input" id="wzr-f-label" type="text" placeholder="e.g. Friends & Family">
          </div>

          <div class="wzr-field-row">
            <div class="wzr-field">
              <label class="wzr-label">Expires In</label>
              <select class="wzr-input" id="wzr-f-expires">
                <option value="">Never</option>
                <option value="1">1 day</option>
                <option value="3">3 days</option>
                <option value="7">7 days</option>
                <option value="14">14 days</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
              </select>
            </div>
            <div class="wzr-field">
              <label class="wzr-label">Access Duration</label>
              <select class="wzr-input" id="wzr-f-duration">
                <option value="unlimited">Unlimited</option>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="180">180 days</option>
                <option value="365">365 days</option>
              </select>
            </div>
          </div>

          <div class="wzr-field">
            <label class="wzr-label">Permissions</label>
            <div class="wzr-checks">
              <label class="wzr-check">
                <input type="checkbox" id="wzr-f-downloads"> Allow Downloads
              </label>
              <label class="wzr-check">
                <input type="checkbox" id="wzr-f-livetv"> Allow Live TV
              </label>
            </div>
          </div>

          <div id="wzr-modal-result" class="wzr-modal-result" style="display:none">
            <div class="wzr-result-label">Invitation Link</div>
            <div class="wzr-result-row">
              <input class="wzr-input wzr-result-input" id="wzr-result-url" type="text" readonly>
              <button class="wzr-copy-btn" id="wzr-copy-btn">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                Copy
              </button>
            </div>
          </div>

          <div id="wzr-modal-error" class="wzr-modal-error" style="display:none"></div>

        </div>

        <div class="wzr-modal-footer">
          <button class="wzr-btn wzr-btn--ghost" id="wzr-modal-cancel-btn">Cancel</button>
          <button class="wzr-btn wzr-btn--primary" id="wzr-modal-submit-btn">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Create Invite
          </button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    // Close handlers
    const close = () => overlay.remove();
    document.getElementById("wzr-modal-close-btn").addEventListener("click", close);
    document.getElementById("wzr-modal-cancel-btn").addEventListener("click", close);
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });

    // Copy handler
    document.getElementById("wzr-copy-btn").addEventListener("click", () => {
      const input = document.getElementById("wzr-result-url");
      input.select();
      navigator.clipboard.writeText(input.value).catch(() => document.execCommand("copy"));
      const btn = document.getElementById("wzr-copy-btn");
      btn.textContent = "Copied!";
      setTimeout(() => {
        btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg> Copy`;
      }, 2000);
    });

    // Submit handler
    document.getElementById("wzr-modal-submit-btn").addEventListener("click", async () => {
      const submitBtn = document.getElementById("wzr-modal-submit-btn");
      const errorEl = document.getElementById("wzr-modal-error");
      const resultEl = document.getElementById("wzr-modal-result");

      errorEl.style.display = "none";
      resultEl.style.display = "none";
      submitBtn.disabled = true;
      submitBtn.textContent = "Creating…";

      const serverId = document.getElementById("wzr-f-server").value;
      const label = document.getElementById("wzr-f-label").value.trim();
      const expires = document.getElementById("wzr-f-expires").value;
      const duration = document.getElementById("wzr-f-duration").value;
      const allowDownloads = document.getElementById("wzr-f-downloads").checked;
      const allowLiveTV = document.getElementById("wzr-f-livetv").checked;

      const payload = {
        server_ids: serverId,
        duration: duration,
        allow_downloads: allowDownloads,
        allow_live_tv: allowLiveTV,
      };
      if (expires) payload.expires_in_days = parseInt(expires);
      if (label) payload.label = label;

      try {
        const result = await wzrFetch("/api/invitations", {
          method: "POST",
          body: JSON.stringify(payload),
        });

        const url = result?.url || result?.invitation?.url || result?.data?.url || "";
        if (!url) throw new Error("No invitation URL in response");

        // Replace internal URL with public URL
        const publicUrl = url.replace(WZR_CONFIG.internalUrl, WZR_CONFIG.url)
          .replace("https://YOUR_TUNNEL_URL", WZR_CONFIG.url);

        document.getElementById("wzr-result-url").value = publicUrl;
        resultEl.style.display = "block";

        // Refresh widget data in background
        fetchAll().then(data => {
          _data = data;
          _lastUpdated = new Date();
        });

      } catch (err) {
        console.error("[WizarrWidget] create invite error:", err);
        errorEl.textContent = `Failed to create invitation: ${err.message}`;
        errorEl.style.display = "block";
      } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg> Create Invite`;
      }
    });
  }

  /* ── Shell ─────────────────────────────────────── */
  function buildShell(contentHtml, loading) {
    const tabs = [
      { key: "overview", label: "Overview" },
      { key: "users", label: "Users" },
      { key: "invitations", label: "Invites" },
    ];

    const tabsHtml = tabs.map(t => {
      const activeInvites = Array.isArray(_data.invitations)
        ? _data.invitations.filter(i => !i.expires || new Date(i.expires) > Date.now()).length
        : 0;
      const badge = t.key === "invitations" && activeInvites
        ? ` <span class="wzr-tab-badge">${activeInvites}</span>` : "";
      return `
        <button class="wzr-tab ${_tab === t.key ? "wzr-tab--active" : ""}" data-tab="${t.key}">
          ${t.label}${badge}
        </button>`;
    }).join("");

    const updatedStr = _lastUpdated ? _lastUpdated.toLocaleTimeString() : "";

    return `
      <div class="wzr-shell">
        <div class="wzr-hdr">
          <div class="wzr-hdr-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/wizarr.webp" alt="Wizarr" class="wzr-icon">
            <span class="wzr-title">Wizarr</span>
          </div>
          <div class="wzr-hdr-right">
            <div class="wzr-tabs">${tabsHtml}</div>
            <button class="wzr-create-btn" id="wzr-create-btn">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   stroke-width="2.5" stroke-linecap="round">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Create
            </button>
            <a class="wzr-open-link" href="${escH(WZR_CONFIG.url)}" target="_blank" rel="noopener">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              Open
            </a>
          </div>
        </div>
        <div class="wzr-body">
          ${loading
        ? `<div class="wzr-loading">
                <svg class="wzr-spin" width="16" height="16" viewBox="0 0 24 24" fill="none"
                     stroke="rgba(220,38,38,0.8)" stroke-width="2">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg> Loading…</div>`
        : `<div class="wzr-scroll">${contentHtml}</div>`}
        </div>
        <div class="wzr-footer">Wizarr · ${updatedStr}</div>
      </div>`;
  }

  /* ── Overview ──────────────────────────────────── */
  function buildOverview() {
    const totalUsers = _data.users.length;
    const totalInvites = _data.invitations.length;
    const activeInvites = _data.invitations.filter(i => !i.expires || new Date(i.expires) > Date.now()).length;
    const expiredInvites = totalInvites - activeInvites;
    const totalServers = _data.servers.length;
    const recentUsers = _data.users
      .filter(u => u.created_at || u.createdAt)
      .sort((a, b) => new Date(b.created_at || b.createdAt) - new Date(a.created_at || a.createdAt))
      .slice(0, 3);

    return `
      <div class="wzr-stat-grid">
        <div class="wzr-stat wzr-stat--good">
          <div class="wzr-stat-value">${fmtNum(totalUsers)}</div>
          <div class="wzr-stat-label">Total Users</div>
        </div>
        <div class="wzr-stat wzr-stat--active">
          <div class="wzr-stat-value">${fmtNum(activeInvites)}</div>
          <div class="wzr-stat-label">Active Invites</div>
        </div>
        <div class="wzr-stat">
          <div class="wzr-stat-value">${fmtNum(totalServers)}</div>
          <div class="wzr-stat-label">Servers</div>
        </div>
        <div class="wzr-stat wzr-stat--warn">
          <div class="wzr-stat-value">${fmtNum(expiredInvites)}</div>
          <div class="wzr-stat-label">Expired Invites</div>
        </div>
        <div class="wzr-stat">
          <div class="wzr-stat-value">${fmtNum(totalInvites)}</div>
          <div class="wzr-stat-label">Total Invites</div>
        </div>
        <div class="wzr-stat wzr-stat--good">
          <div class="wzr-stat-value">${fmtNum(recentUsers.length)}</div>
          <div class="wzr-stat-label">New (Recent)</div>
        </div>
      </div>
      ${recentUsers.length ? `
        <div class="wzr-section-label">Recently Joined</div>
        ${recentUsers.map(u => `
          <div class="wzr-row">
            <span class="wzr-dot wzr-dot--good"></span>
            <div class="wzr-row-body">
              <div class="wzr-row-title">${escH(u.username || u.email || "Unknown")}</div>
              <div class="wzr-row-sub">Joined ${fmtDate(u.created_at || u.createdAt)}</div>
            </div>
            <div class="wzr-row-meta">
              <span class="wzr-badge wzr-badge--good">Member</span>
            </div>
          </div>`).join("")}
      ` : ""}`;
  }

  /* ── Users ─────────────────────────────────────── */
  function buildUsers() {
    const users = _data.users;
    if (!users.length) return `<div class="wzr-empty">No users found</div>`;

    return users.map(u => {
      const name = u.username || u.email || "Unknown";
      const server = u.server || u.media_server || "";
      return `
        <div class="wzr-row">
          <span class="wzr-dot wzr-dot--good"></span>
          <div class="wzr-row-body">
            <div class="wzr-row-title">${escH(name)}</div>
            <div class="wzr-row-sub">Joined ${fmtDate(u.created_at || u.createdAt)}${server ? ` · ${escH(server)}` : ""}</div>
          </div>
          <div class="wzr-row-meta">
            <span class="wzr-badge wzr-badge--good">Member</span>
          </div>
        </div>`;
    }).join("");
  }

  /* ── Invitations ───────────────────────────────── */
  function buildInvitations() {
    const invites = _data.invitations;
    if (!invites.length) return `<div class="wzr-empty">No invitations found</div>`;

    const sorted = [...invites].sort((a, b) => {
      const aExp = a.expires ? new Date(a.expires) : Infinity;
      const bExp = b.expires ? new Date(b.expires) : Infinity;
      return aExp - bExp;
    });

    return sorted.map(inv => {
      const isExpired = inv.status === "expired" || (inv.expires && new Date(inv.expires) <= Date.now());
      const isUnlimited = !inv.expires;
      const code = inv.code || inv.token || inv.id || "—";
      const uses = inv.used_by != null ? inv.used_by : (inv.uses != null ? inv.uses : "—");
      const maxUses = inv.unlimited ? "∞" : (inv.max_uses || "∞");
      const dotCls = isExpired ? "wzr-dot--warn" : "wzr-dot--good";
      const badgeCls = isExpired ? "wzr-badge--warn" : "wzr-badge--active";
      const badgeLabel = isExpired ? "Expired" : isUnlimited ? "Active" : timeUntil(inv.expires);

      return `
      <div class="wzr-row" data-inv-code="${escH(String(code))}">
        <span class="wzr-dot ${dotCls}"></span>
        <div class="wzr-row-body">
          <div class="wzr-row-title">${escH(inv.label || inv.display_name || code)}</div>
          <div class="wzr-row-sub">
            Code: ${escH(String(code))}
            · Uses: ${escH(String(uses))}/${escH(String(maxUses))}
            ${inv.expires ? ` · Expires: ${fmtDate(inv.expires)}` : " · No expiry"}
          </div>
        </div>
        <div class="wzr-row-meta">
          <span class="wzr-badge ${badgeCls}">${escH(badgeLabel)}</span>
          ${isExpired ? `
          <button class="wzr-delete-btn" data-code="${escH(String(inv.id))}" title="Delete invitation">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6M14 11v6"/>
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
          </button>` : ""}
        </div>
      </div>`;
    }).join("");
  }

  async function deleteInvitation(id) {
    try {
      await wzrFetch(`/api/invitations/${encodeURIComponent(id)}`, { method: "DELETE" });
      _data.invitations = _data.invitations.filter(i => String(i.id) !== String(id));
      paint(false);
    } catch (err) {
      console.error("[WizarrWidget] delete invite error:", err);
    }
  }

  /* ── Render ────────────────────────────────────── */
  function renderContent() {
    if (_tab === "overview") return buildOverview();
    if (_tab === "users") return buildUsers();
    if (_tab === "invitations") return buildInvitations();
    return buildOverview();
  }

  function paint(loading = false) {
    if (!_host) return;
    _host.innerHTML = buildShell(loading ? "" : renderContent(), loading);
    if (!loading && (_tab === "users" || _tab === "invitations")) {
      const scroll = _host.querySelector(".wzr-scroll");
      if (scroll) scroll.classList.add("wzr-scroll--scrollable");
    }
    bindEvents();
  }

  function bindEvents() {
    if (!_host) return;
    _host.querySelectorAll(".wzr-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        _tab = btn.dataset.tab;
        paint();
      });
    });
    const createBtn = _host.querySelector("#wzr-create-btn");
    if (createBtn) createBtn.addEventListener("click", openCreateModal);

    _host.querySelectorAll(".wzr-delete-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const code = btn.dataset.code;
        btn.disabled = true;
        btn.style.opacity = "0.4";
        await deleteInvitation(code);
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
      console.error("[WizarrWidget]", err);
      if (_host) _host.innerHTML = buildShell(
        `<div class="wzr-empty" style="color:#f87171">Failed to load Wizarr data</div>`, false);
    } finally {
      _rendering = false;
    }
  }

  /* ── Init ──────────────────────────────────────── */
  function init() {
    const start = () => setTimeout(() => {
      const group = findGroup(WZR_CONFIG.groupName);
      if (!group) return;
      _host = ensureHost(group);
      refresh();
      setInterval(() => {
        if (document.hidden) return;
        refresh();
      }, WZR_CONFIG.pollMs);
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
        if (!document.querySelector(".wzr-host .wzr-shell")) {
          const group = findGroup(WZR_CONFIG.groupName);
          if (!group) return;
          _host = ensureHost(group);
          refresh();
        }
      }, 700);
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();

