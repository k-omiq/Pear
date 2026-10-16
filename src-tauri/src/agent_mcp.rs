//! The AI door (docs/AI_TYPESETTING_PLAN.md section 6, "Door A"): a local MCP
//! server that Claude Code, Codex and Antigravity connect to, so an agent on
//! the user's own plan can typeset through the app.
//!
//! The tools themselves live in the webview (`src/lib/agent/`), because that
//! is where the document is. This module only carries calls across:
//!
//!   tools/list   answered from the list the webview registered
//!                (`agent_tools_set`), so there is one source of truth
//!   tools/call   becomes the Tauri event `agent:call {id, name, args}`; the
//!                webview runs the tool and answers with `agent_result`, which
//!                completes the call. 30 s with no answer is an error result.
//!
//! Security, every part of it required (section 5):
//!   - bound to 127.0.0.1 only, never another interface
//!   - every request carries `Authorization: Bearer <token>`; the token is
//!     random, made by the app, and shown to the user to paste into the client
//!   - a request with an `Origin` (or `Sec-Fetch-Site`) header is a browser
//!     page and is refused; a `Host` that is not this loopback port is refused
//!     too, which closes DNS rebinding
//!   - off until the user turns it on in Settings, and off again means off:
//!     a connection left open from before is refused on its next request
//!
//! rmcp serves the protocol itself (Streamable HTTP, stateless, plain JSON
//! responses); the checks above run in front of it on every request.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Full};
use hyper::header::{HeaderMap, AUTHORIZATION, HOST, ORIGIN};
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use rmcp::model::{
  CallToolRequestParams, CallToolResponse, CallToolResult, Implementation, ListToolsResult,
  PaginatedRequestParams, ServerCapabilities, ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

/// How long a tool call may take in the webview before the agent is told.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// A token shorter than this is refused: the app makes 32 random bytes.
const MIN_TOKEN_LEN: usize = 32;

#[derive(Default)]
struct Inner {
  app: Mutex<Option<AppHandle>>,
  tools: Mutex<Vec<Value>>,
  instructions: Mutex<String>,
  pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
  next_call: AtomicU64,
  /// Which start is live. Every request checks it, so a connection opened
  /// before a stop is refused after it. 0 is "off".
  live: AtomicU64,
  starts: AtomicU64,
  running: Mutex<Option<Running>>,
}

struct Running {
  port: u16,
  accept: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default, Clone)]
pub struct AgentDoor {
  inner: Arc<Inner>,
}

// ---------- the request guard ----------

/// Constant-time compare, so the token cannot be found a byte at a time.
fn same(a: &[u8], b: &[u8]) -> bool {
  if a.len() != b.len() {
    return false;
  }
  a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Whether a request may reach the MCP server: `Err((status, reason))` when
/// not. Pure, so every rule has its own test.
pub fn check_request(headers: &HeaderMap, port: u16, token: &str) -> Result<(), (StatusCode, &'static str)> {
  // A browser page always says where it came from; an MCP client never does.
  if headers.contains_key(ORIGIN) || headers.contains_key("sec-fetch-site") {
    return Err((StatusCode::FORBIDDEN, "requests from a web page are refused"));
  }
  let host = headers.get(HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
  let ok_host = ["127.0.0.1", "localhost", "[::1]"]
    .iter()
    .any(|name| host == *name || host == format!("{name}:{port}"));
  if !ok_host {
    return Err((StatusCode::FORBIDDEN, "this server answers on 127.0.0.1 only"));
  }
  let given = headers
    .get(AUTHORIZATION)
    .and_then(|h| h.to_str().ok())
    .and_then(|h| h.strip_prefix("Bearer "))
    .unwrap_or("");
  if token.len() < MIN_TOKEN_LEN || !same(given.as_bytes(), token.as_bytes()) {
    return Err((StatusCode::UNAUTHORIZED, "a valid bearer token is required"));
  }
  Ok(())
}

fn refusal(status: StatusCode, why: &'static str) -> Response<BoxBody<Bytes, Infallible>> {
  let mut res = Response::new(Full::new(Bytes::from(why)).boxed());
  *res.status_mut() = status;
  res
}

// ---------- the MCP handler ----------

#[derive(Clone)]
struct Handler {
  inner: Arc<Inner>,
}

impl Handler {
  async fn call(&self, name: &str, args: Value) -> CallToolResult {
    let failed = |text: String| {
      let mut r = CallToolResult::success(vec![rmcp::model::ContentBlock::text(text)]);
      r.is_error = Some(true);
      r
    };
    let Some(app) = self.inner.app.lock().unwrap().clone() else {
      return failed("the app is not ready".into());
    };
    let id = self.inner.next_call.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = oneshot::channel();
    self.inner.pending.lock().unwrap().insert(id, tx);
    if app.emit("agent:call", json!({ "id": id, "name": name, "args": args })).is_err() {
      self.inner.pending.lock().unwrap().remove(&id);
      return failed("the app window is not answering".into());
    }
    match tokio::time::timeout(CALL_TIMEOUT, rx).await {
      Ok(Ok(v)) => serde_json::from_value(v).unwrap_or_else(|e| failed(format!("the app sent a bad result: {e}"))),
      Ok(Err(_)) => failed("the call was dropped".into()),
      Err(_) => {
        self.inner.pending.lock().unwrap().remove(&id);
        failed("the app did not answer within 30 s; it may be busy or its window hidden".into())
      }
    }
  }
}

impl ServerHandler for Handler {
  fn get_info(&self) -> ServerConfig {
    let mut info = ServerConfig::new(ServerCapabilities::builder().enable_tools().build());
    info.server_info = Implementation::new("manga-typesetter", env!("CARGO_PKG_VERSION"));
    let text = self.inner.instructions.lock().unwrap().clone();
    if !text.is_empty() {
      info = info.with_instructions(text);
    }
    info
  }

  async fn list_tools(
    &self,
    _request: Option<PaginatedRequestParams>,
    _context: RequestContext<RoleServer>,
  ) -> Result<ListToolsResult, McpError> {
    let tools = self.inner.tools.lock().unwrap().clone();
    serde_json::from_value(json!({ "tools": tools }))
      .map_err(|e| McpError::internal_error(format!("bad tool list: {e}"), None))
  }

  async fn call_tool(
    &self,
    request: CallToolRequestParams,
    _context: RequestContext<RoleServer>,
  ) -> Result<CallToolResponse, McpError> {
    let args = request.arguments.map(Value::Object).unwrap_or_else(|| json!({}));
    Ok(self.call(&request.name, args).await.into())
  }
}

// ---------- start and stop ----------

impl AgentDoor {
  pub fn set_app(&self, app: AppHandle) {
    *self.inner.app.lock().unwrap() = Some(app);
  }

  async fn start(&self, port: u16, token: String) -> Result<u16, String> {
    if token.len() < MIN_TOKEN_LEN {
      return Err("the token is too short".into());
    }
    self.stop();
    // 127.0.0.1, never 0.0.0.0: nothing off this machine can reach it.
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
      .await
      .map_err(|e| format!("could not listen on 127.0.0.1:{port}: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let epoch = self.inner.starts.fetch_add(1, Ordering::SeqCst) + 1;
    self.inner.live.store(epoch, Ordering::SeqCst);

    let inner = self.inner.clone();
    let mut config = StreamableHttpServerConfig::default()
      .with_allowed_hosts(["127.0.0.1", "localhost", "::1"])
      .enforce_origin_validation();
    config.legacy_session_mode = false;
    config.json_response = true;
    let handler = Handler { inner: inner.clone() };
    let mcp = Arc::new(StreamableHttpService::new(
      move || Ok(handler.clone()),
      Arc::new(NeverSessionManager::default()),
      config,
    ));
    let token = Arc::new(token);

    let accept = tauri::async_runtime::spawn(async move {
      loop {
        let Ok((stream, peer)) = listener.accept().await else { continue };
        // Belt to the bind: only loopback peers are served at all.
        if !peer.ip().is_loopback() {
          continue;
        }
        let (inner, mcp, token) = (inner.clone(), mcp.clone(), token.clone());
        tauri::async_runtime::spawn(async move {
          let service = hyper::service::service_fn(move |req: Request<hyper::body::Incoming>| {
            let (inner, mcp, token) = (inner.clone(), mcp.clone(), token.clone());
            async move {
              if inner.live.load(Ordering::SeqCst) != epoch {
                return Ok::<_, Infallible>(refusal(StatusCode::SERVICE_UNAVAILABLE, "the AI door is off"));
              }
              if let Err((status, why)) = check_request(req.headers(), port, &token) {
                return Ok(refusal(status, why));
              }
              if req.uri().path() != "/mcp" {
                return Ok(refusal(StatusCode::NOT_FOUND, "the MCP endpoint is /mcp"));
              }
              Ok(mcp.handle(req).await)
            }
          });
          let _ = hyper::server::conn::http1::Builder::new()
            .serve_connection(TokioIo::new(stream), service)
            .await;
        });
      }
    });
    *self.inner.running.lock().unwrap() = Some(Running { port, accept });
    Ok(port)
  }

  fn stop(&self) {
    self.inner.live.store(0, Ordering::SeqCst);
    if let Some(r) = self.inner.running.lock().unwrap().take() {
      r.accept.abort();
    }
    // Calls waiting on the webview are answered as dropped.
    self.inner.pending.lock().unwrap().clear();
  }

  fn port(&self) -> Option<u16> {
    self.inner.running.lock().unwrap().as_ref().map(|r| r.port)
  }
}

// ---------- commands ----------

#[tauri::command]
pub async fn agent_door_start(door: State<'_, AgentDoor>, port: u16, token: String) -> Result<u16, String> {
  door.start(port, token).await
}

#[tauri::command]
pub fn agent_door_stop(door: State<'_, AgentDoor>) {
  door.stop();
}

#[tauri::command]
pub fn agent_door_status(door: State<'_, AgentDoor>) -> Value {
  json!({ "running": door.port().is_some(), "port": door.port() })
}

/// The webview's tool list and the instructions every client is sent.
#[tauri::command]
pub fn agent_tools_set(door: State<'_, AgentDoor>, tools: Vec<Value>, instructions: String) {
  *door.inner.tools.lock().unwrap() = tools;
  *door.inner.instructions.lock().unwrap() = instructions;
}

/// The webview's answer to one `agent:call`.
#[tauri::command]
pub fn agent_result(door: State<'_, AgentDoor>, id: u64, result: Value) {
  if let Some(tx) = door.inner.pending.lock().unwrap().remove(&id) {
    let _ = tx.send(result);
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use hyper::header::HeaderValue;

  const TOKEN: &str = "0123456789abcdef0123456789abcdef";

  fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
    let mut h = HeaderMap::new();
    for (k, v) in pairs {
      h.insert(*k, HeaderValue::from_str(v).unwrap());
    }
    h
  }
  fn good() -> Vec<(&'static str, String)> {
    vec![("host", "127.0.0.1:7811".into()), ("authorization", format!("Bearer {TOKEN}"))]
  }
  fn with(extra: &[(&'static str, &str)]) -> HeaderMap {
    let base = good();
    let mut pairs: Vec<(&'static str, &str)> = base.iter().map(|(k, v)| (*k, v.as_str())).collect();
    for (k, v) in extra {
      pairs.retain(|(pk, _)| pk != k);
      pairs.push((*k, *v));
    }
    headers(&pairs)
  }

  #[test]
  fn accepts_a_loopback_request_with_the_token() {
    assert!(check_request(&with(&[]), 7811, TOKEN).is_ok());
    assert!(check_request(&with(&[("host", "localhost:7811")]), 7811, TOKEN).is_ok());
  }

  #[test]
  fn refuses_without_the_right_token() {
    let mut h = with(&[]);
    h.remove(AUTHORIZATION);
    assert_eq!(check_request(&h, 7811, TOKEN).unwrap_err().0, StatusCode::UNAUTHORIZED);
    let wrong = format!("Bearer {}", "x".repeat(32));
    assert_eq!(check_request(&with(&[("authorization", &wrong)]), 7811, TOKEN).unwrap_err().0, StatusCode::UNAUTHORIZED);
    assert_eq!(check_request(&with(&[("authorization", TOKEN)]), 7811, TOKEN).unwrap_err().0, StatusCode::UNAUTHORIZED);
    // A short token is never accepted, even when it matches.
    assert!(check_request(&with(&[("authorization", "Bearer abc")]), 7811, "abc").is_err());
  }

  #[test]
  fn refuses_a_browser_origin() {
    for (k, v) in [("origin", "http://127.0.0.1:7811"), ("origin", "null"), ("sec-fetch-site", "cross-site")] {
      assert_eq!(check_request(&with(&[(k, v)]), 7811, TOKEN).unwrap_err().0, StatusCode::FORBIDDEN, "{k}: {v}");
    }
  }

  #[test]
  fn refuses_another_host() {
    for host in ["evil.example:7811", "127.0.0.1:9999", "192.168.1.5:7811", "127.0.0.1.evil.example"] {
      assert_eq!(check_request(&with(&[("host", host)]), 7811, TOKEN).unwrap_err().0, StatusCode::FORBIDDEN, "{host}");
    }
    let mut h = with(&[]);
    h.remove(HOST);
    assert!(check_request(&h, 7811, TOKEN).is_err());
  }

  /// The listener: on 127.0.0.1 and nowhere else, and a stop really stops it.
  #[test]
  fn binds_loopback_only_and_stops() {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let _guard = rt.enter();
    rt.block_on(async {
      let door = AgentDoor::default();
      let port = door.start(0, TOKEN.into()).await.unwrap();
      assert!(tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok());
      // Every other interface of this machine is refused.
      if let Some(ip) = local_non_loopback_ip() {
        assert!(tokio::net::TcpStream::connect((ip, port)).await.is_err(), "reachable on {ip}");
      }
      assert!(door.start(0, "short".into()).await.is_err());
      door.stop();
      assert_eq!(door.port(), None);
      assert_eq!(door.inner.live.load(Ordering::SeqCst), 0);
    });
  }

  /// One raw HTTP/1.1 request; the status code and body back.
  async fn post(port: u16, auth: Option<&str>, body: &str) -> (u16, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let auth = auth.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    let req = format!(
      "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
      body.len()
    );
    s.write_all(req.as_bytes()).await.unwrap();
    let mut out = String::new();
    let _ = s.read_to_string(&mut out).await;
    let code = out.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    (code, out)
  }

  #[test]
  fn serves_mcp_only_with_the_token() {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let _guard = rt.enter();
    rt.block_on(async {
      let door = AgentDoor::default();
      *door.inner.instructions.lock().unwrap() = "be careful".into();
      let port = door.start(0, TOKEN.into()).await.unwrap();
      let init = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}"#;
      assert_eq!(post(port, None, init).await.0, 401);
      let (code, body) = post(port, Some(TOKEN), init).await;
      assert_eq!(code, 200, "{body}");
      assert!(body.contains("manga-typesetter") && body.contains("be careful"), "{body}");
      door.stop();
      assert!(tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_err() || post(port, Some(TOKEN), init).await.0 != 200);
    });
  }

  fn local_non_loopback_ip() -> Option<std::net::IpAddr> {
    // The address the OS would route out from; no packet is sent.
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    let ip = s.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
  }
}
