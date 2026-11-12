<script>
  import { app, dismissError, dismissToast } from './store.svelte.js';
  // Errors come from `app.errors` and stay; the passing toast is info only.
  const show = $derived(app.toast.msg !== '' && app.toast.kind !== 'error');
  // The toast's one action (`toast(msg, kind, { label, run })`): run once, and
  // the toast goes with it, so a second press cannot run it twice.
  const action = $derived(show ? app.toast.action : null);
  function act() {
    const run = action?.run;
    dismissToast();
    run?.();
  }
</script>

{#if app.errors.length}
  <div class="toast-errors" role="alert">
    {#each app.errors as e (e.id)}
      <div class="toast-error">
        <span class="msg">{e.msg}{#if e.count > 1}<span class="count">×{e.count}</span>{/if}</span>
        <button class="x" onclick={() => dismissError(e.id)} aria-label="Dismiss">✕</button>
      </div>
    {/each}
  </div>
{/if}
<div class="toast" class:show class:has-action={!!action} role="status">
  {app.toast.kind === 'error' ? '' : app.toast.msg}
  {#if action}<button class="toast-act" onclick={act}>{action.label}</button>{/if}
</div>
