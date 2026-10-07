package expo.modules.memprobe

import android.os.Debug
import android.view.WindowManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class MemProbeModule : Module() {
  private val logFile: File
    get() = File(appContext.reactContext!!.filesDir, "memlog.csv")

  // Same buckets as `dumpsys meminfo`: TOTAL PSS and Graphics (GL mtrack + EGL mtrack + gfx dev), in bytes.
  private fun summary(key: String): Double {
    val info = Debug.MemoryInfo()
    Debug.getMemoryInfo(info)
    return (info.getMemoryStat(key)?.toDoubleOrNull() ?: -1.0) * 1024.0
  }

  override fun definition() = ModuleDefinition {
    Name("MemProbe")
    // Long measurement runs must not be cut short by the screen timeout.
    OnActivityEntersForeground {
      appContext.currentActivity?.let { activity ->
        activity.runOnUiThread { activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
      }
    }
    Function("footprint") { summary("summary.total-pss") }
    Function("graphics") { summary("summary.graphics") }
    Function("appendLog") { line: String -> logFile.appendText(line + "\n") }
    Function("clearLog") { logFile.delete() }
  }
}
