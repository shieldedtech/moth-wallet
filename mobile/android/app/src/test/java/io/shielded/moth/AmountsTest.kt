package io.shielded.moth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.math.BigInteger

class AmountsTest {
    @Test
    fun parsesAmountsUpToTheTokensDecimals() {
        assertEquals(BigInteger("1500000"), Amount.parse("1.5", 6))
        assertEquals(BigInteger("500000"), Amount.parse(".5", 6))
        assertEquals(BigInteger("2000000"), Amount.parse(" 2 ", 6))
        assertEquals(BigInteger("1"), Amount.parse("0.000001", 6))
        assertEquals(BigInteger("42"), Amount.parse("42", 0))
    }

    @Test
    fun rejectsAmountsThatAreNotPositiveOrTooPrecise() {
        assertNull(Amount.parse("", 6))
        assertNull(Amount.parse(".", 6))
        assertNull(Amount.parse("0", 6))
        assertNull(Amount.parse("0.0000001", 6))
        assertNull(Amount.parse("1.5", 0))
        assertNull(Amount.parse("-1", 6))
        assertNull(Amount.parse("1,5", 6))
        assertNull(Amount.parse("1e3", 6))
    }

    private val night = "0".repeat(64)
    private val other = "ab".repeat(32)
    private val balances = Balances(
        shielded = mapOf(night to "7", other to "3"),
        unshielded = mapOf(other to "9", night to "5000000", "cd".repeat(32) to "0"),
        dust = "0",
        synced = true,
        progress = emptyMap(),
        dustGeneration = null,
    )

    @Test
    fun unshieldedNightComesFirstAndEmptyTokensAreLeftOut() {
        val list = holdings(balances, night, shielded = false)
        assertEquals(listOf("NIGHT", tokenLabel(other)), list.map { it.name })
        assertEquals("5.000000", list[0].formatted)
        assertEquals("9", list[1].formatted)
    }

    @Test
    fun aShieldedTokenWithNightsIdIsNotNight() {
        val list = holdings(balances, night, shielded = true)
        assertEquals(listOf(tokenLabel(night), tokenLabel(other)), list.map { it.name })
        assertEquals(listOf(0, 0), list.map { it.decimals })
        assertEquals("7", list[0].formatted)
    }
}
