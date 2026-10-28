package io.shielded.moth

import android.util.Log
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasScrollToNodeAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Creates a wallet on preprod, backs it up, unlocks it and checks its receive address.
 * Android port of mobile/ios/MothUITests/OnboardingTests.swift.
 *
 * Needs network access, an emulator with a screen lock and fingerprint 1 enrolled, and
 * scripts/ui-test.sh, which answers each [approve] with `adb emu finger touch 1`.
 *
 * Not ported, because the Android app does not have them yet: Settings and "Show recovery
 * phrase", and the Lock button (Android locks when the app leaves the foreground).
 */
@RunWith(AndroidJUnit4::class)
class OnboardingTests {
    @get:Rule
    val compose = createEmptyComposeRule()

    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    @Test
    fun createBackUpUnlockReceive() {
        var app = ActivityScenario.launch(MainActivity::class.java)

        waitFor(hasText("Create wallet"), 120_000, "welcome screen")
        compose.onNodeWithText("Create wallet").performClick()
        approve("Protect your new Moth wallet")

        // The phrase dialog stands in for iOS's backup screen; the wallet is already unlocking behind it.
        waitFor(hasText("I've written it down"), 60_000, "recovery phrase")
        compose.onNodeWithText("I've written it down").performClick()

        // Home is also shown while the engine starts, so only an enabled Receive proves the unlock.
        scrollTo(hasText("Receive") and isEnabled(), 120_000, "home screen after unlock")
        waitFor(hasText("UNSHIELDED BALANCES"), 5_000, "balances")

        // Registering DUST reaches the prover before anything else; an empty wallet then has
        // nothing to register, so this message proves the prover answered.
        scrollTo(hasText("Register NIGHT") and isEnabled(), 600_000, "synced")
        compose.onNodeWithText("Register NIGHT").performClick()
        approve("Approve DUST registration")
        waitFor(hasText("This account has no NIGHT to register."), 120_000, "prover reachable, nothing to register")
        compose.onNodeWithText("OK").performClick()

        scrollTo(hasText("Receive") and isEnabled(), 10_000, "receive button")
        compose.onNodeWithText("Receive").performClick()
        waitFor(textStartsWith("mn_addr_preprod1"), 10_000, "unshielded receive address")
        compose.onNodeWithContentDescription("Back").performClick()

        // Leaving the foreground locks the wallet; coming back asks for the fingerprint by itself.
        app.moveToState(Lifecycle.State.CREATED)
        app.moveToState(Lifecycle.State.RESUMED)
        expectLockedThenUnlock()

        // The wallet is stored in the engine's IndexedDB, which must survive a relaunch. The test
        // shares the app's process, so this is a new activity and engine page, not a cold start.
        app.close()
        app = ActivityScenario.launch(MainActivity::class.java)
        expectLockedThenUnlock()
        app.close()
    }

    private fun expectLockedThenUnlock() {
        waitFor(hasText("Moth is locked"), 120_000, "locked screen")
        approve("Unlock your Moth wallet")
        scrollTo(hasText("Receive") and isEnabled(), 120_000, "existing wallet unlocked")
    }

    /** Waits for the system fingerprint prompt titled [title] and has the runner touch the sensor until it closes. */
    private fun approve(title: String) {
        Log.i("MothUITest", "waiting for: fingerprint prompt \"$title\"")
        check(device.wait(Until.hasObject(By.text(title)), 60_000)) { "no fingerprint prompt \"$title\"" }
        val end = System.currentTimeMillis() + 60_000
        while (device.hasObject(By.text(title))) {
            check(System.currentTimeMillis() < end) {
                "prompt \"$title\" still open: is fingerprint 1 enrolled, and is scripts/ui-test.sh answering?"
            }
            // scripts/ui-test.sh watches for this line.
            Log.i("MothUITest", "fingerprint")
            Thread.sleep(2_000)
        }
    }

    private fun waitFor(matcher: SemanticsMatcher, timeoutMs: Long, what: String) {
        Log.i("MothUITest", "waiting for: $what")
        compose.waitUntil(what, timeoutMs) { compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
    }

    /** As [waitFor], for items of Home's lazy list, which exist only once scrolled into view. */
    private fun scrollTo(matcher: SemanticsMatcher, timeoutMs: Long, what: String) {
        Log.i("MothUITest", "waiting for: $what")
        compose.waitUntil(what, timeoutMs) {
            runCatching { compose.onNode(hasScrollToNodeAction()).performScrollToNode(matcher) }.isSuccess
        }
    }

    private fun textStartsWith(prefix: String) = SemanticsMatcher("text starts with $prefix") { node ->
        node.config.getOrElse(SemanticsProperties.Text) { emptyList() }.any { it.text.startsWith(prefix) }
    }
}
