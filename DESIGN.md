---
name: Pear
description: Warm-neutral greyscale desktop chrome that stays quiet around the manga page.
colors:
  ground: "#e8e7e3"
  panel: "#f6f5f2"
  panel-raised: "#efeeea"
  card: "#fbfaf8"
  surface: "#fcfbf9"
  paper: "#fefdfb"
  art: "#e4e2dd"
  hairline: "rgba(42,38,32,.08)"
  hairline-strong: "rgba(42,38,32,.15)"
  ink: "#22211e"
  ink-quiet: "rgba(34,33,30,.66)"
  ink-faint: "rgba(34,33,30,.55)"
  accent: "#2c2b28"
  accent-fg: "#f8f7f4"
  accent-soft: "rgba(42,38,32,.075)"
  warn: "#8a3f2a"
  page-tint: "rgba(42,38,32,.45)"
  page-tintline: "#2c2b28"
  scrim: "rgba(42,38,32,.28)"
  ground-dark: "#121313"
  panel-dark: "#1a1b1c"
  panel-raised-dark: "#202122"
  surface-dark: "#212223"
  art-dark: "#0d0e0e"
  hairline-dark: "rgba(255,255,255,.07)"
  hairline-strong-dark: "rgba(255,255,255,.13)"
  ink-dark: "#e9e8e5"
  ink-quiet-dark: "rgba(233,232,229,.64)"
  ink-faint-dark: "rgba(233,232,229,.48)"
  accent-dark: "#e9e8e5"
  accent-fg-dark: "#141514"
  accent-soft-dark: "rgba(233,232,229,.10)"
  warn-dark: "#d98b6a"
typography:
  headline:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Hiragino Kaku Gothic ProN\", \"Yu Gothic\", \"Noto Sans JP\", \"Microsoft YaHei\", sans-serif"
    fontSize: "27px"
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  title:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  title-sm:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    letterSpacing: "-0.005em"
  body:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.35
    fontFeature: "tnum"
  body-sm:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.4px"
  list-heading:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "10.5px"
    fontWeight: 400
    letterSpacing: "0.22em"
  wordmark:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "12.5px"
    fontWeight: 600
    letterSpacing: "0.3em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
rounded:
  hairline: "2px"
  xs: "5px"
  sm: "6px"
  md: "8px"
  lg: "9px"
  xl: "12px"
  pill: "16px"
  full: "999px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  section: "34px"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 11px"
    height: "30px"
  button-hover:
    backgroundColor: "{colors.panel-raised}"
  button-accent:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-fg}"
    rounded: "{rounded.sm}"
    padding: "0 11px"
    height: "30px"
  soft-button:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.ink-quiet}"
    rounded: "7px"
    padding: "0 12px"
    height: "28px"
  home-accent-button:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-fg}"
    rounded: "{rounded.md}"
    width: "212px"
    height: "40px"
  segment:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-quiet}"
    rounded: "{rounded.sm}"
    height: "28px"
  segment-on:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-fg}"
  switch:
    backgroundColor: "{colors.panel-raised}"
    rounded: "10px"
    width: "34px"
    height: "18px"
  switch-on:
    backgroundColor: "{colors.accent}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 8px"
    height: "28px"
  chrome-pill:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 12px"
    height: "32px"
  settings-tab:
    textColor: "{colors.ink-quiet}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "30px"
  settings-tab-on:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.ink}"
  settings-row:
    typography: "{typography.body}"
    padding: "6px 0"
    height: "44px"
  menu:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.md}"
    padding: "4px"
  menu-item:
    textColor: "{colors.ink}"
    rounded: "{rounded.xs}"
    padding: "0 10px"
    height: "30px"
---

# Design System: Pear

## Overview

**Creative North Star: "The Quiet Workbench"**

The interface is a set of warm-grey tools laid around a sheet of paper. The manga page is the only thing on screen allowed to carry colour, contrast and weight; everything the app draws for itself is greyscale, small, and one step back. Density is that of a desktop pro tool: a 12.5px body, 28-32px controls, hairline dividers instead of boxes. Both themes are first-class and invert the chrome, never the page.

Structure is rows, not cards. The newest surfaces (Settings, the chapter list) follow the sibling app Manga Cleaner: a full-window column of rows, a label on the left, its control on the right, one quiet sentence under the label, and a hairline under the row. Where something needs to float (the editor's panels, docks and pills), it floats on the panel tone with the soft edge shadow, never a heavier treatment.

Copy is plain and short, and chrome states where a setting is kept: the Settings sidebar groups sections by owner (this computer vs. the series, headed by the series' own name) rather than tagging each row with a scope chip.

**Key Characteristics:**
- Warm-neutral greyscale in light and dark; the accent is the theme's own ink (near-black in light, near-white in dark).
- The manga page sits on paper that does not invert; on-page affordances use their own non-inverting tint.
- System UI font only, tabular numerals everywhere.
- Rows and hairlines over boxed cards; selection is a soft fill, never a weight change.
- One control vocabulary (button, soft button, segment, switch, input) reused in every surface.

## Colors

A single warm-grey family, tinted toward brown (hue of rgb 42,38,32), with the accent drawn from the same ink and one warm rust reserved for warnings.

### Primary
- **Workbench Ink** (accent): the filled state of everything. The selected segment, the on switch, the primary button, the active rail tool, tooltips and toasts. It inverts with the theme (accent-dark), and its foreground pair (accent-fg) always goes with it.
- **Ink Wash** (accent-soft): the soft selected and hover fill. The active Settings tab, a hovered chapter row, the soft button's resting fill, a lit dock button.

### Secondary
- **Rust Warning** (warn / warn-dark): failure and destruction only. A failed autosave dot, an invalid hex border, delete actions (outlined or 14-16% tint, never solid fill), the check-count number, the "Experimental" badge outline.

### Neutral
- **Workbench Ground** (ground): the base layer. Home screens and the Settings column sit on it.
- **Panel** (panel): sidebars (Settings, editor reference), floating panels, menus, chrome pills.
- **Raised Panel** (panel-raised): the hover fill for plain buttons and dock buttons, the off switch track.
- **Surface** (surface): the inside of controls: buttons, inputs, segments, selects.
- **Card** (card): project cover placeholders.
- **Paper** (paper): the manga page frame. Near-white in both themes.
- **Art Ground** (art): the dark-ish field behind the page canvas and the reference sidebar.
- **Hairline / Strong Hairline** (hairline, hairline-strong): row dividers use the light one; control borders use the strong one.
- **Ink / Quiet Ink / Faint Ink** (ink, ink-quiet, ink-faint): text in three steps. Labels and values in ink; descriptions, unselected tabs and secondary facts in quiet; timestamps, placeholders and disabled in faint.
- **Page Tint** (page-tint, page-tintline): on-page selection outlines, handles, caret and rotation grip. Identical in both themes because they draw over paper.

### Named Rules
**The Page Owns Colour Rule.** Chrome is greyscale. The only hues in the UI are the rust warning and the page-status pair (done green #1f9d55, check amber #e08a00), and the status pair is scoped to the pager and page list, where it mirrors the Regions view.

**The Paper Does Not Invert Rule.** Anything drawn over the page (outlines, handles, the review flag, source pills) uses page-tint, page-tintline or the flag rust, never accent, because accent goes near-white in dark mode and would vanish on paper.

**The Theme Token Rule.** Every colour comes from a :root custom property with a light and a dark value. A new surface adds no literal colours.

## Typography

**Body Font:** system-ui (with -apple-system, Segoe UI, Roboto, then Hiragino Kaku Gothic ProN, Yu Gothic, Noto Sans JP, Microsoft YaHei)
**Mono Font:** ui-monospace (SFMono-Regular, Menlo) for hex values, file paths and shortcut keys only.

**Character:** One platform face, set small and even. Hierarchy comes from size steps, weight 500-600 and the three ink steps, not from a second family. Numerals are tabular throughout (set on body and every control).

### Hierarchy
- **Headline** (500, 27px, 1.15, -0.02em): the series name at the head of a project's chapter list. One per screen.
- **Title** (600, 20px, 1.2, -0.01em): the Settings section's h2 at the top of the column.
- **Title small** (600, 14-15px): the Settings sidebar heading and modal heads.
- **Body** (400, 12.5px): row labels, buttons, menu items, chapter names (13px). The app's base size.
- **Body small** (400, 11.5px, 1.5, quiet ink): the sentence under a row label and section intros, capped at 64ch.
- **Label** (600, 11px, 0.4px tracking, uppercase, quiet ink): floating-panel heads and Inspector field labels. Tool chrome only.
- **List heading** (400, 10.5px, 0.22em tracking, uppercase, faint ink): the single heading over a home list ("PROJECTS", "CHAPTERS"). It is the list's own heading, never a lead-in above another heading.
- **Wordmark** (600, 12.5px, 0.3em tracking, uppercase): "PEAR", top-left of the home frame. Brand commitment.

### Named Rules
**The Steady Weight Rule.** Selection never changes font weight; a selected tab or row brightens its colour and gains a fill, so labels never shift under the pointer.

**The Tabular Rule.** Numbers are tabular everywhere, and numeric inputs right-align, so columns of values compare at a glance.

## Layout

Two kinds of screen. The **editor** is full-bleed: the page canvas fills the window on the art ground, with chrome floating over it (pill rows at 12px from the top, a bottom dock at 16px from the floor, a 44px tool rail, draggable floating panels). The page keeps 60px of air on every side and at least 52px clear of the top pill band.

The **Settings screen** is a full window: a 224px sidebar on the panel tone with a hairline right edge, then a scrolling column on the ground, max 680px wide, centred, padded 34px 32px 80px. Sections are 34px apart; a row is at least 44px tall with 6px vertical padding and 16px between label and control. Nested rows indent 18px and dim to 50% while their parent is off. Below 720px the sidebar collapses to a 64px icon strip.

The **home screens** use a frame padded 26px 34px 64px. Projects are a cover grid (min 168px columns, 32px row gap, 20px column gap). Chapters are a full-width table of rows: fixed-width columns for mark (14px), number (64px), status (96px), progress (120px) and time (96px), so values line up down the list. Progress hides below 860px, status and time below 640px.

Spacing runs on 4 / 6 / 8 / 12 / 16, with 34px between major blocks. Control heights are 28px in Settings rows and the Inspector, 30px for standard buttons and menus, 32px for chrome pills, 40px for the home screen's primary actions.

## Elevation & Depth

Mostly flat, with tonal layering between ground, panel and surface. Shadows appear only on things that float over the page or the ground: the page itself, floating panels, chrome pills and docks, menus, toasts and covers. In dark mode the edge shadow gains a 1px white ring, because a shadow alone does not read on a near-black ground. Floating docks and the tool rail sit at 92% panel with a 6px backdrop blur.

### Shadow Vocabulary
- **Edge** (`--edge`: `0 1px 1px rgba(42,38,32,.05), 0 5px 14px rgba(42,38,32,.07)`; dark `0 0 0 1px rgba(255,255,255,.05), 0 6px 20px rgba(0,0,0,.42)`): the paper page, floating panels, pills, menus, toasts, covers.
- **Edge soft** (`--edge-soft`: `0 1px 2px rgba(42,38,32,.05)`; dark a 1px white ring): small on-page badges and pills.
- **Scrim** (`--scrim`): modal overlays, with a 2px blur.

### Named Rules
**The Rows Don't Float Rule.** Settings rows, chapter rows and list content take no shadow. A hairline separates them. Elevation belongs to things that sit over something else.

## Shapes

Gently rounded and small. Controls take 6px (`--radius`); the home screen's larger controls and menus take 7-8px; docks, the chrome menu and font cards take 9px; modals take 12px. Chrome pills are fully rounded at 32px tall (16px). Count chips and badges are full pills (999px). Book covers are nearly square-cornered (3px) so they read as print, and on-page transform handles are 2px squares or circles. Dividers are always 1px hairlines; dashed 1.5-2px strokes are reserved for drop zones and on-page hover and target outlines.

## Components

### Buttons
Quiet, compact, bordered.
- **Shape:** gently rounded (6px), 30px tall, 11px side padding, 15px icons.
- **Default:** surface fill, strong hairline border, ink text. Hover moves to the raised panel fill and a faint-ink border (0.12s).
- **Accent:** accent fill and border, accent-fg text, weight 600. The one filled button in a group.
- **Soft:** accent-soft fill, no visible border, quiet text at 11.5px, 7px corners, 28px tall. Used for secondary actions on home and in dialogs. Its `danger` variant is rust text on a 14% rust tint.
- **Home accent:** 212px by 40px, 8px corners, accent fill, weight 600, 0.02em tracking. The home screen's primary actions stack in one 212px (or 272px for the new-project form) column.
- **Disabled:** dimmed to 0.45-0.55 opacity, never hidden.

### Segmented control
- **Style:** one bordered strip (surface fill, strong hairline, 6px), segments split by hairlines, 28px tall, nowrap.
- **State:** unselected segments in quiet ink, ink on hover; the selected segment fills with accent and accent-fg.

### Switch
- **Style:** 34x18 track, 10px radius, raised-panel fill with a strong hairline; 14px knob in quiet ink.
- **On:** track fills with accent; the knob takes accent-fg and slides 16px (0.15s).
- **Focus:** 2px accent ring outset 2px around the whole track.

### Inputs / Fields
- **Style:** surface fill, strong hairline, 6px corners (5px in the compact tag form), 28px tall in Settings and the Inspector, 30px elsewhere, 12-12.5px text.
- **Focus:** the border turns accent; no glow.
- **Error:** border turns rust; the typed value is kept, not reverted.
- **Selects:** native arrow removed and replaced by a quiet-ink chevron.

### Settings row (signature)
The newest grammar and the template for any preference. Label on the left in body ink, control on the right (flex: none), a quiet one-sentence description under the label at 11.5px, a 1px hairline under the row. Section titles are 12.5px/600 with an optional intro line. A pill badge (10px, strong hairline, 999px) may follow a title to mark state such as "Experimental"; its warn variant uses a rust outline.

### Navigation (Settings sidebar)
- **Tabs:** 30px rows, 16px icon plus label, quiet ink. Hover and selected both take the accent-soft fill and ink colour; weight never changes.
- **Groups:** the app's sections first; the series group below a hairline, headed by the series name (12px/600) with a quiet note saying where it is saved.
- **Back:** a 28px icon button beside the "Settings" heading.

### Chapter row
A full-width, borderless row with a hairline under it, 58px minimum. Status mark, tabular chapter number, title with a quiet sub-line, then right-aligned status, progress and relative time in fixed columns. The whole row takes the accent-soft fill on hover; the "..." row menu appears on hover, focus or when open.

### Row menu and chrome menu
Panel fill, strong hairline, 8-9px corners, edge shadow, 4px inset. Items are 30px, 12.5px text, raised-panel or soft fill on hover. The row menu enters in 0.12s with a 3px rise (cubic-bezier(.2,.8,.2,1)), suppressed under reduced motion.

### Chrome pill
The editor's top-band controls: 32px, fully rounded, panel fill, strong hairline, edge shadow, 12px text. The accent variant fills with accent. Docks use the same family at 9px corners with a 92% panel, blur, and 28px borderless buttons inside.

## Do's and Don'ts

### Do:
- **Do** take every colour from the :root tokens and supply both a light and a dark value for anything new.
- **Do** lay out preferences as Settings rows: label left, control right, one sentence under the label, a hairline under the row, in the 680px column.
- **Do** show where a setting is kept by the sidebar group it lives in, not by a per-row chip.
- **Do** use the shared controls (button, soft button, segment, switch, 28px input) at row scale rather than restyling them per surface.
- **Do** dim a control that cannot act right now (0.45-0.5 opacity) instead of hiding it, so the layout does not shift.
- **Do** use page-tint and page-tintline for anything drawn over the manga page.
- **Do** honour prefers-reduced-motion for every entrance animation.

### Don't:
- **Don't** add hue to the chrome; colour belongs to the manga page. Rust is for warnings and destructive actions only.
- **Don't** wrap rows in boxed cards with their own shadows; separate them with hairlines.
- **Don't** change font weight to show selection.
- **Don't** use accent for on-page affordances; it inverts with the theme and disappears on paper in dark mode.
- **Don't** introduce a second typeface for UI chrome; mono is only for hex, paths and key combos.
- **Don't** put a list heading above another heading as a lead-in; it heads a list on its own.
