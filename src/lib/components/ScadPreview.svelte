<script lang="ts">
  import type { Line } from "../stores/project";
  import { INDENT } from "../config";

  let {
    lines,
    libraryProfile,
    hiddenLines,
    kvRenderedInBlock,
    globalRenderedInBlock,
    collapsed,
    defaultsMode,
    isFavorite,
    scadWidth = $bindable(500),
    getGlobalRows,
    getSortedSchemaRowsForOpen,
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
    defaultsMode: "all" | "favorites" | "none";
    isFavorite: (key: string) => boolean;
    scadWidth: number;
    getGlobalRows: () => any[];
    getSortedSchemaRowsForOpen: (i: number) => any[];
    supportsLid: (i: number) => boolean;
    hasLidChild: (i: number) => boolean;
    getScalarKeysForContext: (ctx: string) => any[];
    isLastOfKind: (i: number) => boolean;
    isRawGroupStart: (i: number) => boolean;
    rawGroupText: (i: number) => string;
    isRawGroupMember: (i: number) => boolean;
  } = $props();

  let dragging = $state(false);

  function scadIndent(depth: number): string { return INDENT.repeat(depth); }

  function isVirtualHidden(key: string): boolean {
    return defaultsMode === "none" || (defaultsMode === "favorites" && !isFavorite(key));
  }

  function onSplitHandleDown(e: MouseEvent) {
    e.preventDefault();
    dragging = true;
    const onMove = (ev: MouseEvent) => {
      const newWidth = window.innerWidth - ev.clientX;
      scadWidth = Math.max(200, Math.min(newWidth, window.innerWidth * 0.8));
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
<div class="split-handle" onmousedown={onSplitHandleDown}></div>
<div class="editor-right" data-testid="scad-pane" style="width: {scadWidth}px">
{#each lines as line, i (i)}
  {#if hiddenLines.has(i)}
    <!-- hidden -->
  {:else if kvRenderedInBlock.has(i)}
    <!-- rendered in schema block -->
  {:else if globalRenderedInBlock.has(i)}
    <!-- rendered in globals block -->

  {:else if line.kind === "open"}
    <div class="scad-line">{line.raw}</div>
    {#if !collapsed.has(i)}
    {#if line.role === "data" && libraryProfile !== "ctd"}
      {#each getGlobalRows() as row (row.key)}
        {#if !row.isReal && isVirtualHidden(row.key)}{:else}
          {#if row.isReal && row.lineIndex !== null}
            <div class="scad-line">{lines[row.lineIndex].raw}</div>
          {:else}
            <div class="scad-line scad-virtual"></div>
          {/if}
        {/if}
      {/each}
    {/if}
    {#each getSortedSchemaRowsForOpen(i) as row (row.key)}
      {#if !row.isReal && isVirtualHidden(row.key)}{:else}
        {#if row.isReal && row.lineIndex !== null}
          <div class="scad-line">{lines[row.lineIndex].raw}</div>
        {:else}
          <div class="scad-line scad-virtual"></div>
        {/if}
      {/if}
    {/each}
    {/if}

  {:else if line.kind === "close"}
    {@const _lidScalars = [...getScalarKeysForContext("lid")].sort((a, b) => a.key.localeCompare(b.key))}
    {@const _showLid = defaultsMode !== "none" && libraryProfile !== "ctd" && supportsLid(i) && !hasLidChild(i) && (defaultsMode === "all" || _lidScalars.some(s => isFavorite(s.key)))}
    {#if _showLid}
      <div class="scad-line scad-virtual"></div>
      {#each _lidScalars as srow (srow.key)}
        {#if defaultsMode === "favorites" && !isFavorite(srow.key)}{:else}
        <div class="scad-line scad-virtual"></div>
        {/if}
      {/each}
      <div class="scad-line scad-virtual"></div>
      <div class="scad-line scad-virtual"></div>
    {/if}
    {#if line.role === "data" || (line.role === "params" && libraryProfile !== "ctd") || (line.role === "object" && libraryProfile !== "ctd") || ((line.role === "lid" || line.role === "lid_params") && libraryProfile !== "ctd")}
      <div class="scad-line scad-virtual"></div>
    {/if}
    {#if line.role === "counter_set" && libraryProfile === "ctd" && isLastOfKind(i)}
      <div class="scad-line scad-virtual"></div>
    {/if}
    {#if line.mergedClose}
      {@const hasVirtualLid = defaultsMode !== "none" && libraryProfile !== "ctd" && supportsLid(i) && !hasLidChild(i) && (defaultsMode === "all" || getScalarKeysForContext("lid").some(s => isFavorite(s.key)))}
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
