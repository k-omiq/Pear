//! The file side of filing Manga Cleaner's messages (SHARED_DATA_FOLDER.md
//! section 8.3). The decisions are the webview's (src/lib/handoff.svelte.js);
//! the moves are here, because the claimed message folder's name starts with
//! a dot and the webview's file scope does not match dot folders on unix.
//!
//! Every path is checked: a message file is `raws/<name>` or
//! `cleaned/<name>` inside a claimed folder of `handoff/to-typesetter/`, and
//! a destination is a new file inside `<root>/Typesetter/`.

use crate::data_folder::{contains, free_name, now_secs, stamp, sync_dir, write_atomic, SUBFOLDER};
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const INBOX: &str = "to-typesetter";
const CLAIMED: &str = ".claimed-";

/// Claims this process made. Any other claim found at start is a dead run's.
static OURS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn note_ours(name: &str, add: bool) {
    if let Ok(mut g) = OURS.lock() {
        let set = g.get_or_insert_with(HashSet::new);
        if add {
            set.insert(name.to_string());
        } else {
            set.remove(name);
        }
    }
}

fn is_ours(name: &str) -> bool {
    OURS.lock().ok().and_then(|g| g.as_ref().map(|s| s.contains(name))).unwrap_or(false)
}

pub fn inbox(root: &Path) -> PathBuf {
    root.join("handoff").join(INBOX)
}

fn plain(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains('/') && !name.contains('\\')
}

fn key_ok(key: &str) -> Result<(), String> {
    if plain(key) && !key.starts_with('.') {
        Ok(())
    } else {
        Err(format!("{key} is not a message name"))
    }
}

fn claim_dir(root: &Path, claim: &str) -> Result<PathBuf, String> {
    if plain(claim) && claim.starts_with(CLAIMED) {
        Ok(inbox(root).join(claim))
    } else {
        Err(format!("{claim} is not a claimed message"))
    }
}

/// `raws/<name>` or `cleaned/<name>`, as a path inside the claim.
fn message_file(claim: &Path, rel: &str) -> Result<PathBuf, String> {
    let parts: Vec<&str> = rel.split('/').collect();
    match parts.as_slice() {
        [dir, name] if (*dir == "raws" || *dir == "cleaned") && plain(name) => Ok(claim.join(dir).join(name)),
        _ => Err(format!("{rel} is not a message file")),
    }
}

/// A new file inside `<root>/Typesetter/`, in a folder that exists.
fn library_dest(root: &Path, dest: &Path) -> Result<(), String> {
    let lib = root.join(SUBFOLDER);
    if !dest.is_absolute() || !contains(&lib, dest) || dest == lib {
        return Err(format!("{} is not inside the library", dest.display()));
    }
    if !dest.parent().is_some_and(Path::is_dir) {
        return Err(format!("{} has no folder", dest.display()));
    }
    Ok(())
}

/// The messages waiting, oldest name first. Dot names are never read.
pub fn list(root: &Path) -> Result<Vec<String>, String> {
    let dir = inbox(root);
    let entries = match fs::read_dir(&dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Could not read {}: {e}", dir.display())),
    };
    let mut keys: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|n| !n.starts_with('.'))
        .collect();
    keys.sort();
    Ok(keys)
}

/// `.claimed-<key>-<random>` -> `<key>`.
fn key_of_claim(name: &str) -> Option<&str> {
    let rest = name.strip_prefix(CLAIMED)?;
    let cut = rest.rfind('-')?;
    (cut > 0).then(|| &rest[..cut])
}

/// Puts a claim back as `<key>`, or deletes it when a newer `<key>` is there.
/// Returns "back" or "dropped".
pub fn put_back(root: &Path, claim: &str, key: &str) -> Result<&'static str, String> {
    key_ok(key)?;
    let from = claim_dir(root, claim)?;
    let home = inbox(root).join(key);
    note_ours(claim, false);
    if fs::symlink_metadata(&home).is_err() && fs::rename(&from, &home).is_ok() {
        return Ok("back");
    }
    fs::remove_dir_all(&from).map_err(|e| format!("Could not remove {}: {e}", from.display()))?;
    Ok("dropped")
}

/// At start: every claim a dead run left is put back (or dropped for a newer
/// message). Returns how many.
pub fn recover(root: &Path) -> Result<u32, String> {
    let dir = inbox(root);
    let Ok(entries) = fs::read_dir(&dir) else { return Ok(0) };
    let mut n = 0;
    for e in entries.flatten() {
        let Some(name) = e.file_name().to_str().map(str::to_string) else { continue };
        if !name.starts_with(CLAIMED) || is_ours(&name) || !e.path().is_dir() {
            continue;
        }
        if let Some(key) = key_of_claim(&name) {
            if put_back(root, &name, key).is_ok() {
                n += 1;
            }
        }
    }
    Ok(n)
}

/// Renames `<key>` to `.claimed-<key>-<random>`. `None` when it is gone or
/// someone else took it.
pub fn claim(root: &Path, key: &str) -> Result<Option<String>, String> {
    key_ok(key)?;
    let tag = format!("{:x}", crate::data_folder::nanos() ^ u128::from(std::process::id()));
    let name = format!("{CLAIMED}{key}-{}", &tag[tag.len().saturating_sub(10)..]);
    note_ours(&name, true);
    match fs::rename(inbox(root).join(key), inbox(root).join(&name)) {
        Ok(()) => Ok(Some(name)),
        Err(_) => {
            note_ours(&name, false);
            Ok(None)
        }
    }
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub exists: bool,
    pub w: u32,
    pub h: u32,
    pub size: u64,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub doc: Option<serde_json::Value>,
    pub error: Option<String>,
    /// Every `raw` and `cleaned` the message lists, by its relative path.
    pub files: BTreeMap<String, FileInfo>,
}

/// Reads `handoff.json` of a claim and looks at every file it lists.
pub fn read(root: &Path, claim: &str) -> Result<Message, String> {
    let dir = claim_dir(root, claim)?;
    let mut out = Message::default();
    let text = match fs::read_to_string(dir.join("handoff.json")) {
        Ok(t) => t,
        Err(e) => {
            out.error = Some(format!("handoff.json could not be read ({e})"));
            return Ok(out);
        }
    };
    let doc: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            out.error = Some(format!("handoff.json is not valid JSON ({e})"));
            return Ok(out);
        }
    };
    for pg in doc["pages"].as_array().into_iter().flatten() {
        for k in ["raw", "cleaned"] {
            let Some(rel) = pg[k].as_str() else { continue };
            let info = match message_file(&dir, rel) {
                Ok(p) if p.is_file() => {
                    let (w, h) = image::image_dimensions(&p).unwrap_or((0, 0));
                    let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                    FileInfo { exists: true, w, h, size }
                }
                _ => FileInfo::default(),
            };
            out.files.insert(rel.to_string(), info);
        }
    }
    out.doc = Some(doc);
    Ok(out)
}

/// Puts one message file into the library as a hard link (a copy where the
/// drive has no links), so the claim stays whole until `done`: a crash or a
/// failed apply puts back a message with every file in it. The raw in a
/// message is itself a link to the cleaner's page, so the raw is still on
/// disk once for both apps.
pub fn take(root: &Path, claim: &str, rel: &str, dest: &Path) -> Result<(), String> {
    let src = message_file(&claim_dir(root, claim)?, rel)?;
    library_dest(root, dest)?;
    if fs::symlink_metadata(dest).is_ok() {
        return Err(format!("{} is already there", dest.display()));
    }
    if fs::hard_link(&src, dest).is_ok() {
        return Ok(());
    }
    // A copy lands under a temporary name first, so `dest` is never half a
    // file.
    let tmp = free_name(&dest.with_file_name(format!(
        ".{}.taking",
        dest.file_name().and_then(|n| n.to_str()).unwrap_or("page")
    )));
    let copied = fs::copy(&src, &tmp)
        .and_then(|_| crate::data_folder::flush_copied(&tmp))
        .and_then(|_| fs::rename(&tmp, dest));
    copied.map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Could not bring {rel} into the library: {e}")
    })
}

/// Undoes a `take` for an apply that failed before it was written: deletes
/// the library's link. Only while the claim still has its own, so the last
/// copy of a page is never deleted.
pub fn give_back(root: &Path, claim: &str, rel: &str, from: &Path) -> Result<(), String> {
    let kept = message_file(&claim_dir(root, claim)?, rel)?;
    library_dest(root, from)?;
    if !kept.is_file() {
        return Err(format!("{rel} is not in the message any more, so the library keeps its copy"));
    }
    fs::remove_file(from).map_err(|e| e.to_string())
}

/// Is a message file byte for byte the library file at `path`? Size first,
/// then sha256 (a re-sent page that did not change is not filed again).
pub fn same(root: &Path, claim: &str, rel: &str, path: &Path) -> Result<bool, String> {
    use sha2::{Digest, Sha256};
    let src = message_file(&claim_dir(root, claim)?, rel)?;
    let lib = root.join(SUBFOLDER);
    if !path.is_absolute() || !contains(&lib, path) {
        return Err(format!("{} is not inside the library", path.display()));
    }
    let (Ok(a), Ok(b)) = (fs::metadata(&src), fs::metadata(path)) else { return Ok(false) };
    if a.len() != b.len() {
        return Ok(false);
    }
    let hash = |p: &Path| -> Result<Vec<u8>, String> {
        let mut f = File::open(p).map_err(|e| e.to_string())?;
        let mut h = Sha256::new();
        std::io::copy(&mut f, &mut h).map_err(|e| e.to_string())?;
        Ok(h.finalize().to_vec())
    };
    Ok(hash(&src)? == hash(path)?)
}

/// A message that cannot be filed goes to `handoff/rejected/<key>-<date>/`
/// with the reason beside it.
pub fn reject(root: &Path, claim: &str, key: &str, reason: &str) -> Result<String, String> {
    key_ok(key)?;
    let from = claim_dir(root, claim)?;
    let dir = root.join("handoff").join("rejected");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let to = free_name(&dir.join(format!("{key}-{}", stamp(now_secs()))));
    fs::rename(&from, &to).map_err(|e| format!("Could not set the message aside: {e}"))?;
    note_ours(claim, false);
    let _ = write_atomic(&to.join("reason.txt"), &format!("{reason}\n"));
    Ok(to.display().to_string())
}

/// The claim is filed: delete it (the raws left in it are links the library
/// already has, or pages it did not need).
pub fn done(root: &Path, claim: &str) -> Result<(), String> {
    let dir = claim_dir(root, claim)?;
    note_ours(claim, false);
    fs::remove_dir_all(&dir).map_err(|e| format!("Could not remove {}: {e}", dir.display()))
}

// ---------- version 2: waiting messages and linking (contract 8.4) ----------

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub key: String,
    /// Changes whenever the folder under that key is a new one (a newer Save
    /// replaces the whole folder, section 8.2), so a message judged already
    /// is not read again while it waits.
    pub stamp: String,
}

fn folder_stamp(meta: &fs::Metadata) -> String {
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    #[cfg(unix)]
    let id = {
        use std::os::unix::fs::MetadataExt;
        meta.ino()
    };
    #[cfg(not(unix))]
    let id = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    format!("{modified:x}-{id:x}")
}

/// The messages waiting, each with its stamp, oldest name first. Dot names
/// are never read. Lists the folder only; no message is opened.
pub fn scan(root: &Path) -> Result<Vec<Entry>, String> {
    let dir = inbox(root);
    let entries = match fs::read_dir(&dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Could not read {}: {e}", dir.display())),
    };
    let mut out: Vec<Entry> = entries
        .flatten()
        .filter_map(|e| {
            let key = e.file_name().to_str()?.to_string();
            let meta = e.metadata().ok().filter(|m| m.is_dir())?;
            (!key.starts_with('.')).then(|| Entry { key, stamp: folder_stamp(&meta) })
        })
        .collect();
    out.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(out)
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Peek {
    /// The folder is not there any more.
    pub gone: bool,
    pub doc: Option<serde_json::Value>,
    pub error: Option<String>,
}

/// Reads `<key>/handoff.json` of a message that is not claimed, in place
/// (section 8.4.2): that one file only, opened, read and closed at once.
/// Nothing is written and no image is opened.
pub fn peek(root: &Path, key: &str) -> Result<Peek, String> {
    key_ok(key)?;
    let file = inbox(root).join(key).join("handoff.json");
    let text = match fs::read_to_string(&file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Peek { gone: !inbox(root).join(key).is_dir(), error: Some("handoff.json is missing".into()), doc: None })
        }
        Err(e) => return Ok(Peek { error: Some(format!("handoff.json could not be read ({e})")), ..Peek::default() }),
    };
    Ok(match serde_json::from_str(&text) {
        Ok(doc) => Peek { doc: Some(doc), ..Peek::default() },
        Err(e) => Peek { error: Some(format!("handoff.json is not valid JSON ({e})")), ..Peek::default() },
    })
}

/// A message folder by its key (waiting, not claimed) or its claim.
fn message_dir(root: &Path, name: &str) -> Result<PathBuf, String> {
    if name.starts_with(CLAIMED) {
        claim_dir(root, name)
    } else {
        key_ok(name)?;
        Ok(inbox(root).join(name))
    }
}

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    pub exists: bool,
    pub sha: Option<String>,
    /// The pixel size after the file's EXIF rotation.
    pub w: u32,
    pub h: u32,
}

/// Width and height as the page is shown: after its EXIF rotation.
pub fn upright_size(p: &Path) -> Option<(u32, u32)> {
    use image::metadata::Orientation::{Rotate270, Rotate270FlipH, Rotate90, Rotate90FlipH};
    use image::ImageDecoder;
    let mut dec = image::ImageReader::open(p).ok()?.with_guessed_format().ok()?.into_decoder().ok()?;
    let (w, h) = dec.dimensions();
    Some(match dec.orientation() {
        Ok(Rotate90 | Rotate270 | Rotate90FlipH | Rotate270FlipH) => (h, w),
        _ => (w, h),
    })
}

fn sha256_hex(p: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    let mut f = File::open(p).ok()?;
    let mut h = Sha256::new();
    std::io::copy(&mut f, &mut h).ok()?;
    Some(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn fact(p: &Path) -> Fact {
    if !p.is_file() {
        return Fact::default();
    }
    let (w, h) = upright_size(p).unwrap_or((0, 0));
    Fact { exists: true, sha: sha256_hex(p), w, h }
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    pub message: Vec<Fact>,
    pub pear: Vec<Fact>,
}

/// The sha256 and upright size of message raws (`raws/<name>` of a key or a
/// claim) and of library pages, for pairing (section 8.4.4). Only reads.
pub fn facts(root: &Path, name: &str, rels: &[String], pear: &[String]) -> Result<Facts, String> {
    let dir = message_dir(root, name)?;
    let lib = root.join(SUBFOLDER);
    let mut out = Facts::default();
    for rel in rels {
        out.message.push(message_file(&dir, rel).map(|p| fact(&p)).unwrap_or_default());
    }
    for p in pear {
        let path = Path::new(p);
        if !path.is_absolute() || !contains(&lib, path) {
            return Err(format!("{p} is not inside the library"));
        }
        out.pear.push(fact(path));
    }
    Ok(out)
}

// ---------- content candidates (contract section 8.4.2) ----------
// A Pear title whose raws hold a byte-identical copy of a message raw is a
// candidate. Cheap by design: sizes come from the file system (no read), and
// only files whose sizes are equal are hashed.

fn file_size(p: &Path) -> Option<u64> {
    fs::metadata(p).ok().filter(|m| m.is_file()).map(|m| m.len())
}

/// The sizes of a message's files, read in place (stat only). `None` for a
/// path that is not a message file or a file that is not there.
pub fn sizes(root: &Path, name: &str, rels: &[String]) -> Result<Vec<Option<u64>>, String> {
    let dir = message_dir(root, name)?;
    Ok(rels.iter().map(|rel| message_file(&dir, rel).ok().and_then(|p| file_size(&p))).collect())
}

#[derive(Serialize, Debug, PartialEq)]
pub struct RawSize {
    pub name: String,
    pub size: u64,
}

/// The files in each chapter folder's `raws/`, with their sizes (one listing
/// and a stat each). Every folder must be inside the library.
pub fn raw_sizes(root: &Path, dirs: &[String]) -> Result<Vec<Vec<RawSize>>, String> {
    let lib = root.join(SUBFOLDER);
    let mut out = Vec::with_capacity(dirs.len());
    for d in dirs {
        let dir = Path::new(d);
        if !dir.is_absolute() || !contains(&lib, dir) || dir == lib {
            return Err(format!("{d} is not inside the library"));
        }
        let mut files = Vec::new();
        if let Ok(entries) = fs::read_dir(dir.join("raws")) {
            for e in entries.flatten() {
                let Ok(meta) = e.metadata() else { continue };
                let name = e.file_name().to_string_lossy().into_owned();
                if meta.is_file() && !name.starts_with('.') {
                    files.push(RawSize { name, size: meta.len() });
                }
            }
        }
        files.sort_by(|a, b| a.name.cmp(&b.name));
        out.push(files);
    }
    Ok(out)
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct Hashes {
    pub message: Vec<Option<String>>,
    pub pear: Vec<Option<String>>,
}

/// The sha256 of some message files (in place) and some library files: the
/// ones whose sizes are equal. No image is decoded.
pub fn hashes(root: &Path, name: &str, rels: &[String], pear: &[String]) -> Result<Hashes, String> {
    let dir = message_dir(root, name)?;
    let lib = root.join(SUBFOLDER);
    let mut out = Hashes::default();
    for rel in rels {
        out.message.push(message_file(&dir, rel).ok().filter(|p| p.is_file()).and_then(|p| sha256_hex(&p)));
    }
    for p in pear {
        let path = Path::new(p);
        if !path.is_absolute() || !contains(&lib, path) {
            return Err(format!("{p} is not inside the library"));
        }
        out.pear.push(Some(path).filter(|p| p.is_file()).and_then(sha256_hex));
    }
    Ok(out)
}

/// More than one name on disk (the cleaner's page and the message's raw).
fn linked(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        fs::metadata(path).map(|m| m.nlink() > 1).unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        crate::data_folder::has_links(path)
    }
}

/// Identical raws (section 8.4.4): when the library raw at `dest` has the
/// bytes of the message's raw and that raw is a hard link, the library takes
/// the same file. Linked to a temp name beside `dest`, then renamed over it,
/// so `dest` is never missing. Run only after `chapter.json` with the link is
/// written. Any failure leaves everything as it was: `Ok(false)`.
pub fn share_raw(root: &Path, claim: &str, rel: &str, dest: &Path) -> Result<bool, String> {
    let src = message_file(&claim_dir(root, claim)?, rel)?;
    let lib = root.join(SUBFOLDER);
    if !dest.is_absolute() || !contains(&lib, dest) || !dest.is_file() {
        return Err(format!("{} is not a page in the library", dest.display()));
    }
    if !linked(&src) || !same(root, claim, rel, dest).unwrap_or(false) {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if fs::metadata(&src).map(|m| m.ino()).ok() == fs::metadata(dest).map(|m| m.ino()).ok() {
            return Ok(true);
        }
    }
    let name = dest.file_name().and_then(|n| n.to_str()).unwrap_or("page");
    let tmp = free_name(&dest.with_file_name(format!(".{name}.sharing-{:x}", crate::data_folder::nanos() & 0xffff_ffff)));
    if fs::hard_link(&src, &tmp).is_err() {
        return Ok(false);
    }
    if fs::rename(&tmp, dest).is_err() {
        let _ = fs::remove_file(&tmp);
        return Ok(false);
    }
    if let Some(dir) = dest.parent() {
        sync_dir(dir);
    }
    Ok(true)
}

// ---------- commands ----------

/// The root the webview names must be the data folder in use, in good order.
fn shared_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>, root: &str) -> Result<PathBuf, String> {
    let st = crate::data_folder::status(&crate::data_folder::paths_for(app)?);
    match st.pointer {
        Some(p) if st.state == "ok" && p.path == root => Ok(PathBuf::from(root)),
        _ => Err("The shared data folder is not available.".into()),
    }
}

#[tauri::command]
pub fn handoff_list<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: String) -> Result<Vec<String>, String> {
    list(&shared_root(&app, &root)?)
}

#[tauri::command]
pub fn handoff_recover<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: String) -> Result<u32, String> {
    recover(&shared_root(&app, &root)?)
}

#[tauri::command]
pub fn handoff_claim<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: String, key: String) -> Result<Option<String>, String> {
    claim(&shared_root(&app, &root)?, &key)
}

#[tauri::command]
pub fn handoff_read<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: String, claim: String) -> Result<Message, String> {
    read(&shared_root(&app, &root)?, &claim)
}

#[tauri::command]
pub fn handoff_take<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: String, claim: String, rel: String, dest: String) -> Result<(), String> {
    take(&shared_root(&app, &root)?, &claim, &rel, Path::new(&dest))
}

#[tauri::command]
pub fn handoff_give_back<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: String, claim: String, rel: String, from: String) -> Result<(), String> {
    give_back(&shared_root(&app, &root)?, &claim, &rel, Path::new(&from))
}

#[tauri::command]
pub fn handoff_same<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: String, claim: String, rel: String, path: String) -> Result<bool, String> {
    same(&shared_root(&app, &root)?, &claim, &rel, Path::new(&path))
}

#[tauri::command]
pub fn handoff_put_back<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: String, claim: String, key: String) -> Result<String, String> {
    put_back(&shared_root(&app, &root)?, &claim, &key).map(str::to_string)
}

#[tauri::command]
pub fn handoff_reject<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: String, claim: String, key: String, reason: String) -> Result<String, String> {
    reject(&shared_root(&app, &root)?, &claim, &key, &reason)
}

#[tauri::command]
pub fn handoff_done<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: String, claim: String) -> Result<(), String> {
    done(&shared_root(&app, &root)?, &claim)
}

#[tauri::command]
pub fn handoff_scan<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: String) -> Result<Vec<Entry>, String> {
    scan(&shared_root(&app, &root)?)
}

#[tauri::command]
pub fn handoff_peek<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: String, key: String) -> Result<Peek, String> {
    peek(&shared_root(&app, &root)?, &key)
}

#[tauri::command]
pub async fn handoff_facts<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: String, name: String, rels: Vec<String>, pear: Vec<String>) -> Result<Facts, String> {
    let root = shared_root(&app, &root)?;
    tauri::async_runtime::spawn_blocking(move || facts(&root, &name, &rels, &pear)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn handoff_sizes<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: String, name: String, rels: Vec<String>) -> Result<Vec<Option<u64>>, String> {
    let root = shared_root(&app, &root)?;
    tauri::async_runtime::spawn_blocking(move || sizes(&root, &name, &rels)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn handoff_raw_sizes<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: String, dirs: Vec<String>) -> Result<Vec<Vec<RawSize>>, String> {
    let root = shared_root(&app, &root)?;
    tauri::async_runtime::spawn_blocking(move || raw_sizes(&root, &dirs)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn handoff_hashes<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: String, name: String, rels: Vec<String>, pear: Vec<String>) -> Result<Hashes, String> {
    let root = shared_root(&app, &root)?;
    tauri::async_runtime::spawn_blocking(move || hashes(&root, &name, &rels, &pear)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn handoff_share_raw<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: String, claim: String, rel: String, dest: String) -> Result<bool, String> {
    share_raw(&shared_root(&app, &root)?, &claim, &rel, Path::new(&dest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_folder::tests::scratch;

    fn message(root: &Path, key: &str) {
        let m = inbox(root).join(key);
        fs::create_dir_all(m.join("raws")).unwrap();
        fs::create_dir_all(m.join("cleaned")).unwrap();
        let img = image::GrayImage::from_pixel(4, 6, image::Luma([200u8]));
        img.save(m.join("raws").join("001.png")).unwrap();
        img.save(m.join("cleaned").join("001.png")).unwrap();
        fs::write(
            m.join("handoff.json"),
            r#"{"schema":1,"pages":[{"sourceIdx":0,"position":1,"raw":"raws/001.png","cleaned":"cleaned/001.png","w":4,"h":6},
                {"sourceIdx":1,"position":2,"raw":"raws/../../x","cleaned":null}]}"#,
        )
        .unwrap();
    }

    #[test]
    fn sizes_raw_index_and_hashes_for_content_candidates() {
        let root = scratch("handoff-content");
        message(&root, "cleaner-L-p1-c1");
        let ch = root.join(SUBFOLDER).join("S").join("001");
        fs::create_dir_all(ch.join("raws")).unwrap();
        fs::copy(inbox(&root).join("cleaner-L-p1-c1").join("raws").join("001.png"), ch.join("raws").join("001.png")).unwrap();
        fs::write(ch.join("raws").join("002.png"), b"not the same").unwrap();
        fs::write(ch.join("raws").join(".DS_Store"), b"x").unwrap();
        let key = "cleaner-L-p1-c1";
        let rels = vec!["raws/001.png".to_string(), "raws/../../x".to_string(), "raws/009.png".to_string()];
        let sz = sizes(&root, key, &rels).unwrap();
        let own = fs::metadata(ch.join("raws").join("001.png")).unwrap().len();
        assert_eq!(sz, vec![Some(own), None, None]);
        assert!(sizes(&root, "../x", &rels).is_err());

        let dirs = vec![ch.to_string_lossy().into_owned(), root.join(SUBFOLDER).join("S").join("none").to_string_lossy().into_owned()];
        let index = raw_sizes(&root, &dirs).unwrap();
        assert_eq!(index[0], vec![RawSize { name: "001.png".into(), size: own }, RawSize { name: "002.png".into(), size: 12 }]);
        assert!(index[1].is_empty());
        assert!(raw_sizes(&root, &[root.to_string_lossy().into_owned()]).is_err(), "only folders inside the library");

        let pear = vec![ch.join("raws").join("001.png").to_string_lossy().into_owned(), ch.join("raws").join("002.png").to_string_lossy().into_owned()];
        let h = hashes(&root, key, &rels[..1], &pear).unwrap();
        assert_eq!(h.message[0], h.pear[0]);
        assert!(h.message[0].is_some() && h.pear[1].is_some() && h.pear[1] != h.pear[0]);
        assert!(hashes(&root, key, &rels[..1], &[root.join("x").to_string_lossy().into_owned()]).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    /// `cargo test --lib handoff::tests::raw_index_time -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn raw_index_time_on_3000_raws() {
        let root = scratch("handoff-3000");
        let mut dirs = Vec::new();
        for c in 0..100 {
            let ch = root.join(SUBFOLDER).join("S").join(format!("{c:03}"));
            fs::create_dir_all(ch.join("raws")).unwrap();
            for i in 0..30 {
                fs::write(ch.join("raws").join(format!("{i:03}.png")), vec![0u8; 1000 + c * 30 + i]).unwrap();
            }
            dirs.push(ch.to_string_lossy().into_owned());
        }
        let t = std::time::Instant::now();
        let index = raw_sizes(&root, &dirs).unwrap();
        let took = t.elapsed();
        assert_eq!(index.iter().map(Vec::len).sum::<usize>(), 3000);
        println!("raw index of 3000 raws in 100 chapters: {took:?}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn claim_read_take_and_done() {
        let root = scratch("handoff");
        fs::create_dir_all(root.join(SUBFOLDER).join("S").join("c").join("raws")).unwrap();
        message(&root, "cleaner-L-p1-c1");
        fs::create_dir_all(inbox(&root).join(".staging-x")).unwrap();
        assert_eq!(list(&root).unwrap(), vec!["cleaner-L-p1-c1".to_string()]);
        let c = claim(&root, "cleaner-L-p1-c1").unwrap().unwrap();
        assert!(claim(&root, "cleaner-L-p1-c1").unwrap().is_none(), "a claimed message cannot be claimed twice");
        assert_eq!(key_of_claim(&c), Some("cleaner-L-p1-c1"));
        let m = read(&root, &c).unwrap();
        assert!(m.error.is_none());
        let f = &m.files["raws/001.png"];
        assert_eq!((f.exists, f.w, f.h), (true, 4, 6));
        assert!(!m.files["raws/../../x"].exists, "a path out of the message is never looked at");

        let dest = root.join(SUBFOLDER).join("S").join("c").join("raws").join("001.png");
        take(&root, &c, "raws/001.png", &dest).unwrap();
        assert!(dest.is_file());
        assert!(inbox(&root).join(&c).join("raws").join("001.png").is_file(), "the claim stays whole");
        assert!(same(&root, &c, "cleaned/001.png", &dest).unwrap(), "same bytes");
        fs::write(dest.with_file_name("other.png"), b"other").unwrap();
        assert!(!same(&root, &c, "cleaned/001.png", &dest.with_file_name("other.png")).unwrap());
        assert!(same(&root, &c, "cleaned/001.png", &root.join("x.png")).is_err(), "only library files");
        assert!(take(&root, &c, "cleaned/001.png", &dest).is_err(), "never over an existing file");
        assert!(take(&root, &c, "cleaned/001.png", &root.join("outside.png")).is_err(), "only into the library");
        assert!(take(&root, &c, "../handoff.json", &dest.with_file_name("x.png")).is_err());
        give_back(&root, &c, "raws/001.png", &dest).unwrap();
        assert!(!dest.exists());
        assert!(inbox(&root).join(&c).join("raws").join("001.png").is_file());
        // A library file whose message copy is gone is never deleted.
        take(&root, &c, "raws/001.png", &dest).unwrap();
        fs::remove_file(inbox(&root).join(&c).join("raws").join("001.png")).unwrap();
        assert!(give_back(&root, &c, "raws/001.png", &dest).is_err());
        assert!(dest.is_file());
        done(&root, &c).unwrap();
        assert!(list(&root).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scan_stamps_a_new_folder_and_peek_reads_in_place() {
        let root = scratch("handoff-peek");
        message(&root, "k1");
        let before = scan(&root).unwrap();
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].key, "k1");
        let p = peek(&root, "k1").unwrap();
        assert_eq!(p.doc.unwrap()["schema"], 1);
        assert!(peek(&root, ".claimed-x").is_err(), "only waiting messages");
        assert!(peek(&root, "gone").unwrap().gone);
        // Peeking changes nothing: same names, same stamp.
        assert_eq!(scan(&root).unwrap(), before);
        assert_eq!(list(&root).unwrap(), vec!["k1".to_string()]);
        // A newer Save replaces the folder: a new stamp.
        std::thread::sleep(std::time::Duration::from_millis(5));
        fs::rename(inbox(&root).join("k1"), inbox(&root).join(".stale-k1")).unwrap();
        message(&root, "k1");
        fs::remove_dir_all(inbox(&root).join(".stale-k1")).unwrap();
        assert_ne!(scan(&root).unwrap()[0].stamp, before[0].stamp);
        fs::write(inbox(&root).join("k1").join("handoff.json"), "{ nope").unwrap();
        assert!(peek(&root, "k1").unwrap().error.unwrap().contains("not valid JSON"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn facts_and_shared_raws() {
        let root = scratch("handoff-facts");
        let ch = root.join(SUBFOLDER).join("S").join("c").join("raws");
        fs::create_dir_all(&ch).unwrap();
        message(&root, "k1");
        // The message's raw is a link to the cleaner's own page.
        let cleaner = root.join("Cleaner");
        fs::create_dir_all(&cleaner).unwrap();
        fs::hard_link(inbox(&root).join("k1").join("raws").join("001.png"), cleaner.join("page.png")).unwrap();
        let mine = ch.join("001.png");
        fs::copy(cleaner.join("page.png"), &mine).unwrap();
        let other = ch.join("002.png");
        image::GrayImage::from_pixel(6, 4, image::Luma([9u8])).save(&other).unwrap();

        let f = facts(&root, "k1", &["raws/001.png".into(), "raws/none.png".into()], &[mine.display().to_string(), other.display().to_string()]).unwrap();
        assert_eq!((f.message[0].w, f.message[0].h), (4, 6));
        assert!(!f.message[1].exists);
        assert_eq!(f.message[0].sha, f.pear[0].sha);
        assert_ne!(f.message[0].sha, f.pear[1].sha);
        assert_eq!((f.pear[1].w, f.pear[1].h), (6, 4));
        assert!(facts(&root, "k1", &[], &[root.join("x.png").display().to_string()]).is_err(), "library pages only");

        let c = claim(&root, "k1").unwrap().unwrap();
        assert!(!share_raw(&root, &c, "raws/001.png", &other).unwrap(), "different bytes are never shared");
        assert!(share_raw(&root, &c, "raws/001.png", &mine).unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(fs::metadata(&mine).unwrap().ino(), fs::metadata(cleaner.join("page.png")).unwrap().ino());
        }
        assert_eq!(fs::read_dir(&ch).unwrap().count(), 2, "no temp file left");
        assert!(share_raw(&root, &c, "raws/001.png", &root.join("x.png")).is_err());
        // A raw that is not a link (a copy) is not shared.
        fs::remove_file(cleaner.join("page.png")).unwrap();
        let plain_copy = ch.join("003.png");
        fs::copy(&mine, &plain_copy).unwrap();
        done(&root, &c).unwrap();
        message(&root, "k2");
        let c2 = claim(&root, "k2").unwrap().unwrap();
        assert!(!share_raw(&root, &c2, "raws/001.png", &plain_copy).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn put_back_recover_and_reject() {
        let root = scratch("handoff-back");
        message(&root, "k1");
        let c = claim(&root, "k1").unwrap().unwrap();
        assert_eq!(put_back(&root, &c, "k1").unwrap(), "back");
        let c = claim(&root, "k1").unwrap().unwrap();
        message(&root, "k1"); // a newer one arrived
        assert_eq!(put_back(&root, &c, "k1").unwrap(), "dropped");
        assert_eq!(list(&root).unwrap(), vec!["k1".to_string()]);

        // A dead run's claim is put back; this run's own claims are not.
        fs::rename(inbox(&root).join("k1"), inbox(&root).join(".claimed-k1-dead")).unwrap();
        message(&root, "k2");
        let mine = claim(&root, "k2").unwrap().unwrap();
        assert_eq!(recover(&root).unwrap(), 1);
        assert_eq!(list(&root).unwrap(), vec!["k1".to_string()]);
        assert!(inbox(&root).join(&mine).is_dir());

        let at = reject(&root, &mine, "k2", "page 2 is missing").unwrap();
        assert!(Path::new(&at).starts_with(root.join("handoff").join("rejected")));
        assert_eq!(fs::read_to_string(Path::new(&at).join("reason.txt")).unwrap(), "page 2 is missing\n");
        assert!(claim(&root, ".staging-x").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
