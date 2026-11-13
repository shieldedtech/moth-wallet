package io.shielded.moth

import android.util.Log
import org.junit.rules.TestWatcher
import org.junit.runner.Description

/**
 * When a test fails, logs "screenshot <test>" and keeps the screen as it is for a few seconds,
 * so scripts/ui-test.sh can capture it: the runner closes the app as soon as the test ends.
 * Make it the innermost rule, so it runs before any other rule tears the screen down.
 */
class HoldScreenOnFailure : TestWatcher() {
    override fun failed(e: Throwable?, description: Description) {
        Log.i("MothUITest", "screenshot ${description.methodName}")
        Thread.sleep(3_000)
    }
}
