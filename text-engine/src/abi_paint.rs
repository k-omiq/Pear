//! The painter's exports: one call per job.
//!
//! The caller writes a job in its wire form (`paint::decode`) into the buffer
//! behind `mt_paint_job_reserve` and calls `mt_paint_job`. The pixels stay in
//! an engine-owned buffer until the next job or `mt_paint_job_release`.
//!
//! Kept apart from `abi.rs` so the two can change independently; the only
//! thing shared is the engine and its fonts.

use std::cell::RefCell;

use crate::abi::{with_engine, Status};
use crate::paint::{self, Raster};
use crate::Error;

#[derive(Default)]
struct State {
    job: Vec<u8>,
    pixels: Vec<u8>,
    /// `[x, y, width, height]` of the last raster, in device pixels. Boxed
    /// so its address survives the thread-local being moved into place.
    result: Box<[f64; 4]>,
    #[cfg(any(
        feature = "raster-tiny-skia",
        feature = "raster-zeno",
        feature = "raster-vello"
    ))]
    rasterizer: u32,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|s| f(&mut s.borrow_mut()))
}

/// A job buffer larger than this is let go once its job is decoded
/// (`drop_big_job`). A job is a few kilobytes of text and records; one that
/// carries a backdrop or a big picked tile can be tens of megabytes, and the
/// decoded job holds its own copy of those. Kept, the buffer would be a second
/// copy for the whole paint, and the paint's own buffers would have to be
/// found past it: wasm memory never shrinks, so that is the module's size
/// for the rest of the session.
pub const JOB_KEEP_BYTES: usize = 1 << 20;

/// Lets the job buffer go when it is past [`JOB_KEEP_BYTES`]. Called once the
/// job is decoded: nothing reads the wire form after that, and the next job
/// reserves its own.
fn drop_big_job(job: &mut Vec<u8>) {
    if job.capacity() > JOB_KEEP_BYTES {
        *job = Vec::new();
    }
}

/// Largest job accepted, in bytes. A guard like the surface's: a job is its
/// text and its pattern tiles, and the largest the app can write is a few
/// megabytes.
pub const MAX_JOB_BYTES: usize = 1 << 28;

/// Returns the job buffer, grown to hold at least `capacity` bytes, or null
/// when `capacity` is more than [`MAX_JOB_BYTES`] or the memory is not to be
/// had. The pointer stays valid until the next call with a larger capacity.
///
/// A refusal changes nothing: the buffer is as it was and the engine paints
/// the next job as if this call had not been made. (Growing a `Vec` past
/// what the allocator can give aborts, which in wasm is a trap that leaves
/// this module's state borrowed for good.)
#[no_mangle]
pub extern "C" fn mt_paint_job_reserve(capacity: usize) -> *mut u8 {
    with(|s| {
        if s.job.len() < capacity {
            let more = capacity - s.job.len();
            if capacity > MAX_JOB_BYTES || s.job.try_reserve_exact(more).is_err() {
                return core::ptr::null_mut();
            }
            s.job.resize(capacity, 0);
        }
        s.job.as_mut_ptr()
    })
}

/// Paints the job in the first `byte_len` bytes of the job buffer.
///
/// Returns 1 when something was drawn: `mt_paint_job_result` then holds
/// `[x, y, width, height]` and `mt_paint_job_pixels` points at
/// `width * height * 4` bytes of straight-alpha RGBA8. Returns 0 when the
/// job draws nothing, or a negative [`Status`].
#[no_mangle]
pub extern "C" fn mt_paint_job(byte_len: usize) -> i32 {
    with(|s| {
        s.pixels = Vec::new();
        *s.result = [0.0; 4];
        let painted = (|| -> Result<Option<Raster>, Error> {
            let _budget = paint::budget::Scope::new();
            let request = paint::decode(s.job.get(..byte_len).ok_or(Error::BadSpec)?)?;
            drop_big_job(&mut s.job);
            #[cfg(any(
                feature = "raster-tiny-skia",
                feature = "raster-zeno",
                feature = "raster-vello"
            ))]
            let rasterizer = paint::compare::by_id(s.rasterizer).ok_or(Error::BadSpec)?;
            #[cfg(not(any(
                feature = "raster-tiny-skia",
                feature = "raster-zeno",
                feature = "raster-vello"
            )))]
            let rasterizer: &dyn paint::Rasterizer = &paint::Exact;
            with_engine(|engine| paint::paint_job_with(engine, &request, rasterizer))
        })();
        match painted {
            Ok(Some(raster)) => {
                *s.result = [
                    f64::from(raster.x),
                    f64::from(raster.y),
                    f64::from(raster.width),
                    f64::from(raster.height),
                ];
                s.pixels = raster.data;
                1
            }
            Ok(None) => 0,
            Err(e) => Status::from(e) as i32,
        }
    })
}

/// Paints the box job in the first `byte_len` bytes of the job buffer: a
/// glyph job and the shadows, the blur, the smear and the mask that go with
/// it (`paint::decode_box`).
///
/// The result is read as a glyph job's is: 1 when something was drawn, with
/// `mt_paint_job_result` and `mt_paint_job_pixels` holding it; 0 when the
/// box draws nothing; or a negative [`Status`].
#[no_mangle]
pub extern "C" fn mt_paint_box(byte_len: usize) -> i32 {
    with(|s| {
        s.pixels = Vec::new();
        *s.result = [0.0; 4];
        let painted = (|| -> Result<Option<Raster>, Error> {
            let _budget = paint::budget::Scope::new();
            let (mut request, key) =
                paint::decode_box_kept(s.job.get(..byte_len).ok_or(Error::BadSpec)?)?;
            drop_big_job(&mut s.job);
            with_engine(|engine| paint::paint_box_kept(engine, &mut request, key))
        })();
        // The tips this job named may go again.
        paint::ink::tips::with_cache(|c| c.end_job());
        match painted {
            Ok(Some(raster)) => {
                *s.result = [
                    f64::from(raster.x),
                    f64::from(raster.y),
                    f64::from(raster.width),
                    f64::from(raster.height),
                ];
                s.pixels = raster.data;
                1
            }
            Ok(None) => 0,
            Err(e) => Status::from(e) as i32,
        }
    })
}

/// Puts one imported brush tip in the engine's tip cache
/// (`paint::ink::tips`), under the key a box job's ink names it by. The job
/// buffer (`mt_paint_job_reserve`) holds the key, `key_len` bytes of UTF-8,
/// and then the tip's coverage, `width * height` bytes row by row: the grey
/// times the alpha, eight bits, after the canvas's cap to 2048. `natural_w`
/// and `natural_h` are the tip's own size, which the stamp's shape is made
/// from.
///
/// Returns 0, or a negative [`Status`]: a key or tip past the limits (a side
/// past 4096, more than 16 MP), more than the buffer holds, or no room the
/// cache can make without letting go of a tip this job has named. A key
/// already held is replaced.
#[no_mangle]
pub extern "C" fn mt_ink_tip_put(
    key_len: usize,
    width: u32,
    height: u32,
    natural_w: u32,
    natural_h: u32,
) -> i32 {
    with(|s| {
        let put = (|| -> Result<(), Error> {
            let (w, h) = (width as usize, height as usize);
            let n = w.checked_mul(h).ok_or(Error::BadSpec)?;
            let end = key_len.checked_add(n).ok_or(Error::BadSpec)?;
            let bytes = s.job.get(..end).ok_or(Error::BadSpec)?;
            let key = core::str::from_utf8(&bytes[..key_len]).map_err(|_| Error::BadText)?;
            paint::ink::tips::with_cache(|c| {
                c.put(key, w, h, (natural_w, natural_h), &bytes[key_len..])
            })
        })();
        match put {
            Ok(()) => 0,
            Err(e) => Status::from(e) as i32,
        }
    })
}

/// 1 when the engine holds the tip whose key is the first `key_len` bytes
/// of the job buffer, 0 when it does not. A tip held is named for the next
/// box job: the cache does not let it go before that job is painted.
#[no_mangle]
pub extern "C" fn mt_ink_tip_has(key_len: usize) -> u32 {
    with(|s| {
        let Some(key) = s
            .job
            .get(..key_len)
            .and_then(|b| core::str::from_utf8(b).ok())
        else {
            return 0;
        };
        u32::from(paint::ink::tips::with_cache(|c| c.has(key)))
    })
}

/// Lets go of every tip the engine holds.
#[no_mangle]
pub extern "C" fn mt_ink_tips_forget() {
    paint::ink::tips::with_cache(|c| c.forget());
}

/// What the engine's tips hold, in bytes, their levels included.
#[no_mangle]
pub extern "C" fn mt_ink_tips_bytes() -> u32 {
    paint::ink::tips::with_cache(|c| c.bytes()) as u32
}

/// The version of the box job wire form this build reads.
#[no_mangle]
pub extern "C" fn mt_paint_box_wire_version() -> u32 {
    paint::BOX_WIRE_VERSION
}

/// Draws one tile of a pattern fill: `kind` as [`paint::PatternKind`]
/// numbers them, `side` pixels square, `fg` over `bg` (both `0xRRGGBBAA`),
/// a hairline `line` of the tile wide.
///
/// Returns 1 with the tile in `mt_paint_job_pixels` as straight RGBA8 and
/// `mt_paint_job_result` holding `[0, 0, side, side]`, or a negative
/// [`Status`]. The tile is a raster like any other: the next job replaces
/// it.
#[no_mangle]
pub extern "C" fn mt_paint_pattern_tile(kind: u32, side: u32, fg: u32, bg: u32, line: f64) -> i32 {
    with(|s| {
        s.pixels = Vec::new();
        *s.result = [0.0; 4];
        let drawn = (|| -> Result<Vec<u8>, Error> {
            let _budget = paint::budget::Scope::new();
            let kind = paint::PatternKind::from_id(kind).ok_or(Error::BadSpec)?;
            paint::pattern_tile(
                kind,
                paint::Rgba::from_u32(fg),
                paint::Rgba::from_u32(bg),
                side,
                line,
                &paint::Exact,
            )
        })();
        match drawn {
            Ok(pixels) => {
                *s.result = [0.0, 0.0, f64::from(side), f64::from(side)];
                s.pixels = pixels;
                1
            }
            Err(e) => Status::from(e) as i32,
        }
    })
}

/// The names of built-in screens, in wire-id order, separated by newlines.
#[no_mangle]
pub extern "C" fn mt_pattern_kinds_ptr() -> *const u8 {
    paint::KIND_NAMES.as_ptr()
}

#[no_mangle]
pub extern "C" fn mt_pattern_kinds_len() -> u32 {
    paint::KIND_NAMES.len() as u32
}

/// Reads an MTPS swatch from the job buffer and replaces the last raster.
/// Errors clear both the pixels and result, exactly as a failed job does.
#[no_mangle]
pub extern "C" fn mt_paint_pattern_swatch(byte_len: usize) -> i32 {
    with(|s| {
        s.pixels = Vec::new();
        *s.result = [0.0; 4];
        let drawn = (|| -> Result<_, Error> {
            let _budget = paint::budget::Scope::new();
            let (w, h, fill, tiles) =
                paint::decode_swatch(s.job.get(..byte_len).ok_or(Error::BadSpec)?)?;
            drop_big_job(&mut s.job);
            let pixels = paint::pattern_swatch(w, h, fill.as_ref(), &tiles)?;
            Ok((w, h, pixels))
        })();
        match drawn {
            Ok((w, h, pixels)) => {
                *s.result = [0.0, 0.0, f64::from(w), f64::from(h)];
                s.pixels = pixels;
                1
            }
            Err(e) => Status::from(e) as i32,
        }
    })
}

#[no_mangle]
pub extern "C" fn mt_paint_job_result() -> *const f64 {
    with(|s| s.result.as_ptr())
}

#[no_mangle]
pub extern "C" fn mt_paint_job_pixels() -> *const u8 {
    with(|s| s.pixels.as_ptr())
}

/// Frees the last raster. Optional: the next job replaces it anyway.
#[no_mangle]
pub extern "C" fn mt_paint_job_release() {
    with(|s| s.pixels = Vec::new());
}

/// The version of the job wire form this build reads.
#[no_mangle]
pub extern "C" fn mt_paint_wire_version() -> u32 {
    paint::WIRE_VERSION
}

/// Picks the rasteriser for the jobs that follow: 0 exact area (the one the
/// painter ships with), 1 tiny-skia, 2 zeno, 3 vello_cpu. Returns 0, or -5 for an unknown
/// id. Only in a comparison build.
#[cfg(any(
    feature = "raster-tiny-skia",
    feature = "raster-zeno",
    feature = "raster-vello"
))]
#[no_mangle]
pub extern "C" fn mt_paint_rasterizer(id: u32) -> i32 {
    if paint::compare::by_id(id).is_none() {
        return Status::BadSpec as i32;
    }
    with(|s| s.rasterizer = id);
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_big_job_buffer_goes_once_decoded_and_a_small_one_stays() {
        let mut small = Vec::with_capacity(JOB_KEEP_BYTES);
        small.resize(64, 7);
        drop_big_job(&mut small);
        assert_eq!((small.len(), small.capacity() >= JOB_KEEP_BYTES), (64, true));
        let mut big = vec![0u8; JOB_KEEP_BYTES + 1];
        drop_big_job(&mut big);
        assert_eq!(big.capacity(), 0);
        // The next reserve grows a fresh buffer: the pointer is good again.
        assert!(!mt_paint_job_reserve(JOB_KEEP_BYTES * 2).is_null());
        with(|s| {
            drop_big_job(&mut s.job);
            assert_eq!(s.job.capacity(), 0);
        });
        assert!(!mt_paint_job_reserve(16).is_null());
    }
}
