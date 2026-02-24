# BGSD — Board Game Storage Designer

A visual desktop editor for creating parametric 3D-printable board game inserts using OpenSCAD libraries. No OpenSCAD coding required.

![BGSD Overview](images/bgsd_overview.png)

## Download

Grab the latest release for your platform:

**[Download BGSD](https://github.com/dppdppd/BGSD/releases/latest)**

| Platform | Format |
|----------|--------|
| Windows  | Installer (.exe) + portable |
| Linux    | AppImage |
| macOS    | .zip |

You will also need [OpenSCAD](https://openscad.org/) installed to render and export your designs to STL.

## How to Use

1. **Create or open a file** — start a new project or open an existing `.scad` file
2. **Edit visually** — modify box sizes, features, lids, labels, dividers, and globals through the UI
3. **Save** — generates valid OpenSCAD code and automatically downloads the required library files
4. **Open in OpenSCAD** — launches OpenSCAD with your file for rendering and STL export

BGSD preserves your comments, formatting, and any hand-written code when round-tripping `.scad` files.

## Features

- **Visual parameter editing** — all controls generated from the library schema, no need to memorize parameter names
- **Round-trip fidelity** — open existing `.scad` files, edit visually, save back without losing comments or formatting
- **Live SCAD preview** — see the generated code update as you edit
- **Automatic library management** — downloads library `.scad` files from GitHub on save, no manual setup needed

## Supported Libraries

| Library | Status |
|---------|--------|
| [Boardgame Insert Toolkit](https://github.com/dppdppd/The-Boardgame-Insert-Toolkit) | Supported |
| [Counter Tray Designer](https://github.com/dppdppd/Counter-Tray-Designer) | Supported |

## Screenshots

![Imported file](images/bgsd_imported.png)

---

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [OpenSCAD](https://openscad.org/)

### Install and Run

```bash
npm install
npm run build
npm start
```

### Dev Mode

```bash
npm run dev    # Vite watch + Electron with hot reload
```

### Package for Distribution

```bash
npm run dist:linux   # AppImage
npm run dist:win     # NSIS installer + portable
npm run dist:mac     # zip
```

### Architecture

- **Electron** — desktop shell with file system access
- **Svelte 5** — reactive UI with runes
- **Vite** — build toolchain
- **Line-based model** — preserves raw SCAD text for round-trip fidelity

## License

CC BY-NC-SA 4.0
