# Group Widget — Multi-Widget Flex Row Guide

## Overview

When two or more custom widgets share the same Homepage group, they will stack
vertically by default because each widget manages its own DOM injection. To place
them **side by side**, all widgets in the group must share a single flex row
container. This is controlled by the `ensureHost` function in each widget's JS.

---

## How It Works

| Piece | What it does |
|---|---|
| `SHARED_ROW_CLASS` | The flex row container. **Identical** across every widget in the group. |
| `HOST_CLASS` | The widget's own host div. **Unique** per widget. |

- The **first widget to load** creates the shared row and appends its host inside it.
- Every **subsequent widget** finds the existing row and appends its own host alongside.
- The CSS `display: flex; flex-direction: row` then places all hosts side by side.
- `flex: 1` on each host gives them equal width.

---

## JS Template

Copy this `ensureHost` block into each widget. Change the two constants at the top.

```javascript
function ensureHost(group) {
  // ── SHARED ROW IDENTIFIER ─────────────────────────────────────────
  // This class name must be IDENTICAL in every widget that shares this row.
  // If you add a 3rd or 4th widget to this group, update their ensureHost
  // to also look for this class and it will slot into the same row.
  const SHARED_ROW_CLASS = "arr-js-flex-row"; // ← change per group

  // ── HOST IDENTIFIER ───────────────────────────────────────────────
  // This class name is UNIQUE to this widget. Change it per widget.
  // e.g. ".jf-monitor-host", ".sr-host", ".tdr-host", ".ldr-host" etc.
  const HOST_CLASS = "jf-monitor-host"; // ← change per widget
  // ─────────────────────────────────────────────────────────────────

  let row = group.querySelector("." + SHARED_ROW_CLASS);
  if (!row) {
    const list = group.querySelector("ul.services-list, ul");
    if (list) list.style.display = "none";
    row = document.createElement("div");
    row.className = SHARED_ROW_CLASS;
    group.appendChild(row);
  }
  let host = row.querySelector("." + HOST_CLASS);
  if (host) return host;
  host = document.createElement("div");
  host.className = HOST_CLASS;
  row.appendChild(host);
  return host;
}
```

---

## CSS Template

Add one selector per widget host. Add a new line for each additional widget.

```css
/* ── Flex Row — Group Name (Widget A + Widget B) ─── */
/* Add a new selector below for every additional widget added to this group */
.arr-js-flex-row {                        /* ← matches SHARED_ROW_CLASS */
  display: flex;
  flex-direction: row;
  gap: 16px;
  width: 100%;
}

.arr-js-flex-row .jf-monitor-host,       /* ← Widget A HOST_CLASS */
.arr-js-flex-row .sr-host                /* ← Widget B HOST_CLASS */
/* .arr-js-flex-row .new-widget-host */  /* ← add Widget C here   */
{
  flex: 1;
  min-width: 0;
}
```

---

## Naming Convention

Use a shared row class name that reflects the group it belongs to.

| Group | Shared Row Class |
|---|---|
| `ARR — LIDARR.TDARR` | `arr-lt-flex-row` |
| `ARR — JELLYFIN.SEERR` | `arr-js-flex-row` |
| Single widget group | Use the widget's own prefix e.g. `wzr-flex-row` |

---

## Checklist — Adding a New Widget to an Existing Group

- [ ] Set `SHARED_ROW_CLASS` to the **same value** as the other widgets in the group
- [ ] Set `HOST_CLASS` to a **unique** class for this widget
- [ ] Add `.shared-row-class .new-host-class` to the CSS selector list
- [ ] Confirm the `groupName` in the widget config **exactly matches** the Homepage group heading

---

## Checklist — Creating a New Multi-Widget Group

- [ ] Pick a shared row class name for the group (e.g. `arr-xy-flex-row`)
- [ ] Set `SHARED_ROW_CLASS` to that value in **every** widget in the group
- [ ] Give each widget its own unique `HOST_CLASS`
- [ ] Add the CSS block with all host selectors listed
- [ ] Set the same `groupName` string in every widget config

---

## Example — Three Widgets Side by Side

**Widget A JS:** `SHARED_ROW_CLASS = "arr-abc-flex-row"`, `HOST_CLASS = "widget-a-host"`

**Widget B JS:** `SHARED_ROW_CLASS = "arr-abc-flex-row"`, `HOST_CLASS = "widget-b-host"`

**Widget C JS:** `SHARED_ROW_CLASS = "arr-abc-flex-row"`, `HOST_CLASS = "widget-c-host"`

**CSS:**
```css
.arr-abc-flex-row {
  display: flex;
  flex-direction: row;
  gap: 16px;
  width: 100%;
}

.arr-abc-flex-row .widget-a-host,
.arr-abc-flex-row .widget-b-host,
.arr-abc-flex-row .widget-c-host {
  flex: 1;
  min-width: 0;
}
```
