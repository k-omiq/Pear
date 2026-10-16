//! Screens are shapes in an infinite lattice, rather than pixels in a tile.
//!
//! A shader keeps the inverse lattice and the device pixel's Jacobian. The
//! distance to an edge is filtered over that footprint, so turning or
//! stretching a screen does not turn or stretch its antialiasing. Small
//! cells are sampled on a bounded grid, just as repeated image tiles are.

use super::geom::{Affine, Pt};
use super::job::{Fill, Rgba, Tile};
use super::shade::{Premul, Shader};
use super::{budget, compose};
use crate::Error;
use core::f64::consts::{FRAC_1_SQRT_2, PI};

/// Wire ids are positions in this list; picked tiles have a separate id.
pub const KIND_NAMES: &str = "dots\nhalftone\nstripes\nhstripes\ndiagonal\ndiagonal-alt\ncrosshatch\nchecker\ngrid\nvlines\nhlines";

#[derive(Clone, Debug, PartialEq)]
pub struct Screen {
    pub kind: u32,
    pub tile: u32,
    pub mode: u32,
    pub seed: u32,
    pub a: Pt,
    pub b: Pt,
    pub origin: Pt,
    pub angle: f64,
    pub aspect: f64,
    pub offset: Pt,
    pub density: f64,
    pub line: f64,
    pub fg: Rgba,
    pub bg: Rgba,
    pub fallback: Rgba,
    pub centre: Pt,
    pub reach: f64,
    pub fade: Option<(Pt, Pt)>,
}

impl Screen {
    fn basis(&self) -> Affine {
        Affine([self.a.x, self.a.y, self.b.x, self.b.y, 0.0, 0.0])
    }

    /// Used by the decoder as well as native callers. Refuse a collapsed
    /// cell before attempting its inverse, and never let a NaN enter a
    /// distance, a fade projection or a colour conversion.
    pub fn sound(&self) -> bool {
        let points = [self.a, self.b, self.origin, self.offset, self.centre];
        self.kind <= 10
            && self.mode <= 1
            && points.iter().all(|p| p.x.is_finite() && p.y.is_finite())
            && [self.angle, self.aspect, self.density, self.line, self.reach]
                .iter()
                .all(|v| v.is_finite())
            && self.aspect > 0.0
            && self.reach > 0.0
            && (0.0..=1.0).contains(&self.density)
            && self.basis().invert().is_some()
            && self
                .fade
                .is_none_or(|(a, b)| [a.x, a.y, b.x, b.y].iter().all(|v| v.is_finite()))
    }
}

fn premul(c: Rgba) -> Premul {
    let a = c.alpha();
    [
        c.0[0] as f32 / 255.0 * a,
        c.0[1] as f32 / 255.0 * a,
        c.0[2] as f32 / 255.0 * a,
        a,
    ]
}

/// One rule for every screen. At one half the original shape is retained;
/// either side of it the designed share tends to empty or solid.
fn share(d: f64, designed: f64) -> f64 {
    if d <= 0.5 {
        2.0 * d * designed
    } else {
        designed + (d - 0.5) * 2.0 * (1.0 - designed)
    }
}

/// Signed distance with the outward normal in tile units. Min and max keep
/// the normal belonging to the edge that determines a union/intersection.
#[derive(Clone, Copy)]
struct Edge {
    d: f64,
    n: Pt,
}
impl Edge {
    fn min(self, other: Self) -> Self {
        if self.d < other.d {
            self
        } else {
            other
        }
    }
    fn max(self, other: Self) -> Self {
        if self.d > other.d {
            self
        } else {
            other
        }
    }
    fn cover(self, jac: &Affine) -> f64 {
        let [a, b, c, d, ..] = jac.0;
        let fw = (self.n.x * a + self.n.y * b).abs() + (self.n.x * c + self.n.y * d).abs();
        (0.5 - self.d / fw.max(1e-12)).clamp(0.0, 1.0)
    }
}

fn wrap(x: f64) -> f64 {
    (x + 0.5).rem_euclid(1.0) - 0.5
}
fn band(x: f64, width: f64, n: Pt) -> Edge {
    let t = wrap(x - width / 2.0);
    let len = n.len();
    Edge {
        d: (t.abs() - width / 2.0) / len,
        n: n.scale(t.signum() / len),
    }
}
fn circle(x: f64, y: f64, r: f64) -> Edge {
    let p = Pt::new(wrap(x), wrap(y));
    let len = p.len();
    Edge {
        d: len - r,
        n: if len > 0.0 {
            p.scale(1.0 / len)
        } else {
            Pt::new(1.0, 0.0)
        },
    }
}
fn square(x: f64, y: f64, half: f64) -> Edge {
    let (x, y) = (wrap(x), wrap(y));
    Edge {
        d: x.abs() - half,
        n: Pt::new(x.signum(), 0.0),
    }
    .max(Edge {
        d: y.abs() - half,
        n: Pt::new(0.0, y.signum()),
    })
}

/// Grow compact shapes far enough to cover the corners as density tends
/// to one. Merely using sqrt(share / pi) would leave holes between circles
/// even at full density. Below the designed share the area rule is exact.
fn grow(s: f64, s0: f64, r0: f64, full: f64) -> f64 {
    if s <= s0 {
        r0 * (s / s0).sqrt()
    } else {
        r0 + (full - r0) * (s - s0) / (1.0 - s0)
    }
}

fn old_edge(kind: u32, u: f64, v: f64, d: f64, line: f64) -> Edge {
    let x = Pt::new(1.0, 0.0);
    let y = Pt::new(0.0, 1.0);
    match kind {
        0 => {
            let s0 = PI * 0.25 * 0.25;
            circle(
                u - 0.5,
                v - 0.5,
                grow(share(d, s0), s0, 0.25, FRAC_1_SQRT_2),
            )
        }
        1 => {
            let s0 = 2.0 * PI * 0.17 * 0.17;
            let r = grow(share(d, s0), s0, 0.17, 0.5);
            circle(u - 0.25, v - 0.25, r).min(circle(u - 0.75, v - 0.75, r))
        }
        2 => band(u, share(d, 0.5), x),
        3 => band(v, share(d, 0.5), y),
        4 => {
            let w = share(d, 0.5);
            band(v - u + w / 2.0, w, Pt::new(-1.0, 1.0))
        }
        5 => {
            let w = share(d, 0.5);
            band(v + u + w / 2.0, w, Pt::new(1.0, 1.0))
        }
        6 => {
            // The union of two bands of width .3 has share .51.
            let w = 1.0 - (1.0 - share(d, 0.51)).sqrt();
            band(v - u + w / 2.0, w, Pt::new(-1.0, 1.0)).min(band(
                v + u + w / 2.0,
                w,
                Pt::new(1.0, 1.0),
            ))
        }
        7 => {
            let h = grow(share(d, 0.5), 0.5, 0.25, 0.5);
            square(u - 0.25, v - 0.25, h).min(square(u - 0.75, v - 0.75, h))
        }
        8 => {
            let s0 = 2.0 * line - line * line;
            let w = 1.0 - (1.0 - share(d, s0)).sqrt();
            band(u, w, x).min(band(v, w, y))
        }
        9 => band(u, share(d, line), x),
        _ => band(v, share(d, line), y),
    }
}

pub struct ScreenShader {
    screen: Screen,
    to_frame: Affine,
    to_tile: Affine,
    taps: u32,
    fg: Premul,
    bg: Premul,
}

impl ScreenShader {
    pub fn new(s: &Screen, frame: &Affine) -> Option<Self> {
        if !s.sound() {
            return None;
        }
        let to_frame = frame.invert()?;
        let (sin, cos) = s.angle.sin_cos();
        let to_tile = Affine::translate(s.offset.x, s.offset.y)
            .after(&s.basis().invert()?)
            .after(&Affine::scale(1.0 / s.aspect, 1.0))
            .after(&Affine::rotate(cos, -sin))
            .after(&Affine::translate(-s.origin.x, -s.origin.y))
            .after(&to_frame);
        if !to_tile.is_finite() {
            return None;
        }
        let [a, b, c, d, ..] = to_tile.0;
        let footprint = a.hypot(b).max(c.hypot(d));
        let taps = if footprint <= 0.25 {
            1
        } else {
            (footprint * 4.0).ceil().clamp(2.0, 8.0) as u32
        };
        Some(Self {
            screen: s.clone(),
            to_frame,
            to_tile,
            taps,
            fg: premul(s.fg),
            bg: premul(s.bg),
        })
    }

    fn density(&self, p: Pt) -> f64 {
        let s = &self.screen;
        let Some((a, b)) = s.fade else {
            return s.density;
        };
        let ab = b.minus(a);
        // A coincident line is a step at its origin, with positive x as
        // its direction. A nondegenerate line keeps its stated direction.
        let len = ab.x.hypot(ab.y);
        let factor = if len == 0.0 {
            if p.x < a.x {
                1.0
            } else {
                0.0
            }
        } else {
            (1.0 - p.minus(a).dot(ab.scale(1.0 / len)) / len).clamp(0.0, 1.0)
        };
        s.density * factor
    }

    fn sample(&self, p: Pt, jac: &Affine) -> Premul {
        let q = self.to_tile.apply(p);
        let d = self.density(self.to_frame.apply(p));
        let ink = if d <= 0.0 {
            0.0
        } else if d >= 1.0 {
            1.0
        } else {
            old_edge(
                self.screen.kind,
                q.x,
                q.y,
                d,
                self.screen.line.clamp(0.0, 1.0),
            )
            .cover(jac)
        } as f32;
        let under = 1.0 - self.fg[3] * ink;
        core::array::from_fn(|k| self.fg[k] * ink + self.bg[k] * under)
    }

    pub fn at(&self, x: f64, y: f64) -> Premul {
        let n = self.taps;
        let mut jac = self.to_tile;
        for v in &mut jac.0[..4] {
            *v /= n as f64;
        }
        if n == 1 {
            return self.sample(Pt::new(x, y), &jac);
        }
        let mut sum = [0.0; 4];
        for j in 0..n {
            for i in 0..n {
                let p = Pt::new(
                    x - 0.5 + (i as f64 + 0.5) / n as f64,
                    y - 0.5 + (j as f64 + 0.5) / n as f64,
                );
                let c = self.sample(p, &jac);
                for k in 0..4 {
                    sum[k] += c[k];
                }
            }
        }
        sum.map(|v| v / (n * n) as f32)
    }
}

/// Paint any fill across a whole swatch. It deliberately uses the same
/// shader and final colour conversion as a glyph job, without manufacturing
/// a rectangle outline or requiring a registered font.
pub fn swatch(w: u32, h: u32, fill: Option<&Fill>, tiles: &[Tile]) -> Result<Vec<u8>, Error> {
    if !(1..=2048).contains(&w) || !(1..=2048).contains(&h) {
        return Err(Error::BadSpec);
    }
    let mut out = budget::filled(w as usize * h as usize * 4, 0u8)?;
    if let Some(shader) = fill.and_then(|f| Shader::new(f, &Affine::IDENTITY, tiles)) {
        for (i, px) in out.chunks_exact_mut(4).enumerate() {
            let c = shader.at((i % w as usize) as i32, (i / w as usize) as i32);
            compose::store(&c, px);
        }
    }
    Ok(out.into_vec())
}

#[cfg(test)]
mod tests {
    use super::super::{job, pattern, Exact};
    use super::*;

    fn screen(kind: u32, pitch: f64) -> Screen {
        Screen {
            kind,
            tile: u32::MAX,
            mode: 0,
            seed: 1,
            a: Pt::new(pitch, 0.0),
            b: Pt::new(0.0, pitch),
            origin: Pt::new(0.0, 0.0),
            angle: 0.0,
            aspect: 1.0,
            offset: Pt::new(0.0, 0.0),
            density: 0.5,
            line: 0.12,
            fg: Rgba([0, 0, 0, 255]),
            bg: Rgba([255; 4]),
            fallback: Rgba([20, 30, 40, 255]),
            centre: Pt::new(48.0, 48.0),
            reach: 48.0 * 2.0f64.sqrt(),
            fade: None,
        }
    }
    fn pixels(s: &Screen) -> Vec<u8> {
        let _budget = budget::Scope::new();
        swatch(96, 96, Some(&Fill::Screen(s.clone())), &[]).unwrap()
    }
    fn ink(bytes: &[u8]) -> f64 {
        bytes
            .chunks_exact(4)
            .map(|p| 1.0 - p[0] as f64 / 255.0)
            .sum::<f64>()
            / (bytes.len() / 4) as f64
    }
    fn draw(shader: Shader<'_>) -> Vec<u8> {
        let mut out = vec![0; 96 * 96 * 4];
        for (i, px) in out.chunks_exact_mut(4).enumerate() {
            compose::store(&shader.at((i % 96) as i32, (i / 96) as i32), px);
        }
        out
    }
    fn u(bytes: &mut Vec<u8>, v: u32) {
        bytes.extend(v.to_le_bytes());
    }
    fn f(bytes: &mut Vec<u8>, v: f64) {
        bytes.extend(v.to_le_bytes());
    }
    fn wire(s: &Screen) -> Vec<u8> {
        let mut b = Vec::new();
        u(&mut b, 5);
        for v in [s.kind, s.tile, s.mode, s.seed] {
            u(&mut b, v);
        }
        for v in [
            s.a.x, s.a.y, s.b.x, s.b.y, s.origin.x, s.origin.y, s.angle, s.aspect, s.offset.x,
            s.offset.y, s.density, s.line,
        ] {
            f(&mut b, v);
        }
        for c in [s.fg, s.bg, s.fallback] {
            b.extend(c.0);
        }
        for v in [s.centre.x, s.centre.y, s.reach] {
            f(&mut b, v);
        }
        u(&mut b, u32::from(s.fade.is_some()));
        if let Some((a, c)) = s.fade {
            for v in [a.x, a.y, c.x, c.y] {
                f(&mut b, v);
            }
        }
        b
    }
    fn swatch_wire(s: &Screen) -> Vec<u8> {
        let mut b = Vec::new();
        for v in [0x5354_504d, 96, 96] {
            u(&mut b, v);
        }
        b.extend(wire(s));
        u(&mut b, 0);
        b
    }

    #[test]
    fn screen_wire_round_trip_and_malformed_records() {
        let _budget = budget::Scope::new();
        let mut s = screen(6, 7.8);
        s.angle = 0.3;
        s.aspect = 1.7;
        s.offset = Pt::new(-0.5, 0.25);
        s.seed = 73;
        s.fade = Some((Pt::new(1.0, 2.0), Pt::new(81.0, 22.0)));
        let b = swatch_wire(&s);
        assert_eq!(
            job::decode_swatch(&b).unwrap().2,
            Some(Fill::Screen(s.clone()))
        );
        // Exercise the actual job decoder too, including the v8 header.
        let mut j = Vec::new();
        for v in [job::MAGIC, job::WIRE_VERSION, 1, 0, 0, 0] {
            u(&mut j, v);
        }
        for v in [20.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0] {
            f(&mut j, v);
        }
        u(&mut j, 0);
        u(&mut j, 0);
        f(&mut j, 0.0);
        u(&mut j, 0);
        u(&mut j, 0);
        j.extend(wire(&s));
        for _ in 0..4 {
            u(&mut j, 0);
        }
        assert_eq!(
            job::decode(&j).unwrap().job.fill,
            Some(Fill::Screen(s.clone()))
        );
        for len in 0..b.len() {
            assert!(job::decode_swatch(&b[..len]).is_err(), "truncation {len}");
        }
        let mut extra = b;
        extra.push(0);
        assert!(job::decode_swatch(&extra).is_err());
        for i in 0..8 {
            let mut bad = s.clone();
            match i {
                0 => bad.a = bad.b,
                1 => bad.aspect = 0.0,
                2 => bad.aspect = -1.0,
                3 => bad.angle = f64::NAN,
                4 => bad.offset.x = f64::INFINITY,
                5 => bad.density = 1.1,
                6 => bad.reach = 0.0,
                _ => bad.fade.as_mut().unwrap().0.y = f64::NAN,
            }
            assert!(
                job::decode_swatch(&swatch_wire(&bad)).is_err(),
                "bad field {i}"
            );
        }
    }

    #[test]
    fn old_kinds_match_the_tiles_at_the_apps_two_pitches() {
        let _budget = budget::Scope::new();
        for pitch in [7.8_f64, 15.6] {
            for kind in 0..11 {
                let s = screen(kind, pitch);
                let side = (pitch * 2.0).round() as u32;
                let rgba = pattern::tile(
                    pattern::Kind::from_id(kind).unwrap(),
                    s.fg,
                    s.bg,
                    side,
                    s.line,
                    &Exact,
                )
                .unwrap();
                let tiles = [Tile::from_rgba(side, side, &rgba).unwrap()];
                let fill = Fill::Pattern {
                    tile: 0,
                    pitch,
                    origin: s.origin,
                    fallback: s.fallback,
                };
                let frame = Affine::scale(2.0, 2.0);
                let a = draw(Shader::new(&fill, &frame, &tiles).unwrap());
                let b = draw(Shader::new(&Fill::Screen(s), &frame, &[]).unwrap());
                for channel in 0..4 {
                    let mut errors: Vec<u8> = a
                        .chunks_exact(4)
                        .zip(b.chunks_exact(4))
                        .map(|(a, b)| a[channel].abs_diff(b[channel]))
                        .collect();
                    let mean = errors.iter().map(|v| *v as f64).sum::<f64>() / errors.len() as f64;
                    errors.sort_unstable();
                    let p99 = errors[errors.len() * 99 / 100];
                    if channel == 0 {
                        println!(
                            "old kind {kind:2}, pitch {pitch}: channel MAE {mean:.4}, p99 {p99}"
                        );
                    }
                    // Measured maxima: mean 6.7003 and p99 64 on RGBA8 channels.
                    // The limits are measured on each channel independently;
                    // the opaque alpha channel cannot dilute the RGB error.
                    assert!(
                        mean < 7.0 && p99 <= 64,
                        "kind {kind}, pitch {pitch}, channel {channel}: {mean}, {p99}"
                    );
                }
            }
        }
    }

    #[test]
    fn rotation_stretch_offset_and_a_skew_lattice_follow_the_mapping() {
        let s = screen(2, 12.0);
        let mut turned = s.clone();
        turned.angle = PI / 2.0;
        assert_eq!(pixels(&turned), pixels(&screen(3, 12.0)));
        let mut stretched = s.clone();
        stretched.aspect = 2.0;
        let p = pixels(&stretched);
        assert_ne!(&p[..12 * 4], &p[12 * 4..24 * 4]);
        assert_eq!(&p[..24 * 4], &p[24 * 4..48 * 4]);
        let mut shifted = s.clone();
        shifted.offset.x = 0.5;
        let a = pixels(&s);
        let b = pixels(&shifted);
        for y in 0..96 {
            for x in 0..90 {
                assert_eq!(
                    &a[(y * 96 + x + 6) * 4..(y * 96 + x + 6) * 4 + 4],
                    &b[(y * 96 + x) * 4..(y * 96 + x) * 4 + 4]
                );
            }
        }
        let mut skew = s;
        skew.b = Pt::new(6.0, 12.0);
        skew.angle = 0.3;
        skew.aspect = 1.7;
        skew.origin = Pt::new(2.0, -3.0);
        skew.offset = Pt::new(0.2, -0.1);
        let shader = ScreenShader::new(&skew, &Affine::IDENTITY).unwrap();
        let uv = Pt::new(0.3, 0.7);
        let local = skew.basis().apply(uv.minus(skew.offset));
        let (sin, cos) = skew.angle.sin_cos();
        let p = Affine::rotate(cos, sin)
            .apply(Pt::new(local.x * skew.aspect, local.y))
            .plus(skew.origin);
        assert!(shader.to_tile.apply(p).minus(uv).len() < 1e-12);
    }

    #[test]
    fn density_has_empty_and_solid_ends_and_grows_monotonically() {
        for kind in 0..11 {
            let mut s = screen(kind, 12.0);
            let mut previous = vec![255; 96 * 96 * 4];
            for d in [0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0] {
                s.density = d;
                let p = pixels(&s);
                if d == 0.0 {
                    assert!(p.chunks_exact(4).all(|p| p == [255; 4]));
                }
                if d == 1.0 {
                    assert!(p.chunks_exact(4).all(|p| p == [0, 0, 0, 255]));
                }
                assert!(
                    p.iter().zip(&previous).all(|(a, b)| a <= b),
                    "kind {kind} density {d}"
                );
                previous = p;
            }
        }
    }

    #[test]
    fn fade_and_transparent_ground_and_subpixel_cells() {
        let mut s = screen(2, 12.0);
        s.fade = Some((Pt::new(0.0, 0.0), Pt::new(96.0, 0.0)));
        let p = pixels(&s);
        let strips: Vec<f64> = (0..4)
            .map(|i| {
                let mut b = Vec::new();
                for y in 0..96 {
                    b.extend(&p[(y * 96 + i * 24) * 4..(y * 96 + (i + 1) * 24) * 4]);
                }
                ink(&b)
            })
            .collect();
        assert!(strips.windows(2).all(|w| w[0] > w[1]), "{strips:?}");
        s.fade = Some((Pt::new(48.0, 0.0), Pt::new(48.0, 0.0)));
        let shader = ScreenShader::new(&s, &Affine::IDENTITY).unwrap();
        assert_eq!(shader.density(Pt::new(47.0, 0.0)), 0.5);
        assert_eq!(shader.density(Pt::new(48.0, 0.0)), 0.0);
        s.fade = None;
        s.bg = Rgba([0; 4]);
        let p = pixels(&s);
        assert!(p.chunks_exact(4).any(|p| p[3] == 0));
        assert!(p.chunks_exact(4).any(|p| p[3] == 255));
        s = screen(2, 0.1);
        assert!((ink(&pixels(&s)) - 0.5).abs() < 0.02);
    }
}
