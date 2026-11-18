package io.shielded.moth

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.fragment.app.FragmentActivity
import java.io.File

/**
 * Moth for Android (spike): Home and Receive, ported from the iOS app, over moth's engine
 * hosted in a hidden WebView and the in-app native prover.
 */
class MainActivity : FragmentActivity() {
    private lateinit var model: WalletModel
    private var screen by mutableStateOf("home")
    private var confirmStartOver by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // The app-switcher thumbnail would show balances and addresses (iOS shows a privacy cover).
        if (android.os.Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false)
        model = WalletModel(this)

        setContent {
            MothTheme {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    App()
                }
            }
        }
        Servers.start(this)
            .onSuccess { model.write("prover on 127.0.0.1:${Servers.PROVER_PORT}, engine page on 127.0.0.1:${Servers.ENGINE_PORT}") }
            .onFailure { return model.startFailed(it) }
        model.start()
        lifecycle.addObserver(autoUnlock)
        // Attached but invisible, so the WebView is never paused as off-screen.
        addContentView(model.engine.webView, android.view.ViewGroup.LayoutParams(1, 1))
        handle(intent)
    }

    override fun onDestroy() {
        super.onDestroy()
        // The activity can be created again in this process (back on Android 11, a locale
        // change); its new engine page must not share the wallet's IndexedDB with this one.
        model.close()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // Only the focused app can read the clipboard, so a due clear may have waited for this.
        if (hasFocus) Clipboard.clearIfDue(this)
    }

    @Composable
    private fun App() {
        when (model.phase) {
            WalletModel.Phase.Failed -> Stopped()
            WalletModel.Phase.NoWallet -> if (screen == "restore") {
                BackHandler { screen = "home" }
                RestoreScreen(model) { screen = "home" }
            } else Welcome()
            WalletModel.Phase.Locked, WalletModel.Phase.Unlocking -> Locked()
            else -> when (screen) {
                "receive" -> {
                    BackHandler { screen = "home" }
                    ReceiveScreen(model) { screen = "home" }
                }
                "send" -> {
                    BackHandler { screen = "home" }
                    SendScreen(model) { screen = "home" }
                }
                "logs" -> {
                    BackHandler { screen = "home" }
                    LogsScreen { screen = "home" }
                }
                else -> HomeScreen(model, onReceive = { screen = "receive" }, onSend = { screen = "send" }, onLogs = { screen = "logs" })
            }
        }
        model.newPhrase?.let { phrase ->
            AlertDialog(
                onDismissRequest = {},
                title = { Text("Recovery phrase") },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("Write these words down. They are the only backup of this wallet. Testnet funds only.")
                        SelectionContainer { Text(phrase, fontFamily = FontFamily.Monospace) }
                    }
                },
                confirmButton = { TextButton(onClick = { model.newPhrase = null }) { Text("I've written it down") } },
            )
        }
        if (confirmStartOver) {
            AlertDialog(
                onDismissRequest = { confirmStartOver = false },
                title = { Text("Start over?") },
                text = { Text("This deletes the wallet, its key and all app data from this phone, and closes Moth. You can only get the wallet back from its recovery phrase.") },
                confirmButton = { TextButton(onClick = { confirmStartOver = false; model.startOver() }) { Text("Delete and start over", color = MaterialTheme.colorScheme.error) } },
                dismissButton = { TextButton(onClick = { confirmStartOver = false }) { Text("Cancel") } },
            )
        }
        model.notice?.let { message ->
            AlertDialog(
                onDismissRequest = { model.notice = null },
                title = { Text("DUST") },
                text = { Text(message) },
                confirmButton = { TextButton(onClick = { model.notice = null }) { Text("OK") } },
            )
        }
        model.error?.let { message ->
            AlertDialog(
                onDismissRequest = { model.error = null },
                title = { Text("Something went wrong") },
                text = { Text(message) },
                confirmButton = { TextButton(onClick = { model.error = null }) { Text("OK") } },
            )
        }
    }

    @Composable
    private fun Welcome() {
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("Moth", style = MaterialTheme.typography.displaySmall)
                Text(
                    "A Midnight wallet. This Android build is a preview on ${model.network}; use testnet funds only.",
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (model.busy) CircularProgressIndicator(Modifier.size(28.dp))
                else {
                    PrimaryButton("Create wallet", Modifier.fillMaxWidth()) { model.create() }
                    SecondaryButton("Restore from recovery phrase", Modifier.fillMaxWidth()) { screen = "restore" }
                }
            }
        }
    }

    @Composable
    private fun Locked() {
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Icon(Icons.Default.Lock, null, Modifier.size(48.dp), tint = MaterialTheme.colorScheme.primary)
                Text("Moth is locked", style = MaterialTheme.typography.headlineSmall)
                Text("${model.walletName} · ${model.network}", color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (model.phase == WalletModel.Phase.Unlocking) CircularProgressIndicator(Modifier.size(28.dp))
                else PrimaryButton("Unlock", Modifier.fillMaxWidth()) { model.unlock() }
                if (BuildConfig.DEBUG) TextButton(onClick = { confirmStartOver = true }) { Text("Start over (test builds)") }
            }
        }
    }

    /** Moth could not start safely; nothing else is offered. */
    @Composable
    private fun Stopped() {
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("Moth stopped", style = MaterialTheme.typography.headlineSmall)
                Text(model.startError ?: "", textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }

    // As on iOS: leaving the app locks the wallet, so the seed is never left in memory behind
    // the app switcher; coming back asks for the fingerprint again. Showing the device-PIN
    // screen also stops this activity, but lock() only acts on an unlocked wallet.
    // On resume, not start: an app launched behind the lock screen is started but not resumed
    // until the phone is unlocked. An ON_RESUME observer rather than onResume(), because the
    // lifecycle only reports RESUMED (which maybeAutoUnlock checks) after onResume() returns.
    private val autoUnlock = androidx.lifecycle.LifecycleEventObserver { _, event ->
        if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) model.maybeAutoUnlock()
    }

    override fun onStop() {
        super.onStop()
        // The device-PIN screen also stops this activity mid-unlock; lock() ignores that.
        if (model.phase == WalletModel.Phase.Unlocked || model.phase == WalletModel.Phase.Locked) model.autoPrompt = true
        if (!model.authorizing) model.lock()
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun LogsScreen(onBack: () -> Unit) {
        val state = rememberLazyListState()
        LaunchedEffect(model.log.size) { if (model.log.isNotEmpty()) state.scrollToItem(model.log.size - 1) }
        Scaffold(topBar = {
            TopAppBar(
                title = { Text("Logs") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = { if (BuildConfig.DEBUG) TextButton(onClick = { confirmStartOver = true }) { Text("Start over") } },
            )
        }) { padding ->
            SelectionContainer {
                LazyColumn(Modifier.fillMaxSize().padding(padding).padding(horizontal = 12.dp), state = state) {
                    items(model.log) { Text(it, fontFamily = FontFamily.Monospace, fontSize = 11.sp, modifier = Modifier.fillMaxWidth()) }
                }
            }
        }
    }

    // Lets adb drive the spike, e.g. adb shell am start -n io.shielded.moth/.MainActivity --es screen receive
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent?) {
        if (model.phase == WalletModel.Phase.Failed) return
        intent?.getStringExtra("screen")?.let { screen = it }
        when (intent?.getStringExtra("action")) {
            "create" -> model.create()
            "unlock" -> model.unlock()
            "restore" -> screen = "restore"
            "lock" -> model.lock()
            "sync" -> model.sync()
            "balances" -> model.refreshBalances()
        }
    }
}

/**
 * The loopback prover and engine-page servers, started once per process: an activity created
 * again in the same process must not start them twice.
 *
 * Loopback ports are shared by every app on the phone, so another app could hold one first.
 * The engine page's origin and the prover URL are fixed, so Moth then stops rather than load
 * that app's page (which would be handed the vault passphrase) or send it proving requests.
 */
private object Servers {
    const val PROVER_PORT = 6300
    const val ENGINE_PORT = 8765
    // A failure is kept too: the prover sets the process environment, which is safe only once.
    private var started: Result<Unit>? = null

    fun start(context: android.content.Context): Result<Unit> = started ?: runCatching {
        val engineDir = Bundled.extract(context, "engine")
        val params = File(context.filesDir, "zk-params").apply { mkdirs() }
        check(Native.initTls(context.applicationContext)) { "Could not set up TLS for the prover." }
        check(Native.proverStart(params.path, PROVER_PORT, 2) == PROVER_PORT) { taken(PROVER_PORT) }
        check(Native.staticStart(engineDir.path, ENGINE_PORT) == ENGINE_PORT) { taken(ENGINE_PORT) }
    }.also { started = it }

    private fun taken(port: Int) =
        "Another app is using port $port on this phone, which Moth needs, so Moth stopped before that app could reach your wallet. Restart the phone and open Moth again; if this keeps happening, remove apps you do not trust."
}
