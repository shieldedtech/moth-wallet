package io.shielded.moth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp

/** Port of the iOS `RestoreView` (mobile/ios/Moth/Views/OnboardingViews.swift). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RestoreScreen(model: WalletModel, onBack: () -> Unit) {
    var phrase by remember { mutableStateOf("") }
    val state = remember { model.importableState() }
    var useState by remember { mutableStateOf(state != null) }
    val words = phrase.split(Regex("\\s+")).count { it.isNotEmpty() }

    Scaffold(topBar = {
        TopAppBar(title = { Text("Restore") }, navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } })
    }) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).padding(16.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            OutlinedTextField(
                value = phrase,
                onValueChange = { phrase = it },
                label = { Text("Recovery phrase") },
                modifier = Modifier.fillMaxWidth().heightIn(min = 140.dp),
                textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
                // Password type keeps the words out of the keyboard's suggestions and history.
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Password),
            )
            Footnote("Enter your 24 words separated by spaces. A restored wallet scans the chain from the start, so its first sync takes longer.")
            state?.let {
                Card(Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = useState, onCheckedChange = { useState = it })
                        Column {
                            Text("Use sync state from a computer")
                            Text(
                                "Test builds only. Pushed for ${it.unshielded.take(20)}…; loaded only if the phrase matches.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
            if (model.busy) CircularProgressIndicator(Modifier.size(28.dp).align(Alignment.CenterHorizontally))
            else PrimaryButton("Restore", Modifier.fillMaxWidth(), enabled = words >= 12) {
                model.restore(phrase, state.takeIf { useState })
            }
        }
    }
}
