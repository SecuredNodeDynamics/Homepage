/* =====================================================
   MEALIE KITCHEN WIDGET
   Meal plan + recipes + shopping lists
   Group name: MEALIE-KITCHEN
===================================================== */
(function () {
  const MEALIE_CONFIG = {
    groupName: "MEALIE-KITCHEN",
    primaryBaseUrl: "http://YOUR_MEALIE_IP:9000",
    fallbackBaseUrl: null,
    activeBaseUrl: null,
    apiToken: "YOUR_MEALIE_API_TOKEN",
    primaryHref: "http://YOUR_MEALIE_IP:9000",
    fallbackHref: null,
    pollMs: 5 * 60 * 1000,
    debug: false
  };

  let _host = null;
  let _rendering = false;
  let _lastUpdated = null;
  let _recipes = [];
  let _mealPlans = [];
  let _shoppingLists = [];
  let _about = {};
  let _recipeTotal = 0;

  function log(...a) { if (MEALIE_CONFIG.debug) console.log("[MealieWidget]", ...a); }
  function esc(s = "") {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function normText(v) { return (v || "").replace(/\s+/g, " ").trim(); }
  function num(v) {
    const n = Number(v || 0);
    return Number.isFinite(n) ? n : 0;
  }
  function fmtInt(v) { return num(v).toLocaleString(); }

  function isoDate(offsetDays = 0) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  }

  function shortDate(value) {
    if (!value) return "";
    const d = new Date(`${String(value).slice(0, 10)}T12:00:00`);
    if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }

  function getTargets() {
    const targets = [];
    if (MEALIE_CONFIG.activeBaseUrl) targets.push(MEALIE_CONFIG.activeBaseUrl);
    if (MEALIE_CONFIG.primaryBaseUrl && MEALIE_CONFIG.primaryBaseUrl !== MEALIE_CONFIG.activeBaseUrl) targets.push(MEALIE_CONFIG.primaryBaseUrl);
    if (MEALIE_CONFIG.fallbackBaseUrl && MEALIE_CONFIG.fallbackBaseUrl !== MEALIE_CONFIG.activeBaseUrl) targets.push(MEALIE_CONFIG.fallbackBaseUrl);
    return targets;
  }

  function getHref() {
    if (MEALIE_CONFIG.activeBaseUrl === MEALIE_CONFIG.fallbackBaseUrl && MEALIE_CONFIG.fallbackHref) return MEALIE_CONFIG.fallbackHref;
    return MEALIE_CONFIG.primaryHref || MEALIE_CONFIG.fallbackHref || "#";
  }

  function apiPath(path) {
    return path.startsWith("/api/") ? path : `/api${path.startsWith("/") ? "" : "/"}${path}`;
  }

  async function mlFetch(path, options = {}, timeout = 12_000) {
    const targets = getTargets();
    let lastErr = null;
    for (const baseUrl of targets) {
      try {
        const res = await fetch(`${baseUrl.replace(/\/$/, "")}${apiPath(path)}`, {
          ...options,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${MEALIE_CONFIG.apiToken}`,
            ...(options.headers || {})
          },
          signal: AbortSignal.timeout(timeout)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        MEALIE_CONFIG.activeBaseUrl = baseUrl;
        return await res.json();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error(`Mealie request failed for ${path}`);
  }

  async function mlFetchOptional(paths, fallback) {
    for (const path of paths) {
      try {
        return await mlFetch(path);
      } catch (err) {
        log("optional endpoint failed", path, err);
      }
    }
    return fallback;
  }

  function findGroupContainer() {
    const hd = Array.from(document.querySelectorAll("h2,h3,.group-title,.service-group-name"))
      .find(el => normText(el.textContent) === MEALIE_CONFIG.groupName);
    if (!hd) return null;
    return hd.closest("section") || hd.closest("div[class*='group']") ||
      hd.parentElement?.parentElement || hd.parentElement;
  }

  function ensureHost(group) {
    let row = group.querySelector(".hp-widget-row, .ml-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "hp-widget-row ml-flex-row";
      group.appendChild(row);
    } else {
      row.classList.add("hp-widget-row", "ml-flex-row");
    }

    let host = row.querySelector(".ml-kitchen-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "ml-kitchen-host";
    row.appendChild(host);
    return host;
  }

  function normalizeList(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.items)) return payload.items;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.results)) return payload.results;
    return [];
  }

  function recipeName(row) {
    return row.name || row.recipe?.name || row.recipeName || row.recipe_name || row.title || "Recipe";
  }

  function mealTitle(row) {
    return row.recipe?.name || row.recipeName || row.recipe_name || row.title || row.note || "Planned meal";
  }

  function mealType(row) {
    return row.entryType || row.entry_type || row.mealType || row.meal_type || row.type || "Meal";
  }

  function recipeKey(row) {
    const recipe = row.recipe || row;
    return recipe.id || recipe.recipeId || recipe.recipe_id || recipe.slug || row.recipeId || row.recipe_id || row.slug || row.id || "";
  }

  function imageCandidates(row) {
    const recipe = row.recipe || row;
    const base = (MEALIE_CONFIG.activeBaseUrl || MEALIE_CONFIG.primaryBaseUrl || "").replace(/\/$/, "");
    const key = recipeKey(row);
    const urls = [];
    if (key) {
      urls.push(`${base}/api/media/recipes/${encodeURIComponent(key)}/images/min-original.webp`);
      urls.push(`${base}/api/media/recipes/${encodeURIComponent(key)}/images/original.webp`);
    }
    const img = recipe.image || recipe.imagePath || recipe.image_path || recipe.assetUrl || recipe.asset_url;
    if (img) urls.push(/^https?:\/\//i.test(img) ? img : `${base}${img.startsWith("/") ? "" : "/"}${img}`);
    return [...new Set(urls.filter(Boolean))];
  }

  function imageUrl(row) {
    return imageCandidates(row)[0] || "";
  }

  function fallbackAttrs(row) {
    const rest = imageCandidates(row).slice(1);
    if (!rest.length) return "";
    return ` data-fallbacks="${esc(JSON.stringify(rest))}" onerror="this.onerror=null;const f=JSON.parse(this.dataset.fallbacks||'[]');const n=f.shift();if(n){this.dataset.fallbacks=JSON.stringify(f);this.src=n;}else{this.style.display='none';}"`;
  }

  async function fetchAll() {
    const start = isoDate(0);
    const end = isoDate(7);

    const [about, recipes, mealPlans, shoppingLists] = await Promise.all([
      mlFetchOptional(["/app/about"], {}),
      mlFetchOptional([
        "/recipes?orderBy=created_at&orderDirection=desc&page=1&perPage=6",
        "/recipes?orderBy=createdAt&orderDirection=desc&page=1&perPage=6",
        "/recipes?page=1&perPage=6"
      ], {}),
      mlFetchOptional([
        `/households/mealplans?start_date=${start}&end_date=${end}`,
        `/households/mealplans?startDate=${start}&endDate=${end}`,
        `/meal-plans?start_date=${start}&end_date=${end}`
      ], []),
      mlFetchOptional([
        "/households/shopping/lists",
        "/shopping/lists",
        "/groups/shopping/lists"
      ], [])
    ]);

    _about = about || {};
    _recipes = normalizeList(recipes).slice(0, 6);
    _recipeTotal = recipes?.total || recipes?.total_pages || recipes?.count || _recipes.length;
    _mealPlans = normalizeList(mealPlans).slice(0, 8);
    _shoppingLists = normalizeList(shoppingLists).slice(0, 4);
    _lastUpdated = new Date();
  }

  function buildStats() {
    const today = isoDate(0);
    const todaysMeals = _mealPlans.filter(row => String(row.date || row.createdAt || "").slice(0, 10) === today).length;
    const listCount = _shoppingLists.length;
    return `
      <div class="ml-stats">
        <div class="ml-stat"><small>Recipes</small><span>${fmtInt(_recipeTotal)}</span></div>
        <div class="ml-stat"><small>Today</small><span>${fmtInt(todaysMeals)}</span></div>
        <div class="ml-stat"><small>Planned</small><span>${fmtInt(_mealPlans.length)}</span></div>
        <div class="ml-stat"><small>Lists</small><span>${fmtInt(listCount)}</span></div>
      </div>`;
  }

  function buildToday() {
    const today = isoDate(0);
    const meals = _mealPlans.filter(row => String(row.date || row.createdAt || "").slice(0, 10) === today).slice(0, 3);
    if (!meals.length) return `<div class="ml-empty">No meals planned today</div>`;
    return `
      <div class="ml-today-list">
        ${meals.map(row => `
          <div class="ml-today-card">
            ${imageUrl(row) ? `<img class="ml-meal-image" src="${esc(imageUrl(row))}" alt=""${fallbackAttrs(row)}>` : `<div class="ml-meal-icon">🍽</div>`}
            <div class="ml-today-main">
              <div class="ml-meal-name">${esc(mealTitle(row))}</div>
              <div class="ml-meal-meta">${esc(mealType(row))}</div>
            </div>
          </div>`).join("")}
      </div>`;
  }

  function buildUpcoming() {
    if (!_mealPlans.length) return `<div class="ml-empty">No upcoming meal plan entries</div>`;
    return `
      <div class="ml-upcoming">
        ${_mealPlans.slice(0, 6).map(row => `
          <div class="ml-upcoming-row">
            <div>
              <div class="ml-row-title">${esc(mealTitle(row))}</div>
              <div class="ml-row-sub">${esc([shortDate(row.date || row.createdAt), mealType(row)].filter(Boolean).join(" · "))}</div>
            </div>
          </div>`).join("")}
      </div>`;
  }

  function buildRecipes() {
    if (!_recipes.length) return `<div class="ml-empty">No recipe data</div>`;
    return `
      <div class="ml-recipes">
        ${_recipes.map(row => `
          <a class="ml-recipe" href="${esc(getHref())}/g/home/r/${esc(row.slug || row.id || "")}" target="_blank" rel="noopener noreferrer">
            ${imageUrl(row) ? `<img class="ml-recipe-image" src="${esc(imageUrl(row))}" alt=""${fallbackAttrs(row)}>` : `<div class="ml-recipe-fallback">🍲</div>`}
            <span>${esc(recipeName(row))}</span>
            <small>Open recipe</small>
          </a>`).join("")}
      </div>`;
  }

  function buildShopping() {
    if (!_shoppingLists.length) return `<div class="ml-empty">No shopping lists</div>`;
    return `
      <div class="ml-shopping">
        ${_shoppingLists.map(row => `
          <div class="ml-shopping-row">
            <span>🛒</span>
            <div>
              <div class="ml-row-title">${esc(row.name || row.title || "Shopping List")}</div>
              <div class="ml-row-sub">${fmtInt(row.listItems?.length || row.items?.length || row.itemCount || row.item_count || 0)} items</div>
            </div>
          </div>`).join("")}
      </div>`;
  }

  function buildShell() {
    const ts = _lastUpdated
      ? _lastUpdated.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })
      : "Loading";
    const version = _about.version || _about.versionLatest || "";
    return `
      <div class="ml-shell">
        <div class="ml-header">
          <div class="ml-header-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/mealie.webp" alt="Mealie" class="ml-icon">
            <div>
              <div class="ml-title">Mealie</div>
              <div class="ml-subtitle">${version ? `Kitchen planner · ${esc(version)}` : "Kitchen planner"}</div>
            </div>
          </div>
          <a class="ml-open-link" href="${esc(getHref())}" target="_blank" rel="noopener noreferrer">Open</a>
        </div>

        ${buildStats()}

        <div class="ml-book">
          <section class="ml-page ml-recipes-section">
            <div class="ml-section-title">Recipe Book</div>
            ${buildRecipes()}
          </section>
          <section class="ml-page ml-today-section">
            <div class="ml-section-title">Today</div>
            ${buildToday()}
          </section>
          <section class="ml-page ml-upcoming-section">
            <div class="ml-section-title">Upcoming</div>
            ${buildUpcoming()}
          </section>
          <section class="ml-page ml-shopping-section">
            <div class="ml-section-title">Shopping</div>
            ${buildShopping()}
          </section>
        </div>

        <div class="ml-footer">Updated ${esc(ts)}</div>
      </div>`;
  }

  function buildError(message) {
    return `
      <div class="ml-shell">
        <div class="ml-header">
          <div class="ml-header-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/mealie.webp" alt="Mealie" class="ml-icon">
            <div>
              <div class="ml-title">Mealie</div>
              <div class="ml-subtitle">Connection failed</div>
            </div>
          </div>
          <a class="ml-open-link" href="${esc(getHref())}" target="_blank" rel="noopener noreferrer">Open</a>
        </div>
        <div class="ml-empty ml-empty--error">${esc(message)}</div>
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
      if (!MEALIE_CONFIG.apiToken || MEALIE_CONFIG.apiToken === "YOUR_MEALIE_API_TOKEN") {
        _host.innerHTML = buildError("Set your Mealie API token in MEALIE_CONFIG.apiToken");
        return;
      }
      if (!_host.querySelector(".ml-shell")) {
        _host.innerHTML = `<div class="ml-shell"><div class="ml-empty">Loading Mealie</div></div>`;
      }
      await fetchAll();
      updateHost();
    } catch (err) {
      console.error("[MealieWidget]", err);
      if (_host) _host.innerHTML = buildError(err.message || "Failed to load Mealie");
    } finally {
      _rendering = false;
    }
  }

  function init() {
    const start = () => {
      setTimeout(refresh, 1600);
      setInterval(() => { if (!document.hidden) refresh(); }, MEALIE_CONFIG.pollMs);
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
    new MutationObserver(() => {
      if (!document.querySelector(".ml-kitchen-host .ml-shell")) {
        setTimeout(refresh, 500);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
