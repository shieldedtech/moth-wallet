package io.shielded.moth

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject

/**
 * Hosts moth's engine page (mobile/ios/engine, unchanged) in a WebView and calls its
 * `window.moth` API. The page is served by the in-app static server, so its origin is fixed
 * and its IndexedDB wallet storage persists across launches.
 *
 * The engine was written against WKWebView: it posts events to
 * `window.webkit.messageHandlers.moth`. A document-start script gives it that object here,
 * backed by the [Bridge] JavaScript interface.
 */
class Engine(context: Context, private val onEvent: (event: String, data: Any?) -> Unit) {
    companion object {
        const val ORIGIN = "http://127.0.0.1:8765"
    }

    val webView = WebView(context)
    private val main = Handler(Looper.getMainLooper())
    private var nextId = 1
    private val pending = HashMap<Int, (Result<Any?>) -> Unit>()
    private val whenReady = ArrayList<() -> Unit>()
    var ready = false
        private set

    init {
        WebView.setWebContentsDebuggingEnabled(true)
        @SuppressLint("SetJavaScriptEnabled")
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.databaseEnabled = true
        webView.addJavascriptInterface(Bridge(), "MothAndroid")
        // Interfaces only appear on the next page load, so the debug one is added up front.
        if (BuildConfig.DEBUG) webView.addJavascriptInterface(DebugFiles(), "MothDebugFiles")
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.i("MothEngine", "${m.messageLevel()} ${m.sourceId().substringAfterLast('/')}:${m.lineNumber()} ${m.message()}")
                return true
            }
        }
        check(WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) { "This WebView cannot run document-start scripts" }
        WebViewCompat.addDocumentStartJavaScript(
            webView,
            "window.webkit = { messageHandlers: { moth: { postMessage: (e) => MothAndroid.event(JSON.stringify(e)) } } };",
            setOf(ORIGIN),
        )
        webView.loadUrl("$ORIGIN/index.html")
    }

    /** Calls `window.moth[function](...args)`; [function] may be dotted. The callback runs on the main thread. */
    fun call(function: String, args: List<Any?> = emptyList(), callback: (Result<Any?>) -> Unit) = run(
        """
            const keys = ${JSONObject.quote(function)}.split('.');
            let target = window.moth;
            for (const k of keys.slice(0, -1)) target = target[k];
            return await target[keys.at(-1)](...${JSONArray(args)});
        """.trimIndent(),
        callback,
    )

    /** Runs [body] as an async function in the engine page and returns its result. */
    fun run(body: String, callback: (Result<Any?>) -> Unit) {
        if (!ready) {
            whenReady.add { run(body, callback) }
            return
        }
        val id = nextId++
        pending[id] = callback
        val script = """
            (async () => {
              let r;
              try {
                const v = await (async () => {
                  $body
                })();
                r = { ok: true, value: v === undefined ? null : v };
              } catch (e) {
                r = { ok: false, error: String((e && e.message) || e) };
              }
              MothAndroid.result($id, JSON.stringify(r, (k, v) => typeof v === 'bigint' ? String(v) : v));
            })();
        """.trimIndent()
        webView.evaluateJavascript(script, null)
    }

    /** Files a debug build offers the page by key; see [StateImport]. Empty unless an import runs. */
    val debugFiles = java.util.concurrent.ConcurrentHashMap<String, java.io.File>()

    private inner class DebugFiles {
        @JavascriptInterface
        fun keys(): String = JSONArray(debugFiles.keys.toList()).toString()

        @JavascriptInterface
        fun read(key: String): String? = debugFiles[key]?.readText()
    }

    private inner class Bridge {
        @JavascriptInterface
        fun event(json: String) {
            main.post {
                val message = JSONObject(json)
                val event = message.getString("event")
                val data = message.opt("data").takeUnless { it == JSONObject.NULL }
                if (event == "ready") {
                    ready = true
                    whenReady.forEach { it() }
                    whenReady.clear()
                }
                onEvent(event, data)
            }
        }

        @JavascriptInterface
        fun result(id: Int, json: String) {
            main.post {
                val callback = pending.remove(id) ?: return@post
                val reply = JSONObject(json)
                if (reply.getBoolean("ok")) callback(Result.success(reply.opt("value").takeUnless { it == JSONObject.NULL }))
                else callback(Result.failure(Exception(reply.optString("error", "engine call failed"))))
            }
        }
    }
}
