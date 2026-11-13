package io.shielded.moth

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.os.SystemClock
import android.widget.Toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/** Port of iOS `ReceiveView` (mobile/ios/Moth/Views/HomeView.swift). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReceiveScreen(model: WalletModel, onBack: () -> Unit) {
    val kinds = listOf("unshielded" to "Unshielded", "shielded" to "Shielded", "dust" to "DUST", "cardano" to "Cardano")
    var kind by rememberSaveable { mutableStateOf("unshielded") }
    var cardanoAddress by remember { mutableStateOf<String?>(null) }
    var cardanoError by remember { mutableStateOf<String?>(null) }
    val context = LocalContext.current

    LaunchedEffect(kind) {
        if (kind == "cardano" && cardanoAddress == null) {
            model.cardanoAddress { r -> r.onSuccess { cardanoAddress = it }.onFailure { cardanoError = it.message } }
        }
    }

    val address = when (kind) {
        "shielded" -> model.addresses?.shielded
        "dust" -> model.addresses?.dust
        "cardano" -> cardanoAddress
        else -> model.addresses?.unshielded
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Receive") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
        MothTabs(kinds.map { it.second }, kinds.indexOfFirst { it.first == kind }) { kind = kinds[it].first }
        Column(
            Modifier.fillMaxSize().padding(horizontal = 24.dp).padding(top = 20.dp).verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            if (kind == "dust") {
                Hint("Give this to someone registering NIGHT or cNIGHT, so its DUST is generated for this account.")
            }
            if (kind == "cardano") {
                Hint("Receives ADA and cNIGHT on Cardano ${model.network}, from the same recovery phrase.")
                cardanoError?.let { Text(it, color = Color(0xFFE08A00), style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center) }
            }
            if (address != null) {
                QrCode(address, Modifier.size(240.dp))
                SelectionContainer {
                    Text(address, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
                }
                PrimaryButton("Copy address", Modifier.fillMaxWidth()) { Clipboard.copy(context, address) }
            }
        }
        }
    }
}

@Composable
private fun Hint(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
}

/** A QR code with error correction level M, as on iOS; drawn dark on white in both themes so scanners read it. */
@Composable
fun QrCode(text: String, modifier: Modifier = Modifier) {
    val bitmap = remember(text) {
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.MARGIN to 2))
        val pixels = IntArray(matrix.width * matrix.height) { i ->
            if (matrix.get(i % matrix.width, i / matrix.width)) android.graphics.Color.BLACK else android.graphics.Color.WHITE
        }
        Bitmap.createBitmap(pixels, matrix.width, matrix.height, Bitmap.Config.ARGB_8888).asImageBitmap()
    }
    Box(modifier.background(Color.White)) {
        Image(bitmap, "QR code for the address", Modifier.fillMaxSize(), filterQuality = FilterQuality.None)
    }
}

/**
 * Port of iOS `Clipboard`: marks the copy sensitive and clears it after two minutes if it is still ours.
 *
 * Only the focused app can read the clipboard (Android 10+), and the copy is usually pasted in
 * another app, so a clear that falls due in the background waits until Moth has focus again.
 */
object Clipboard {
    private const val CLEAR_AFTER_MS = 120_000L
    /** The address last copied and when to clear it, until it is cleared or replaced. */
    private var pending: Pair<String, Long>? = null

    fun copy(context: Context, text: String) {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText("Moth address", text)
        if (Build.VERSION.SDK_INT >= 33) {
            clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
        }
        clipboard.setPrimaryClip(clip)
        // Android 13+ shows its own copy confirmation.
        if (Build.VERSION.SDK_INT < 33) Toast.makeText(context, "Address copied", Toast.LENGTH_SHORT).show()
        pending = text to SystemClock.elapsedRealtime() + CLEAR_AFTER_MS
        val app = context.applicationContext
        Handler(Looper.getMainLooper()).postDelayed({ clearIfDue(app) }, CLEAR_AFTER_MS)
    }

    /** Clears a due copy if it is still ours. Unreadable (Moth not focused): keeps it for the next call. */
    fun clearIfDue(context: Context) {
        val (text, due) = pending ?: return
        if (SystemClock.elapsedRealtime() < due) return
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val current = clipboard.primaryClip ?: return
        if (current.itemCount > 0 && current.getItemAt(0).text?.toString() == text) clipboard.clearPrimaryClip()
        pending = null
    }
}
