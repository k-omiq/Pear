<script>
  // The marketplaces the user added (font-market.js), what they list, and the
  // Install button. A list is fetched when the user adds it or presses
  // Refresh, and kept between launches; nothing goes to the network on its
  // own. Previews are the marketplace's own images, loaded as they scroll in.
  import { app, toast, toastError } from './store.svelte.js';
  import { prefs, setPref } from './prefs.svelte.js';
  import { loadManifest, filterFonts, tagsOf, installState, installMarketFont, writeMarketCache, allowedUrl } from './font-market.js';
  import { SLOT_LABEL, fontsWritten } from './fonts.js';

  // The sidebar of the Font Library lists every marketplace under
  // Marketplace, so the library owns which one is open (`pick`: 'all' or a
  // url) and the fetched lists (`cache`, for the counts beside them).
  // `addNonce` moves when the sidebar's "Add marketplace" is pressed.
  let { pick = $bindable('all'), cache = $bindable({}), addNonce = 0 } = $props();
  let addUrl = $state('');
  let adding = $state(false);
  let busy = $state({}); // url -> true while refreshing
  let installing = $state({}); // `${url}|${id}` -> 'n of m'
  let armedRemove = $state(null);
  let query = $state('');
  let tag = $state('');
  let showSkipped = $state(null);

  const markets = $derived(prefs.fontMarketplaces);
  const one = $derived(pick === 'all' ? null : (markets.find((m) => m.url === pick) ?? null));
  // A marketplace removed (here or in the other window) closes its page.
  $effect(() => {
    if (pick !== 'all' && !one) pick = 'all';
  });
  const managed = $derived(one ? [one] : markets);
  let addInput = $state();
  // Focus moves to the address field once per press of "Add marketplace", not
  // every time the form comes back on screen.
  let focusedNonce = 0;
  $effect(() => {
    if (addNonce > focusedNonce && addInput) {
      focusedNonce = addNonce;
      addInput.focus();
    }
  });
  // The list of marketplaces, saved and told to the other windows at once.
  function saveMarkets(list) {
    setPref('fontMarketplaces', list);
    fontsWritten();
  }
  const listed = $derived.by(() => {
    const out = [];
    for (const m of markets) {
      if (pick !== 'all' && pick !== m.url) continue;
      for (const f of cache[m.url]?.manifest?.fonts ?? []) out.push({ ...f, market: m.url });
    }
    return out;
  });
  const tags = $derived(tagsOf(listed));
  const shown = $derived(filterFonts(listed, { query, tag }));
  // A page of fonts at a time: a marketplace may list thousands.
  const PAGE = 60;
  let limit = $state(PAGE);
  $effect(() => {
    query;
    tag;
    pick;
    limit = PAGE;
  });

  function remember(url, manifest) {
    // A fetch that ends after its marketplace was removed keeps nothing.
    if (!prefs.fontMarketplaces.some((m) => m.url === url)) return;
    cache = { ...cache, [url]: { at: Date.now(), manifest } };
    writeMarketCache(cache);
  }

  async function add() {
    const url = allowedUrl(addUrl);
    if (!url) {
      toastError('A marketplace address starts with https://');
      return;
    }
    if (markets.some((m) => m.url === url)) {
      toast('That marketplace is already added');
      return;
    }
    adding = true;
    try {
      const manifest = await loadManifest(url);
      if (markets.some((m) => m.url === url)) return toast('That marketplace is already added');
      saveMarkets([...markets, { url, name: manifest.name }]);
      remember(url, manifest);
      addUrl = '';
      pick = url;
      toast(`Added ${manifest.name} - ${manifest.fonts.length} fonts`);
    } catch (e) {
      toastError(`Could not add that marketplace - ${e?.message || e}`);
    } finally {
      adding = false;
    }
  }

  async function refresh(m) {
    busy = { ...busy, [m.url]: true };
    try {
      const manifest = await loadManifest(m.url);
      if (!markets.some((x) => x.url === m.url)) return;
      remember(m.url, manifest);
      if (manifest.name !== m.name) saveMarkets(markets.map((x) => (x.url === m.url ? { ...x, name: manifest.name } : x)));
      toast(`${manifest.name} - ${manifest.fonts.length} fonts`);
    } catch (e) {
      toastError(`Could not refresh ${m.name || m.url} - ${e?.message || e}`);
    } finally {
      busy = { ...busy, [m.url]: false };
    }
  }

  function remove(m) {
    armedRemove = null;
    saveMarkets(markets.filter((x) => x.url !== m.url));
    const { [m.url]: _gone, ...rest } = cache;
    cache = rest;
    writeMarketCache(cache);
    if (pick === m.url) pick = 'all';
  }

  async function install(f) {
    const key = `${f.market}|${f.id}`;
    installing = { ...installing, [key]: 'Starting…' };
    try {
      await installMarketFont(f, f.market, { onProgress: (i, n) => (installing = { ...installing, [key]: `${i} of ${n}` }) });
    } finally {
      const { [key]: _done, ...rest } = installing;
      installing = rest;
    }
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Link copied');
    } catch {
      toast(text);
    }
  }
  const ago = (t) => {
    if (!t) return '';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
  };
</script>

{#if one}
  {@const c = cache[one.url]}
  <header class="set-page-head">
    <h2>{one.name || c?.manifest?.name || one.url}</h2>
    <p class="set-lead">{c?.manifest?.description || 'One of the font lists you added.'} Fonts are downloaded only when you press Install, checked, and added to Your fonts. Read each font’s licence before you use it.</p>
  </header>
{:else}
  <header class="set-page-head">
    <h2>Marketplace</h2>
    <p class="set-lead">Font lists you add by address. Add as many as you like; each one is listed under Marketplace in the sidebar. Fonts are downloaded only when you press Install, checked, and added to Your fonts. Read each font’s licence before you use it.</p>
  </header>
{/if}

<section class="settings-section">
  <h3 class="settings-title">{one ? 'This marketplace' : 'Marketplaces'}</h3>
  {#if !one}
    <form class="mk-add" onsubmit={(e) => { e.preventDefault(); add(); }}>
      <input bind:this={addInput} class="mk-input" type="url" placeholder="https://…/fonts.json" aria-label="Marketplace address" bind:value={addUrl} disabled={adding} />
      <button class="btn" type="submit" disabled={adding || !addUrl.trim()}>{adding ? 'Adding…' : 'Add'}</button>
    </form>
  {/if}
  {#each managed as m (m.url)}
    {@const c = cache[m.url]}
    <div class="set-item">
      <div class="set-line">
        <span class="set-label">
          {m.name || c?.manifest?.name || m.url}
          <span class="set-label-sub mk-url">{m.url}</span>
          <span class="set-label-sub">
            {#if c}{c.manifest.fonts.length} fonts · fetched {ago(c.at)}{#if c.manifest.skipped?.length}{' · '}<button class="set-link" onclick={() => (showSkipped = showSkipped === m.url ? null : m.url)}>{c.manifest.skipped.length} could not be read</button>{/if}{:else}Not fetched yet{/if}
          </span>
        </span>
        <div class="set-ctl">
          <button class="btn tiny" disabled={busy[m.url]} onclick={() => refresh(m)}>{busy[m.url] ? 'Refreshing…' : 'Refresh'}</button>
          {#if armedRemove === m.url}
            <button class="btn tiny" onclick={() => (armedRemove = null)}>Cancel</button>
            <button class="btn tiny danger" onclick={() => remove(m)}>Remove</button>
          {:else}
            <button class="btn tiny" onclick={() => (armedRemove = m.url)}>Remove</button>
          {/if}
        </div>
      </div>
      {#if showSkipped === m.url && c?.manifest?.skipped?.length}
        <ul class="mk-skipped">
          {#each c.manifest.skipped as s, i (i)}<li><b>{s.id}</b> - {s.reason}</li>{/each}
        </ul>
      {/if}
    </div>
  {:else}
    <p class="set-intro">No marketplaces yet. Paste the address of one to see what it offers.</p>
  {/each}
</section>

{#if markets.length}
  <section class="settings-section">
    <h3 class="settings-title">Fonts</h3>
    <div class="mk-bar">
      <input class="mk-input" type="search" placeholder={one ? 'Search this marketplace' : 'Search every marketplace'} aria-label="Search the marketplaces" bind:value={query} />
    </div>
    {#if tags.length}
      <div class="mk-tags" role="group" aria-label="Tags">
        <button class="mk-tag" class:on={!tag} aria-pressed={!tag} onclick={() => (tag = '')}>All</button>
        {#each tags.slice(0, 24) as t (t)}
          <button class="mk-tag" class:on={tag === t} aria-pressed={tag === t} onclick={() => (tag = tag === t ? '' : t)}>{t}</button>
        {/each}
      </div>
    {/if}

    {#if !listed.length}
      <p class="set-intro">Nothing listed yet. Press Refresh on a marketplace above.</p>
    {:else if !shown.length}
      <p class="set-intro">Nothing matches.</p>
    {/if}

    {#each shown.slice(0, limit) as f (f.market + '|' + f.id)}
      {@const state = installState(f, app.fonts.user)}
      {@const progress = installing[`${f.market}|${f.id}`]}
      <div class="mk-font">
        <div class="mk-preview">
          {#if f.preview}
            <img src={f.preview} alt="{f.family} sample" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
          {:else}
            <span class="mk-noprev">{f.family}</span>
          {/if}
        </div>
        <div class="mk-info">
          <div class="mk-family">{f.family}{#if !one && markets.length > 1}<span class="mk-from">{markets.find((m) => m.url === f.market)?.name || ''}</span>{/if}</div>
          <div class="mk-sub">{f.designer ? `${f.designer} · ` : ''}{f.files.map((x) => SLOT_LABEL[x.slot]).join(', ')}</div>
          {#if f.description}<div class="mk-desc">{f.description}</div>{/if}
          <div class="mk-sub">
            Licence: <b>{f.license.name}</b>
            {#if f.license.url}<button class="set-link" onclick={() => copy(f.license.url)} title={f.license.url}>copy link</button>{/if}
            {#if f.tags.length} · {f.tags.join(', ')}{/if}
          </div>
        </div>
        <div class="mk-act">
          {#if progress}
            <span class="mk-state">Installing {progress}</span>
          {:else if state === 'installed'}
            <span class="mk-state">Installed</span>
          {:else}
            <button class="btn tiny" onclick={() => install(f)}>{state === 'partial' ? 'Install the rest' : 'Install'}</button>
          {/if}
        </div>
      </div>
    {/each}
    {#if shown.length > limit}
      <button class="btn tiny mk-more" onclick={() => (limit += PAGE)}>Show {Math.min(PAGE, shown.length - limit)} more of {shown.length - limit}</button>
    {/if}
  </section>
{/if}

<style>
  .mk-add,
  .mk-bar {
    display: flex;
    gap: 8px;
    margin: 6px 0 8px;
  }
  .mk-input {
    flex: 1;
    min-width: 0;
    height: 28px;
    padding: 0 9px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    font-size: 12px;
  }
  .mk-input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .mk-from {
    margin-left: 8px;
    font-size: 11px;
    font-weight: 400;
    color: var(--t3);
  }
  .mk-url {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    overflow-wrap: anywhere;
  }
  .mk-skipped {
    margin: -4px 0 12px;
    padding-left: 18px;
    font-size: 11.5px;
    color: var(--t2);
  }
  .btn.danger {
    color: var(--warn);
    border-color: var(--warn);
  }
  .mk-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 8px;
  }
  .mk-tag {
    height: 24px;
    padding: 0 10px;
    border: 1px solid var(--line2);
    border-radius: 999px;
    background: transparent;
    color: var(--t2);
    font-size: 11px;
    cursor: pointer;
  }
  .mk-tag:hover {
    color: var(--text);
  }
  .mk-tag.on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-fg);
  }
  .mk-font {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 0;
    border-bottom: 1px solid var(--line);
  }
  .mk-preview {
    flex: none;
    width: 168px;
    height: 56px;
    display: grid;
    place-items: center;
    border-radius: 6px;
    background: var(--paper);
    overflow: hidden;
  }
  .mk-preview img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .mk-noprev {
    padding: 0 8px;
    font-size: 12px;
    /* On paper, which does not invert: the page's own ink. */
    color: var(--tintline);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mk-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .mk-family {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }
  .mk-sub,
  .mk-desc {
    font-size: 11.5px;
    color: var(--t2);
    line-height: 1.45;
  }
  .mk-sub b {
    color: var(--text);
    font-weight: 500;
  }
  .mk-act {
    flex: none;
  }
  .mk-state {
    font-size: 11.5px;
    color: var(--t2);
  }
  .mk-more {
    margin-top: 12px;
  }
</style>
