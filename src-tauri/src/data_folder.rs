//! The shared data folder (SHARED_DATA_FOLDER.md at the repository root).
//!
//! One folder holds the user data of this app and of Manga Cleaner. Both find
//! it through a pointer file in a state directory that never moves, both hold
//! an advisory lock under `<root>/locks/` while they run, and either can set
//! the folder up or move it while the other is closed, under `move.lock`
//! beside the pointer and with a journal there, so a crash at any point is
//! recovered at the next start.
//!
//! Every command takes paths from the webview, so each one checks what it is
//! pointed at before it touches anything. Only setup and move create folders:
//! nothing else here makes the data folder, so an unplugged drive never gets a
//! new, empty library in its place.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Overrides where the pointer file lives (a full file path); `move.lock` and
/// the journal go beside it. Tests use it.
pub const POINTER_ENV: &str = "MANGA_LIBRARY_POINTER";
/// Bundle identifiers of the two release apps. Every other build uses the
/// `-dev` directory so it never touches the real folder.
const RELEASE_IDS: [&str; 2] = ["com.mangacleaner.studio", "com.mangatypesetter.app"];
pub const MARKER: &str = "manga-library.json";
pub const SUBFOLDER: &str = "Typesetter";
/// This app's library file inside `Typesetter/`: what says the subfolder is a
/// library and not an empty folder someone made (contract section 5).
pub const LIBRARY_FILE: &str = "library.json";
const POINTER_NAME: &str = "data-folder.json";
const MOVE_LOCK: &str = "move.lock";
const JOURNAL: &str = "move-journal.json";
pub const OWN_LOCK: &str = "typesetter.lock";
pub const OTHER_LOCK: &str = "cleaner.lock";

// ---------- small helpers ----------

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Civil date and time (UTC) for a Unix time, without a date crate.
fn civil(secs: u64) -> (i64, i64, i64, u64, u64, u64) {
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
    (y, m, d, rem / 3600, (rem % 3600) / 60, rem % 60)
}

pub fn rfc3339(secs: u64) -> String {
    let (y, m, d, hh, mm, ss) = civil(secs);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// `2026-11-25-1000`: a date for folder names (old copies, rejected messages).
pub fn stamp(secs: u64) -> String {
    let (y, m, d, hh, mm, _) = civil(secs);
    format!("{y:04}-{m:02}-{d:02}-{hh:02}{mm:02}")
}

/// A random UUID (version 4 layout). Not for secrets: an id that has to be
/// different on every machine and every setup.
pub fn new_uuid() -> String {
    use std::hash::{BuildHasher, Hasher};
    let word = |salt: u64| {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(nanos());
        h.write_u32(std::process::id());
        h.write_u64(salt);
        h.finish()
    };
    let (a, b) = (word(1), word(2));
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&a.to_le_bytes());
    bytes[8..].copy_from_slice(&b.to_le_bytes());
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let h: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// A name for something new: `base`, else `base-2`, `base-3`...
pub fn free_name(base: &Path) -> PathBuf {
    if fs::symlink_metadata(base).is_err() {
        return base.to_path_buf();
    }
    let mut i = 2u32;
    loop {
        let mut s = base.as_os_str().to_os_string();
        s.push(format!("-{i}"));
        let p = PathBuf::from(s);
        if fs::symlink_metadata(&p).is_err() {
            return p;
        }
        i += 1;
    }
}

pub fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(f) = File::open(dir) {
        let _ = f.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// Temp file in the same folder, flushed, renamed over, folder flushed.
pub fn write_atomic(file: &Path, text: &str) -> Result<(), String> {
    let dir = file.parent().ok_or("The file has no folder")?;
    let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = dir.join(format!("{name}.{}.{}.tmp", std::process::id(), nanos()));
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
    sync_dir(dir);
    result.map_err(|e| format!("Could not write {}: {e}", file.display()))
}

// ---------- where things are ----------

/// The state directory's name for a bundle identifier.
pub fn state_dir_name(identifier: &str) -> &'static str {
    if RELEASE_IDS.contains(&identifier) {
        "MangaLibrary"
    } else {
        "MangaLibrary-dev"
    }
}

/// The pointer file: the env override when set and not empty, else
/// `<app state dir>/<MangaLibrary or MangaLibrary-dev>/data-folder.json`.
pub fn pointer_file(state_base: &Path, identifier: &str, env: Option<&str>) -> PathBuf {
    match env {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => state_base.join(state_dir_name(identifier)).join(POINTER_NAME),
    }
}

/// The pointer and the files beside it.
#[derive(Clone, Debug)]
pub struct Paths {
    pub pointer: PathBuf,
}

impl Paths {
    pub fn dir(&self) -> PathBuf {
        self.pointer.parent().map(Path::to_path_buf).unwrap_or_default()
    }
    pub fn move_lock(&self) -> PathBuf {
        self.dir().join(MOVE_LOCK)
    }
    pub fn journal(&self) -> PathBuf {
        self.dir().join(JOURNAL)
    }
}

// ---------- the pointer ----------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pointer {
    pub schema: u32,
    pub path: String,
    pub folder_id: String,
}

#[derive(Debug, PartialEq)]
pub enum PointerRead {
    None,
    Ok(Pointer),
    /// A schema this app does not know: never overwritten.
    Newer(u64),
    Invalid(String),
}

pub fn read_pointer(file: &Path) -> PointerRead {
    let text = match fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return PointerRead::None,
        Err(e) => return PointerRead::Invalid(format!("Could not read {}: {e}", file.display())),
    };
    let v: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => return PointerRead::Invalid(format!("{} is not a valid pointer: {e}", file.display())),
    };
    match v["schema"].as_u64() {
        Some(1) => {}
        Some(n) if n > 1 => return PointerRead::Newer(n),
        _ => return PointerRead::Invalid(format!("{} has no schema", file.display())),
    }
    match serde_json::from_value::<Pointer>(v) {
        Ok(p) if Path::new(&p.path).is_absolute() && !p.folder_id.trim().is_empty() => PointerRead::Ok(p),
        Ok(_) => PointerRead::Invalid(format!("{} does not name an absolute folder and its id", file.display())),
        Err(e) => PointerRead::Invalid(format!("{} is not a valid pointer: {e}", file.display())),
    }
}

pub fn write_pointer(file: &Path, p: &Pointer) -> Result<(), String> {
    if !Path::new(&p.path).is_absolute() {
        return Err("The data folder must be an absolute path".into());
    }
    if let PointerRead::Newer(n) = read_pointer(file) {
        return Err(format!("The data folder was set up by a newer version (schema {n}); it is left as it is."));
    }
    let dir = file.parent().ok_or("The pointer file has no folder")?;
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    write_atomic(file, &serde_json::to_string_pretty(p).map_err(|e| e.to_string())?)
}

// ---------- the marker ----------

#[derive(Debug, PartialEq)]
pub enum MarkerRead {
    Missing,
    Ok(String),
    Newer(u64),
    Invalid(String),
}

pub fn read_marker(root: &Path) -> MarkerRead {
    let file = root.join(MARKER);
    let text = match fs::read_to_string(&file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return MarkerRead::Missing,
        Err(e) => return MarkerRead::Invalid(format!("Could not read {}: {e}", file.display())),
    };
    let v: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => return MarkerRead::Invalid(format!("{} is not valid: {e}", file.display())),
    };
    match (v["schema"].as_u64(), v["folderId"].as_str()) {
        (Some(1), Some(id)) if !id.trim().is_empty() => MarkerRead::Ok(id.to_string()),
        (Some(n), _) if n > 1 => MarkerRead::Newer(n),
        _ => MarkerRead::Invalid(format!("{} has no schema or folder id", file.display())),
    }
}

/// Writes a new marker into an existing root. Never creates the root.
fn write_marker(root: &Path, folder_id: &str) -> Result<(), String> {
    if !root.is_dir() {
        return Err(format!("{} does not exist", root.display()));
    }
    let v = serde_json::json!({ "schema": 1, "folderId": folder_id, "createdBy": "pear", "createdAt": rfc3339(now_secs()) });
    write_atomic(&root.join(MARKER), &serde_json::to_string_pretty(&v).unwrap_or_default())
}

fn write_library_file(dir: &Path) -> Result<(), String> {
    let v = serde_json::json!({ "schema": 1, "app": "pear" });
    write_atomic(&dir.join(LIBRARY_FILE), &serde_json::to_string_pretty(&v).unwrap_or_default())
}

// ---------- status ----------

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub pointer_file: String,
    pub pointer: Option<Pointer>,
    /// "none" (legacy), "ok", "missing", "noMarker", "idMismatch", "newer" or
    /// "invalid". Every state but "none" and "ok" is Unavailable mode.
    pub state: &'static str,
    pub detail: Option<String>,
    /// `<root>/Typesetter/library.json` is there.
    pub typesetter_ready: bool,
}

pub fn status(paths: &Paths) -> Status {
    let mut s = Status {
        pointer_file: paths.pointer.display().to_string(),
        pointer: None,
        state: "none",
        detail: None,
        typesetter_ready: false,
    };
    let p = match read_pointer(&paths.pointer) {
        PointerRead::None => return s,
        PointerRead::Newer(n) => {
            s.state = "newer";
            s.detail = Some(format!("The pointer was written by a newer version (schema {n})."));
            return s;
        }
        PointerRead::Invalid(e) => {
            s.state = "invalid";
            s.detail = Some(e);
            return s;
        }
        PointerRead::Ok(p) => p,
    };
    let root = PathBuf::from(&p.path);
    s.pointer = Some(p.clone());
    if !root.is_dir() {
        s.state = "missing";
        return s;
    }
    match read_marker(&root) {
        MarkerRead::Missing => s.state = "noMarker",
        MarkerRead::Invalid(e) => {
            s.state = "noMarker";
            s.detail = Some(e);
        }
        MarkerRead::Newer(n) => {
            s.state = "newer";
            s.detail = Some(format!("The data folder was set up by a newer version (schema {n})."));
        }
        MarkerRead::Ok(id) if id != p.folder_id => s.state = "idMismatch",
        MarkerRead::Ok(_) => {
            s.state = "ok";
            s.typesetter_ready = root.join(SUBFOLDER).join(LIBRARY_FILE).is_file();
        }
    }
    s
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub exists: bool,
    pub is_dir: bool,
    /// An existing directory with nothing in it.
    pub empty: bool,
    /// Holds a usable `manga-library.json`.
    pub marker: bool,
    pub folder_id: Option<String>,
    /// A known sync folder (contract section 7): say so before using it.
    pub sync_warning: Option<String>,
}

pub fn inspect(path: &Path, home: Option<&Path>) -> FolderInfo {
    let meta = fs::metadata(path).ok();
    let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
    let empty = is_dir && fs::read_dir(path).map(|mut r| r.next().is_none()).unwrap_or(false);
    let folder_id = match is_dir.then(|| read_marker(path)) {
        Some(MarkerRead::Ok(id)) => Some(id),
        _ => None,
    };
    FolderInfo {
        exists: meta.is_some(),
        is_dir,
        empty,
        marker: folder_id.is_some(),
        folder_id,
        sync_warning: sync_warning(path, home),
    }
}

/// Paths inside a folder that a sync service uploads and may evict.
pub fn sync_warning(path: &Path, home: Option<&Path>) -> Option<String> {
    let s = format!("{}/", path.to_string_lossy().replace('\\', "/"));
    for (needle, name) in [
        ("/Library/Mobile Documents/", "iCloud Drive"),
        ("/Library/CloudStorage/", "a cloud storage folder"),
        ("/OneDrive", "OneDrive"),
        ("/Dropbox", "Dropbox"),
        ("/Google Drive", "Google Drive"),
    ] {
        if s.contains(needle) {
            return Some(format!(
                "This folder is in {name}. A synced library uploads gigabytes and can have files moved to the cloud, which breaks the shared folder."
            ));
        }
    }
    if cfg!(target_os = "macos") {
        if let Some(home) = home {
            if path.starts_with(home.join("Documents")) || path.starts_with(home.join("Desktop")) {
                return Some("Documents and Desktop are often synced by iCloud. A synced library uploads gigabytes and can have files moved to the cloud, which breaks the shared folder.".into());
            }
        }
    }
    None
}

// ---------- the locks ----------

/// Takes `<root>/locks/<name>` without waiting. `Ok(None)` when another
/// process holds it. The root must exist; only `locks/` may be created.
pub fn take_lock(root: &Path, name: &str) -> Result<Option<File>, String> {
    if !root.is_dir() {
        return Err(format!("The data folder is not there: {}", root.display()));
    }
    let dir = root.join("locks");
    if let Err(e) = fs::create_dir(&dir) {
        if e.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(format!("Could not create {}: {e}", dir.display()));
        }
    }
    try_lock_file(&dir.join(name))
}

fn try_lock_file(path: &Path) -> Result<Option<File>, String> {
    let f = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    match f.try_lock() {
        Ok(()) => Ok(Some(f)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(e)) => Err(format!("Could not lock {}: {e}", path.display())),
    }
}

/// Whether another process holds the lock file at `path`: try to take it and
/// let it go at once. `None` when this file system cannot tell. A missing
/// file is free.
pub fn lock_file_held(path: &Path) -> Option<bool> {
    let f = match OpenOptions::new().read(true).write(true).open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Some(false),
        Err(_) => return None,
    };
    match f.try_lock() {
        Ok(()) => {
            let _ = f.unlock();
            Some(false)
        }
        Err(std::fs::TryLockError::WouldBlock) => Some(true),
        Err(std::fs::TryLockError::Error(_)) => None,
    }
}

pub fn lock_is_held(root: &Path, name: &str) -> Option<bool> {
    lock_file_held(&root.join("locks").join(name))
}

/// The cleaner must be closed for a setup, an adopt or a move. A file system
/// that cannot tell is refused with a `CANNOT_TELL:` reason, and the caller
/// can pass `confirmed` once the user says the cleaner is closed.
fn refuse_if_cleaner(root: &Path, confirmed: bool) -> Result<(), String> {
    match lock_is_held(root, OTHER_LOCK) {
        Some(false) => Ok(()),
        Some(true) => Err("Manga Cleaner is open. Close it first.".into()),
        None if confirmed => Ok(()),
        None => Err("CANNOT_TELL: This drive cannot tell whether Manga Cleaner is open. Close it, then confirm.".into()),
    }
}

/// `move.lock` beside the pointer, for the whole of a setup, adopt or move.
pub fn take_move_lock(paths: &Paths) -> Result<File, String> {
    let dir = paths.dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    match try_lock_file(&paths.move_lock())? {
        Some(f) => Ok(f),
        None => Err("Manga Cleaner is setting up or moving the data folder. Try again when it finishes.".into()),
    }
}

/// The lock this process holds on its own `locks/typesetter.lock` while it
/// runs in Shared mode. Dropping the `File` releases it.
#[derive(Default)]
pub struct DataFolderState {
    held: Mutex<Option<(PathBuf, File)>>,
}

impl DataFolderState {
    pub fn hold(&self, root: &Path) -> Result<(), String> {
        let mut held = self.held.lock().map_err(|_| "lock state poisoned")?;
        if held.as_ref().is_some_and(|(r, _)| r == root) {
            return Ok(());
        }
        *held = None;
        match take_lock(root, OWN_LOCK)? {
            Some(f) => {
                *held = Some((root.to_path_buf(), f));
                Ok(())
            }
            None => Err("Another copy of the typesetter is using this data folder.".into()),
        }
    }

    pub fn release(&self) {
        if let Ok(mut held) = self.held.lock() {
            *held = None;
        }
    }
}

// ---------- the tree ----------

#[derive(Debug, Clone, PartialEq)]
pub enum Kind {
    Dir,
    File,
    Symlink,
}

#[derive(Debug, Clone)]
pub struct Item {
    pub rel: PathBuf,
    pub kind: Kind,
    pub size: u64,
    /// (device, inode) of a file with more than one link (unix).
    pub link: Option<(u64, u64)>,
}

pub struct Tree {
    pub items: Vec<Item>,
    /// Bytes on disk, each hard-linked file counted once.
    pub bytes: u64,
    /// Files that are only in the cloud.
    pub dataless: usize,
}

/// A file whose bytes are not on this disk: macOS SF_DATALESS, Windows
/// FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS.
pub fn is_dataless(meta: &fs::Metadata) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        const SF_DATALESS: u32 = 0x4000_0000;
        meta.st_flags() & SF_DATALESS != 0
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
        meta.file_attributes() & RECALL_ON_DATA_ACCESS != 0
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = meta;
        false
    }
}

#[cfg(unix)]
fn link_key(meta: &fs::Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    (meta.nlink() > 1).then(|| (meta.dev(), meta.ino()))
}
#[cfg(not(unix))]
fn link_key(_meta: &fs::Metadata) -> Option<(u64, u64)> {
    None
}

type Dataless<'a> = &'a dyn Fn(&fs::Metadata) -> bool;

fn walk(root: &Path, rel: &Path, tree: &mut Tree, seen: &mut std::collections::HashSet<(u64, u64)>, dataless: Dataless) -> Result<(), String> {
    let dir = root.join(rel);
    let mut entries: Vec<_> = fs::read_dir(&dir)
        .map_err(|e| format!("Could not read {}: {e}", dir.display()))?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let meta = fs::symlink_metadata(e.path()).map_err(|e| e.to_string())?;
        let r = rel.join(e.file_name());
        if meta.file_type().is_symlink() {
            tree.items.push(Item { rel: r, kind: Kind::Symlink, size: 0, link: None });
        } else if meta.is_dir() {
            tree.items.push(Item { rel: r.clone(), kind: Kind::Dir, size: 0, link: None });
            walk(root, &r, tree, seen, dataless)?;
        } else {
            let link = link_key(&meta);
            if link.is_none_or(|k| seen.insert(k)) {
                tree.bytes += meta.len();
            }
            if dataless(&meta) {
                tree.dataless += 1;
            }
            tree.items.push(Item { rel: r, kind: Kind::File, size: meta.len(), link });
        }
    }
    Ok(())
}

pub fn scan_tree(root: &Path, dataless: Dataless) -> Result<Tree, String> {
    let mut tree = Tree { items: Vec::new(), bytes: 0, dataless: 0 };
    let mut seen = std::collections::HashSet::new();
    walk(root, Path::new(""), &mut tree, &mut seen, dataless)?;
    Ok(tree)
}

/// Free bytes on the volume that holds `path` (or its nearest existing
/// ancestor). `None` where this build cannot ask (Windows for now).
pub fn free_space(path: &Path) -> Option<u64> {
    let mut p = path.to_path_buf();
    while !p.exists() {
        p = p.parent()?.to_path_buf();
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(p.as_os_str().as_bytes()).ok()?;
        // SAFETY: an all-zero statvfs is a valid value to pass as the out
        // pointer, and `c` is a valid C string for the duration of the call.
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
            return None;
        }
        #[allow(clippy::unnecessary_cast)]
        Some(st.f_bavail as u64 * st.f_frsize as u64)
    }
    #[cfg(not(unix))]
    {
        None
    }
}

fn copy_tree(from: &Path, to: &Path, tree: &Tree) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| format!("Could not create {}: {e}", to.display()))?;
    let mut first: HashMap<(u64, u64), PathBuf> = HashMap::new();
    let mut dirs = vec![to.to_path_buf()];
    for item in &tree.items {
        let (src, dst) = (from.join(&item.rel), to.join(&item.rel));
        match item.kind {
            Kind::Dir => {
                fs::create_dir_all(&dst).map_err(|e| format!("Could not create {}: {e}", dst.display()))?;
                dirs.push(dst);
            }
            Kind::Symlink => {
                let target = fs::read_link(&src).map_err(|e| e.to_string())?;
                #[cfg(unix)]
                std::os::unix::fs::symlink(&target, &dst).map_err(|e| e.to_string())?;
                #[cfg(windows)]
                {
                    let is_dir = fs::metadata(&src).map(|m| m.is_dir()).unwrap_or(false);
                    let made = if is_dir {
                        std::os::windows::fs::symlink_dir(&target, &dst)
                    } else {
                        std::os::windows::fs::symlink_file(&target, &dst)
                    };
                    made.map_err(|e| format!("Could not copy the link {}: {e}", src.display()))?;
                }
            }
            Kind::File => {
                if let Some(key) = item.link {
                    if let Some(prev) = first.get(&key) {
                        fs::hard_link(prev, &dst).map_err(|e| format!("Could not link {}: {e}", dst.display()))?;
                        continue;
                    }
                    first.insert(key, dst.clone());
                }
                fs::copy(&src, &dst).map_err(|e| format!("Could not copy {}: {e}", src.display()))?;
                File::open(&dst)
                    .and_then(|f| f.sync_all())
                    .map_err(|e| format!("Could not flush {}: {e}", dst.display()))?;
            }
        }
    }
    for d in dirs.iter().rev() {
        sync_dir(d);
    }
    Ok(())
}

/// Same relative paths, sizes and hard-link groups, or the copy is not
/// trusted.
fn verify_copy(original: &Tree, copy: &Path) -> Result<(), String> {
    let found = scan_tree(copy, &|_| false)?;
    if found.items.len() != original.items.len() {
        return Err(format!("The copy has {} items, the original {}", found.items.len(), original.items.len()));
    }
    let mut groups: HashMap<(u64, u64), Option<(u64, u64)>> = HashMap::new();
    for (a, b) in original.items.iter().zip(found.items.iter()) {
        if a.rel != b.rel || a.kind != b.kind {
            return Err(format!("The copy differs at {}", a.rel.display()));
        }
        if a.kind == Kind::File && a.size != b.size {
            return Err(format!("{} has a different size in the copy", a.rel.display()));
        }
        if let Some(k) = a.link {
            match groups.get(&k) {
                None => {
                    groups.insert(k, b.link);
                }
                Some(g) if *g == b.link && g.is_some() => {}
                Some(_) => return Err(format!("{} lost its hard link in the copy", a.rel.display())),
            }
        }
    }
    Ok(())
}

/// Is `inner` the same as or inside `outer`? Resolved as far as each exists.
pub fn contains(outer: &Path, inner: &Path) -> bool {
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

/// Does a legacy library folder hold anything to move?
pub fn holds_library(dir: &Path) -> bool {
    fs::read_dir(dir)
        .map(|r| r.flatten().any(|e| e.path().join("project.json").is_file()))
        .unwrap_or(false)
}

/// A source the move may take: a data folder (marker), a typesetter library
/// (a project folder in it), or an empty folder. Never an arbitrary tree.
fn movable_source(from: &Path) -> Result<(), String> {
    if !from.is_absolute() || from.parent().is_none() {
        return Err("The folder to move must be an absolute folder, not a whole disk".into());
    }
    let meta = fs::symlink_metadata(from).map_err(|e| format!("Could not read {}: {e}", from.display()))?;
    if !meta.is_dir() {
        return Err(format!("{} is not a folder", from.display()));
    }
    let empty = fs::read_dir(from).map(|mut r| r.next().is_none()).unwrap_or(false);
    if from.join(MARKER).is_file() || empty || holds_library(from) {
        return Ok(());
    }
    Err(format!("{} does not look like a library, so it was not moved", from.display()))
}

// ---------- the journal ----------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub schema: u32,
    /// "setup", "adopt" or "move".
    pub kind: String,
    pub from: String,
    pub to: String,
    pub started_at: String,
    /// "copying", "copied" or "switched".
    pub phase: String,
    /// "rename" or "copy", once known.
    #[serde(default)]
    pub method: Option<String>,
    /// The pointer to write at the switch, when the move changes it.
    #[serde(default)]
    pub pointer: Option<Pointer>,
}

fn write_journal(paths: &Paths, j: &Journal) -> Result<(), String> {
    fs::create_dir_all(paths.dir()).map_err(|e| e.to_string())?;
    write_atomic(&paths.journal(), &serde_json::to_string_pretty(j).map_err(|e| e.to_string())?)
}

pub fn read_journal(paths: &Paths) -> Option<Journal> {
    serde_json::from_str(&fs::read_to_string(paths.journal()).ok()?).ok()
}

fn remove_journal(paths: &Paths) {
    let _ = fs::remove_file(paths.journal());
    sync_dir(&paths.dir());
}

fn partial_of(to: &Path) -> PathBuf {
    let mut s = to.as_os_str().to_os_string();
    s.push(".partial");
    PathBuf::from(s)
}

/// Renames the old tree of a copy aside, to be deleted from Settings.
fn set_old_aside(from: &Path) -> Option<String> {
    let mut s = from.as_os_str().to_os_string();
    s.push(format!(".moved-{}", stamp(now_secs())));
    let aside = free_name(Path::new(&s));
    fs::rename(from, &aside).ok().map(|_| aside.display().to_string())
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MoveReport {
    /// "rename", "copy" or "none" (nothing to move).
    pub method: &'static str,
    /// The old tree of a copy, renamed to `<from>.moved-<date>`.
    pub old_copy: Option<String>,
}

pub struct MoveOpts<'a> {
    pub force_copy: bool,
    pub dataless: Dataless<'a>,
    pub free_space: &'a dyn Fn(&Path) -> Option<u64>,
}

impl Default for MoveOpts<'_> {
    fn default() -> Self {
        MoveOpts { force_copy: false, dataless: &is_dataless, free_space: &free_space }
    }
}

/// Moves `from` to `to` under the journal (contract section 7). The caller
/// holds `move.lock` and has checked the other app. `pointer` is written at
/// the switch. Same volume: one rename. Other volume (or `force_copy`): a
/// checked copy into `<to>.partial`, then the old tree is set aside.
pub fn run_move(paths: &Paths, kind: &str, from: &Path, to: &Path, pointer: Option<Pointer>, opts: &MoveOpts) -> Result<MoveReport, String> {
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
    let info = inspect(to, None);
    if info.exists && !(info.is_dir && info.empty) {
        return Err(format!("{} is not empty", to.display()));
    }
    let partial = partial_of(to);
    if fs::symlink_metadata(&partial).is_ok() {
        return Err(format!("{} is in the way; remove it and try again", partial.display()));
    }
    let tree = scan_tree(from, opts.dataless)?;
    if tree.dataless > 0 {
        let n = tree.dataless;
        return Err(format!(
            "{n} file{} only in the cloud. Download {} first (in Finder or File Explorer), then try again.",
            if n == 1 { " is" } else { "s are" },
            if n == 1 { "it" } else { "them" }
        ));
    }
    let parent = to.parent().ok_or("The new place has no parent folder")?;
    fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    let had_empty = info.exists;
    if had_empty {
        fs::remove_dir(to).map_err(|e| format!("Could not use {}: {e}", to.display()))?;
    }
    let restore_empty = || {
        if had_empty {
            let _ = fs::create_dir(to);
        }
    };

    let mut j = Journal {
        schema: 1,
        kind: kind.into(),
        from: from.display().to_string(),
        to: to.display().to_string(),
        started_at: rfc3339(now_secs()),
        phase: "copying".into(),
        method: Some(if opts.force_copy { "copy" } else { "rename" }.into()),
        pointer: pointer.clone(),
    };
    if let Err(e) = write_journal(paths, &j) {
        restore_empty();
        return Err(e);
    }
    let fail = |e: String| -> Result<MoveReport, String> {
        let _ = fs::remove_dir_all(&partial);
        remove_journal(paths);
        restore_empty();
        Err(e)
    };

    if !opts.force_copy {
        match fs::rename(from, to) {
            Ok(()) => {
                sync_dir(parent);
                if let Some(p) = &pointer {
                    if let Err(e) = write_pointer(&paths.pointer, p) {
                        // Before the switch nothing has changed for either
                        // app: put the tree back.
                        let _ = fs::rename(to, from);
                        return fail(e);
                    }
                }
                remove_journal(paths);
                return Ok(MoveReport { method: "rename", old_copy: None });
            }
            Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
                j.method = Some("copy".into());
                if let Err(e) = write_journal(paths, &j) {
                    return fail(e);
                }
            }
            Err(e) => return fail(format!("Could not move {}: {e}", from.display())),
        }
    }

    if let Some(free) = (opts.free_space)(parent) {
        let need = tree.bytes + tree.bytes / 20;
        if free < need {
            return fail(format!(
                "Not enough space: the move needs {} MB and the drive has {} MB free.",
                need.div_ceil(1_000_000),
                free / 1_000_000
            ));
        }
    }
    if let Err(e) = copy_tree(from, &partial, &tree).and_then(|_| verify_copy(&tree, &partial)) {
        return fail(e);
    }
    if let Err(e) = fs::rename(&partial, to) {
        return fail(format!("Could not finish the copy: {e}"));
    }
    sync_dir(parent);
    j.phase = "copied".into();
    if let Err(e) = write_journal(paths, &j) {
        let _ = fs::remove_dir_all(to);
        return fail(e);
    }
    if let Some(p) = &pointer {
        // Past `copied` the copy is whole; if this fails, recovery writes the
        // pointer at the next start, so the copy is not thrown away here.
        write_pointer(&paths.pointer, p)?;
    }
    j.phase = "switched".into();
    let _ = write_journal(paths, &j);
    let old_copy = set_old_aside(from);
    remove_journal(paths);
    Ok(MoveReport { method: "copy", old_copy })
}

/// At every start, before anything else, under `move.lock`: finishes or
/// undoes a move a crash interrupted. Returns what it did, for a notice.
pub fn recover(paths: &Paths) -> Result<Option<String>, String> {
    let Some(mut j) = read_journal(paths) else {
        if paths.journal().exists() {
            remove_journal(paths);
        }
        return Ok(None);
    };
    let (from, to) = (PathBuf::from(&j.from), PathBuf::from(&j.to));
    let partial = partial_of(&to);
    if j.phase == "copying" {
        // A same-volume rename either happened or did not.
        let renamed = j.method.as_deref() == Some("rename") && !from.exists() && to.exists();
        if !renamed {
            let _ = fs::remove_dir_all(&partial);
            remove_journal(paths);
            return Ok(Some(format!("A move was stopped before it finished. Your data is still at {}.", j.from)));
        }
        j.phase = "copied".into();
    }
    if j.phase == "copied" {
        if let Some(p) = &j.pointer {
            if read_pointer(&paths.pointer) != PointerRead::Ok(p.clone()) {
                write_pointer(&paths.pointer, p)?;
            }
        }
        j.phase = "switched".into();
        write_journal(paths, &j)?;
    }
    let mut note = format!("A move that was stopped has been finished. Your data is at {}.", j.to);
    if j.method.as_deref() == Some("copy") && from.exists() {
        if let Some(aside) = set_old_aside(&from) {
            note.push_str(&format!(" The old copy is at {aside}."));
        }
    }
    remove_journal(paths);
    Ok(Some(note))
}

// ---------- the operations ----------

/// "Set up shared folder" from Legacy mode. `root` is empty, missing, or
/// already a data folder (joined). This app's legacy library moves into
/// `<root>/Typesetter`; the marker is made when missing; the pointer is
/// written last.
pub fn setup(paths: &Paths, root: &Path, legacy: Option<&Path>, confirmed: bool, opts: &MoveOpts) -> Result<MoveReport, String> {
    if !root.is_absolute() || root.parent().is_none() {
        return Err("The data folder must be an absolute folder, not a whole disk".into());
    }
    let info = inspect(root, None);
    if info.exists && !info.is_dir {
        return Err(format!("{} is a file", root.display()));
    }
    let folder_id = match read_marker(root) {
        MarkerRead::Ok(id) => {
            refuse_if_cleaner(root, confirmed)?;
            id
        }
        MarkerRead::Newer(n) => return Err(format!("That folder was set up by a newer version (schema {n}).")),
        MarkerRead::Invalid(e) => return Err(e),
        MarkerRead::Missing => {
            if info.exists && !info.empty {
                return Err("Pick an empty folder, or one that is already a shared data folder.".into());
            }
            fs::create_dir_all(root).map_err(|e| format!("Could not create {}: {e}", root.display()))?;
            let id = new_uuid();
            write_marker(root, &id)?;
            id
        }
    };
    for d in ["locks", "handoff", "handoff/to-typesetter", "handoff/rejected"] {
        let _ = fs::create_dir_all(root.join(d));
    }
    let pointer = Pointer { schema: 1, path: root.display().to_string(), folder_id };
    file_library(paths, "setup", root, legacy, Some(pointer), opts)
}

/// Moves (or makes) this app's library at `<root>/Typesetter`, then writes
/// `pointer` when given.
fn file_library(paths: &Paths, kind: &str, root: &Path, legacy: Option<&Path>, pointer: Option<Pointer>, opts: &MoveOpts) -> Result<MoveReport, String> {
    let target = root.join(SUBFOLDER);
    let there = inspect(&target, None);
    if there.exists && !(there.is_dir && there.empty) {
        // Already ours (a second machine, a reinstall): use it as it is when
        // there is nothing of ours to bring.
        if target.join(LIBRARY_FILE).is_file() && !legacy.is_some_and(holds_library) {
            if let Some(p) = &pointer {
                write_pointer(&paths.pointer, p)?;
            }
            return Ok(MoveReport { method: "none", old_copy: None });
        }
        return Err(format!("{} already has files in it, so nothing was moved.", target.display()));
    }
    match legacy.filter(|l| holds_library(l)) {
        Some(from) => {
            // Written before the move so it travels with the library: there is
            // no moment at which the moved library lacks it.
            write_library_file(from)?;
            run_move(paths, kind, from, &target, pointer, opts)
        }
        None => {
            fs::create_dir_all(&target).map_err(|e| format!("Could not create {}: {e}", target.display()))?;
            write_library_file(&target)?;
            if let Some(p) = &pointer {
                write_pointer(&paths.pointer, p)?;
            }
            Ok(MoveReport { method: "none", old_copy: None })
        }
    }
}

/// Pending mode: move the legacy library into the folder the pointer names.
pub fn adopt(paths: &Paths, legacy: Option<&Path>, confirmed: bool, opts: &MoveOpts) -> Result<MoveReport, String> {
    let st = status(paths);
    let p = st.pointer.filter(|_| st.state == "ok").ok_or("The shared data folder is not available.")?;
    let root = PathBuf::from(&p.path);
    refuse_if_cleaner(&root, confirmed)?;
    file_library(paths, "adopt", &root, legacy, None, opts)
}

/// Moves the whole data folder to `to`.
pub fn move_root(paths: &Paths, to: &Path, confirmed: bool, opts: &MoveOpts) -> Result<MoveReport, String> {
    let st = status(paths);
    let p = st.pointer.filter(|_| st.state == "ok").ok_or("The shared data folder is not available.")?;
    let from = PathBuf::from(&p.path);
    refuse_if_cleaner(&from, confirmed)?;
    if inspect(to, None).marker {
        return Err("That folder is already a data folder. Use it instead, or pick an empty one.".into());
    }
    let next = Pointer { schema: 1, path: to.display().to_string(), folder_id: p.folder_id.clone() };
    run_move(paths, "move", &from, to, Some(next), opts)
}

/// "Use existing folder": point at a folder that already holds a marker.
pub fn use_existing(paths: &Paths, root: &Path) -> Result<Pointer, String> {
    match read_marker(root) {
        MarkerRead::Ok(id) => {
            let p = Pointer { schema: 1, path: root.display().to_string(), folder_id: id };
            write_pointer(&paths.pointer, &p)?;
            Ok(p)
        }
        MarkerRead::Missing => Err("That folder is not a shared data folder (it has no manga-library.json).".into()),
        MarkerRead::Newer(n) => Err(format!("That folder was set up by a newer version (schema {n}).")),
        MarkerRead::Invalid(e) => Err(e),
    }
}

/// Deletes an old copy a cross-volume move set aside. Only a folder named
/// `<something>.moved-<date>` that is not the data folder in use.
pub fn delete_old_copy(paths: &Paths, path: &Path) -> Result<(), String> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if !(name.contains(".moved-") && path.is_absolute() && path.is_dir()) {
        return Err("That is not an old copy of a data folder.".into());
    }
    if let PointerRead::Ok(p) = read_pointer(&paths.pointer) {
        if contains(path, Path::new(&p.path)) || contains(Path::new(&p.path), path) {
            return Err("That folder is the data folder in use.".into());
        }
    }
    fs::remove_dir_all(path).map_err(|e| format!("Could not delete {}: {e}", path.display()))
}

// ---------- commands ----------

fn state_base<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    use tauri::Manager;
    let p = app.path();
    #[cfg(windows)]
    let base = p.local_data_dir();
    #[cfg(not(windows))]
    let base = p.config_dir();
    base.map_err(|e| e.to_string())
}

pub fn paths_for<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Paths, String> {
    let env = std::env::var(POINTER_ENV).ok();
    Ok(Paths { pointer: pointer_file(&state_base(app)?, &app.config().identifier, env.as_deref()) })
}

fn home<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().home_dir().ok()
}

#[tauri::command]
pub fn data_folder_status<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<Status, String> {
    Ok(status(&paths_for(&app)?))
}

#[tauri::command]
pub fn data_folder_recover<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<Option<String>, String> {
    let paths = paths_for(&app)?;
    if !paths.journal().exists() {
        return Ok(None);
    }
    let _lock = take_move_lock(&paths)?;
    recover(&paths)
}

#[tauri::command]
pub fn data_folder_inspect<R: tauri::Runtime>(app: tauri::AppHandle<R>, path: String) -> FolderInfo {
    inspect(Path::new(&path), home(&app).as_deref())
}

/// `~/Manga Library`, the default for a new setup.
#[tauri::command]
pub fn data_folder_default_root<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<String, String> {
    Ok(home(&app).ok_or("No home folder")?.join("Manga Library").display().to_string())
}

/// Whether the cleaner holds `move.lock` now: no filing, setup or move.
#[tauri::command]
pub fn data_folder_move_busy<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<bool, String> {
    Ok(lock_file_held(&paths_for(&app)?.move_lock()) == Some(true))
}

/// `true` running, `false` not, `null` this drive cannot tell.
#[tauri::command]
pub fn data_folder_cleaner_running(root: String) -> Option<bool> {
    lock_is_held(Path::new(&root), OTHER_LOCK)
}

/// Grants the webview the data folder (the fs plugin and the asset protocol,
/// so a folder outside the home folder works; the deny lists are checked
/// first and still win) and takes this app's lock on it. Never creates it.
#[tauri::command]
pub fn data_folder_open<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, DataFolderState>,
    root: String,
) -> Result<(), String> {
    use tauri::Manager;
    use tauri_plugin_fs::FsExt;
    let root = PathBuf::from(root);
    let st = status(&paths_for(&app)?);
    let named = st.pointer.as_ref().is_some_and(|p| Path::new(&p.path) == root);
    if st.state != "ok" || !named {
        return Err("The shared data folder is not available.".into());
    }
    app.fs_scope().allow_directory(&root, true).map_err(|e| e.to_string())?;
    app.asset_protocol_scope().allow_directory(&root, true).map_err(|e| e.to_string())?;
    state.hold(&root)
}

#[tauri::command]
pub fn data_folder_release(state: tauri::State<'_, DataFolderState>) {
    state.release();
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn data_folder_setup<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    root: String,
    legacy: Option<String>,
    confirmed: Option<bool>,
) -> Result<MoveReport, String> {
    let paths = paths_for(&app)?;
    blocking(move || {
        let _lock = take_move_lock(&paths)?;
        setup(&paths, Path::new(&root), legacy.as_deref().map(Path::new), confirmed == Some(true), &MoveOpts::default())
    })
    .await
}

#[tauri::command]
pub async fn data_folder_adopt<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    legacy: Option<String>,
    confirmed: Option<bool>,
) -> Result<MoveReport, String> {
    let paths = paths_for(&app)?;
    blocking(move || {
        let _lock = take_move_lock(&paths)?;
        adopt(&paths, legacy.as_deref().map(Path::new), confirmed == Some(true), &MoveOpts::default())
    })
    .await
}

/// This app's own lock is let go for the move; the caller opens the new
/// root afterwards (or the old one again on a failure).
#[tauri::command]
pub async fn data_folder_move<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, DataFolderState>,
    to: String,
    confirmed: Option<bool>,
) -> Result<MoveReport, String> {
    let paths = paths_for(&app)?;
    let lock = take_move_lock(&paths)?;
    state.release();
    blocking(move || {
        let _lock = lock;
        move_root(&paths, Path::new(&to), confirmed == Some(true), &MoveOpts::default())
    })
    .await
}

#[tauri::command]
pub fn data_folder_use_existing<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: String) -> Result<Pointer, String> {
    let paths = paths_for(&app)?;
    let _lock = take_move_lock(&paths)?;
    use_existing(&paths, Path::new(&root))
}

#[tauri::command]
pub async fn data_folder_delete_old<R: tauri::Runtime>(app: tauri::AppHandle<R>, path: String) -> Result<(), String> {
    let paths = paths_for(&app)?;
    blocking(move || delete_old_copy(&paths, Path::new(&path))).await
}

/// Size of a folder in bytes, hard links once (for "Old copy at X, 9.2 GB").
#[tauri::command]
pub async fn data_folder_size(path: String) -> Result<u64, String> {
    blocking(move || Ok(scan_tree(Path::new(&path), &|_| false)?.bytes)).await
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mt-data-folder-{name}-{}-{}", std::process::id(), nanos()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    pub fn paths_in(d: &Path) -> Paths {
        Paths { pointer: d.join("state").join("MangaLibrary").join("data-folder.json") }
    }

    #[test]
    fn pointer_location_follows_identifier_and_env() {
        let base = Path::new("/state");
        assert_eq!(pointer_file(base, "com.mangatypesetter.app", None), PathBuf::from("/state/MangaLibrary/data-folder.json"));
        assert_eq!(pointer_file(base, "com.mangacleaner.studio", None), PathBuf::from("/state/MangaLibrary/data-folder.json"));
        assert_eq!(pointer_file(base, "com.mangatypesetter.rust", None), PathBuf::from("/state/MangaLibrary-dev/data-folder.json"));
        assert_eq!(pointer_file(base, "com.mangatypesetter.app", Some("/x/p.json")), PathBuf::from("/x/p.json"));
        assert_eq!(pointer_file(base, "com.mangatypesetter.app", Some(" ")), PathBuf::from("/state/MangaLibrary/data-folder.json"));
        let p = Paths { pointer: PathBuf::from("/x/p.json") };
        assert_eq!(p.move_lock(), PathBuf::from("/x/move.lock"));
        assert_eq!(p.journal(), PathBuf::from("/x/move-journal.json"));
    }

    #[test]
    fn pointer_round_trip_and_bad_ones() {
        let d = scratch("pointer");
        let file = d.join("nested").join("data-folder.json");
        assert_eq!(read_pointer(&file), PointerRead::None);
        let p = Pointer { schema: 1, path: "/Users/me/Manga Library".into(), folder_id: new_uuid() };
        write_pointer(&file, &p).unwrap();
        assert_eq!(read_pointer(&file), PointerRead::Ok(p.clone()));
        let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(json["folderId"], p.folder_id.as_str());
        assert_eq!(fs::read_dir(file.parent().unwrap()).unwrap().count(), 1, "no temp file left");
        assert!(write_pointer(&file, &Pointer { path: "relative".into(), ..p.clone() }).is_err());
        fs::write(&file, "{ not json").unwrap();
        assert!(matches!(read_pointer(&file), PointerRead::Invalid(_)));
        fs::write(&file, r#"{"schema":1,"path":"rel/x","folderId":"a"}"#).unwrap();
        assert!(matches!(read_pointer(&file), PointerRead::Invalid(_)));
        fs::write(&file, r#"{"schema":3,"path":"/x"}"#).unwrap();
        assert_eq!(read_pointer(&file), PointerRead::Newer(3));
        // A newer pointer is never overwritten.
        assert!(write_pointer(&file, &p).is_err());
        assert!(fs::read_to_string(&file).unwrap().contains("\"schema\":3"));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn dates_and_ids() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(stamp(951_782_400 + 3600 * 13 + 60 * 5), "2000-02-29-1305");
        let (a, b) = (new_uuid(), new_uuid());
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        assert_eq!(&a[14..15], "4");
    }

    #[test]
    fn status_covers_every_mode_and_creates_nothing() {
        let d = scratch("status");
        let paths = paths_in(&d);
        assert_eq!(status(&paths).state, "none");
        let root = d.join("Manga Library");
        let p = Pointer { schema: 1, path: root.display().to_string(), folder_id: "id-1".into() };
        write_pointer(&paths.pointer, &p).unwrap();
        assert_eq!(status(&paths).state, "missing");
        assert!(!root.exists(), "a missing folder is not made");
        assert!(take_lock(&root, OWN_LOCK).is_err(), "the lock does not make it either");
        assert!(!root.exists());
        fs::create_dir_all(&root).unwrap();
        assert_eq!(status(&paths).state, "noMarker");
        write_marker(&root, "id-2").unwrap();
        assert_eq!(status(&paths).state, "idMismatch");
        write_marker(&root, "id-1").unwrap();
        let s = status(&paths);
        assert_eq!((s.state, s.typesetter_ready), ("ok", false));
        fs::create_dir_all(root.join(SUBFOLDER)).unwrap();
        write_library_file(&root.join(SUBFOLDER)).unwrap();
        assert!(status(&paths).typesetter_ready);
        fs::write(root.join(MARKER), r#"{"schema":2,"folderId":"id-1"}"#).unwrap();
        assert_eq!(status(&paths).state, "newer");
        fs::write(&paths.pointer, r#"{"schema":2}"#).unwrap();
        assert_eq!(status(&paths).state, "newer");
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn locks_are_seen_held_and_free() {
        let root = scratch("lock");
        assert_eq!(lock_is_held(&root, OTHER_LOCK), Some(false), "a missing lock file is free");
        let held = take_lock(&root, OTHER_LOCK).unwrap().expect("a free lock is taken");
        assert_eq!(lock_is_held(&root, OTHER_LOCK), Some(true));
        assert!(take_lock(&root, OTHER_LOCK).unwrap().is_none());
        assert!(refuse_if_cleaner(&root, false).is_err());
        drop(held);
        assert_eq!(lock_is_held(&root, OTHER_LOCK), Some(false));
        assert!(refuse_if_cleaner(&root, false).is_ok());

        let state = DataFolderState::default();
        state.hold(&root).unwrap();
        assert_eq!(lock_is_held(&root, OWN_LOCK), Some(true));
        state.hold(&root).unwrap();
        state.release();
        assert_eq!(lock_is_held(&root, OWN_LOCK), Some(false));

        let paths = paths_in(&root);
        let m = take_move_lock(&paths).unwrap();
        assert!(take_move_lock(&paths).is_err());
        assert_eq!(lock_file_held(&paths.move_lock()), Some(true));
        drop(m);
        assert!(take_move_lock(&paths).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    pub fn library_tree(at: &Path) {
        let ch = at.join("Series").join("001");
        fs::create_dir_all(ch.join("raws")).unwrap();
        fs::write(at.join("Series").join("project.json"), "{}").unwrap();
        fs::write(ch.join("chapter.json"), "{\"pages\":[]}").unwrap();
        fs::write(ch.join("raws").join("001.png"), vec![7u8; 4096]).unwrap();
    }

    fn assert_tree(at: &Path) {
        assert_eq!(fs::read(at.join("Series").join("001").join("raws").join("001.png")).unwrap(), vec![7u8; 4096]);
        assert!(at.join("Series").join("project.json").is_file());
    }

    fn copy_opts() -> MoveOpts<'static> {
        MoveOpts { force_copy: true, ..MoveOpts::default() }
    }

    #[test]
    fn setup_renames_on_one_volume_and_writes_marker_then_pointer() {
        let d = scratch("setup");
        let paths = paths_in(&d);
        let legacy = d.join("MangaTypesetter");
        library_tree(&legacy);
        let root = d.join("Manga Library");
        let r = setup(&paths, &root, Some(&legacy), false, &MoveOpts::default()).unwrap();
        assert_eq!(r, MoveReport { method: "rename", old_copy: None });
        assert!(!legacy.exists());
        assert_tree(&root.join(SUBFOLDER));
        let s = status(&paths);
        assert_eq!((s.state, s.typesetter_ready), ("ok", true));
        assert!(root.join("handoff").join("to-typesetter").is_dir());
        assert!(!paths.journal().exists());
        let full = d.join("full");
        fs::create_dir_all(&full).unwrap();
        fs::write(full.join("x.txt"), "x").unwrap();
        assert!(setup(&paths, &full, None, false, &MoveOpts::default()).is_err());
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn setup_with_nothing_to_move_makes_an_empty_library() {
        let d = scratch("setup-empty");
        let paths = paths_in(&d);
        let root = d.join("Manga Library");
        let r = setup(&paths, &root, Some(&d.join("never-made")), false, &MoveOpts::default()).unwrap();
        assert_eq!(r.method, "none");
        assert!(status(&paths).typesetter_ready);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn adopt_moves_the_legacy_library_into_a_folder_the_cleaner_set_up() {
        let d = scratch("adopt");
        let paths = paths_in(&d);
        let root = d.join("Manga Library");
        fs::create_dir_all(root.join("Cleaner")).unwrap();
        write_marker(&root, "cleaner-made").unwrap();
        write_pointer(&paths.pointer, &Pointer { schema: 1, path: root.display().to_string(), folder_id: "cleaner-made".into() }).unwrap();
        let legacy = d.join("Documents").join("MangaTypesetter");
        library_tree(&legacy);
        let cleaner = take_lock(&root, OTHER_LOCK).unwrap().unwrap();
        assert!(adopt(&paths, Some(&legacy), false, &MoveOpts::default()).is_err(), "refused while the cleaner runs");
        drop(cleaner);
        adopt(&paths, Some(&legacy), false, &copy_opts()).unwrap();
        assert_tree(&root.join(SUBFOLDER));
        assert!(status(&paths).typesetter_ready);
        assert!(!legacy.exists());
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn move_copies_across_volumes_keeping_links_and_sets_the_old_tree_aside() {
        let d = scratch("move-copy");
        let paths = paths_in(&d);
        let root = d.join("old");
        setup(&paths, &root, None, false, &MoveOpts::default()).unwrap();
        library_tree(&root.join(SUBFOLDER));
        let raw = root.join(SUBFOLDER).join("Series").join("001").join("raws").join("001.png");
        fs::create_dir_all(root.join("Cleaner")).unwrap();
        fs::hard_link(&raw, root.join("Cleaner").join("page.png")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("Series/project.json", root.join(SUBFOLDER).join("link.json")).unwrap();
        let to = d.join("new");
        let r = move_root(&paths, &to, false, &copy_opts()).unwrap();
        assert_eq!(r.method, "copy");
        let aside = PathBuf::from(r.old_copy.expect("the old tree is kept"));
        assert!(aside.file_name().unwrap().to_str().unwrap().starts_with("old.moved-"));
        assert_tree(&aside.join(SUBFOLDER));
        assert!(!root.exists());
        assert_tree(&to.join(SUBFOLDER));
        assert!(!partial_of(&to).exists());
        let s = status(&paths);
        assert_eq!((s.state, s.pointer.unwrap().path), ("ok", to.display().to_string()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let a = fs::metadata(to.join(SUBFOLDER).join("Series").join("001").join("raws").join("001.png")).unwrap();
            let b = fs::metadata(to.join("Cleaner").join("page.png")).unwrap();
            assert_eq!((a.ino(), a.nlink()), (b.ino(), 2), "the hard link is kept");
            assert!(fs::symlink_metadata(to.join(SUBFOLDER).join("link.json")).unwrap().file_type().is_symlink());
        }
        delete_old_copy(&paths, &aside).unwrap();
        assert!(!aside.exists());
        assert!(delete_old_copy(&paths, &to).is_err(), "the folder in use is never deleted");
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn move_refuses_full_drives_cloud_files_and_bad_targets() {
        let d = scratch("move-refuse");
        let paths = paths_in(&d);
        let root = d.join("root");
        setup(&paths, &root, None, false, &MoveOpts::default()).unwrap();
        library_tree(&root.join(SUBFOLDER));
        let full = MoveOpts { force_copy: true, free_space: &|_| Some(10), ..MoveOpts::default() };
        let e = move_root(&paths, &d.join("a"), false, &full).unwrap_err();
        assert!(e.starts_with("Not enough space"), "{e}");
        let cloud = MoveOpts { dataless: &|m: &fs::Metadata| m.len() == 4096, ..MoveOpts::default() };
        let e = move_root(&paths, &d.join("b"), false, &cloud).unwrap_err();
        assert!(e.starts_with("1 file is only in the cloud"), "{e}");
        let busy = d.join("busy");
        fs::create_dir_all(&busy).unwrap();
        fs::write(busy.join("x"), "x").unwrap();
        assert!(move_root(&paths, &busy, false, &MoveOpts::default()).is_err());
        assert!(move_root(&paths, &root.join("inner"), false, &copy_opts()).is_err());
        let other = take_lock(&root, OTHER_LOCK).unwrap().unwrap();
        assert_eq!(move_root(&paths, &d.join("c"), false, &MoveOpts::default()).unwrap_err(), "Manga Cleaner is open. Close it first.");
        drop(other);
        assert_tree(&root.join(SUBFOLDER));
        assert!(!paths.journal().exists());
        for n in ["a", "b", "c"] {
            assert!(!d.join(n).exists() && !partial_of(&d.join(n)).exists());
        }
        let random = d.join("random");
        fs::create_dir_all(&random).unwrap();
        fs::write(random.join("notes.txt"), "x").unwrap();
        assert!(run_move(&paths, "move", &random, &d.join("e"), None, &MoveOpts::default()).is_err());
        fs::remove_dir_all(d).unwrap();
    }

    fn journal(paths: &Paths, from: &Path, to: &Path, phase: &str, method: &str, pointer: Option<Pointer>) {
        write_journal(
            paths,
            &Journal {
                schema: 1,
                kind: "move".into(),
                from: from.display().to_string(),
                to: to.display().to_string(),
                started_at: rfc3339(now_secs()),
                phase: phase.into(),
                method: Some(method.into()),
                pointer,
            },
        )
        .unwrap();
    }

    #[test]
    fn a_crash_in_each_phase_recovers() {
        let d = scratch("recover");
        let paths = paths_in(&d);
        let from = d.join("from");
        let to = d.join("to");
        let next = Pointer { schema: 1, path: to.display().to_string(), folder_id: "id".into() };
        let old = Pointer { schema: 1, path: from.display().to_string(), folder_id: "id".into() };

        // copying, copy: the partial copy goes, the data is whole at `from`.
        library_tree(&from);
        write_pointer(&paths.pointer, &old).unwrap();
        fs::create_dir_all(partial_of(&to)).unwrap();
        journal(&paths, &from, &to, "copying", "copy", Some(next.clone()));
        assert!(recover(&paths).unwrap().is_some());
        assert!(!partial_of(&to).exists() && !paths.journal().exists());
        assert_tree(&from);
        assert_eq!(read_pointer(&paths.pointer), PointerRead::Ok(old.clone()));

        // copying, a rename that happened: the pointer is redone.
        fs::rename(&from, &to).unwrap();
        journal(&paths, &from, &to, "copying", "rename", Some(next.clone()));
        recover(&paths).unwrap();
        assert_eq!(read_pointer(&paths.pointer), PointerRead::Ok(next.clone()));
        assert!(!paths.journal().exists());

        // copied: pointer written, the old tree set aside.
        fs::rename(&to, &from).unwrap();
        write_pointer(&paths.pointer, &old).unwrap();
        library_tree(&to);
        journal(&paths, &from, &to, "copied", "copy", Some(next.clone()));
        let note = recover(&paths).unwrap().unwrap();
        assert!(note.contains("old copy"), "{note}");
        assert_eq!(read_pointer(&paths.pointer), PointerRead::Ok(next.clone()));
        assert!(!from.exists());
        assert!(fs::read_dir(&d).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("from.moved-")));

        // switched: only the tidy-up is left.
        library_tree(&from);
        journal(&paths, &from, &to, "switched", "copy", Some(next.clone()));
        recover(&paths).unwrap();
        assert!(!from.exists() && !paths.journal().exists());
        assert_eq!(recover(&paths).unwrap(), None);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_failed_pointer_write_before_the_switch_puts_the_tree_back() {
        let d = scratch("move-fail");
        let paths = paths_in(&d);
        let from = d.join("old");
        library_tree(&from);
        fs::create_dir_all(paths.dir()).unwrap();
        fs::write(&paths.pointer, r#"{"schema":9}"#).unwrap();
        let p = Pointer { schema: 1, path: d.join("new").display().to_string(), folder_id: "x".into() };
        assert!(run_move(&paths, "move", &from, &d.join("new"), Some(p), &MoveOpts::default()).is_err());
        assert_tree(&from);
        assert!(!d.join("new").exists() && !paths.journal().exists());
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn use_existing_and_sync_warnings() {
        let d = scratch("existing");
        let paths = paths_in(&d);
        let root = d.join("lib");
        fs::create_dir_all(&root).unwrap();
        assert!(use_existing(&paths, &root).is_err());
        write_marker(&root, "abc").unwrap();
        assert_eq!(use_existing(&paths, &root).unwrap().folder_id, "abc");
        assert_eq!(status(&paths).state, "ok");
        assert!(sync_warning(Path::new("/Users/me/Library/CloudStorage/Dropbox/x"), None).is_some());
        assert!(sync_warning(Path::new("C:\\Users\\me\\OneDrive\\Manga"), None).is_some());
        assert!(sync_warning(Path::new("/Users/me/Manga Library"), Some(Path::new("/Users/me"))).is_none());
        if cfg!(target_os = "macos") {
            assert!(sync_warning(Path::new("/Users/me/Documents/x"), Some(Path::new("/Users/me"))).is_some());
        }
        fs::remove_dir_all(d).unwrap();
    }
}
