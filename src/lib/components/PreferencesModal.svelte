<script lang="ts">
  import tooltips from "../tooltips/en.json";
  const i18n = tooltips as Record<string, { label?: string; tooltip?: string }>;

  let {
    show = $bindable(false),
    workingDir = $bindable(""),
    openScadPath = $bindable(""),
    autoOpen = $bindable(true),
    proxy = $bindable(""),
    onsave,
    onbrowseworkingdir,
    onbrowseopenscad,
  }: {
    show: boolean;
    workingDir: string;
    openScadPath: string;
    autoOpen: boolean;
    proxy: string;
    onsave: () => void;
    onbrowseworkingdir: () => void;
    onbrowseopenscad: () => void;
  } = $props();

  function openExternal(url: string) {
    (window as any).bgsd?.openExternal?.(url);
  }
</script>

{#if show}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="prefs-overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) show = false; }}>
    <div class="prefs-modal" data-testid="prefs-modal">
      <h2 class="prefs-title">Preferences</h2>
      <div class="prefs-row">
        <label class="prefs-label" for="prefs-working-dir">Working directory</label>
        <div class="prefs-input-row">
          <input class="prefs-input" id="prefs-working-dir" type="text" bind:value={workingDir} placeholder="(not set)" data-testid="prefs-working-dir" />
          <button class="prefs-browse" onclick={onbrowseworkingdir} data-testid="prefs-browse-working-dir">Browse...</button>
        </div>
      </div>
      <div class="prefs-row">
        <label class="prefs-label" for="prefs-openscad-path">OpenSCAD path</label>
        <div class="prefs-input-row">
          <input class="prefs-input" id="prefs-openscad-path" type="text" bind:value={openScadPath} placeholder="(auto-detect)" data-testid="prefs-openscad-path" />
          <button class="prefs-browse" onclick={onbrowseopenscad} data-testid="prefs-browse">Browse...</button>
        </div>
      </div>
      <div class="prefs-row">
        <label class="prefs-check-label">
          <input type="checkbox" bind:checked={autoOpen} data-testid="prefs-auto-open" />
          Auto-open in OpenSCAD when loading a file
        </label>
      </div>
      <div class="prefs-row">
        <label class="prefs-label" for="prefs-proxy">HTTP proxy</label>
        <input class="prefs-input" id="prefs-proxy" type="text" style="width: 100%; box-sizing: border-box;" bind:value={proxy} placeholder="e.g. http://proxy:8080" data-testid="prefs-proxy" />
      </div>
      <div class="prefs-buttons">
        <button class="prefs-btn" onclick={() => show = false}>Cancel</button>
        <button class="prefs-btn primary" onclick={onsave} data-testid="prefs-save">Save</button>
      </div>
      <div class="prefs-divider"></div>
      <div class="prefs-about">
        <div class="prefs-links">
          <!-- svelte-ignore a11y_invalid_attribute -->
          <a href="#" onclick={(e) => { e.preventDefault(); openExternal('https://github.com/dppdppd/bgsd'); }}>BGSD</a>
          <span class="prefs-link-sep">&middot;</span>
          <!-- svelte-ignore a11y_invalid_attribute -->
          <a href="#" onclick={(e) => { e.preventDefault(); openExternal('https://github.com/dppdppd/The-Boardgame-Insert-Toolkit'); }}>Board Game Insert Toolkit</a>
          <span class="prefs-link-sep">&middot;</span>
          <!-- svelte-ignore a11y_invalid_attribute -->
          <a href="#" onclick={(e) => { e.preventDefault(); openExternal('https://github.com/dppdppd/counter-tray-designer'); }}>Counter Tray Designer</a>
        </div>
        <div class="prefs-submit-designs">
          <p class="prefs-submit-title">{i18n["_ui_share_title"]?.label}</p>
          <p class="prefs-submit-help">{i18n["_ui_share_intro"]?.label}
            <!-- svelte-ignore a11y_invalid_attribute -->
            <a href="#" onclick={(e) => { e.preventDefault(); openExternal('https://chatgpt.com/?q=' + encodeURIComponent('I want to submit a new design as a pull request to the Board Game Insert Toolkit (BIT) github project (https://github.com/dppdppd/The-Boardgame-Insert-Toolkit). This is one of two OpenSCAD libraries used by the BGSD editor — the other is Counter Tray Designer (CTD) at https://github.com/dppdppd/counter-tray-designer. I have no github experience. Walk me through the process step by step.')); }}>{i18n["_ui_share_help_bit"]?.label}</a>
            <span class="prefs-link-sep">&middot;</span>
            <!-- svelte-ignore a11y_invalid_attribute -->
            <a href="#" onclick={(e) => { e.preventDefault(); openExternal('https://chatgpt.com/?q=' + encodeURIComponent('I want to submit a new design as a pull request to the Counter Tray Designer (CTD) github project (https://github.com/dppdppd/counter-tray-designer). This is one of two OpenSCAD libraries used by the BGSD editor — the other is Board Game Insert Toolkit (BIT) at https://github.com/dppdppd/The-Boardgame-Insert-Toolkit. I have no github experience. Walk me through the process step by step.')); }}>{i18n["_ui_share_help_ctd"]?.label}</a>
          </p>
        </div>
        <p class="prefs-copyright">{i18n["_ui_share_copyright"]?.label}</p>
      </div>
    </div>
  </div>
{/if}
