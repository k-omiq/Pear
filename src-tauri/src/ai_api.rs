// ===== Door B: the Claude API, through Rust =====
// The in-app AI panel talks to the Claude API on the user's own key
// (docs/AI_TYPESETTING_PLAN.md sections 5 and 7). Two rules shape this file:
//
//   the key never enters the webview   it lives in the OS keychain (macOS
//                                      Keychain, Windows Credential Manager,
//                                      the Linux kernel keyring). The webview
//                                      can set it, clear it and ask whether
//                                      one is set; it can never read it back
//   it only goes to api.anthropic.com  the webview names a path, and only the
//                                      few the panel needs are allowed. The
//                                      host is fixed here
//
// The webview runs the official SDK with a custom `fetch` (agent/transport.js)
// that lands in `ai_request`. Rust adds the key, sends the request and streams
// the answer back over a Tauri channel: first the status and headers, then the
// body as text as it arrives, then the end. The SDK parses the stream, retries
// and reads errors, so none of that is here.
//
// Where no keychain works (some Linux setups), the key is kept for this
// session only, in memory, and the status says so.
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

const API: &str = "https://api.anthropic.com";
// What the panel calls: a message (streamed), a token count, and the model
// list (the Settings "Test key" button).
const PATHS: &[&str] = &["/v1/messages", "/v1/messages/count_tokens", "/v1/models"];
// The request headers the webview may set. Everything else it sends is
// dropped - an `x-api-key` or `authorization` above all, so the SDK's
// placeholder key never reaches the API.
const PASS: &[&str] = &["anthropic-version", "anthropic-beta", "content-type", "accept"];
const ACCOUNT: &str = "api-key";
const MAX_KEY: usize = 512;

#[derive(Default)]
pub struct AiApi {
  // The key, once read: macOS may ask the user each time an unsigned build
  // reads the keychain, so it is read once a session.
  key: Mutex<Option<String>>,
  // True when the keychain refused and the key lives only in `key`.
  session_only: Mutex<bool>,
  calls: Mutex<HashMap<u64, tauri::async_runtime::JoinHandle<()>>>,
  client: OnceLock<reqwest::Client>,
}

// One frame of an answer, as the webview's fetch reads it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Frame {
  Head { status: u16, headers: Vec<(String, String)> },
  Chunk { text: String },
  End,
  Fail { error: String },
}

// Per app, so the side-by-side test build keeps its own key.
fn service(app: &AppHandle) -> String {
  format!("{}.claude-api", app.config().identifier)
}

fn entry(app: &AppHandle) -> Result<keyring::Entry, String> {
  keyring::Entry::new(&service(app), ACCOUNT).map_err(|e| e.to_string())
}

pub fn clean_key(key: &str) -> Result<String, String> {
  let k = key.trim();
  if k.is_empty() {
    return Err("the key is empty".into());
  }
  if k.len() > MAX_KEY || k.chars().any(|c| c.is_whitespace() || c.is_control()) {
    return Err("that does not look like an API key".into());
  }
  Ok(k.to_string())
}

impl AiApi {
  fn read_key(&self, app: &AppHandle) -> Option<String> {
    if let Some(k) = self.key.lock().unwrap().clone() {
      return Some(k);
    }
    let k = entry(app).ok()?.get_password().ok()?;
    *self.key.lock().unwrap() = Some(k.clone());
    Some(k)
  }

  fn status(&self, app: &AppHandle) -> Value {
    let set = self.read_key(app).is_some();
    // The Linux kernel keyring lasts until logout.
    let session = *self.session_only.lock().unwrap() || cfg!(target_os = "linux");
    json!({ "set": set, "store": if !set { Value::Null } else if session { json!("session") } else { json!("keychain") } })
  }

  fn client(&self) -> Result<reqwest::Client, String> {
    if let Some(c) = self.client.get() {
      return Ok(c.clone());
    }
    // No overall timeout: a long answer streams for minutes. A read that
    // stalls for two minutes is a dead connection, not a slow model - the
    // API sends pings while it thinks.
    let c = reqwest::Client::builder()
      .connect_timeout(Duration::from_secs(30))
      .read_timeout(Duration::from_secs(120))
      .build()
      .map_err(|e| e.to_string())?;
    Ok(self.client.get_or_init(|| c).clone())
  }
}

#[tauri::command]
pub fn ai_key_status(app: AppHandle, api: State<'_, AiApi>) -> Value {
  api.status(&app)
}

#[tauri::command]
pub fn ai_key_set(app: AppHandle, api: State<'_, AiApi>, key: String) -> Result<Value, String> {
  let key = clean_key(&key)?;
  let saved = entry(&app).and_then(|e| e.set_password(&key).map_err(|e| e.to_string()));
  *api.session_only.lock().unwrap() = saved.is_err();
  if let Err(e) = saved {
    log::warn!("ai key: the keychain refused ({e}); keeping it for this session only");
  }
  *api.key.lock().unwrap() = Some(key);
  Ok(api.status(&app))
}

#[tauri::command]
pub fn ai_key_clear(app: AppHandle, api: State<'_, AiApi>) -> Value {
  *api.key.lock().unwrap() = None;
  *api.session_only.lock().unwrap() = false;
  if let Ok(e) = entry(&app) {
    // No entry is the state we want, so its error is not one.
    let _ = e.delete_credential();
  }
  api.status(&app)
}

// The path the webview asked for, if it is one the panel may call: a path in
// PATHS, with any query string kept.
pub fn allowed_path(path: &str) -> Option<String> {
  let (p, q) = path.split_once('?').map_or((path, None), |(p, q)| (p, Some(q)));
  if !PATHS.contains(&p) {
    return None;
  }
  if let Some(q) = q {
    if !q.chars().all(|c| c.is_ascii_alphanumeric() || "=&_-.%".contains(c)) {
      return None;
    }
  }
  Some(path.to_string())
}

pub fn pass_headers(given: &[(String, String)]) -> Vec<(String, String)> {
  given
    .iter()
    .filter(|(k, v)| PASS.contains(&k.to_ascii_lowercase().as_str()) && !v.chars().any(|c| c.is_control()))
    .map(|(k, v)| (k.to_ascii_lowercase(), v.clone()))
    .collect()
}

// Text out of a byte stream that may cut a letter in two: what decodes is
// taken, the cut tail waits in `carry` for the next chunk.
pub fn take_text(carry: &mut Vec<u8>, bytes: &[u8]) -> Option<String> {
  carry.extend_from_slice(bytes);
  let valid = match std::str::from_utf8(carry) {
    Ok(s) => s.len(),
    // A byte that can never decode is replaced, so one bad byte cannot hold
    // the rest of the stream back.
    Err(e) if e.error_len().is_some() => {
      let s = String::from_utf8_lossy(carry).into_owned();
      carry.clear();
      return Some(s);
    }
    Err(e) => e.valid_up_to(),
  };
  if valid == 0 {
    return None;
  }
  let rest = carry.split_off(valid);
  let text = String::from_utf8(std::mem::replace(carry, rest)).ok()?;
  Some(text)
}

#[tauri::command]
pub fn ai_request(
  app: AppHandle,
  api: State<'_, AiApi>,
  id: u64,
  method: String,
  path: String,
  headers: Vec<(String, String)>,
  body: Option<String>,
  on_frame: Channel<Frame>,
) -> Result<(), String> {
  let path = allowed_path(&path).ok_or_else(|| format!("the panel may not call {path}"))?;
  let method = match method.to_ascii_uppercase().as_str() {
    "GET" => reqwest::Method::GET,
    "POST" => reqwest::Method::POST,
    m => return Err(format!("the panel may not send {m}")),
  };
  let key = api.read_key(&app).ok_or("no Claude API key is set - add one in Settings > AI agents")?;
  let client = api.client()?;
  let headers = pass_headers(&headers);

  let handle = app.clone();
  let task = tauri::async_runtime::spawn(async move {
    let mut req = client.request(method, format!("{API}{path}")).header("x-api-key", key);
    for (k, v) in &headers {
      req = req.header(k, v);
    }
    if let Some(b) = body {
      req = req.body(b);
    }
    let sent = async {
      let mut resp = req.send().await.map_err(|e| e.to_string())?;
      let head = resp
        .headers()
        .iter()
        .filter(|(k, _)| k.as_str() != "set-cookie")
        .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.to_string(), v.to_string())))
        .collect();
      if on_frame.send(Frame::Head { status: resp.status().as_u16(), headers: head }).is_err() {
        return Ok(());
      }
      let mut carry = Vec::new();
      while let Some(bytes) = resp.chunk().await.map_err(|e| e.to_string())? {
        if let Some(text) = take_text(&mut carry, &bytes) {
          // The webview went away: nothing is reading.
          if on_frame.send(Frame::Chunk { text }).is_err() {
            return Ok(());
          }
        }
      }
      if !carry.is_empty() {
        let _ = on_frame.send(Frame::Chunk { text: String::from_utf8_lossy(&carry).into_owned() });
      }
      let _ = on_frame.send(Frame::End);
      Ok::<(), String>(())
    }
    .await;
    if let Err(error) = sent {
      let _ = on_frame.send(Frame::Fail { error });
    }
    handle.state::<AiApi>().calls.lock().unwrap().remove(&id);
  });
  api.calls.lock().unwrap().insert(id, task);
  Ok(())
}

// Stop: the request is dropped where it is, mid-stream or not.
#[tauri::command]
pub fn ai_abort(api: State<'_, AiApi>, id: u64) {
  if let Some(task) = api.calls.lock().unwrap().remove(&id) {
    task.abort();
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_the_panel_paths_pass() {
    assert_eq!(allowed_path("/v1/messages").as_deref(), Some("/v1/messages"));
    assert_eq!(allowed_path("/v1/models?limit=20").as_deref(), Some("/v1/models?limit=20"));
    assert!(allowed_path("/v1/files").is_none());
    assert!(allowed_path("/v1/messages/batches").is_none());
    assert!(allowed_path("//evil.example/v1/messages").is_none());
    assert!(allowed_path("/v1/models?x=@evil").is_none());
    assert!(allowed_path("https://evil.example/v1/messages").is_none());
  }

  #[test]
  fn the_webview_cannot_send_a_key() {
    let given = vec![
      ("X-Api-Key".to_string(), "placeholder".to_string()),
      ("Authorization".to_string(), "Bearer x".to_string()),
      ("anthropic-version".to_string(), "2023-06-01".to_string()),
      ("Content-Type".to_string(), "application/json".to_string()),
      ("anthropic-beta".to_string(), "a\r\nx-api-key: b".to_string()),
    ];
    assert_eq!(
      pass_headers(&given),
      vec![
        ("anthropic-version".to_string(), "2023-06-01".to_string()),
        ("content-type".to_string(), "application/json".to_string()),
      ]
    );
  }

  #[test]
  fn a_letter_cut_between_chunks_waits() {
    let s = "ab\u{3042}c".as_bytes();
    let mut carry = Vec::new();
    assert_eq!(take_text(&mut carry, &s[..3]).as_deref(), Some("ab"));
    assert_eq!(take_text(&mut carry, &s[3..4]), None);
    assert_eq!(take_text(&mut carry, &s[4..]).as_deref(), Some("\u{3042}c"));
    assert!(carry.is_empty());
    // A byte that can never decode does not hold the stream.
    assert_eq!(take_text(&mut carry, &[b'x', 0xff, b'y']).as_deref(), Some("x\u{fffd}y"));
  }

  #[test]
  fn keys_are_trimmed_and_checked() {
    assert_eq!(clean_key("  sk-ant-abc \n").unwrap(), "sk-ant-abc");
    assert!(clean_key("").is_err());
    assert!(clean_key("sk ant").is_err());
  }
}
