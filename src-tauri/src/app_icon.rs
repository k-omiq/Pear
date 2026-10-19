//! `set_theme_icon()` - the Dock / taskbar icon follows the app theme.
//!
//! Each theme in `src/lib/theme.svelte.js` has a pear in its own colours,
//! drawn by `scripts/make-icon.mjs --themes` into `icons/themes/`. The bundled
//! icon (Finder, Launchpad, the installer) stays the dark one; this only
//! changes what the running app shows.
//!
//! On macOS the Dock icon is NSApplication's icon image, which must be set on
//! the main thread. Elsewhere the taskbar shows the window's icon.

const ICONS: [(&str, &[u8]); 5] = [
  ("light", include_bytes!("../icons/themes/light.png")),
  ("dark", include_bytes!("../icons/themes/dark.png")),
  ("sakura", include_bytes!("../icons/themes/sakura.png")),
  ("jade", include_bytes!("../icons/themes/jade.png")),
  ("ocean", include_bytes!("../icons/themes/ocean.png")),
];

#[tauri::command]
pub fn set_theme_icon(app: tauri::AppHandle, theme: String) -> Result<(), String> {
  let png = ICONS
    .iter()
    .find(|(name, _)| *name == theme)
    .map(|(_, png)| *png)
    .ok_or_else(|| format!("no icon for theme {theme:?}"))?;

  #[cfg(target_os = "macos")]
  {
    app
      .run_on_main_thread(move || {
        use objc2::{AllocAnyThread, MainThreadMarker};
        use objc2_app_kit::{NSApplication, NSImage};
        use objc2_foundation::NSData;

        // SAFETY: run_on_main_thread runs this closure on the main thread.
        let mtm = unsafe { MainThreadMarker::new_unchecked() };
        let data = NSData::with_bytes(png);
        if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
          // SAFETY: on the main thread, with a valid image.
          unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&image)) };
        }
      })
      .map_err(|error| error.to_string())
  }
  #[cfg(not(target_os = "macos"))]
  {
    use tauri::Manager;
    let image = tauri::image::Image::from_bytes(png).map_err(|error| error.to_string())?;
    match app.get_webview_window("main") {
      Some(window) => window.set_icon(image).map_err(|error| error.to_string()),
      None => Ok(()),
    }
  }
}
