package io.shielded.moth

import android.app.Activity
import android.content.Intent
import android.content.SharedPreferences
import android.graphics.Typeface
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.io.File
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Minimal host for moth's engine: one wallet ("main") on preprod; create, unlock, sync and
 * balances, with the engine's events logged on screen.
 *
 * SPIKE ONLY: the keystore passphrase is kept in SharedPreferences. The iOS app keeps it in
 * the Keychain behind Face ID; the Android equivalent (Keystore + BiometricPrompt) is next.
 */
class MainActivity : Activity() {
    private val walletName = "main"
    private val network = "preprod"
    private lateinit var prefs: SharedPreferences
    private lateinit var log: TextView
    private lateinit var scroll: ScrollView
    private lateinit var engine: Engine
    private val clock = SimpleDateFormat("HH:mm:ss", Locale.UK)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences("moth-spike", MODE_PRIVATE)

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 48, 24, 24) }
        val buttons = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        log = TextView(this).apply { typeface = Typeface.MONOSPACE; textSize = 11f; setTextIsSelectable(true) }
        scroll = ScrollView(this).apply { addView(log) }
        root.addView(buttons)
        root.addView(scroll, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        setContentView(root)

        val engineDir = Bundled.extract(this, "engine")
        val params = File(filesDir, "zk-params").apply { mkdirs() }
        val proverPort = Native.proverStart(params.path, 6300, 2)
        val enginePort = Native.staticStart(engineDir.path, 8765)
        append("prover on 127.0.0.1:$proverPort, engine page on 127.0.0.1:$enginePort")

        engine = Engine(this) { event, data -> onEngineEvent(event, data) }
        // Attached but invisible, so the WebView is never paused as off-screen.
        root.addView(engine.webView, LinearLayout.LayoutParams(1, 1))

        fun button(label: String, onClick: () -> Unit) {
            buttons.addView(Button(this).apply { text = label; setOnClickListener { onClick() } })
        }
        button("Create") { create() }
        button("Unlock") { unlock() }
        button("Sync") { sync() }
        button("Balances") { balances() }
        handle(intent)
    }

    // Lets adb drive the spike: adb shell am start -n io.shielded.moth/.MainActivity --es action create
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent?) {
        when (intent?.getStringExtra("action")) {
            "create" -> create()
            "unlock" -> unlock()
            "sync" -> sync()
            "balances" -> balances()
            null -> {}
            else -> append("unknown action")
        }
    }

    private fun onEngineEvent(event: String, data: Any?) {
        when (event) {
            "ready" -> {
                append("engine ready")
                engine.call("list") { r -> r.onSuccess { append("wallets: $it") }.onFailure { append("list failed: ${it.message}") } }
            }
            "balances" -> append("balances: ${summary(data as JSONObject)}")
            "syncMessage" -> append("sync: $data")
            "workerError" -> append("WORKER ERROR: $data")
            else -> append("$event: $data")
        }
    }

    private fun summary(b: JSONObject): String =
        "synced=${b.optBoolean("synced")} unshielded=${b.optJSONObject("unshielded")} shielded=${b.optJSONObject("shielded")} dust=${b.optString("dust")}"

    private fun passphrase(): String =
        prefs.getString("passphrase", null) ?: ByteArray(32).also { SecureRandom().nextBytes(it) }
            .joinToString("") { "%02x".format(it) }
            .also { prefs.edit().putString("passphrase", it).apply() }

    private fun create() {
        append("creating wallet \"$walletName\" on $network…")
        engine.call("create", listOf(walletName, passphrase(), network)) { r ->
            r.onSuccess { append("created: $it\nBACK UP THE PHRASE ABOVE (testnet only).") }.onFailure { append("create failed: ${it.message}") }
        }
    }

    private fun unlock() {
        engine.call("unlock", listOf(walletName, passphrase(), network)) { r ->
            r.onSuccess { append("unlocked: $it") }.onFailure { append("unlock failed: ${it.message}") }
        }
    }

    private fun sync() {
        append("sync requested")
        engine.call("sync", listOf(walletName, network)) { r ->
            r.onSuccess { append("sync started") }.onFailure { append("sync failed: ${it.message}") }
        }
    }

    private fun balances() {
        engine.call("balances", listOf(walletName, network)) { r ->
            r.onSuccess { append("balances: ${summary(it as JSONObject)}") }.onFailure { append("balances failed: ${it.message}") }
        }
    }

    private fun append(line: String) {
        Log.i("MothSpike", line)
        log.append("${clock.format(Date())} $line\n")
        scroll.post { scroll.fullScroll(ScrollView.FOCUS_DOWN) }
    }
}
