//! Crop extraction has its own input and output buffers. A successful call
//! replaces the last cell; a refused extraction clears it so a caller cannot
//! mistake an old tile for the result of a malformed crop. No painter state
//! or fonts are involved, and adding these exports changes no existing ABI.

use std::cell::RefCell;

use crate::abi::Status;
use crate::paint::budget::{self, Buffer};
use crate::pattern::{self, MAX_SIDE};
use crate::Error;

#[derive(Default)]
struct State {
    input: Buffer<u8>,
    pixels: Vec<u8>,
    // The thread-local State is initialized in place and never replaced.
    // This fixed array therefore has a stable address without an allocation.
    info: [f64; 9],
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

/// Returns writable RGBA storage, or null for a size above 1024² * 4 or a
/// failed allocation. A refusal preserves the input and the previous result.
/// The pointer lasts until a reserve grows the input buffer.
#[no_mangle]
pub extern "C" fn mt_pattern_input_reserve(len: usize) -> *mut u8 {
    STATE.with(|state| {
        let mut s = state.borrow_mut();
        if len > MAX_SIDE * MAX_SIDE * 4 {
            return core::ptr::null_mut();
        }
        let _scope = budget::Scope::new();
        let size = len.max(s.input.len());
        if budget::resize(&mut s.input, size, 0).is_err() {
            return core::ptr::null_mut();
        }
        s.input.as_mut_ptr()
    })
}

/// Reads width * height * 4 straight RGBA bytes. Returns 1 with a lattice
/// cell and nine report values, or a negative Status. Zero dimensions, sides
/// above 1024 and input that has not been reserved are all malformed specs.
#[no_mangle]
pub extern "C" fn mt_pattern_extract(width: u32, height: u32) -> i32 {
    STATE.with(|state| {
        let mut s = state.borrow_mut();
        s.pixels = Vec::new();
        s.info = [0.0; 9];
        let result = (|| {
            let _scope = budget::Scope::new();
            if width == 0 || height == 0 || width as usize > MAX_SIDE || height as usize > MAX_SIDE
            {
                return Err(Error::BadSpec);
            }
            s.input.account()?;
            let len = width as usize * height as usize * 4;
            let bytes = s.input.get(..len).ok_or(Error::BadSpec)?;
            pattern::extract(width as usize, height as usize, bytes)
        })();
        match result {
            Ok(tile) => {
                s.info = tile.info();
                s.pixels = tile.pixels;
                1
            }
            Err(e) => Status::from(e) as i32,
        }
    })
}

/// N² * 4 opaque RGBA8 bytes, valid until the next extraction. Empty when
/// there is no successful result; callers first read N from the report.
#[no_mangle]
pub extern "C" fn mt_pattern_output_pixels() -> *const u8 {
    STATE.with(|state| state.borrow().pixels.as_ptr())
}

/// [periodic, confidence, period, angle, ax, ay, bx, by, N], all f64.
/// Views of either output must be reacquired after wasm memory grows.
#[no_mangle]
pub extern "C" fn mt_pattern_output_info() -> *const f64 {
    STATE.with(|state| state.borrow().info.as_ptr())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_input_bounds_and_clears_failed_results() {
        assert_eq!(mt_pattern_extract(16, 16), Status::BadSpec as i32);
        assert!(!mt_pattern_input_reserve(16 * 16 * 4).is_null());
        assert!(mt_pattern_input_reserve(MAX_SIDE * MAX_SIDE * 4 + 1).is_null());
        assert_eq!(mt_pattern_extract(16, 16), 1);
        STATE.with(|s| {
            let s = s.borrow();
            assert_eq!(s.info[8], 16.0);
            assert_eq!(s.pixels.len(), 16 * 16 * 4);
            assert!(s.pixels.as_chunks::<4>().0.iter().all(|p| *p == [0, 0, 0, 255]));
        });
        for (w, h) in [
            (0, 16),
            (16, 0),
            (1025, 1),
            (1, 1025),
            (u32::MAX, u32::MAX),
            (17, 16),
        ] {
            assert_eq!(mt_pattern_extract(w, h), Status::BadSpec as i32);
            STATE.with(|s| {
                assert_eq!(s.borrow().info, [0.0; 9]);
                assert!(s.borrow().pixels.is_empty());
            });
        }
    }

    #[test]
    fn budget_refusal_is_recoverable() {
        assert!(!mt_pattern_input_reserve(32 * 32 * 4).is_null());
        budget::limit_next_scope_for_test(8);
        assert_eq!(mt_pattern_extract(32, 32), Status::BadSpec as i32);
        assert_eq!(mt_pattern_extract(32, 32), 1);
        budget::limit_next_scope_for_test(8);
        assert!(mt_pattern_input_reserve(128 * 128 * 4).is_null());
        assert!(!mt_pattern_input_reserve(128 * 128 * 4).is_null());
    }
}
