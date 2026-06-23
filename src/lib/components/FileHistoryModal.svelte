<script lang="ts">
  import { slide } from "svelte/transition";

  type UndoRevision = {
    id: string;
    timestamp: string;
    hash: string;
    hashPrefix: string;
    label: string;
    pinned: boolean;
    changeSummary: string;
    isBase: boolean;
    index: number;
  };

  let {
    show = $bindable(false),
    filePath,
    onrestore,
  }: {
    show: boolean;
    filePath: string | null;
    onrestore: (payload: { data: any; revision: UndoRevision; scadText: string }) => void | Promise<void>;
  } = $props();

  let revisions = $state<UndoRevision[]>([]);
  let loading = $state(false);
  let error = $state("");
  let previewText = $state("");
  let previewRevision = $state<UndoRevision | null>(null);
  let editingId = $state<string | null>(null);
  let labelDraft = $state("");
  let loadedFor = $state<string | null>(null);

  $effect(() => {
    if (show && filePath && loadedFor !== filePath) {
      loadedFor = filePath;
      void refreshHistory();
    }
    if (!show) {
      previewText = "";
      previewRevision = null;
      editingId = null;
      labelDraft = "";
      loadedFor = null;
    }
  });

  function shortId(id: string): string {
    return id.replace(/-/g, "").slice(0, 8);
  }

  function formatDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
  }

  async function refreshHistory() {
    if (!filePath) return;
    const bgsd = (window as any).bgsd;
    if (!bgsd?.listUndoHistory) return;
    loading = true;
    error = "";
    try {
      const result = await bgsd.listUndoHistory(filePath);
      if (result?.ok) {
        revisions = result.revisions || [];
      } else if (result?.corrupt) {
        revisions = [];
        error = `Version History sidecar is corrupt: ${result.error || "unknown error"}`;
      } else {
        revisions = [];
        error = result?.error || "Could not load Version History";
      }
    } catch (err: any) {
      revisions = [];
      error = err?.message || "Could not load Version History";
    } finally {
      loading = false;
    }
  }

  async function previewRevisionText(revision: UndoRevision) {
    if (previewRevision?.id === revision.id) {
      previewRevision = null;
      return;
    }
    if (!filePath) return;
    const bgsd = (window as any).bgsd;
    const result = await bgsd?.loadUndoRevision?.(filePath, revision.id);
    if (result?.ok) {
      previewRevision = revision;
      previewText = result.scadText || "";
      error = "";
    } else {
      error = result?.error || "Could not preview version";
    }
  }

  function closePreview() {
    previewRevision = null;
  }

  async function restoreRevision(revision: UndoRevision) {
    if (!filePath) return;
    const bgsd = (window as any).bgsd;
    const result = await bgsd?.loadUndoRevision?.(filePath, revision.id);
    if (result?.ok) {
      await onrestore({ data: result.data, revision: result.revision, scadText: result.scadText || "" });
      show = false;
    } else {
      error = result?.error || "Could not restore version";
    }
  }

  async function openRevisionInOpenScad(revision: UndoRevision) {
    if (!filePath) return;
    const bgsd = (window as any).bgsd;
    const result = await bgsd?.openUndoRevisionInOpenScad?.(filePath, revision.id);
    if (result?.ok) {
      error = "";
    } else {
      error = result?.detail || result?.error || "Could not open version in OpenSCAD";
    }
  }

  function startLabel(revision: UndoRevision) {
    editingId = revision.id;
    labelDraft = revision.label || "";
  }

  async function saveLabel(revision: UndoRevision) {
    if (!filePath) return;
    const bgsd = (window as any).bgsd;
    const result = await bgsd?.labelUndoRevision?.(filePath, revision.id, labelDraft);
    if (result?.ok) {
      revisions = result.revisions || [];
      editingId = null;
      labelDraft = "";
      error = "";
    } else {
      error = result?.error || "Could not label version";
    }
  }

  async function togglePin(revision: UndoRevision) {
    if (!filePath) return;
    const bgsd = (window as any).bgsd;
    const result = await bgsd?.pinUndoRevision?.(filePath, revision.id, !revision.pinned);
    if (result?.ok) {
      revisions = result.revisions || [];
      error = "";
    } else {
      error = result?.error || "Could not update version pin";
    }
  }
</script>

{#if show}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="history-overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) show = false; }}>
    <div class="history-modal" data-testid="file-history-modal">
      <header class="history-header">
        <div>
          <h2 class="history-title">Version History</h2>
          <p class="history-path">{filePath || "No file open"}</p>
        </div>
        <button class="history-close" title="Close" onclick={() => show = false}>&times;</button>
      </header>

      {#if loading}
        <div class="history-empty">Loading version history...</div>
      {:else if error}
        <div class="history-error" data-testid="history-error">{error}</div>
      {:else if revisions.length === 0}
        <div class="history-empty" data-testid="history-empty">No saved version history yet.</div>
      {:else}
        <div class="history-list" data-testid="history-list">
          {#each revisions as revision (revision.id)}
            <div class="history-row" class:pinned={revision.pinned} class:previewing={previewRevision?.id === revision.id}
              class:subdued={!!previewRevision && previewRevision.id !== revision.id} data-testid="history-row" role="button" tabindex="0"
              onclick={() => previewRevisionText(revision)}
              onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); previewRevisionText(revision); } }}>
              <div class="history-main">
                <div class="history-line">
                  <span class="history-time">{formatDate(revision.timestamp)}</span>
                  <span class="history-id" title={revision.id}>{shortId(revision.id)}</span>
                  <span class="history-hash" title={revision.hash}>{revision.hashPrefix}</span>
                  {#if revision.isBase}<span class="history-badge">base</span>{/if}
                  {#if revision.pinned}<span class="history-pin">pinned</span>{/if}
                </div>
                <div class="history-summary">{revision.changeSummary}</div>
                {#if editingId === revision.id}
                  <div class="history-label-edit" role="presentation" onclick={(e) => e.stopPropagation()}>
                    <input class="history-label-input" data-testid="history-label-input" type="text" bind:value={labelDraft}
                      onkeydown={(e) => { if (e.key === "Enter") saveLabel(revision); if (e.key === "Escape") editingId = null; }} />
                    <button class="history-action primary" data-testid="history-label-save" onclick={() => saveLabel(revision)}>Save</button>
                    <button class="history-action" onclick={() => editingId = null}>Cancel</button>
                  </div>
                {:else if revision.label}
                  <div class="history-label">{revision.label}</div>
                {/if}
              </div>
              <div class="history-actions" role="presentation" onclick={(e) => e.stopPropagation()}>
                <button class="history-action" data-testid="history-preview-button" onclick={() => openRevisionInOpenScad(revision)}>OpenSCAD</button>
                <button class="history-action" data-testid="history-restore-button" onclick={() => restoreRevision(revision)}>Restore</button>
                <button class="history-action" data-testid="history-label-button" onclick={() => startLabel(revision)}>{revision.label ? "Rename" : "Label"}</button>
                <button class="history-action" data-testid="history-pin-button" class:active={revision.pinned} onclick={() => togglePin(revision)}>{revision.pinned ? "Unpin" : "Pin"}</button>
              </div>
            </div>
            {#if previewRevision?.id === revision.id}
              <section class="history-preview" data-testid="history-preview" transition:slide={{ duration: 170 }}>
                <div class="history-preview-head">
                  <span>Preview {shortId(previewRevision.id)} &middot; {previewRevision.hashPrefix}</span>
                  <button class="history-action" onclick={closePreview}>Close Preview</button>
                </div>
                <pre>{previewText}</pre>
              </section>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .history-overlay {
    position: fixed; inset: 0; z-index: 120;
    background: rgba(20, 30, 40, 0.42);
    display: flex; align-items: center; justify-content: center;
  }
  .history-modal {
    width: min(980px, calc(100vw - 40px));
    max-height: calc(100vh - 48px);
    display: flex; flex-direction: column;
    background: #ffffff; color: #1f2933;
    border-radius: 8px; box-shadow: 0 14px 42px rgba(0,0,0,0.28);
    overflow: hidden;
  }
  .history-header {
    display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;
    padding: 16px 18px 12px; border-bottom: 1px solid #d7e0e7;
    background: #f5f8fb;
  }
  .history-title { margin: 0 0 4px; font-size: 18px; color: #2c3e50; }
  .history-path {
    margin: 0; max-width: 760px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: "Courier New", monospace; font-size: 12px; color: #64748b;
  }
  .history-close {
    border: none; background: transparent; color: #667085; cursor: pointer;
    font-size: 24px; line-height: 1; padding: 0 4px;
  }
  .history-close:hover { color: #111827; }
  .history-list { overflow: auto; padding: 8px 0; }
  .history-row {
    display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 14px;
    padding: 9px 14px; border-bottom: 1px solid #eef2f5;
  }
  .history-row:hover,
  .history-row:focus-visible {
    background: #f6f9fc;
  }
  .history-row.pinned { background: #fff9e8; }
  .history-row.pinned:hover,
  .history-row.pinned:focus-visible {
    background: #fff5d7;
  }
  .history-row.previewing,
  .history-row.previewing.pinned {
    background: #eaf4fb;
    box-shadow: inset 3px 0 0 #2d5a7b;
  }
  .history-row.previewing:hover,
  .history-row.previewing:focus-visible {
    background: #e2f0f8;
  }
  .history-row.subdued {
    opacity: 0.45;
  }
  .history-row.subdued:hover,
  .history-row.subdued:focus-visible {
    opacity: 0.82;
  }
  .history-main { min-width: 0; }
  .history-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .history-time { font-weight: 600; color: #2c3e50; }
  .history-id, .history-hash {
    font-family: "Courier New", monospace; font-size: 12px;
    color: #64748b; background: #eef3f7; border-radius: 3px; padding: 1px 5px;
  }
  .history-badge, .history-pin {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    color: #51606f; border: 1px solid #d2dce4; border-radius: 3px; padding: 1px 5px;
  }
  .history-pin { color: #7a5700; border-color: #e2c46d; background: #fff2bd; }
  .history-summary { margin-top: 3px; color: #4b5563; font-size: 13px; }
  .history-label {
    display: inline-block; margin-top: 5px; max-width: 100%;
    color: #1f5d37; background: #e9f7ee; border: 1px solid #c9e8d4;
    border-radius: 4px; padding: 2px 7px; font-size: 12px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .history-label-edit { display: flex; align-items: center; gap: 6px; margin-top: 7px; }
  .history-label-input {
    width: min(360px, 100%); box-sizing: border-box;
    border: 1px solid #b8c7d3; border-radius: 4px; padding: 4px 6px;
    font-size: 13px;
  }
  .history-actions {
    display: flex; align-items: center; gap: 5px; flex-wrap: wrap; justify-content: flex-end;
    opacity: 0; visibility: hidden; pointer-events: none;
    transition: opacity 120ms ease, visibility 120ms ease;
  }
  .history-row:hover .history-actions,
  .history-row:focus-visible .history-actions {
    opacity: 1; visibility: visible; pointer-events: auto;
  }
  .history-action {
    border: 1px solid #b8c7d3; border-radius: 4px; background: #f7fafc; color: #2c3e50;
    cursor: pointer; font-size: 12px; padding: 4px 8px;
  }
  .history-action:hover { background: #ffffff; border-color: #7d93a7; }
  .history-action.primary, .history-action.active {
    background: #2d5a7b; color: white; border-color: #2d5a7b;
  }
  .history-empty, .history-error {
    padding: 28px 18px; color: #64748b; text-align: center;
  }
  .history-error { color: #b42318; background: #fff1f0; }
  .history-preview {
    border-top: 1px solid #d7e0e7; border-bottom: 1px solid #d7e0e7;
    background: #fbfcfd; max-height: 42vh;
    display: flex; flex-direction: column;
  }
  .history-preview-head {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 8px 12px; color: #475569; font-size: 12px; border-bottom: 1px solid #e5ebf0;
  }
  .history-preview pre {
    margin: 0; padding: 12px; overflow: auto;
    font-family: "Courier New", monospace; font-size: 12px; line-height: 1.45;
    color: #111827; background: #ffffff;
  }
</style>
