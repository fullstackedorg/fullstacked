package org.fullstacked

import android.Manifest
import android.content.pm.PackageManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

/**
 * Passes a page's camera, microphone and location requests on to Android.
 *
 * The webview doesn't ask Android itself: without these overrides it denies the page silently.
 * Here the page asks (getUserMedia, navigator.geolocation), Android shows its own dialog,
 * and the page gets what the user chose. No prompt of our own, and none at all once the app
 * holds the permission. Registered in MainActivity.onCreate (an activity result launcher has
 * to be), shared by every webview of the activity, stacked projects included.
 */
class WebPermissions(private val activity: ComponentActivity) {
    private class Pending(val permissions: List<String>, val done: (Set<String>) -> Unit)

    // Android shows one permission dialog at a time
    private val queue = ArrayDeque<Pending>()
    private var current: Pending? = null

    private val launcher = activity.registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        val pending = current
        current = null
        pending?.done?.invoke(pending.permissions.filter(::held).toSet())
        next()
    }

    private fun held(permission: String) =
        ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED

    /** Asks Android for the ones the app doesn't hold yet; done gets the ones it holds after. */
    private fun request(permissions: List<String>, done: (Set<String>) -> Unit) {
        if (permissions.all(::held)) return done(permissions.toSet())
        queue.addLast(Pending(permissions, done))
        next()
    }

    private fun next() {
        if (current != null) return
        val pending = queue.removeFirstOrNull() ?: return
        current = pending
        launcher.launch(pending.permissions.filterNot(::held).toTypedArray())
    }

    /** getUserMedia: the video and audio capture the user allowed, the rest denied. */
    fun onPermissionRequest(request: PermissionRequest) {
        val wanted = request.resources.mapNotNull { resource ->
            when (resource) {
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> resource to Manifest.permission.CAMERA
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> resource to Manifest.permission.RECORD_AUDIO
                else -> null
            }
        }
        if (wanted.isEmpty()) return request.deny()
        request(wanted.map { it.second }.distinct()) { granted ->
            val resources = wanted.filter { it.second in granted }.map { it.first }
            if (resources.isEmpty()) request.deny() else request.grant(resources.toTypedArray())
        }
    }

    /**
     * navigator.geolocation. Android's dialog offers precise or approximate: either one is
     * enough, so a user who chose approximate isn't asked again on every call.
     */
    fun onGeolocation(origin: String?, callback: GeolocationPermissions.Callback?) {
        val location = listOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )
        if (location.any(::held)) return callback?.invoke(origin, true, false) ?: Unit
        request(location) { granted -> callback?.invoke(origin, granted.isNotEmpty(), false) }
    }
}
