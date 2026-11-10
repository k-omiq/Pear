//! Page encoders for the export.
//!
//! The webview's own encoders are not good enough for lettered pages. WebKit's
//! and Chromium's canvas JPEG keeps colour at half resolution each way
//! (4:2:0), so a one-pixel red outline comes back as a pink-grey smear, and
//! WebKit cannot write WebP at all: asked for one, it hands back a PNG. These
//! encode straight RGBA8 instead - JPEG with colour at full resolution (4:4:4)
//! and WebP lossless - from the same pixels, so only the file is better.
//!
//! One input buffer and one output buffer, as `abi_pattern` has. A refused
//! encode clears the output, so a caller cannot take an old file for a new one.

use std::cell::RefCell;

use crate::abi::Status;
use crate::paint::budget::{self, Buffer};
use crate::Error;

#[derive(Default)]
struct State {
    input: Buffer<u8>,
    output: Vec<u8>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

/// The longest side either format holds: JPEG stores a side in 16 bits, and
/// lossless WebP in 14.
const JPEG_MAX_SIDE: u32 = 65_535;
const WEBP_MAX_SIDE: u32 = 16_384;

/// Returns writable storage for `len` straight RGBA8 bytes, or null for a
/// failed allocation. The pointer lasts until a reserve grows the buffer.
#[no_mangle]
pub extern "C" fn mt_encode_input_reserve(len: usize) -> *mut u8 {
    STATE.with(|state| {
        let mut s = state.borrow_mut();
        let _scope = budget::Scope::new();
        let size = len.max(s.input.len());
        if budget::resize(&mut s.input, size, 0).is_err() {
            return core::ptr::null_mut();
        }
        s.input.as_mut_ptr()
    })
}

/// The reserved input as `width` x `height` RGBA8, or a malformed spec.
fn pixels(s: &State, width: u32, height: u32, max_side: u32) -> Result<&[u8], Error> {
    if width == 0 || height == 0 || width > max_side || height > max_side {
        return Err(Error::BadSpec);
    }
    let len = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4))
        .ok_or(Error::BadSpec)?;
    s.input.get(..len).ok_or(Error::BadSpec)
}

/// Whether every pixel is opaque: such a page is written without alpha.
fn opaque(rgba: &[u8]) -> bool {
    rgba.as_chunks::<4>().0.iter().all(|p| p[3] == 255)
}

/// `rgba` without its alpha bytes.
fn rgb(rgba: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rgba.len() / 4 * 3);
    for p in rgba.as_chunks::<4>().0 {
        out.extend_from_slice(&p[..3]);
    }
    out
}

/// Encodes the reserved input as a baseline JPEG at `quality` (1 to 100)
/// with colour at full resolution (4:4:4). Alpha is dropped: a page is
/// composited over white before it is encoded. Returns 1 with the file in the
/// output, or a negative Status.
#[no_mangle]
pub extern "C" fn mt_encode_jpeg(width: u32, height: u32, quality: u32) -> i32 {
    run(|s| {
        if !(1..=100).contains(&quality) {
            return Err(Error::BadSpec);
        }
        let data = pixels(s, width, height, JPEG_MAX_SIDE)?;
        let mut out = Vec::new();
        let mut enc = jpeg_encoder::Encoder::new(&mut out, quality as u8);
        enc.set_sampling_factor(jpeg_encoder::SamplingFactor::F_1_1);
        enc.encode(data, width as u16, height as u16, jpeg_encoder::ColorType::Rgba)
            .map_err(|_| Error::BadSpec)?;
        Ok(out)
    })
}

/// Encodes the reserved input as a lossless WebP, with alpha only when some
/// pixel is not opaque. Returns 1 with the file in the output, or a negative
/// Status.
#[no_mangle]
pub extern "C" fn mt_encode_webp_lossless(width: u32, height: u32) -> i32 {
    run(|s| {
        let data = pixels(s, width, height, WEBP_MAX_SIDE)?;
        let mut out = Vec::new();
        let enc = image_webp::WebPEncoder::new(&mut out);
        let result = if opaque(data) {
            enc.encode(&rgb(data), width, height, image_webp::ColorType::Rgb8)
        } else {
            enc.encode(data, width, height, image_webp::ColorType::Rgba8)
        };
        result.map_err(|_| Error::BadSpec)?;
        Ok(out)
    })
}

fn run(encode: impl FnOnce(&State) -> Result<Vec<u8>, Error>) -> i32 {
    STATE.with(|state| {
        let mut s = state.borrow_mut();
        s.output = Vec::new();
        let result = {
            let _scope = budget::Scope::new();
            match s.input.account() {
                Ok(()) => encode(&s),
                Err(e) => Err(e),
            }
        };
        match result {
            Ok(file) => {
                s.output = file;
                1
            }
            Err(e) => Status::from(e) as i32,
        }
    })
}

/// The last encoded file, valid until the next encode or release. Empty
/// after a refusal.
#[no_mangle]
pub extern "C" fn mt_encode_output_ptr() -> *const u8 {
    STATE.with(|state| state.borrow().output.as_ptr())
}

#[no_mangle]
pub extern "C" fn mt_encode_output_len() -> u32 {
    STATE.with(|state| state.borrow().output.len() as u32)
}

/// Hands both buffers back: a page is megabytes, and the export encodes one
/// at a time.
#[no_mangle]
pub extern "C" fn mt_encode_release() {
    STATE.with(|state| *state.borrow_mut() = State::default());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(rgba: &[u8]) {
        let p = mt_encode_input_reserve(rgba.len());
        assert!(!p.is_null());
        unsafe { core::ptr::copy_nonoverlapping(rgba.as_ptr(), p, rgba.len()) };
    }
    fn output() -> Vec<u8> {
        STATE.with(|s| s.borrow().output.clone())
    }

    // One-pixel red and blue columns on white: what 4:2:0 smears.
    fn columns(w: usize, h: usize) -> Vec<u8> {
        let mut v = Vec::with_capacity(w * h * 4);
        for _ in 0..h {
            for x in 0..w {
                v.extend_from_slice(match x % 4 {
                    1 => &[224, 16, 16, 255],
                    3 => &[16, 48, 224, 255],
                    _ => &[255, 255, 255, 255],
                });
            }
        }
        v
    }

    #[test]
    fn a_jpeg_is_a_jpeg_with_full_resolution_colour() {
        put(&columns(32, 16));
        assert_eq!(mt_encode_jpeg(32, 16, 95), 1);
        let f = output();
        assert_eq!(&f[..2], &[0xFF, 0xD8]);
        assert_eq!(&f[f.len() - 2..], &[0xFF, 0xD9]);
        // The baseline frame header: three components, each sampled 1x1.
        let sof = f.windows(2).position(|w| w == [0xFF, 0xC0]).expect("baseline frame");
        assert_eq!(f[sof + 9], 3);
        let comps = &f[sof + 10..sof + 19];
        for c in comps.chunks(3) {
            assert_eq!(c[1], 0x11, "component {} sampled {:#x}", c[0], c[1]);
        }
    }

    #[test]
    fn full_resolution_colour_even_at_a_low_quality() {
        put(&columns(32, 16));
        assert_eq!(mt_encode_jpeg(32, 16, 60), 1);
        let f = output();
        let sof = f.windows(2).position(|w| w == [0xFF, 0xC0]).unwrap();
        assert_eq!(f[sof + 11], 0x11);
    }

    #[test]
    fn a_webp_is_a_lossless_webp() {
        put(&columns(32, 16));
        assert_eq!(mt_encode_webp_lossless(32, 16), 1);
        let f = output();
        assert_eq!(&f[..4], b"RIFF");
        assert_eq!(&f[8..16], b"WEBPVP8L");
    }

    #[test]
    fn malformed_requests_are_refused_and_leave_no_file() {
        put(&columns(8, 8));
        assert_eq!(mt_encode_jpeg(8, 8, 90), 1);
        for (w, h, q) in [(0, 8, 90), (8, 0, 90), (8, 9, 90), (8, 8, 0), (8, 8, 101), (70_000, 1, 90)] {
            assert_eq!(mt_encode_jpeg(w, h, q), Status::BadSpec as i32, "{w}x{h} q{q}");
            assert!(output().is_empty());
        }
        assert_eq!(mt_encode_webp_lossless(20_000, 1), Status::BadSpec as i32);
        assert!(output().is_empty());
        mt_encode_release();
        assert_eq!(mt_encode_output_len(), 0);
    }
}
