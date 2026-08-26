<script lang="ts">
  import type { Line } from "../stores/project";
  import { INDENT } from "../config";

  type DefaultsMode = "all" | "favorites" | "none";

  let {
    lines,
    libraryProfile,
    hiddenLines,
    kvRenderedInBlock,
    globalRenderedInBlock,
    collapsed,
    displayRevision,
    scadWidth = $bindable(500),
    getGlobalRows,
    getSortedSchemaRowsForOpen,
    getSchemaScopeForOpen,
    groupRowsForDisplay,
    groupScalarDefaultsForDisplay,
    blockDefaultsKeyForOpen,
    blockDefaultsKeyForVirtualLid,
    blockDefaultsMode,
    blockDefaultsModeIsExplicit,
    supportsLid,
    hasLidChild,
    getScalarKeysForContext,
    isLastOfKind,
    isRawGroupStart,
    rawGroupText,
    isRawGroupMember,
  }: {
    lines: Line[];
    libraryProfile: string | undefined;
    hiddenLines: Set<number>;
    kvRenderedInBlock: Set<number>;
    globalRenderedInBlock: Set<number>;
    collapsed: Set<number>;
    displayRevision: string;
    scadWidth: number;
    getGlobalRows: () => any[];
    getSortedSchemaRowsForOpen: (i: number) => any[];
    getSchemaScopeForOpen: (i: number) => string;
    groupRowsForDisplay: (rows: any[], scope: string, fallbackDepth?: number, mode?: DefaultsMode) => any[];
    groupScalarDefaultsForDisplay: (rows: { key: string; def: any }[], scope: string, depth: number, mode?: DefaultsMode) => any[];
    blockDefaultsKeyForOpen: (i: number) => string;
    blockDefaultsKeyForVirtualLid: (i: number) => string;
    blockDefaultsMode: (blockKey: string) => DefaultsMode;
    blockDefaultsModeIsExplicit: (blockKey: string) => boolean;
    supportsLid: (i: number) => boolean;
    hasLidChild: (i: number) => boolean;
    getScalarKeysForContext: (ctx: string) => any[];
    isLastOfKind: (i: number) => boolean;
    isRawGroupStart: (i: number) => boolean;
    rawGroupText: (i: number) => string;
    isRawGroupMember: (i: number) => boolean;
  } = $props();

  const MIN_SCAD_WIDTH = 200;
  const MIN_EDITOR_LEFT_WIDTH = 560;
  const SPLIT_HANDLE_WIDTH = 6;

  let dragging = $state(false);
  let splitHandle: HTMLDivElement | null = $state(null);

  function scadIndent(depth: number): string { return INDENT.repeat(depth); }

  function availableSplitWidth(): number {
    return splitHandle?.parentElement?.getBoundingClientRect().width || window.innerWidth;
  }

  function clampScadWidth(width: number): number {
    const maxRightWidth = Math.max(
      MIN_SCAD_WIDTH,
      availableSplitWidth() - MIN_EDITOR_LEFT_WIDTH - SPLIT_HANDLE_WIDTH,
    );
    return Math.max(MIN_SCAD_WIDTH, Math.min(width, maxRightWidth));
  }

  $effect(() => {
    if (!splitHandle) return;
    const onResize = () => {
      scadWidth = clampScadWidth(scadWidth);
    };
    const frame = requestAnimationFrame(onResize);
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  });

  function onSplitHandleDown(e: MouseEvent) {
    e.preventDefault();
    dragging = true;
    const onMove = (ev: MouseEvent) => {
      const newWidth = window.innerWidth - ev.clientX;
      scadWidth = clampScadWidth(newWidth);
    };
    const onUp = () => {
      dragging = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="split-handle" bind:this={splitHandle} onmousedown={onSplitHandleDown}></div>
<div class="editor-right" data-testid="scad-pane" data-display-revision={displayRevision} style="width: {scadWidth}px">
{#each lines as line, i (i)}
  {#if hiddenLines.has(i)}
    <!-- hidden -->
  {:else if kvRenderedInBlock.has(i)}
    <!-- rendered in schema block -->
  {:else if globalRenderedInBlock.has(i)}
    <!-- rendered in globals block -->

  {:else if line.kind === "open"}
    {@const _openDefaultsMode = blockDefaultsMode(blockDefaultsKeyForOpen(i))}
    <div class="scad-line">{line.raw}</div>
    {#if !collapsed.has(i)}
    {#if line.role === "data" && libraryProfile !== "ctd"}
      {#each groupRowsForDisplay(getGlobalRows(), "globals", 1, _openDefaultsMode) as group (group.id)}
        <div class="scad-line scad-virtual"></div>
        {#each group.rows as row (row.key)}
          {#if row.isReal && row.lineIndex !== null}
            <div class="scad-line">{lines[row.lineIndex].raw}</div>
          {:else}
            <div class="scad-line scad-virtual"></div>
          {/if}
        {/each}
      {/each}
    {/if}
    {#each groupRowsForDisplay(getSortedSchemaRowsForOpen(i), getSchemaScopeForOpen(i), (line.depth ?? 0) + 1, _openDefaultsMode) as group (group.id)}
      <div class="scad-line scad-virtual"></div>
      {#each group.rows as row (row.key)}
        {#if row.isReal && row.lineIndex !== null}
          <div class="scad-line">{lines[row.lineIndex].raw}</div>
        {:else}
          <div class="scad-line scad-virtual"></div>
        {/if}
      {/each}
    {/each}
    {/if}

  {:else if line.kind === "close"}
    {@const _lidScalars = [...getScalarKeysForContext("lid")].sort((a, b) => a.key.localeCompare(b.key))}
    {@const _lidDefaultsKey = blockDefaultsKeyForVirtualLid(i)}
    {@const _lidMode = blockDefaultsMode(_lidDefaultsKey)}
    {@const _lidGroups = groupScalarDefaultsForDisplay(_lidScalars, "lid", (line.depth ?? 0) + 2, _lidMode)}
    {@const _showLid = libraryProfile !== "ctd" && supportsLid(i) && !hasLidChild(i) && (_lidGroups.length > 0 || blockDefaultsModeIsExplicit(_lidDefaultsKey))}
    {#if _showLid}
      <div class="scad-line scad-virtual"></div>
      {#each _lidGroups as group (group.id)}
        <div class="scad-line scad-virtual"></div>
        {#each group.rows as srow (srow.key)}
        <div class="scad-line scad-virtual"></div>
        {/each}
      {/each}
      <div class="scad-line scad-virtual"></div>
      <div class="scad-line scad-virtual"></div>
    {/if}
    {#if line.role === "data" || (line.role === "params" && libraryProfile !== "ctd") || (line.role === "object" && libraryProfile !== "ctd") || (line.role === "feature_list" && libraryProfile !== "ctd") || ((line.role === "lid" || line.role === "lid_params") && libraryProfile !== "ctd")}
      <div class="scad-line scad-virtual"></div>
    {/if}
    {#if line.role === "counter_set" && libraryProfile === "ctd" && isLastOfKind(i)}
      <div class="scad-line scad-virtual"></div>
    {/if}
    {#if line.mergedClose}
      {@const hasVirtualLid = _showLid}
      {#if !hasVirtualLid}
        <div class="scad-line">{scadIndent((line.depth ?? 0) + 1)}],</div>
      {/if}
      <div class="scad-line">{scadIndent(line.depth ?? 0)}],</div>
    {:else}
      <div class="scad-line">{line.raw}</div>
    {/if}
    {#if line.role === "data"}
      <div class="scad-line scad-virtual"></div>
    {/if}

  {:else if line.kind === "kv" && line.kvKey}
    <div class="scad-line">{line.raw}</div>

  {:else if line.kind === "makeall"}
    <div class="scad-line">Make({line.varName || "data"});</div>

  {:else if line.kind === "blank"}
    <div class="scad-line">&nbsp;</div>

  {:else if line.kind === "include" || line.kind === "marker"}
    <div class="scad-line">{line.raw}</div>

  {:else if line.kind === "variable"}
    <div class="scad-line">{line.raw}</div>

  {:else if line.kind === "comment"}
    <div class="scad-line">{line.raw}</div>

  {:else if line.kind === "raw" && isRawGroupStart(i)}
    <div class="scad-raw-group">{rawGroupText(i)}</div>

  {:else if line.kind === "raw" && isRawGroupMember(i)}
    <!-- skip -->

  {:else}
    <div class="scad-line">{line.raw}</div>
  {/if}
{/each}
</div>
