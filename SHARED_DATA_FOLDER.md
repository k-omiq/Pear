# Shared data folder (Manga Cleaner + Pear)

Contract version 1, draft 3 (after design review). The same file lives in
both repositories: `manga-cleaner/docs/shared-data-folder.md` and
`manga-typesetter/SHARED_DATA_FOLDER.md`. Change both together.

## 1. The request, stated plainly

Manga Cleaner (removes text from raw pages) and Pear (typesets the
translation onto cleaned pages) are one workflow. Today each app keeps its
own private library, so a chapter is exported from one and imported into the
other by hand, and every page is stored twice.

| # | Requirement | Measure of done |
|---|---|---|
| R1 | Both apps keep their user data in **one data folder**. | Both apps' Settings show the same path. |
| R2 | The user **chooses where** that folder lives, and can change it later, on any local or external drive. | A folder on an external drive works in both apps. |
| R3 | **Migration**: move each app's existing data into the folder, and move the whole folder later, with no data loss on a crash, an unplug or a full disk. | Kill the app at any point of a move: on the next start every chapter opens, at the old place or the new one. |
| R4 | **No duplicates**: a raw page is stored once on disk, and one chapter never shows as two entries. | Sending a 1 GB chapter adds about the size of its cleaned pages, not another 1 GB of raws. Sending it again updates it. Exception: drives without hard links (exFAT, FAT32), where raws are stored twice and Settings says so. |
| R5 | **Sync**: "Save" in the cleaner makes the chapter appear in Pear, and a later Save updates it there. Neither app has to be open when the other acts. | Save in the cleaner, switch to Pear: the chapter is there within a few seconds. |
| R6 | **Save destination option**: the cleaned pages go into the data folder only, or also into a folder next to the raws the user picked. | Both options work, and both sync to Pear. |

Out of scope for version 1 (section 11): Pear back to the cleaner, live swap
of a chapter Pear has open, a shared project catalog.

## 2. Architecture

```
<data folder>/                       chosen by the user (R2)
  manga-library.json                 marker: schema, folder id
  Cleaner/                           the cleaner library, its own format; only the cleaner writes
  Typesetter/                        the Pear library, its own format; only Pear writes
  handoff/to-typesetter/<key>/       messages from the cleaner to Pear (R5)
  handoff/rejected/                  messages Pear could not file, with a reason
  locks/cleaner.lock                 held while the cleaner runs
  locks/typesetter.lock              held while Pear runs

<app state dir>/MangaLibrary/        never moves
  data-folder.json                   the pointer: where the data folder is
  move.lock                          held by whichever app is setting up or moving
  move-journal.json                  only while a move is in progress
```

`<app state dir>` is `~/Library/Application Support` on macOS,
`%LOCALAPPDATA%` on Windows (not the roaming `%APPDATA%`: the folder path is
per machine), `$XDG_CONFIG_HOME` or `~/.config` on Linux.

No folder name starts with a dot. Pear's file scope does not match dot
folders on unix, and users should be able to see what is there.

Six decisions carry the design:

1. **Co-located libraries, one owner each.** Each app keeps its own format in
   its own subfolder and never writes the other's. A shared catalog that both
   apps write would need cross-app locking on every edit and a rewrite of both
   libraries.
2. **Message passing through the filesystem.** The cleaner never writes into
   Pear's library. It drops a complete, self-describing message folder into
   `handoff/to-typesetter/`, and Pear files it with its own code. This works
   with either app closed, and each library keeps one writer.
3. **Hard links for dedupe, only between the two libraries.** A raw in a
   message is a hard link to the cleaner's own page file; Pear moves it into
   its chapter with `rename`, which keeps the link. The file system counts the
   links, so deleting a chapter in one app never breaks the other, and nothing
   needs garbage collection. Files outside the data folder are never linked
   (section 8).
4. **Page files are immutable.** Neither app rewrites an existing raw or
   cleaned file in place. New content gets a new file (temp file, then
   rename). This makes hard links safe. Both apps already work this way
   (cleaner `buffers.rs` `write_atomic`, Pear `copyInto` and fresh names); a
   test keeps it so.
5. **A pointer that never moves** says where the folder is. Moves are
   journaled beside it, so a crash is recovered from a place the move cannot
   take away.
6. **Stable identities, never names.** The folder, each cleaner library, each
   cleaner project and chapter, and each cleaner page have ids that do not
   change when things are renamed, re-cleaned or moved. Nothing is matched by
   name or by file hash.

## 3. Identities

| Thing | Id | Where it lives |
|---|---|---|
| Data folder | `folderId`, a UUID | `manga-library.json` |
| Cleaner library | `libraryId`, a UUID | `Cleaner/index.json` (added on first read if missing) |
| Cleaner project, chapter | `p<N>`, `c<M>` (existing, unique only inside one library) | `Cleaner/index.json` |
| Cleaner page | `sourceIdx`, the row in the manifest's `sources` (rows are never removed, so the index is stable) | the chapter manifest |

A cleaner chapter is named everywhere by `(libraryId, projectId, chapterId)`,
so two libraries (a reinstall, a second machine, "use existing folder") can
never collide. (Not done in version 1: the cleaner's cloud attempt journals are
still keyed by chapter id only; see docs/findings.md.)

A page's file hash is not an identity: re-cleaning can replace a page's source
(`replace_source`) and change its hash and size.

## 4. The pointer

```json
{ "schema": 1, "path": "/Users/me/Manga Library", "folderId": "<uuid>" }
```

- Bundle identifiers other than the release ones (`com.mangacleaner.studio`,
  `com.mangatypesetter.app`) use `MangaLibrary-dev`, so Next and side-by-side
  builds never touch the real folder.
- `MANGA_LIBRARY_POINTER` (a full file path) overrides the location, for tests.
- Written atomically: temp file, fsync, rename, fsync the folder.
- The path is stored as the OS gives it; a path that is not valid UTF-8 is
  refused at setup with a plain message, never mangled.
- A schema the app does not know: Unavailable mode, "set up by a newer
  version". Never overwritten.

## 5. Modes

| Mode | When | Library used | What the user sees |
|---|---|---|---|
| Legacy | No pointer | The old private place | Settings offers "Set up shared folder". |
| Pending | Pointer is good, this app's data is still in its old place | The old private place | A card: "Move your library into the shared folder". |
| Shared | Pointer is good, marker matches `folderId`, own subfolder has its library file (`Cleaner/index.json` or the Pear equivalent), or there was nothing to move and setup created it | `<root>/<App>/` | Normal. |
| Unavailable | Pointer exists, but the folder is missing (unplugged drive), its marker is missing, its `folderId` differs, or a schema is newer | None | A blocking screen: "Data folder not found at X. Reconnect the drive, or choose another folder." |

**Only setup and move create folders.** Every other path (the library index
lock, the app lock, Pear's scan, the marker writer) refuses to create the
root. Without this an unplugged drive or an unmounted share silently gets a
new, empty library.

## 6. Locks

- Each app holds an exclusive OS advisory lock on `locks/<app>.lock` while it
  runs in Shared mode (flock on unix, LockFileEx from byte 0 on Windows; Rust
  `File::try_lock` and the cleaner's `lock::try_exclusive` contend with each
  other).
- "Is the other app running": try its lock without waiting.
- `move.lock` beside the pointer: held by either app for the whole of a setup,
  an adopt or a move. While it is held by the other app, this app refuses to
  set up, adopt, move or file messages, and says why.
- A file system without locks: "cannot tell", and the user confirms the other
  app is closed before a move.

## 7. Migration (R3)

**Preconditions**: `move.lock` taken; the other app not running; this app has
no chapter open, no job running and (Pear) no agent window editing.

**Before copying**

1. **Fix the cleaner's origin paths.** A manifest stores the folder the raws
   came from (`converted_from`, `archived_original`) relative to the manifest,
   as a `..` chain. Moving the library breaks that chain, and the export's
   "never overwrite the raws" guard and the `_cleaned` folder would then point
   at the wrong place. Under each job lock, every such path that leaves the
   tree being moved (the legacy library for a setup, the whole data folder for
   a move) is rewritten as absolute. Paths inside it stay relative.
   (Idempotent; a test moves a library and then exports.)
2. **Cloud placeholders.** Files that are only in the cloud (macOS
   `SF_DATALESS`, Windows `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`) are
   listed; the move refuses until they are downloaded, and says how many.
3. **Free space**: the target volume needs the tree's size (counting each
   hard-linked file once) plus 5 percent.

**The journal.** Both apps write and read the same file,
`<state dir>/MangaLibrary/move-journal.json`, so either app can finish a move
the other one started:

```json
{
  "schema": 1,
  "app": "manga-cleaner" | "pear",
  "kind": "setup" | "move",
  "method": "rename" | "copy",
  "from": "<abs>",
  "to": "<abs>",
  "pointerFile": "<abs path of the pointer to write>",
  "pointer": { "path": "<abs>", "folderId": "<uuid>" },
  "startedAt": "<RFC 3339>",
  "phase": "copying" | "copied" | "switched"
}
```

`kind` is `setup` when only one app's own library moves into `<root>/<App>/`
(a first setup or an adopt), `move` when the whole data folder moves.

**The move:**

1. Write the journal: phase `copying`, method `rename`.
2. Try one `rename(from, to)`. It worked: go to step 5.
3. It failed across volumes: rewrite the journal with method `copy` **before**
   anything is copied. Copy into `<to>.partial`:
   - hard links kept: a file whose (device, inode) was already copied is
     linked to its first copy;
   - symlinks copied as symlinks;
   - every file and folder fsynced.
4. Verify: same relative paths, sizes and link groups; the cleaner also checks
   every page against the sha256 in its manifests. Rename `<to>.partial` to
   `<to>`.
5. Phase `copied`. Write the pointer. Phase `switched`.
6. Method `copy` only: rename the old tree to `<from>.moved-<date>`. It is
   deleted only when the user says so in Settings, after the app has started
   at the new place. Delete refuses any path that is, holds, or sits inside
   the live data folder or a library, or whose marker has the live `folderId`.
7. Remove the journal.

**Recovery**, run by either app at start and again at every status check,
under `move.lock`:

- A journal that does not parse, or has an unknown schema: leave it alone,
  never delete it, and stay Unavailable ("An unfinished move needs a newer
  version").
- `kind` `move` while the other app holds its lock in `from` or `to`: do
  nothing yet, stay Unavailable ("Close the other app to finish the move").
- `copying`, method `rename`: `to` there and `from` gone means the rename
  happened, so go on as `copied`. Otherwise nothing moved: remove the journal.
- `copying`, method `copy`: delete `<to>.partial`, and delete `to` if it is
  there (step 3 started from an absent or empty `to`, so anything there is
  this move's own finished copy). Remove the journal. Data is whole at `from`.
- `copied`: write the pointer, then as `switched`.
- `switched`: method `copy` and `from` still there: set it aside (step 6).
  Remove the journal.

**While a journal exists, both apps are Unavailable.** No app opens a library
at `from` or `to` until the journal is gone, so no edit lands in a tree that
recovery is about to set aside.

**Setup from Legacy** moves only this app's own data into `<root>/<App>/`,
creates the marker (with a new `folderId`) if missing, then writes the
pointer. The other app finds itself in Pending mode at its next start or
focus.

**Default location**: `~/Manga Library`, not `~/Documents`. Documents is
often synced (iCloud "Desktop and Documents" on macOS, OneDrive on Windows),
and a synced library uploads gigabytes of caches and can have its files
evicted, which breaks locks and hard links. A path inside a known sync folder
(`Library/Mobile Documents`, `Library/CloudStorage`, `OneDrive`, `Dropbox`,
`Google Drive`, or `~/Documents` on macOS) gets a warning before it is used.
Pear's current default, `~/Documents/MangaTypesetter`, is the most likely
place for evicted files, which is why step 2 exists.

**Pear's file scope**: at start, and after every setup or move, Pear's Rust
side allows the data folder (`fs_scope().allow_directory(root, true)` and
`asset_protocol_scope().allow_directory(root, true)`), so a folder outside
the home folder works. The deny lists still win.

## 8. Handoff, cleaner to Pear (R4, R5)

### 8.1 The message

```
<root>/handoff/to-typesetter/<key>/
  handoff.json
  raws/<NNN>.<ext>     hard link to the cleaner's page file (copy if linking fails)
  cleaned/<NNN>.png    the cleaned page
```

`<key>` is `cleaner-<libraryId>-<projectId>-<chapterId>`. `<NNN>` is the
1-based position in the cleaner's page order, zero padded to 3 digits.

```json
{
  "schema": 1,
  "from": "manga-cleaner",
  "appVersion": "1.0.0-beta.22",
  "sentAt": "2026-11-25T10:00:00.000Z",
  "cleaner": { "libraryId": "<uuid>", "projectId": "p3", "chapterId": "c7" },
  "project": { "name": "Series name", "layout": "pages" | "longstrip", "readingDirection": "rtl" | "ltr" },
  "chapter": { "title": "Chapter 12", "number": 12, "label": "12.5" },
  "pages": [
    { "sourceIdx": 0, "position": 1,
      "raw": "raws/001.jpg", "rawFormat": "jpeg",
      "cleaned": "cleaned/001.png",
      "w": 1200, "h": 1800 }
  ]
}
```

- `pages` is in the cleaner's reading order. `label` and `number` may be
  `null`.
- `w`/`h` is the size of both files: raw and cleaned always have the same
  pixels and orientation.
- The raw keeps its format (`png`, `jpeg`), linked from the cleaner's copy.
  Only a TIFF source or one with an EXIF rotation is written as an upright PNG
  instead, which costs a second copy of that page.
- 16-bit and CMYK sources: the cleaned page is the cleaner's normal PNG
  export of it; Pear already reads whatever the export writes.
- Longstrip: per-page files in order, never a stitched strip. Pear's
  longstrip layout lays them end to end.
- Denoised pages: the cleaned page is what the cleaner's export writes, which
  includes the chapter's denoise.

### 8.2 Writing it (cleaner)

1. Build in `handoff/to-typesetter/.staging-<key>-<random>/` (the leading dot
   marks work in progress; Pear's Rust side lists the folder, so the scope is
   not involved).
2. If `<key>` exists (not filed yet), rename it to `.stale-<key>-<random>`.
3. Rename the staging folder to `<key>`. Delete the stale one.

### 8.3 Filing it (Pear)

Only Pear's main window files messages, only in Shared mode, never while the
cleaner holds `move.lock`. Checked at start, on window focus, and every 3
seconds while the window is visible. The file moves are done by Pear's Rust
side.

1. **Recover**: at start, every `.claimed-<key>-*` older than this process is
   renamed back to `<key>` (or deleted if a newer `<key>` exists). Filing is
   idempotent, so a message filed twice gives the same result.
2. **Claim**: rename `<key>` to `.claimed-<key>-<random>`. A failed rename
   means it is gone or taken: skip.
3. **Validate**: schema 1, every listed file exists, each cleaned image is
   the size of its raw and of `w`/`h`. A bad message moves to
   `handoff/rejected/<key>-<date>/` with a `reason.txt`, and Pear shows a
   notice. A message is never half applied.
4. **Find the chapter** whose `chapter.json` `cleanerLink` has the same
   `libraryId`, `projectId` and `chapterId`. Hold the chapter's claim and
   record lock (`chapter_claim`, `record_lock`) and the save gate for the
   whole apply, so an autosave or an agent window cannot write between the
   check and the apply.
5. **New chapter**: find the project whose `project.json` `cleanerLink` has
   the same `libraryId` and `projectId`; else create a project with the
   message's name and layout (a same-named project that is not linked is left
   alone: two series can share a name). Create the chapter and `rename` the
   files in.
6. **Existing chapter, closed**: take a snapshot (as every source edit does).
   Match pages by `sourceIdx` through `cleanerLink.pages`.
   - Matched: the new cleaned file replaces the old one (the old one goes to
     `logs/previous-cleaned`). If the raw's size changed, the new raw replaces
     the old one too and the page is respaced (`respacePage`), so its text
     boxes follow the new size. Otherwise the message's raw link is deleted.
   - Unmatched: inserted in the cleaner's order relative to its matched
     neighbours, or at the end when it has none.
   - Pages missing from the message are kept. Pages the user reordered in
     Pear keep Pear's order.
7. **Existing chapter, open**: put the claim back and show "Cleaner sent new
   pages for this chapter. They apply when you close it."
8. **Older `sentAt`** than `cleanerLink.sentAt`: discard.
9. Rescan the library, show "Cleaner sent Chapter 12 (18 pages).", delete
   the claimed folder.

`chapter.json` keeps the link at chapter level (Pear rebuilds page records on
every save and would drop unknown page keys):

```json
"cleanerLink": { "libraryId": "<uuid>", "projectId": "p3", "chapterId": "c7",
                 "sentAt": "...", "pages": [ { "sourceIdx": 0, "pageId": 4 } ] }
```

and `project.json` gets
`"cleanerLink": { "libraryId": "<uuid>", "projectId": "p3" }`.

Pear's `writeFileAtomic` falls back to an in-place write when the scope
refuses a temp file. With the data folder in scope that cannot happen; an
assertion keeps the fallback off library paths.

## 9. Save in the cleaner (R5, R6)

A **Save** action on the chapter (a button, and Cmd/Ctrl+S) exports every
page and writes the message. Setting `saveCleanedTo`:

| Value | Cleaned files go to | Pear gets it |
|---|---|---|
| `data-folder` (default) | The message only; they end up in Pear's chapter `cleaned/` folder inside the data folder. | Yes |
| `next-to-raws` | Also `<raws folder>_cleaned/`, beside the folder the user picked (the existing "new folder" export). | Yes |

- `next-to-raws` **copies** the files into the message (a copy-on-write clone
  where the file system has one: APFS `clonefile`, Linux `FICLONE`, Windows
  ReFS block cloning). It never hard-links them: those are files the user
  opens in other tools, and an in-place save there would silently change
  Pear's page.
- The cleaner promises never to write into the folder the user picked, so
  `next-to-raws` uses the sibling `_cleaned` folder, not the raws folder.
- Save is refused, with the reason, in Legacy, Pending and Unavailable mode,
  and while a run is going.

## 10. Tests that keep the two apps honest

- **Golden fixture**: one small message folder (3 tiny pages, one JPEG raw)
  checked into both repositories. The cleaner's writer test compares its
  output to it (ignoring `sentAt`, `appVersion`, ids); Pear's filer tests file
  it.
- Pointer: round trip, bad schema, newer schema, relative path, dev identifier.
- Modes: legacy, pending, shared, unavailable (missing folder, missing marker,
  wrong `folderId`); nothing is created in Unavailable mode.
- Move: rename path; forced copy path; hard links kept; fsync called; full
  target refused; free space refused; dataless file refused; crash in each
  journal phase recovers; old tree kept as `.moved-<date>`.
- Cleaner: a moved library still guards the raws folder and finds the
  `_cleaned` folder.
- Pear filer: new chapter; update by `sourceIdx`; replaced source with a new
  size respaces; insert in order; open chapter deferral; stale `sentAt`;
  claim race; crash-left claim recovered; rejected message; same-named
  unlinked project left alone; autosave during apply blocked.
- Immutability: no code path writes over an existing raw or cleaned file.

## 11. Details each app settled while building

- Pear's library file is `Typesetter/library.json` (`{"schema":1,"app":"pear"}`);
  the cleaner's is `Cleaner/index.json` plus `Cleaner/library-id.json`.
- A message whose `sentAt` equals the last applied one is stale.
- "Cannot tell whether the other app runs" errors start with `typesetter_unknown:` in
  the cleaner and `CANNOT_TELL:` in Pear; both UIs then ask the user and retry
  with a confirmation.
- Each app lists the old `.moved-<date>` trees it made itself (cleaner:
  `old-copies.json` in the state dir; Pear: localStorage `mt.oldDataCopies`).
- When a re-cleaned page brings a new raw, Pear keeps the old raw on disk.
- Every file move in `handoff/` is done by Rust on both sides (dot names are
  outside Pear's JS file scope).

- A Save with a cleaned page whose bytes equal the one Pear already has does
  not replace it (no churn in `logs/previous-cleaned`).
- The cleaner deletes its own `.staging-*` and `.stale-*` folders older than
  one hour before each Save. Pear never reads them.
- Raws are hard-linked only when the cleaner's page file is inside the data
  folder; a legacy chapter that still reads the user's scan file is copied.

## 12. Later, not in version 1

- Pear to cleaner ("send back for more cleaning"): `handoff/to-cleaner/`,
  the same rules mirrored.
- Live update of a chapter Pear has open.
- A shared project catalog (one list of series and chapters both apps show).
  The `cleanerLink` records are its seed.
- Dedupe of a raw imported by hand into both apps (needs a hash index). The
  supported route is: import in the cleaner, Save to Pear.
