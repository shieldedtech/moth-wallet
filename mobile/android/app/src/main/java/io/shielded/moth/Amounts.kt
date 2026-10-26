package io.shielded.moth

import org.json.JSONObject
import java.math.BigInteger

/**
 * Balances as the engine reports them (engine/host.ts `PlainBalances`): base units as decimal
 * strings, so no amount ever passes through a floating-point type. Port of iOS `Balances`.
 */
data class Balances(
    val shielded: Map<String, String>,
    val unshielded: Map<String, String>,
    /** SPECK. */
    val dust: String,
    val synced: Boolean,
    /**
     * Sync progress per wallet ("Shielded", "Unshielded", "DUST"), each 0..1, or null before
     * its total is known. Shown per wallet: one combined figure weights the wallets by block
     * count, so two finished wallets made the bar look far ahead of a slow DUST sync.
     */
    val progress: Map<String, Double?>,
    val dustGeneration: DustGeneration?,
) {
    data class DustGeneration(
        /** Maximum DUST this account can hold from its generating sources, in SPECK. */
        val limit: String,
        /** NIGHT backing the generating DUST coins, in STAR. */
        val designated: String,
        /** This account's own NIGHT registered for DUST, in STAR. */
        val registeredNight: String,
        /** SPECK generated per day. */
        val ratePerDay: String,
        /** When the balance reaches the limit, in Unix seconds. */
        val fillTime: Double?,
        val registered: Boolean,
    )

    companion object {
        fun parse(json: JSONObject): Balances {
            fun strings(o: JSONObject?): Map<String, String> =
                o?.keys()?.asSequence()?.associateWith { o.getString(it) } ?: emptyMap()

            val sub = json.optJSONObject("subProgress")
            val progress = linkedMapOf("Shielded" to "shielded", "Unshielded" to "unshielded", "DUST" to "dust").mapValues { (_, key) ->
                sub?.optJSONObject(key)?.let { p ->
                    val total = p.optDouble("total", 0.0)
                    if (total > 0) (p.optDouble("applied", 0.0) / total).coerceIn(0.0, 1.0) else null
                }
            }
            val g = json.optJSONObject("dustGeneration")
            return Balances(
                shielded = strings(json.optJSONObject("shielded")),
                unshielded = strings(json.optJSONObject("unshielded")),
                dust = json.optString("dust", "0"),
                synced = json.optBoolean("synced"),
                progress = progress,
                dustGeneration = g?.let {
                    DustGeneration(
                        limit = it.optString("limit", "0"),
                        designated = it.optString("designated", "0"),
                        registeredNight = it.optString("registeredNight", "0"),
                        ratePerDay = it.optString("ratePerDay", "0"),
                        fillTime = if (it.isNull("fillTime")) null else it.optDouble("fillTime"),
                        registered = it.optBoolean("registered"),
                    )
                },
            )
        }
    }
}

/** Port of iOS `Amount`. */
object Amount {
    /** NIGHT has 6 decimals (1 NIGHT = 10^6 STAR). */
    const val NIGHT_DECIMALS = 6
    /** DUST has 15 decimals (1 DUST = 10^15 SPECK). */
    const val DUST_DECIMALS = 15

    /**
     * Formats a base-unit decimal string with [decimals] decimals, keeping [places] of them
     * (truncated, never rounded up) and grouping the whole part.
     */
    fun format(base: String, decimals: Int, places: Int): String {
        val digits = base.trimStart('0')
        val padded = "0".repeat(maxOf(0, decimals + 1 - digits.length)) + digits
        val whole = padded.dropLast(decimals)
        val fraction = padded.takeLast(decimals).take(places)
        val grouped = whole.reversed().chunked(3).joinToString(",").reversed()
        return if (places > 0) "$grouped.$fraction" else grouped
    }

    /** a - b for base-unit strings, or null if either is not a number. */
    fun minus(a: String, b: String): BigInteger? =
        runCatching { BigInteger(a) - BigInteger(b) }.getOrNull()
}

/** Tokens other than NIGHT have no registry yet, so they are shown by a short id. */
fun tokenLabel(id: String) = "${id.take(8)}…"
