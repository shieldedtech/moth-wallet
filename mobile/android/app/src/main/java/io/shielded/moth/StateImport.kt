package io.shielded.moth

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * Debug builds only: a wallet's sync state, synced on a computer with the moth CLI or TUI and
 * pushed by scripts/push-sync-state.sh, so a restored wallet skips the scan from genesis.
 *
 * The CLI's files (`~/.moth/sync/<network>/<wallet>/<part>.dat`, `witness/...`) use the same
 * keys the engine keeps in its IndexedDB, so they are copied as they are, under this app's
 * wallet name. The state holds the wallet's own addresses; [WalletModel] checks them against
 * the restored phrase before anything is written.
 */
object StateImport {
    class Found(val dir: File, val unshielded: String)

    private fun dir(context: Context, network: String) = File(context.getExternalFilesDir(null), "sync-import/$network")

    fun find(context: Context, network: String): Found? {
        if (!BuildConfig.DEBUG) return null
        val dir = dir(context, network)
        val unshielded = File(dir, "sync/unshielded.dat").takeIf { it.isFile } ?: return null
        val address = runCatching { JSONObject(unshielded.readText()).getJSONObject("publicKey").getString("address") }.getOrNull()
        return address?.let { Found(dir, it) }
    }

    /** Replaces [wallet]'s sync state in the engine with [found]'s, then deletes the pushed files. */
    fun apply(engine: Engine, found: Found, wallet: String, network: String, callback: (Result<Int>) -> Unit) {
        for (kind in listOf("sync", "witness")) {
            File(found.dir, kind).listFiles()?.filter { it.isFile }?.forEach { engine.debugFiles["$kind/$network/$wallet/${it.name}"] = it }
        }
        val prefixes = org.json.JSONArray(listOf("sync/$network/$wallet/", "witness/$network/$wallet/"))
        // Same database, store and value encoding as packages/browser/src/adapters/idb-storage.ts.
        engine.run(
            """
                const db = await new Promise((resolve, reject) => {
                  const r = indexedDB.open('moth', 1);
                  r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv'); };
                  r.onsuccess = () => resolve(r.result);
                  r.onerror = () => reject(r.error);
                });
                const done = (t) => new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = () => reject(t.error); });
                const prefixes = $prefixes;
                const old = await new Promise((resolve) => {
                  const r = db.transaction('kv').objectStore('kv').getAllKeys();
                  r.onsuccess = () => resolve(r.result.filter((k) => prefixes.some((p) => String(k).startsWith(p))));
                });
                const keys = JSON.parse(MothDebugFiles.keys());
                const encoder = new TextEncoder();
                const t = db.transaction('kv', 'readwrite');
                for (const k of old) t.objectStore('kv').delete(k);
                for (const k of keys) t.objectStore('kv').put(encoder.encode(MothDebugFiles.read(k)), k);
                await done(t);
                db.close();
                return keys.length;
            """.trimIndent(),
        ) { r ->
            engine.debugFiles.clear()
            found.dir.deleteRecursively()
            callback(r.mapCatching { (it as Number).toInt() })
        }
    }

    fun discard(context: Context, network: String) {
        dir(context, network).deleteRecursively()
    }
}
