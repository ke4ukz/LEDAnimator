//! USB device — the dev-tooling channel (docs/PORT.md → Phase C).
//!
//! Two things on one USB device:
//!  1. A **picotool reset interface** (vendor class `0xFF`/`0x00`/`0x01`). picotool
//!     sends a class request to this interface; `bRequest 0x01` = reset into the
//!     ROM USB bootloader. This is what makes `picotool reboot -f -u` drop the
//!     running firmware to BOOTSEL — **no physical button** for reflashing.
//!  2. A **CDC-ACM serial logger** (`embassy-usb-logger`) — the observability this
//!     firmware has never had. `log::info!` etc. appear on `/dev/cu.usbmodem*`.
//!
//! Matches the MicroPython firmware's BOOTSEL capability (protocol.md → Maintenance)
//! but for CLI dev iteration; the over-the-air BOOTSEL *command* is a later phase.

use embassy_rp::peripherals::USB;
use embassy_rp::rom_data;
use embassy_rp::usb::Driver;
use embassy_usb::class::cdc_acm::{CdcAcmClass, State};
use embassy_usb::control::{OutResponse, Recipient, Request, RequestType};
use embassy_usb::types::InterfaceNumber;
use embassy_usb::{Builder, Config, Handler};
use static_cell::StaticCell;

// pico-sdk reset-interface identifiers (RP2040 datasheet / pico-sdk `usb_reset_interface`).
const RESET_IFACE_CLASS: u8 = 0xFF;
const RESET_IFACE_SUBCLASS: u8 = 0x00;
const RESET_IFACE_PROTOCOL: u8 = 0x01;
const RESET_REQUEST_BOOTSEL: u8 = 0x01;

/// Catches the picotool reset request on our vendor interface and jumps to the
/// ROM bootloader. Registered on the builder so it sees all control requests.
struct ResetHandler {
    iface: InterfaceNumber,
}

impl Handler for ResetHandler {
    fn control_out(&mut self, req: Request, _data: &[u8]) -> Option<OutResponse> {
        if req.request_type == RequestType::Class
            && req.recipient == Recipient::Interface
            && req.index == self.iface.0 as u16
            && req.request == RESET_REQUEST_BOOTSEL
        {
            // gpio_activity_pin_mask=0, disable_interface_mask=0 → both MSD +
            // PICOBOOT available. Does not return (the chip resets).
            rom_data::reset_to_usb_boot(0, 0);
        }
        None // not our request — let other handlers see it
    }
}

/// Build the USB device (reset interface + CDC logger) and run it forever.
#[embassy_executor::task]
pub async fn usb_task(driver: Driver<'static, USB>) {
    let mut config = Config::new(0x2e8a, 0x000a); // Raspberry Pi VID + pico-sdk stdio PID
    config.manufacturer = Some("LED Animator");
    config.product = Some("LED Animator");
    config.serial_number = Some("LEDA-0001");
    config.max_power = 100;
    config.max_packet_size_0 = 64;

    static CONFIG_DESC: StaticCell<[u8; 256]> = StaticCell::new();
    static BOS_DESC: StaticCell<[u8; 256]> = StaticCell::new();
    static MSOS_DESC: StaticCell<[u8; 128]> = StaticCell::new();
    static CONTROL_BUF: StaticCell<[u8; 128]> = StaticCell::new();
    static CDC_STATE: StaticCell<State<'static>> = StaticCell::new();
    static RESET_HANDLER: StaticCell<ResetHandler> = StaticCell::new();

    let mut builder = Builder::new(
        driver,
        config,
        CONFIG_DESC.init([0; 256]),
        BOS_DESC.init([0; 256]),
        MSOS_DESC.init([0; 128]),
        CONTROL_BUF.init([0; 128]),
    );

    // 1. picotool reset interface — one interface, one alt setting, no endpoints.
    let reset_iface = {
        let mut func = builder.function(RESET_IFACE_CLASS, RESET_IFACE_SUBCLASS, RESET_IFACE_PROTOCOL);
        let mut iface = func.interface();
        let num = iface.interface_number();
        iface.alt_setting(RESET_IFACE_CLASS, RESET_IFACE_SUBCLASS, RESET_IFACE_PROTOCOL, None);
        num
    };
    builder.handler(RESET_HANDLER.init(ResetHandler { iface: reset_iface }));

    // 2. CDC-ACM serial logger.
    let class = CdcAcmClass::new(&mut builder, CDC_STATE.init(State::new()), 64);

    let mut usb = builder.build();
    let usb_fut = usb.run();
    let log_fut = embassy_usb_logger::with_class!(1024, log::LevelFilter::Info, class);

    // Both run forever; join never completes.
    embassy_futures::join::join(usb_fut, log_fut).await;
}
