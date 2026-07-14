//
//  TCPController.swift
//  LED Animator
//
//  Wi-Fi DeviceTransport: the same newline-framed text protocol as BLE, over a
//  raw TCP socket (NWConnection) to a device on CONTROL_PORT. Drives a
//  DeviceSession exactly like BLEController does over Bluetooth.
//

import Foundation
import Network
import Observation

/// Wi-Fi/TCP transport: runs the same text protocol as `BLEController` over an
/// `NWConnection`, and adds a TCP-only file upload path (see `upload`).
@Observable
final class TCPController: DeviceTransport {
    var connectionState: ConnectionState = .disconnected
    var session: DeviceSession?
    // Upload (TCP-only) state, observed by the UI.
    /// True while a pattern-file upload is mid-flight.
    var uploadInProgress = false
    /// User-facing message when an upload is rejected or fails; nil otherwise.
    var uploadError: String?

    /// The device's control port (matches the firmware's CONTROL_PORT).
    @ObservationIgnored private let port: NWEndpoint.Port = 4550
    @ObservationIgnored private var connection: NWConnection?
    /// Accumulates received bytes until a full newline-framed line is available.
    @ObservationIgnored private var buffer = Data()
    @ObservationIgnored private var pendingUpload: Data?   // bytes to stream once the device says OK UPLOAD

    /// Open a control connection to a device at `host` (an IP or hostname).
    func connect(host: String, name: String? = nil) {
        disconnect()
        let target = host.trimmingCharacters(in: .whitespaces)
        guard !target.isEmpty else { return }
        connectionState = .connecting
        buffer = Data()
        let conn = NWConnection(host: NWEndpoint.Host(target), port: port, using: .tcp)
        connection = conn
        conn.stateUpdateHandler = { [weak self] state in
            self?.handleState(state, name: name ?? target)
        }
        conn.start(queue: .main)   // handlers run on main, so @Observable updates are safe
        receive(on: conn)
    }

    /// Cancel the socket and reset connection state.
    func disconnect() {
        stopKeepalive()
        connection?.cancel()
        connection = nil
        session = nil
        if connectionState != .disconnected { connectionState = .disconnected }
    }

    /// Dismiss a `.failed` state after the user acknowledges the error.
    func clearFailure() {
        if case .failed = connectionState { connectionState = .disconnected }
    }

    // MARK: DeviceTransport

    /// Send one command, newline-framed. `expectResponse` is irrelevant over
    /// TCP (no per-write ack semantics), so it's ignored.
    func send(_ line: String, expectResponse: Bool) {
        guard let data = (line + "\n").data(using: .utf8) else { return }
        connection?.send(content: data, completion: .contentProcessed { _ in })
    }

    // MARK: Connection lifecycle

    /// React to `NWConnection` state changes, mapping them onto
    /// `connectionState` and starting a session once `.ready`.
    private func handleState(_ state: NWConnection.State, name: String) {
        switch state {
        case .ready:
            let session = DeviceSession(name: name)
            session.transport = self
            self.session = session
            connectionState = .connected
            session.start()
            startKeepalive()
        case .failed(let error):
            session = nil
            stopKeepalive()
            // A drop *after* we were connected (idle timeout, Wi-Fi blip, device
            // reset) is a transient disconnect, not an initial connect failure — so
            // disconnect quietly instead of raising the "Couldn't Connect" alert.
            if connectionState == .connected {
                connectionState = .disconnected
            } else {
                connectionState = .failed(error.localizedDescription)
            }
        case .waiting:
            // Transient (no route yet) or waiting on the Local Network prompt —
            // stay "connecting" rather than failing, so a granted permission can
            // still proceed to .ready.
            break
        case .cancelled:
            session = nil
            stopKeepalive()
            if connectionState == .connected || connectionState == .connecting {
                connectionState = .disconnected
            }
        default:
            break
        }
    }

    // MARK: Keepalive
    //
    // The device times out an idle TCP control socket (~60 s) and resets it, which
    // would otherwise surface as a "Couldn't Connect" alert while just sitting on
    // the Control tab. A light periodic PING keeps the socket warm.
    @ObservationIgnored private var keepaliveGen = 0

    private func startKeepalive() {
        keepaliveGen += 1
        scheduleKeepalive(keepaliveGen)
    }

    private func stopKeepalive() {
        keepaliveGen += 1 // invalidates any pending tick
    }

    private func scheduleKeepalive(_ gen: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 25) { [weak self] in
            guard let self, self.keepaliveGen == gen, self.connectionState == .connected
            else { return }
            self.send("PING", expectResponse: false)
            self.scheduleKeepalive(gen)
        }
    }

    /// Read one chunk and re-arm; on error or clean close, tear the session
    /// down. Self-reschedules to keep a continuous read loop going.
    private func receive(on conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty { self.ingest(data) }
            if error == nil && !isComplete {
                self.receive(on: conn)   // keep reading
            } else {
                self.session = nil
                self.stopKeepalive()
                if self.connectionState == .connected { self.connectionState = .disconnected }
            }
        }
    }

    /// TCP is a byte stream, so buffer and split on newline (like the firmware).
    private func ingest(_ data: Data) {
        buffer.append(data)
        while let nl = buffer.firstIndex(of: 0x0A) {   // '\n'
            let lineData = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            if let text = String(data: lineData, encoding: .utf8) {
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty { continue }
                if uploadInProgress && handleUploadReply(trimmed) { continue }
                session?.handleReply(trimmed)
            }
        }
    }

    // MARK: Upload (TCP only)

    /// Stream a pattern file to the device: send UPLOAD, then (on "OK UPLOAD")
    /// the raw bytes; the device replies "OK UPLOADED <name>". The pattern list
    /// then updates via the device's broadcast, so no manual refresh is needed.
    func upload(name: String, data: Data) {
        guard connection != nil, !uploadInProgress, !data.isEmpty else { return }
        uploadError = nil
        uploadInProgress = true
        pendingUpload = data
        send("UPLOAD \(data.count) \(name)", expectResponse: false)
    }

    /// Consumes upload-protocol replies (returns true if handled).
    private func handleUploadReply(_ line: String) -> Bool {
        if line == "OK UPLOAD" {
            streamPendingUpload()
            return true
        }
        if line.hasPrefix("OK UPLOADED ") {
            uploadInProgress = false
            pendingUpload = nil
            return true
        }
        if line.hasPrefix("ERR") {
            uploadInProgress = false
            pendingUpload = nil
            uploadError = "Upload rejected (\(line))."
            return true
        }
        return false
    }

    /// Send the buffered file bytes after the device grants "OK UPLOAD". Only a
    /// send *error* is terminal here; success just means we wait for the device
    /// to confirm with "OK UPLOADED".
    private func streamPendingUpload() {
        guard let data = pendingUpload, let conn = connection else {
            uploadInProgress = false
            return
        }
        pendingUpload = nil
        conn.send(content: data, completion: .contentProcessed { [weak self] error in
            guard let self, error != nil else { return }   // else: await OK UPLOADED
            self.uploadInProgress = false
            self.uploadError = "Couldn't send the file."
        })
    }
}
