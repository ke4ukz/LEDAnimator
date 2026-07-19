/* RP2350 memory layout (Pico 2 W). Unlike the RP2040 (which carved a 256-byte
   BOOT2 CRC block at the start of flash), the RP2350 bootrom scans flash for an
   IMAGE_DEF in a `.start_block` — embassy-rp emits it automatically under the
   `rp235xa` feature, and the SECTIONS below place it in the first 4 KB.

   FLASH is kept at 2 MB (the Pico 2 W has 4 MB) so the existing on-flash
   littlefs region — 4096 × 212 blocks at 0x1012c000, ending exactly at the 2 MB
   boundary (see src/fs.rs, FLASH_SIZE) — stays put. The upper 2 MB is currently
   unused; reclaiming it means moving/enlarging that region deliberately. */
MEMORY {
    FLASH : ORIGIN = 0x10000000, LENGTH = 2048K
    /* RP2350 SRAM: 8 striped banks (SRAM0-7) = 512K, plus two 4K direct-mapped
       banks (SRAM8/9) left free here. */
    RAM   : ORIGIN = 0x20000000, LENGTH = 512K
    SRAM8 : ORIGIN = 0x20080000, LENGTH = 4K
    SRAM9 : ORIGIN = 0x20081000, LENGTH = 4K
}

SECTIONS {
    /* Boot ROM info — goes after .vector_table so it stays in the first 4K of
       flash where the boot ROM and picotool look for it. */
    .start_block : ALIGN(4)
    {
        __start_block_addr = .;
        KEEP(*(.start_block));
        KEEP(*(.boot_info));
    } > FLASH
} INSERT AFTER .vector_table;

/* move .text to start /after/ the boot info */
_stext = ADDR(.start_block) + SIZEOF(.start_block);

SECTIONS {
    /* Picotool 'Binary Info' entries. */
    .bi_entries : ALIGN(4)
    {
        __bi_entries_start = .;
        KEEP(*(.bi_entries));
        . = ALIGN(4);
        __bi_entries_end = .;
    } > FLASH
} INSERT AFTER .text;

SECTIONS {
    /* Boot ROM extra info — goes after everything, so it can hold a signature. */
    .end_block : ALIGN(4)
    {
        __end_block_addr = .;
        KEEP(*(.end_block));
    } > FLASH
} INSERT AFTER .uninit;

PROVIDE(start_to_end = __end_block_addr - __start_block_addr);
PROVIDE(end_to_start = __start_block_addr - __end_block_addr);
