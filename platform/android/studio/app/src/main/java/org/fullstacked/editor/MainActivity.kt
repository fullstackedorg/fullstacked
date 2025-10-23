package org.fullstacked.editor

import android.app.Activity
import android.app.UiModeManager
import android.content.Intent
import android.content.SharedPreferences.OnSharedPreferenceChangeListener
import android.content.res.Configuration
import android.content.res.Configuration.UI_MODE_TYPE_DESK
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.ValueCallback
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import java.io.File

val buildTimestampPreferenceKey = "project-build-ts"

class MainActivity() : ComponentActivity() {
    companion object {
        init {
            System.loadLibrary("editor-core")
        }
    }

    var editorWebViewComponent: WebViewComponent? = null
    var stackedProjectWebViewComponent: WebViewComponent? = null
    val projectsIdsInExternal = mutableListOf<String>()

    var onSharedPreferenceChangeListeners = mutableMapOf<String, OnSharedPreferenceChangeListener>()

    private lateinit var root: String
    private lateinit var config: String
    private lateinit var editor: String
    private lateinit var tmp: String

    private external fun directories(
        root: String,
        config: String,
        editor: String,
        tmp: String,
    )

    private external fun addCallback(id: Int)
    private external fun removeCallback(id: Int)

    private val callbackId = (0..9999).random()

    fun Callback(projectId: String, messageType: String, message: String) {
        println("RECEIVED CORE MESSAGE FOR [$projectId] [$messageType]")

        if(projectId == "*") {
            this.editorWebViewComponent?.onMessage(messageType, message)
            this.stackedProjectWebViewComponent?.onMessage(messageType, message)
        } else if(projectId == "") {
            if(this.editorWebViewComponent == null) return

            // open project
            if(messageType == "open") {
                val mainLooper = Looper.getMainLooper()
                val handler = Handler(mainLooper)
                handler.post {
                    val ts = System.currentTimeMillis()
                    println("BUILD TIMESTAMP [$message] [$ts]")
                    val sharedPreferences = this.getSharedPreferences(buildTimestampPreferenceKey, MODE_PRIVATE)
                    val editor = sharedPreferences.edit()
                    editor.putLong(message, ts)
                    editor.apply()

                    if(this.useMultiWindow()) {
                        this.openProjectInAdjacentWindow(message)
                    } else {
                        if(stackedProjectWebViewComponent != null) {
                            this.removeStackedProject()
                        }

                        if(editorWebViewComponent != null) {
                            (editorWebViewComponent?.webView?.parent as ViewGroup).removeView(editorWebViewComponent?.webView)
                        }

                        stackedProjectWebViewComponent = WebViewComponent(this, Instance(message))
                        this.setContentView(stackedProjectWebViewComponent?.webView)
                    }
                }
            }
            // pass message to editor
            else {
                editorWebViewComponent?.onMessage(messageType, message)
            }
        }
        // for stacked project
        else if(stackedProjectWebViewComponent?.instance?.projectId == projectId) {
            if(messageType == "title") {
                val mainLooper = Looper.getMainLooper()
                val handler = Handler(mainLooper)
                handler.post {
                    this.title = message
                }
            } else {
                stackedProjectWebViewComponent?.onMessage(messageType, message)
            }
        }
    }


    private fun setDirectories(){
        this.directories(
            root,
            config,
            editor,
            tmp
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        root = this.filesDir.absolutePath + "/projects"
        config = this.filesDir.absolutePath + "/.config"
        editor = this.filesDir.absolutePath + "/editor"
        tmp = this.filesDir.absolutePath + "/.tmp"

        this.addCallback(callbackId)

        this.setDirectories()

        var deeplink: String? = null
        var projectIdExternal: String? = null
        val data: Uri? = intent?.data
        if(data != null && data.toString().isNotEmpty()) {
            val urlStr = data.toString()
            if(urlStr.startsWith("fullstacked://http")) {
                println("LAUNCH URL [$data]")
                deeplink = urlStr
            } else {
                projectIdExternal = urlStr.slice("fullstacked://".length..< urlStr.length)
                println("INTENT [$projectIdExternal]")
            }
        }

        // launch editor and maybe launch Url
        if(projectIdExternal == null) {
            val editorInstance = Instance( "", true)
            this.editorWebViewComponent = WebViewComponent(this, editorInstance)

            // after editor update,
            // make sure to set directories to re-run setup fn
            if(this.extractEditorFiles(editorInstance, editor)){
                this.setDirectories()
            }

            this.fileChooserResultLauncher = this.createFileChooserResultLauncher()
            this.setContentView(this.editorWebViewComponent?.webView)
            if(deeplink != null) {
                this.editorWebViewComponent?.onMessage("deeplink", deeplink)
            }
        }
        // launch single project
        else {
            this.stackedProjectWebViewComponent = WebViewComponent(this, Instance(projectIdExternal))
            this.setContentView(this.stackedProjectWebViewComponent?.webView)
            var lastTs: Long = 0
            this.onSharedPreferenceChangeListeners[buildTimestampPreferenceKey] = OnSharedPreferenceChangeListener { sharedPreferences, _ ->
                val ts = sharedPreferences.getLong(projectIdExternal, 0L)
                println("BUILD TIMESTAMP 1 [$ts]")
                if(lastTs != ts) {
                    this.stackedProjectWebViewComponent?.webView?.reload()
                    lastTs = ts
                    println("BUILD TIMESTAMP 2 [$lastTs]")
                }
            }
            getSharedPreferences(buildTimestampPreferenceKey, MODE_PRIVATE).registerOnSharedPreferenceChangeListener(this.onSharedPreferenceChangeListeners[buildTimestampPreferenceKey])
        }

        this.onBackPressedDispatcher.addCallback {
            // in external project window
            if(editorWebViewComponent == null && stackedProjectWebViewComponent != null) {
                stackedProjectWebViewComponent?.back { didGoBack ->
                    if(!didGoBack) {
                        finish()
                    }
                }
            }
            // in top window
            else {
                // we have a stacked project
                if(stackedProjectWebViewComponent != null) {
                    stackedProjectWebViewComponent?.back { didGoBack ->
                        if(!didGoBack) {
                            removeStackedProject()
                        }
                    }
                }
                // we're in the editor
                else {
                    editorWebViewComponent?.back { didGoBack ->
                        if(!didGoBack) {
                            moveTaskToBack(true)
                        }
                    }
                }
            }
        }.isEnabled = true
    }

    override fun onDestroy() {
        super.onDestroy()
        removeCallback(callbackId)

        this.removeStackedProject()

        if(stackedProjectWebViewComponent != null) {
            val buildTimestampPreferences = getSharedPreferences(buildTimestampPreferenceKey, MODE_PRIVATE)
            val editor = buildTimestampPreferences.edit()
            editor.remove(stackedProjectWebViewComponent?.instance?.projectId)
            editor.apply()
        }
    }

    private fun shouldExtractEditorFromZip(editorDir: String) : Boolean {
        val currentEditorDir = File(editorDir)
        val currentEditorDirContents = currentEditorDir.listFiles()
        val currentEditorBuildFile = currentEditorDirContents?.find { it.name == "build.txt" }

        if(currentEditorBuildFile == null) {
            println("EDITOR VERSION NO CURRENT BUILD FILE")
            return true
        }

        val currentEditorBuildNumber = currentEditorBuildFile.readText()
        val zipEditorBuildNumber = this.assets.open("build.txt").readBytes().decodeToString()

        if(currentEditorBuildNumber == zipEditorBuildNumber) {
            println("EDITOR VERSION SAME")
            return false
        }

        println("EDITOR VERSION DIFFERENT")
        return true
    }

    private fun extractEditorFiles(instanceEditor: Instance, editorDir: String) : Boolean {
        val shouldExtract = this.shouldExtractEditorFromZip(editorDir)

        if(!shouldExtract) {
            println("UNZIP SKIPPED !")
            return false
        }

        val destination = editorDir.toByteArray()
        val zipData = this.assets.open("build.zip").readBytes()

        var payload = byteArrayOf(
            30, // UNZIP_BIN_TO_FILE
        )

        // ENTRY
        payload += byteArrayOf(
            4 // BUFFER
        )
        payload += numberToBytes(zipData.size)
        payload += zipData

        // OUT
        payload += byteArrayOf(
            2 // STRING
        )
        payload += numberToBytes(destination.size)
        payload += destination

        // use absolute path to unzip to
        payload += byteArrayOf(
            1 // BOOLEAN
        )
        payload += numberToBytes(1)
        payload += byteArrayOf(
            1 // true
        )

        val unzipped = deserializeArgs(instanceEditor.callLib(payload))[0] as Boolean
        if(unzipped) {
            println("UNZIPPED !")
            File("$editorDir/build.txt").writeBytes(this.assets.open("build.txt").readBytes())
            return true
        }

        println("FAILED TO UNZIPPED")
        return false
    }

    fun removeStackedProject(){
        if(stackedProjectWebViewComponent != null) {
            (stackedProjectWebViewComponent?.webView?.parent as ViewGroup).removeView(stackedProjectWebViewComponent?.webView)
            stackedProjectWebViewComponent?.webView?.destroy()
            stackedProjectWebViewComponent = null
        }

        if(editorWebViewComponent != null) {
            this.setContentView(editorWebViewComponent?.webView)
        }
    }

    fun openProjectInAdjacentWindow(projectId: String) {
        val intent = Intent(Intent.ACTION_VIEW)
        intent.data = Uri.parse("fullstacked://$projectId")
        intent.addFlags(Intent.FLAG_ACTIVITY_LAUNCH_ADJACENT)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        startActivity(intent)

        if(!this.projectsIdsInExternal.contains(projectId)) {
            this.projectsIdsInExternal.add(projectId)

            if(stackedProjectWebViewComponent?.instance?.projectId == projectId) {
                removeStackedProject()
            }

            this.onSharedPreferenceChangeListeners[projectId] = OnSharedPreferenceChangeListener { sharedPreferences, _ ->
                if(!sharedPreferences.contains(projectId)) {
                    this.projectsIdsInExternal.remove(projectId)
                    this.onSharedPreferenceChangeListeners.remove(projectId)
                }
            }

            getSharedPreferences(buildTimestampPreferenceKey, MODE_PRIVATE).registerOnSharedPreferenceChangeListener(this.onSharedPreferenceChangeListeners[projectId])
        }
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

    private fun useMultiWindow(): Boolean {
        // Samsung DeX
        // source: https://developer.samsung.com/samsung-dex/modify-optimizing.html
        val enabled: Boolean
        val config = this.resources.configuration
        try {
            val configClass: Class<*> = config.javaClass
            enabled = (configClass.getField("SEM_DESKTOP_MODE_ENABLED").getInt(configClass)
                    == configClass.getField("semDesktopModeEnabled").getInt(config))
            return enabled
        } catch (_: NoSuchFieldException) {
        } catch (_: IllegalAccessException) {
        } catch (_: IllegalArgumentException) {
        }

        // ChromeOS
        // source: https://www.b4x.com/android/forum/threads/check-if-the-application-is-running-on-a-chromebook.145496/
        if(this.packageManager.hasSystemFeature("org.chromium.arc") ||
            this.packageManager.hasSystemFeature("org.chromium.arc.device_management")) {
            return true
        }

        // Check if the UI is in DESK mode
        val uim = this.getSystemService(UI_MODE_SERVICE) as UiModeManager
        if(uim.currentModeType == UI_MODE_TYPE_DESK) {
            return true
        }

        // use multi-window if larger thant normal screen size layout
        // source: https://stackoverflow.com/a/19256468
        var screenLayout: Int = this.resources.configuration.screenLayout
        screenLayout = screenLayout and Configuration.SCREENLAYOUT_SIZE_MASK
        return screenLayout > Configuration.SCREENLAYOUT_SIZE_NORMAL
    }
}