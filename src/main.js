import { mount } from 'svelte'
import './styles.css'

// Which window this is decides what it shows: the Font Library's own window
// (font_library.rs) mounts the library alone, every other window the app.
// Said on `globalThis` before anything else loads, because the preferences
// read it as they load (prefs.svelte.js leaves the text engine off there).
const meta = typeof window !== 'undefined' ? window.__TAURI_INTERNALS__?.metadata : null
const label = meta?.currentWebview?.label || meta?.currentWindow?.label
let fontsOnly = label === 'fonts'
if (!label) {
  try {
    fontsOnly = new URLSearchParams(window.location.search).get('window') === 'fonts'
  } catch {
    /* no location: the app */
  }
}
globalThis.__MT_WINDOW__ = fontsOnly ? 'fonts' : 'app'

const root = fontsOnly ? import('./lib/FontLibraryWindow.svelte') : import('./App.svelte')
root.then(({ default: Root }) => {
  mount(Root, { target: document.getElementById('app') })
})
