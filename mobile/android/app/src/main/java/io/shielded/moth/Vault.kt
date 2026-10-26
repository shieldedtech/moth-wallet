package io.shielded.moth

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import android.util.Log
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class VaultException(message: String, val canceled: Boolean = false) : Exception(message)

/**
 * Holds each wallet's keystore passphrase, encrypted under a per-wallet AES-256-GCM key in the
 * Android Keystore. Android port of iOS `Vault` (mobile/ios/Moth/Wallet/Vault.swift).
 *
 * - The key is hardware-backed (StrongBox when the phone has it) and never leaves it.
 * - Every use of the key needs the user: a strong biometric (fingerprint) or the device
 *   PIN/pattern/password, as iOS `.userPresence` (Face ID or passcode). Re-enrolling a
 *   fingerprint keeps the key, as on iOS.
 * - The key is usable only while the device is unlocked, and is lost if the screen lock is
 *   removed (the iOS `WhenPasscodeSetThisDeviceOnly` equivalent). Nothing is backed up
 *   (`allowBackup=false`); the recovery phrase is the backup.
 * - A key is never replaced: an existing one may be the only way into an older keystore.
 *
 * The passphrase is 32 random bytes the user never sees. Moth's keystore encrypts the recovery
 * phrase with it (scrypt + AES-GCM, in the engine's IndexedDB).
 */
object Vault {
    private const val PROVIDER = "AndroidKeyStore"
    private const val PREFS = "moth-vault"
    private const val ALLOWED = BIOMETRIC_STRONG or DEVICE_CREDENTIAL

    private fun alias(wallet: String) = "io.shielded.moth.keystore.$wallet"
    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private fun keyStore() = KeyStore.getInstance(PROVIDER).apply { load(null) }

    /** Whether a passphrase is stored for [wallet], checked without prompting. */
    fun exists(context: Context, wallet: String): Boolean =
        prefs(context).contains(wallet) && keyStore().containsAlias(alias(wallet))

    /**
     * Creates and stores a fresh passphrase for [wallet], asking for a fingerprint or the device
     * PIN to encrypt it. Fails if one already exists.
     */
    fun create(activity: FragmentActivity, wallet: String, callback: (Result<String>) -> Unit) {
        val passphrase = ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        store(activity, wallet, passphrase, "Protect your new Moth wallet", callback)
    }

    /** Moves an existing passphrase (the spike's old plain-text one) into the vault. */
    fun adopt(activity: FragmentActivity, wallet: String, passphrase: String, callback: (Result<String>) -> Unit) =
        store(activity, wallet, passphrase, "Protect your Moth wallet with your fingerprint", callback)

    private fun store(activity: FragmentActivity, wallet: String, passphrase: String, title: String, callback: (Result<String>) -> Unit) {
        if (prefs(activity).contains(wallet) || keyStore().containsAlias(alias(wallet))) {
            return callback(Result.failure(VaultException("A key for \"$wallet\" already exists on this device; Moth never replaces one.")))
        }
        val cipher = try {
            Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, generateKey(wallet)) }
        } catch (e: Exception) {
            keyStore().deleteEntry(alias(wallet))
            return callback(Result.failure(VaultException("Could not create a Keystore key: ${e.message}")))
        }
        prompt(activity, title, cipher) { r ->
            callback(r.mapCatching { c ->
                val sealed = c.doFinal(passphrase.toByteArray())
                val blob = Base64.encodeToString(c.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(sealed, Base64.NO_WRAP)
                // commit(), not apply(): the wallet must not be created until the key is on disk.
                check(prefs(activity).edit().putString(wallet, blob).commit()) { "could not save the encrypted key" }
                passphrase
            }.onFailure {
                // A key without its ciphertext is useless, and would block a retry.
                if (!prefs(activity).contains(wallet)) keyStore().deleteEntry(alias(wallet))
            })
        }
    }

    /** Reads [wallet]'s passphrase, asking for a fingerprint or the device PIN. */
    fun passphrase(activity: FragmentActivity, wallet: String, reason: String, callback: (Result<String>) -> Unit) {
        val blob = prefs(activity).getString(wallet, null)
        val key = keyStore().getKey(alias(wallet), null) as? SecretKey
        if (blob == null || key == null) {
            return callback(Result.failure(VaultException("This wallet's key is missing from this phone. Restore it from its recovery phrase.")))
        }
        val (iv, sealed) = blob.split(":").map { Base64.decode(it, Base64.NO_WRAP) }
        val cipher = try {
            Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv)) }
        } catch (e: android.security.keystore.KeyPermanentlyInvalidatedException) {
            return callback(Result.failure(VaultException("This wallet's key was invalidated because the screen lock was removed. Restore it from its recovery phrase.")))
        }
        prompt(activity, reason, cipher) { r -> callback(r.mapCatching { String(it.doFinal(sealed)) }) }
    }

    private fun generateKey(wallet: String): SecretKey {
        fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(alias(wallet), KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            // 0 seconds: every use needs its own authentication, bound to this cipher.
            .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
            .setInvalidatedByBiometricEnrollment(false)
            .setUnlockedDeviceRequired(true)
            .setIsStrongBoxBacked(strongBox)
            .build()
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        return try {
            generator.init(spec(strongBox = Build.VERSION.SDK_INT >= 28))
            generator.generateKey().also { Log.i("MothSpike", "vault: key for $wallet in StrongBox") }
        } catch (e: StrongBoxUnavailableException) {
            generator.init(spec(strongBox = false))
            generator.generateKey().also { Log.i("MothSpike", "vault: key for $wallet in TEE (no StrongBox)") }
        }
    }

    private fun prompt(activity: FragmentActivity, title: String, cipher: Cipher, callback: (Result<Cipher>) -> Unit) {
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setSubtitle("Moth")
            .setAllowedAuthenticators(ALLOWED)
            .build()
        val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                val c = result.cryptoObject?.cipher
                callback(if (c != null) Result.success(c) else Result.failure(VaultException("The Keystore returned no cipher")))
            }

            override fun onAuthenticationError(code: Int, message: CharSequence) {
                val canceled = code in setOf(
                    BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_NEGATIVE_BUTTON, BiometricPrompt.ERROR_CANCELED,
                )
                callback(Result.failure(VaultException(if (canceled) "Unlock was canceled." else message.toString(), canceled)))
            }
            // onAuthenticationFailed (a fingerprint not recognised) keeps the prompt open; nothing to do.
        })
        prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }
}
