//! littlefs on the QSPI flash — the config + patterns live in the **same on-flash
//! filesystem the web UF2 builds** (see `web/src/export/littlefs.ts` /
//! `combinedUf2.ts`): block 4096 × 212 blocks at `0x1012c000`, `prog_size` 256.
//! Matching that geometry (esp. `prog_size`, which sets metadata alignment) is
//! what lets existing bundles mount as-is. See docs/PORT.md §1.
//!
//! Reads are plain **XIP memory-mapped** loads (the fs is mapped at 0x1012c000);
//! writes/erase go through the embassy `Flash` peripheral (runs from RAM).

use embassy_rp::flash::{Blocking, Flash};
use embassy_rp::peripherals::FLASH;
use littlefs2::consts::{U16, U256};
use littlefs2::driver::Storage;
use littlefs2::io::{Error as LfsError, Result as LfsResult};

const FLASH_SIZE: usize = 2 * 1024 * 1024;
/// Byte offset of the fs region within flash (fsBase 0x1012c000 − XIP 0x10000000).
const FS_OFFSET: u32 = 0x12_c000;

pub const FS_BLOCK_SIZE: usize = 4096;
pub const FS_BLOCK_COUNT: usize = 212;

/// littlefs block device backed by the RP2040 QSPI flash.
pub struct FlashStorage {
    flash: Flash<'static, FLASH, Blocking, FLASH_SIZE>,
}

impl FlashStorage {
    pub fn new(flash: Flash<'static, FLASH, Blocking, FLASH_SIZE>) -> Self {
        Self { flash }
    }
}

impl Storage for FlashStorage {
    const READ_SIZE: usize = 256;
    const WRITE_SIZE: usize = 256; // = prog_size the web format was built with
    const BLOCK_SIZE: usize = FS_BLOCK_SIZE;
    const BLOCK_COUNT: usize = FS_BLOCK_COUNT;
    type CACHE_SIZE = U256;
    type LOOKAHEAD_SIZE = U16;

    fn read(&mut self, off: usize, buf: &mut [u8]) -> LfsResult<usize> {
        // Use embassy's flash read (proven correct) rather than a raw XIP pointer.
        self.flash
            .blocking_read(FS_OFFSET + off as u32, buf)
            .map_err(|_| LfsError::IO)?;
        Ok(buf.len())
    }

    fn write(&mut self, off: usize, data: &[u8]) -> LfsResult<usize> {
        self.flash
            .blocking_write(FS_OFFSET + off as u32, data)
            .map_err(|_| LfsError::IO)?;
        Ok(data.len())
    }

    fn erase(&mut self, off: usize, len: usize) -> LfsResult<usize> {
        let start = FS_OFFSET + off as u32;
        self.flash
            .blocking_erase(start, start + len as u32)
            .map_err(|_| LfsError::IO)?;
        Ok(len)
    }
}

/// The mounted filesystem over the flash `FlashStorage`.
pub type Fs<'a> = littlefs2::fs::Filesystem<'a, FlashStorage>;

/// The shared, `'static` filesystem behind an async mutex — so the player,
/// recovery, and the control-command dispatch (BLE + Wi-Fi tasks) all serialize
/// their flash access. littlefs ops are blocking (they never yield mid-op), so the
/// mutex is held only briefly; it also supplies the `Sync` the shared `&'static`
/// needs. Built once in `main` after a successful mount.
pub type SharedFs = embassy_sync::mutex::Mutex<
    embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex,
    Fs<'static>,
>;

/// Build a nul-terminated littlefs `Path` from a runtime filename into `buf`
/// (for the dynamically-named selected pattern; known config names use `path!`).
pub fn make_path<'a>(name: &str, buf: &'a mut [u8; 64]) -> Option<&'a littlefs2::path::Path> {
    let n = name.len();
    if n + 1 > buf.len() {
        return None;
    }
    buf[..n].copy_from_slice(name.as_bytes());
    buf[n] = 0;
    littlefs2::path::Path::from_bytes_with_nul(&buf[..n + 1]).ok()
}
