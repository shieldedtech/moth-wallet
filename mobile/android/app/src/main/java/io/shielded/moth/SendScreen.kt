package io.shielded.moth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp

/**
 * Send NIGHT to one recipient: a cut-down port of the iOS `SendView` (HomeView.swift), without
 * other tokens, several recipients, contacts or Cardano. The first tap shows the fee; the
 * second asks for the fingerprint and sends.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SendScreen(model: WalletModel, onBack: () -> Unit) {
    var shielded by remember { mutableStateOf(false) }
    var to by remember { mutableStateOf("") }
    var amount by remember { mutableStateOf("") }
    var fee by remember { mutableStateOf<String?>(null) }
    var sentHash by remember { mutableStateOf<String?>(null) }
    val night = model.addresses?.nightTokenId
    val b = model.balances
    val held = night?.let { (if (shielded) b?.shielded else b?.unshielded)?.get(it) } ?: "0"
    val synced = b?.synced == true
    val ready = night != null && to.isNotBlank() && amount.isNotBlank() && synced && sentHash == null

    fun transfers(callback: (List<Transfer>) -> Unit) = model.parseNight(amount) { r ->
        r.onSuccess { star -> callback(listOf(Transfer(shielded, night!!, star, to.trim()))) }.onFailure { model.error = it.message }
    }

    Scaffold(topBar = {
        TopAppBar(title = { Text("Send") }, navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } })
    }) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).padding(16.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (!synced) Footnote("Waiting for Midnight to finish syncing.")
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                listOf(false to "Unshielded", true to "Shielded").forEachIndexed { i, (value, label) ->
                    SegmentedButton(
                        selected = shielded == value,
                        onClick = { shielded = value; fee = null },
                        shape = SegmentedButtonDefaults.itemShape(i, 2),
                        enabled = sentHash == null,
                    ) { Text(label) }
                }
            }
            Footnote("Available: ${Amount.format(held, Amount.NIGHT_DECIMALS, 6)} NIGHT")
            OutlinedTextField(
                value = to,
                onValueChange = { to = it; fee = null },
                label = { Text(if (shielded) "mn_shield-addr…" else "mn_addr…") },
                modifier = Modifier.fillMaxWidth(),
                textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Uri),
                enabled = sentHash == null,
            )
            OutlinedTextField(
                value = amount,
                onValueChange = { amount = it; fee = null },
                label = { Text("Amount in NIGHT") },
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                singleLine = true,
                enabled = sentHash == null,
            )
            fee?.let { Footnote("Fee: ${Amount.format(it, Amount.DUST_DECIMALS, 6)} DUST") }
            if (model.busy && model.status.isNotEmpty()) Footnote(model.status)
            sentHash?.let { hash ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("Submitted", style = MaterialTheme.typography.titleMedium)
                        SelectionContainer { Text(hash, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
                    }
                }
            }
            if (sentHash != null) {
                PrimaryButton("Done", Modifier.fillMaxWidth(), onClick = onBack)
            } else {
                PrimaryButton(
                    if (model.busy) "Working…" else if (fee == null) "Review" else "Send",
                    Modifier.fillMaxWidth(),
                    enabled = ready && !model.busy,
                ) {
                    // A second tap can arrive before the disabled button is drawn.
                    if (!model.busy) transfers { t ->
                        if (fee == null) model.estimateFee(t) { r -> r.onSuccess { fee = it }.onFailure { model.error = it.message } }
                        else model.send(t) { r -> r.onSuccess { sentHash = it }.onFailure { model.error = it.message } }
                    }
                }
            }
        }
    }
}
