package io.shielded.moth

import android.content.Context
import android.util.Log
import androidx.fragment.app.FragmentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

data class Addresses(val unshielded: String, val shielded: String, val dust: String, val nightTokenId: String)

/**
 * The app's state, driven by the engine. A cut-down port of iOS `WalletModel`: one wallet
 * ("main") on preprod, unlocked at start and synced while the app runs.
 *
 * The keystore passphrase lives in [Vault] (Android Keystore, fingerprint or device PIN).
 * The wallet locks when the app leaves the foreground, as on iOS.
 */
class WalletModel(private val activity: FragmentActivity) {
    private val context: Context = activity
    enum class Phase { Starting, NoWallet, Locked, Unlocking, Unlocked, Failed }

    val walletName = "main"
    val network = "preprod"

    var phase by mutableStateOf(Phase.Starting)
        private set
    var addresses by mutableStateOf<Addresses?>(null)
        private set
    var balances by mutableStateOf<Balances?>(null)
        private set
    var status by mutableStateOf("")
        private set
    var error by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)
        private set
    /** Mnemonic shown once after creating a wallet, for backup. */
    var newPhrase by mutableStateOf<String?>(null)
    val log = mutableStateListOf<String>()

    /** The spike's first builds kept the passphrase here in plain text; [unlock] moves it into the [Vault]. */
    private val legacy = context.getSharedPreferences("moth-spike", Context.MODE_PRIVATE)
    private var hasWallet = false
    /**
     * Ask for the fingerprint by itself once the app is in front and the phone is unlocked
     * (as iOS promptOnLockedScreen). Set at launch and whenever the app leaves the foreground;
     * consumed by one prompt, so cancelling it does not prompt again.
     */
    var autoPrompt = true
    private val keyguard = context.getSystemService(android.app.KeyguardManager::class.java)
    private val clock = SimpleDateFormat("HH:mm:ss", Locale.UK)
    lateinit var engine: Engine
        private set

    fun start() {
        engine = Engine(context) { event, data -> onEvent(event, data) }
    }

    private fun onEvent(event: String, data: Any?) {
        when (event) {
            "ready" -> {
                write("engine ready")
                engine.call("list") { r ->
                    r.onSuccess { list ->
                        val names = (list as? org.json.JSONArray)?.let { a -> (0 until a.length()).map { a.getJSONObject(it).getString("name") } } ?: emptyList()
                        write("wallets: $names")
                        hasWallet = walletName in names
                        phase = if (hasWallet) Phase.Locked else Phase.NoWallet
                        maybeAutoUnlock()
                    }.onFailure { fail("list", it) }
                }
            }
            "balances" -> (data as? JSONObject)?.let { b ->
                balances = Balances.parse(b)
                logProgress(balances!!)
                if (balances?.synced == true) status = "Synced"
            }
            // moth prefixes progress lines with ○/●; the status line doesn't need them.
            "syncMessage" -> {
                val line = (data as? String ?: "").trim('○', '●', ' ')
                if (!line.startsWith("syncing")) write("sync $line")
                status = line
            }
            "txStage" -> status = data.toString()
            "workerError" -> {
                write("worker $data")
                error = data.toString()
            }
            else -> write("$event $data")
        }
    }

    fun create() {
        if (legacy.contains("passphrase")) {
            error = "A wallet key from an earlier build exists on this device; not replacing it."
            return
        }
        busy = true
        Vault.create(activity, walletName) { r ->
            r.onSuccess { passphrase ->
                engine.call("create", listOf(walletName, passphrase, network)) { c ->
                    busy = false
                    c.onSuccess {
                        newPhrase = (it as JSONObject).getString("mnemonic")
                        hasWallet = true
                        write("created wallet $walletName")
                        unlockWith(passphrase)
                    }.onFailure { fail("create", it) }
                }
            }.onFailure { busy = false; if ((it as? VaultException)?.canceled != true) fail("vault", it) }
        }
    }

    fun maybeAutoUnlock() {
        val resumed = activity.lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)
        if (autoPrompt && phase == Phase.Locked && resumed && !keyguard.isDeviceLocked) {
            autoPrompt = false
            unlock()
        }
    }

    /** Asks for a fingerprint or the device PIN, then unlocks the wallet. */
    fun unlock() {
        if (phase == Phase.Unlocking || phase == Phase.Unlocked) return
        // The Keystore key works only while the phone is unlocked (setUnlockedDeviceRequired).
        if (keyguard.isDeviceLocked) {
            error = "Unlock your phone first."
            return
        }
        phase = Phase.Unlocking
        val old = legacy.getString("passphrase", null)
        when {
            Vault.exists(context, walletName) -> Vault.passphrase(activity, walletName, "Unlock your Moth wallet") { r ->
                r.onSuccess { unlockWith(it) }.onFailure { vaultFailed(it) }
            }
            old != null -> Vault.adopt(activity, walletName, old) { r ->
                r.onSuccess {
                    // Only now that the vault holds it is the plain-text copy removed.
                    legacy.edit().remove("passphrase").commit()
                    write("vault: moved the old plain-text passphrase into the Keystore")
                    unlockWith(it)
                }.onFailure { vaultFailed(it) }
            }
            else -> vaultFailed(VaultException("This wallet's key is missing from this phone. Restore it from its recovery phrase."))
        }
    }

    private fun vaultFailed(e: Throwable) {
        phase = Phase.Locked
        if ((e as? VaultException)?.canceled == true) write("unlock canceled") else fail("unlock", e)
    }

    private fun unlockWith(passphrase: String) {
        phase = Phase.Unlocking
        engine.call("unlock", listOf(walletName, passphrase, network)) { r ->
            r.onSuccess {
                val a = it as JSONObject
                addresses = Addresses(a.getString("unshielded"), a.getString("shielded"), a.getString("dust"), a.getString("nightTokenId"))
                phase = Phase.Unlocked
                write("unlocked")
                status = "Starting sync…"
                sync()
            }.onFailure { fail("unlock", it); phase = Phase.Locked }
        }
    }

    /** Stops sync and drops the seed from the engine; the next use needs the fingerprint again. */
    fun lock() {
        if (phase != Phase.Unlocked) return
        engine.call("lock", listOf(walletName)) { r -> r.onFailure { write("lock failed: ${it.message}") } }
        balances = null
        addresses = null
        status = ""
        phase = Phase.Locked
        write("locked")
    }

    fun sync() {
        engine.call("sync", listOf(walletName, network)) { r -> r.onFailure { fail("sync", it) } }
    }

    fun refreshBalances() {
        engine.call("balances", listOf(walletName, network)) { r ->
            r.onSuccess { balances = Balances.parse(it as JSONObject) }.onFailure { fail("balances", it) }
        }
    }

    fun cardanoAddress(callback: (Result<String>) -> Unit) {
        engine.call("cardanoAddresses", listOf(walletName, network)) { r ->
            callback(r.mapCatching { (it as JSONObject).getString("address") })
        }
    }

    private var lastProgressLog = 0L

    /** One progress line a minute in the log, so sync speed can be measured from it. */
    private fun logProgress(b: Balances) {
        val now = System.currentTimeMillis()
        if (b.synced || now - lastProgressLog < 60_000) return
        lastProgressLog = now
        write("progress " + b.progress.entries.joinToString(" ") { (k, v) -> "$k=${v?.let { "%.2f%%".format(it * 100) } ?: "?"}" })
    }

    private fun fail(what: String, e: Throwable) {
        write("$what failed: ${e.message}")
        error = e.message
    }

    fun write(line: String) {
        Log.i("MothSpike", line)
        log.add("${clock.format(Date())} $line")
        if (log.size > 500) log.removeRange(0, log.size - 500)
    }
}
