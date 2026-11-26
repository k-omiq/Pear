# Plan: one library for Manga Cleaner and Pear, version 2

Status: plan only, nothing built. Written 2026-11-25 after the shared data folder (version 1)
shipped and was pulled. The same text is in the cleaner repo as `docs/plans/library-sync-plan.md`. The
contract (`docs/shared-data-folder.md`) changes only when this plan is built.

## 1. What the user asked, stated plainly

1. **Bring existing titles across.** Every title and chapter already in the cleaner can go to
   Pear. Where Pear already has that title (made by hand), the cleaner's chapters join it. No
   title or chapter appears twice, and nothing the user did in Pear is lost.
2. **A better first-run prompt.** The question "use one folder for both apps?" looks good, says
   clearly what happens, and is asked once.
3. **One app alone: no question.** If the sister app is not on this computer, the app moves its
   library into the shared layout by itself, at once, without asking.
4. **The second app asks during its onboarding.** When the user starts the other app later, its
   first-run flow asks whether to use the same data folder. Both directions.

Version 1 already does: the shared folder, moves between drives, recovery, and Save in the
cleaner sending one chapter to Pear. Version 1 did not: any title sync (section 12 of the
contract, "a shared project catalog"), and a Save of a title Pear already has made a second
copy of that title in Pear.

## 2. Words

- **Sister app**: the other app. For the cleaner it is Pear, for Pear it is the cleaner.
- **Sister present**: the sister app has run on this computer (section 3).
- **Linked**: a Pear title or chapter that carries a `cleanerLink` (contract 8.3). A Save
  updates a linked chapter in place.
- **Match**: the user's choice of which Pear title (and chapter) an incoming cleaner title (and
  chapter) belongs to.

## 3. Is the sister app present?

"Installed" cannot be checked the same way on three systems, and it is the wrong question: an
app that never ran has no data to share. So the test is: **has the sister run here?** True if
any of these exists:

- the pointer file (`<state dir>/MangaLibrary/data-folder.json`, contract section 4);
- the sister's own app data folder (`com.mangatypesetter.app` or `com.mangacleaner.studio`
  under the system's app data location);
- the sister's legacy library (Pear: `~/Documents/MangaTypesetter`; the cleaner: `library/` in
  its app data folder).

Each app checks this at start, before it opens a library. The check reads only; it never
creates any of these.

## 4. The flows at start

Every start lands in exactly one row. The first matching row wins.

| # | State at start | What the app does |
|---|---|---|
| A | Pointer exists, this app's subfolder exists | Shared. Nothing to ask. |
| B | Journal exists (a move is unfinished) | Unavailable, recovery runs (version 1 rule). |
| C | Pointer exists, this app has no subfolder yet, **first launch of this app** | Onboarding step "Join" (section 6). |
| D | Pointer exists, this app has no subfolder yet, the app was used before | The prompt (section 5), "Join" variant, once. Not now hides it; Settings keeps the offer. |
| E | No pointer, **sister not present** | Quiet setup (section 4.1). |
| F | No pointer, sister present | The prompt (section 5), "Set up" variant, once. |

### 4.1 Quiet setup (row E)

Runs Setup at the default place (`~/Manga Library`) without asking, but only when all hold:

- The default place is absent or an empty folder.
- It is on the same drive as the current library, so Setup is a rename: instant, nothing copied.
- No file in the current library is cloud-only (iCloud, OneDrive). A move out of a synced
  folder can trigger downloads; that case asks instead.
- No job is running (it runs before the library opens, so none can be).

If any check fails, the app stays Legacy and says nothing. Settings > Data folder still offers
Setup. If the sister appears later, row F or D asks then.

After a quiet setup the app shows one short notice, once: "Your library now lives in
~/Manga Library." with a "Show" button that opens the folder.

A brand-new install with no library yet takes the same path: it creates the shared folder
directly.

### 4.2 Answers are kept per app

Each app stores its own answer (the version 1 keys: cleaner `dataFolderPromptAnswered`, Pear
`dataFolderFirstRun`), extended to also cover the Join variant. "Not now" is never asked again;
Settings > Data folder always offers the action.

## 5. The prompt

A centered dialog, not a Home card, so it is seen. Both apps use the same structure and words,
each in its own visual style.

**Layout, top to bottom**

1. A small drawing: the two app icons, two arrows, one folder. It must be quiet, with no
   animation loop.
2. Title: "One folder for both apps"
3. Two short lines:
   - "Manga Cleaner and Pear keep your titles in one place."
   - "Chapters you clean show up in Pear when you save them."
4. A path row: a folder icon, the path (`~/Manga Library`), and a "Change…" link that opens the
   folder picker.
5. One line saying what will happen, which changes with the state:
   - Set up, same drive: "Your library moves there. It takes a moment."
   - Set up, other drive: "Your library (9.7 GB) is copied there. It takes about 8 minutes."
     The estimate uses the measured rate, about 20 MB/s, and rounds up.
   - Join: "Pear already uses this folder. Your library (4.4 GB) moves in next to it."
6. Buttons: primary "Use one folder", secondary "Not now".

**States inside the same dialog**

- **Blocked**: "Close Pear first." with "Check again". The primary button is disabled.
- **Working**: a progress bar with "Copying 5.5 of 9.7 GB". The dialog cannot be closed; the
  version 1 busy cover still holds the window.
- **Done**: "Done. Both apps now use ~/Manga Library." Plus, when both libraries have titles:
  "You have 19 titles in Manga Cleaner. Send them to Pear?" with "Choose titles…" (section 7)
  and "Later".
- **Failed**: the reason in plain words (never raw OS text), and "Nothing was changed." when
  that is true.

The words are the same in both apps with the names swapped. Translated in the cleaner's 6
locales; Pear is English only today.

## 6. Onboarding "Join" step (row C)

- **Cleaner**: one more step in the first-launch dialog (`FirstLaunchDialog.svelte`), placed
  before the model downloads.
- **Pear**: Pear has no first-launch flow today. Add a one-step welcome dialog that shows only
  in this case.

Content: "Pear already keeps its titles in ~/Manga Library. Use the same folder?" with "Use the
same folder" (recommended) and "Keep separate".

- A new install has no library yet, so joining moves nothing: it creates this app's subfolder.
- "Keep separate" records the answer. The app stays Legacy-separate and does not ask again.

## 7. Bring existing titles across (the matching)

### 7.1 Who does what

- **The cleaner sends.** It knows which chapters have cleaned pages, and Save already writes a
  correct message per chapter.
- **Pear matches.** Matching changes Pear's files and risks Pear's work, and only Pear may write
  them (contract: each app writes only its own folder).

The cleaner never reads Pear's files, and Pear never reads the cleaner's. The message carries
everything needed.

### 7.2 In the cleaner: "Send to Pear"

Reached from the Done state of the prompt, from Home (a "Send titles to Pear" button while
Shared), and from Settings > Data folder.

A list of the cleaner's titles, one row each:

- A checkbox, the title name, "12 chapters, 9 cleaned".
- Checked by default when at least one chapter has a cleaned page. A title with nothing cleaned
  is unchecked and labeled "Nothing cleaned yet".
- Already linked titles say "In Pear" and send only chapters changed since their last Save.

One button: "Send 9 titles". It writes one message per chapter through the version 1 Save path,
in the background, with a progress line ("Sending 40 of 63 chapters"). It can be stopped; the
messages already written stay valid.

Chapters with no cleaned page are not sent: Pear would get raws only. A later Save sends them.

### 7.3 In Pear: filing a title it does not know

When a message arrives for a cleaner title that no Pear title is linked to:

1. Pear looks for **candidates**: its unlinked titles whose normalized name is close to the
   message's name. Lowercase, no punctuation, no "the", and close means an edit distance within
   20% or one name containing the other. So "Dungeon streamer" finds "Dungeon Steamer", and
   "apocalypse" finds "surviving the apocalypse".
2. **No candidate**: file it as today. Make a new linked title. No question.
3. **Candidates**: do not file it yet. Leave the message where it is and add the title to a
   "Waiting to match" list. Pear shows a banner: "Manga Cleaner sent 9 titles. Match them to
   your titles." with a "Match…" button.

### 7.4 The match screen (Pear)

One row per waiting cleaner title:

- Left: the cleaner title and its chapter count.
- Right: a dropdown. The best candidate is preselected; then "New title in Pear", then "Skip".
- Under each row, a collapsed list of its chapters. Each chapter shows what will happen:
  - "New chapter": no Pear chapter has that number.
  - "Already in Pear: link, keep Pear's pages" (the default): a Pear chapter with the same
    number exists and is not linked.
  - "Replace Pear's cleaned pages" (opt-in per chapter): the old ones go to
    `logs/previous-cleaned`, as Save already does.
  - "Add as a separate chapter" (opt-in).

One button: "Apply". Then Pear files everything waiting, in order.

### 7.5 Linking a chapter Pear already has ("keep Pear's pages")

- Pages are paired by position, but only when both have the same page count and every pair has
  the same pixel size. Then Pear writes `cleanerLink` with the page map and changes no image.
  Text boxes and lettering are untouched.
- If a raw in Pear is byte-identical to the cleaner's raw (same sha256), Pear replaces its copy
  with a hard link to the cleaner's file. This saves space at no risk, and it is skipped on
  drives without hard links.
- If pages cannot be paired (different count or size), the chapter is not linked. The match
  screen says so before Apply ("Pages differ: 15 here, 14 in Pear") and offers "Add as a
  separate chapter" or "Skip".
- From then on, a Save of that chapter updates it like any linked chapter (version 1 rule 6).

### 7.6 Skip

Skip deletes that title's waiting messages and remembers the skip per cleaner title. A later
Save of that title asks again, because a Save is a clear wish to send.

### 7.7 Single Saves later

The same rules apply to one Save. If the title is unlinked and has candidates, Pear shows the
match screen with that one row instead of making a second copy of the title. This fixes the
version 1 duplicate.

## 8. Contract changes (both repos, same text)

- Section 4: the "sister present" test (section 3 here).
- Section 5: the start table (section 4 here), quiet setup, and the stored answers.
- Section 8.3: "Waiting to match", candidates, the match decisions, linking with a page map,
  identical raws linked, and skip.
- Section 8.1: no message format change is needed. Optional: `chapter.cleanedPages`, a count,
  so Pear can show "9 cleaned" without opening files.
- Section 12: remove "shared project catalog" from Later. Matching covers the user's need. A
  full two-way catalog stays out of scope.

## 9. Also fixed in this round (found in the 2026-11-25 test)

- The cleaner's Pending Move is enabled while Pear runs, but section 7 forbids that. Fix it to
  refuse with "Close Pear first."
- On Windows, the Save notice shows a `\\?\` path prefix. Strip it from every path shown.
- Pear's Unavailable screen waits for Try again after the cleaner's move is killed. It should
  retry by itself every few seconds while visible.
- The cleaner's Unavailable heading for an unfinished move reads "Data folder not found /
  Reconnect the drive". It should say "Data folder move not finished", like Pear.
- Raw OS text in move errors. Map the common ones (no space, not allowed, drive gone) to plain
  words.

## 10. Order of work

1. Contract text (both repos, same commit message). Review it before any code.
2. In parallel, in worktrees, one agent per app:
   - **Cleaner**: section 3, start table, quiet setup, the prompt dialog, onboarding step, Send
     to Pear, fixes from section 9.
   - **Pear**: section 3, start table, quiet setup, the prompt dialog, welcome step, candidates,
     Waiting to match, match screen, linking, fixes from section 9.
3. Golden fixtures: one message for a title with a candidate, and one with a chapter linked by
   page map, checked by both apps' tests.
4. Rehearsal on clones of the real libraries (headless, as on 2026-11-25): send all 19 titles
   and match them. Then check that no Pear page, text box or lettering changed (sha256 of
   every `chapter.json` box list and every image), and that no title or chapter appears twice.
5. VM round (Linux and Windows) with the real UI, as on 2026-11-25. Ask about cost first.
6. Release. The next versions are cleaner 1.0.0-beta.24 and Pear 0.6.0. The pulled numbers
   (beta.22, beta.23, 0.5.0, 0.5.1) are not reused: an app that installed them would not take a
   lower number.

## 11. Open questions for the user

1. **Quiet setup location.** This plan uses `~/Manga Library`, the same default as the prompt.
   "In the same folder" could instead mean "leave the files where they are". That puts the
   shared folder inside the hidden app data folder, which the sister app then shares from. The
   plan prefers `~/Manga Library`: it is visible, and the move is instant either way.
2. **Pear edits to cleaned pages.** If the user painted on a cleaned page inside Pear, a later
   Save from the cleaner replaces it (the old file is kept in `logs/previous-cleaned`). That is
   the version 1 rule. Should a linked chapter with Pear-side paint edits ask before replacing?
</content>
