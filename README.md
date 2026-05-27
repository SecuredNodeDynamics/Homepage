<p align="center">
  <img src="https://img.shields.io/badge/Homepage-Custom%20Widgets-blue?style=for-the-badge&logo=javascript" alt="Homepage Widgets"/>
  <img src="https://img.shields.io/badge/Built%20With-JavaScript%20%7C%20CSS-yellow?style=for-the-badge" alt="Tech Stack"/>
  <img src="https://img.shields.io/badge/Theme-Custom%20CSS-purple?style=for-the-badge" alt="Custom CSS"/>
  <img src="https://img.shields.io/badge/Logic-Custom%20JS-green?style=for-the-badge" alt="Custom JS"/>
</p>

<h1 align="center">🏠 Homepage Custom Widgets</h1>

<p align="center">
  A collection of custom Homepage widgets and dashboard enhancements built for self-hosted infrastructure, media services, and home lab visibility.
</p>

***

## 📋 Overview

This project is focused on building custom widgets for the [Homepage](https://gethomepage.dev) dashboard with a clean and centralized customization workflow. The custom widget logic is added through `custom.js`, while the theming for the Homepage dashboard, dashboard background, and all custom widgets is handled through `custom.css`.

Instead of scattering changes across multiple files, this approach keeps functionality and styling easy to maintain, easy to expand, and simple to deploy across a self-hosted Homepage environment.

> **Built for:** self-hosters, home lab builders, media server admins, and infrastructure engineers.

***

## ✨ Features

- **Custom widget logic in `custom.js`** — widget behavior, API requests, rendering, and dashboard-side interactivity live in one place
- **Unified theming in `custom.css`** — Homepage layout styling, background presentation, and widget appearance are centrally managed
- **Self-hosted service integration** — designed around infrastructure and media platforms commonly found in advanced home labs
- **Responsive widget design** — layouts and styling remain clean across different screen sizes
- **Maintainable structure** — separates behavior from presentation for easier long-term updates

***

## 🧠 Architecture

The customization approach used in this project is intentionally simple:

- `custom.js` is responsible for injecting, rendering, and updating custom widget functionality
- `custom.css` defines the visual language for the full Homepage experience, including dashboard theme, page background, spacing, cards, and widget styling
- This separation makes it easier to tune the look of the entire dashboard without rewriting widget logic

This structure works especially well for users who want Homepage to feel more like a polished operations dashboard than a default landing page.

***

## 🧩 Widget Focus

These widgets are being designed around real-world self-hosted services and infrastructure tooling, including:

- **Proxmox VE** for node and cluster visibility
- **Jellyfin** for media activity and streaming status
- **Navidrome** for music playback and listener insights
- **AdGuard Home** for DNS and blocking metrics
- **Proxmox Backup Server** for backup health and datastore status
- **Netdata** for network and system telemetry

The goal is to surface useful information directly inside Homepage without needing to jump between multiple admin panels.

***

## ⚙️ File Layout

```text
homepage/
├── custom.js
├── custom.css
├── images/
├── icons/
└── README.md
```

### File Roles

- `custom.js` contains the custom Homepage widget logic, JavaScript behavior, API integrations, and rendering flow
- `custom.css` controls the visual theme of the Homepage dashboard, the page background, shared dashboard styling, and the appearance of each custom widget
- Supporting folders such as `images/` or `icons/` can store assets used by the widgets or themed dashboard elements

***

## 🚀 Design Goals

This project is built around a few core goals:

- **Clarity** — important infrastructure and media information should be visible at a glance
- **Consistency** — widgets should feel like a native part of the Homepage dashboard
- **Extensibility** — new widgets should be easy to add through `custom.js`
- **Centralized styling** — dashboard-wide theming changes should happen in `custom.css`

That means the dashboard is treated as a cohesive interface, not just a grid of disconnected tiles.

***

## 🛠️ Development Notes

When building new widgets for this setup:

1. Add or extend the widget logic inside `custom.js`
2. Style the widget and any dashboard-wide visual updates inside `custom.css`
3. Keep shared visual patterns consistent so every widget matches the overall Homepage theme
4. Test changes against the full dashboard to ensure the background, layout, and widgets still feel unified

This keeps the workflow straightforward and avoids fragmented styling or duplicated logic.

***

## 📸 Screenshots

> Screenshot examples can be added here later to show the dashboard theme, background styling, and custom widget layouts in action.

***

## 🤝 Contributing

Contributions, ideas, and improvements are welcome — especially for self-hosted integrations that fit the Homepage ecosystem. New widgets should follow the same structure: logic in `custom.js`, presentation in `custom.css`, and a consistent dashboard-first design approach.

***

## 📄 License

This project can be released under the MIT License or whatever license best matches the repository goals.

***

<p align="center">
  Built for a custom self-hosted Homepage experience.
</p>
