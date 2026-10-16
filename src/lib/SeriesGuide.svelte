<script>
  // The series guide's sections in Settings ▸ Project: the glossary, and (as
  // the guide grows) the text rules and the free notes. Everything here is in
  // project.json under `guide` (guide.svelte.js), so it travels with the
  // series and applies to every chapter in it. `scope` is the modal's own
  // chip snippet, handed down so the chips match the sections around these.
  import { guide, addTerm, updateTerm, removeTerm } from './guide.svelte.js';

  let { scope } = $props();

  // ---------- glossary ----------
  // Each field commits on change (blur or Enter), not per keystroke: one
  // project.json write per edit, and a half-typed name is never checked.
  let newSource = $state('');
  let newTarget = $state('');
  let filter = $state('');
  let sourceEl = $state(null);

  const shown = $derived.by(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return guide.glossary;
    return guide.glossary.filter((t) =>
      [t.source, t.target, t.note, ...(t.aliases ?? [])].some((v) => String(v ?? '').toLowerCase().includes(f)),
    );
  });

  function add() {
    if (!newSource.trim() || !newTarget.trim()) return;
    addTerm({ source: newSource, target: newTarget });
    newSource = '';
    newTarget = '';
    sourceEl?.focus();
  }

  const aliasText = (t) => (t.aliases ?? []).join(', ');
  const aliasList = (v) => v.split(/[,、]/).map((s) => s.trim()).filter(Boolean);
</script>

<div class="settings-section">
  <div class="settings-title">GLOSSARY{@render scope('series')}</div>
  <div class="qhint sg-lead">
    Words this series always translates one way. A line whose source has a
    term and whose English does not is listed in the check list. Other
    spellings are other ways the source may write it.
  </div>
  {#if guide.glossary.length > 8}
    <input class="qtf-input sg-filter" placeholder="Find a term…" aria-label="Find a term" bind:value={filter} />
  {/if}
  {#if guide.glossary.length}
    <div class="sg-head" aria-hidden="true">
      <span>Source</span><span>English</span><span>Other spellings</span><span>Note</span><span></span>
    </div>
  {/if}
  {#each shown as t (t.id)}
    <div class="sg-row">
      <input class="qtf-input" aria-label="Source" value={t.source} onchange={(e) => updateTerm(t.id, { source: e.currentTarget.value })} />
      <input class="qtf-input" aria-label="English" value={t.target} onchange={(e) => updateTerm(t.id, { target: e.currentTarget.value })} />
      <input class="qtf-input" aria-label="Other spellings" placeholder="-" value={aliasText(t)} onchange={(e) => updateTerm(t.id, { aliases: aliasList(e.currentTarget.value) })} />
      <input class="qtf-input" aria-label="Note" placeholder="-" value={t.note} onchange={(e) => updateTerm(t.id, { note: e.currentTarget.value })} />
      <button class="btn tiny sg-del" title="Remove this term" aria-label="Remove {t.target || t.source}" onclick={() => removeTerm(t.id)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  {:else}
    <div class="qhint sg-empty">{guide.glossary.length ? 'No term matches.' : 'No terms yet.'}</div>
  {/each}
  <div class="sg-row sg-add">
    <input class="qtf-input" placeholder="Source…" aria-label="New term source" bind:this={sourceEl} bind:value={newSource} onkeydown={(e) => e.key === 'Enter' && add()} />
    <input class="qtf-input" placeholder="English…" aria-label="New term English" bind:value={newTarget} onkeydown={(e) => e.key === 'Enter' && add()} />
    <button class="btn tiny" disabled={!newSource.trim() || !newTarget.trim()} onclick={add}>Add</button>
  </div>
</div>

<style>
  /* The modal lays its own headings out this way; its rule is scoped to it. */
  .settings-title {
    display: flex;
    align-items: center;
  }
  .sg-lead {
    margin: 0 0 10px;
  }
  .sg-filter {
    width: 100%;
    max-width: 260px;
    margin-bottom: 8px;
    padding: 5px 8px;
    font-size: 12px;
  }
  .sg-head,
  .sg-row {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr 1.2fr 26px;
    gap: 6px;
    align-items: center;
  }
  .sg-head {
    padding: 0 0 4px;
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--t3, var(--t2));
  }
  .sg-row {
    padding: 3px 0;
  }
  .sg-row .qtf-input {
    min-width: 0;
    width: 100%;
    padding: 4px 7px;
    font-size: 12px;
  }
  .sg-add {
    grid-template-columns: 1fr 1fr auto;
    margin-top: 8px;
  }
  .sg-del {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    padding: 0;
  }
  .sg-del svg {
    width: 12px;
    height: 12px;
  }
  .sg-empty {
    padding: 4px 0;
  }
</style>
