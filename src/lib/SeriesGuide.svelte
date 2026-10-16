<script>
  // The series guide's sections in Settings ▸ Project: the glossary, and (as
  // the guide grows) the text rules and the free notes. Everything here is in
  // project.json under `guide` (guide.svelte.js), so it travels with the
  // series and applies to every chapter in it. `scope` is the modal's own
  // chip snippet, handed down so the chips match the sections around these.
  import { guide, addTerm, updateTerm, removeTerm, setGuideRule, setGuideNotes } from './guide.svelte.js';
  import { knownTags } from './tags.svelte.js';
  import { app } from './store.svelte.js';

  let { scope } = $props();

  // Characters (TXT-6) are glossary terms marked `character`: their names are
  // checked like any term, and a line's speaker points at one by id. Listed
  // apart so each list says what it is for.
  const terms = $derived(guide.glossary.filter((t) => !t.character));
  const characters = $derived(guide.glossary.filter((t) => t.character));
  const tagNames = $derived(knownTags(app.pages).map((t) => t.name));
  let newName = $state('');
  let newNameSource = $state('');
  let nameEl = $state(null);

  function addCharacter() {
    if (!newName.trim()) return;
    addTerm({ source: newNameSource, target: newName, character: true });
    newName = '';
    newNameSource = '';
    nameEl?.focus();
  }

  // ---------- glossary ----------
  // Each field commits on change (blur or Enter), not per keystroke: one
  // project.json write per edit, and a half-typed name is never checked.
  let newSource = $state('');
  let newTarget = $state('');
  let filter = $state('');
  let sourceEl = $state(null);

  const shown = $derived.by(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return terms;
    return terms.filter((t) =>
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

<!-- TXT-3. Checked in the check list; Keep checks nothing. A font that has
     no glyph for the chosen form is named by the queue's font notice. -->
<div class="settings-section">
  <div class="settings-title">TEXT RULES{@render scope('series')}</div>
  <div class="field">
    <span>Dashes</span>
    <div class="seg" role="group" aria-label="Dashes">
      {#each [['keep', 'Keep'], ['ascii', 'No long dash (-)'], ['em', 'Em dash (—)']] as [v, label]}
        <button class:on={guide.rules.dashes === v} onclick={() => setGuideRule('dashes', v)}>{label}</button>
      {/each}
    </div>
  </div>
  <div class="field">
    <span>Ellipsis</span>
    <div class="seg" role="group" aria-label="Ellipsis">
      {#each [['keep', 'Keep'], ['dots', 'Three dots (...)'], ['char', 'One glyph (…)']] as [v, label]}
        <button class:on={guide.rules.ellipsis === v} onclick={() => setGuideRule('ellipsis', v)}>{label}</button>
      {/each}
    </div>
  </div>
  <div class="qhint">
    A line that breaks a rule is listed in the check list. Keep checks
    nothing. Spaced dots (<code>. . .</code>) count as breaking either
    ellipsis rule.
  </div>
</div>

<div class="settings-section">
  <div class="settings-title">GLOSSARY{@render scope('series')}</div>
  <div class="qhint sg-lead">
    Words this series always translates one way. A line whose source has a
    term and whose English does not is listed in the check list. Other
    spellings are other ways the source may write it.
  </div>
  {#if terms.length > 8}
    <input class="qtf-input sg-filter" placeholder="Find a term…" aria-label="Find a term" bind:value={filter} />
  {/if}
  {#if terms.length}
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
    <div class="qhint sg-empty">{terms.length ? 'No term matches.' : 'No terms yet.'}</div>
  {/each}
  <div class="sg-row sg-add">
    <input class="qtf-input" placeholder="Source…" aria-label="New term source" bind:this={sourceEl} bind:value={newSource} onkeydown={(e) => e.key === 'Enter' && add()} />
    <input class="qtf-input" placeholder="English…" aria-label="New term English" bind:value={newTarget} onkeydown={(e) => e.key === 'Enter' && add()} />
    <button class="btn tiny" disabled={!newSource.trim() || !newTarget.trim()} onclick={add}>Add</button>
  </div>
</div>

<div class="settings-section">
  <div class="settings-title">CHARACTERS{@render scope('series')}</div>
  <div class="qhint sg-lead">
    Who speaks a line, picked in the Text Queue. A name is checked like a
    glossary term. A character with a tag gives their boxes that tag's
    style when they are placed.
  </div>
  {#if characters.length}
    <div class="sg-head sg-chars" aria-hidden="true">
      <span>Name</span><span>Source</span><span>Tag</span><span>Note</span><span></span>
    </div>
  {/if}
  {#each characters as t (t.id)}
    <div class="sg-row sg-chars">
      <input class="qtf-input" aria-label="Name" value={t.target} onchange={(e) => updateTerm(t.id, { target: e.currentTarget.value })} />
      <input class="qtf-input" aria-label="Source name" placeholder="-" value={t.source} onchange={(e) => updateTerm(t.id, { source: e.currentTarget.value })} />
      <select class="qtf-input" aria-label="Tag" value={t.tag ?? ''} onchange={(e) => updateTerm(t.id, { tag: e.currentTarget.value || null })}>
        <option value="">-</option>
        {#if t.tag && !tagNames.includes(t.tag)}<option value={t.tag}>{t.tag}</option>{/if}
        {#each tagNames as n (n)}<option value={n}>{n}</option>{/each}
      </select>
      <input class="qtf-input" aria-label="Note" placeholder="-" value={t.note} onchange={(e) => updateTerm(t.id, { note: e.currentTarget.value })} />
      <button class="btn tiny sg-del" title="Remove this character" aria-label="Remove {t.target}" onclick={() => removeTerm(t.id)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  {:else}
    <div class="qhint sg-empty">No characters yet.</div>
  {/each}
  <div class="sg-row sg-add">
    <input class="qtf-input" placeholder="Name…" aria-label="New character name" bind:this={nameEl} bind:value={newName} onkeydown={(e) => e.key === 'Enter' && addCharacter()} />
    <input class="qtf-input" placeholder="Source name…" aria-label="New character source name" bind:value={newNameSource} onkeydown={(e) => e.key === 'Enter' && addCharacter()} />
    <button class="btn tiny" disabled={!newName.trim()} onclick={addCharacter}>Add</button>
  </div>
</div>

<!-- Free notes (AI_TYPESETTING_PLAN.md section 4): what no rule can hold.
     Saved when the field is left. -->
<div class="settings-section">
  <div class="settings-title">NOTES{@render scope('series')}</div>
  <textarea
    class="qtf-input sg-notes"
    rows="4"
    placeholder="Anything about this series a rule cannot say: “screams tilt with the balloon”, “Tomoe never uses contractions”…"
    aria-label="Series notes"
    value={guide.notes}
    onchange={(e) => setGuideNotes(e.currentTarget.value)}
  ></textarea>
</div>

<style>
  /* The modal lays its own headings out this way; its rule is scoped to it. */
  .settings-title {
    display: flex;
    align-items: center;
  }
  .btn.tiny {
    padding: 4px 10px;
    font-size: 12px;
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
  .sg-row select.qtf-input {
    height: 26px;
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
  .sg-notes {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    padding: 6px 8px;
    font-size: 12px;
    line-height: 1.45;
  }
  .sg-empty {
    padding: 4px 0;
  }
</style>
