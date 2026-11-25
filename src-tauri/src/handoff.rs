//! The file side of filing Manga Cleaner's messages (SHARED_DATA_FOLDER.md
//! section 8.3). The decisions are the webview's (src/lib/handoff.svelte.js);
//! the moves are here, because the claimed message folder's name starts with
//! a dot and the webview's file scope does not match dot folders on unix.
//!
//! Every path is checked: a message file is `raws/<name>` or
//! `cleaned/<name>` inside a claimed folder of `handoff/to-typesetter/`, and
//! a destination is a new file inside `<root>/Typesetter/`.

use crate::data_folder::{contains, free_name, now_secs, stamp, write_atomic, SUBFOLDER};
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::fs;
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
                    FileInfo { exists: true, w, h }
                }
                _ => FileInfo::default(),
            };
            out.files.insert(rel.to_string(), info);
        }
    }
    out.doc = Some(doc);
    Ok(out)
}

/// Moves one message file into the library. A rename keeps a hard link.
pub fn take(root: &Path, claim: &str, rel: &str, dest: &Path) -> Result<(), String> {
    let src = message_file(&claim_dir(root, claim)?, rel)?;
    library_dest(root, dest)?;
    if fs::symlink_metadata(dest).is_ok() {
        return Err(format!("{} is already there", dest.display()));
    }
    fs::rename(&src, dest).map_err(|e| format!("Could not move {rel} into the library: {e}"))
}

/// The reverse of `take`, for an apply that failed part-way.
pub fn give_back(root: &Path, claim: &str, rel: &str, from: &Path) -> Result<(), String> {
    let dst = message_file(&claim_dir(root, claim)?, rel)?;
    library_dest(root, from)?;
    if fs::symlink_metadata(&dst).is_ok() {
        return Err(format!("{rel} is already back"));
    }
    fs::rename(from, &dst).map_err(|e| e.to_string())
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
        assert!(take(&root, &c, "cleaned/001.png", &dest).is_err(), "never over an existing file");
        assert!(take(&root, &c, "cleaned/001.png", &root.join("outside.png")).is_err(), "only into the library");
        assert!(take(&root, &c, "../handoff.json", &dest.with_file_name("x.png")).is_err());
        give_back(&root, &c, "raws/001.png", &dest).unwrap();
        assert!(!dest.exists());
        done(&root, &c).unwrap();
        assert!(list(&root).unwrap().is_empty());
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
