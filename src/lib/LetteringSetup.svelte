<script>
  // Settings ▸ Project ▸ Lettering: the series' lettering style (lettering.js)
  // as a form - the same questions the AI asks before its first run, answered
  // here instead, or changed after it asked. A role's font is its tag's font
  // and a character's font is their voice tag's (lettering-fonts.js), so what
  // is picked here is what new boxes of that kind are placed in, by hand or by
  // the AI. Freedom and notes are kept in the series guide.
  import { guide, setLettering } from './guide.svelte.js';
  import { LETTERING_ROLES, FREEDOMS, FREEDOM_TEXT, letteringSetUp } from './lettering.js';
  import { tagFont, setTagFont, setVoiceFont } from './lettering-fonts.js';
  import { fontGroups, fontCaveat } from './font-menu.js';

  let { scope } = $props();

  const setUp = $derived(letteringSetUp(guide.lettering));
  const characters = $derived(guide.glossary.filter((t) => t.character));
  const FREEDOM_LABEL = { strict: 'Strict', balanced: 'Balanced', free: 'Free' };
</script>

{#snippet fontSelect(value, label, onpick)}
  <select class="qtf-input" aria-label={label} value={value ?? ''} onchange={(e) => onpick(e.currentTarget.value || null)}>
    <option value="">-</option>
    {#if value && fontCaveat(value)}<option {value}>{value} ({fontCaveat(value)})</option>{/if}
    {#each fontGroups() as g (g.key)}
      <optgroup label={g.label}>
        {#each g.fonts as f (f.name)}<option value={f.name}>{f.name}</option>{/each}
      </optgroup>
    {/each}
  </select>
{/snippet}

<div class="settings-section">
  <div class="settings-title">LETTERING{@render scope('series')}</div>
  <div class="qhint lt-lead">
    {#if setUp}
      How this series is lettered. New boxes of each kind start in its font; the
      AI letters to it. Change anything here, or tell the AI.
    {:else}
      Not set up yet. The AI asks these questions before it letters this series.
      You can answer them here instead.
    {/if}
  </div>

  <div class="lt-grid">
    {#each LETTERING_ROLES as r (r.tag)}
      <div class="lt-name">
        <span>{r.label}</span>
        <span class="lt-hint">{r.hint}</span>
      </div>
      {@render fontSelect(tagFont(r.tag), `${r.label} font`, (font) => setTagFont(r.tag, font))}
    {/each}
  </div>

  {#if characters.length}
    <div class="lt-sub">Character voices</div>
    <div class="qhint lt-lead">A character with a font speaks in it. Lines get a speaker in the Text Queue.</div>
    <div class="lt-grid">
      {#each characters as t (t.id)}
        <div class="lt-name"><span>{t.target || t.source}</span></div>
        {@render fontSelect(tagFont(t.tag), `${t.target || t.source} font`, (font) => setVoiceFont(t, font))}
      {/each}
    </div>
  {/if}

  <div class="lt-sub">AI freedom</div>
  <div class="field">
    <span>Freedom</span>
    <div class="seg" role="group" aria-label="AI freedom">
      {#each FREEDOMS as v (v)}
        <button class:on={guide.lettering.freedom === v} onclick={() => setLettering({ freedom: v })}>{FREEDOM_LABEL[v]}</button>
      {/each}
    </div>
  </div>
  <div class="qhint">
    {guide.lettering.freedom ? FREEDOM_TEXT[guide.lettering.freedom] : 'Pick one. Until you do, the AI asks before it letters.'}
    {#if setUp}<button class="lt-again" onclick={() => setLettering({ freedom: null })}>Ask me again</button>{/if}
  </div>

  <textarea
    class="qtf-input lt-notes"
    rows="3"
    placeholder="Anything else about the look: “inner thoughts in italic narration”, “SFX keep the art’s colour”…"
    aria-label="Lettering notes"
    value={guide.lettering.notes}
    onchange={(e) => setLettering({ notes: e.currentTarget.value })}
  ></textarea>
</div>

<style>
  .settings-title {
    display: flex;
    align-items: center;
  }
  .lt-lead {
    margin: 0 0 10px;
  }
  .lt-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
    gap: 6px 10px;
    align-items: center;
  }
  .lt-name {
    display: flex;
    flex-direction: column;
    min-width: 0;
    font-size: 12px;
  }
  .lt-hint {
    font-size: 11px;
    color: var(--t3, var(--t2));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lt-grid select.qtf-input {
    min-width: 0;
    width: 100%;
    height: 26px;
    font-size: 12px;
  }
  .lt-sub {
    margin: 14px 0 6px;
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--t3, var(--t2));
  }
  .lt-again {
    margin-left: 6px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--acc, inherit);
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
  .lt-notes {
    width: 100%;
    box-sizing: border-box;
    margin-top: 10px;
    resize: vertical;
    padding: 6px 8px;
    font-size: 12px;
    line-height: 1.45;
  }
</style>
