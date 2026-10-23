//! The twelve sound types: how each one lays its letters out, as data.
//!
//! A type is a layout and nothing else: it never changes the box's look
//! (font, fill, outlines are the user's). Applying one resets the box's
//! layout fields to unset, and [`super::params`] fills every unset number
//! from here, so this table is the one place a type's numbers live.
//!
//! The names and the character of each type follow the manga convention the
//! Giongo generator also uses, and so do the numbers: the user asked for its
//! presets exactly, as measured in `docs/giongo/04-reference-controls.md`
//! (sections 1.1, 1.2 and 1.4). A path's centre there is in the reference's
//! design units; here it is that divided by the em of the type's own example
//! text, as the doc's table works it out.
//!
//! Lengths are in ems of the box's font size, angles in degrees.

/// Where one text group's path lies when the box has none of its own: its
/// centre, its direction and its bend. The length is the group's natural
/// length (see [`super::place`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PathShape {
    pub dx: f64,
    pub dy: f64,
    /// Degrees, clockwise on the screen (y down): -12 climbs to the right.
    pub angle: f64,
    /// Pushes the curve's control point sideways, as a share of its length.
    pub bend: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Kind {
    pub id: &'static str,
    pub name: &'static str,
    /// A sound this type suits, as the card shows it.
    pub example: &'static str,
    /// The lettering tag whose font the type asks for (`lettering.js`).
    pub tag: &'static str,
    pub vertical: bool,
    /// Letter size at the start and the end of a group, and the ease.
    pub flow: (f64, f64, f64),
    /// 0 letters upright .. 1 letters turn with the path.
    pub follow: f64,
    /// Ems between letters.
    pub gap: f64,
    pub slant: f64,
    pub rise: f64,
    /// Seeded per letter: turn (degrees), size (spread), sideways offset (ems).
    pub jitter: (f64, f64, f64),
    /// One shape per group; a group past the end is stacked.
    pub paths: &'static [PathShape],
}

/// A path shape: its angle, its bend, and its centre off the box's (ems).
const fn path(angle: f64, bend: f64, dx: f64, dy: f64) -> PathShape {
    PathShape {
        dx,
        dy,
        angle,
        bend,
    }
}

pub const KINDS: &[Kind] = &[
    Kind {
        id: "impact",
        name: "Impact",
        example: "ドン!!",
        tag: "blocky",
        vertical: false,
        flow: (0.78, 1.3, 1.0),
        follow: 0.35,
        gap: 0.10,
        slant: 0.0,
        rise: 6.0,
        jitter: (7.0, 0.0, 0.0),
        paths: &[path(-16.4, 0.05, 0.0, 0.077)],
    },
    Kind {
        id: "rumble",
        name: "Rumble",
        example: "ゴゴゴゴ",
        tag: "blocky",
        vertical: false,
        flow: (1.35, 0.55, 0.8),
        follow: 0.6,
        gap: -0.08,
        slant: 0.0,
        rise: 5.0,
        jitter: (4.0, 0.0, 0.0),
        paths: &[path(12.6, -0.05, 0.0, 0.02)],
    },
    Kind {
        id: "slash",
        name: "Slash",
        example: "ザシュッ",
        tag: "sfx-sharp",
        vertical: false,
        flow: (1.25, 0.85, 1.0),
        follow: 0.7,
        gap: -0.08,
        slant: 12.0,
        rise: 6.0,
        jitter: (0.0, 0.0, 0.0),
        paths: &[path(33.7, 0.06, 0.0, 0.0)],
    },
    Kind {
        id: "explosion",
        name: "Explosion",
        example: "バキッ",
        tag: "blocky",
        vertical: false,
        flow: (1.05, 1.25, 1.0),
        follow: 0.3,
        gap: -0.12,
        slant: 0.0,
        rise: 4.0,
        jitter: (9.0, 0.1, 0.3),
        paths: &[path(-6.2, 0.04, 0.0, 0.021)],
    },
    Kind {
        id: "splash",
        name: "Splash",
        example: "ドボーン",
        tag: "sfx",
        vertical: true,
        flow: (0.9, 1.2, 1.0),
        follow: 0.5,
        gap: -0.05,
        slant: 0.0,
        rise: 4.0,
        jitter: (0.0, 0.0, 0.0),
        paths: &[path(88.1, 0.08, 0.057, 0.0)],
    },
    Kind {
        id: "soft",
        name: "Soft",
        example: "きらっ",
        tag: "sfx-soft",
        vertical: false,
        flow: (1.0, 1.1, 1.0),
        follow: 0.4,
        gap: -0.05,
        slant: 0.0,
        rise: 4.0,
        jitter: (10.0, 0.0, 0.6),
        paths: &[path(-8.9, 0.15, 0.0, 0.025)],
    },
    Kind {
        id: "drip",
        name: "Drip",
        example: "ぽちゃん",
        tag: "sfx-soft",
        vertical: false,
        flow: (1.0, 0.9, 1.0),
        follow: 0.6,
        gap: 0.12,
        slant: 0.0,
        rise: 4.0,
        jitter: (0.0, 0.0, 0.0),
        paths: &[path(9.8, -0.12, 0.0, 0.023)],
    },
    Kind {
        id: "small",
        name: "Small",
        example: "ストン",
        tag: "sfx",
        vertical: true,
        flow: (1.0, 1.0, 1.0),
        follow: 0.0,
        gap: 0.08,
        slant: 0.0,
        rise: 4.0,
        jitter: (0.0, 0.0, 0.0),
        paths: &[path(90.0, 0.0, 0.0, 0.0)],
    },
    Kind {
        id: "glare",
        name: "Glare",
        example: "ギ/ロッ",
        tag: "sfx-sharp",
        vertical: true,
        flow: (1.0, 0.9, 1.0),
        follow: 0.4,
        gap: -0.05,
        slant: 0.0,
        rise: 8.0,
        jitter: (6.0, 0.0, 0.0),
        // Group one top left, group two lower right, both 85.6 degrees.
        paths: &[path(85.6, 0.0, -1.42, -0.84), path(85.6, 0.05, 1.53, 0.6)],
    },
    Kind {
        id: "pop",
        name: "Pop",
        example: "ドーン!!",
        tag: "sfx-soft",
        vertical: false,
        flow: (1.0, 1.15, 1.0),
        follow: 0.3,
        gap: -0.05,
        slant: 0.0,
        rise: 5.0,
        jitter: (8.0, 0.0, 0.0),
        paths: &[path(-9.5, 0.08, 0.0, 0.0)],
    },
    Kind {
        id: "silence",
        name: "Silence",
        example: "シーン",
        tag: "sfx",
        vertical: true,
        flow: (1.0, 1.0, 1.0),
        follow: 0.0,
        gap: 0.4,
        slant: 0.0,
        rise: 0.0,
        jitter: (0.0, 0.0, 0.0),
        paths: &[path(90.0, 0.0, 0.0, 0.0)],
    },
    Kind {
        id: "shock",
        name: "Shock",
        example: "ズーン",
        tag: "sfx",
        vertical: true,
        flow: (0.9, 1.3, 1.0),
        follow: 0.5,
        gap: -0.05,
        slant: -8.0,
        rise: 3.0,
        jitter: (0.0, 0.0, 0.0),
        paths: &[path(84.6, -0.1, 0.035, 0.0)],
    },
];

/// The type called `id`, by its index.
pub fn index_of(id: &str) -> Option<usize> {
    KINDS.iter().position(|k| k.id == id)
}

fn num(out: &mut String, v: f64) {
    out.push_str(&v.to_string());
}

/// A JSON string. Non-ASCII text (the examples) is written as `\u` escapes,
/// so the document stays ASCII whatever a label holds.
fn text(out: &mut String, s: &str) {
    out.push('"');
    for unit in s.encode_utf16() {
        match unit {
            0x22 => out.push_str("\\\""),
            0x5c => out.push_str("\\\\"),
            0x20..=0x7e => out.push(unit as u8 as char),
            _ => out.push_str(&format!("\\u{unit:04x}")),
        }
    }
    out.push('"');
}

fn key(out: &mut String, name: &str) {
    text(out, name);
    out.push(':');
}

fn kind_json(out: &mut String, k: &Kind) {
    out.push('{');
    for (name, v) in [
        ("id", k.id),
        ("name", k.name),
        ("example", k.example),
        ("tag", k.tag),
    ] {
        key(out, name);
        text(out, v);
        out.push(',');
    }
    key(out, "dir");
    text(out, if k.vertical { "v" } else { "h" });
    out.push(',');
    key(out, "flow");
    out.push('{');
    for (i, (name, v)) in [("from", k.flow.0), ("to", k.flow.1), ("pow", k.flow.2)]
        .iter()
        .enumerate()
    {
        if i > 0 {
            out.push(',');
        }
        key(out, name);
        num(out, *v);
    }
    out.push('}');
    for (name, v) in [
        ("follow", k.follow),
        ("gap", k.gap),
        ("slant", k.slant),
        ("rise", k.rise),
    ] {
        out.push(',');
        key(out, name);
        num(out, v);
    }
    out.push(',');
    key(out, "jitter");
    out.push('{');
    key(out, "rot");
    num(out, k.jitter.0);
    out.push(',');
    key(out, "size");
    num(out, k.jitter.1);
    out.push(',');
    key(out, "off");
    num(out, k.jitter.2);
    out.push('}');
    out.push('}');
}

/// The table as one ASCII JSON document: `{"kinds":[...]}`, in [`KINDS`]
/// order. The paths are not in it: the engine applies them.
pub fn kinds_json() -> String {
    let mut out = String::from("{\"kinds\":[");
    for (i, k) in KINDS.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        kind_json(&mut out, k);
    }
    out.push_str("]}");
    out
}
