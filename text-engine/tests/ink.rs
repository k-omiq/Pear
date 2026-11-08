//! Brush ink in the box job (layer styles phase 8a): the stamps are the ones
//! `strokeStamps` in brush.js lays, the wire record reads back and refuses
//! what is not one, and the ink is content of the box: it paints alone, the
//! shadow is thrown from it, Fill Opacity fades it and No Fill keeps it.
#![cfg(feature = "paint")]

use mt_text::paint::ink::{stroke_stamps, Flip, Ink, Stamp, Stroke, Taper, TipOrder};
use mt_text::paint::{
    decode_box, paint_box, Affine, Align, Band, BoxRequest, Effects, Fill, Job, Pt, Raster,
    Request, Rgba, Run, Shadow, BOX_MAGIC, BOX_WIRE_VERSION, MAGIC, WIRE_VERSION,
};
use mt_text::{Engine, Error, Face, FontId};

// ---------------------------------------------------------------------------
// A JSON reader, enough for the fixture: objects, arrays, numbers, strings,
// true, false, null.

#[derive(Debug, Clone)]
enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    fn get(&self, k: &str) -> &Json {
        match self {
            Json::Obj(v) => {
                &v.iter()
                    .find(|(n, _)| n == k)
                    .unwrap_or_else(|| panic!("no {k}"))
                    .1
            }
            _ => panic!("not an object"),
        }
    }
    fn num(&self) -> f64 {
        match self {
            Json::Num(v) => *v,
            j => panic!("not a number: {j:?}"),
        }
    }
    fn opt(&self) -> Option<f64> {
        match self {
            Json::Null => None,
            j => Some(j.num()),
        }
    }
    fn bool(&self) -> bool {
        match self {
            Json::Bool(v) => *v,
            j => panic!("not a bool: {j:?}"),
        }
    }
    fn str(&self) -> &str {
        match self {
            Json::Str(v) => v,
            j => panic!("not a string: {j:?}"),
        }
    }
    fn arr(&self) -> &[Json] {
        match self {
            Json::Arr(v) => v,
            j => panic!("not an array: {j:?}"),
        }
    }
}

struct Parse<'a> {
    s: &'a [u8],
    at: usize,
}

impl Parse<'_> {
    fn ws(&mut self) {
        while self.at < self.s.len() && self.s[self.at].is_ascii_whitespace() {
            self.at += 1;
        }
    }
    fn value(&mut self) -> Json {
        self.ws();
        match self.s[self.at] {
            b'{' => {
                self.at += 1;
                let mut out = Vec::new();
                loop {
                    self.ws();
                    if self.s[self.at] == b'}' {
                        self.at += 1;
                        return Json::Obj(out);
                    }
                    let Json::Str(k) = self.value() else {
                        panic!("key")
                    };
                    self.ws();
                    assert_eq!(self.s[self.at], b':');
                    self.at += 1;
                    out.push((k, self.value()));
                    self.ws();
                    if self.s[self.at] == b',' {
                        self.at += 1;
                    }
                }
            }
            b'[' => {
                self.at += 1;
                let mut out = Vec::new();
                loop {
                    self.ws();
                    if self.s[self.at] == b']' {
                        self.at += 1;
                        return Json::Arr(out);
                    }
                    out.push(self.value());
                    self.ws();
                    if self.s[self.at] == b',' {
                        self.at += 1;
                    }
                }
            }
            b'"' => {
                self.at += 1;
                let from = self.at;
                while self.s[self.at] != b'"' {
                    self.at += 1;
                }
                self.at += 1;
                Json::Str(String::from_utf8(self.s[from..self.at - 1].to_vec()).unwrap())
            }
            b't' => {
                self.at += 4;
                Json::Bool(true)
            }
            b'f' => {
                self.at += 5;
                Json::Bool(false)
            }
            b'n' => {
                self.at += 4;
                Json::Null
            }
            _ => {
                let from = self.at;
                while self.at < self.s.len() && b"+-.eE0123456789".contains(&self.s[self.at]) {
                    self.at += 1;
                }
                Json::Num(
                    std::str::from_utf8(&self.s[from..self.at])
                        .unwrap()
                        .parse()
                        .unwrap(),
                )
            }
        }
    }
}

fn flip(s: &str) -> Flip {
    match s {
        "on" => Flip::On,
        "random" => Flip::Random,
        _ => Flip::Off,
    }
}

fn taper(j: &Json) -> Taper {
    Taper {
        on: j.get("on").bool(),
        pct: j.get("mode").str() == "pct",
        len: j.get("len").num(),
        ratio: j.get("ratio").num(),
    }
}

/// The fixture's stroke as the engine holds one.
fn stroke_of(j: &Json) -> Stroke {
    let tips = j.get("tips").num() as usize;
    Stroke {
        ribbon: j.get("ribbon").bool(),
        follow_dir: j.get("followDir").bool(),
        flip_x: flip(j.get("flipX").str()),
        flip_y: flip(j.get("flipY").str()),
        tip_order: match j.get("tipOrder").str() {
            "reverse" => TipOrder::Reverse,
            "once" => TipOrder::Once,
            "random" => TipOrder::Random,
            _ => TipOrder::Repeat,
        },
        cycle: vec![None; tips],
        tip: (!j.get("round").bool()).then_some(0),
        size: j.get("size").num(),
        spacing: j.get("spacing").num(),
        opacity: j.get("opacity").num(),
        angle: j.get("angle").num(),
        angle_jitter: j.get("angleJitter").num(),
        flatness: j.get("flatness").num(),
        corners: j.get("corners").num(),
        seed: j.get("seed").num(),
        taper_in: taper(j.get("taperIn")),
        taper_out: taper(j.get("taperOut")),
        pts: j
            .get("pts")
            .arr()
            .iter()
            .map(|p| {
                let mut q = [1.0; 5];
                for (v, n) in q.iter_mut().zip(p.arr()) {
                    *v = n.num();
                }
                q
            })
            .collect(),
        ..Stroke::default()
    }
}

#[test]
fn the_stamps_are_the_ones_brush_js_lays() {
    // tests/data/ink_stamps.json, written by parity/ink-stamps.mjs from
    // brush.js's strokeStamps; src/lib/ink-stamps-fixture.test.js holds the
    // file to brush.js.
    let text = include_str!("data/ink_stamps.json");
    let json = Parse {
        s: text.as_bytes(),
        at: 0,
    }
    .value();
    let cases = json.get("cases").arr();
    assert_eq!(cases.len(), 30);
    let mut worst = 0.0f64;
    let mut total = 0;
    for (n, c) in cases.iter().enumerate() {
        let k = stroke_of(c.get("stroke"));
        let want = c.get("stamps").arr();
        let got = stroke_stamps(&k);
        assert_eq!(got.len(), want.len(), "case {n}: how many stamps");
        for (i, (g, w)) in got.iter().zip(want).enumerate() {
            let w = w.arr();
            let mut close = |a: f64, b: f64, what: &str| {
                let d = (a - b).abs();
                worst = worst.max(d);
                assert!(d <= 1e-9, "case {n} stamp {i}: {what} {a} against {b}");
            };
            close(g.x, w[0].num(), "x");
            close(g.y, w[1].num(), "y");
            close(g.size, w[2].num(), "size");
            close(g.angle, w[3].num(), "angle");
            close(g.alpha, w[4].num(), "alpha");
            match (g.ribbon, w[5].opt(), w[6].opt()) {
                (Some((d, len)), Some(wd), Some(wl)) => {
                    close(d, wd, "d");
                    close(len, wl, "len");
                }
                (None, None, None) => {}
                other => panic!("case {n} stamp {i}: ribbon {other:?}"),
            }
            assert_eq!(
                g.tip,
                w[7].opt().map(|t| t as usize),
                "case {n} stamp {i}: tip"
            );
            match (w[8].opt(), w[9].opt()) {
                (Some(fx), Some(fy)) => assert_eq!((g.fx, g.fy), (fx, fy), "case {n} stamp {i}"),
                (None, None) => assert_eq!((g.fx, g.fy), (1.0, 1.0), "case {n} stamp {i}"),
                other => panic!("case {n} stamp {i}: flips {other:?}"),
            }
            match (g.flat, w[10].opt()) {
                (Some(a), Some(b)) => close(a, b, "flat"),
                (None, None) => {}
                other => panic!("case {n} stamp {i}: flat {other:?}"),
            }
        }
        total += got.len();
    }
    assert!(total > 4000, "{total}");
    // What the two differ by at most: Rust's libm and V8's fdlibm part only
    // in the last bit of a sine or an arc tangent.
    assert!(worst <= 1e-9, "{worst}");
}

#[test]
fn the_same_stroke_lays_the_same_stamps() {
    let k = Stroke {
        angle_jitter: 60.0,
        flip_x: Flip::Random,
        cycle: vec![None; 3],
        tip_order: TipOrder::Random,
        seed: 31337.0,
        pts: (0..20)
            .map(|i| [f64::from(i) * 7.0, f64::from(i * i % 13), 1.0, 1.0, 1.0])
            .collect(),
        ..Stroke::default()
    };
    let a: Vec<Stamp> = stroke_stamps(&k);
    assert_eq!(a, stroke_stamps(&k));
    assert!(a.len() > 20);
    // Another seed is another jitter.
    let other = stroke_stamps(&Stroke { seed: 31338.0, ..k });
    assert_ne!(a[3].angle, other[3].angle);
}

// ---------------------------------------------------------------------------
// The wire.

fn u(b: &mut Vec<u8>, v: u32) {
    b.extend_from_slice(&v.to_le_bytes());
}

fn f(b: &mut Vec<u8>, v: f64) {
    b.extend_from_slice(&v.to_le_bytes());
}

fn load(engine: &mut Engine) -> FontId {
    let path = format!(
        "{}/../src/test/fonts/DejaVuSans.ttf",
        env!("CARGO_MANIFEST_DIR")
    );
    engine
        .add_font_bytes(std::fs::read(path).unwrap(), 0)
        .unwrap()
}

/// A glyph job on the wire: `text` at 60, black, at (40, 100).
fn job_bytes(font: u32, text: &str) -> Vec<u8> {
    let mut b = Vec::new();
    u(&mut b, MAGIC);
    u(&mut b, WIRE_VERSION);
    u(&mut b, font);
    u(&mut b, 0);
    u(&mut b, 0);
    u(&mut b, 0);
    f(&mut b, 60.0);
    for v in [1.0, 0.0, 0.0, 1.0, 0.0, 0.0] {
        f(&mut b, v);
    }
    f(&mut b, 0.0);
    u(&mut b, 0);
    u(&mut b, 0);
    f(&mut b, 0.0);
    b.extend_from_slice(&[0, 0, 0, 255]);
    u(&mut b, 0);
    u(&mut b, 0);
    f(&mut b, 0.0);
    f(&mut b, 0.0);
    f(&mut b, 0.0);
    u(&mut b, 0);
    u(&mut b, 1);
    b.extend_from_slice(&[0, 0, 0, 255]);
    u(&mut b, 0);
    u(&mut b, 0);
    u(&mut b, 1);
    for v in [40.0, 100.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0] {
        f(&mut b, v);
    }
    u(&mut b, 0);
    u(&mut b, 0);
    u(&mut b, text.len() as u32);
    b.extend_from_slice(text.as_bytes());
    u(&mut b, 0);
    b
}

/// Where a stroke's parts start, from its first byte.
const AT_OPACITY: usize = 8;
const AT_SIZE: usize = 16;
const AT_FLATNESS: usize = 56;
const AT_SEED: usize = 152;
const AT_TIP: usize = 160;
const AT_CYCLE: usize = 164;
/// With an empty cycle.
const AT_POINTS: usize = 168;

/// One stroke on the wire: `flags`, red, size 10, the defaults, `pts` of
/// three numbers.
fn stroke_bytes(b: &mut Vec<u8>, flags: u32, pts: &[[f64; 3]]) {
    u(b, flags);
    b.extend_from_slice(&[255, 0, 0, 255]);
    // opacity, size, spacing, hardness, angle, jitter, flatness, corners
    for v in [1.0, 10.0, 10.0, 100.0, 0.0, 0.0, 1.0, 0.0] {
        f(b, v);
    }
    for v in [20.0, 60.0, 20.0, 60.0] {
        f(b, v);
    }
    for v in [4.0, 0.5, 0.0, 0.0] {
        f(b, v);
    }
    f(b, 0.5);
    f(b, 100.0);
    f(b, 7.0);
    u(b, u32::MAX);
    u(b, 0);
    u(b, pts.len() as u32);
    u(b, 3);
    for p in pts {
        for v in p {
            f(b, *v);
        }
    }
}

const LINE: [[f64; 3]; 2] = [[20.0, 20.0, 1.0], [120.0, 20.0, 1.0]];

/// A box job of `text` and ink of one stroke, and where the ink record and
/// its stroke start.
fn wire(font: u32, text: &str, flags: u32) -> (Vec<u8>, usize, usize) {
    let mut b = Vec::new();
    u(&mut b, BOX_MAGIC);
    u(&mut b, BOX_WIRE_VERSION);
    u(&mut b, 200);
    u(&mut b, 160);
    u(&mut b, 0);
    f(&mut b, 0.0);
    u(&mut b, 0);
    u(&mut b, 0);
    u(&mut b, 0);
    f(&mut b, 1.0);
    u(&mut b, 0);
    u(&mut b, 0);
    u(&mut b, 0);
    u(&mut b, 0); // no effects
    let ink_at = b.len();
    u(&mut b, 1);
    f(&mut b, 10.0);
    f(&mut b, 30.0);
    u(&mut b, 0); // no tips
    u(&mut b, 1);
    let stroke_at = b.len();
    stroke_bytes(&mut b, flags, &LINE);
    u(&mut b, 0); // no page
    let job = job_bytes(font, text);
    u(&mut b, job.len() as u32);
    b.extend_from_slice(&job);
    (b, ink_at, stroke_at)
}

#[test]
fn a_box_job_reads_its_ink() {
    let flags = 1 | 2 | 16 | (2 << 8) | (2 << 10) | (1 << 12) | (3 << 14) | (1 << 16) | (1 << 19);
    let (bytes, ..) = wire(0, "HI", flags);
    let r = decode_box(&bytes).unwrap();
    let ink = r.request.ink.as_ref().expect("ink");
    assert_eq!(ink.origin, Pt::new(10.0, 30.0));
    assert!(ink.tips.is_empty());
    let k = &ink.strokes[0];
    assert!(k.ribbon && k.follow_dir && k.water_edge && !k.density && !k.texture);
    assert_eq!(k.antialias, 2);
    assert_eq!((k.flip_x, k.flip_y), (Flip::Random, Flip::On));
    assert_eq!(k.tip_order, TipOrder::Random);
    assert!(k.taper_in.on && !k.taper_in.pct && !k.taper_out.on && k.taper_out.pct);
    assert_eq!(k.color, Rgba([255, 0, 0, 255]));
    assert_eq!((k.size, k.seed, k.tip), (10.0, 7.0, None));
    assert_eq!(
        k.pts,
        vec![[20.0, 20.0, 1.0, 1.0, 1.0], [120.0, 20.0, 1.0, 1.0, 1.0]]
    );
    // No ink is none.
    let mut none = bytes.clone();
    let (_, ink_at, _) = wire(0, "HI", 0);
    none.truncate(ink_at);
    u(&mut none, 0);
    u(&mut none, 0);
    let job = job_bytes(0, "HI");
    u(&mut none, job.len() as u32);
    none.extend_from_slice(&job);
    assert!(decode_box(&none).unwrap().request.ink.is_none());
}

#[test]
fn a_damaged_ink_record_is_refused_not_guessed_at() {
    let (good, ink_at, at) = wire(0, "HI", 0);
    assert!(decode_box(&good).is_ok());
    for len in ink_at..good.len() {
        assert!(decode_box(&good[..len]).is_err(), "accepted {len} bytes");
    }
    let with_u = |p: usize, v: u32| {
        let mut b = good.clone();
        b[p..p + 4].copy_from_slice(&v.to_le_bytes());
        decode_box(&b).map(|_| ()).err()
    };
    let with_f = |p: usize, v: f64| {
        let mut b = good.clone();
        b[p..p + 8].copy_from_slice(&v.to_le_bytes());
        decode_box(&b).map(|_| ()).err()
    };
    assert_eq!(with_u(ink_at, 2), Some(Error::BadSpec));
    assert_eq!(with_f(ink_at + 4, f64::NAN), Some(Error::BadSpec));
    assert_eq!(with_f(ink_at + 4, 1e6), Some(Error::BadSpec));
    // A count of tips or strokes the bytes cannot hold, more strokes than
    // the guard.
    assert_eq!(with_u(ink_at + 20, 5), Some(Error::BadSpec));
    assert_eq!(with_u(ink_at + 24, 2), Some(Error::BadSpec));
    assert_eq!(with_u(ink_at + 24, 4097), Some(Error::BadSpec));
    // Flags that are not ones: bit 7, bit 20, a flip of 3.
    assert_eq!(with_u(at, 1 << 7), Some(Error::BadSpec));
    assert_eq!(with_u(at, 1 << 20), Some(Error::BadSpec));
    assert_eq!(with_u(at, 3 << 10), Some(Error::BadSpec));
    assert_eq!(with_u(at, 3 << 12), Some(Error::BadSpec));
    assert_eq!(with_u(at, 0x000f_ff7f & !(3 << 10) & !(3 << 12)), None);
    // Numbers out of their ranges.
    for (p, bad) in [
        (AT_OPACITY, 1.5),
        (AT_OPACITY, -0.1),
        (AT_SIZE, 0.25),
        (AT_SIZE, 2001.0),
        (AT_FLATNESS, 0.0),
        (AT_SEED, f64::INFINITY),
        (AT_SEED, 1e17),
    ] {
        assert_eq!(with_f(at + p, bad), Some(Error::BadSpec), "{p} {bad}");
    }
    // A tip the table does not hold, a cycle the bytes cannot hold.
    assert_eq!(with_u(at + AT_TIP, 0), Some(Error::BadSpec));
    assert_eq!(with_u(at + AT_CYCLE, 1000), Some(Error::BadSpec));
    // No points, a stride that is not 3 or 5, a factor past 1, a point past
    // the guard.
    assert_eq!(with_u(at + AT_POINTS, 0), Some(Error::BadSpec));
    assert_eq!(with_u(at + AT_POINTS + 4, 4), Some(Error::BadSpec));
    assert_eq!(with_f(at + AT_POINTS + 8 + 16, 1.5), Some(Error::BadSpec));
    assert_eq!(with_f(at + AT_POINTS + 8, 70000.0), Some(Error::BadSpec));
    // More points than the guard, over every stroke: refused before they
    // are read.
    assert_eq!(with_u(at + AT_POINTS, 1 << 21), Some(Error::BadSpec));
}

// ---------------------------------------------------------------------------
// The ink as content of the box.

fn px(r: &Raster, x: i32, y: i32) -> [u8; 4] {
    let (lx, ly) = (x - r.x, y - r.y);
    if lx < 0 || ly < 0 || lx >= r.width as i32 || ly >= r.height as i32 {
        return [0; 4];
    }
    let i = (ly as usize * r.width as usize + lx as usize) * 4;
    r.data[i..i + 4].try_into().unwrap()
}

const RED: Rgba = Rgba([255, 0, 0, 255]);
const BLUE: Rgba = Rgba([0, 0, 255, 255]);

/// A box of `text` (nothing for none) with one black stroke from (30, 50)
/// to (130, 50), 12 wide, in a 200 x 160 surface.
fn inked(font: FontId, text: &str) -> BoxRequest {
    let request = Request {
        job: Job {
            curved: false,
            align: Align::Left,
            letter_spacing: 0.0,
            bands: Vec::new(),
            silhouette: None,
            no_fill: false,
            fill: Some(Fill::Solid(BLUE)),
            mesh: None,
            roughen: None,
            effects: Effects::default(),
            runs: vec![Run {
                text: text.to_owned(),
                x: 40.0,
                y: 140.0,
                rot: 0.0,
                sx: 1.0,
                sy: 1.0,
                skew: 0.0,
                drip: 0.0,
                pen: 1.0,
                ghost: false,
                fill: None,
            }],
        },
        face: Face::new(font, 40.0),
        bold_draw: None,
        weight: 0.0,
        transform: Affine::IDENTITY,
        tiles: Vec::new(),
        ink: Some(Ink::new(
            Pt::new(20.0, 40.0),
            vec![Stroke {
                size: 12.0,
                pts: vec![[10.0, 10.0, 1.0, 1.0, 1.0], [110.0, 10.0, 1.0, 1.0, 1.0]],
                ..Stroke::default()
            }],
        )),
    };
    BoxRequest::new(200, 160, request)
}

fn paint(e: &mut Engine, r: &mut BoxRequest) -> Raster {
    paint_box(e, r).unwrap().expect("something was drawn")
}

#[test]
fn an_ink_box_with_no_letters_paints() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let r = paint(&mut e, &mut inked(font, ""));
    assert_eq!(px(&r, 80, 50), [0, 0, 0, 255]);
    assert_eq!(px(&r, 80, 60)[3], 0);
    // Its raster is the stroke's: a hundred long and twelve wide, round at
    // the ends.
    assert!(
        (r.x, r.y) >= (23, 43) && (r.x, r.y) <= (25, 45),
        "{:?}",
        (r.x, r.y)
    );
    assert!(r.width >= 110 && r.width <= 114 && r.height >= 12 && r.height <= 14);
    // And from the wire too.
    let (bytes, ..) = wire(font, "", 0);
    let r = paint(&mut e, &mut decode_box(&bytes).unwrap());
    assert_eq!(px(&r, 70, 50), [255, 0, 0, 255]);
}

#[test]
fn the_ink_lies_over_the_letters_and_paints_the_same_twice() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let a = paint(&mut e, &mut inked(font, "IIII"));
    // A letter under the stroke and one below it.
    assert!(a.data.as_chunks::<4>().0.contains(&[0, 0, 255, 255]));
    assert_eq!(px(&a, 80, 50), [0, 0, 0, 255]);
    let b = paint(&mut e, &mut inked(font, "IIII"));
    assert_eq!(a, b);
}

#[test]
fn a_shadow_is_thrown_from_the_ink() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut r = inked(font, "");
    r.shadows.push(Shadow {
        color: RED,
        y: 20.0,
        ..Shadow::default()
    });
    let out = paint(&mut e, &mut r);
    assert_eq!(px(&out, 80, 50), [0, 0, 0, 255]);
    assert_eq!(px(&out, 80, 70), [255, 0, 0, 255]);
}

#[test]
fn the_outlines_go_round_the_ink_and_its_shadow_round_them() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut r = inked(font, "");
    r.request.job.bands = vec![Band {
        color: RED,
        opacity: 1.0,
        line: 8.0,
    }];
    r.shadows.push(Shadow {
        color: BLUE,
        y: 30.0,
        ..Shadow::default()
    });
    let out = paint(&mut e, &mut r);
    // The ink, then four of outline past its edge (6 from the middle).
    assert_eq!(px(&out, 80, 50), [0, 0, 0, 255]);
    assert_eq!(px(&out, 80, 58), [255, 0, 0, 255]);
    assert_eq!(px(&out, 80, 62)[3], 0);
    // The shadow is the ink and its outline as one shape, 20 tall, thrown 30 down.
    assert_eq!(px(&out, 80, 88), [0, 0, 255, 255]);
    assert_eq!(px(&out, 80, 72), [0, 0, 255, 255]);
    assert_eq!(px(&out, 80, 93)[3], 0);
}

#[test]
fn fill_opacity_fades_the_ink_and_not_its_outline() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut r = inked(font, "");
    r.request.job.bands = vec![Band {
        color: RED,
        opacity: 1.0,
        line: 8.0,
    }];
    r.fill_opacity = 0.0;
    let out = paint(&mut e, &mut r);
    // Gone where the ink was, and the outline cut away under it.
    assert_eq!(px(&out, 80, 50)[3], 0);
    assert_eq!(px(&out, 80, 58), [255, 0, 0, 255]);
    r.fill_opacity = 0.5;
    let out = paint(&mut e, &mut r);
    assert_eq!(px(&out, 80, 50), [0, 0, 0, 128]);
}

#[test]
fn no_fill_hides_the_letters_fill_and_keeps_the_ink() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut r = inked(font, "IIII");
    r.request.job.no_fill = true;
    r.request.job.fill = None;
    r.request.job.bands = vec![Band {
        color: RED,
        opacity: 1.0,
        line: 4.0,
    }];
    let out = paint(&mut e, &mut r);
    assert_eq!(px(&out, 80, 50), [0, 0, 0, 255]);
    assert!(!out.data.as_chunks::<4>().0.contains(&[0, 0, 255, 255]));
}
