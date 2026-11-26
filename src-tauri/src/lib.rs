// The AI door: a local MCP server, off until Settings turns it on.
mod agent_mcp;
// The in-app AI panel: the Claude API key and the streaming proxy.
mod ai_api;
mod app_icon;
// The data folder shared with Manga Cleaner (SHARED_DATA_FOLDER.md).
mod data_folder;
// Filing the cleaner's messages: the file moves (handoff.svelte.js decides).
mod handoff;
// `pub` because the `.sut` parser and its scorer are reachable from the crate's
// tests as well as from the `brush_import` command below.
pub mod brush;
// `pub` for examples/detect_pages.rs, the headless Detect scripts call.
pub mod detect;
mod durability;
mod trash;
mod font_coverage;
mod font_decode;
// The Font Library's window and its marketplace downloads.
mod font_library;
// Linux-only at runtime; compiled under `test` everywhere so its unit tests
// run on the Mac too (the code is plain POSIX).
#[cfg(any(target_os = "linux", test))]
mod linux;
mod memory;
mod screen_color;
mod system_fonts;

/// Command-line flag that makes the binary probe one execution provider and
/// exit instead of starting the app. It takes the provider's name as its
/// argument; see `detect::accel::probe_isolated`.
pub const PROBE_FLAG: &str = detect::accel::PROBE_FLAG;

/// The child side of the device probe. Nothing but the ONNX provider
/// registration runs here, so a driver that aborts takes only this process -
/// and only the one rung it was asked about, which is why the rung to try is
/// an argument rather than the whole ladder.
pub fn probe_device_main(rung: &str) {
  println!("{}", detect::accel::probe_rung(rung));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  #[cfg(target_os = "linux")]
  linux::prepare();
  tauri::Builder::default()
    // First, as the plugin asks. Two copies of the app autosaving the same
    // chapter.json would each write over the other's work (SAV-2), so a second
    // launch only brings the window that is already open to the front.
    .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
      use tauri::Manager;
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
      }
    }))
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_opener::init())
    // In-process ONNX engine for detection and OCR.
    .manage(detect::engine::DetectEngine::new(detect::engine::default_models_dir()))
    .invoke_handler(tauri::generate_handler![
      detect::engine::detect_analyze,
      detect::engine::detect_read_drawing,
      detect::engine::detect_models_cache,
      detect::engine::detect_models_cache_clear,
      detect::engine::detect_health,
      brush::brush_import,
      memory::process_memory,
      screen_color::pick_screen_color,
      system_fonts::system_fonts,
      system_fonts::system_font_face,
      font_coverage::system_font_coverage,
      font_decode::font_to_sfnt,
      font_library::font_library_open,
      font_library::font_library_close,
      font_library::font_fetch,
      durability::fsync_path,
      trash::trash_path,
      agent_mcp::agent_door_start,
      agent_mcp::agent_door_stop,
      agent_mcp::agent_door_status,
      agent_mcp::agent_tools_set,
      agent_mcp::agent_result,
      agent_mcp::agent_window_role,
      agent_mcp::chapter_claim,
      agent_mcp::chapter_sync,
      agent_mcp::chapter_windows,
      agent_mcp::record_lock,
      agent_mcp::record_unlock,
      agent_mcp::agent_window_open,
      agent_mcp::agent_window_ready,
      agent_mcp::agent_window_close,
      agent_mcp::agent_windows_close,
      ai_api::ai_key_status,
      ai_api::ai_key_set,
      ai_api::ai_key_clear,
      ai_api::ai_request,
      ai_api::ai_abort,
      app_icon::set_theme_icon,
      data_folder::data_folder_status,
      data_folder::data_folder_inspect,
      data_folder::data_folder_default_root,
      data_folder::data_folder_move_busy,
      data_folder::data_folder_cleaner_running,
      data_folder::data_folder_open,
      data_folder::data_folder_release,
      data_folder::data_folder_setup,
      data_folder::data_folder_adopt,
      data_folder::data_folder_move,
      data_folder::data_folder_use_existing,
      data_folder::data_folder_delete_old,
      data_folder::data_folder_size,
      data_folder::data_folder_sister,
      data_folder::data_folder_quiet_setup,
      data_folder::data_folder_plan,
      data_folder::data_folder_progress,
      data_folder::data_folder_reveal,
      handoff::handoff_list,
      handoff::handoff_recover,
      handoff::handoff_claim,
      handoff::handoff_read,
      handoff::handoff_take,
      handoff::handoff_give_back,
      handoff::handoff_same,
      handoff::handoff_put_back,
      handoff::handoff_reject,
      handoff::handoff_done,
      handoff::handoff_scan,
      handoff::handoff_peek,
      handoff::handoff_facts,
      handoff::handoff_content_scan,
      handoff::handoff_share_raw
    ])
    .manage(agent_mcp::AgentDoor::default())
    .manage(ai_api::AiApi::default())
    .manage(data_folder::DataFolderState::default())
    // A window gone frees the chapters it held (agent_mcp.rs).
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::Destroyed = event {
        use tauri::Manager;
        window.state::<agent_mcp::AgentDoor>().forget_window(window.label());
      }
    })
    .setup(|app| {
      {
        use tauri::Manager;
        app.state::<agent_mcp::AgentDoor>().set_app(app.handle().clone());
      }
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
  use std::path::Path;

  /// `asset://` and the fs plugin are two scopes that share nothing, so the
  /// same deny list is written twice - once in `tauri.conf.json` under
  /// `app.security.assetProtocol.scope`, once in `capabilities/default.json`
  /// under `fs:scope`. A path denied in one and forgotten in the other is
  /// still reachable, and nothing about editing one file makes the other
  /// obvious, so the invariant is asserted rather than left as a comment.
  #[test]
  fn the_two_scope_deny_lists_are_identical() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let read = |p: &str| -> serde_json::Value {
      serde_json::from_str(&std::fs::read_to_string(root.join(p)).expect(p)).expect(p)
    };

    let asset = read("tauri.conf.json")["app"]["security"]["assetProtocol"]["scope"].clone();
    let fs = read("capabilities/default.json")["permissions"]
      .as_array()
      .expect("permissions is a list")
      .iter()
      .find(|p| p["identifier"] == "fs:scope")
      .cloned()
      .expect("capabilities/default.json declares an fs:scope permission");

    // The fs entries are `{ "path": "..." }` objects; the asset ones are bare
    // strings. Compare what they mean, not how each file spells it.
    let paths = |v: &serde_json::Value| -> Vec<String> {
      v.as_array()
        .map(|list| {
          list
            .iter()
            .map(|e| e.get("path").unwrap_or(e).as_str().unwrap_or_default().to_string())
            .collect()
        })
        .unwrap_or_default()
    };

    for list in ["allow", "deny"] {
      let a = paths(&asset[list]);
      let f = paths(&fs[list]);
      assert!(!a.is_empty(), "the asset protocol {list} list is empty");
      assert_eq!(
        a, f,
        "the asset:// and fs:scope {list} lists have drifted apart; edit both"
      );
    }
  }
}
