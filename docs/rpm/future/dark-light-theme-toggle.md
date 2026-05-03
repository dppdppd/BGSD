# Dark/light theme toggle

## Plan

### Current state

- Backlog entry: `docs/rpm/future/tasks.org` has an unlinked top item, `Dark/light theme toggle`.
- Renderer preferences already flow through `window.bgsd.getPreferences()` / `setPreferences()` in `src/App.svelte`, backed by `preferences.json` in Electron `userData` via `main.js`.
- The preferences modal already edits persisted settings in `src/lib/components/PreferencesModal.svelte`; adding a theme field there fits the existing settings model.
- The app has no theme abstraction today. Most colors are hard-coded in `src/App.svelte` under its `<style>` block, including global styles for `WelcomeScreen`, `PreferencesModal`, and `ScadPreview`. `ElementNode.svelte` and `KVRow.svelte` also contain local hard-coded colors.
- The Electron View menu already drives renderer UI state for defaults and SCAD visibility through `preload.js` callbacks, so a menu-level theme command can reuse that pattern.

### Proposed behavior

- Support a persisted app preference named `theme`, with values:
  - `system`: follow `prefers-color-scheme`
  - `light`: force light mode
  - `dark`: force dark mode
- Default to `system` for new and existing users by merging it into `DEFAULT_PREFS` in `main.js`.
- Apply the effective theme to the renderer root early on startup by setting `document.documentElement.dataset.theme` to `light` or `dark`, and optionally `dataset.themePreference` to the saved preference for diagnostics/tests.
- Provide two user-facing controls:
  - Preferences modal radio/segmented control: System, Light, Dark.
  - View menu items for System, Light, Dark, using the existing main-process menu + preload event pattern.
- Keep SCAD output and project data untouched; this is presentation-only.

### Implementation steps

1. Add a small renderer theme module, likely `src/lib/stores/theme.ts`, with:
   - `type ThemePreference = "system" | "light" | "dark"`
   - a Svelte store for the saved preference
   - `effectiveTheme` derived from preference plus `window.matchMedia("(prefers-color-scheme: dark)")`
   - `loadThemePreference()`, `setThemePreference()`, and DOM application helpers
2. In `main.js`:
   - extend `DEFAULT_PREFS` with `theme: "system"`
   - add a View menu theme section with radio items
   - add IPC send event such as `menu-theme-mode`
   - update menu checked state when theme changes, either by rebuilding the menu from persisted prefs or by updating item checks after `set-preferences`
3. In `preload.js`:
   - expose `onMenuThemeMode(callback)` alongside the existing View menu callbacks.
4. In `src/App.svelte`:
   - load `prefs.theme` during `onMount` before or alongside favorite keys
   - subscribe to/apply effective theme to the document root
   - handle `onMenuThemeMode` by updating the renderer store and persisting via `setPreferences`
   - add a `prefsTheme` bindable state and include it in `openPreferencesModal()` / `savePreferences()`
5. In `src/lib/components/PreferencesModal.svelte`:
   - add a bindable `theme` prop
   - add a compact control in the existing preferences list with data-testid values such as `prefs-theme-system`, `prefs-theme-light`, and `prefs-theme-dark`
6. Convert colors incrementally to CSS custom properties:
   - define default tokens on `:global(:root)` and dark overrides on `:global(:root[data-theme="dark"])`
   - start with app-wide surfaces/text/borders/accent/status/editor rows/inputs/menus
   - replace hard-coded colors in `App.svelte` first, then the extracted component styles in `ElementNode.svelte` and `KVRow.svelte`
   - keep semantic colors for destructive actions, comments, favorites, and debug highlight recognizable in both themes
7. Add a harness script, for example `harness/scripts/test-theme-toggle.txt`, that:
   - opens the welcome screen
   - switches to dark mode through Preferences
   - creates BIT and CTD projects
   - toggles Show SCAD
   - captures screenshots proving toolbar, editor rows, inputs, SCAD pane, status bar, welcome screen, menus/modals, and intent pane remain readable
   - switches back to light mode and captures at least one screenshot

### Verification

- Required baseline gates:
  - `npm run build`
  - `BGSD_HARNESS_SCRIPT=harness/scripts/test-new-bit.txt xvfb-run -a node harness/run.js`
  - `BGSD_HARNESS_SCRIPT=harness/scripts/test-new-ctd.txt xvfb-run -a node harness/run.js`
- Theme-specific gate:
  - `BGSD_HARNESS_SCRIPT=harness/scripts/test-theme-toggle.txt xvfb-run -a node harness/run.js`
  - inspect the generated screenshots in `harness/out/`
- Also run `test-scad-toggle.txt` because the SCAD preview pane has separate global styles and must remain readable in both themes.

### Risks and notes

- The largest risk is incomplete color migration because `App.svelte` owns most global component styles and some child components have local color rules. A token pass should be broad enough before declaring the feature done.
- Persisted settings are currently generic JSON with no schema/migration layer; relying on `DEFAULT_PREFS` merging is consistent with existing code.
- Avoid using theme state to affect generated `.scad`, autosave, importer behavior, or history.
- Consider whether `system` should respond live to OS changes while the app is open; the proposed store supports this with a `matchMedia` change listener.
