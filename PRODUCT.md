# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Scanlators who letter English onto cleaned manga, manhua and manhwa raws. Mostly one person per series, working chapter by chapter, often for hours at a time on a desktop or laptop.

## Product Purpose

Pear (formerly Manga Typesetter) is a desktop app (Tauri webview; macOS first, Windows and Linux builds too) for typesetting comics: it detects and reads the source text, holds the translation, and lets the letterer place, fit and style English text in balloons, captions and SFX, then export the pages. Success is a chapter lettered to a human letterer's standard in less time.

## Positioning

Lettering-first rather than translation-first: balloon-aware fitting, per-series text styles and character voices, and AI agents (Claude Code, Codex, Antigravity) that can letter through the app's own tools over a local MCP door.

## Operating Context

- A library folder holds projects; a project is one series; chapters sit inside a project with their raws, cleaned pages and translations.
- The editor is the main surface; the home screens (projects, a project's chapters) and Settings are where a session starts and ends.
- A chapter opens as a typesetting chapter or a translation workspace.
- Detection and OCR run locally (Japanese, Chinese, Korean sources).
- Manga Cleaner (~/dev/manga-cleaner) is the sibling app for cleaning raws; the two share a visual lineage.

## Capabilities and Constraints

- Settings are saved in three places: this computer (prefs), the series (project.json, travels with the folder), one chapter (chapter.json).
- Series settings exist only while a chapter of that series is open.
- No font files ship with the app (licensing); user-loaded fonts are first class.
- Desktop only for real use; the browser dev build lacks the file system and native dialogs.

## Brand Commitments

- Name and wordmark: "Pear", set as a spaced uppercase wordmark. The icon is a white pear on a near-black tile.
- Warm-neutral greyscale UI in light and dark themes; colour belongs to the manga page, not the chrome. Sakura, Jade and Ocean (Manga Cleaner's themes) are opt-in colour themes, and the Dock icon follows the theme.

## Product Principles

1. The page is the work; chrome stays quiet and out of its way.
2. Say where a setting is kept, so nobody changes a series by accident.
3. One control vocabulary across the app; a setting looks the same wherever it lives.
4. Plain, short words in the interface.
</content>
</invoke>
<invoke name="Bash">
<parameter name="command">cat /Users/caved/.claude/plugins/cache/impeccable/impeccable/4.0.4/skills/impeccable/reference/craft-floor.md