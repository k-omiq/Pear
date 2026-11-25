//! The shared data folder (SHARED_DATA_FOLDER.md at the repository root).
//!
//! One folder holds the user data of this app and of Manga Cleaner. Both find
//! it through a small pointer file in the OS config directory, both hold an
//! advisory lock under `<root>/.locks/` while they run, and either can move the
//! whole folder while the other is closed. This module is the disk half of
//! that contract: the pointer, the locks, the move, and the scope grant that
//! lets the webview reach a data folder outside the home directory.
//!
//! Every command takes paths from the webview, so each one checks what it is
//! pointed at before it touches anything: a move needs a source that looks
//! like a library and a target that is empty or absent.

use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Overrides where the pointer file lives (a full file path). Tests use it.
pub const POINTER_ENV: &str = "MANGA_LIBRARY_POINTER";
/// Bundle identifiers of the two release apps. Every other build (the
/// side-by-side test build, a dev build) uses the `-dev` pointer directory so
/// it never touches the real folder.
const RELEASE_IDS: [&str; 2] = ["com.mangacleaner.studio", "com.mangatypesetter.app"];
pub const MARKER: &str = "manga-library.json";
const POINTER_NAME: &str = "data-folder.json";
const OWN_LOCK: &str = "typesetter.lock";
const OTHER_LOCK: &str = "cleaner.lock";

// ---------- the pointer ----------

/// The pointer directory's name for a bundle identifier.
pub fn pointer_dir_name(identifier: &str) -> &'static str {
    if RELEASE_IDS.contains(&identifier) {
        "MangaLibrary"
    } else {
        "MangaLibrary-dev"
    }
}

/// Where the pointer file is: the env override when set and not empty, else
/// `<config dir>/<MangaLibrary or MangaLibrary-dev>/data-folder.json`.
pub fn pointer_file(config_dir: &Path, identifier: &str, env: Option<&str>) -> PathBuf {
    match env {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => config_dir.join(pointer_dir_name(identifier)).join(POINTER_NAME),
    }
}

#[derive(Serialize, Deserialize)]
struct PointerJson {
    schema: u32,
    path: String,
}

/// The data folder the pointer names. `Ok(None)` when there is no pointer
/// file (legacy mode). A pointer that cannot be read or parsed is an error, so
/// the app can say so instead of quietly running on its old location.
pub fn read_pointer(file: &Path) -> Result<Option<String>, String> {
    let text = match fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Could not read {}: {e}", file.display())),
    };
    let p: PointerJson =
        serde_json::from_str(&text).map_err(|e| format!("{} is not a valid pointer: {e}", file.display()))?;
    if p.schema != 1 {
        return Err(format!("{} has schema {}, this app reads schema 1", file.display(), p.schema));
    }
    if p.path.trim().is_empty() || !Path::new(&p.path).is_absolute() {
        return Err(format!("{} does not name an absolute folder", file.display()));
    }
    Ok(Some(p.path))
}

/// Writes the pointer atomically: a temp file in the same directory, flushed,
/// then renamed over the pointer.
pub fn write_pointer(file: &Path, root: &str) -> Result<(), String> {
    if !Path::new(root).is_absolute() {
        return Err("The data folder must be an absolute path".into());
    }
    let dir = file.parent().ok_or("The pointer file has no folder")?;
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let text = serde_json::to_string_pretty(&PointerJson { schema: 1, path: root.to_string() })
        .map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".{POINTER_NAME}.{}.{}.tmp", std::process::id(), nanos()));
    let result = (|| {
        let mut f = File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
        drop(f);
        fs::rename(&tmp, file).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|e| format!("Could not write {}: {e}", file.display()))
}

fn nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

// ---------- the marker ----------

/// RFC 3339 UTC for a Unix time, without a date crate (civil-from-days).
fn rfc3339(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Creates the root, `.locks/` and `.handoff/`, and the marker when missing.
pub fn prepare_root(root: &Path) -> Result<(), String> {
    if !root.is_absolute() {
        return Err("The data folder must be an absolute path".into());
    }
    for d in [root.to_path_buf(), root.join(".locks"), root.join(".handoff")] {
        fs::create_dir_all(&d).map_err(|e| format!("Could not create {}: {e}", d.display()))?;
    }
    let marker = root.join(MARKER);
    if !marker.exists() {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let text = serde_json::json!({ "schema": 1, "createdBy": "pear", "createdAt": rfc3339(secs) });
        fs::write(&marker, serde_json::to_string_pretty(&text).unwrap_or_default())
            .map_err(|e| format!("Could not write {}: {e}", marker.display()))?;
    }
    Ok(())
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub exists: bool,
    pub is_dir: bool,
    /// An existing directory with nothing in it.
    pub empty: bool,
    /// Holds `manga-library.json`: a data folder already.
    pub marker: bool,
}

pub fn inspect(path: &Path) -> FolderInfo {
    let meta = fs::metadata(path).ok();
    let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
    let empty = is_dir && fs::read_dir(path).map(|mut r| r.next().is_none()).unwrap_or(false);
    FolderInfo {
        exists: meta.is_some(),
        is_dir,
        empty,
        marker: is_dir && path.join(MARKER).is_file(),
    }
}

// ---------- the locks ----------

/// Takes `<root>/.locks/<name>` without waiting. `Ok(None)` when another
/// process holds it.
pub fn take_lock(root: &Path, name: &str) -> Result<Option<File>, String> {
    let dir = root.join(".locks");
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let path = dir.join(name);
    let f = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    match f.try_lock() {
        Ok(()) => Ok(Some(f)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(e)) => Err(format!("Could not lock {}: {e}", path.display())),
    }
}

/// Whether another process holds `<root>/.locks/<name>`: try to take it, and
/// let it go at once if that worked. A lock file that does not exist is free.
pub fn lock_is_held(root: &Path, name: &str) -> Result<bool, String> {
    let path = root.join(".locks").join(name);
    let f = match OpenOptions::new().read(true).write(true).open(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("Could not open {}: {e}", path.display())),
    };
    match f.try_lock() {
        Ok(()) => {
            let _ = f.unlock();
            Ok(false)
        }
        Err(std::fs::TryLockError::WouldBlock) => Ok(true),
        Err(std::fs::TryLockError::Error(e)) => Err(format!("Could not test {}: {e}", path.display())),
    }
}

/// The lock this process holds on its own `.locks/typesetter.lock`, for as
/// long as it runs with that root. Dropping the `File` releases it.
#[derive(Default)]
pub struct DataFolderState {
    held: Mutex<Option<(PathBuf, File)>>,
}

impl DataFolderState {
    fn hold(&self, root: &Path) -> Result<(), String> {
        let mut held = self.held.lock().map_err(|_| "lock state poisoned")?;
        if held.as_ref().is_some_and(|(r, _)| r == root) {
            return Ok(());
        }
        // Let the old root go first: taking the same file twice in one
        // process would refuse itself.
        *held = None;
        match take_lock(root, OWN_LOCK)? {
            Some(f) => {
                *held = Some((root.to_path_buf(), f));
                Ok(())
            }
            None => Err("Another copy of the typesetter is using this data folder.".into()),
        }
    }

    fn release(&self) {
        if let Ok(mut held) = self.held.lock() {
            *held = None;
        }
    }
}

// ---------- the move ----------

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MoveReport {
    /// "rename" (one rename on the same volume) or "copy" (copied, checked,
    /// then the old tree deleted).
    pub method: &'static str,
    /// The old tree, when it could not be deleted after a verified copy.
    pub leftover: Option<String>,
}

/// Is `inner` the same as or inside `outer`? Both are compared after
/// resolving as much of each as exists, so `..` and symlinks cannot hide it.
fn contains(outer: &Path, inner: &Path) -> bool {
    let resolve = |p: &Path| -> PathBuf {
        let mut cur = p.to_path_buf();
        let mut tail = Vec::new();
        loop {
            if let Ok(c) = cur.canonicalize() {
                let mut out = c;
                for t in tail.iter().rev() {
                    out.push(t);
                }
                return out;
            }
            match (cur.file_name().map(|s| s.to_os_string()), cur.parent()) {
                (Some(name), Some(parent)) => {
                    tail.push(name);
                    cur = parent.to_path_buf();
                }
                _ => return p.to_path_buf(),
            }
        }
    };
    resolve(inner).starts_with(resolve(outer))
}

/// A source the move may take: a data folder (marker), a typesetter library
/// (a project folder in it), or an empty folder. Never an arbitrary tree.
fn movable_source(from: &Path) -> Result<(), String> {
    if !from.is_absolute() {
        return Err("The folder to move must be an absolute path".into());
    }
    let meta = fs::symlink_metadata(from).map_err(|e| format!("Could not read {}: {e}", from.display()))?;
    if !meta.is_dir() {
        return Err(format!("{} is not a folder", from.display()));
    }
    if from.parent().is_none() {
        return Err("A whole disk cannot be moved".into());
    }
    if from.join(MARKER).is_file() {
        return Ok(());
    }
    let mut entries = fs::read_dir(from).map_err(|e| e.to_string())?.flatten().peekable();
    if entries.peek().is_none() {
        return Ok(());
    }
    if entries.any(|e| e.path().join("project.json").is_file()) {
        return Ok(());
    }
    Err(format!("{} does not look like a library, so it was not moved", from.display()))
}

fn walk(root: &Path, rel: &Path, out: &mut Vec<(PathBuf, u64, bool)>) -> Result<(), String> {
    let dir = root.join(rel);
    for e in fs::read_dir(&dir).map_err(|e| format!("Could not read {}: {e}", dir.display()))? {
        let e = e.map_err(|e| e.to_string())?;
        let meta = fs::symlink_metadata(e.path()).map_err(|e| e.to_string())?;
        let r = rel.join(e.file_name());
        if meta.is_dir() {
            out.push((r.clone(), 0, true));
            walk(root, &r, out)?;
        } else {
            out.push((r, meta.len(), false));
        }
    }
    Ok(())
}

fn copy_tree(from: &Path, to: &Path) -> Result<Vec<(PathBuf, u64, bool)>, String> {
    let mut list = Vec::new();
    walk(from, Path::new(""), &mut list)?;
    fs::create_dir_all(to).map_err(|e| format!("Could not create {}: {e}", to.display()))?;
    for (rel, _, is_dir) in &list {
        let (src, dst) = (from.join(rel), to.join(rel));
        if *is_dir {
            fs::create_dir_all(&dst).map_err(|e| format!("Could not create {}: {e}", dst.display()))?;
            continue;
        }
        let meta = fs::symlink_metadata(&src).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            #[cfg(unix)]
            {
                let target = fs::read_link(&src).map_err(|e| e.to_string())?;
                std::os::unix::fs::symlink(target, &dst).map_err(|e| e.to_string())?;
                continue;
            }
            #[cfg(not(unix))]
            return Err(format!("{} is a link; move the folder by hand", src.display()));
        }
        fs::copy(&src, &dst).map_err(|e| format!("Could not copy {}: {e}", src.display()))?;
    }
    Ok(list)
}

/// Same file count and every file's size, or the copy is not trusted.
fn verify_copy(expected: &[(PathBuf, u64, bool)], copy: &Path) -> Result<(), String> {
    let mut found = Vec::new();
    walk(copy, Path::new(""), &mut found)?;
    if found.len() != expected.len() {
        return Err(format!("The copy has {} items, the original {}", found.len(), expected.len()));
    }
    for (rel, size, is_dir) in expected {
        if *is_dir {
            if !copy.join(rel).is_dir() {
                return Err(format!("The copy is missing the folder {}", rel.display()));
            }
            continue;
        }
        let meta = fs::symlink_metadata(copy.join(rel))
            .map_err(|_| format!("The copy is missing {}", rel.display()))?;
        if !meta.file_type().is_symlink() && meta.len() != *size {
            return Err(format!("{} has a different size in the copy", rel.display()));
        }
    }
    Ok(())
}

/// Moves the tree at `from` to `to`, then calls `commit` (the pointer write),
/// then, on the copy path, deletes the old tree.
///
/// Same volume: one rename. Other volume (or `force_copy`, the tests' way to
/// take that path on one disk): copy into `<to>.partial`, check every file's
/// size and the count, rename it to `to`, commit, delete `from`. A failure
/// before `commit` succeeds leaves `from` as it was and removes the copy.
pub fn move_tree(
    from: &Path,
    to: &Path,
    force_copy: bool,
    commit: impl FnOnce() -> Result<(), String>,
) -> Result<MoveReport, String> {
    movable_source(from)?;
    if !to.is_absolute() {
        return Err("The new place must be an absolute path".into());
    }
    if contains(from, to) {
        return Err("The new place cannot be inside the folder being moved".into());
    }
    if contains(to, from) {
        return Err("The new place cannot hold the folder being moved".into());
    }
    let info = inspect(to);
    if info.exists && !(info.is_dir && info.empty) {
        return Err(format!("{} is not empty", to.display()));
    }
    let parent = to.parent().ok_or("The new place has no parent folder")?;
    fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    // An empty target is replaced: a rename onto a directory fails on Windows.
    let had_empty = info.exists;
    if had_empty {
        fs::remove_dir(to).map_err(|e| format!("Could not use {}: {e}", to.display()))?;
    }
    let restore_empty = || {
        if had_empty {
            let _ = fs::create_dir(to);
        }
    };

    if !force_copy {
        match fs::rename(from, to) {
            Ok(()) => {
                if let Err(e) = commit() {
                    let _ = fs::rename(to, from);
                    restore_empty();
                    return Err(e);
                }
                return Ok(MoveReport { method: "rename", leftover: None });
            }
            Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {}
            Err(e) => {
                restore_empty();
                return Err(format!("Could not move {}: {e}", from.display()));
            }
        }
    }

    let mut partial = to.as_os_str().to_os_string();
    partial.push(".partial");
    let partial = PathBuf::from(partial);
    if fs::symlink_metadata(&partial).is_ok() {
        restore_empty();
        return Err(format!("{} is in the way; remove it and try again", partial.display()));
    }
    let checked = copy_tree(from, &partial).and_then(|list| verify_copy(&list, &partial));
    if let Err(e) = checked {
        let _ = fs::remove_dir_all(&partial);
        restore_empty();
        return Err(e);
    }
    if let Err(e) = fs::rename(&partial, to) {
        let _ = fs::remove_dir_all(&partial);
        restore_empty();
        return Err(format!("Could not finish the copy: {e}"));
    }
    if let Err(e) = commit() {
        let _ = fs::remove_dir_all(to);
        restore_empty();
        return Err(e);
    }
    let leftover = fs::remove_dir_all(from).err().map(|_| from.display().to_string());
    Ok(MoveReport { method: "copy", leftover })
}

// ---------- commands ----------

fn pointer_file_for<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    use tauri::Manager;
    let env = std::env::var(POINTER_ENV).ok();
    let config = app.path().config_dir().map_err(|e| e.to_string())?;
    Ok(pointer_file(&config, &app.config().identifier, env.as_deref()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PointerInfo {
    /// Where the pointer file is (or would be).
    pub file: String,
    /// The data folder it names, when there is one.
    pub path: Option<String>,
    /// Why a pointer that exists could not be used.
    pub error: Option<String>,
}

#[tauri::command]
pub fn data_folder_pointer<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<PointerInfo, String> {
    let file = pointer_file_for(&app)?;
    let (path, error) = match read_pointer(&file) {
        Ok(p) => (p, None),
        Err(e) => (None, Some(e)),
    };
    Ok(PointerInfo { file: file.display().to_string(), path, error })
}

#[tauri::command]
pub fn data_folder_set_pointer<R: tauri::Runtime>(app: tauri::AppHandle<R>, path: String) -> Result<(), String> {
    write_pointer(&pointer_file_for(&app)?, &path)
}

#[tauri::command]
pub fn data_folder_inspect(path: String) -> FolderInfo {
    inspect(Path::new(&path))
}

#[tauri::command]
pub fn data_folder_prepare(root: String) -> Result<(), String> {
    prepare_root(Path::new(&root))
}

/// Grants the webview the data folder (fs plugin and asset protocol, so a
/// folder outside the home directory works; the deny lists in the capability
/// and in tauri.conf.json are checked first and still win) and takes this
/// app's lock on it for as long as the process runs.
#[tauri::command]
pub fn data_folder_open<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, DataFolderState>,
    root: String,
) -> Result<(), String> {
    use tauri::Manager;
    use tauri_plugin_fs::FsExt;
    let root = PathBuf::from(root);
    if !root.is_absolute() || root.parent().is_none() {
        return Err("The data folder must be an absolute folder, not a whole disk".into());
    }
    fs::create_dir_all(&root).map_err(|e| format!("Could not create {}: {e}", root.display()))?;
    app.fs_scope().allow_directory(&root, true).map_err(|e| e.to_string())?;
    app.asset_protocol_scope().allow_directory(&root, true).map_err(|e| e.to_string())?;
    state.hold(&root)
}

#[tauri::command]
pub fn data_folder_release(state: tauri::State<'_, DataFolderState>) {
    state.release();
}

#[tauri::command]
pub fn data_folder_cleaner_running(root: String) -> Result<bool, String> {
    lock_is_held(Path::new(&root), OTHER_LOCK)
}

/// Moves `from` to `to`. With `pointer`, the pointer is written to name that
/// folder once the tree is in place, before the old copy is deleted. Refused
/// while the cleaner holds its lock in `from`. This app's own lock is let go
/// for the move; the caller opens the new root afterwards.
#[tauri::command]
pub async fn data_folder_move<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, DataFolderState>,
    from: String,
    to: String,
    pointer: Option<String>,
) -> Result<MoveReport, String> {
    let (from, to) = (PathBuf::from(from), PathBuf::from(to));
    if lock_is_held(&from, OTHER_LOCK)? {
        return Err("Manga Cleaner is open. Close it first.".into());
    }
    let file = pointer_file_for(&app)?;
    state.release();
    tauri::async_runtime::spawn_blocking(move || {
        move_tree(&from, &to, false, || match &pointer {
            Some(p) => write_pointer(&file, p),
            None => Ok(()),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mt-data-folder-{name}-{}-{}", std::process::id(), nanos()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn pointer_location_follows_identifier_and_env() {
        let cfg = Path::new("/cfg");
        assert_eq!(
            pointer_file(cfg, "com.mangatypesetter.app", None),
            PathBuf::from("/cfg/MangaLibrary/data-folder.json")
        );
        assert_eq!(
            pointer_file(cfg, "com.mangacleaner.studio", None),
            PathBuf::from("/cfg/MangaLibrary/data-folder.json")
        );
        assert_eq!(
            pointer_file(cfg, "com.mangatypesetter.rust", None),
            PathBuf::from("/cfg/MangaLibrary-dev/data-folder.json")
        );
        assert_eq!(pointer_file(cfg, "com.mangatypesetter.app", Some("/x/p.json")), PathBuf::from("/x/p.json"));
        assert_eq!(
            pointer_file(cfg, "com.mangatypesetter.app", Some("  ")),
            PathBuf::from("/cfg/MangaLibrary/data-folder.json")
        );
    }

    #[test]
    fn pointer_round_trips_atomically() {
        let d = scratch("pointer");
        let file = d.join("nested").join("data-folder.json");
        assert_eq!(read_pointer(&file).unwrap(), None);
        write_pointer(&file, "/Users/me/Documents/Manga Library").unwrap();
        assert_eq!(read_pointer(&file).unwrap().as_deref(), Some("/Users/me/Documents/Manga Library"));
        let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(json["schema"], 1);
        write_pointer(&file, "/Volumes/Big/Manga Library").unwrap();
        assert_eq!(read_pointer(&file).unwrap().as_deref(), Some("/Volumes/Big/Manga Library"));
        // No temp file is left beside it.
        let names: Vec<_> = fs::read_dir(file.parent().unwrap()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(names.len(), 1);
        assert!(write_pointer(&file, "relative/path").is_err());
        fs::write(&file, "{ not json").unwrap();
        assert!(read_pointer(&file).is_err());
        fs::write(&file, r#"{"schema":2,"path":"/x"}"#).unwrap();
        assert!(read_pointer(&file).is_err());
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn prepare_writes_marker_once() {
        let d = scratch("prepare");
        let root = d.join("Manga Library");
        prepare_root(&root).unwrap();
        assert!(root.join(".locks").is_dir() && root.join(".handoff").is_dir());
        let first = fs::read_to_string(root.join(MARKER)).unwrap();
        let json: serde_json::Value = serde_json::from_str(&first).unwrap();
        assert_eq!(json["createdBy"], "pear");
        assert!(json["createdAt"].as_str().unwrap().ends_with('Z'));
        prepare_root(&root).unwrap();
        assert_eq!(fs::read_to_string(root.join(MARKER)).unwrap(), first);
        assert!(inspect(&root).marker);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn rfc3339_formats_known_dates() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_764_064_800), "2025-11-25T10:00:00Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn lock_is_seen_held_and_free() {
        let root = scratch("lock");
        assert!(!lock_is_held(&root, "cleaner.lock").unwrap(), "a missing lock file is free");
        let held = take_lock(&root, "cleaner.lock").unwrap().expect("free lock is taken");
        assert!(lock_is_held(&root, "cleaner.lock").unwrap());
        assert!(take_lock(&root, "cleaner.lock").unwrap().is_none(), "a held lock is refused");
        // Testing does not take it.
        assert!(lock_is_held(&root, "cleaner.lock").unwrap());
        drop(held);
        assert!(!lock_is_held(&root, "cleaner.lock").unwrap());

        let state = DataFolderState::default();
        state.hold(&root).unwrap();
        assert!(lock_is_held(&root, OWN_LOCK).unwrap());
        state.hold(&root).unwrap();
        state.release();
        assert!(!lock_is_held(&root, OWN_LOCK).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    fn library_tree(at: &Path) {
        fs::create_dir_all(at.join("Series").join("001").join("raws")).unwrap();
        fs::write(at.join("Series").join("project.json"), "{}").unwrap();
        fs::write(at.join("Series").join("001").join("chapter.json"), "{\"pages\":[]}").unwrap();
        fs::write(at.join("Series").join("001").join("raws").join("001.png"), vec![7u8; 4096]).unwrap();
    }

    fn assert_tree(at: &Path) {
        assert_eq!(fs::read(at.join("Series").join("001").join("raws").join("001.png")).unwrap(), vec![7u8; 4096]);
        assert!(at.join("Series").join("project.json").is_file());
    }

    #[test]
    fn move_renames_on_one_volume_and_commits() {
        let d = scratch("move-rename");
        let from = d.join("MangaTypesetter");
        library_tree(&from);
        let to = d.join("Manga Library").join("Typesetter");
        let mut committed = false;
        let r = move_tree(&from, &to, false, || {
            committed = true;
            Ok(())
        })
        .unwrap();
        assert_eq!(r, MoveReport { method: "rename", leftover: None });
        assert!(committed);
        assert!(!from.exists());
        assert_tree(&to);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn move_copies_across_volumes_then_deletes_the_old_tree() {
        let d = scratch("move-copy");
        let from = d.join("old");
        library_tree(&from);
        fs::write(from.join(MARKER), "{}").unwrap();
        let to = d.join("new");
        fs::create_dir_all(&to).unwrap(); // an empty target is fine
        let pointer = d.join("ptr").join("data-folder.json");
        let r = move_tree(&from, &to, true, || write_pointer(&pointer, &to.display().to_string())).unwrap();
        assert_eq!(r, MoveReport { method: "copy", leftover: None });
        assert!(!from.exists());
        assert!(!d.join("new.partial").exists());
        assert_tree(&to);
        assert_eq!(read_pointer(&pointer).unwrap(), Some(to.display().to_string()));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_failed_commit_leaves_everything_as_it_was() {
        let d = scratch("move-fail");
        for force_copy in [false, true] {
            let from = d.join(format!("old-{force_copy}"));
            library_tree(&from);
            let to = d.join(format!("new-{force_copy}"));
            let err = move_tree(&from, &to, force_copy, || Err("pointer refused".into())).unwrap_err();
            assert_eq!(err, "pointer refused");
            assert_tree(&from);
            assert!(!to.exists());
            assert!(!d.join(format!("new-{force_copy}.partial")).exists());
        }
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn move_refuses_bad_sources_and_targets() {
        let d = scratch("move-refuse");
        let from = d.join("lib");
        library_tree(&from);
        let ok = || Ok(());
        // A target with something in it.
        let full = d.join("full");
        fs::create_dir_all(&full).unwrap();
        fs::write(full.join("x.txt"), "x").unwrap();
        assert!(move_tree(&from, &full, false, ok).is_err());
        // Inside itself.
        assert!(move_tree(&from, &from.join("inner"), true, ok).is_err());
        // Not a library.
        let random = d.join("random");
        fs::create_dir_all(&random).unwrap();
        fs::write(random.join("notes.txt"), "x").unwrap();
        assert!(move_tree(&random, &d.join("elsewhere"), false, ok).is_err());
        // A partial copy in the way is not deleted.
        fs::create_dir_all(d.join("dest.partial")).unwrap();
        fs::write(d.join("dest.partial").join("keep.txt"), "x").unwrap();
        assert!(move_tree(&from, &d.join("dest"), true, ok).is_err());
        assert!(d.join("dest.partial").join("keep.txt").is_file());
        assert_tree(&from);
        fs::remove_dir_all(d).unwrap();
    }
}
