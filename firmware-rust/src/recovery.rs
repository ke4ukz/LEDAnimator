//! Power-cycle recovery ritual — the forgotten-PIN / factory-reset escape hatch
//! (docs/config-and-auth-plan.md §3). A physical act, so it works regardless of
//! auth: a PIN is never a permanent lockout.
//!
//! Model: **interrupt boot to climb, let it reach the run loop to commit.**
//! `bootcount.txt` is bumped very early (before the radio, so it sticks even if
//! radio init hangs); the moment the device reaches its player loop the count
//! commits back to 0. So each power-cut *before* the device starts playing adds
//! one; letting it play once zeroes it.
//!
//! | count | action | strip flash |
//! |---|---|---|
//! | 5th short boot | clear the PIN (`auth.txt`) | cyan |
//! | 10th short boot | full reset: clear PIN + Wi-Fi (`networks.txt`) + de-group (`standalone.txt`) | magenta |
//!
//! Counts 2..=4 and 6..=9 light that many dim-white pixels ("it registered, you're
//! at N"); count 1 stays silent (a normal power-on looks like nothing happened).

use crate::fs::Fs;
use crate::status::Recovery;
use littlefs2::path::Path;

const BOOTCOUNT: &[u8] = b"bootcount.txt\0";
const AUTH: &[u8] = b"auth.txt\0";
const NETWORKS: &[u8] = b"networks.txt\0";
const STANDALONE: &[u8] = b"standalone.txt\0";

const PIN_CLEAR_AT: u8 = 5;
const FACTORY_AT: u8 = 10;

fn p(nul: &[u8]) -> &Path {
    Path::from_bytes_with_nul(nul).unwrap()
}

/// What boot feedback to render for this boot (rendered by the caller, which owns
/// the strip). Rendered *before* radio bring-up so a rapid cycler sees it fast.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Normal boot (count 0/1) — nothing to show.
    None,
    /// Climbing — light `n` dim-white pixels.
    Climb(u8),
    /// 5th short boot — PIN cleared (cyan whole-strip flash).
    PinCleared,
    /// 10th short boot — full reset (magenta whole-strip flash).
    FactoryReset,
}

fn read_count(fs: &Fs) -> u8 {
    fs.read::<8>(p(BOOTCOUNT))
        .ok()
        .and_then(|v| core::str::from_utf8(&v).ok().and_then(|s| s.trim().parse().ok()))
        .unwrap_or(0)
}

fn write_count(fs: &Fs, n: u8) {
    let mut tmp = [0u8; 3];
    let mut buf = [0u8; 3];
    let len = if n == 0 {
        buf[0] = b'0';
        1
    } else {
        let mut i = 0;
        let mut v = n;
        while v > 0 {
            tmp[i] = b'0' + v % 10;
            v /= 10;
            i += 1;
        }
        for j in 0..i {
            buf[j] = tmp[i - 1 - j];
        }
        i
    };
    let _ = fs.write(p(BOOTCOUNT), &buf[..len]);
}

/// Bump the boot counter and, on a threshold boot, perform the recovery action
/// (delete the relevant config files). Returns what the caller should flash.
/// Call this once, early in boot, right after the filesystem mounts.
pub fn bump_and_act(fs: &Fs) -> Action {
    let n = read_count(fs).saturating_add(1);
    write_count(fs, n);
    log::info!("boot count {} (interrupt boots to climb; 5=PIN clear, 10=factory)", n);
    match n {
        1 => Action::None,
        PIN_CLEAR_AT => {
            let _ = fs.remove(p(AUTH));
            Action::PinCleared
        }
        FACTORY_AT => {
            let _ = fs.remove(p(AUTH));
            let _ = fs.remove(p(NETWORKS));
            // De-group override respected once sync/role lands (like syncflags.txt).
            let _ = fs.write(p(STANDALONE), b"1");
            Action::FactoryReset
        }
        _ => Action::Climb(n),
    }
}

/// The boot completed — the device reached its run loop. Commit the counter back
/// to 0 (COMMIT_MS = 0: no settle window, so "let it start once" clears it exactly
/// when it visibly starts playing). Call at the top of the player loop.
pub fn commit(fs: &Fs) {
    let _ = fs.remove(p(BOOTCOUNT));
}

impl Action {
    /// The `Recovery` flash kind for a threshold action, if any.
    pub fn recovery(self) -> Option<Recovery> {
        match self {
            Action::PinCleared => Some(Recovery::PinCleared),
            Action::FactoryReset => Some(Recovery::FactoryReset),
            _ => None,
        }
    }
}
