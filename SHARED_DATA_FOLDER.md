# Shared data folder (Manga Cleaner + Pear)

Contract version 2, draft 1 (2026-11-26). Version 2 adds the start flows
(section 5.1), the sister-app test (section 4.1) and title matching
(section 8.4). The plan behind it is `docs/plans/library-sync-plan.md` in the
cleaner and `PLAN_LIBRARY_SYNC.md` in Pear. The same file lives in
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

Version 2 adds:

| # | Requirement | Measure of done |
|---|---|---|
| R7 | **Bring existing titles across.** Every cleaner title can go to Pear. Where Pear already has that title, the cleaner's chapters join it. | Send all titles, match them: no title or chapter shows twice, and no Pear page, text box or lettering changed. |
| R8 | **One app alone: no question.** Without the sister app, the library moves into the shared layout by itself. | First start with no sister: Settings shows `~/Manga Library`, nothing was asked. |
| R9 | **Ask once, clearly.** With the sister present, a dialog asks once; an app that starts after the folder exists asks during its first run. Both directions. | Each case shows its dialog once, and never after "Not now". |

Out of scope (section 12): Pear back to the cleaner, live swap of a chapter
Pear has open, a two-way catalog that both apps write.

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

### 4.1 Is the sister app present?

The **sister app** is the other app: Pear for the cleaner, the cleaner for
Pear. "Installed" cannot be checked the same way on three systems, and an app
that never ran has nothing to share. So the test is: **has the sister run on
this computer?** True when any of these exists:

1. the pointer file (section 4);
2. the sister's app data folder, for its release identifier
   (`com.mangatypesetter.app` or `com.mangacleaner.studio`), in any of the
   system's app data locations (Tauri `app_data_dir`, `app_local_data_dir`,
   `app_config_dir`);
3. the sister's legacy library: Pear `~/Documents/MangaTypesetter`; the
   cleaner `library/` inside its app data folder;
4. the sister's webview data folder (macOS `~/Library/WebKit/<identifier>`;
   on Windows and Linux it sits inside the app data folders of item 2).
   Pear's Rust side does not always create its app data folder, so on macOS
   this is the reliable sign that Pear has run.

- The check only reads. It never creates any of these.
- A dev or side-by-side build (section 4, first bullet) checks the release
  identifiers too: it shares the dev pointer, but a real sister still counts.
- `MANGA_SISTER_PRESENT` set to `1` or `0` overrides the result, for tests.

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

### 5.1 What happens at start

Each app runs this before it opens a library. Every start lands in exactly
one row; the first row that matches wins.

| # | State at start | What the app does |
|---|---|---|
| B | Journal exists (a move is unfinished). Checked first: with a journal, no other row is looked at. | Unavailable; recovery runs (section 7). |
| A | Pointer good, this app's subfolder has its library file | Shared. Nothing to ask. |
| C | Pointer good, this app has no subfolder yet, **first launch of this app** | First-run step "Join" (section 5.5). |
| D | Pointer good, this app has no subfolder yet, the app was used before (Pending) | The dialog (section 5.4), Join variant, once. |
| E | No pointer, **sister not present** | Quiet setup (section 5.2). |
| F | No pointer, sister present | The dialog (section 5.4), Set up variant, once. |

Unavailable for any other reason (section 5 table) stays as in version 1.

"No subfolder yet" also covers a subfolder that exists but is empty. A
non-empty subfolder without its library file is Unavailable: "The Pear (or
Cleaner) folder inside the data folder is damaged."

**First launch** means all of these: this app has no library of its own yet
(the legacy place is absent or holds no title), AND it has never stored a
start answer (section 5.3), AND its own first-run flow is not done (Pear:
`prefs.onboarded` is false; the cleaner: its first-launch dialog is not
done).

### 5.2 Quiet setup (row E)

The app runs Setup at the default place (`~/Manga Library`, section 7)
without asking, only when all of these hold:

- The default place is absent, or an empty folder.
- It is on the same volume as this app's current library, so Setup is one
  `rename`: instant, nothing copied. (No library yet: nothing to check.)
- No file in the current library is cloud-only (section 7, step 2).
- Neither the current library nor the default place is inside a known sync
  folder (section 7, "Default location").
- No job is running. (It runs before the library opens, so none can be.)
- Every check above is made again under `move.lock`, just before the
  rename. The other app's lock rules (section 6) apply as for any setup.

If any check fails, the app stays Legacy and says nothing. Settings > Data
folder still offers Setup. If the sister appears later, row F (or row D for
the sister) asks then.

After a quiet setup the app shows one short notice, once: "Your library now
lives in ~/Manga Library." with a "Show" button that opens the folder.

A new install with no library yet takes the same path: Setup creates the
folder, the marker, this app's subfolder and the pointer. Nothing moves.

### 5.3 Answers are kept per app

Each app stores its own answer in its own settings: the cleaner
`dataFolderPromptAnswered`, Pear `dataFolderFirstRun`. The value records
which question was answered (`setup` or `join`) and how (`accepted`,
`declined`). A declined question is never asked again by that app.
Settings > Data folder always offers the action. A quiet setup stores
`setup`/`accepted`.

Version 1 values are read as: Pear `notNow`, or the cleaner `true` with no
move done, mean `setup`/`declined`; Pear `moved`, or the cleaner `true` after
a move, mean `setup`/`accepted`; Pear `ask` and the cleaner `false` mean no
answer. A `setup`/`declined` answer does not block the Join question: Join
is a different question, asked once.

### 5.4 The dialog (rows D and F)

A centered dialog, not a Home card. Both apps use the same structure and the
same words with the app names swapped, each in its own visual style. The
cleaner translates it into its locales; Pear is English only.

Top to bottom:

1. A small, still drawing: the two app icons, two arrows, one folder. No
   animation loop.
2. Title: "One folder for both apps".
3. Two lines: "Manga Cleaner and Pear keep your titles in one place." and
   "Chapters you clean show up in Pear when you save them."
4. A path row: a folder icon, the path (`~/Manga Library`, or the existing
   data folder for Join), and "Change…" which opens the folder picker. Join
   has no "Change…": the folder is the one the sister already uses.
5. One line that says what will happen:
   - Set up, same volume: "Your library moves there. It takes a moment."
   - Set up, other volume: "Your library (9.7 GB) is copied there. It takes
     about 8 minutes." The time uses 20 MB/s and rounds up to whole minutes.
   - Join: "Pear already uses this folder. Your library (4.4 GB) moves in
     next to it." Same-volume and other-volume variants as for Set up.
   - No library yet: "Nothing to move."
6. Buttons: primary "Use one folder", secondary "Not now".

States in the same dialog:

- **Blocked**: "Close Pear first." (or "Close Manga Cleaner first.") with
  "Check again". The primary button is disabled. "Cannot tell" (section 11)
  asks the user to confirm instead.
- **Working**: a progress bar, "Copying 5.5 of 9.7 GB". The dialog cannot be
  closed; the version 1 busy cover holds the window.
- **Done**: "Done. Both apps now use ~/Manga Library." In the cleaner, when
  it has titles: "You have 19 titles in Manga Cleaner. Send them to Pear?"
  with "Choose titles…" (section 8.4.1) and "Later". Pear cannot see the
  cleaner's titles, so its Done state says only, when the sister is present:
  "To bring your Manga Cleaner titles across, use Send to Pear in Manga
  Cleaner."
- **Failed**: the reason in plain words (section 11), never raw OS text, and
  "Nothing was changed." when that is true.

### 5.5 First-run step "Join" (row C)

- Cleaner: one more step in its first-launch dialog, before the model
  downloads.
- Pear: one more step in its existing onboarding (`src/lib/onboarding`),
  shown only in this case. Pear never shows a second first-run dialog.

Content: "Pear already keeps its titles in ~/Manga Library. Use the same
folder?" (names swapped in Pear) with "Use the same folder" (primary) and
"Keep separate".

- A new install has nothing to move: Join creates this app's subfolder and
  its library file. Mode becomes Shared.
- "Keep separate" stores `join`/`declined`. The app stays in its legacy
  place and does not ask again.

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
   the live data folder or a library. (Not the marker: a moved copy keeps the
   folder's `folderId` by design.)
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

**First run.** Version 2 replaces the version 1 Home card with the start
flows of section 5.1. Nothing moves without a click, except the quiet setup
of row E, which only renames on one volume.

**Pending Move** follows the same preconditions as any move: while the other
app runs, it is refused with "Close Pear first." (or "Close Manga Cleaner
first.").

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
- Version 2 adds two optional fields, with no schema change: `"send":
  "save" | "bulk"` (one Save, or Send to Pear, section 8.4.1) and
  `chapter.cleanedPages`, the count of pages with a cleaned file. A reader
  that does not know them ignores them; a missing `send` means `save`.
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
   the same `libraryId` and `projectId`.
   - Found, and it has no unlinked chapter with the message's chapter key
     (section 8.4.2):
     create the chapter and `rename` the files in.
   - Found, and it has an unlinked chapter with that key: the message
     **waits** (section 8.4.2), as one row.
   - Not found, and Pear has **candidates** (section 8.4.2): the message
     waits.
   - Not found, no candidates: create a project with the message's name and
     layout, then the chapter, as in version 1.
   A waiting message is put back (claim renamed to `<key>`) before anything
   in Pear changes.
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

### 8.4 Bringing titles across (version 2)

**The cleaner sends, Pear matches.** The cleaner knows which chapters have
cleaned pages and already writes a correct message per chapter. Matching
changes Pear's files, and only Pear writes them. The cleaner never reads
Pear's files and Pear never reads the cleaner's: the message carries all
Pear needs.

#### 8.4.1 Send to Pear (cleaner)

Reached from the dialog's Done state, from Home (a "Send titles to Pear"
button while Shared) and from Settings > Data folder.

- One row per cleaner title: a checkbox, the name, "12 chapters, 9 cleaned".
- Checked by default when at least one chapter has a cleaned page. A title
  with none is unchecked and says "Nothing cleaned yet".
- Each cleaner chapter stores `lastSentAt` in the cleaner's own library: the
  time of its last Save or bulk send. A chapter is **changed** when its job
  or manifest was modified after `lastSentAt`.
- A title with at least one sent chapter says "Sent before" (the cleaner
  cannot know whether Pear filed it) and sends only its changed and never
  sent chapters. A "Send all again" option sends every chapter.
- One button: "Send 9 titles". It writes one message per chapter through the
  Save path (section 9), with `"send": "bulk"`, in the background, with
  "Sending 40 of 63 chapters". It can be stopped; messages already written
  stay valid.
- A chapter with no cleaned page is not sent. A later Save sends it.

#### 8.4.2 Candidates and Waiting to match (Pear)

**Normalized name**: lowercase; Unicode NFKC; every character that is not a
letter or a digit becomes a space; the word "the" is removed; runs of spaces
become one; trimmed.

**Chapter key**, used everywhere a chapter number is compared (here and in
section 8.3, step 5): `label` when it reads as a decimal number (`12.5`, or
`12,5` read as `12.5`), else `number`. A label that does not read as a
number (`12-1`, `Extra`) has no key: that chapter is always "New chapter".
Pear stores the key as the chapter's `number` when it creates a chapter.

**Candidates** for a message are Pear's projects with no `cleanerLink`, or
with a `cleanerLink` to a different `libraryId` (a reinstalled cleaner gets a
new one), whose normalized name is close to the message's `project.name`.
Choosing a project linked to another `libraryId` replaces its link; its
chapters linked to that old `libraryId` count as unlinked. Close means
either:

- the edit distance (Levenshtein, on characters) is at most 20 percent of
  the longer normalized name, rounded down; or
- one normalized name contains the other as whole words, and the shorter is
  at least 4 characters long.

So "Dungeon streamer" finds "Dungeon Steamer", and "apocalypse" finds
"Surviving the Apocalypse". Candidates are ranked: smallest distance first,
then containment, then name order.

**Waiting**: a message that waits stays in `handoff/to-typesetter/<key>`,
unclaimed. To list it, Pear's Rust side reads its `handoff.json` in place
(a read-only command; it opens only that file, never the images, and closes
it at once) and never writes there. Pear keeps in memory which keys it has
judged, with their `sentAt`. A key is judged again when its `sentAt` changes
or a Pear project is created, renamed or deleted; otherwise a waiting
message is neither claimed nor re-read. The cleaner retries a directory
rename that fails with a sharing violation 5 times over 1 second, because
Pear may have `handoff.json` open for a moment on Windows. Pear lists
the waiting messages on every check and groups them by
cleaner title `(libraryId, projectId)`. When any waiting message has
`"send": "bulk"`, it shows a banner: "Manga Cleaner sent 9 titles. Match
them to your titles." with "Match…". When only `save` messages wait, it
opens the match screen with those rows (section 8.4.6). A newer Save of a
waiting chapter replaces the message in place (section 8.2); Apply catches
that (section 8.4.3).

#### 8.4.3 The match screen (Pear)

One row per waiting cleaner title:

- Left: the cleaner title and how many chapters wait.
- Right: a choice. The best candidate is preselected, then the other
  candidates, then "New title in Pear", then "Skip". A row that waits for a
  chapter number clash in an already linked project (section 8.3, step 5)
  shows that project, fixed.
- Under each row, a collapsed list of its chapters, each with what will
  happen. Chapters are compared by chapter key (section 8.4.2); a chapter
  with no key is always "New chapter".
  - **New chapter**: the chosen project has no chapter with that number.
  - **Already in Pear: link, keep Pear's pages** (the default when a
    chapter with that number exists and is not linked).
  - **Replace Pear's cleaned pages** (opt-in): as link, then the message's
    cleaned files replace Pear's; the old ones go to `logs/previous-cleaned`.
  - **Add as a separate chapter** (opt-in): a new linked chapter in the same
    project, next to Pear's.
  - **Skip this chapter**.
- If pages cannot be paired (rule below), link and replace are not offered.
  The row says why, for example "Pages differ: 15 here, 14 in Pear", and
  offers "Add as a separate chapter" or "Skip this chapter".

- A Pear project can be chosen by one row only. Once one row picks it, the
  other rows do not offer it.
- A chapter that is open in Pear (main window or an agent window) cannot be
  linked or replaced. Its line says "Close Chapter 12 first" and Apply skips
  it; it keeps waiting.

One button: "Apply". Pear then files every waiting message of the rows not
skipped, in order, each with the version 1 claim, validate and locking rules
(section 8.3 steps 2 to 4). It writes `cleanerLink` into the chosen
project's `project.json` first.

- **Single flight.** The 3-second check pauses while the match screen is
  open, and Apply runs inside the same single flight as filing. No poll can
  file a chapter of a row between the user's choice and Apply.
- **Re-read.** Apply reads each claimed message again. If its `sentAt`
  differs from the one the screen showed, Pear puts it back unapplied and
  shows that row again.
- **Crash during Apply.** Each chapter is one apply (version 1 rule 4). A
  crash leaves some chapters filed and the rest waiting; the claim recovery
  of section 8.3, step 1 puts those back. The next check shows only the rows
  that still wait. A skip of a chapter that Apply did not reach is lost and
  is asked again.

#### 8.4.4 Linking a chapter Pear already has

- **Pairing** needs the same page count on both sides. Then:
  1. Pages whose raws have the same sha256 pair with each other.
  2. The rest pair by position among the unpaired pages (the message's
     `pages` order against Pear's page order), and only when every such pair
     has the same pixel size after EXIF rotation.
  Otherwise the chapter cannot be linked. The chapter line says how pages
  paired ("15 pages: 12 identical, 3 by position"), and the position pairs
  show as small side-by-side thumbnails before Apply.
- **Link, keep Pear's pages**: Pear writes `cleanerLink` (with `sentAt` from
  the message and `pages` from the pairing) and changes no existing image,
  no text box and no lettering. Where a paired Pear page has no cleaned
  file, Pear takes the message's cleaned file for it. The other cleaned
  files in the message are deleted with the message.
- **Identical raws**: when a Pear raw has the same sha256 as the message's
  raw, and the message's raw is a hard link (link count above 1) on the same
  volume, Pear shares the storage. Only after `chapter.json` with the link
  is written: Pear hard-links the message's raw to a temp name beside its
  own raw, then `rename`s the temp file over its raw path. The message stays
  whole until `done`. On any failure (no hard links, file in use on
  Windows), this is skipped and nothing else changes. The bytes are the
  same; this is the one case where a raw path gets a new file, and
  section 2, decision 4 still holds for content. This needs a new Rust
  command; `take` refuses an existing destination.
- From then on, a Save of that chapter updates it as any linked chapter
  (section 8.3, step 6). That Save replaces Pear's cleaned pages where the
  bytes differ; the old ones are kept in `logs/previous-cleaned`.

#### 8.4.5 Skip

Skip claims each of that title's waiting messages, then deletes it, and
records the skip in Pear's own folder: `(libraryId, projectId, skippedAt)`.
Later messages for that title:

- `"send": "bulk"` (a send still running, or a later Send to Pear): deleted
  unasked.
- `"send": "save"` with a `sentAt` after `skippedAt`: waits again, because a
  Save is a clear wish to send. The skip record is removed when that title
  is matched.

A skipped chapter (not the whole title) is handled the same way, keyed by
`(libraryId, projectId, chapterId)`.

#### 8.4.6 Single Saves

The same rules apply to one Save. An unlinked title with candidates waits,
and the match screen shows that one row, instead of a second copy of the
title. This fixes the version 1 duplicate.

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
- Version 2: the sister test (each source, and the override); every start
  row A to F; quiet setup and each check that stops it; answers stored and
  honoured; candidates (the examples in 8.4.2, short names, linked projects
  excluded); waiting put back untouched; match apply for each chapter
  choice; pairing refused on count and on size; identical raws linked;
  skip and a later Save asking again; a single Save with a candidate makes
  no second title.
- **Golden fixtures, version 2**, in both repositories next to the version 1
  one: a message for a title that has a candidate in Pear
  ("Dungeon streamer" against a Pear project "Dungeon Steamer"), and a
  message for a chapter that links by page map to an existing Pear chapter.
  The cleaner's writer test compares against them; Pear's tests match and
  file them.

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

Added in version 2 (found in the 2026-11-25 test):

- **Paths shown to the user** never carry the Windows `\\?\` (or
  `\\?\UNC\`) prefix. Strip it from every path the UI shows.
- **Plain errors.** Move and setup errors map the common OS errors to plain
  words: no space left ("There is not enough free space on that drive."),
  not allowed ("This app is not allowed to write there."), drive gone ("The
  drive was disconnected."), in use ("A file is in use by another app."). Any
  other error: "The move could not finish." The raw text goes to the log
  only.
- **Unavailable retries by itself**: while the Unavailable screen is shown,
  each app checks again every 3 seconds, and on window focus.
- **Unavailable heading for an unfinished move**, both apps: "Data folder
  move not finished", not "Data folder not found".

## 12. Later, not in version 2

- Pear to cleaner ("send back for more cleaning"): `handoff/to-cleaner/`,
  the same rules mirrored.
- Live update of a chapter Pear has open.
- A two-way catalog that both apps write. Matching (section 8.4) covers
  the user's need; the `cleanerLink` records stay its seed.
- Asking before a Save replaces cleaned pages that were painted on in Pear.
  Version 2 keeps the version 1 rule: the old file goes to
  `logs/previous-cleaned`.
- Dedupe of a raw imported by hand into both apps (needs a hash index). The
  supported route is: import in the cleaner, Save to Pear.
