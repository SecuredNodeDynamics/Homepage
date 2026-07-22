# Widget Pack Setup Guide


*For support or questions about these widgets, contact me through my github or discord *

Github: https://github.com/SecuredNodeDynamics/Homepage

Discord: https://discord.gg/XCyu64Ee


This document covers everything you need to get your widgets up and running — API keys, credentials, Cloudflare tunnels, proxy workers, and CORS rules.

---

## 1. URLs — Primary and Fallback

Every widget has two URL fields:

```javascript
baseUrl: "http://YOUR_LOCAL_IP:PORT",
fallbackUrl: "https://YOUR_TUNNEL_URL", // or null if not using a tunnel
```

**`baseUrl`** is the primary address the widget tries first. This should be your local IP and port, for example `http://YOUR_LOCAL_IP:8096`.

**`fallbackUrl`** is tried automatically if the primary fails. If you are not using a tunnel, set this to `null` and the widget will skip it cleanly.

The widget caches whichever URL succeeds first, so subsequent requests go directly to the working address without retrying the failed one.

---

## 2. API Keys

Most widgets require an API key from the service they connect to. Each widget has a clearly marked placeholder:

```javascript
apiKey: "YOUR_API_KEY_HERE",
```

**How to find your API key for common services:**

- **Jellyfin** — Dashboard → API Keys → + (top right)
- **Radarr / Sonarr / Lidarr / Prowlarr / Bazarr** — Settings → General → Security → API Key
- **qBittorrent** — Tools → Options → Web UI → Enable bypass for clients on localhost (no key needed for local), or use username/password
- **Immich** — User Settings → API Keys → New API Key
- **Navidrome** — Uses token authentication. Generate using the Subsonic API MD5 method. See Navidrome docs for details.
- **AdGuard Home** — Uses username and password, no API key. Fill in the `user` and `pass` fields.
- **Uptime Kuma** — No API key needed. Uses the public status page slug only.

---

## 3. Credentials (Username & Password)

Some widgets use basic authentication instead of API keys. These fields look like:

```javascript
username: "YOUR_USERNAME",
password: "YOUR_PASSWORD",
```

Use the same username and password you use to log into that service's web interface. It is recommended to create a dedicated read-only or limited-permission account for dashboard widgets rather than using your admin account.

---

## 4. Cloudflare Tunnels (Optional)

Cloudflare Tunnels let you expose your self-hosted services to the internet without opening ports on your router. They are entirely optional — if you only access your dashboard from inside your home network, you do not need them.

**If you want to set one up:**

1. Create a free Cloudflare account at cloudflare.com
2. Add your domain to Cloudflare (or use a free `*.trycloudflare.com` subdomain for testing)
3. Install `cloudflared` on your server:
   ```bash
   # Debian/Ubuntu
   curl -L https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null
   echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
   sudo apt update && sudo apt install cloudflared
   ```
4. Authenticate and create a tunnel:
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create my-tunnel
   ```
5. In your Cloudflare Zero Trust dashboard, create a public hostname pointing to your local service (e.g. `jellyfin.yourdomain.com` → `http://localhost:8096`)
6. Put the tunnel URL in the `fallbackUrl` field of the widget

**Cloudflare Access (optional but recommended):** If you want to protect your tunnel behind a login, enable Cloudflare Access in the Zero Trust dashboard and create an Access Application for your dashboard URL. This prevents anyone without your credentials from reaching the dashboard even if they know the URL.

---

## 5. Cloudflare Proxy Worker (Cloudflare Widget Only)

The Cloudflare widget requires a proxy worker because the Cloudflare API does not allow direct browser requests due to CORS restrictions. This worker sits between your browser and the Cloudflare API.

**You only need this if you are using the Cloudflare widget.**

**Setting up the worker:**

1. Log into your Cloudflare dashboard and go to **Workers & Pages**
2. Click **Create Application → Create Worker**
3. Name it something like `cf-proxy`
4. Replace the default code with the following:

```javascript
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.searchParams.get("path");

    if (!path) {
      return new Response("Missing path parameter", { status: 400 });
    }

    const apiUrl = `https://api.cloudflare.com/client/v4${path}`;

    const response = await fetch(apiUrl, {
      method: request.method,
      headers: {
        "Authorization": `Bearer YOUR_CF_API_TOKEN`,
        "Content-Type": "application/json",
      },
      body: request.method !== "GET" ? request.body : null,
    });

    const data = await response.json();

    return new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
};
```

5. Replace `YOUR_CF_API_TOKEN` with a Cloudflare API token that has **Zone:Read** and **Account:Read** permissions (create one at dash.cloudflare.com → My Profile → API Tokens)
6. Deploy the worker and copy its URL (e.g. `https://cf-proxy.yoursubdomain.workers.dev`)
7. Put that URL in the widget config:

```javascript
proxyBase: "https://cf-proxy.yoursubdomain.workers.dev",
```

---

## 6. CORS Rules

CORS (Cross-Origin Resource Sharing) controls which domains are allowed to make API requests to a service. If your widget shows a CORS error in the browser console, you need to add your dashboard's URL to that service's allowed origins.

**Common services and where to set CORS:**

- **Jellyfin** — Dashboard → Networking → Custom SSL certificate domain(s) / also check Advanced → CORS hosts. Add your dashboard URL (e.g. `https://homepage.yourdomain.com`)
- **Radarr / Sonarr / Lidarr / Prowlarr** — Settings → General → Security → Allowed URL origins. Add your dashboard URL.
- **qBittorrent** — Tools → Options → Web UI → "Enable CSRF protection" can interfere. Also add your dashboard hostname under "Bypass authentication for clients on localhost" if accessing locally.
- **Immich** — Generally CORS-safe by default for local access. If issues arise, check your reverse proxy configuration and ensure it passes the correct headers.
- **AdGuard Home** — CORS is handled automatically for local access. If accessing via a tunnel, ensure your reverse proxy forwards the `Origin` header.

**If you are using a reverse proxy (Nginx, Caddy, Traefik)** you can add CORS headers there instead of in each application. Example for Nginx:

```nginx
add_header Access-Control-Allow-Origin "https://your-dashboard-url.com" always;
add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
add_header Access-Control-Allow-Headers "Authorization, Content-Type, X-Api-Key" always;
```

**General rule:** if a widget loads on your local network but fails when accessing remotely through a tunnel, CORS is usually the cause. Add your tunnel URL to the allowed origins for that service.

---

## 7. Quick Checklist

Before considering a widget broken, run through this checklist:

- [ ] `baseUrl` is correct including the port number
- [ ] API key or credentials are filled in and correct
- [ ] The service is actually running and accessible at the URL you entered
- [ ] If accessing remotely, the tunnel URL is in `fallbackUrl`
- [ ] If you see a CORS error in browser DevTools (F12 → Console), add your dashboard URL to the service's allowed origins
- [ ] If using the Cloudflare widget, the proxy worker is deployed and `proxyBase` is set correctly

---

*For support or questions about these widgets, contact me through my github or discord *

Github: https://github.com/SecuredNodeDynamics/Homepage

Discord: https://discord.gg/XCyu64Ee
