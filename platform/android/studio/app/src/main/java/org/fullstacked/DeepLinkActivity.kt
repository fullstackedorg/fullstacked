package org.fullstacked

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle

// Receives fullstacked:// deeplinks: triggers them in every running context,
// or launches the app with the link (MainActivity triggers it once started).
class DeepLinkActivity : Activity() {
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

        val url = data.toString()
        val running = MainActivity.activeActivities.filter { !it.isFinishing && !it.isDestroyed }
        if (running.isEmpty()) {
            startActivity(Intent(this, MainActivity::class.java).apply {
                putExtra(EXTRA_DEEPLINK, url)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            })
            return
        }
        Core.deepLinkAll(url)
        AuthCallbackActivity.bringToFront(this, running.last())
    }
}
