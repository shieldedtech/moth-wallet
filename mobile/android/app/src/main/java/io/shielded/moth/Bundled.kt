package io.shielded.moth

import android.content.Context
import android.content.res.AssetManager
import java.io.File

/** Extracts a bundled asset tree to the app's files directory, once per installed build. */
object Bundled {
    fun extract(context: Context, asset: String): File {
        val dest = File(context.filesDir, asset)
        val stamp = File(context.filesDir, "$asset.stamp")
        val version = context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime.toString()
        if (dest.isDirectory && stamp.exists() && stamp.readText() == version) return dest
        dest.deleteRecursively()
        copy(context.assets, asset, dest)
        stamp.writeText(version)
        return dest
    }

    private fun copy(assets: AssetManager, path: String, dest: File) {
        val children = assets.list(path) ?: emptyArray()
        if (children.isEmpty()) {
            dest.parentFile?.mkdirs()
            assets.open(path).use { input -> dest.outputStream().use { output -> input.copyTo(output) } }
        } else {
            dest.mkdirs()
            for (child in children) copy(assets, "$path/$child", File(dest, child))
        }
    }
}
