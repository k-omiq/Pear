//! A paint job: everything one box's glyphs need drawn, as plain data.
//!
//! It mirrors the job `glyphJob` builds in `src/lib/exporter.js`, with the
//! parts the JS loader resolves already resolved: colours are RGBA bytes,
//! the face is a font id with a size, and a pattern names a tile by index.
//!
//! [`decode`] reads the wire form `text-engine/js/paint.mjs` writes: one
//! little-endian buffer per job.

use super::geom::{Affine, IBox, Pt};
use super::roughen::Roughen;
use super::shade::Premul;
use super::special::{Aim, BreakOff, Crack, Lightning, Motion, Scratches, Special, Splash, MAX_SPECIAL_SIZE};
use super::stroke::Join;
use super::warp::{Mesh, MAX_MESH_SIDE};
use super::BoldDraw;
use crate::engine::{Face, Synth};
use crate::Error;

/// Straight (not premultiplied) RGBA, the layout of canvas `ImageData`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgba(pub [u8; 4]);

impl Rgba {
    /// From `0xRRGGBBAA`.
    pub fn from_u32(rgba: u32) -> Self {
        Self(rgba.to_be_bytes())
    }

    pub fn alpha(self) -> f32 {
        f32::from(self.0[3]) / 255.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Stop {
    pub pos: f64,
    pub color: Rgba,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Fill {
    Solid(Rgba),
    /// A seamless, procedural screen in the fill's own frame.
    Screen(super::screen::Screen),
    /// Canvas `createLinearGradient(from, to)`.
    Linear {
        from: Pt,
        to: Pt,
        stops: Vec<Stop>,
    },
    /// Canvas `createRadialGradient(c, 0, c, radius)`.
    Radial {
        centre: Pt,
        radius: f64,
        stops: Vec<Stop>,
    },
    /// Tile number `tile`, repeated every `pitch` job units in both
    /// directions with a tile corner at `origin`.
    Pattern {
        tile: u32,
        pitch: f64,
        origin: Pt,
        /// Painted flat when there is no such tile.
        fallback: Rgba,
    },
}

/// One stroke of the outline, wider than the one painted after it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Band {
    pub color: Rgba,
    /// Canvas `globalAlpha` for this stroke.
    pub opacity: f64,
    /// Canvas `lineWidth`: the whole pen, half of it outside the outline.
    pub line: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Align {
    Left,
    Center,
    Right,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Run {
    pub text: String,
    /// Straight text: the anchor `align` names, on the alphabetic baseline.
    /// Curved text: where the glyph's centre goes.
    pub x: f64,
    pub y: f64,
    /// Curved text only: the glyph's rotation about `(x, y)`, radians.
    pub rot: f64,
    /// Curved text only: the glyph's own scale, about its centre and before
    /// the skew and the turn. Negative mirrors. The run's fill is not scaled
    /// with it: a gradient or a pattern is stated in the frame `x, y, rot`
    /// make, so it is not stretched from letter to letter.
    pub sx: f64,
    pub sy: f64,
    /// Curved text only: the glyph leans, radians, after it is scaled and
    /// before it is turned. Positive leans the top of the letter to the right.
    pub skew: f64,
    /// Curved text only: the lower half of the glyph is pulled down by this
    /// many job units while its top stays where it is; 0 for none. Down is
    /// the job's, whichever way the glyph is turned. A band is pulled with
    /// the outline it is a stroke of.
    pub drip: f64,
    /// This run's own fill; `None` means the job's.
    pub fill: Option<Fill>,
    /// Curved text only: every band of this run's glyphs, and a negative's
    /// grow, is this many times as wide. An SFX letter's rims follow its
    /// size this way (less than in step, so small letters keep thin rims).
    /// 1 for a run like any other.
    pub pen: f64,
    /// An afterimage: the run is painted first, under everything, with its
    /// fill alone. It has no bands, no negative and no shadow, and a job
    /// with no fill does not cut it out.
    pub ghost: bool,
}

/// A negative: the letters grown into one blob of `color`, the bands round
/// the blob instead of the letters, and the letters filled over it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Negative {
    pub color: Rgba,
    /// How far the blob reaches past the letters, job units (times each
    /// run's pen).
    pub grow: f64,
}

/// How the bands of a job are laid. The default is how every job but an
/// SFX is painted.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Effects {
    /// How a band, a negative's blob and a silhouette are joined at a corner.
    /// A fill made heavier by the weight is always round.
    pub join: Join,
    /// Letter by letter: each run's bands and then its fill, in run order,
    /// so a later letter's rim lies over an earlier letter's fill. Otherwise
    /// every band is one shape and the fill is laid over all of them.
    pub each: bool,
    pub negative: Option<Negative>,
    /// With a silhouette: the shape grown this much more, job units (times
    /// each run's pen). A box's shadow sets it; a job on the wire has 0.
    pub grow: f64,
    /// More weight on every glyph, in synthesised bolds: each is grown by
    /// this many times the bold pen of its size on top of what its face
    /// draws, and its bands go round the heavier shape. 0 for none.
    pub embolden: f64,
    /// More lean on every glyph, as the synthesised oblique leans: x moves by
    /// this share of y in the glyph's own frame, about its baseline origin.
    /// Added to the oblique's own. 0 for none.
    pub slant: f64,
    /// Crisp: each straight line's baseline, x-height and cap height are
    /// moved onto whole pixels of the page (one job unit), so the flat
    /// bottoms and tops of letters are one solid row of pixels instead of two
    /// grey ones. Only where the transform keeps job y as device y (no turn,
    /// no vertical mirror) and nothing bends the outlines afterwards. The
    /// point is where a corner of a page pixel is, in device pixels: the
    /// grid is counted from it, because a surface cut a whole device pixel
    /// in from the picture's corner puts the page's pixel rows on odd device
    /// rows at a scale of two. `None` paints exactly.
    pub crisp: Option<Pt>,
    /// Wobble: each letter moved up or down and turned about its middle by
    /// numbers of its own (`Wobble`). `None` leaves every letter where the
    /// shaper put it.
    pub wobble: Option<Wobble>,
    /// Curved text only: the runs are the clusters of one line, in order,
    /// and are shaped as that line (`shape_line_runs`), so a curve keeps the
    /// line's kerning, ligatures and contextual alternates. A box's job sets
    /// it (box wire v22); a job on the glyph wire has no place for it and
    /// shapes each run on its own, as an SFX letter is.
    pub line: bool,
    /// Special effects (wire v15): crack and scratches cut shapes over the
    /// whole box, splash and lightning are the box job's paint on the fill
    /// (`special.rs`). `None` paints the letters as they are.
    pub special: Option<Special>,
    /// What of Crack's and Scratches' cuts this paint lays (not on the
    /// wire): the box's own strokes ask for the letters whole and for the
    /// cuts alone, so a stroke outlines the letters and is then cut through
    /// as a glyph band is.
    pub cuts: Cuts,
    /// The device pixels this paint is seen through (not on the wire): the
    /// box's surface, its corner at device `(0, 0)`. A crack's cuts alone
    /// and its pieces are rastered no further, so a crack far bigger than
    /// the letters makes no raster past it. `None`: as far as they reach.
    pub surface: Option<IBox>,
}

/// [`Effects::cuts`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Cuts {
    /// The letters with the cuts taken out of everything: every job.
    #[default]
    Made,
    /// The letters as if nothing cut them.
    Skipped,
    /// The cuts alone, opaque, and nothing of the letters, rastered no
    /// further than the surface (`Effects::surface`): a cut only takes
    /// away, so what lies past it is never read.
    Alone,
}

/// Letters that jump about: each letter is moved up or down by up to
/// `amount` of its size and turned either way by up to `tilt` degrees,
/// about its own middle. Never moved along the line, so a caret between two
/// letters stays where the shaper put it.
///
/// Which numbers a letter gets is keyed by the seed and the letter's place
/// among the job's letters, counted across its runs and skipping spaces and
/// hyphens (`Glyphs::add_run`): a line broken somewhere else moves only
/// spaces and hyphens, so no letter is given new numbers when its box is
/// resized, and typing at the end leaves the letters before it still.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Wobble {
    pub amount: f64,
    pub tilt: f64,
    pub seed: u32,
    /// How many afterimages of each letter an SFX trail lays (`Run::ghost`):
    /// not on the wire, but read from the run list when it is decoded, so
    /// the box job's own pass of the afterimages alone (the trail laid under
    /// the letters) still knows whose copy each one is and wobbles it as its
    /// letter. The app's writer lays the same number behind every letter
    /// that is a run, in the letters' order, copies that draw nothing for a
    /// letter that cannot trail. Zero when the runs do not divide that way,
    /// and for a job on the wire of afterimages alone, which the app never
    /// writes: then no afterimage wobbles.
    pub copies: u32,
}

impl Wobble {
    /// A wobble of `amount` and `tilt` keyed by `seed`, with no afterimages.
    pub fn new(amount: f64, tilt: f64, seed: u32) -> Self {
        Self {
            amount,
            tilt,
            seed,
            copies: 0,
        }
    }
}

/// Most wobble accepted: a letter moved its whole size, or turned a right
/// angle. Guards, not design limits (the panel stops at 0.4 and 20).
pub const MAX_WOBBLE_AMOUNT: f64 = 1.0;
pub const MAX_WOBBLE_TILT: f64 = 90.0;

impl Default for Effects {
    fn default() -> Self {
        Self {
            join: Join::Round,
            each: false,
            negative: None,
            grow: 0.0,
            embolden: 0.0,
            slant: 0.0,
            crisp: None,
            wobble: None,
            line: false,
            special: None,
            cuts: Cuts::Made,
            surface: None,
        }
    }
}

/// Largest coordinate or side a special effect's box may state, job units.
pub const MAX_SPECIAL_SPAN: f64 = 1_048_576.0;

/// Most extra weight accepted, in synthesised bolds.
pub const MAX_EMBOLDEN: f64 = 8.0;
/// Most extra lean accepted either way: about 56 degrees.
pub const MAX_SLANT: f64 = 1.5;

/// The mitre limit of a mitred band, in half-widths: canvas's default.
pub const MITER_LIMIT: f64 = 10.0;

#[derive(Clone, Debug, PartialEq)]
pub struct Job {
    /// One glyph per run, each centred on its point and turned.
    pub curved: bool,
    pub align: Align,
    /// Straight text only: added after every cluster, the last included.
    pub letter_spacing: f64,
    /// Outermost first.
    pub bands: Vec<Band>,
    /// Paint the glyphs and their widest band as one flat shape in this
    /// colour, instead of bands and fills.
    pub silhouette: Option<Rgba>,
    /// No fill at all: no run's fill and not the job's is painted, and the
    /// glyphs as they would have been filled are cut out of the bands under
    /// them, so what is left of a band is its outer half. With a silhouette
    /// it is cut the same way: the widest band's outer half in one colour.
    /// A job with no band then paints nothing.
    pub no_fill: bool,
    pub fill: Option<Fill>,
    /// The box's mesh warp: every outline, grown by its band or its bold
    /// first, is carried through it before the transform. `None`, or a mesh
    /// that moves nothing, paints the job as it is. A gradient or a pattern
    /// is carried with each glyph it fills, by the mesh's tangent at that
    /// glyph, so a letter keeps the part of the fill it had.
    pub mesh: Option<Mesh>,
    /// The box's roughening: every outline, grown by its band or its bold
    /// first, is carried through a field of noise before the mesh. `None`
    /// paints the job as it is. A fill is not moved with it: only the shape
    /// of a letter is roughened, not what it is filled with.
    pub roughen: Option<Roughen>,
    pub effects: Effects,
    pub runs: Vec<Run>,
}

/// A pattern tile: premultiplied pixels, row by row from the top.
#[derive(Clone, Debug, PartialEq)]
pub struct Tile {
    pub width: u32,
    pub height: u32,
    pub texels: Vec<Premul>,
}

impl Tile {
    /// From straight RGBA8, the layout of canvas `ImageData`.
    pub fn from_rgba(width: u32, height: u32, rgba: &[u8]) -> Option<Self> {
        let n = (width as usize).checked_mul(height as usize)?;
        if rgba.len() != n.checked_mul(4)? {
            return None;
        }
        let mut texels = Vec::new();
        super::budget::reserve_raw(&mut texels, n).ok()?;
        texels.extend(rgba.as_chunks::<4>().0.iter().map(|p| {
            let a = f32::from(p[3]) / 255.0;
            [
                f32::from(p[0]) / 255.0 * a,
                f32::from(p[1]) / 255.0 * a,
                f32::from(p[2]) / 255.0 * a,
                a,
            ]
        }));
        Some(Self {
            width,
            height,
            texels,
        })
    }

    pub fn is_empty(&self) -> bool {
        self.width == 0 || self.height == 0
    }
}

/// A decoded request: the job and everything that came beside it.
pub struct Request {
    pub job: Job,
    /// The font, its size and synthetic style, and the fallback chain a
    /// letter it lacks is looked for in (zero for none).
    pub face: Face,
    /// How a synthesised bold is drawn; `None` for the way that goes with
    /// the engine's `boldAdvance` rule ([`BoldDraw::for_rule`]).
    pub bold_draw: Option<BoldDraw>,
    /// Extra weight: every filled glyph shape is grown by this many device
    /// pixels on every side before it is painted. Zero paints the outline
    /// as the font has it.
    ///
    /// A band is not moved by it: it stays a stroke of the outline the font
    /// has, so the heavier fill covers that much more of it. That is what
    /// was measured: Safari on a Mac draws filled text heavier than its
    /// outline and stroked text exactly on it (P5B-REPORT.md). The
    /// silhouette, which is the fill and the widest band as one shape, is
    /// as wide as the wider of the two.
    pub weight: f64,
    pub transform: Affine,
    pub tiles: Vec<Tile>,
    /// The box's brush ink, painted with the letters in every pass of the
    /// box job (`super::ink`). Only a box job carries it.
    pub ink: Option<super::ink::Ink>,
    /// The faces of a text set in several (v13): empty for a job in one face,
    /// which is every job without the block.
    pub faces: RunFaces,
}

/// A straight job's lines set in more faces than `face` (v13): the faces, at
/// the request's size, and for each run the stretches of its text each is
/// set in. A run with no stretches is set in `face`, as before. Each line is
/// shaped through [`crate::engine::Engine::measure_spans`], the measure the
/// layout broke it by, so a bold word paints exactly as wide as it measured.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RunFaces {
    pub faces: Vec<Face>,
    /// One list per run (or none at all): `(index into faces, UTF-16 range
    /// of the run's text)`, in order and end to end.
    pub spans: Vec<Vec<(u32, core::ops::Range<u32>)>>,
}

impl RunFaces {
    /// The stretches of run `i` with their faces, or `None` when the run is
    /// set in the job's face alone.
    pub fn of(&self, i: usize) -> Option<Vec<(Face, core::ops::Range<u32>)>> {
        let list = self.spans.get(i).filter(|l| !l.is_empty())?;
        Some(list.iter().map(|(k, r)| (self.faces[*k as usize], r.clone())).collect())
    }
}

/// Most faces one job's lines can be set in: four faces of one family, and
/// room for fallback-built faces of more families later.
pub const MAX_RUN_FACES: usize = 16;

/// First four bytes of the wire form: "MTPJ".
pub const MAGIC: u32 = 0x4a50_544d;
/// Bumped when the wire form changes; `paint.mjs` writes the same number.
pub const WIRE_VERSION: u32 = 18;

/// Largest extra weight accepted, in device pixels. A guard, not a design
/// limit: the weight that was measured against the browsers is under one.
pub const MAX_WEIGHT: f64 = 64.0;

/// A run's scale must be at least this far from zero and at most this big
/// (in absolute value): a guard against a glyph collapsed to nothing or
/// grown to fill a surface, not a design limit.
const SCALE_RANGE: core::ops::RangeInclusive<f64> = 0.01..=100.0;

/// Largest skew accepted, radians (about 80 degrees; the tangent is 5.8).
const MAX_SKEW: f64 = 1.4;

/// Largest drip accepted, job units. A guard: a drip is a share of the
/// letter's size.
const MAX_DRIP: f64 = 4096.0;

/// Largest tile side accepted, a guard like the surface's.
const MAX_TILE_SIDE: u32 = 4096;

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

/// One fill record as a glyph job states it, read from the front of `bytes`
/// (a box job's pattern effects take the same record), and its length. `None`
/// is the record for no fill.
pub(crate) fn read_fill(bytes: &[u8]) -> Result<(Option<Fill>, usize), Error> {
    let mut r = Reader { bytes, at: 0 };
    let fill = r.fill()?;
    Ok((fill, r.at))
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], Error> {
        let end = self.at.checked_add(n).ok_or(Error::BadSpec)?;
        let s = self.bytes.get(self.at..end).ok_or(Error::BadSpec)?;
        self.at = end;
        Ok(s)
    }

    fn u32(&mut self) -> Result<u32, Error> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    /// A number that must be finite: a NaN or an infinity in a job is a
    /// malformed job, and refusing it here is what lets the painter's own
    /// arithmetic never meet one.
    fn f64(&mut self) -> Result<f64, Error> {
        let b = self.take(8)?;
        let v = f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]);
        if v.is_finite() {
            Ok(v)
        } else {
            Err(Error::BadSpec)
        }
    }

    fn rgba(&mut self) -> Result<Rgba, Error> {
        let b = self.take(4)?;
        Ok(Rgba([b[0], b[1], b[2], b[3]]))
    }

    fn pt(&mut self) -> Result<Pt, Error> {
        Ok(Pt::new(self.f64()?, self.f64()?))
    }

    /// A count of records of at least `min_size` bytes each, checked against
    /// what is left so a bad count cannot ask for a huge allocation.
    fn count(&mut self, min_size: usize) -> Result<usize, Error> {
        let n = self.u32()? as usize;
        let left = self.bytes.len() - self.at;
        if n.checked_mul(min_size).ok_or(Error::BadSpec)? > left {
            return Err(Error::BadSpec);
        }
        Ok(n)
    }

    fn stops(&mut self) -> Result<Vec<Stop>, Error> {
        let n = self.count(12)?;
        super::budget::collect((0..n).map(|_| {
            Ok(Stop {
                pos: self.f64()?,
                color: self.rgba()?,
            })
        }))
    }

    fn mesh(&mut self) -> Result<Option<Mesh>, Error> {
        let cols = self.u32()?;
        if cols == 0 {
            return Ok(None);
        }
        let rows = self.u32()?;
        if cols > MAX_MESH_SIDE || !(1..=MAX_MESH_SIDE).contains(&rows) {
            return Err(Error::BadSpec);
        }
        let (x, y, w, h) = (self.f64()?, self.f64()?, self.f64()?, self.f64()?);
        if w <= 0.0 || h <= 0.0 {
            return Err(Error::BadSpec);
        }
        // Within the guard the product is small; the bytes left bound it
        // before anything is allocated.
        let n = (cols as usize + 1) * (rows as usize + 1);
        if n * 16 > self.bytes.len() - self.at {
            return Err(Error::BadSpec);
        }
        let pts = super::budget::collect((0..n).map(|_| self.pt()))?;
        Ok(Some(Mesh {
            cols,
            rows,
            pts,
            x,
            y,
            w,
            h,
        }))
    }

    fn roughen(&mut self) -> Result<Option<Roughen>, Error> {
        if self.u32()? == 0 {
            return Ok(None);
        }
        let r = Roughen {
            amount: self.f64()?,
            detail: self.f64()?,
            seed: self.f64()?,
            origin: self.pt()?,
            grit: self.f64()?,
        };
        if r.sound() {
            Ok(Some(r))
        } else {
            Err(Error::BadSpec)
        }
    }

    fn fill(&mut self) -> Result<Option<Fill>, Error> {
        Ok(Some(match self.u32()? {
            0 => return Ok(None),
            1 => Fill::Solid(self.rgba()?),
            2 => Fill::Linear {
                from: self.pt()?,
                to: self.pt()?,
                stops: self.stops()?,
            },
            3 => Fill::Radial {
                centre: self.pt()?,
                radius: self.f64()?,
                stops: self.stops()?,
            },
            4 => Fill::Pattern {
                tile: self.u32()?,
                pitch: self.f64()?,
                origin: self.pt()?,
                fallback: self.rgba()?,
            },
            5 => {
                let screen = super::screen::Screen {
                    kind: self.u32()?,
                    tile: self.u32()?,
                    mode: self.u32()?,
                    seed: self.u32()?,
                    a: self.pt()?,
                    b: self.pt()?,
                    origin: self.pt()?,
                    angle: self.f64()?,
                    aspect: self.f64()?,
                    offset: self.pt()?,
                    density: self.f64()?,
                    line: self.f64()?,
                    fg: self.rgba()?,
                    bg: self.rgba()?,
                    fallback: self.rgba()?,
                    centre: self.pt()?,
                    reach: self.f64()?,
                    fade: match self.u32()? {
                        0 => None,
                        1 => Some((self.pt()?, self.pt()?)),
                        _ => return Err(Error::BadSpec),
                    },
                };
                if !screen.sound() {
                    return Err(Error::BadSpec);
                }
                Fill::Screen(screen)
            }
            _ => return Err(Error::BadSpec),
        }))
    }

    // The v13 block of a job set in several faces (see `decode`). Whether a
    // stretch list covers its run's text is the shaper's to check
    // (`Engine::measure_spans`), which refuses one that does not.
    // The special effects (wire v15). Every number is checked here, so a
    // generator never meets one it cannot use.
    fn special(&mut self) -> Result<Special, Error> {
        let mut rect = [0.0; 4];
        for v in &mut rect {
            *v = self.f64()?;
        }
        if !rect.iter().all(|v| v.is_finite() && v.abs() <= MAX_SPECIAL_SPAN) || !(rect[2] > 0.0 && rect[3] > 0.0) {
            return Err(Error::BadSpec);
        }
        let kinds = self.u32()?;
        // 16 (v16): the crack's pieces break off; only with a crack. 32 (v17): a
        // box's strokes are cut through; only with a crack or scratches. 64
        // (v18): the glyph bands fill the cuts; only with a crack or
        // scratches. 128 (v18): the lightning is aimed; only with a
        // lightning. 256 (v18): the splash is placed; only with a splash.
        if kinds & 15 == 0
            || kinds > 511
            || (kinds & 16 != 0 && kinds & 1 == 0)
            || (kinds & 96 != 0 && kinds & 9 == 0)
            || (kinds & 128 != 0 && kinds & 2 == 0)
            || (kinds & 256 != 0 && kinds & 4 == 0)
        {
            return Err(Error::BadSpec);
        }
        let share = |v: f64, lo: f64, hi: f64| if (lo..=hi).contains(&v) { Ok(v) } else { Err(Error::BadSpec) };
        let turn = |v: f64| if v.is_finite() && v.abs() <= 64.0 { Ok(v) } else { Err(Error::BadSpec) };
        let mut sp = Special {
            rect,
            crack: None,
            break_off: None,
            lightning: None,
            splash: None,
            scratches: None,
            cut_strokes: kinds & 32 != 0,
            fill_bands: kinds & 64 != 0,
        };
        if kinds & 1 != 0 {
            let (amount, size) = (share(self.f64()?, 0.0, 1.0)?, share(self.f64()?, 0.01, MAX_SPECIAL_SIZE)?);
            let at = (share(self.f64()?, 0.0, 1.0)?, share(self.f64()?, 0.0, 1.0)?);
            let spread = share(self.f64()?, 0.0, 1.0)?;
            sp.crack = Some(Crack { amount, size, at, spread, seed: self.u32()? });
            if kinds & 16 != 0 {
                let share = self.f64()?;
                if !(share > 0.0 && share <= 1.0) {
                    return Err(Error::BadSpec);
                }
                let motion = match self.u32()? {
                    0 => Motion::Apart,
                    1 => Motion::Fall,
                    _ => return Err(Error::BadSpec),
                };
                sp.break_off = Some(BreakOff { share, motion });
            }
        }
        if kinds & 2 != 0 {
            let amount = share(self.f64()?, 0.0, 1.0)?;
            let (core, glow) = (self.rgba()?, self.rgba()?);
            let glow_size = share(self.f64()?, 0.0, 3.0)?;
            let seed = self.u32()?;
            let aim = if kinds & 128 != 0 {
                let at = (share(self.f64()?, 0.0, 1.0)?, share(self.f64()?, 0.0, 1.0)?);
                Some(Aim { at, angle: turn(self.f64()?)? })
            } else {
                None
            };
            sp.lightning = Some(Lightning { amount, core, glow, glow_size, seed, aim });
        }
        if kinds & 4 != 0 {
            let (amount, size) = (share(self.f64()?, 0.0, 1.0)?, share(self.f64()?, 0.01, MAX_SPECIAL_SIZE)?);
            let color = self.rgba()?;
            let seed = self.u32()?;
            let (at, spread) = if kinds & 256 != 0 {
                let at = (share(self.f64()?, 0.0, 1.0)?, share(self.f64()?, 0.0, 1.0)?);
                (at, share(self.f64()?, 0.0, 1.0)?)
            } else {
                ((0.5, 0.5), 1.0)
            };
            sp.splash = Some(Splash { amount, size, color, seed, at, spread });
        }
        if kinds & 8 != 0 {
            let (amount, angle) = (share(self.f64()?, 0.0, 1.0)?, turn(self.f64()?)?);
            sp.scratches = Some(Scratches { amount, angle, seed: self.u32()? });
        }
        Ok(sp)
    }

    fn run_faces(&mut self, runs: usize, size: f64) -> Result<RunFaces, Error> {
        let n = self.count(12)?;
        if n == 0 || n > MAX_RUN_FACES {
            return Err(Error::BadSpec);
        }
        let faces = super::budget::collect((0..n).map(|_| {
            Ok(Face {
                font: self.u32()?,
                synth: Synth::from_bits(self.u32()?),
                chain: self.u32()?,
                size,
            })
        }))?;
        if self.u32()? as usize != runs {
            return Err(Error::BadSpec);
        }
        let spans = super::budget::collect((0..runs).map(|_| {
            super::budget::collect((0..self.count(12)?).map(|_| {
                let (k, a, b) = (self.u32()?, self.u32()?, self.u32()?);
                if k as usize >= n || b < a {
                    return Err(Error::BadSpec);
                }
                Ok((k, a..b))
            }))
        }))?;
        Ok(RunFaces { faces, spans })
    }

    fn tiles(&mut self) -> Result<Vec<Tile>, Error> {
        super::budget::collect((0..self.count(8)?).map(|_| {
            let (width, height) = (self.u32()?, self.u32()?);
            if width > MAX_TILE_SIDE || height > MAX_TILE_SIDE {
                return Err(Error::BadSpec);
            }
            let len = width as usize * height as usize * 4;
            Tile::from_rgba(width, height, self.take(len)?).ok_or(Error::BadSpec)
        }))
    }
}

/// Reads one request from its wire form.
///
/// ```text
/// u32 magic, u32 version
/// u32 font, u32 synth bits (1 bold, 2 oblique)
/// u32 fallback chain (0 none)
/// u32 bold drawing (0 as the engine's bold rule has it, 1 outset, 2 smear)
/// f64 size
/// f64 x 6 transform (a, b, c, d, e, f)
/// f64 weight (device pixels, 0 to 64)
/// u32 flags (1 curved, 2 silhouette, 4 no fill, 8 letter by letter,
///     16 negative, 32 crisp v11, 64 wobble v12, 128 faces v13, 256 special
///     v14), u32 align (0 left,
///     1 centre, 2 right)
/// f64 letter spacing
/// rgba silhouette
/// u32 join (0 round, 1 mitre), rgba negative colour, f64 negative grow
/// f64 embolden (0 to 8 synthesised bolds), f64 slant (within 1.5)
/// with flag 32 (v11): f64 x, y, a page pixel's corner in device pixels
/// with flag 64 (v12): f64 amount (a share of the size, 0 to 1), f64 tilt
///     (degrees, 0 to 90), u32 seed
/// u32 band count, then per band: rgba colour, f64 opacity, f64 line
/// fill (the job's)
/// mesh
/// roughen
/// u32 run count, then per run: f64 x, y, rot, sx, sy, skew, drip, pen,
///                              u32 run flags (1 afterimage), fill,
///                              u32 byte length, UTF-8 text
/// u32 tile count, then per tile: u32 width, u32 height, RGBA8 pixels
/// with flag 128 (v13), a straight job whose lines are set in several
///     faces (and nothing at all otherwise, so a job in one face is the bytes
///     it was): u32 face count (1 to 16), then per face: u32 font, u32 synth bits,
///     u32 fallback chain, all at the job's size;
///     u32 run count (the job's), then per run: u32 stretch count (0 for a
///     run in the job's face), then per stretch: u32 face index, u32 first
///     and one-past-last UTF-16 unit of the run's text
/// with flag 256 (v14), after the faces: the special effects. f64 x, y, w, h
///     (the box in job space), u32 kinds (1 crack, 2 lightning, 4 splash,
///     8 scratches; 16 the crack's pieces break off, v16, only with 1;
///     32 a box's own strokes are cut through at the cuts, v17, no
///     payload, only with 1 or 8),
///     then for each kind set, in that order:
///     crack:     f64 amount (0 to 1), f64 size (a share of the size, 0.01
///                to 4), f64 x, y (where it gathers, shares of the ink
///                box), f64 spread (0 to 1), u32 seed (v15); with 16, f64
///                break off (over 0, at most 1), u32 motion (0 apart,
///                1 fall)
///     lightning: f64 amount, rgba core, rgba glow, f64 glow size (0 to
///                3), u32 seed (v15)
///     splash:    f64 amount, f64 size, rgba colour, u32 seed (v15)
///     scratches: f64 amount, f64 angle (radians), u32 seed
///
/// fill: u32 kind, then
///   0 none
///   1 solid:   rgba
///   2 linear:  f64 x0, y0, x1, y1, stops
///   3 radial:  f64 cx, cy, r, stops
///   4 pattern: u32 tile, f64 pitch, f64 ax, ay, rgba fallback
///   5 screen: u32 kind (0..32 built-in, 255 picked), tile (0xffffffff for none),
///     mode (0 tone, 1 image), seed;
///     f64 ax, ay, bx, by (basis columns), ox, oy (origin), angle (radians),
///     aspect (> 0), su, sv (offset in tiles), density (0..1), line (tile share);
///     rgba fg, bg, fallback; f64 cx, cy (centre), reach (> 0);
///     u32 fade: 0 none, 1 then f64 x0, y0, x1, y1 (job units).
///     Tile and mode apply only to picked screens. Image mode preserves the
///     tile colours, multiplied by fg alpha; tone mode recolours with fg/bg.
///     The basis must be nonsingular and all numbers finite. The aspect is
///     applied along local x before the canvas turn about the origin.
/// mesh: u32 cols, 0 for a job with no mesh; else
///   u32 rows, f64 x, y, w, h (the rectangle the mesh is defined on),
///   then (cols + 1) * (rows + 1) points, row by row from the top left:
///   f64 x, y, relative to the rectangle's corner
/// roughen: u32 0 for a job that is not roughened; else u32 1, then
///   f64 amount, detail, seed, f64 x, y (the field's origin in job space),
///   f64 grit
/// stops: u32 count, then per stop: f64 position, rgba
/// rgba: four bytes, straight alpha
/// ```
///
/// A run's `sx` and `sy` are 0.01 to 100 in absolute value and its `skew` is
/// within 1.4 radians, its `drip` is 0 to 4096, or the job is refused. A
/// straight job's runs write 1, 1, 0, 0: only a curved job reads them. A
/// run's `pen` is 0.01 to 100 (a straight run writes 1) and a negative's grow
/// is 0 to 4096. A mesh
/// has 1 to 64 cells each way and a rectangle with a size. A roughening's
/// amount is within 4096 either way, its detail is 0 to 8 and its grit is 0
/// to 4096.
pub fn decode(bytes: &[u8]) -> Result<Request, Error> {
    decode_split(bytes).map(|(request, _)| request)
}

/// [`decode`], and where the special effects' record starts in `bytes`
/// (their length with none): what is before it is all the letters' raster
/// reads of the job but Crack's and Scratches' numbers.
pub(crate) fn decode_split(bytes: &[u8]) -> Result<(Request, usize), Error> {
    let mut r = Reader { bytes, at: 0 };
    if r.u32()? != MAGIC || r.u32()? != WIRE_VERSION {
        return Err(Error::BadSpec);
    }
    let font = r.u32()?;
    let synth = Synth::from_bits(r.u32()?);
    let chain = r.u32()?;
    let bold_draw = match r.u32()? {
        0 => None,
        1 => Some(BoldDraw::Outset),
        2 => Some(BoldDraw::Smear),
        _ => return Err(Error::BadSpec),
    };
    let size = r.f64()?;
    let mut m = [0.0; 6];
    for v in &mut m {
        *v = r.f64()?;
    }
    let weight = r.f64()?;
    if !(0.0..=MAX_WEIGHT).contains(&weight) {
        return Err(Error::BadSpec);
    }
    let flags = r.u32()?;
    let align = match r.u32()? {
        0 => Align::Left,
        1 => Align::Center,
        2 => Align::Right,
        _ => return Err(Error::BadSpec),
    };
    let letter_spacing = r.f64()?;
    let silhouette = r.rgba()?;
    let join = match r.u32()? {
        0 => Join::Round,
        1 => Join::Miter { limit: MITER_LIMIT },
        _ => return Err(Error::BadSpec),
    };
    let negative = Negative {
        color: r.rgba()?,
        grow: r.f64()?,
    };
    if !(0.0..=MAX_DRIP).contains(&negative.grow) {
        return Err(Error::BadSpec);
    }
    let (embolden, slant) = (r.f64()?, r.f64()?);
    if !(0.0..=MAX_EMBOLDEN).contains(&embolden) || !(-MAX_SLANT..=MAX_SLANT).contains(&slant) {
        return Err(Error::BadSpec);
    }
    let crisp = if flags & 32 != 0 {
        let at = Pt::new(r.f64()?, r.f64()?);
        if !(at.x.is_finite() && at.y.is_finite()) {
            return Err(Error::BadSpec);
        }
        Some(at)
    } else {
        None
    };
    let wobble = if flags & 64 != 0 {
        let (amount, tilt, seed) = (r.f64()?, r.f64()?, r.u32()?);
        if !(0.0..=MAX_WOBBLE_AMOUNT).contains(&amount) || !(0.0..=MAX_WOBBLE_TILT).contains(&tilt) {
            return Err(Error::BadSpec);
        }
        // A wobble that moves nothing is no wobble, so Crisp stays on and the
        // bytes are those of a box without one.
        (amount > 0.0 || tilt > 0.0).then(|| Wobble::new(amount, tilt, seed))
    } else {
        None
    };
    let bands = super::budget::collect((0..r.count(20)?).map(|_| {
        Ok(Band {
            color: r.rgba()?,
            opacity: r.f64()?,
            line: r.f64()?,
        })
    }))?;
    let fill = r.fill()?;
    let mesh = r.mesh()?;
    let roughen = r.roughen()?;
    let runs = super::budget::collect((0..r.count(76)?).map(|_| {
        let (x, y, rot) = (r.f64()?, r.f64()?, r.f64()?);
        let (sx, sy, skew) = (r.f64()?, r.f64()?, r.f64()?);
        let (drip, pen) = (r.f64()?, r.f64()?);
        let run_flags = r.u32()?;
        if !SCALE_RANGE.contains(&sx.abs())
            || !SCALE_RANGE.contains(&sy.abs())
            || skew.abs() > MAX_SKEW
            || !(0.0..=MAX_DRIP).contains(&drip)
            || !SCALE_RANGE.contains(&pen)
            || run_flags > 1
        {
            return Err(Error::BadSpec);
        }
        let fill = r.fill()?;
        let len = r.u32()? as usize;
        if len > super::budget::MAX_RUN_BYTES {
            return Err(Error::BadSpec);
        }
        let text = core::str::from_utf8(r.take(len)?).map_err(|_| Error::BadText)?;
        let mut owned = Vec::new();
        super::budget::reserve_raw(&mut owned, text.len())?;
        owned.extend_from_slice(text.as_bytes());
        // Valid UTF-8 was checked above; this conversion does not allocate.
        let text = String::from_utf8(owned).map_err(|_| Error::BadText)?;
        Ok(Run {
            text,
            x,
            y,
            rot,
            sx,
            sy,
            skew,
            drip,
            fill,
            pen,
            ghost: run_flags & 1 != 0,
        })
    }))?;
    let wobble = wobble.map(|w| {
        let ghosts = runs.iter().filter(|r| r.ghost).count();
        let letters = runs.len() - ghosts;
        let copies = if letters > 0 && ghosts % letters == 0 {
            u32::try_from(ghosts / letters).unwrap_or(0)
        } else {
            0
        };
        Wobble { copies, ..w }
    });
    let tiles = r.tiles()?;
    let faces = if flags & 128 != 0 {
        r.run_faces(runs.len(), size)?
    } else {
        RunFaces::default()
    };
    // A curve is one glyph a run, laid out in the box's face: no stretches.
    if flags & 1 != 0 && flags & 128 != 0 {
        return Err(Error::BadSpec);
    }
    let special_at = r.at;
    let special = if flags & 256 != 0 { Some(r.special()?) } else { None };
    if flags > 511 {
        return Err(Error::BadSpec);
    }
    if r.at != bytes.len() {
        return Err(Error::BadSpec);
    }
    let request = Request {
        job: Job {
            curved: flags & 1 != 0,
            align,
            letter_spacing,
            bands,
            silhouette: (flags & 2 != 0).then_some(silhouette),
            no_fill: flags & 4 != 0,
            fill,
            mesh,
            roughen,
            effects: Effects {
                join,
                each: flags & 8 != 0,
                negative: (flags & 16 != 0).then_some(negative),
                grow: 0.0,
                embolden,
                slant,
                crisp,
                wobble,
                line: false,
                special,
                cuts: Cuts::Made,
                surface: None,
            },
            runs,
        },
        face: Face {
            font,
            size,
            synth,
            chain,
        },
        bold_draw,
        weight,
        transform: Affine(m),
        tiles,
        ink: None,
        faces,
    };
    Ok((request, special_at))
}

/// A swatch uses the same fill and tile records as a job, without a font
/// or glyphs. Decode all of it before painting so a trailing or truncated
/// record cannot leave a partial result in the caller's raster.
pub fn decode_swatch(bytes: &[u8]) -> Result<(u32, u32, Option<Fill>, Vec<Tile>), Error> {
    let mut r = Reader { bytes, at: 0 };
    if r.u32()? != 0x5354_504d {
        return Err(Error::BadSpec);
    }
    let (w, h) = (r.u32()?, r.u32()?);
    if !(1..=2048).contains(&w) || !(1..=2048).contains(&h) {
        return Err(Error::BadSpec);
    }
    let fill = r.fill()?;
    let tiles = r.tiles()?;
    if r.at != bytes.len() {
        return Err(Error::BadSpec);
    }
    Ok((w, h, fill, tiles))
}
