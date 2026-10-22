<script>
  // Settings ▸ Project ▸ Text styles: every look a box can start with, in one
  // list. Each kind of text (lettering.js `LETTERING_ROLES`) is a row with its
  // font. The user's own tags sit under the kind they belong to (a tag's
  // `kind`, tags.svelte.js): a style of that kind, laid over its look. The
  // characters' voices sit under Speech, the kind they speak in. Tags under no
  // kind are listed last. On a line the most particular wins - the user's
  // tag, then a character's voice, then the kind (store.svelte.js
  // `withStyleOrder`) - so what is picked here is what a box is placed in, by
  // hand or by the AI.
  import { app } from './store.svelte.js';
  import { guide } from './guide.svelte.js';
  import { LETTERING_ROLES, ROLE_TAGS } from './lettering.js';
  import { tagFont, setTagFont, setVoiceFont } from './lettering-fonts.js';
  import { knownTags, findTag, saveTagDefaults, tagFormFields, tagFormDefaults, normalizeTagName, MAX_TAG_LEN } from './tags.svelte.js';
  import FontPicker from './FontPicker.svelte';
  import TagDefaultsForm from './TagDefaultsForm.svelte';

  const all = $derived(knownTags(app.pages));
  const characters = $derived(guide.glossary.filter((t) => t.character));
  const voiceTags = $derived(new Set(characters.map((t) => t.tag).filter(Boolean)));
  // The user's own tags: not a kind of text, not a character's voice.
  const own = $derived(all.filter((t) => !ROLE_TAGS.includes(t.name) && !voiceTags.has(t.name)));
  const under = (kind) => own.filter((t) => t.kind === kind);
  const loose = $derived(own.filter((t) => !t.kind));
  const labelOf = (kind) => LETTERING_ROLES.find((r) => r.tag === kind)?.label ?? kind;

  // One row's full form open at a time: the queue's own (TagDefaultsForm),
  // plus, for a user's tag, the kind it sits under.
  let form = $state(null);
  function openForm(name) {
    const mine = !ROLE_TAGS.includes(name) && !voiceTags.has(name);
    form = { name, mine, edit: mine, tools: true, confirmDelete: false, ...tagFormFields(findTag(name)) };
    if (!mine) delete form.kind;
  }
  const toggle = (name) => (form?.name === name ? (form = null) : openForm(name));
  function save() {
    if (!form) return;
    saveTagDefaults(form.name, tagFormDefaults(form));
    form = null;
  }

  // A new style: a name and the kind it sits under; its form opens for the rest.
  let newName = $state('');
  let newKind = $state('speech');
  function add() {
    const name = normalizeTagName(newName);
    if (!name) return;
    if (!ROLE_TAGS.includes(name) && !all.some((t) => t.name === name)) saveTagDefaults(name, { kind: newKind || null });
    openForm(name);
    newName = '';
  }

  // What a row sets besides its font, said short.
  function summary(t) {
    const bits = [];
    const st = t?.style ?? {};
    if (Array.isArray(st.strokes)) bits.push(st.strokes.length ? `outline ${st.strokes[0].width}px` : 'no outline');
    if (t?.size) bits.push(`${t.size}px`);
    if (t?.minSize) bits.push(`min ${t.minSize}px`);
    const more = Object.keys(st).filter((k) => k !== 'font' && k !== 'strokes').length;
    if (more) bits.push(`+${more} style`);
    return bits.join(' · ');
  }
</script>

<!-- `unset` says what a row with no font of its own is set in: the app's
     font for a kind, the kind's font for a style or a voice under it. -->
{#snippet fontSelect(value, label, onpick, unset)}
  <FontPicker {value} {label} {unset} compact onpick={(name) => onpick(name || null)} />
{/snippet}

{#snippet editButton(name, label)}
  <button class="btn tiny ts-edit" aria-expanded={form?.name === name} aria-label="{form?.name === name ? 'Close' : 'Edit'} {label}" onclick={() => toggle(name)}>
    {form?.name === name ? 'Close' : 'Edit'}
  </button>
{/snippet}

{#snippet formFor(name)}
  {#if form?.name === name}
    <div class="qtagform ts-form">
      {#if form.mine}
        <span class="qtf-row">
          <label class="qtf-lbl" for="ts-kind">Under</label>
          <select id="ts-kind" value={form.kind} onchange={(e) => (form.kind = e.currentTarget.value)}>
            <option value="">No kind</option>
            {#each LETTERING_ROLES as r (r.tag)}<option value={r.tag}>{r.label}</option>{/each}
          </select>
        </span>
      {/if}
      <TagDefaultsForm bind:form key="text-styles" onforget={() => (form = null)} />
      <span class="qtf-top">
        <button class="qtf-go" onclick={save}>Save</button>
      </span>
    </div>
  {/if}
{/snippet}

{#snippet styleRow(t)}
  <div class="ts-row ts-sub">
    <div class="ts-name">
      <span><span class="ts-mark" aria-hidden="true">↳</span>{t.name}</span>
      {#if summary(t)}<span class="ts-hint">{summary(t)}</span>{/if}
    </div>
    {@render fontSelect(tagFont(t.name), `${t.name} font`, (font) => setTagFont(t.name, font), t.kind ? `${labelOf(t.kind)}’s font` : 'Default font')}
    {@render editButton(t.name, t.name)}
  </div>
  {@render formFor(t.name)}
{/snippet}

<section class="settings-section ts-list">
  <h3 class="settings-title">Kinds of text</h3>
  <p class="set-intro">
    The look each kind of text starts with. Your own styles sit under a kind
    and change only what they set; characters speak in their own font. On a
    line, the most particular wins: your style, then the character's voice,
    then the kind. Boxes already placed keep their look until you apply it
    with Bulk style.
  </p>

  {#each LETTERING_ROLES as r (r.tag)}
    <div class="ts-row">
      <div class="ts-name">
        <span>{r.label}</span>
        <span class="ts-hint">{r.hint}</span>
      </div>
      {@render fontSelect(tagFont(r.tag), `${r.label} font`, (font) => setTagFont(r.tag, font), 'Default font')}
      {@render editButton(r.tag, r.label)}
    </div>
    {@render formFor(r.tag)}
    {#if r.tag === 'speech'}
      {#each characters as c (c.id)}
        <div class="ts-row ts-sub">
          <div class="ts-name">
            <span><span class="ts-mark" aria-hidden="true">↳</span>{c.target || c.source}</span>
            <span class="ts-hint">voice</span>
          </div>
          {@render fontSelect(tagFont(c.tag), `${c.target || c.source} font`, (font) => setVoiceFont(c, font), `${labelOf('speech')}’s font`)}
          {#if c.tag && findTag(c.tag)}{@render editButton(c.tag, c.target || c.source)}{:else}<span></span>{/if}
        </div>
        {#if c.tag}{@render formFor(c.tag)}{/if}
      {/each}
    {/if}
    {#each under(r.tag) as t (t.name)}
      {@render styleRow(t)}
    {/each}
  {/each}

  {#if loose.length}
    <div class="ts-sub-title">Under no kind</div>
    {#each loose as t (t.name)}
      {@render styleRow(t)}
    {/each}
  {/if}

  <div class="ts-add">
    <input
      class="qtf-input"
      placeholder="New style…"
      aria-label="New style name"
      maxlength={MAX_TAG_LEN}
      bind:value={newName}
      onkeydown={(e) => e.key === 'Enter' && add()}
    />
    <span class="ts-under">under</span>
    <select class="qtf-input" aria-label="Kind of the new style" bind:value={newKind}>
      <option value="">No kind</option>
      {#each LETTERING_ROLES as r (r.tag)}<option value={r.tag}>{labelOf(r.tag)}</option>{/each}
    </select>
    <button class="btn tiny" disabled={!normalizeTagName(newName)} onclick={add}>Add</button>
  </div>
</section>

<style>
  /* A row is the screen's row (styles.css, .set-line): the name on the left,
     then the font, then Edit. A style under a kind is set in under it. */
  .ts-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr) auto;
    gap: 6px 12px;
    align-items: center;
    min-height: 44px;
    padding: 6px 0;
    border-bottom: 1px solid var(--line);
  }
  .ts-sub {
    min-height: 38px;
  }
  .ts-sub .ts-name {
    padding-left: 18px;
  }
  .ts-mark {
    margin-right: 6px;
    color: var(--t3);
  }
  .ts-name {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    font-size: 12.5px;
  }
  .ts-name > span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ts-hint {
    font-size: 11px;
    line-height: 1.4;
    color: var(--t2);
  }
  .ts-row select.qtf-input {
    min-width: 0;
    width: 100%;
    height: 28px;
    padding: 0 8px;
    font-size: 12px;
  }
  .ts-edit {
    min-width: 58px;
    justify-content: center;
  }
  .ts-form {
    margin: 8px 0 12px 18px;
  }
  .ts-form .qtf-top {
    justify-content: flex-end;
  }
  .ts-sub-title {
    margin: 22px 0 4px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text);
  }
  .ts-add {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 14px;
  }
  .ts-add .qtf-input {
    min-width: 0;
    height: 28px;
    padding: 0 8px;
    font-size: 12px;
  }
  .ts-add input.qtf-input {
    flex: 1;
    max-width: 220px;
  }
  .ts-under {
    font-size: 12px;
    color: var(--t2);
  }
</style>
