<script>
  // The match screen (SHARED_DATA_FOLDER.md section 8.4.3): one row per
  // cleaner title waiting, the title here it belongs to (best candidate
  // first, then "New title in Pear", then "Skip"), and under each row its
  // chapters with what will happen to each. A title here goes to one row
  // only. The 3-second check is paused while this is open (handoff.svelte.js);
  // Apply files everything in the same single flight.
  import {
    handoffMatch,
    closeMatch,
    rowOptions,
    chapterTarget,
    pairingFor,
    applyMatch,
  } from '../handoff.svelte.js';
  import { pairingLine } from '../handoff-match.js';
  import { chapterOpenAnywhere } from '../library.svelte.js';
  import { dataFolder } from '../data-folder.svelte.js';
  import { captureFocus } from '../focus.js';

  const rows = $derived(handoffMatch.rows);

  // Row id -> project id | 'new' | 'skip'. The best candidate first, a fixed
  // project when the row waits on a number clash, else a new title.
  let choices = $state({});
  // Message key -> chapter action, once the user picks one.
  let actions = $state({});
  // `${key}|${chapterId}` -> pairing, read off the disk.
  let pairings = $state({});
  // Chapter id -> open in this window or another.
  let open = $state({});
  let busy = $state(false);

  $effect(() => {
    const next = {};
    for (const r of rows) next[r.id] = choices[r.id] ?? r.fixed ?? r.candidates[0] ?? 'new';
    // One title here per row: a later row that would take one already taken
    // falls back to its next option.
    const taken = new Set();
    for (const r of rows) {
      const c = next[r.id];
      if (c !== 'new' && c !== 'skip' && taken.has(c) && !r.fixed) next[r.id] = r.candidates.find((id) => !taken.has(id)) ?? 'new';
      if (next[r.id] !== 'new' && next[r.id] !== 'skip') taken.add(next[r.id]);
    }
    if (JSON.stringify(next) !== JSON.stringify(choices)) choices = next;
  });

  const takenBy = (rowId) => new Set(rows.filter((r) => r.id !== rowId).map((r) => choices[r.id]).filter((c) => c && c !== 'new' && c !== 'skip'));

  // What each chapter would link to, for the row's choice, and its pairing.
  const targets = $derived(
    Object.fromEntries(rows.flatMap((r) => r.messages.map((m) => [m.key, chapterTarget(r, choices[r.id] ?? 'new', m)]))),
  );
  $effect(() => {
    for (const r of rows) {
      const choice = choices[r.id];
      for (const m of r.messages) {
        const t = targets[m.key];
        if (t?.action !== 'link') continue;
        const id = `${m.key}|${t.chapter.id}`;
        if (pairings[id] !== undefined) continue;
        pairings[id] = null;
        pairingFor(dataFolder.root, m.key, m, t.chapter, choice)
          .then((p) => {
            pairings[id] = p;
          })
          .catch((e) => {
            pairings[id] = { ok: false, why: `The pages could not be read: ${e?.message ?? e}` };
          });
        chapterOpenAnywhere(t.chapter.id).then((v) => {
          open[t.chapter.id] = v;
        });
      }
    }
  });

  const label = (m) => m.title || (m.label ? `Chapter ${m.label}` : m.number != null ? `Chapter ${m.number}` : 'A chapter');

  // The choices one chapter has, and the one in force. Section 8.4.3: no
  // default ever adds a chapter beside one Pear has. A chapter that may link
  // has no choice until its pages are read ("Checking pages…", Apply off);
  // one whose pages do not pair keeps waiting unless the user says otherwise.
  function chapterChoice(r, m) {
    const t = targets[m.key];
    if (!t || t.action === 'skip') return { options: [], value: 'skip' };
    if (t.action === 'new') {
      const options = [
        ['new', 'New chapter'],
        ['skip', 'Skip this chapter'],
      ];
      return { options, value: actions[m.key] ?? 'new' };
    }
    const pairing = pairings[`${m.key}|${t.chapter.id}`];
    if (!pairing) return { options: [], value: null, checking: true, chapter: t.chapter };
    const options = pairing.ok
      ? [
          ['link', "Already in Pear: link, keep Pear's pages"],
          ['replace', "Replace Pear's cleaned pages"],
          ['separate', 'Add as a separate chapter'],
          ['skip', 'Skip this chapter'],
        ]
      : [
          ['wait', 'Keep waiting'],
          ['separate', 'Add as a separate chapter'],
          ['skip', 'Skip this chapter'],
        ];
    let value = actions[m.key] ?? options[0][0];
    if (!options.some(([v]) => v === value)) value = options[0][0];
    return { options, value, pairing, chapter: t.chapter, closeFirst: open[t.chapter.id] && (value === 'link' || value === 'replace') };
  }

  // Apply waits for every pairing a line may link by.
  const checking = $derived(rows.some((r) => choices[r.id] !== 'skip' && r.messages.some((m) => chapterChoice(r, m).checking)));

  async function apply() {
    busy = true;
    try {
      const plan = rows.map((r) => ({
        rowId: r.id,
        choice: choices[r.id],
        chapters: Object.fromEntries(r.messages.map((m) => [m.key, chapterChoice(r, m).value])),
      }));
      await applyMatch(dataFolder.root, plan);
      closeMatch();
    } finally {
      busy = false;
    }
  }

  let box = $state(null);
  $effect(() => {
    if (box) return captureFocus();
  });
  function onkeydown(e) {
    if (e.key === 'Escape' && !busy) {
      e.preventDefault();
      e.stopPropagation();
      closeMatch();
    }
  }
</script>

<div class="modal-overlay open" role="presentation">
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div bind:this={box} class="modal match" role="dialog" aria-modal="true" aria-labelledby="match-title" tabindex="-1" {onkeydown}>
    <div class="modal-head" id="match-title">Match titles from Manga Cleaner</div>
    <div class="match-rows">
      {#each rows as r (r.id)}
        {@const opts = rowOptions(r, takenBy(r.id))}
        <div class="match-row" data-testid="match-row">
          <div class="row-head">
            <div class="row-left">
              <strong>{r.name}</strong>
              <span>{r.messages.length} chapter{r.messages.length === 1 ? '' : 's'} wait{r.messages.length === 1 ? 's' : ''}</span>
            </div>
            <select
              aria-label="Title in Pear for {r.name}"
              disabled={busy || opts.length === 1}
              value={choices[r.id]}
              onchange={(e) => (choices = { ...choices, [r.id]: e.currentTarget.value })}
            >
              {#each opts as o (o.value)}
                <option value={o.value}>{o.label}</option>
              {/each}
            </select>
          </div>
          {#if choices[r.id] !== 'skip'}
            <details class="row-chapters">
              <summary>Chapters</summary>
              {#each r.messages as m (m.key)}
                {@const ch = chapterChoice(r, m)}
                <div class="ch" data-testid="match-chapter">
                  <span class="ch-name">{label(m)}</span>
                  {#if ch.checking}
                    <span class="ch-note" data-testid="checking">Checking pages…</span>
                  {:else}
                    <select
                      aria-label="What happens to {label(m)}"
                      disabled={busy}
                      value={ch.value}
                      onchange={(e) => (actions = { ...actions, [m.key]: e.currentTarget.value })}
                    >
                      {#each ch.options as [v, text] (v)}
                        <option value={v}>{text}</option>
                      {/each}
                    </select>
                  {/if}
                  {#if ch.closeFirst}
                    <span class="ch-note">Close {label(m)} first</span>
                  {:else if ch.pairing}
                    <span class="ch-note">{pairingLine(ch.pairing)}</span>
                    {#if ch.pairing.ok && ch.pairing.thumbs?.length}
                      <div class="thumbs">
                        {#each ch.pairing.thumbs as t (t.index)}
                          <span class="pair" title="Page {t.index + 1}">
                            {#if t.cleaner}<img src={t.cleaner} alt="Manga Cleaner page {t.index + 1}" crossorigin="anonymous" />{/if}
                            {#if t.pear}<img src={t.pear} alt="Pear page {t.index + 1}" crossorigin="anonymous" />{/if}
                          </span>
                        {/each}
                      </div>
                    {/if}
                  {/if}
                </div>
              {/each}
            </details>
          {/if}
        </div>
      {/each}
    </div>
    <div class="modal-foot">
      <button class="soft-btn" disabled={busy} onclick={closeMatch}>Later</button>
      <button class="accent-btn narrow" disabled={busy || checking || !rows.length} title={checking ? 'Checking pages…' : undefined} onclick={apply}>{busy ? 'Applying…' : 'Apply'}</button>
    </div>
  </div>
</div>

<style>
  .match {
    width: 600px;
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 64px);
    display: flex;
    flex-direction: column;
  }
  .match:focus {
    outline: none;
  }
  .match-rows {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    border-top: 1px solid var(--line);
  }
  .match-row {
    padding: 10px 0;
    border-bottom: 1px solid var(--line);
  }
  .row-head {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .row-left {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12.5px;
    color: var(--t2);
  }
  .row-left strong {
    color: var(--text);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  select {
    max-width: 260px;
    font-size: 12px;
  }
  .row-chapters {
    margin-top: 6px;
    font-size: 12px;
    color: var(--t2);
  }
  .row-chapters summary {
    cursor: pointer;
    color: var(--t2);
  }
  .ch {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 6px 0 6px 14px;
  }
  .ch-name {
    min-width: 110px;
    color: var(--text);
  }
  .ch-note {
    flex-basis: 100%;
    padding-left: 118px;
    color: var(--t3);
  }
  .thumbs {
    flex-basis: 100%;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding-left: 118px;
  }
  .pair {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--line2);
    border-radius: 4px;
  }
  .pair img {
    width: 36px;
    height: 52px;
    object-fit: cover;
    background: var(--surface);
  }
</style>
