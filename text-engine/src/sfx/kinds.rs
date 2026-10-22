//! The twelve sound types: how each one lays its letters out and how it
//! looks, as data.
//!
//! A type is a starting point, not a mode: applying one writes the layout
//! fields of the box's `sfx` and the look below into the box style, and the
//! user edits from there. The layout numbers are read by [`super::place`];
//! the look is only handed to JS (`mt_sfx_kinds`), which maps it onto the
//! box's effect fields.
//!
//! The names and the character of each type follow the manga convention the
//! Giongo generator also uses. The numbers are ours, set by eye.
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
pub enum FillLook {
    Solid,
    White,
    /// Gray, 0 white .. 1 black.
    Gray(f64),
    /// A dot screen: ink share, cell size in ems.
    Tone {
        density: f64,
        pitch: f64,
    },
    /// A dot screen that fades along `angle`: ink share at the start and at
    /// the end.
    GradTone {
        from: f64,
        to: f64,
        angle: f64,
    },
    /// White letters cut out of a dark shape grown `grow` ems around them.
    Negative {
        grow: f64,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Look {
    pub fill: FillLook,
    /// Outlines, innermost first: width in ems, colour.
    pub outlines: &'static [(f64, &'static str)],
    /// Sharp corners on the outlines instead of round ones.
    pub sharp: bool,
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
    pub look: Look,
}

const fn path(angle: f64, bend: f64) -> PathShape {
    PathShape {
        dx: 0.0,
        dy: 0.0,
        angle,
        bend,
    }
}

const WHITE_RIM: &[(f64, &str)] = &[(0.10, "#ffffff")];
const THIN_WHITE_RIM: &[(f64, &str)] = &[(0.07, "#ffffff")];
const BLACK_WHITE_RIMS: &[(f64, &str)] = &[(0.06, "#111111"), (0.08, "#ffffff")];
const WHITE_BLACK_RIMS: &[(f64, &str)] = &[(0.08, "#ffffff"), (0.06, "#111111")];

pub const KINDS: &[Kind] = &[
    Kind {
        id: "impact",
        name: "Impact",
        example: "ドン!!",
        tag: "blocky",
        vertical: false,
        flow: (0.8, 1.3, 1.0),
        follow: 0.35,
        gap: 0.08,
        slant: 0.0,
        rise: 5.0,
        jitter: (6.0, 0.0, 0.0),
        paths: &[path(-12.0, 0.05)],
        look: Look {
            fill: FillLook::Solid,
            outlines: WHITE_RIM,
            sharp: false,
        },
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
        rise: 4.0,
        jitter: (4.0, 0.0, 0.0),
        paths: &[path(10.0, -0.05)],
        look: Look {
            fill: FillLook::Solid,
            outlines: WHITE_BLACK_RIMS,
            sharp: false,
        },
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
        rise: 5.0,
        jitter: (0.0, 0.0, 0.0),
        paths: &[path(30.0, 0.06)],
        look: Look {
            fill: FillLook::Solid,
            outlines: WHITE_RIM,
            sharp: true,
        },
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
        paths: &[path(-6.0, 0.04)],
        look: Look {
            fill: FillLook::Negative { grow: 0.16 },
            outlines: THIN_WHITE_RIM,
            sharp: true,
        },
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
        paths: &[path(88.0, 0.08)],
        look: Look {
            fill: FillLook::GradTone {
                from: 0.0,
                to: 0.85,
                angle: 90.0,
            },
            outlines: BLACK_WHITE_RIMS,
            sharp: false,
        },
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
        paths: &[path(-8.0, 0.15)],
        look: Look {
            fill: FillLook::White,
            outlines: BLACK_WHITE_RIMS,
            sharp: false,
        },
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
        paths: &[path(8.0, -0.12)],
        look: Look {
            fill: FillLook::Solid,
            outlines: WHITE_RIM,
            sharp: false,
        },
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
        paths: &[path(90.0, 0.0)],
        look: Look {
            fill: FillLook::Solid,
            outlines: THIN_WHITE_RIM,
            sharp: false,
        },
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
        paths: &[
            PathShape {
                dx: 1.4,
                dy: -1.1,
                angle: 92.0,
                bend: 0.0,
            },
            PathShape {
                dx: -1.4,
                dy: 1.1,
                angle: 86.0,
                bend: 0.05,
            },
        ],
        look: Look {
            fill: FillLook::Solid,
            outlines: WHITE_RIM,
            sharp: false,
        },
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
        paths: &[path(-9.0, 0.08)],
        look: Look {
            fill: FillLook::Gray(0.45),
            outlines: BLACK_WHITE_RIMS,
            sharp: false,
        },
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
        paths: &[path(90.0, 0.0)],
        look: Look {
            fill: FillLook::Solid,
            outlines: THIN_WHITE_RIM,
            sharp: false,
        },
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
        paths: &[path(84.0, -0.1)],
        look: Look {
            fill: FillLook::GradTone {
                from: 0.8,
                to: 0.05,
                angle: 90.0,
            },
            outlines: BLACK_WHITE_RIMS,
            sharp: false,
        },
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

fn fill(out: &mut String, f: &FillLook) {
    out.push('{');
    key(out, "type");
    match *f {
        FillLook::Solid => text(out, "solid"),
        FillLook::White => text(out, "white"),
        FillLook::Gray(g) => {
            text(out, "gray");
            out.push(',');
            key(out, "gray");
            num(out, g);
        }
        FillLook::Tone { density, pitch } => {
            text(out, "tone");
            out.push(',');
            key(out, "density");
            num(out, density);
            out.push(',');
            key(out, "pitch");
            num(out, pitch);
        }
        FillLook::GradTone { from, to, angle } => {
            text(out, "gradTone");
            for (k, v) in [("from", from), ("to", to), ("angle", angle)] {
                out.push(',');
                key(out, k);
                num(out, v);
            }
        }
        FillLook::Negative { grow } => {
            text(out, "negative");
            out.push(',');
            key(out, "grow");
            num(out, grow);
        }
    }
    out.push('}');
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
    out.push(',');
    key(out, "look");
    out.push('{');
    key(out, "fill");
    fill(out, &k.look.fill);
    out.push(',');
    key(out, "outlines");
    out.push('[');
    for (i, (w, c)) in k.look.outlines.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('{');
        key(out, "width");
        num(out, *w);
        out.push(',');
        key(out, "color");
        text(out, c);
        out.push('}');
    }
    out.push(']');
    out.push(',');
    key(out, "sharp");
    out.push_str(if k.look.sharp { "true" } else { "false" });
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
