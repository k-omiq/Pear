//! The Font Library's window, and the one download path its marketplaces use.
//!
//! The library is a window of its own (label `fonts`), one at most: asking
//! for it again brings the open one to the front. The webview decides what it
//! shows from its label (src/main.js), so the window loads the same
//! index.html as every other.
//!
//! `font_fetch` is how a marketplace's list and its font files come down. The
//! webview could `fetch` them itself only from a host that answers CORS for
//! the app's origin; this asks nothing of the host and speaks https only (or
//! http to this machine, for a marketplace being written locally), follows
//! only redirects that stay so, and stops reading at the size the caller
//! allows. It is called when the user presses something, never on its own.

use std::time::Duration;
use tauri::{AppHandle, Manager};

pub const LABEL: &str = "fonts";

/// The most `font_fetch` reads, whatever the caller asks: the largest font
/// file the app takes (font_decode.rs).
const MAX_FETCH: usize = 128 * 1024 * 1024;

#[tauri::command]
pub fn font_library_open(app: AppHandle) -> Result<(), String> {
  if let Some(win) = app.get_webview_window(LABEL) {
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
    return Ok(());
  }
  tauri::WebviewWindowBuilder::new(&app, LABEL, tauri::WebviewUrl::App("index.html".into()))
    .title("Font Library")
    .inner_size(1120.0, 780.0)
    .min_inner_size(760.0, 520.0)
    .center()
    // The library's own drag and drop (faces between families, files from
    // Finder) is the webview's; Tauri's handler would take the drops.
    .disable_drag_drop_handler()
    .build()
    .map(|_| ())
    .map_err(|e| format!("could not open the Font Library: {e}"))
}

#[tauri::command]
pub fn font_library_close(app: AppHandle) {
  if let Some(win) = app.get_webview_window(LABEL) {
    let _ = win.destroy();
  }
}

/// https anywhere, http only to this machine.
fn allowed(url: &reqwest::Url) -> bool {
  match url.scheme() {
    "https" => true,
    "http" => matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1")),
    _ => false,
  }
}

#[tauri::command]
pub async fn font_fetch(url: String, max: Option<usize>) -> Result<tauri::ipc::Response, String> {
  let parsed = reqwest::Url::parse(&url).map_err(|_| "that is not a web address".to_string())?;
  if !allowed(&parsed) || !parsed.username().is_empty() || parsed.password().is_some() {
    return Err("only https addresses can be used".into());
  }
  let max = max.unwrap_or(MAX_FETCH).min(MAX_FETCH);
  let client = reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(20))
    .read_timeout(Duration::from_secs(60))
    .redirect(reqwest::redirect::Policy::custom(|attempt| {
      if attempt.previous().len() >= 5 {
        attempt.error("too many redirects")
      } else if allowed(attempt.url()) {
        attempt.follow()
      } else {
        attempt.error("redirected to an address that is not https")
      }
    }))
    .build()
    .map_err(|e| e.to_string())?;
  let mut resp = client
    .get(parsed)
    .send()
    .await
    .map_err(|e| if e.is_timeout() { "the server did not answer in time".to_string() } else { e.to_string() })?;
  let status = resp.status();
  if !status.is_success() {
    return Err(format!("the server answered {}", status.as_u16()));
  }
  if resp.content_length().is_some_and(|n| n as usize > max) {
    return Err(too_big(max));
  }
  let mut out: Vec<u8> = Vec::new();
  while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
    if out.len() + chunk.len() > max {
      return Err(too_big(max));
    }
    out.extend_from_slice(&chunk);
  }
  Ok(tauri::ipc::Response::new(out))
}

fn too_big(max: usize) -> String {
  format!("the file is larger than {} MB", max / (1024 * 1024))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn speaks_https_and_local_http_only() {
    let ok = |s: &str| allowed(&reqwest::Url::parse(s).unwrap());
    assert!(ok("https://fonts.example.com/market.json"));
    assert!(ok("http://localhost:5240/market.json"));
    assert!(ok("http://127.0.0.1/x.ttf"));
    assert!(!ok("http://fonts.example.com/market.json"));
    assert!(!ok("file:///etc/passwd"));
    assert!(!ok("ftp://example.com/x.ttf"));
  }
}
