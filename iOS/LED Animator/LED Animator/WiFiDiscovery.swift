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

    /// The trailing "-XXXXXX" MAC suffix, matching the BLE advert's device id.
    var deviceID: String? {
        guard let dash = hostname.lastIndex(of: "-") else { return nil }
        let suffix = String(hostname[hostname.index(after: dash)...])
        guard suffix.count == 6, suffix.allSatisfy({ $0.isHexDigit }) else { return nil }
        return suffix.uppercased()
    }
}

@Observable
final class WiFiDiscovery {
    var devices: [DiscoveredWiFiDevice] = []

    @ObservationIgnored private let queue = DispatchQueue(label: "wifi-discovery")
    @ObservationIgnored private let port: UInt16 = 4550
    @ObservationIgnored private let probe = [UInt8]("LEDADISCOVER".utf8)
    @ObservationIgnored private var lastSeen: [String: Date] = [:]   // hostname -> when last heard

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
        var tv = timeval(tv_sec: 0, tv_usec: 250_000)   // recv timeout so the loop can re-probe / check the deadline
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        let targets = broadcastTargets()   // each interface's subnet broadcast + limited broadcast

        // Probe REPEATEDLY over ~2.5s: UDP is lossy (a single probe or reply
        // often drops), and iOS delivers subnet-directed broadcast far more
        // reliably than 255.255.255.255. Collect replies as they arrive.
        let deadline = Date().addingTimeInterval(2.5)
        var lastProbe = Date.distantPast
        var buf = [UInt8](repeating: 0, count: 256)
        while Date() < deadline {
            if Date().timeIntervalSince(lastProbe) > 0.4 {
                lastProbe = Date()
                for target in targets { sendProbe(fd, to: target) }
            }
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
            // n <= 0 → timeout (EAGAIN); loop to re-probe / keep listening.
        }
        DispatchQueue.main.async { [weak self] in self?.prune() }
    }

    /// Drop devices that haven't answered in a while (e.g. after "Forget
    /// network" or losing power), so a dead Wi-Fi entry doesn't linger with a
    /// stale IP. The window tolerates a couple of missed scans.
    private func prune(ttl: TimeInterval = 9) {
        let cutoff = Date().addingTimeInterval(-ttl)
        devices.removeAll { (lastSeen[$0.hostname] ?? .distantPast) < cutoff }
        lastSeen = lastSeen.filter { key, _ in devices.contains { $0.hostname == key } }
    }

    private func sendProbe(_ fd: Int32, to broadcast: in_addr_t) {
        var dst = sockaddr_in()
        dst.sin_family = sa_family_t(AF_INET)
        dst.sin_port = port.bigEndian
        dst.sin_addr.s_addr = broadcast
        _ = withUnsafePointer(to: &dst) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                sendto(fd, probe, probe.count, 0, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
    }

    /// The subnet-directed broadcast of each up, broadcast-capable IPv4
    /// interface (e.g. 192.168.68.255 for Wi-Fi), plus the limited broadcast.
    private func broadcastTargets() -> [in_addr_t] {
        var targets: [in_addr_t] = []
        var ifap: UnsafeMutablePointer<ifaddrs>?
        if getifaddrs(&ifap) == 0 {
            var ptr = ifap
            while let cur = ptr {
                let ifa = cur.pointee
                let flags = ifa.ifa_flags
                if (flags & UInt32(IFF_UP)) != 0,
                   (flags & UInt32(IFF_BROADCAST)) != 0,
                   (flags & UInt32(IFF_LOOPBACK)) == 0,
                   let addr = ifa.ifa_addr, addr.pointee.sa_family == sa_family_t(AF_INET),
                   let bcast = ifa.ifa_dstaddr {
                    let s = bcast.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr.s_addr }
                    if s != 0, !targets.contains(s) { targets.append(s) }
                }
                ptr = ifa.ifa_next
            }
            freeifaddrs(ifap)
        }
        targets.append(in_addr_t(0xffff_ffff))   // 255.255.255.255 fallback
        return targets
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
        lastSeen[device.hostname] = Date()
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
