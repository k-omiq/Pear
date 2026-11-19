<script>
  // The confirm step of a font import (font-import.js): how the files were
  // sorted, which families that makes, and what did not fit. Nothing is
  // written until Import. Every file's family and slot can be changed here;
  // picking another sort starts the rows again from that rule.
  import { planImport, finishPlan, editRow, renamePlanFamily, sortModesFor, planWrites } from './font-import.js';
  import { FACE_SLOTS, SLOT_LABEL } from './fonts.js';

  let { items, unreadable = [], ctx, onconfirm, oncancel } = $props();

  const modes = $derived(sortModesFor(items));
  let mode = $state('names');
  // The rows start from the first rule; the sheet is made fresh for each import.
  const firstRows = () => planImport(items, 'names', ctx).rows;
  let rows = $state(firstRows());
  let edited = $state(false);
  const plan = $derived(finishPlan({ mode, rows }, ctx));
  const writes = $derived(planWrites(plan));
  const familyNames = $derived([...new Set([...plan.families.map((f) => f.name), ...ctx.existing.map((f) => f.name)])]);

  function pickMode(id) {
    if (id === mode) return;
    mode = id;
    rows = planImport(items, id, ctx).rows;
    edited = false;
  }
  function setSlot(id, slot) {
    rows = editRow(rows, id, { slot: slot || null });
    edited = true;
  }
  function setFamily(id, family) {
    const name = family.trim();
    if (!name) return;
    rows = editRow(rows, id, { family: name });
    edited = true;
  }
  function renameFamily(from, to) {
    if (!to.trim() || to.trim() === from) return;
    rows = renamePlanFamily(rows, from, to);
    edited = true;
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      oncancel();
    }
  }
  function focusOnMount(node) {
    node.focus();
  }
  const where = (r) => (r.dir ? `${r.dir}/` : '');
</script>

{#snippet fileRow(r)}
  <div class="is-row" class:clash={r.clash} class:out={!r.slot}>
    <div class="is-file">
      <span class="is-name" title="{where(r)}{r.name}">{r.name}</span>
      <span class="is-style">{r.style || 'style unknown'}{#if r.dir} · {r.dir}{/if}</span>
      {#if r.clash}
        <span class="is-note warn">Two files for {SLOT_LABEL[r.slot]} in this family - move one or leave it out</span>
      {:else if r.note}
        <span class="is-note">{r.note}</span>
      {/if}
    </div>
    <input
      class="is-input"
      list="is-families"
      aria-label="Family for {r.name}"
      value={r.family}
      onchange={(e) => setFamily(r.id, e.currentTarget.value)}
    />
    <select class="is-select" aria-label="Face for {r.name}" value={r.slot || ''} onchange={(e) => setSlot(r.id, e.currentTarget.value)}>
      {#each FACE_SLOTS as s (s)}
        <option value={s}>{SLOT_LABEL[s]}</option>
      {/each}
      <option value="">Leave out</option>
    </select>
  </div>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_click_events_have_key_events -->
<div class="modal-overlay open" role="presentation" onkeydown={onKey} onclick={(e) => e.target === e.currentTarget && oncancel()}>
  <div class="modal is-sheet" role="dialog" aria-modal="true" aria-labelledby="is-title" tabindex="-1" use:focusOnMount>
    <div class="modal-head">
      <h3 id="is-title">Sort {items.length} {items.length === 1 ? 'file' : 'files'}</h3>
    </div>
    <div class="modal-body">
      <fieldset class="is-modes">
        <legend>Sort them</legend>
        {#each modes as m (m.id)}
          <label class="is-mode" class:on={mode === m.id}>
            <input type="radio" name="is-mode" value={m.id} checked={mode === m.id} onchange={() => pickMode(m.id)} />
            <span>
              <span class="is-mode-label">{m.label}</span>
              <span class="is-mode-note">{m.note}</span>
            </span>
          </label>
        {/each}
        {#if edited}<p class="is-hint">Picking another way starts the list again from it, without your changes.</p>{/if}
      </fieldset>

      <datalist id="is-families">
        {#each familyNames as n (n)}<option value={n}></option>{/each}
      </datalist>

      <div class="is-head">
        {plan.families.length} {plan.families.length === 1 ? 'family' : 'families'} · {plan.faces} {plan.faces === 1 ? 'face' : 'faces'}{plan.leftOut.length ? ` · ${plan.leftOut.length} left out` : ''}
      </div>

      {#each plan.families as fam (fam.name)}
        {@const placed = fam.rows.filter((r) => r.slot)}
        {#if placed.length}
          <section class="is-fam">
            <div class="is-fam-head">
              <input
                class="is-fam-name"
                aria-label="Family name"
                value={fam.name}
                onchange={(e) => renameFamily(fam.name, e.currentTarget.value)}
              />
              {#if fam.builtin}
                <span class="set-badge warn">a built-in has this name - rename it to import it</span>
              {:else if fam.existing}
                <span class="set-badge">adds to your font</span>
              {/if}
              {#each Object.entries(fam.replaces) as [slot, file] (slot)}
                <span class="set-badge warn" title="Replaces {file}">replaces {SLOT_LABEL[slot]}</span>
              {/each}
            </div>
            {#each placed as r (r.id)}{@render fileRow(r)}{/each}
          </section>
        {/if}
      {/each}

      {#if plan.leftOut.length}
        <section class="is-fam">
          <div class="is-fam-head"><span class="is-out-title">Left out</span><span class="is-mode-note">Pick a face to put one back.</span></div>
          {#each plan.leftOut as r (r.id)}{@render fileRow(r)}{/each}
        </section>
      {/if}

      {#if unreadable.length}
        <section class="is-fam">
          <div class="is-fam-head"><span class="is-out-title">Not fonts</span></div>
          {#each unreadable as u (u.id)}
            <div class="is-row out"><div class="is-file"><span class="is-name">{u.name}</span><span class="is-style">{u.unreadable}</span></div></div>
          {/each}
        </section>
      {/if}
    </div>
    <div class="is-foot">
      <span class="is-sum">{#if !plan.ok}Two files share a face - fix the rows marked in rust{:else if plan.blocked.length}Left out until renamed: {plan.blocked.join(', ')} (a built-in has the name){:else}Nothing is saved until you import{/if}</span>
      <button class="soft-btn" onclick={oncancel}>Cancel</button>
      <button class="btn btn-accent" disabled={!plan.ok || !writes.length} onclick={() => onconfirm(plan)}>Import {writes.length} {writes.length === 1 ? 'face' : 'faces'}</button>
    </div>
  </div>
</div>

<style>
  .is-sheet {
    width: min(820px, calc(100vw - 48px));
    max-height: min(820px, calc(100vh - 48px));
    display: flex;
    flex-direction: column;
  }
  .is-modes {
    margin: 0 0 14px;
    padding: 0;
    border: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .is-modes legend {
    margin-bottom: 6px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text);
  }
  .is-mode {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 7px 10px;
    border-radius: 6px;
    cursor: pointer;
  }
  .is-mode:hover,
  .is-mode.on {
    background: var(--accent-soft);
  }
  .is-mode input {
    margin: 2px 0 0;
    accent-color: var(--accent);
  }
  .is-mode > span {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .is-mode-label {
    font-size: 12.5px;
    color: var(--text);
  }
  .is-mode-note,
  .is-hint {
    font-size: 11.5px;
    color: var(--t2);
    line-height: 1.45;
  }
  .is-hint {
    margin: 4px 10px 0;
  }
  .is-head {
    margin: 6px 0 4px;
    font-size: 11.5px;
    color: var(--t2);
  }
  .is-fam {
    padding: 10px 0 6px;
    border-top: 1px solid var(--line);
  }
  .is-fam-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 4px;
  }
  .is-fam-name,
  .is-input,
  .is-select {
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    font-size: 12px;
    min-width: 0;
  }
  .is-fam-name {
    flex: 0 1 300px;
    font-size: 12.5px;
    font-weight: 600;
  }
  .is-fam-name:focus,
  .is-input:focus,
  .is-select:focus {
    outline: none;
    border-color: var(--accent);
  }
  .is-out-title {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text);
  }
  .is-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 0 5px 12px;
  }
  .is-row.out .is-name {
    color: var(--t2);
  }
  .is-row.clash {
    box-shadow: inset 2px 0 0 var(--warn);
  }
  .is-file {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .is-name {
    font-size: 12px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .is-style,
  .is-note {
    font-size: 11px;
    color: var(--t2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .is-note.warn {
    color: var(--warn);
  }
  .is-input {
    flex: 0 0 200px;
  }
  .is-select {
    flex: 0 0 116px;
  }
  .is-foot {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--line);
  }
  .is-foot .soft-btn {
    height: 30px;
  }
  .is-sum {
    margin-right: auto;
    font-size: 11.5px;
    color: var(--t2);
  }
</style>
