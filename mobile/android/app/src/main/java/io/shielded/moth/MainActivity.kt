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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // The app-switcher thumbnail would show balances and addresses (iOS shows a privacy cover).
        if (android.os.Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false)
        model = WalletModel(this)

        val engineDir = Bundled.extract(this, "engine")
        val params = File(filesDir, "zk-params").apply { mkdirs() }
        val proverPort = Native.proverStart(params.path, 6300, 2)
        val enginePort = Native.staticStart(engineDir.path, 8765)
        model.write("prover on 127.0.0.1:$proverPort, engine page on 127.0.0.1:$enginePort")
        model.start()
        // Attached but invisible, so the WebView is never paused as off-screen.
        addContentView(model.engine.webView, android.view.ViewGroup.LayoutParams(1, 1))

        setContent {
            MothTheme {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    App()
                }
            }
        }
        handle(intent)
    }

    @Composable
    private fun App() {
        when (model.phase) {
            WalletModel.Phase.NoWallet -> Welcome()
            WalletModel.Phase.Locked, WalletModel.Phase.Unlocking -> Locked()
            else -> when (screen) {
                "receive" -> {
                    BackHandler { screen = "home" }
                    ReceiveScreen(model) { screen = "home" }
                }
                "logs" -> {
                    BackHandler { screen = "home" }
                    LogsScreen { screen = "home" }
                }
                else -> HomeScreen(model, onReceive = { screen = "receive" }, onLogs = { screen = "logs" })
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
                else PrimaryButton("Create wallet", Modifier.fillMaxWidth()) { model.create() }
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
            }
        }
    }

    // As on iOS: leaving the app locks the wallet, so the seed is never left in memory behind
    // the app switcher; coming back asks for the fingerprint again. Showing the device-PIN
    // screen also stops this activity, but lock() only acts on an unlocked wallet.
    // onResume, not onStart: an app launched behind the lock screen is started but not resumed
    // until the phone is unlocked.
    override fun onResume() {
        super.onResume()
        model.maybeAutoUnlock()
    }

    override fun onStop() {
        super.onStop()
        // The device-PIN screen also stops this activity mid-unlock; lock() ignores that.
        if (model.phase == WalletModel.Phase.Unlocked || model.phase == WalletModel.Phase.Locked) model.autoPrompt = true
        model.lock()
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun LogsScreen(onBack: () -> Unit) {
        val state = rememberLazyListState()
        LaunchedEffect(model.log.size) { if (model.log.isNotEmpty()) state.scrollToItem(model.log.size - 1) }
        Scaffold(topBar = {
            TopAppBar(title = { Text("Logs") }, navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } })
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
        intent?.getStringExtra("screen")?.let { screen = it }
        when (intent?.getStringExtra("action")) {
            "create" -> model.create()
            "unlock" -> model.unlock()
            "lock" -> model.lock()
            "sync" -> model.sync()
            "balances" -> model.refreshBalances()
        }
    }
}
