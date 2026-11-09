//! What one box paint keeps for the next.
//!
//! A box is painted again each time one of its settings moves, and most of
//! what a paint works out does not depend on that setting: the letters'
//! rasters, the shadows under them, each effect's map, the fill with the
//! effects laid on it. Each such piece is kept here under a key made from
//! everything it was worked out from, so a paint that asks for the same piece
//! again is handed it and does not work it out.
//!
//! A piece is never read for anything but the key it was put under, and a
//! key holds every input of its piece, to the bit: the job's own wire bytes,
//! the engine's fonts and rules ([`crate::Engine::stamp`]), and the settings
//! the piece reads, each as its `Debug` text (which names every field, and
//! says a float so that it reads back to the same bits). A setting that is
//! not a number has no key ([`Hasher::finish`]), and its piece is worked out
//! each time. So a paint gives the same bytes with the store cold, warm or
//! emptied: the tests in `tests/paint_kept.rs` paint each way and compare.
//!
//! The store is one to a thread, like the engine, and holds at most
//! [`KEPT_BYTES`]: the pieces least lately asked for go first. wasm memory
//! does not shrink, so the ceiling is the most the store adds to a module.

use std::any::Any;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::fmt::{Debug, Write};
use std::rc::Rc;

/// The most the store holds, pixels and maps together.
pub const KEPT_BYTES: usize = 48 * 1024 * 1024;
/// What an entry costs past its piece: the key, the map's slot.
const ENTRY_COST: usize = 96;
/// The most keys remembered as seen ([`seen`]); past it they are forgotten.
const MAX_SEEN: usize = 4096;

/// What a piece was worked out from, as 128 bits of hash.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Key(u64, u64);

/// Makes a [`Key`] from the inputs of a piece, in the order they are given.
pub struct Hasher {
    a: u64,
    b: u64,
    /// A float that is not a number was written: its `Debug` text does not
    /// say which, so there is no key.
    nan: bool,
    text: String,
}

fn mix(mut v: u64) -> u64 {
    v ^= v >> 33;
    v = v.wrapping_mul(0xff51_afd7_ed55_8ccd);
    v ^= v >> 33;
    v = v.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
    v ^ (v >> 33)
}

impl Hasher {
    /// A hasher for the pieces of one kind, named by `tag`.
    pub fn new(tag: &str) -> Self {
        Self {
            a: 0x243f_6a88_85a3_08d3,
            b: 0x1319_8a2e_0370_7344,
            nan: false,
            text: String::new(),
        }
        .bytes(tag.as_bytes())
    }

    fn word(&mut self, v: u64) {
        self.a = (self.a.rotate_left(5) ^ v).wrapping_mul(0x9e37_79b9_7f4a_7c15);
        self.b = mix(self.b ^ v.wrapping_mul(0xd6e8_feb8_6659_fd93));
    }

    pub fn u64(mut self, v: u64) -> Self {
        self.word(v);
        self
    }

    pub fn i32(self, v: i32) -> Self {
        self.u64(v as u32 as u64)
    }

    pub fn f64(self, v: f64) -> Self {
        self.u64(v.to_bits())
    }

    pub fn key(self, k: Key) -> Self {
        self.u64(k.0).u64(k.1)
    }

    /// A key that may not be there: with none, there is none of this either.
    pub fn maybe(mut self, k: Option<Key>) -> Self {
        match k {
            Some(k) => self.key(k),
            None => {
                self.nan = true;
                self
            }
        }
    }

    /// The bytes, and how many they are.
    pub fn bytes(mut self, bytes: &[u8]) -> Self {
        self.word(bytes.len() as u64);
        let (words, rest) = bytes.as_chunks::<8>();
        for w in words {
            self.word(u64::from_le_bytes(*w));
        }
        if !rest.is_empty() {
            let mut last = [0u8; 8];
            last[..rest.len()].copy_from_slice(rest);
            self.word(u64::from_le_bytes(last));
        }
        self
    }

    /// A setting, as its `Debug` text: every field, each float to the bit.
    pub fn debug(mut self, v: &impl Debug) -> Self {
        let mut text = core::mem::take(&mut self.text);
        text.clear();
        if write!(text, "{v:?}").is_err() || text.contains("NaN") {
            self.nan = true;
        }
        self = self.bytes(text.as_bytes());
        self.text = text;
        self
    }

    /// The key, or none when a setting was not a number.
    pub fn finish(self) -> Option<Key> {
        (!self.nan).then(|| Key(mix(self.a ^ self.b.rotate_left(32)), mix(self.b) ^ self.a))
    }
}

struct Entry {
    piece: Rc<dyn Any>,
    bytes: usize,
    used: u64,
}

/// The pieces, by key.
struct Store {
    map: HashMap<Key, Entry>,
    seen: HashSet<Key>,
    bytes: usize,
    clock: u64,
    ceiling: usize,
}

thread_local! {
    static STORE: RefCell<Store> = RefCell::new(Store {
        map: HashMap::new(),
        seen: HashSet::new(),
        bytes: 0,
        clock: 0,
        ceiling: KEPT_BYTES,
    });
}

/// The piece kept under `key`, if one of this type is.
pub fn get<T: 'static>(key: Key) -> Option<Rc<T>> {
    STORE.with(|s| {
        let s = &mut *s.borrow_mut();
        s.clock += 1;
        let e = s.map.get_mut(&key)?;
        e.used = s.clock;
        Rc::clone(&e.piece).downcast::<T>().ok()
    })
}

/// Keeps `piece`, which holds `bytes` bytes, under `key`, in place of any
/// there. Room is made by letting go of the pieces least lately asked for.
/// A piece of more than a quarter of the ceiling is not kept: it would push
/// out most of what a paint needs beside it.
pub fn put<T: 'static>(key: Key, piece: T, bytes: usize) {
    STORE.with(|s| {
        let s = &mut *s.borrow_mut();
        let bytes = bytes.saturating_add(ENTRY_COST);
        if let Some(old) = s.map.remove(&key) {
            s.bytes -= old.bytes;
        }
        if bytes > s.ceiling / 4 {
            return;
        }
        while s.bytes + bytes > s.ceiling {
            let Some(oldest) = s.map.iter().min_by_key(|(_, e)| e.used).map(|(k, _)| *k) else {
                break;
            };
            if let Some(old) = s.map.remove(&oldest) {
                s.bytes -= old.bytes;
            }
        }
        s.clock += 1;
        let used = s.clock;
        s.bytes += bytes;
        s.map.insert(
            key,
            Entry {
                piece: Rc::new(piece),
                bytes,
                used,
            },
        );
    });
}

/// Whether [`mark`] was given `key` before.
pub fn seen(key: Key) -> bool {
    STORE.with(|s| s.borrow().seen.contains(&key))
}

/// Remembers `key` as seen. Only the key is held, no piece.
pub fn mark(key: Key) {
    STORE.with(|s| {
        let s = &mut *s.borrow_mut();
        if s.seen.len() >= MAX_SEEN {
            s.seen.clear();
        }
        s.seen.insert(key);
    });
}

/// Lets go of every piece and every key seen.
pub fn clear() {
    STORE.with(|s| {
        let s = &mut *s.borrow_mut();
        s.map = HashMap::new();
        s.seen = HashSet::new();
        s.bytes = 0;
    });
}

/// The bytes the store holds now.
pub fn bytes() -> usize {
    STORE.with(|s| s.borrow().bytes)
}

/// Sets the most the store holds, letting go of everything first. For the
/// tests of a store that is too small for what a paint puts in it.
#[doc(hidden)]
pub fn set_ceiling(bytes: usize) {
    clear();
    STORE.with(|s| s.borrow_mut().ceiling = bytes);
}

/// A copy of `v` to keep, or none when the memory is not to be had (a `Vec`
/// grown past what the allocator gives aborts, which in wasm is a trap).
pub fn copy<T: Copy>(v: &[T]) -> Option<Vec<T>> {
    let mut out = Vec::new();
    out.try_reserve_exact(v.len()).ok()?;
    out.extend_from_slice(v);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(n: u64) -> Key {
        Hasher::new("test").u64(n).finish().unwrap()
    }

    #[test]
    fn a_key_is_its_inputs_in_their_order() {
        let of = |h: Hasher| h.finish().unwrap();
        assert_eq!(of(Hasher::new("a").u64(1).u64(2)), of(Hasher::new("a").u64(1).u64(2)));
        assert_ne!(of(Hasher::new("a").u64(1).u64(2)), of(Hasher::new("a").u64(2).u64(1)));
        assert_ne!(of(Hasher::new("a").u64(1)), of(Hasher::new("b").u64(1)));
        // The bytes' length is in the key: two runs are not one run joined.
        assert_ne!(
            of(Hasher::new("a").bytes(b"ab").bytes(b"c")),
            of(Hasher::new("a").bytes(b"a").bytes(b"bc"))
        );
        assert_ne!(of(Hasher::new("a").bytes(&[0; 3])), of(Hasher::new("a").bytes(&[0; 4])));
        // A float is told by its bits: minus zero is not zero.
        assert_ne!(of(Hasher::new("a").debug(&0.0f64)), of(Hasher::new("a").debug(&-0.0f64)));
        assert_ne!(of(Hasher::new("a").f64(0.0)), of(Hasher::new("a").f64(-0.0)));
        assert_ne!(
            of(Hasher::new("a").debug(&0.1f64)),
            of(Hasher::new("a").debug(&f64::from_bits(0.1f64.to_bits() + 1)))
        );
    }

    #[test]
    fn a_setting_that_is_no_number_has_no_key() {
        assert!(Hasher::new("a").debug(&(1.0f64, f64::NAN)).finish().is_none());
        assert!(Hasher::new("a").debug(&Some(f32::NAN)).finish().is_none());
        assert!(Hasher::new("a").maybe(None).finish().is_none());
        assert!(Hasher::new("a").debug(&(1.0f64, f64::INFINITY)).finish().is_some());
    }

    #[test]
    fn the_store_keeps_to_its_ceiling_and_lets_the_oldest_go() {
        set_ceiling(4 * (1000 + ENTRY_COST));
        for n in 0..4 {
            put(key(n), n, 1000);
        }
        assert_eq!(bytes(), 4 * (1000 + ENTRY_COST));
        // Asked for again, the first is the newest: the second goes.
        assert_eq!(get::<u64>(key(0)).as_deref(), Some(&0));
        put(key(4), 4u64, 1000);
        assert!(get::<u64>(key(1)).is_none());
        assert!(get::<u64>(key(0)).is_some() && get::<u64>(key(4)).is_some());
        assert_eq!(bytes(), 4 * (1000 + ENTRY_COST));
        // A piece of another type is not this one.
        assert!(get::<u32>(key(0)).is_none());
        // One too big for the store is not kept, and pushes nothing out.
        put(key(9), 9u64, 4000);
        assert!(get::<u64>(key(9)).is_none());
        assert!(get::<u64>(key(0)).is_some());
        // Put again, a piece takes the place of the one under its key.
        put(key(0), 7u64, 10);
        assert_eq!(get::<u64>(key(0)).as_deref(), Some(&7));
        clear();
        assert_eq!(bytes(), 0);
        assert!(get::<u64>(key(0)).is_none());
        set_ceiling(KEPT_BYTES);
    }

    #[test]
    fn a_key_seen_is_remembered() {
        assert!(!seen(key(77)));
        mark(key(77));
        assert!(seen(key(77)));
        clear();
        assert!(!seen(key(77)));
    }
}
