# BGSD — rpm Context

Injected at session start. Keep under 30 lines.

## Project Summary
Cross-platform desktop GUI for constructing Boardgame Insert Toolkit (BIT)
design files. Electron 33 + Svelte 5 (runes) + Vite 6, with Playwright-driven
harness for headless visual verification. Solo project (Ido Magal). License
CC BY-NC-SA 4.0. The `.scad` file is the source of truth — the GUI preserves
user code, comments, and preamble/postamble. UI is schema-driven from
`schema/bit.schema.json` and `schema/ctd.schema.json`.

## Key Files
| What | Where |
|------|-------|
| Project instructions | AGENTS.md (CLAUDE.md → AGENTS.md) |
| Frontend entry | src/App.svelte, src/main.ts |
| Electron main | main.js |
| Preload bridge | preload.js |
| SCAD parser | importer.js |
| Schema (BIT/CTD) | schema/bit.schema.json, schema/ctd.schema.json |
| Harness | harness/run.js, harness/scripts/*.txt |
| Unit tests | tests/ (vitest) |
| Build/release | build-release.sh, docs/guidance/RELEASE.md |

## Focus Areas for Review
- **Round-trip fidelity**: minimal-diff SCAD save/load (line-based model)
- **Schema drift**: GUI controls must stay aligned with the SCAD schema files
- **Harness coverage**: every UI behavior change needs a harness script + screenshot
- **Cross-platform packaging**: Electron-builder targets (linux/win/mac) via build-release.sh

## Prior Findings
See `docs/rpm/past/log.md` Audit History.
