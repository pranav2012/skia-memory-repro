import ExpoModulesCore
import Foundation
import UIKit

public class MemProbeModule: Module {
  private let logURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("memlog.csv")

  public func definition() -> ModuleDefinition {
    Name("MemProbe")

    // Long measurement runs must not be cut short by auto-lock.
    OnCreate {
      DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = true }
    }

    // Physical footprint in bytes (what jetsam counts; includes Metal/IOAccelerator memory).
    Function("footprint") { () -> Double in
      var info = task_vm_info_data_t()
      var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
      let kr = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
          task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
        }
      }
      return kr == KERN_SUCCESS ? Double(info.phys_footprint) : -1
    }

    Function("graphics") { () -> Double in
      return -1
    }

    Function("appendLog") { (line: String) in
      let data = (line + "\n").data(using: .utf8)!
      if let handle = try? FileHandle(forWritingTo: self.logURL) {
        handle.seekToEndOfFile()
        handle.write(data)
        try? handle.close()
      } else {
        try? data.write(to: self.logURL)
      }
    }

    Function("clearLog") {
      try? FileManager.default.removeItem(at: self.logURL)
    }
  }
}
