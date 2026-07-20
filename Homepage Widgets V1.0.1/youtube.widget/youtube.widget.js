/* =====================================================
   YOUTUBE FEED WIDGET
   Latest videos from configured channels
   Group name: YOUTUBE-WIDGET
===================================================== */
(function () {
  const YT_CONFIG = {
    groupName: "YOUTUBE-WIDGET",
    youtubeHref: "https://www.youtube.com/",
    pollMs: 30 * 60 * 1000,
    maxPerChannel: 7,
    maxVideos: 12,
    sideVideos: 6,
    rssProxyUrl: null, // e.g. "https://youtube-rss.yourdomain.workers.dev"
    debug: false,
    storageKey: "homepage.youtube.channels.v1",
    initialChannels: [
      { label: "Sax Piano Chill", id: "UCAuKGTrlew8mwuaze6HI-Kg" },
      {
        label: "Zhang Manhwa",
        id: "UCaICGDabRMrPLmXnyIfH29w",
        preferFallback: true,
        fallbackVideos: [
          { id: "i0XOnhYQhP8", title: "Everyone thought he is an E-Rank, But Every Villager He Summons Becomes SSS-Rank!", published: "2026-05-27T14:56:18+00:00" },
          { id: "jgQ3sVggwfY", title: "Everyone laughed at his Slime, But the Slime Is SSS-Rank and Can Transform Into Any Beast!", published: "2026-05-26T14:54:25+00:00" },
          { id: "htd3HQU6dsg", title: "He awakened a Simp System, But He Spent EVERYTHING on Himself Instead!", published: "2026-05-25T12:55:54+00:00" },
          { id: "z3hwCX4xv9c", title: "He Beat His Wife Every Night - Until He Woke Up One Day and Cooked Her Daughter Breakfast!", published: "2026-05-23T06:16:27+00:00" },
          { id: "HydaeB5Fcig", title: "She Was Called CRAZY for Letting a Medieval Knight Into Her Store, Until He Bought Everything!", published: "2026-05-22T01:00:17+00:00" },
          { id: "eMBib8cOy2Q", title: "They Took Away His Entire Bonus for Being 2 Minutes Late, So He Quit and the Factory Lost Millions!", published: "2026-05-21T01:59:59+00:00" }
        ]
      }
    ]
  };

  let _host = null;
  let _rendering = false;
  let _lastUpdated = null;
  let _videos = [];
  let _activeChannel = "all";

  const YT_KNOWN_CHANNELS = {
    UCaICGDabRMrPLmXnyIfH29w: {
      label: "Zhang Manhwa",
      preferFallback: true,
      fallbackVideos: [
        { id: "i0XOnhYQhP8", title: "Everyone thought he is an E-Rank, But Every Villager He Summons Becomes SSS-Rank!", published: "2026-05-27T14:56:18+00:00" },
        { id: "jgQ3sVggwfY", title: "Everyone laughed at his Slime, But the Slime Is SSS-Rank and Can Transform Into Any Beast!", published: "2026-05-26T14:54:25+00:00" },
        { id: "htd3HQU6dsg", title: "He awakened a Simp System, But He Spent EVERYTHING on Himself Instead!", published: "2026-05-25T12:55:54+00:00" },
        { id: "z3hwCX4xv9c", title: "He Beat His Wife Every Night - Until He Woke Up One Day and Cooked Her Daughter Breakfast!", published: "2026-05-23T06:16:27+00:00" },
        { id: "HydaeB5Fcig", title: "She Was Called CRAZY for Letting a Medieval Knight Into Her Store, Until He Bought Everything!", published: "2026-05-22T01:00:17+00:00" },
        { id: "eMBib8cOy2Q", title: "They Took Away His Entire Bonus for Being 2 Minutes Late, So He Quit and the Factory Lost Millions!", published: "2026-05-21T01:59:59+00:00" }
      ]
    },
    UCXHS4zp25ITnryx8Q9a1_1w: {
      label: "Blaze Core Anime",
      preferFallback: true,
      fallbackVideos: [
        { id: "9Cbc7keuEVo", title: "ENG DUB I Can Combine Anything in the Apocalypse-And It Made Me Unstoppable | Full Anime", published: "2026-06-25T12:00:17+00:00" },
        { id: "EdgwEyocvCk", title: "ENG DUB | The Entire World Hunted Me for Being a Negative S-Rank-So I Exposed the Truth", published: "2026-06-10T12:00:37+00:00" },
        { id: "bewgc6iofzE", title: "I Returned with the Wolf Lord's Child-On the Day He Married Another Woman | Full Story", published: "2026-06-06T12:00:19+00:00" },
        { id: "K58lXV0OCHA", title: "ENG DUB | I Became a Powerful Heir's Pawn... But He Was the One Who Fell First | Full Anime", published: "2026-06-01T12:49:54+00:00" },
        { id: "rBKiVBfYwgI", title: "ENG DUB | Everyone Mocked My Hidden Class... Until I Soloed Every Dungeon | Full Anime", published: "2026-05-29T12:45:14+00:00" },
        { id: "ZYLxNQx6XMs", title: "ENG DUB | My Teammates Betrayed Me-So I Dominated the World Arena with Slimes | Full Anime", published: "2026-05-27T12:00:22+00:00" }
      ]
    }
  };

  function log(...a) { if (YT_CONFIG.debug) console.log("[YouTubeWidget]", ...a); }
  function esc(s = "") {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function normText(v) { return (v || "").replace(/\s+/g, " ").trim(); }

  function findGroupContainer() {
    const hd = Array.from(document.querySelectorAll("h2,h3,.group-title,.service-group-name"))
      .find(el => normText(el.textContent) === YT_CONFIG.groupName);
    if (!hd) return null;
    return hd.closest("section") || hd.closest("div[class*='group']") ||
      hd.parentElement?.parentElement || hd.parentElement;
  }

  function ensureHost(group) {
    let row = group.querySelector(".hp-widget-row, .yt-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "hp-widget-row yt-flex-row";
      group.appendChild(row);
    } else {
      row.classList.add("hp-widget-row", "yt-flex-row");
    }

    let host = row.querySelector(".yt-feed-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "yt-feed-host";
    row.appendChild(host);
    return host;
  }

  function rssUrl(channelId) {
    return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  }

  function videoIdFromUrl(url = "") {
    try {
      const parsed = new URL(url);
      if (parsed.searchParams.get("v")) return parsed.searchParams.get("v");
      const parts = parsed.pathname.split("/").filter(Boolean);
      return parts.pop() || "";
    } catch {
      const match = String(url).match(/[?&]v=([^&]+)/);
      return match ? match[1] : "";
    }
  }

  function thumbUrl(videoId) {
    return videoId ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg` : "";
  }

  function extractChannelId(value = "") {
    const text = String(value).trim();
    if (/^UC[A-Za-z0-9_-]{20,}$/.test(text)) return text;
    const channelMatch = text.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]+)/i);
    if (channelMatch) return channelMatch[1];
    if (/@BlazeCoreAnime/i.test(text)) return "UCXHS4zp25ITnryx8Q9a1_1w";
    if (/@ZhangManhwaa/i.test(text)) return "UCaICGDabRMrPLmXnyIfH29w";
    if (/@SaxPianoChill999/i.test(text)) return "UCAuKGTrlew8mwuaze6HI-Kg";
    return "";
  }

  function enrichChannel(channel) {
    const id = extractChannelId(channel.id) || extractChannelId(channel.url) || channel.id;
    const known = YT_KNOWN_CHANNELS[id] || {};
    return {
      ...known,
      ...channel,
      id,
      label: channel.label || known.label || id
    };
  }

  function getChannels() {
    try {
      const saved = JSON.parse(localStorage.getItem(YT_CONFIG.storageKey) || "null");
      if (Array.isArray(saved)) return saved.map(enrichChannel);
    } catch (err) {
      log("channel storage read failed", err);
    }
    return (YT_CONFIG.initialChannels || []).map(enrichChannel);
  }

  function saveChannels(channels) {
    localStorage.setItem(YT_CONFIG.storageKey, JSON.stringify(channels));
  }

  function persistChannelVideos(channelId, videos) {
    if (!videos?.length) return;
    const channels = getChannels();
    const next = channels.map(channel => {
      if (channel.id !== channelId) return channel;
      return {
        ...channel,
        preferFallback: channel.preferFallback ?? true,
        fallbackVideos: videos.slice(0, YT_CONFIG.maxPerChannel).map(video => ({
          id: video.id,
          title: video.title,
          published: video.published || ""
        }))
      };
    });
    saveChannels(next);
  }

  function validChannels() {
    return getChannels().filter(c => c.id && !String(c.id).includes("YOUR_"));
  }

  function resetVideosForRemovedChannels() {
    const ids = new Set(validChannels().map(channel => channel.id));
    if (_activeChannel !== "all" && !ids.has(_activeChannel)) _activeChannel = "all";
    _videos = _videos.filter(video => ids.has(video.channelId));
  }

  function fallbackVideos(channel) {
    return (channel.fallbackVideos || []).slice(0, YT_CONFIG.maxPerChannel).map(video => ({
      id: video.id,
      title: video.title || `Latest video from ${channel.label}`,
      channel: channel.label,
      channelId: channel.id,
      published: video.published || "",
      url: video.url || `https://www.youtube.com/watch?v=${video.id}`,
      thumb: video.thumb || thumbUrl(video.id)
    })).filter(video => video.id);
  }

  function timeAgo(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    const diff = Date.now() - d.getTime();
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);
    if (days > 30) return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    if (days) return `${days}d ago`;
    if (hours) return `${hours}h ago`;
    if (mins) return `${mins}m ago`;
    return "Just now";
  }

  async function fetchJsonFeed(channel) {
    const url = rssUrl(channel.id);
    const api = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}`;
    const res = await fetch(api, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12_000)
    });
    if (!res.ok) throw new Error(`rss2json HTTP ${res.status}`);
    const json = await res.json();
    if (json.status && json.status !== "ok") throw new Error(json.message || "rss2json failed");
    return (json.items || []).slice(0, YT_CONFIG.maxPerChannel).map(item => {
      const videoId = videoIdFromUrl(item.link || item.guid || "");
      return {
        id: videoId,
        title: item.title || "Untitled video",
        channel: channel.label,
        channelId: channel.id,
        published: item.pubDate || item.published || "",
        url: item.link || `https://www.youtube.com/watch?v=${videoId}`,
        thumb: item.thumbnail || thumbUrl(videoId)
      };
    });
  }

  function parseXmlFeed(xmlText, channel) {
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    if (doc.querySelector("parsererror")) throw new Error("Invalid YouTube RSS XML");
    const textByName = (node, name) => Array.from(node.children).find(child => child.localName === name)?.textContent || "";
    const linkHref = node => Array.from(node.children).find(child => child.localName === "link")?.getAttribute("href") || "";
    return Array.from(doc.querySelectorAll("entry")).slice(0, YT_CONFIG.maxPerChannel).map(entry => {
      const videoId = textByName(entry, "videoId");
      return {
        id: videoId,
        title: textByName(entry, "title") || "Untitled video",
        channel: channel.label,
        channelId: channel.id,
        published: textByName(entry, "published") || "",
        url: linkHref(entry) || `https://www.youtube.com/watch?v=${videoId}`,
        thumb: thumbUrl(videoId)
      };
    });
  }

  async function fetchXmlFeed(channel) {
    const feed = rssUrl(channel.id);
    const proxies = [
      ...(YT_CONFIG.rssProxyUrl ? [`${YT_CONFIG.rssProxyUrl.replace(/\/$/, "")}?channel_id=${encodeURIComponent(channel.id)}`] : []),
      `https://api.allorigins.win/raw?url=${encodeURIComponent(feed)}`,
      `https://api.codetabs.com/v1/proxy?quest=${feed}`
    ];
    let lastErr = null;
    for (const url of proxies) {
      try {
        const res = await fetch(url, {
          headers: { Accept: "application/xml,text/xml,*/*" },
          signal: AbortSignal.timeout(25_000)
        });
        if (!res.ok) throw new Error(`proxy HTTP ${res.status}`);
        const videos = parseXmlFeed(await res.text(), channel);
        if (videos.length) return videos;
      } catch (err) {
        lastErr = err;
        log("xml proxy failed", url, err);
      }
    }
    throw lastErr || new Error("YouTube XML feed failed");
  }

  async function resolveHandle(value = "") {
    const text = String(value).trim();
    const handleMatch = text.match(/(?:youtube\.com\/)?@([A-Za-z0-9._-]+)/i);
    if (!handleMatch) return "";
    if (YT_CONFIG.rssProxyUrl) {
      const res = await fetch(`${YT_CONFIG.rssProxyUrl.replace(/\/$/, "")}?handle=${encodeURIComponent(handleMatch[1])}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000)
      });
      if (!res.ok) throw new Error(`handle proxy HTTP ${res.status}`);
      const json = await res.json();
      if (json.id) return json.id;
    }
    const page = `https://www.youtube.com/@${handleMatch[1]}`;
    const urls = [
      `https://api.allorigins.win/raw?url=${encodeURIComponent(page)}`,
      `https://api.codetabs.com/v1/proxy?quest=${page}`
    ];
    let lastErr = null;
    for (const url of urls) {
      try {
        const res = await fetch(url, { headers: { Accept: "text/html,*/*" }, signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`handle proxy HTTP ${res.status}`);
        const html = await res.text();
        const id = html.match(/https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]+)/)?.[1] ||
          html.match(/"channelId":"(UC[A-Za-z0-9_-]+)"/)?.[1];
        if (id) return id;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("Could not resolve YouTube handle");
  }

  function channelHelpMessage(value = "") {
    if (/@[A-Za-z0-9._-]+/.test(String(value))) {
      return "Could not resolve that @handle from the browser. Set rssProxyUrl to the YouTube worker for automatic handle lookup, or paste a UC... channel ID.";
    }
    return "Could not add channel. Paste a YouTube channel ID beginning with UC, or a /channel/UC... URL.";
  }

  async function fetchPageFeed(channel) {
    const page = `https://www.youtube.com/channel/${encodeURIComponent(channel.id)}/videos`;
    const proxies = [
      `https://api.allorigins.win/raw?url=${encodeURIComponent(page)}`,
      `https://api.codetabs.com/v1/proxy?quest=${page}`
    ];
    let lastErr = null;
    for (const url of proxies) {
      try {
        const res = await fetch(url, {
          headers: { Accept: "text/html,*/*" },
          signal: AbortSignal.timeout(25_000)
        });
        if (!res.ok) throw new Error(`page proxy HTTP ${res.status}`);
        const html = await res.text();
        const ids = [...new Set(Array.from(html.matchAll(/"videoId":"([A-Za-z0-9_-]{8,})"/g)).map(match => match[1]))]
          .slice(0, YT_CONFIG.maxPerChannel);
        if (!ids.length) throw new Error("No video IDs on channel page");
        return ids.map(videoId => ({
          id: videoId,
          title: `Latest video from ${channel.label}`,
          channel: channel.label,
          channelId: channel.id,
          published: "",
          url: `https://www.youtube.com/watch?v=${videoId}`,
          thumb: thumbUrl(videoId)
        }));
      } catch (err) {
        lastErr = err;
        log("page proxy failed", url, err);
      }
    }
    throw lastErr || new Error("YouTube page fallback failed");
  }

  async function hydrateChannel(candidate) {
    const channel = enrichChannel(candidate);
    let videos = fallbackVideos(channel);
    if (!videos.length || channel.preferFallback === false) {
      try {
        videos = await fetchJsonFeed({ ...channel, preferFallback: false });
      } catch (err) {
        log("hydrate JSON failed", channel.label, err);
      }
    }
    if (!videos.length || channel.preferFallback === false) {
      try {
        videos = await fetchXmlFeed({ ...channel, preferFallback: false });
      } catch (err) {
        log("hydrate XML failed", channel.label, err);
      }
    }
    if (!videos.length) {
      try {
        videos = await fetchPageFeed(channel);
      } catch (err) {
        log("hydrate page failed", channel.label, err);
      }
    }
    if (!videos.length) throw new Error("Could not find videos for that channel");
    return {
      ...channel,
      preferFallback: true,
      fallbackVideos: videos.slice(0, YT_CONFIG.maxPerChannel).map(video => ({
        id: video.id,
        title: video.title,
        published: video.published || ""
      }))
    };
  }

  async function fetchChannel(channel) {
    const fallback = fallbackVideos(channel);
    if (fallback.length && channel.preferFallback !== false) return fallback;

    try {
      const videos = await fetchJsonFeed(channel);
      if (videos.length) return videos;
      throw new Error("rss2json returned no videos");
    } catch (err) {
      log("rss2json failed", channel.label, err);
      try {
        const videos = await fetchXmlFeed(channel);
        if (videos.length) return videos;
        throw new Error("XML feed returned no videos");
      } catch (xmlErr) {
        log("xml feed failed", channel.label, xmlErr);
        try {
          const videos = await fetchPageFeed(channel);
          if (videos.length) return videos;
          throw new Error("Page fallback returned no videos");
        } catch (pageErr) {
          if (fallback.length) return fallback;
          throw pageErr;
        }
      }
    }
  }

  async function fetchAll() {
    const channels = validChannels();
    if (!channels.length) {
      _videos = [];
      _lastUpdated = new Date();
      return;
    }

    const settled = await Promise.allSettled(channels.map(fetchChannel));
    const loaded = settled.flatMap((result, index) => {
      if (result.status !== "fulfilled") return [];
      persistChannelVideos(channels[index].id, result.value);
      return result.value;
    });
    _videos = loaded
      .filter(v => v.id || v.url)
      .sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime())
      .slice(0, Math.max(YT_CONFIG.maxVideos, channels.length * YT_CONFIG.maxPerChannel));
    _lastUpdated = new Date();
  }

  function seedFallbackVideos() {
    const channels = validChannels();
    _videos = channels
      .flatMap(channel => fallbackVideos(channel))
      .sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime())
      .slice(0, Math.max(YT_CONFIG.maxVideos, channels.length * YT_CONFIG.maxPerChannel));
    _lastUpdated = new Date();
  }

  function getFilteredVideos() {
    if (_activeChannel === "all") return _videos;
    return _videos.filter(v => v.channelId === _activeChannel);
  }

  function buildTabs() {
    const channels = validChannels();
    return `
      <div class="yt-toolbar">
        <div class="yt-tabs">
          <button class="yt-tab ${_activeChannel === "all" ? "is-active" : ""}" data-channel="all">All</button>
          ${channels.map(channel => `
            <button class="yt-tab ${_activeChannel === channel.id ? "is-active" : ""}" data-channel="${esc(channel.id)}">${esc(channel.label)}</button>
          `).join("")}
        </div>
        <div class="yt-toolbar-actions">
          <button class="yt-preview-btn" type="button">Preview</button>
          <button class="yt-manage-btn" type="button">Channels</button>
        </div>
      </div>`;
  }

  function buildFeatured(video) {
    const hasChannels = validChannels().length > 0;
    if (!video) return `<div class="yt-empty">${hasChannels ? "No videos loaded yet. Refresh again in a moment." : "Add YouTube channels from the Channels button"}</div>`;
    return `
      <a class="yt-featured" href="${esc(video.url)}" target="_blank" rel="noopener noreferrer">
        <img class="yt-featured-thumb" src="${esc(video.thumb)}" alt="">
        <div class="yt-featured-main">
          <div class="yt-kicker">Latest Upload</div>
          <div class="yt-featured-title">${esc(video.title)}</div>
          <div class="yt-featured-meta">${esc(video.channel)} · ${esc(timeAgo(video.published))}</div>
        </div>
      </a>`;
  }

  function buildVideos(videos) {
    if (!videos.length) return `<div class="yt-empty">No recent videos found</div>`;
    return `
      <div class="yt-videos">
        ${videos.slice(1, 1 + YT_CONFIG.sideVideos).map(video => `
          <a class="yt-video" href="${esc(video.url)}" target="_blank" rel="noopener noreferrer">
            <img class="yt-thumb" src="${esc(video.thumb)}" alt="">
            <div class="yt-video-body">
              <div class="yt-video-title">${esc(video.title)}</div>
              <div class="yt-video-meta">${esc(video.channel)} · ${esc(timeAgo(video.published))}</div>
            </div>
          </a>
        `).join("")}
      </div>`;
  }

  function activeChannelLabel(videos) {
    if (_activeChannel === "all") return "All Channels";
    return validChannels().find(channel => channel.id === _activeChannel)?.label || videos[0]?.channel || "Channel";
  }

  function buildPreviewModal(selectedId) {
    const videos = getFilteredVideos();
    const selected = videos.find(video => video.id === selectedId) || videos[0];
    if (!selected) return "";
    return `
      <div class="yt-modal-backdrop" role="dialog" aria-modal="true" aria-label="YouTube channel preview">
        <div class="yt-modal">
          <div class="yt-modal-header">
            <div>
              <div class="yt-modal-kicker">Channel Preview</div>
              <div class="yt-modal-title">${esc(activeChannelLabel(videos))}</div>
            </div>
            <button class="yt-modal-close" type="button" aria-label="Close preview">×</button>
          </div>
          <div class="yt-modal-body">
            <div class="yt-player-wrap">
              <iframe
                class="yt-player"
                src="https://www.youtube.com/embed/${esc(selected.id)}"
                title="${esc(selected.title)}"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowfullscreen></iframe>
              <div class="yt-player-title">${esc(selected.title)}</div>
              <div class="yt-player-meta">${esc(selected.channel)} · ${esc(timeAgo(selected.published))}</div>
            </div>
            <div class="yt-preview-list">
              ${videos.slice(0, YT_CONFIG.maxVideos).map(video => `
                <button class="yt-preview-item ${video.id === selected.id ? "is-active" : ""}" type="button" data-video="${esc(video.id)}">
                  <img src="${esc(video.thumb)}" alt="">
                  <span>
                    <strong>${esc(video.title)}</strong>
                    <small>${esc(timeAgo(video.published))}</small>
                  </span>
                </button>
              `).join("")}
            </div>
          </div>
          <div class="yt-modal-actions">
            <a class="yt-watch-link" href="${esc(selected.url)}" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          </div>
        </div>
      </div>`;
  }

  function buildShell() {
    const videos = getFilteredVideos();
    const ts = _lastUpdated
      ? _lastUpdated.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })
      : "Loading";
    return `
      <div class="yt-shell">
        <div class="yt-header">
          <div class="yt-header-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/youtube.webp" alt="YouTube" class="yt-icon">
            <div>
              <div class="yt-title">YouTube</div>
              <div class="yt-subtitle">${validChannels().length || 0} channels · latest uploads</div>
            </div>
          </div>
          <a class="yt-open-link" href="${esc(YT_CONFIG.youtubeHref)}" target="_blank" rel="noopener noreferrer">Open</a>
        </div>

        ${buildTabs()}

        <div class="yt-grid">
          ${buildFeatured(videos[0])}
          ${buildVideos(videos)}
        </div>

        <div class="yt-footer">Updated ${esc(ts)}</div>
      </div>`;
  }

  function buildError(message) {
    return `
      <div class="yt-shell">
        <div class="yt-header">
          <div class="yt-header-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/youtube.webp" alt="YouTube" class="yt-icon">
            <div>
              <div class="yt-title">YouTube</div>
              <div class="yt-subtitle">Feed failed</div>
            </div>
          </div>
          <a class="yt-open-link" href="${esc(YT_CONFIG.youtubeHref)}" target="_blank" rel="noopener noreferrer">Open</a>
        </div>
        <div class="yt-empty yt-empty--error">${esc(message)}</div>
      </div>`;
  }

  function buildManageModal(message = "") {
    const channels = validChannels();
    return `
      <div class="yt-modal-backdrop yt-channel-modal-backdrop" role="dialog" aria-modal="true" aria-label="Manage YouTube channels">
        <div class="yt-channel-modal">
          <div class="yt-modal-header">
            <div>
              <div class="yt-modal-kicker">YouTube</div>
              <div class="yt-modal-title">Manage Channels</div>
            </div>
            <button class="yt-modal-close" type="button" aria-label="Close channel manager">×</button>
          </div>
          <form class="yt-channel-form">
            <label>
              <span>Label</span>
              <input name="label" type="text" placeholder="Sax Piano Chill" autocomplete="off">
            </label>
            <label>
              <span>Channel ID or URL</span>
              <input name="channel" type="text" placeholder="UC... or https://www.youtube.com/channel/UC..." autocomplete="off" required>
            </label>
            <button type="submit">Add</button>
          </form>
          <div class="yt-channel-hint">
            Before saving, the widget checks the channel ID, fetches recent videos, and stores the latest uploads for fast loading.
            ${YT_CONFIG.rssProxyUrl ? "Handle URLs are resolved through your RSS proxy." : "Paste UC... IDs for reliable adds; @handle auto-lookup needs rssProxyUrl."}
          </div>
          ${message ? `<div class="yt-channel-message">${esc(message)}</div>` : ""}
          <div class="yt-channel-list">
            ${channels.length ? channels.map(channel => `
              <div class="yt-channel-row">
                <div>
                  <strong>${esc(channel.label)}</strong>
                  <small>${esc(channel.id)}</small>
                </div>
                <button type="button" data-remove-channel="${esc(channel.id)}">Remove</button>
              </div>
            `).join("") : `<div class="yt-empty">No channels added yet</div>`}
          </div>
        </div>
      </div>`;
  }

  function bindTabs() {
    if (!_host) return;
    _host.querySelectorAll(".yt-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        _activeChannel = btn.dataset.channel || "all";
        updateHost();
      });
    });
    _host.querySelector(".yt-preview-btn")?.addEventListener("click", () => openPreview());
    _host.querySelector(".yt-manage-btn")?.addEventListener("click", () => openManager());
  }

  function openPreview(videoId) {
    if (!_host) return;
    closePreview();
    _host.insertAdjacentHTML("beforeend", buildPreviewModal(videoId));
    bindPreview();
  }

  function closePreview() {
    _host?.querySelector(".yt-modal-backdrop")?.remove();
  }

  function bindPreview() {
    if (!_host) return;
    const modal = _host.querySelector(".yt-modal-backdrop");
    if (!modal) return;
    modal.querySelector(".yt-modal-close")?.addEventListener("click", closePreview);
    modal.addEventListener("click", event => {
      if (event.target === modal) closePreview();
    });
    modal.querySelectorAll(".yt-preview-item").forEach(btn => {
      btn.addEventListener("click", () => openPreview(btn.dataset.video));
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") closePreview();
    }, { once: true });
  }

  function openManager(message = "") {
    if (!_host) return;
    closePreview();
    _host.insertAdjacentHTML("beforeend", buildManageModal(message));
    bindManager();
  }

  function closeManager() {
    _host?.querySelector(".yt-channel-modal-backdrop")?.remove();
  }

  function bindManager() {
    if (!_host) return;
    const modal = _host.querySelector(".yt-channel-modal-backdrop");
    if (!modal) return;
    modal.querySelector(".yt-modal-close")?.addEventListener("click", closeManager);
    modal.addEventListener("click", event => {
      if (event.target === modal) closeManager();
    });
    modal.querySelectorAll("[data-remove-channel]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.removeChannel;
        saveChannels(getChannels().filter(channel => channel.id !== id));
        resetVideosForRemovedChannels();
        closeManager();
        updateHost();
        openManager("Channel removed");
        refresh();
      });
    });
    modal.querySelector(".yt-channel-form")?.addEventListener("submit", async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const labelInput = form.elements.label;
      const channelInput = form.elements.channel;
      const raw = channelInput.value.trim();
      const label = labelInput.value.trim() || raw.replace(/^https?:\/\/(www\.)?youtube\.com\//, "").replace(/^@/, "") || "YouTube";
      try {
        const submit = form.querySelector("button[type='submit']");
        submit.disabled = true;
        submit.textContent = "Checking";
        const id = extractChannelId(raw) || await resolveHandle(raw);
        const channels = getChannels();
        if (channels.some(channel => channel.id === id)) throw new Error("That channel is already added");
        const hydrated = await hydrateChannel({ label, id });
        saveChannels([...channels, hydrated]);
        closeManager();
        seedFallbackVideos();
        updateHost();
        openManager("Channel added");
        refresh();
      } catch (err) {
        closeManager();
        openManager(channelHelpMessage(raw));
      }
    });
  }

  function updateHost() {
    if (!_host) return;
    _host.innerHTML = buildShell();
    bindTabs();
  }

  async function refresh() {
    if (_rendering) return;
    const group = findGroupContainer();
    if (!group) return;
    _host = ensureHost(group);
    _rendering = true;

    if (!_host.querySelector(".yt-shell")) {
      seedFallbackVideos();
      updateHost();
    }

    fetchAll()
      .then(updateHost)
      .catch(err => {
        console.error("[YouTubeWidget]", err);
        if (!_videos.length && _host) _host.innerHTML = buildError(err.message || "Failed to load YouTube feeds");
      })
      .finally(() => {
        _rendering = false;
      });
  }

  function init() {
    const start = () => {
      setTimeout(refresh, 100);
      setInterval(() => { if (!document.hidden) refresh(); }, YT_CONFIG.pollMs);
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
    new MutationObserver(() => {
      if (!document.querySelector(".yt-feed-host .yt-shell")) {
        setTimeout(refresh, 500);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
