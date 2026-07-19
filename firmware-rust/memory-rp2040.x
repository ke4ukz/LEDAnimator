/* RP2040 memory layout (Pico W). 2 MB QSPI flash, 264 KB SRAM. The second-stage
   bootloader (boot2) lives in the first 256 bytes of flash; embassy-rp's
   link-rp.x (added for this target in .cargo/config.toml) fills BOOT2 with a
   default boot2 and computes its CRC.

   The on-flash littlefs region (4096 × 212 blocks at 0x1012c000, ending at the
   2 MB boundary — see src/fs.rs) sits past the program image, untouched here. */
MEMORY {
    BOOT2 : ORIGIN = 0x10000000, LENGTH = 0x100
    FLASH : ORIGIN = 0x10000100, LENGTH = 2048K - 0x100
    RAM   : ORIGIN = 0x20000000, LENGTH = 264K
}
