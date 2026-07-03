//
//  WiFiDiscovery.swift
//  LED Animator
//
//  Finds LED Animator devices on the LAN without mDNS: broadcast "LEDADISCOVER"
//  as a UDP datagram to CONTROL_PORT and collect the "LEDA <hostname> <name>"
//  replies, pairing each with its source IP. Uses a POSIX socket because
//  NWConnection only receives from the one endpoint it's connected to, whereas
//  replies arrive from many device IPs.
//

import Darwin
import Foundation
import Observation

struct DiscoveredWiFiDevice: Identifiable, Equatable {
    var host: String       // source IP of the reply
    var hostname: String   // e.g. "LED-Animator-0901CD"
    var name: String       // friendly device name
    var id: String { hostname }
    var displayName: String { name.isEmpty ? hostname : name }
}

@Observable
final class WiFiDiscovery {
    var devices: [DiscoveredWiFiDevice] = []

    @ObservationIgnored private let queue = DispatchQueue(label: "wifi-discovery")
    @ObservationIgnored private let port: UInt16 = 4550

    /// One-shot: broadcast a probe and collect replies for ~2s. Existing entries
    /// are kept and refreshed (a device only answers when probed).
    func scan() {
        queue.async { [weak self] in self?.runScan() }
    }

    private func runScan() {
        let fd = socket(AF_INET, SOCK_DGRAM, 0)
        guard fd >= 0 else { return }
        defer { close(fd) }

        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &yes, socklen_t(MemoryLayout<Int32>.size))
        var tv = timeval(tv_sec: 0, tv_usec: 300_000)   // recv timeout so the loop can check the deadline
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        // Broadcast the probe to 255.255.255.255:port.
        var dst = sockaddr_in()
        dst.sin_family = sa_family_t(AF_INET)
        dst.sin_port = port.bigEndian
        dst.sin_addr.s_addr = in_addr_t(0xffff_ffff)   // INADDR_BROADCAST
        let probe = [UInt8]("LEDADISCOVER".utf8)
        _ = withUnsafePointer(to: &dst) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                sendto(fd, probe, probe.count, 0, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }

        // Collect replies for ~2s.
        let deadline = Date().addingTimeInterval(2.0)
        var buf = [UInt8](repeating: 0, count: 256)
        while Date() < deadline {
            var from = sockaddr_in()
            var fromLen = socklen_t(MemoryLayout<sockaddr_in>.size)
            let n = withUnsafeMutablePointer(to: &from) { p in
                p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                    recvfrom(fd, &buf, buf.count, 0, sa, &fromLen)
                }
            }
            if n > 0, let text = String(bytes: buf[0..<n], encoding: .utf8) {
                handleReply(text.trimmingCharacters(in: .whitespacesAndNewlines), from: from)
            }
            // n <= 0 → timeout (EAGAIN); loop until the deadline.
        }
    }

    private func handleReply(_ line: String, from addr: sockaddr_in) {
        guard line.hasPrefix("LEDA ") else { return }
        let rest = line.dropFirst("LEDA ".count)
        let hostname: String
        let name: String
        if let sp = rest.firstIndex(of: " ") {
            hostname = String(rest[..<sp])
            name = String(rest[rest.index(after: sp)...])
        } else {
            hostname = String(rest)
            name = ""
        }
        guard !hostname.isEmpty else { return }
        let device = DiscoveredWiFiDevice(host: ipString(addr), hostname: hostname, name: name)
        DispatchQueue.main.async { [weak self] in self?.add(device) }
    }

    private func add(_ device: DiscoveredWiFiDevice) {
        if let i = devices.firstIndex(where: { $0.hostname == device.hostname }) {
            devices[i] = device
        } else {
            devices.append(device)
        }
    }

    private func ipString(_ addr: sockaddr_in) -> String {
        var a = addr
        var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
        inet_ntop(AF_INET, &a.sin_addr, &buf, socklen_t(INET_ADDRSTRLEN))
        return String(cString: buf)
    }
}
