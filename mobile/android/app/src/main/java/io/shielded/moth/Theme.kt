package io.shielded.moth

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Shapes
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/** Port of iOS `Theme` (Moth's colours from packages/extension/assets/globals.css). */
object MothColors {
    /** Moth's primary colour, for fills behind ink text. */
    val moonlime = Color(0xFFAEEB6B)
    val ink = Color(0xFF1C1F36)
    /** Moonlime is only 1.3:1 on light backgrounds, so light mode uses a deep green for text and icons. */
    val accentLight = Color(0xFF3D6B1F)
}

/**
 * One corner radius for buttons, text fields, menus and cards, so every screen shares a look.
 * Material's defaults mix 4 dp fields, 12 dp cards and pill buttons.
 */
private val MothShapes = Shapes(
    extraSmall = RoundedCornerShape(14.dp),
    small = RoundedCornerShape(14.dp),
    medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(20.dp),
)

@Composable
fun MothTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val scheme = if (dark) {
        darkColorScheme(primary = MothColors.moonlime, onPrimary = MothColors.ink, secondary = MothColors.moonlime)
    } else {
        lightColorScheme(primary = MothColors.accentLight, onPrimary = Color.White, secondary = MothColors.accentLight)
    }
    MaterialTheme(colorScheme = scheme, shapes = MothShapes, content = content)
}

/** Port of iOS `PrimaryButton`: moonlime fill and ink text in both themes. */
@Composable
fun PrimaryButton(text: String, modifier: Modifier = Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier,
        shape = MaterialTheme.shapes.small,
        colors = ButtonDefaults.buttonColors(containerColor = MothColors.moonlime, contentColor = MothColors.ink),
    ) {
        Text(text, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(vertical = 6.dp))
    }
}

/** The outlined counterpart of [PrimaryButton], same shape and text. */
@Composable
fun SecondaryButton(text: String, modifier: Modifier = Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, enabled = enabled, modifier = modifier, shape = MaterialTheme.shapes.small) {
        Text(text, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(vertical = 6.dp))
    }
}

/** Full-width tabs under the top bar, for switching between kinds (Receive, Send). */
@Composable
fun MothTabs(labels: List<String>, selected: Int, enabled: Boolean = true, onSelect: (Int) -> Unit) {
    TabRow(selectedTabIndex = selected, Modifier.fillMaxWidth()) {
        labels.forEachIndexed { i, label ->
            // Labels without Tab's 16 dp side padding, so "Unshielded" fits on a phone.
            Tab(selected = i == selected, onClick = { onSelect(i) }, enabled = enabled) {
                Text(label, Modifier.padding(vertical = 14.dp), maxLines = 1, style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}
