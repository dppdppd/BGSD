# BGSD — Board Game Storage Designer

A visual desktop editor for creating parametric 3D-printable board game inserts using OpenSCAD libraries.

BGSD provides a GUI for editing `.scad` data structures — no OpenSCAD coding required. It generates valid OpenSCAD files that can be rendered and exported to STL for 3D printing.

![BGSD Overview](images/bgsd_overview.png)

## Supported Libraries

| Library | Repo | Status |
|---------|------|--------|
| [Boardgame Insert Toolkit](https://github.com/dppdppd/The-Boardgame-Insert-Toolkit) | `dppdppd/The-Boardgame-Insert-Toolkit` | Supported |

BGSD automatically downloads the required library files from GitHub and places them next to your `.scad` file on save.

## Features

- **Schema-driven UI** — all controls generated from a JSON schema
- **Round-trip editing** — open existing `.scad` files, edit visually, save back without losing comments or formatting
- **Live preview** — edit parameters and see the generated SCAD update in real time
- **Library profiles** — pluggable support for multiple parametric SCAD libraries
- **On-demand library fetch** — downloads library `.scad` files from GitHub, caches locally

## Screenshots

| Imported file | Scrolled view |
|--------------|---------------|
| ![Imported](images/bgsd_imported.png) | ![Scrolled](images/bgsd_scrolled.png) |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [OpenSCAD](https://openscad.org/) (for rendering)

### Install and Run

```bash
npm install
npm run build
npm start
```

### Development

```bash
npm run dev    # Vite watch + Electron with hot reload
```

### Package for Distribution

```bash
npm run dist:linux   # AppImage
npm run dist:win     # NSIS installer + portable
npm run dist:mac     # zip
```

## How It Works

1. **New file** — creates a starter `.scad` with a basic box definition
2. **Open file** — parses an existing `.scad` file into editable parameters
3. **Edit** — modify box sizes, features, lids, labels, dividers, and globals through the UI
4. **Save** — generates valid OpenSCAD code, downloads library files if needed
5. **Open in OpenSCAD** — launches OpenSCAD with your file for rendering/export

## Architecture

- **Electron** — desktop shell with file system access
- **Svelte 5** — reactive UI with runes (`$state`, `$derived`, `$effect`)
- **Vite** — build toolchain
- **Line-based model** — preserves raw SCAD text for round-trip fidelity

## Related Projects

- [Boardgame Insert Toolkit](https://github.com/dppdppd/The-Boardgame-Insert-Toolkit) — the OpenSCAD parametric library for board game inserts

## License

MIT
