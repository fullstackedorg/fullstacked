package org.fullstacked

import android.net.Uri
import android.os.Handler
import android.os.Looper
import java.util.concurrent.CopyOnWriteArrayList

object AuthManager {
    private val activeActivities = CopyOnWriteArrayList<MainActivity>()
    private var activeMainActivity: MainActivity? = null
    private var activeWebView: FullStackedWebView? = null

    fun registerActivity(activity: MainActivity) {
        if (!activeActivities.contains(activity)) {
            activeActivities.add(activity)
        }
    }

    fun unregisterActivity(activity: MainActivity) {
        activeActivities.remove(activity)
        clearAuthSession(activity = activity)
    }

    @Synchronized
    fun getActiveMainActivity(): MainActivity? = activeMainActivity

    @Synchronized
    fun getActiveWebView(): FullStackedWebView? = activeWebView

    @Synchronized
    fun registerAuthSession(activity: MainActivity, webView: FullStackedWebView) {
        activeMainActivity = activity
        activeWebView = webView
    }

    @Synchronized
    fun clearAuthSession(activity: MainActivity? = null, webView: FullStackedWebView? = null) {
        if (activity == null && webView == null) {
            activeMainActivity = null
            activeWebView = null
            return
        }
        if (activity != null && activeMainActivity == activity) {
            activeMainActivity = null
            activeWebView = null
        }
        if (webView != null && activeWebView == webView) {
            activeMainActivity = null
            activeWebView = null
        }
    }

    fun isAuthRedirect(uri: Uri): Boolean {
        val uriStr = uri.toString()
        if (!uriStr.startsWith("fullstacked://") && !uriStr.startsWith("fullstacked:")) return false

        val pathWithoutScheme = uriStr.removePrefix("fullstacked://").removePrefix("fullstacked:")
        val candidate = pathWithoutScheme.substringBefore('?').substringBefore('#').trimStart('/')

        if (candidate.startsWith("done") ||
            uri.getQueryParameter("token") != null ||
            uri.getQueryParameter("error") != null ||
            uri.fragment?.contains("token=") == true ||
            uri.fragment?.contains("error=") == true
        ) {
            return true
        }
        return false
    }

    @Synchronized
    fun handleAuthRedirect(uri: Uri): Boolean {
        val targetWebView: FullStackedWebView? = activeWebView ?: activeMainActivity?.stackedWebViews?.lastOrNull() ?: activeActivities.lastOrNull()?.stackedWebViews?.lastOrNull()
        val targetActivity: MainActivity? = activeMainActivity ?: targetWebView?.ctx

        activeMainActivity = null
        activeWebView = null

        if (targetWebView == null) {
            return false
        }

        val query: String = (if (!uri.query.isNullOrEmpty()) {
            uri.query
        } else if (!uri.fragment.isNullOrEmpty()) {
            uri.fragment
        } else {
            val raw = uri.toString()
            if (raw.contains("?")) raw.substringAfter("?")
            else if (raw.contains("#")) raw.substringAfter("#")
            else ""
        }) ?: ""

        val error = uri.getQueryParameter("error")
            ?: if (uri.fragment?.contains("error=") == true) {
                Uri.parse("fullstacked://temp?" + uri.fragment).getQueryParameter("error")
            } else null

        val mainLooper = Looper.getMainLooper()
        val handler = Handler(mainLooper)
        handler.post {
            val hostActivity = targetActivity ?: targetWebView.ctx
            if (!hostActivity.isFinishing && !hostActivity.isDestroyed) {
                hostActivity.bringStackedProjectToFront(targetWebView)
            }

            if (error != null) {
                val escapedError = error.replace("\\", "\\\\").replace("`", "\\`")
                targetWebView.webView.evaluateJavascript(
                    "window.postMessage(new Error(`$escapedError`), \"*\")",
                    null
                )
            } else {
                val escapedQuery = query.replace("\\", "\\\\").replace("`", "\\`")
                targetWebView.webView.evaluateJavascript(
                    "window.postMessage(Object.fromEntries(new URLSearchParams(`$escapedQuery`)), \"*\")",
                    null
                )
            }
        }

        return true
    }

    @Synchronized
    fun cancelAuthSessionIfPending(activity: MainActivity): Boolean {
        if (activeMainActivity == activity && activeWebView != null) {
            val targetWebView = activeWebView
            activeMainActivity = null
            activeWebView = null

            val mainLooper = Looper.getMainLooper()
            val handler = Handler(mainLooper)
            handler.post {
                targetWebView?.webView?.evaluateJavascript(
                    "window.postMessage(new Error(`Authentication Canceled`), \"*\")",
                    null
                )
            }
            return true
        }
        return false
    }
}
