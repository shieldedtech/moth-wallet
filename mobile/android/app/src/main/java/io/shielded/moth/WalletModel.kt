package io.shielded.moth

import android.content.Context
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONObject
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

data class Addresses(val unshielded: String, val shielded: String, val dust: String, val nightTokenId: String)

/**
 * The app's state, driven by the engine. A cut-down port of iOS `WalletModel`: one wallet
 * ("main") on preprod, unlocked at start and synced while the app runs.
 *
 * SPIKE ONLY: the keystore passphrase is kept in SharedPreferences. The iOS app keeps it in
 * the Keychain behind Face ID; the Android equivalent (Keystore + BiometricPrompt) is next.
 */
class WalletModel(private val context: Context) {
    enum class Phase { Starting, NoWallet, Unlocking, Unlocked, Failed }

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

    private val prefs = context.getSharedPreferences("moth-spike", Context.MODE_PRIVATE)
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
                        if (walletName in names && prefs.contains("passphrase")) unlock() else phase = Phase.NoWallet
                    }.onFailure { fail("list", it) }
                }
            }
            "balances" -> (data as? JSONObject)?.let { b ->
                balances = Balances.parse(b)
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
        busy = true
        val passphrase = ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        // Never replace a key: an existing one may be the only way into an older keystore.
        if (prefs.contains("passphrase")) {
            error = "A keystore passphrase already exists on this device; not replacing it."
            busy = false
            return
        }
        prefs.edit().putString("passphrase", passphrase).apply()
        engine.call("create", listOf(walletName, passphrase, network)) { r ->
            busy = false
            r.onSuccess {
                newPhrase = (it as JSONObject).getString("mnemonic")
                write("created wallet $walletName")
                unlock()
            }.onFailure { fail("create", it) }
        }
    }

    private fun unlock() {
        phase = Phase.Unlocking
        engine.call("unlock", listOf(walletName, prefs.getString("passphrase", ""), network)) { r ->
            r.onSuccess {
                val a = it as JSONObject
                addresses = Addresses(a.getString("unshielded"), a.getString("shielded"), a.getString("dust"), a.getString("nightTokenId"))
                phase = Phase.Unlocked
                write("unlocked")
                sync()
            }.onFailure { fail("unlock", it); phase = Phase.Failed }
        }
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
