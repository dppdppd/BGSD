<script lang="ts">
  let {
    workingDirSet,
    setupBusy,
    setupStatus,
    setupLog,
    sortMode = $bindable("dir" as "dir" | "date"),
    libraryTree,
    libMenu = $bindable<{x: number, y: number, path: string, isRepo: boolean} | null>(null),
    onchooseworkingdir,
    onopenpreferences,
    onupdatelibs,
    onnewproject,
    onopenlibraryfile,
    oneditfile,
    ondeletefile,
    onrenamefile,
    onexportstl,
  }: {
    workingDirSet: boolean;
    setupBusy: boolean;
    setupStatus: string;
    setupLog: string[];
    sortMode: "dir" | "date";
    libraryTree: Record<string, any>;
    libMenu: {x: number, y: number, path: string, isRepo: boolean} | null;
    onchooseworkingdir: () => void;
    onopenpreferences: () => void;
    onupdatelibs: () => void;
    onnewproject: (profile: string) => void;
    onopenlibraryfile: (path: string) => void;
    oneditfile: (path: string) => void;
    ondeletefile: (path: string) => void;
    onrenamefile: (path: string) => void;
    onexportstl: (path: string) => void;
  } = $props();

  function scrollBottom(node: HTMLElement, _deps: any) {
    node.scrollTop = node.scrollHeight;
    return { update() { node.scrollTop = node.scrollHeight; } };
  }

  function formatPublisher(slug: string): string {
    const allCaps: Record<string, string> = { gmt: "GMT", mmp: "MMP" };
    if (allCaps[slug]) return allCaps[slug];
    return slug.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }

  function formatGameName(slug: string): string {
    return slug.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }

  function dateBucket(mtime: number): string {
    const now = Date.now();
    const days = Math.floor((now - mtime) / 86400000);
    if (days < 1) return "Today";
    if (days < 2) return "Yesterday";
    if (days < 7) return "This Week";
    if (days < 30) return "This Month";
    return "Older";
  }

  function filesByDate(pubs: Record<string, any[]>): { bucket: string; files: any[] }[] {
    const all: any[] = [];
    for (const files of Object.values(pubs || {})) {
      for (const f of files) all.push(f);
    }
    all.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    const order = ["Today", "Yesterday", "This Week", "This Month", "Older"];
    const groups: Record<string, any[]> = {};
    for (const f of all) {
      const b = dateBucket(f.mtime || 0);
      if (!groups[b]) groups[b] = [];
      groups[b].push(f);
    }
    return order.filter(b => groups[b]).map(b => ({ bucket: b, files: groups[b] }));
  }

  function showLibMenu(e: MouseEvent, filePath: string, isRepo: boolean) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const menuW = 180;
    const x = rect.right + menuW > window.innerWidth ? rect.left - menuW - 4 : rect.right + 4;
    libMenu = { x, y: rect.top, path: filePath, isRepo };
  }
</script>

<div class="welcome" data-testid="welcome-screen">
  <h1 class="welcome-title">BGSD</h1>
  <p class="welcome-subtitle">Board Game Solutions Designer</p>

  {#if !workingDirSet}
    <div class="welcome-actions">
      <p class="welcome-hint">Set a working directory where your<br>designs and libraries will be stored.</p>
      <button class="welcome-btn welcome-btn-primary" data-testid="welcome-choose-dir" onclick={() => onchooseworkingdir()} disabled={setupBusy}>
        {setupBusy ? "Setting up..." : "Choose Folder..."}
      </button>
      <button class="welcome-btn" data-testid="welcome-prefs-init" onclick={() => onopenpreferences()}>Preferences</button>
      {#if setupBusy || setupStatus}
        <div class="welcome-progress">
          {#if setupBusy}<span class="welcome-spinner"></span>{/if}
          <span class="welcome-progress-msg">{setupStatus}</span>
        </div>
      {/if}
    </div>
  {:else}
    <div class="welcome-icon-bar">
      <div class="update-btn-wrap">
        <button class="welcome-icon-btn" data-testid="welcome-update-libs" title={setupBusy ? "Updating..." : "Update Libraries"} onclick={() => onupdatelibs()} disabled={setupBusy}><span class:spinning={setupBusy}>&#x21BB;</span></button>
        {#if setupBusy || setupLog.length > 0}
          <div class="update-toast" data-testid="update-toast" use:scrollBottom={setupLog}>
            {#if setupBusy}<span class="welcome-spinner"></span>{/if}
            <div class="update-toast-lines">
              {#if setupLog.length > 0}
                {#each setupLog as line}<div class="update-toast-line">{line}</div>{/each}
              {:else}
                <div class="update-toast-line">{setupStatus || "Working..."}</div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
      <button class="welcome-icon-btn" data-testid="welcome-prefs" title="Preferences" onclick={() => onopenpreferences()}>&#x2699;</button>
    </div>
    <div class="welcome-sort-bar">
      <button class="welcome-sort-btn" class:active={sortMode === "dir"} data-testid="sort-dir" onclick={() => sortMode = "dir"}>Directories</button>
      <button class="welcome-sort-btn" class:active={sortMode === "date"} data-testid="sort-date" onclick={() => sortMode = "date"}>Modified</button>
    </div>

    <div class="welcome-columns" data-testid="welcome-columns">
      {#each [["bit", "Storage Inserts", "Box inserts with compartments, lids, and dividers"], ["ctd", "Counter Trays", "Counter trays sized for tokens, markers, and chits"]] as [profileId, profileLabel, profileDesc]}
      {@const tree = libraryTree[profileId]}
      {@const pubs = tree?.publishers}
      {@const designsDir = tree?.designsDir || "my_designs"}
      {@const pubKeys = pubs ? Object.keys(pubs).sort((a, b) => a === designsDir ? -1 : b === designsDir ? 1 : a.localeCompare(b)) : []}
      <div class="welcome-col" class:welcome-col-right-align={profileId === "bit"} data-testid="welcome-col-{profileId}">
        <h2 class="welcome-library-title">{profileLabel}</h2>
        <p class="welcome-library-desc">{profileDesc}</p>
        <div class="welcome-library-scroll">
          {#if sortMode === "dir"}
            {#if !pubKeys.includes(designsDir)}
              <div class="welcome-library-publisher">
                <h3 class="welcome-library-publisher-name">{formatPublisher(designsDir)}</h3>
                <button class="welcome-new-file" data-testid="new-{profileId}" onclick={() => onnewproject(profileId)}>+ New</button>
              </div>
            {/if}
            {#each pubKeys as pub}
              <div class="welcome-library-publisher">
                <h3 class="welcome-library-publisher-name">{formatPublisher(pub)}</h3>
                {#if pub === designsDir}
                  <button class="welcome-new-file" data-testid="new-{profileId}" onclick={() => onnewproject(profileId)}>+ New</button>
                {/if}
                {#each pubs[pub].sort((a: any, b: any) => a.name.localeCompare(b.name)) as game}
                  <button class="welcome-library-game" class:user-file={!game.isRepo} onclick={(e: MouseEvent) => showLibMenu(e, game.path, game.isRepo)}>{formatGameName(game.name)}</button>
                {/each}
              </div>
            {/each}
          {:else}
            {@const dateGroups = filesByDate(pubs)}
            {#each dateGroups as group, gi}
              <div class="welcome-library-publisher">
                <h3 class="welcome-library-publisher-name">{group.bucket}</h3>
                {#if gi === 0}
                  <button class="welcome-new-file" data-testid="new-{profileId}-date" onclick={() => onnewproject(profileId)}>+ New</button>
                {/if}
                {#each group.files as game}
                  <button class="welcome-library-game" class:user-file={!game.isRepo} onclick={(e: MouseEvent) => showLibMenu(e, game.path, game.isRepo)}>{formatGameName(game.name)}</button>
                {/each}
              </div>
            {/each}
            {#if !pubs || Object.keys(pubs).length === 0}
              <div class="welcome-library-publisher">
                <h3 class="welcome-library-publisher-name">Today</h3>
                <button class="welcome-new-file" data-testid="new-{profileId}-date" onclick={() => onnewproject(profileId)}>+ New</button>
              </div>
            {/if}
          {/if}
        </div>
      </div>
      {/each}
    </div>
  {/if}

  {#if libMenu}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="lib-context-backdrop" onclick={() => libMenu = null} onkeydown={() => {}}></div>
    <div class="lib-context-menu" style="left: {libMenu.x}px; top: {libMenu.y}px;">
      {#if libMenu.isRepo}
        <button class="lib-context-item" data-testid="ctx-edit-copy" onclick={() => { const p = libMenu!.path; libMenu = null; onopenlibraryfile(p); }}>Edit a Copy</button>
        <button class="lib-context-item" data-testid="ctx-export-stl" onclick={() => onexportstl(libMenu!.path)}>Export STL</button>
      {:else}
        <button class="lib-context-item" data-testid="ctx-edit" onclick={() => { const p = libMenu!.path; libMenu = null; oneditfile(p); }}>Edit</button>
        <button class="lib-context-item" data-testid="ctx-rename" onclick={() => onrenamefile(libMenu!.path)}>Rename</button>
        <button class="lib-context-item" data-testid="ctx-delete" onclick={() => ondeletefile(libMenu!.path)}>Delete</button>
        <button class="lib-context-item" data-testid="ctx-export-stl" onclick={() => onexportstl(libMenu!.path)}>Export STL</button>
      {/if}
    </div>
  {/if}

</div>
