//! What a box's mask, fade and paint hold at once while they are painted,
//! counted by the allocator itself: the most bytes live above what was live
//! before the paint. Each test runs alone in this binary's one thread at a
//! time (a lock), so another test's allocations are not counted.
#![cfg(feature = "paint")]

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use mt_text::paint::fx::blend::Blend;
use mt_text::paint::fx::effects::{Effect, Marks, PaintMark};
use mt_text::paint::{
    paint_box, paint_box_kept, Affine, BoxKeys, Align, BoxRequest, ClipShape, Effects, Fade, FadePart, Fill, Job, Pt,
    Request, Rgba, Run,
};
use mt_text::{Engine, Face, FontId};

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            let now = LIVE.fetch_add(l.size(), Ordering::Relaxed) + l.size();
            PEAK.fetch_max(now, Ordering::Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) };
        LIVE.fetch_sub(l.size(), Ordering::Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, size: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, l, size) };
        if !q.is_null() {
            if size > l.size() {
                let now = LIVE.fetch_add(size - l.size(), Ordering::Relaxed) + size - l.size();
                PEAK.fetch_max(now, Ordering::Relaxed);
            } else {
                LIVE.fetch_sub(l.size() - size, Ordering::Relaxed);
            }
        }
        q
    }
}

#[global_allocator]
static A: Counting = Counting;
static ONE: Mutex<()> = Mutex::new(());

/// The most bytes live above the start while `f` ran, and how long it took.
fn peak<T>(f: impl FnOnce() -> T) -> (usize, f64, T) {
    let start = LIVE.load(Ordering::Relaxed);
    PEAK.store(start, Ordering::Relaxed);
    let t = Instant::now();
    let out = f();
    let ms = t.elapsed().as_secs_f64() * 1000.0;
    (PEAK.load(Ordering::Relaxed) - start, ms, out)
}

fn load(engine: &mut Engine) -> FontId {
    let path = format!("{}/../src/test/fonts/DejaVuSans.ttf", env!("CARGO_MANIFEST_DIR"));
    engine.add_font_bytes(std::fs::read(path).unwrap(), 0).unwrap()
}

/// A 600 x 400 box at scale 2: "HHHH" at 120, black, over a 1200 x 800
/// surface.
fn big(font: FontId) -> BoxRequest {
    let request = Request {
        job: Job {
            curved: false,
            align: Align::Left,
            letter_spacing: 0.0,
            bands: Vec::new(),
            silhouette: None,
            no_fill: false,
            fill: Some(Fill::Solid(Rgba([0, 0, 0, 255]))),
            mesh: None,
            roughen: None,
            effects: Effects::default(),
            runs: vec![Run {
                text: "HHHH".to_owned(),
                x: 60.0,
                y: 260.0,
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
        face: Face::new(font, 200.0),
        bold_draw: None,
        weight: 0.0,
        transform: Affine::scale(2.0, 2.0),
        tiles: Vec::new(),
        ink: None,
    };
    let mut b = BoxRequest::new(1200, 800, request);
    b.blend = Blend::Normal;
    b
}

/// `n` brush strokes: short dabs in a grid, or (`long`) strokes that run
/// corner to corner across the box, so each one's own coverage is about the
/// whole surface.
fn strokes(n: usize, soft: f64, long: bool) -> Fade {
    Fade {
        origin: Pt::new(0.0, 0.0),
        shapes: (0..n)
            .map(|i| {
                let pts = if long {
                    let d = (i % 40) as f64 * 5.0;
                    vec![Pt::new(10.0 + d, 10.0), Pt::new(300.0, 200.0 + d / 4.0), Pt::new(590.0 - d, 390.0)]
                } else {
                    let (x, y) = (20.0 + (i % 20) as f64 * 28.0, 20.0 + (i / 20 % 20) as f64 * 18.0);
                    vec![Pt::new(x, y), Pt::new(x + 12.0, y + 4.0), Pt::new(x + 20.0, y - 2.0)]
                };
                FadePart { strength: 0.5, soft, shape: ClipShape::Stroke { size: 8.0, pts } }
            })
            .collect(),
    }
}

/// The fade's shapes are rastered when their group is, from their boxes
/// until then: 400 strokes hold no more at once than 50.
#[test]
fn the_fade_holds_one_group_and_one_shape_at_a_time() {
    let _one = ONE.lock().unwrap();
    let mut e = Engine::new();
    let font = load(&mut e);
    for long in [false, true] {
        for soft in [0.0, 6.0] {
            let mut rows = Vec::new();
            for n in [50, 400] {
                let mut b = big(font);
                b.fade = Some(strokes(n, soft, long));
                let (bytes, ms, r) = peak(|| paint_box(&mut e, &mut b).unwrap());
                assert!(r.is_some());
                let kind = if long { "long" } else { "short" };
                eprintln!("fade, {kind}, soft {soft}, {n} strokes: peak {:.1} MB, {ms:.1} ms", bytes as f64 / 1e6);
                rows.push(bytes);
            }
            // The surface (3.8 MB), one group's raster and the one shape
            // rastered at a time are most of it: the count does not show.
            assert!(rows[1] < rows[0] + rows[0] / 4, "{rows:?}");
        }
    }
}

fn soft_mark(cx: f64, cy: f64, rx: f64, ry: f64) -> PaintMark {
    // Soft 100: a quarter of the mark's size, as the app sends it.
    PaintMark {
        shape: ClipShape::Ellipse { centre: Pt::new(cx, cy), rx, ry },
        color: Rgba([230, 40, 30, 255]),
        opacity: 1.0,
        soft: 2.0 * rx.min(ry) / 4.0,
        erase: false,
    }
}

/// A soft mark is rastered and blurred on a piece of its own size, at a
/// fraction of the surface's resolution once its blur is wide, and the
/// blurred pieces are kept: one large mark at soft 100 holds a few MB, and a
/// repaint reads it back.
#[test]
fn a_soft_mark_holds_a_piece_of_its_own_size() {
    let _one = ONE.lock().unwrap();
    let mut e = Engine::new();
    let font = load(&mut e);
    mt_text::paint::kept::set_ceiling(mt_text::paint::kept::KEPT_BYTES);
    let cases: [(&str, Vec<PaintMark>); 2] = [
        ("one large soft-100 mark", vec![soft_mark(300.0, 200.0, 290.0, 190.0)]),
        (
            "20 soft-100 marks",
            (0..20).map(|i| soft_mark(40.0 + (i % 5) as f64 * 120.0, 60.0 + (i / 5) as f64 * 90.0, 40.0, 30.0)).collect(),
        ),
    ];
    let keys = || BoxKeys {
        job: mt_text::paint::kept::Hasher::new("t job").u64(7).finish().unwrap(),
        premask: None,
        cover: None,
    };
    for (name, marks) in cases {
        let make = |marks: &[PaintMark]| {
            let mut b = big(font);
            b.effects.push(Effect::Paint(Marks { origin: Pt::new(0.0, 0.0), marks: marks.to_vec() }));
            b
        };
        mt_text::paint::kept::clear();
        let mut b = make(&marks);
        let (cold, cold_ms, r) = peak(|| paint_box_kept(&mut e, &mut b, keys()).unwrap());
        assert!(r.is_some());
        assert_eq!(r, paint_box(&mut e, &mut make(&marks)).unwrap());
        // One more mark: the ones before are read back.
        let mut more = marks.clone();
        more.push(soft_mark(500.0, 320.0, 30.0, 20.0));
        let mut b = make(&more);
        let (_, more_ms, r2) = peak(|| paint_box_kept(&mut e, &mut b, keys()).unwrap());
        assert_eq!(r2, paint_box(&mut e, &mut make(&more)).unwrap());
        eprintln!("paint, {name}: peak {:.1} MB, {cold_ms:.1} ms; one more mark {more_ms:.1} ms", cold as f64 / 1e6);
        // The surface (3.8 MB), the layer (as big), the pieces.
        assert!(cold < 20_000_000, "{cold}");
    }
}
