package org.fullstacked

import android.app.Activity
import android.app.UiModeManager
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.ByteArrayInputStream
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.zip.ZipInputStream

const val EXTRA_CTX_ID = "ctxId"

class MainActivity : ComponentActivity() {
    companion object {
        init {
            try {
                System.loadLibrary("core")
            } catch (_: Exception) { }
            System.loadLibrary("fullstacked-android")
        }
    }

    val stackedWebViews = CopyOnWriteArrayList<FullStackedWebView>()
    private var activeAuthWebView: FullStackedWebView? = null

    lateinit var root: String
        private set

    fun getRootPath(): String = root

    private external fun addCallback(id: Int)
    private external fun removeCallback(id: Int)

    private val callbackId = (0..9999).random()

    fun onStreamData(ctx: Int, id: Int, size: Int) {
        val targetWebView = stackedWebViews.firstOrNull { (it.ctxId.toInt() and 0xFF) == ctx } ?: return
        val buffer = Core.getCorePayload(ctx, 2, id, size)
        targetWebView.onStreamData(id, buffer)
    }

    private fun setDirectories() {
        // Context initialization is now managed per Instance via start / startWithCtx
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        root = this.filesDir.absolutePath + "/projects"

        val mainBuildDir = getMainLocation()

        try {
            this.addCallback(callbackId)
        } catch (e: Exception) {
            e.printStackTrace()
        }

        this.setDirectories()

        val providedCtxId = if (intent.hasExtra(EXTRA_CTX_ID)) {
            val id = intent.getIntExtra(EXTRA_CTX_ID, -1)
            if (id >= 0) id else null
        } else {
            val data: Uri? = intent?.data
            if (data != null && data.toString().isNotEmpty()) {
                val urlStr = data.toString()
                if (urlStr.startsWith("fullstacked-ctx://") || urlStr.startsWith("fullstacked-ctx:")) {
                    val path = urlStr.removePrefix("fullstacked-ctx://").removePrefix("fullstacked-ctx:")
                    val candidate = path.substringBefore('?').substringBefore('#').trimStart('/')
                    candidate.toIntOrNull()
                } else {
                    null
                }
            } else {
                null
            }
        }

        this.fileChooserResultLauncher = this.createFileChooserResultLauncher()

        if (providedCtxId != null && providedCtxId >= 0) {
            // Bind to provided ctxId (multi-window intent response)
            val webView = FullStackedWebView(this, ctxId = providedCtxId.toByte())
            this.stackedWebViews.add(webView)
        } else {
            // Create default app context using out directory from mainBuildDir
            val defaultCtxId = Core.startMain(root, mainBuildDir, null)
            val webView = FullStackedWebView(this, ctxId = defaultCtxId.toByte())
            this.stackedWebViews.add(webView)
        }

        AuthManager.registerActivity(this)

        this.updateActiveContentView()
        this.handleIntent(intent)

        this.onBackPressedDispatcher.addCallback {
            stackedWebViews.lastOrNull()?.webView?.evaluateJavascript("globalThis.back?.()", null)
        }.isEnabled = true
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var pendingCancelRunnable: Runnable? = null

    override fun onResume() {
        super.onResume()
        pendingCancelRunnable?.let { mainHandler.removeCallbacks(it) }
        val r = Runnable {
            AuthManager.cancelAuthSessionIfPending(this)
        }
        pendingCancelRunnable = r
        mainHandler.postDelayed(r, 600)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        pendingCancelRunnable?.let { mainHandler.removeCallbacks(it) }
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        val data: Uri = intent?.data ?: return
        if (AuthManager.isAuthRedirect(data)) {
            AuthManager.handleAuthRedirect(data)
            return
        }

        val urlStr = data.toString()
        if (!urlStr.startsWith("fullstacked-ctx://") && !urlStr.startsWith("fullstacked-ctx:")) return

        val pathWithoutScheme = urlStr.removePrefix("fullstacked-ctx://").removePrefix("fullstacked-ctx:")
        val candidate = pathWithoutScheme.substringBefore('?').substringBefore('#').trimStart('/')
        val ctxId = candidate.toIntOrNull() ?: if (intent.hasExtra(EXTRA_CTX_ID)) intent.getIntExtra(EXTRA_CTX_ID, -1) else null
        if (ctxId != null && ctxId >= 0) {
            val exists = stackedWebViews.any { (it.ctxId.toInt() and 0xFF) == ctxId }
            if (!exists) {
                val webView = FullStackedWebView(this, ctxId = ctxId.toByte())
                addStackedProject(webView)
            }
        }
    }

    private var lastOpenUrlTime: Long = 0L
    private var lastOpenUrl: String? = null
    private var lastAuthOpenTime: Long = 0L

    fun openAuthSession(originatingWebView: FullStackedWebView, uri: Uri) {
        val now = System.currentTimeMillis()
        if (now - lastAuthOpenTime < 1000L) {
            return
        }
        lastAuthOpenTime = now

        activeAuthWebView = originatingWebView
        AuthManager.registerAuthSession(this, originatingWebView)

        var builder = uri.buildUpon()
        if (uri.getQueryParameter("auth") == null) {
            builder = builder.appendQueryParameter("auth", "1")
        }
        if (uri.getQueryParameter("native") == null) {
            builder = builder.appendQueryParameter("native", "1")
        }
        val authUri = builder.build()

        val customTabsIntent = CustomTabsIntent.Builder()
            .setShowTitle(true)
            .build()

        try {
            customTabsIntent.launchUrl(this, authUri)
        } catch (_: Exception) {
            val intent = Intent(Intent.ACTION_VIEW, authUri)
            startActivity(intent)
        }
    }

    fun openUrl(originatingWebView: FullStackedWebView? = null, url: String) {
        runOnUiThread {
            val now = System.currentTimeMillis()
            if (url == lastOpenUrl && now - lastOpenUrlTime < 1000L) {
                return@runOnUiThread
            }
            lastOpenUrl = url
            lastOpenUrlTime = now

            val uri = Uri.parse(url)
            val scheme = uri.scheme?.lowercase()
            if (scheme == "fullstacked-ctx") {
                val pathWithoutScheme = url.removePrefix("fullstacked-ctx://").removePrefix("fullstacked-ctx:")
                val candidate = pathWithoutScheme.substringBefore('?').substringBefore('#').trimStart('/')
                val targetCtx = candidate.toIntOrNull()
                if (targetCtx != null && targetCtx >= 0) {
                    openContextWindow(targetCtx)
                    return@runOnUiThread
                }
            }

            val isAuthRequest = uri.getQueryParameter("auth") != null
            val targetWebView = originatingWebView ?: stackedWebViews.lastOrNull()

            if (isAuthRequest && targetWebView != null) {
                openAuthSession(targetWebView, uri)
            } else {
                val intent = Intent(Intent.ACTION_VIEW, uri)
                startActivity(intent)
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        AuthManager.unregisterActivity(this)
        try {
            removeCallback(callbackId)
        } catch (e: Exception) {
            e.printStackTrace()
        }

        this.removeAllStackedProjects()
    }

    fun getMainLocation(): String {
        val outDir = File(this.filesDir, "out")
        if (!outDir.exists()) {
            outDir.mkdirs()
        }

        val currentVersion = try {
            val pInfo = packageManager.getPackageInfo(packageName, 0)
            val vName = pInfo.versionName ?: "1.0.0"
            val vCode = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                pInfo.longVersionCode
            } else {
                @Suppress("DEPRECATION")
                pInfo.versionCode.toLong()
            }
            "$vName-$vCode"
        } catch (_: Exception) {
            "1.0.0-1"
        }

        val prefs = getSharedPreferences("app_version_prefs", MODE_PRIVATE)
        val stashedVersion = prefs.getString("last_decompressed_version", null)

        val buildFile = File(outDir, "build.txt")
        val buildFileContent = if (buildFile.exists()) buildFile.readText().trim() else null

        val isDebug = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        val needsDecompression = isDebug ||
                stashedVersion != currentVersion ||
                buildFileContent != currentVersion

        if (needsDecompression) {
            val zipData = try {
                resources.openRawResource(R.raw.out).use { it.readBytes() }
            } catch (e: Exception) {
                null
            }

            if (zipData != null) {
                val unzipped = try {
                    val zis = ZipInputStream(ByteArrayInputStream(zipData))
                    var entry = zis.nextEntry
                    while (entry != null) {
                        val file = File(outDir, entry.name)
                        if (entry.isDirectory) {
                            file.mkdirs()
                        } else {
                            file.parentFile?.mkdirs()
                            file.outputStream().use { zis.copyTo(it) }
                        }
                        zis.closeEntry()
                        entry = zis.nextEntry
                    }
                    zis.close()
                    true
                } catch (e: Exception) {
                    e.printStackTrace()
                    false
                }

                if (unzipped) {
                    prefs.edit().putString("last_decompressed_version", currentVersion).apply()
                    try {
                        buildFile.writeText(currentVersion)
                    } catch (_: Exception) { }
                }
            }
        }

        return outDir.absolutePath
    }

    fun updateActiveContentView() {
        val currentWebView = stackedWebViews.lastOrNull()
        if (currentWebView == null) {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.LOLLIPOP) {
                finishAndRemoveTask()
            } else {
                finish()
            }
            return
        }

        val rootLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.BLACK)
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        (currentWebView.webView.parent as? ViewGroup)?.removeView(currentWebView.webView)

        var topBar: FrameLayout? = null
        if (stackedWebViews.size > 1) {
            val density = resources.displayMetrics.density

            topBar = FrameLayout(this).apply {
                setBackgroundColor(Color.BLACK)
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
            }

            val closeButton = TextView(this).apply {
                text = "✕"
                textSize = 16f
                setTextColor(Color.WHITE)
                gravity = Gravity.CENTER
                val padH = (12 * density).toInt()
                val padV = (4 * density).toInt()
                setPadding(padH, padV, padH, padV)
                setOnClickListener {
                    removeStackedProject(currentWebView)
                }
            }

            val btnParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                gravity = Gravity.END or Gravity.CENTER_VERTICAL
            }

            topBar.addView(closeButton, btnParams)
            rootLayout.addView(topBar)
        }

        val webViewParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            0,
            1.0f
        )
        rootLayout.addView(currentWebView.webView, webViewParams)

        ViewCompat.setOnApplyWindowInsetsListener(rootLayout) { _, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val density = resources.displayMetrics.density
            if (topBar != null) {
                topBar.setPadding(
                    systemBars.left + (4 * density).toInt(),
                    systemBars.top + (2 * density).toInt(),
                    systemBars.right + (4 * density).toInt(),
                    (2 * density).toInt()
                )
                rootLayout.setPadding(0, 0, 0, systemBars.bottom)
            } else {
                rootLayout.setPadding(
                    systemBars.left,
                    systemBars.top,
                    systemBars.right,
                    systemBars.bottom
                )
            }
            insets
        }

        setContentView(rootLayout)
    }

    fun openContextWindow(targetCtxId: Int) {
        runOnUiThread {
            if (useMultiWindow()) {
                val intent = Intent(this, MainActivity::class.java).apply {
                    action = Intent.ACTION_VIEW
                    data = Uri.parse("fullstacked-ctx://$targetCtxId")
                    putExtra(EXTRA_CTX_ID, targetCtxId)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT)
                    addFlags(Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    addFlags(Intent.FLAG_ACTIVITY_LAUNCH_ADJACENT)
                }

                val options = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                    val currentDisplayId = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
                        this.display?.displayId ?: android.view.Display.DEFAULT_DISPLAY
                    } else {
                        @Suppress("DEPRECATION")
                        windowManager.defaultDisplay.displayId
                    }
                    android.app.ActivityOptions.makeBasic().apply {
                        setLaunchDisplayId(currentDisplayId)
                    }.toBundle()
                } else if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N) {
                    android.app.ActivityOptions.makeBasic().toBundle()
                } else {
                    null
                }

                startActivity(intent, options)
            } else {
                val stacked = FullStackedWebView(this, ctxId = targetCtxId.toByte())
                addStackedProject(stacked)
            }
        }
    }

    fun addStackedProject(stackedWebView: FullStackedWebView) {
        this.stackedWebViews.add(stackedWebView)
        this.updateActiveContentView()
    }

    fun bringStackedProjectToFront(target: FullStackedWebView) {
        runOnUiThread {
            if (stackedWebViews.contains(target)) {
                if (stackedWebViews.lastOrNull() != target) {
                    stackedWebViews.remove(target)
                    stackedWebViews.add(target)
                    updateActiveContentView()
                }
            }
        }
    }

    fun removeStackedProject(target: FullStackedWebView? = null) {
        val viewToRemove = target ?: this.stackedWebViews.lastOrNull()
        if (viewToRemove != null) {
            this.stackedWebViews.remove(viewToRemove)
            viewToRemove.destroyView()
        }

        this.updateActiveContentView()
    }

    fun removeAllStackedProjects() {
        for (stacked in this.stackedWebViews) {
            stacked.destroyView()
        }
        this.stackedWebViews.clear()
    }

    lateinit var fileChooserResultLauncher: ActivityResultLauncher<Intent>
    var fileChooserValueCallback: ValueCallback<Array<Uri>>? = null
    private fun createFileChooserResultLauncher(): ActivityResultLauncher<Intent> {
        return this.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            if (it.resultCode == Activity.RESULT_OK) {
                fileChooserValueCallback?.onReceiveValue(arrayOf(Uri.parse(it?.data?.dataString)))
            } else {
                fileChooserValueCallback?.onReceiveValue(null)
            }
        }
    }

    fun useMultiWindow(): Boolean {
        return isChromebook() || isSamsungDexActive()
    }

    private fun isChromebook(): Boolean {
        if (this.packageManager.hasSystemFeature("org.chromium.arc") ||
            this.packageManager.hasSystemFeature("org.chromium.arc.device_management") ||
            this.packageManager.hasSystemFeature("org.chromium.arc.intent_helper")
        ) {
            return true
        }
        val brand = android.os.Build.BRAND ?: ""
        val manufacturer = android.os.Build.MANUFACTURER ?: ""
        val device = android.os.Build.DEVICE ?: ""
        if (device.contains("cheets", ignoreCase = true) ||
            brand.equals("chromium", ignoreCase = true) ||
            manufacturer.equals("Chromium", ignoreCase = true) ||
            (brand.equals("google", ignoreCase = true) && device.contains("chrome", ignoreCase = true))
        ) {
            return true
        }
        return false
    }

    private fun isSamsungDexActive(): Boolean {
        val config = this.resources.configuration

        // 1. Desk UI Mode on Configuration or UiModeManager (Samsung DeX sets UI_MODE_TYPE_DESK)
        if ((config.uiMode and Configuration.UI_MODE_TYPE_MASK) == Configuration.UI_MODE_TYPE_DESK) {
            return true
        }
        val uim = this.getSystemService(UI_MODE_SERVICE) as? UiModeManager
        if (uim?.currentModeType == Configuration.UI_MODE_TYPE_DESK) {
            return true
        }

        // 2. Samsung DeX Mode check via semDesktopModeEnabled (1 = standalone, 2 = dual/external)
        try {
            val configClass: Class<*> = config.javaClass
            val field = configClass.getDeclaredField("semDesktopModeEnabled")
            field.isAccessible = true
            val value = field.getInt(config)
            if (value == 1 || value == 2) {
                return true
            }
        } catch (_: Exception) { }

        // 3. Samsung DeX via semIsDesktopMode() method
        try {
            val method = config.javaClass.getDeclaredMethod("semIsDesktopMode")
            method.isAccessible = true
            val result = method.invoke(config) as? Boolean
            if (result == true) {
                return true
            }
        } catch (_: Exception) { }

        // 4. Samsung DesktopModeManager service state
        try {
            val desktopModeManager = getSystemService("desktopmode")
            if (desktopModeManager != null) {
                val method = desktopModeManager.javaClass.getMethod("getDesktopModeState")
                val state = method.invoke(desktopModeManager)
                if (state != null) {
                    val stateStr = state.toString().uppercase()
                    val getEnabledMethod = state.javaClass.getMethod("getEnabled")
                    val enabled = getEnabledMethod.invoke(state) as? Int
                    val isEnabledVal = enabled != null && enabled != 0 && enabled != -1
                    if (isEnabledVal && (stateStr.contains("ENABLE") || stateStr.contains("DUAL") || stateStr.contains("STANDALONE") || stateStr.contains("DEX"))) {
                        return true
                    }
                }
            }
        } catch (_: Exception) { }

        // 5. Configuration string containing active desktop flags
        try {
            val configLower = config.toString().lowercase()
            if (configLower.contains("desktop/e") ||
                configLower.contains("semdesktopmodeenabled=1") ||
                configLower.contains("semdesktopmodeenabled=2") ||
                configLower.contains("dexmode=1") ||
                configLower.contains("dexmode=2") ||
                configLower.contains("dexmode=3")
            ) {
                return true
            }
        } catch (_: Exception) { }

        // 6. Active Samsung DeX System / Global / Secure settings
        try {
            if (android.provider.Settings.System.getInt(contentResolver, "sem_desktop_mode_enabled", 0) in 1..2) return true
            if (android.provider.Settings.Global.getInt(contentResolver, "sem_desktop_mode_enabled", 0) in 1..2) return true
            if (android.provider.Settings.Secure.getInt(contentResolver, "sem_desktop_mode_enabled", 0) in 1..2) return true
            if (android.provider.Settings.System.getInt(contentResolver, "desktop_mode", 0) in 1..2) return true
            if (android.provider.Settings.Global.getInt(contentResolver, "desktop_mode", 0) in 1..2) return true
            if (android.provider.Settings.Secure.getInt(contentResolver, "desktop_mode", 0) in 1..2) return true
        } catch (_: Exception) { }

        // 7. Samsung System Properties via reflection
        try {
            val systemProperties = Class.forName("android.os.SystemProperties")
            val getProp = systemProperties.getMethod("get", String::class.java)
            val dexProp = (getProp.invoke(null, "sys.desktop.mode") as? String)?.lowercase()
            if (dexProp == "1" || dexProp == "true" || dexProp == "dual" || dexProp == "standalone" || dexProp == "dex") {
                return true
            }
        } catch (_: Exception) { }

        // 8. Secondary display check on Samsung devices (external monitor / wireless DeX)
        try {
            val isSamsung = android.os.Build.MANUFACTURER?.contains("samsung", ignoreCase = true) == true ||
                android.os.Build.BRAND?.contains("samsung", ignoreCase = true) == true
            if (isSamsung) {
                val display = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
                    this.display
                } else {
                    @Suppress("DEPRECATION")
                    windowManager.defaultDisplay
                }
                if (display != null && display.displayId != android.view.Display.DEFAULT_DISPLAY) {
                    return true
                }
            }
        } catch (_: Exception) { }

        return false
    }
}