/* RP2040 memory layout. The Pico W has 2 MB QSPI flash and 264 KB SRAM.
   The second-stage bootloader (boot2) lives in the first 256 bytes of flash;
   embassy-rp's link-rp.x fills BOOT2 with a default boot2 and computes its CRC. */
MEMORY {
    BOOT2 : ORIGIN = 0x10000000, LENGTH = 0x100
    FLASH : ORIGIN = 0x10000100, LENGTH = 2048K - 0x100
    RAM   : ORIGIN = 0x20000000, LENGTH = 264K
}
