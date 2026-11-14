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
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
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
 * Send one token to one recipient: a cut-down port of the iOS `SendView` (HomeView.swift),
 * without several recipients, contacts or Cardano. After choosing unshielded or shielded, the
 * user picks one of the tokens held of that kind (NIGHT first), and the amount is checked
 * against what is available. The first tap shows the fee; the second asks for the fingerprint
 * and sends.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SendScreen(model: WalletModel, onBack: () -> Unit) {
    var shielded by remember { mutableStateOf(false) }
    var to by remember { mutableStateOf("") }
    var amount by remember { mutableStateOf("") }
    var tokenId by remember { mutableStateOf<String?>(null) }
    var fee by remember { mutableStateOf<String?>(null) }
    var sentHash by remember { mutableStateOf<String?>(null) }
    val b = model.balances
    val synced = b?.synced == true
    val options = b?.let { holdings(it, model.addresses?.nightTokenId, shielded) } ?: emptyList()
    val token = options.firstOrNull { it.id == tokenId } ?: options.firstOrNull()
    // The amount and fee belong to one token. The list can change under the user (the token is
    // spent to zero, NIGHT arrives with a sync), making another token the default; clear them
    // then, rather than send the same number of a different token.
    var enteredFor by remember { mutableStateOf<String?>(null) }
    if (token?.id != enteredFor) {
        enteredFor = token?.id
        amount = ""
        fee = null
    }
    val base = token?.let { Amount.parse(amount, it.decimals) }
    val tooMuch = base != null && base > token.amount.toBigInteger()
    val amountError = when {
        amount.isBlank() || token == null -> null
        base == null && token.decimals > 0 -> "Enter a positive amount with at most ${token.decimals} decimals."
        base == null -> "Enter a whole, positive number of base units."
        tooMuch -> "More than the ${token.formatted} available."
        else -> null
    }
    val ready = token != null && base != null && !tooMuch && to.isNotBlank() && synced && sentHash == null

    Scaffold(topBar = {
        TopAppBar(title = { Text("Send") }, navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } })
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
        // The same tabs as Receive.
        MothTabs(listOf("Unshielded", "Shielded"), if (shielded) 1 else 0, enabled = sentHash == null) {
            shielded = it == 1; tokenId = null; amount = ""; fee = null
        }
        Column(
            Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (!synced) Footnote("Waiting for Midnight to finish syncing.")
            if (options.isEmpty()) {
                Footnote(if (b == null) "Waiting for the first sync update…" else "No ${if (shielded) "shielded" else "unshielded"} tokens held.")
            } else {
                TokenPicker(options, token, enabled = sentHash == null) { tokenId = it.id; amount = ""; fee = null }
            }
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
                label = { Text(if (token != null && token.decimals > 0) "Amount in ${token.name}" else "Amount in base units") },
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = if (token != null && token.decimals > 0) KeyboardType.Decimal else KeyboardType.Number),
                singleLine = true,
                isError = amountError != null,
                supportingText = amountError?.let { { Text(it) } },
                enabled = sentHash == null && token != null,
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
                    if (!model.busy) {
                        val t = listOf(Transfer(shielded, token!!.id, base!!.toString(), to.trim()))
                        if (fee == null) model.estimateFee(t) { r -> r.onSuccess { fee = it }.onFailure { model.error = it.message } }
                        else model.send(t) { r -> r.onSuccess { sentHash = it }.onFailure { model.error = it.message } }
                    }
                }
            }
        }
        }
    }
}

/** The tokens held of the chosen kind, each with the amount available. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TokenPicker(options: List<Holding>, selected: Holding?, enabled: Boolean, onSelect: (Holding) -> Unit) {
    var open by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = enabled && it }) {
        OutlinedTextField(
            value = selected?.let { "${it.name} · ${it.formatted} available" } ?: "",
            onValueChange = {},
            readOnly = true,
            label = { Text("Token") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = open) },
            modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable).fillMaxWidth(),
            enabled = enabled,
        )
        ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { h ->
                DropdownMenuItem(
                    text = { Text("${h.name} · ${h.formatted}${if (h.decimals > 0) "" else " base units"}") },
                    onClick = { onSelect(h); open = false },
                )
            }
        }
    }
}
