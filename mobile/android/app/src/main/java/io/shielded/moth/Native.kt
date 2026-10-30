package io.shielded.moth

/** libmoth_android.so (native/): moth-native's loopback servers, built into the app. */
object Native {
    init {
        System.loadLibrary("moth_android")
    }

    /** Gives the prover's TLS (rustls-platform-verifier) the app context, for downloading proving keys. Call before [proverStart]. */
    external fun initTls(context: android.content.Context): Boolean

    /** Starts the proof server on 127.0.0.1:[port]. Keys missing from [paramsDir] are downloaded there. Returns the port, or -1. */
    external fun proverStart(paramsDir: String, port: Int, workers: Int): Int

    /** Serves the engine page from [dir] on 127.0.0.1:[port]. Returns the port, or -1. */
    external fun staticStart(dir: String, port: Int): Int
}
