package io.shielded.moth

import android.content.Context
import android.util.Log
import androidx.fragment.app.FragmentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** One recipient of a send (iOS `Transfer`); [amount] is in base units. */
data class Transfer(val shielded: Boolean, val tokenId: String, val amount: String, val to: String) {
    val json get() = JSONObject(mapOf("type" to if (shielded) "shielded" else "unshielded", "tokenId" to tokenId, "amount" to amount, "to" to to))
}

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
    /** Outcome of a DUST registration or deregistration, shown once. */
    var notice by mutableStateOf<String?>(null)
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

    /** Why Moth could not start; shown instead of the wallet. */
    var startError by mutableStateOf<String?>(null)
        private set

    fun start() {
        engine = Engine(context) { event, data -> onEvent(event, data) }
    }

    fun startFailed(e: Throwable) {
        write("start failed: ${e.message}")
        startError = e.message
        phase = Phase.Failed
    }

    /** Locks the wallet and destroys the engine page, when the activity is destroyed. */
    fun close() {
        if (!::engine.isInitialized) return
        lock()
        (engine.webView.parent as? android.view.ViewGroup)?.removeView(engine.webView)
        engine.webView.destroy()
    }

    /** Whether the app is in the foreground; onStop locks only a wallet that is fully unlocked. */
    private val visible get() = activity.lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED)

    /** Locks a wallet that came unlocked, or stayed unlocked, while the app was in the background. */
    private fun lockIfHidden() {
        if (visible || phase != Phase.Unlocked) return
        write("app left the foreground meanwhile")
        autoPrompt = true
        lock()
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
                if (balances!!.synced && syncStartedAt > 0) {
                    write("synced in %.1f s since sync start".format((System.currentTimeMillis() - syncStartedAt) / 1000.0))
                    syncStartedAt = 0
                }
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
                    }.onFailure {
                        // As in restore: a key with no wallet would block every later create.
                        Vault.remove(context, walletName)
                        fail("create", it)
                    }
                }
            }.onFailure { busy = false; if ((it as? VaultException)?.canceled != true) fail("vault", it) }
        }
    }

    /** State pushed from a computer (debug builds), offered on the restore screen. */
    fun importableState(): StateImport.Found? = StateImport.find(context, network)

    /**
     * Restores a wallet from its recovery phrase (iOS `WalletModel.restore`). A restored wallet
     * scans from genesis; with [state], a debug build loads that state instead, once the
     * phrase is shown to own it.
     */
    fun restore(phrase: String, state: StateImport.Found?) {
        val words = phrase.lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
        busy = true
        Vault.create(activity, walletName) { r ->
            r.onSuccess { passphrase ->
                engine.call("importPhrase", listOf(walletName, words, passphrase, network)) { c ->
                    busy = false
                    c.onSuccess {
                        hasWallet = true
                        write("restored wallet $walletName" + if (state != null) ", with sync state from a computer" else "")
                        pendingImport = state
                        unlockWith(passphrase)
                    }.onFailure {
                        Vault.remove(context, walletName)
                        fail("restore", it)
                    }
                }
            }.onFailure { busy = false; if ((it as? VaultException)?.canceled != true) fail("vault", it) }
        }
    }

    private var pendingImport: StateImport.Found? = null

    /**
     * Test builds only: deletes the wallet, its Keystore key and all app data, so the app opens
     * on the welcome screen again. Android closes the app.
     */
    fun startOver() {
        if (!BuildConfig.DEBUG) return
        lock()
        Vault.remove(context, walletName)
        legacy.edit().clear().commit()
        write("starting over")
        context.getSystemService(android.app.ActivityManager::class.java).clearApplicationUserData()
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
                // onStop ran while this was Unlocking, so it could not lock then.
                if (!visible) return@onSuccess lockIfHidden()
                status = "Starting sync…"
                val state = pendingImport
                pendingImport = null
                if (state == null) sync() else importState(state)
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

    private fun importState(state: StateImport.Found) {
        // The state holds its wallet's addresses; one from another phrase would show the wrong funds.
        if (state.unshielded != addresses?.unshielded) {
            StateImport.discard(context, network)
            error = "The sync state from the computer belongs to another wallet; syncing from the start instead."
            write("state import: address mismatch, not loaded")
            return sync()
        }
        status = "Loading sync state…"
        StateImport.apply(engine, state, walletName, network) { r ->
            r.onSuccess { write("state import: loaded $it files") }.onFailure { fail("state import", it) }
            sync()
        }
    }

    // Transactions. Unlike iOS, where this is a setting that is off by default, every
    // transaction asks for the fingerprint or device PIN: the unlocked session alone is not enough.

    /** The DUST fee for sending [transfers] in one transaction, in SPECK. */
    fun estimateFee(transfers: List<Transfer>, callback: (Result<String>) -> Unit) {
        busy = true
        engine.call("estimateFee", listOf(walletName, network, JSONArray(transfers.map { it.json }))) { r ->
            busy = false
            r.onFailure { write("fee estimate failed: ${it.message}") }
            callback(r.mapCatching { (it as JSONObject).getString("fee") })
        }
    }

    /** Sends all [transfers] in one transaction and returns its hash. */
    fun send(transfers: List<Transfer>, callback: (Result<String>) -> Unit) = authorized("Approve this send", callback) {
        engine.call("send", listOf(walletName, network, JSONArray(transfers.map { it.json }))) { r ->
            txDone()
            r.onSuccess { write("sent $it") }.onFailure { write("send failed: ${it.message}") }
            callback(r.mapCatching { (it as JSONObject).getString("txHash") })
        }
    }

    /** Registers this wallet's NIGHT so it generates DUST for this wallet. */
    fun registerDust() = authorized("Approve DUST registration", ::reportTx) {
        engine.call("registerDust", listOf(walletName, network)) { r ->
            txDone()
            reportTx(r.mapCatching { describeRegistration(it as JSONObject) })
        }
    }

    fun deregisterDust() = authorized("Approve DUST deregistration", ::reportTx) {
        engine.call("deregisterDust", listOf(walletName, network)) { r ->
            txDone()
            reportTx(r.mapCatching {
                "Deregistration submitted (${(it as JSONObject).getString("txHash").take(12)}…). This NIGHT stops generating DUST once it is on chain."
            })
        }
    }

    /** True while a transaction prompt is up; the device-PIN screen stops the activity, which must not lock. */
    var authorizing = false
        private set

    private fun authorized(reason: String, onFail: (Result<String>) -> Unit, work: () -> Unit) {
        busy = true
        authorizing = true
        Vault.confirmPresence(activity, reason) { r ->
            authorizing = false
            r.onSuccess { work() }.onFailure {
                txDone()
                if ((it as? VaultException)?.canceled != true) onFail(Result.failure(it))
            }
        }
    }

    /** Ends a transaction. onStop skips locking while [authorizing], so lock now if the app left meanwhile. */
    private fun txDone() {
        busy = false
        lockIfHidden()
    }

    private fun reportTx(r: Result<String>) {
        r.onSuccess { write("dust: $it"); notice = it }.onFailure { fail("dust", it) }
    }

    /** Port of iOS `WalletModel.describe(_:nightHeld:)`. */
    private fun describeRegistration(r: JSONObject): String {
        r.optString("txHash").takeIf { it.isNotEmpty() && !r.isNull("txHash") }?.let {
            return "DUST registration submitted (${it.take(12)}…). DUST starts accruing once it is on chain."
        }
        val wait = r.optJSONObject("notYet")
        if (wait == null) {
            val held = addresses?.let { balances?.unshielded?.get(it.nightTokenId) }.let { it != null && it != "0" }
            return if (held) "All of this account's NIGHT is already registered for DUST." else "This account has no NIGHT to register."
        }
        val need = Amount.format(wait.getString("feeSpecks"), Amount.DUST_DECIMALS, 6)
        val have = Amount.format(wait.getString("availableSpecks"), Amount.DUST_DECIMALS, 6)
        if (wait.isNull("secondsUntilAffordable")) {
            return "Registering costs $need DUST, more than this NIGHT can ever generate. Hold more NIGHT and try again."
        }
        val eta = android.text.format.DateUtils.formatElapsedTime(wait.getDouble("secondsUntilAffordable").toLong())
        return "Registration pays its own fee from the DUST this NIGHT has generated since it arrived. " +
            "It needs $need DUST and has $have so far, about $eta (h:mm:ss) to go. Nothing was spent; try again then."
    }

    private var syncStartedAt = 0L

    fun sync() {
        syncStartedAt = System.currentTimeMillis()
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
