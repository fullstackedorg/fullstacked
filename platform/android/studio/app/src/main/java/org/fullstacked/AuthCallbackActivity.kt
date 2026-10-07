package org.fullstacked

import android.app.Activity
import android.app.ActivityManager
import android.content.Intent
import android.net.Uri
import android.os.Bundle

class AuthCallbackActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleIntent(intent)
        finish()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        handleIntent(intent)
        finish()
    }

    private fun handleIntent(intent: Intent?) {
        val data: Uri = intent?.data ?: return

        // fullstacked:// links that are not auth redirects are deeplinks
        if (!AuthManager.isAuthRedirect(data)) {
            handleDeepLink(data.toString())
            return
        }

        val originatingActivity = AuthManager.getActiveMainActivity()
        val originatingWebView = AuthManager.getActiveWebView()
        val targetActivity = originatingActivity ?: originatingWebView?.ctx

        AuthManager.handleAuthRedirect(data)
        bringToFront(targetActivity)
    }

    // Triggers the deeplink in every running context, or launches the app with it.
    private fun handleDeepLink(url: String) {
        val running = MainActivity.activeActivities.filter { !it.isFinishing && !it.isDestroyed }
        if (running.isEmpty()) {
            startActivity(Intent(this, MainActivity::class.java).apply {
                putExtra(EXTRA_DEEPLINK, url)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            })
            return
        }
        Core.deepLinkAll(url)
        bringToFront(running.last())
    }

    private fun bringToFront(targetActivity: MainActivity?) {
        if (targetActivity != null && !targetActivity.isFinishing && !targetActivity.isDestroyed) {
            try {
                val am = getSystemService(ACTIVITY_SERVICE) as? ActivityManager
                am?.moveTaskToFront(targetActivity.taskId, ActivityManager.MOVE_TASK_WITH_HOME)
            } catch (_: Exception) { }

            try {
                val bringToFrontIntent = Intent(targetActivity.intent).apply {
                    component = targetActivity.componentName
                    flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                }
                targetActivity.startActivity(bringToFrontIntent)
            } catch (_: Exception) { }
        }
    }
}
