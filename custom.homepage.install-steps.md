# Custom Widget Installation for Homepage

This guide explains how to add your custom widgets to the Homepage dashboard.

## Step 1 — Copy the JavaScript

1. Open the `widgetname.widget.js` file.
2. Copy the **entire widget `.js` code block**.
3. Paste it into your Homepage config's `custom.js` file.

---

## Step 2 — Copy the CSS

1. Open the `widgetname.widget.css` file.
2. Copy the **entire `.css` widget code block**.
3. Paste it into your Homepage config's `custom.css` file.

---

## Step 3 — Add the Widget Anchor to `services.yaml`

1. Open the `widgetname.widget.services.yaml` file.
2. Copy the **entire widget anchor block** (the top-level key and its nested item).
3. Open your Homepage config's `services.yaml` file.
4. Paste the widget anchor **below the `layout:` line**, where your other links and buttons are located.

Your `services.yaml` should follow this structure:

```yaml
- ARR -- INDEXERS:

    - Prowlarr:
        icon: https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/prowlarr.webp
        description: Indexer Management (injected widget)

- ARR — BAZARR:

    - Bazarr:
        icon: https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/bazarr.webp
        description: Subtitle Management (injected widget)

- ARR — WIZARR:

    - Wizarr:
        icon: https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/wizarr.webp
        description: User invitation management (injected widget)

- ARR — TDARR:

    - Tdarr Anchor:
        icon: https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/tdarr.webp
        description: Transcode pipeline (injected widget)

- ARR — YOUR-WIDGET:

    - Your Widget Name:
        icon: https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/your-icon.webp
        description: Your widget description (injected widget)
```

> Replace `YOUR-WIDGET`, `Your Widget Name`, the icon URL, and description with your actual widget details.

---

## Step 4 — Add Card Placement in `settings.yaml`
0. Add this block above the layout:

```
color: slate
theme: dark
customCSS: true
showStats: true
```

2. Open your Homepage config's `settings.yaml` file.
3. Under the `layout:` section, create a **connecting card placement block** for the new widget anchor you just added to `services.yaml`.

Your `settings.yaml` layout block should look like this:

```yaml
layout:

  # ── Media Tab ──────────────────────────────────────

  JELLYFIN-INJECTED:
    tab: Media
    style: row
    columns: 1
    initiallyCollapsed: false

  MEDIA-WIDGETS:
    tab: Media
    style: row
    columns: 2
    initiallyCollapsed: false

  ARR — WIZARR:
    tab: Media
    style: row
    columns: 1
    initiallyCollapsed: false

  ARR — YOUR-WIDGET:
    tab: Media
    style: row
    columns: 1
    initiallyCollapsed: false
```

> The key `ARR — YOUR-WIDGET` must **exactly match** the top-level name you used in `services.yaml`.

---

## Quick Checklist

- [ ] `custom.js` updated with widget JS
- [ ] `custom.css` updated with widget CSS
- [ ] `services.yaml` updated with widget anchor under `layout:`
- [ ] `settings.yaml` updated with card placement for the new widget

---

## Notes

- The widget anchor name in `services.yaml` and `settings.yaml` must match exactly.
- Adjust `columns:` in `settings.yaml` to control how many widgets appear per row.
- Set `initiallyCollapsed: true` if you want the widget row collapsed by default.
