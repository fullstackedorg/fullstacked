package org.fullstacked.editor

import android.app.Activity
import android.app.UiModeManager
import android.content.Intent
import android.content.SharedPreferences.OnSharedPreferenceChangeListener
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

class MainActivity : ComponentActivity() {
    companion object {
        init {
            System.loadLibrary("editor-core")
        }
    }

    var editorWebViewComponent: WebViewComponent? = null
    var stackedProjectWebViewComponent: WebViewComponent? = null
    val projectsIdsInExternal = mutableListOf<String>()

    var onSharedPreferenceChangeListeners = mutableMapOf<String, OnSharedPreferenceChangeListener>()

    private external fun directories(
        root: String,
        config: String,
        editor: String,
    )

    private external fun addCallback(id: Int)
    private external fun removeCallback(id: Int)

    private val callbackId = (0..9999).random()

    fun Callback(projectId: String, messageType: String, message: String) {
        println("RECEIVED CORE MESSAGE FOR [$projectId] [$messageType]")

        if(projectId == "") {
            if(this.editorWebViewComponent == null) return;

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

                    if(this.isSamsungDexOrChromeOsOrDeskMode()) {
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
            stackedProjectWebViewComponent?.onMessage(messageType, message)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = this.filesDir.absolutePath + "/projects"
        val config = this.filesDir.absolutePath + "/.config"
        val editor = this.filesDir.absolutePath + "/editor"

        this.directories(
            root,
            config,
            editor
        )

        addCallback(callbackId)

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
            this.extractEditorFiles(editorInstance, editor)
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

    private fun shouldExtractEditorFromZip(editorDir: String) : String? {
        val currentEditorDir = File(editorDir)
        val currentEditorDirContents = currentEditorDir.listFiles()
        val currentEditorBuildFile = currentEditorDirContents?.find { it.name == "build.txt" }

        val assetContents = this.assets.list("")
        assetContents?.forEach { println(it) }
        val editorZipFileName = assetContents?.find { it.startsWith("editor") }
        val editorZipNumber = editorZipFileName?.split("-")?.last()?.split(".")?.first()
        println("EDITOR VERSION BUILD $editorZipNumber")

        if(currentEditorBuildFile == null) {
            println("EDITOR VERSION NO CURRENT BUILD FILE")
            return editorZipNumber
        }

        val currentEditorBuildNumber = currentEditorBuildFile.readText()

        println("EDITOR VERSION CURRENT BUILD $currentEditorBuildNumber")

        if(editorZipNumber != currentEditorBuildNumber) {
            return editorZipNumber
        }

        return null
    }

    private fun extractEditorFiles(instanceEditor: Instance, editorDir: String) {
        val editorZipNumber = this.shouldExtractEditorFromZip(editorDir)

        if(editorZipNumber == null) {
            println("UNZIPPED SKIPPED !")
            return
        }

        val destination = editorDir.toByteArray()
        val zipData = this.assets.open("editor-$editorZipNumber.zip").readBytes()

        var payload = byteArrayOf(
            30, // UNZIP
            2   // STRING
        )
        payload += numberToBytes(destination.size)
        payload += destination
        payload += byteArrayOf(
            4 // BUFFER
        )
        payload += numberToBytes(zipData.size)
        payload += zipData

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
            File("$editorDir/build.txt").writeText(editorZipNumber)
        } else {
            println("FAILED TO UNZIPPED")
        }
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

    private fun isSamsungDexOrChromeOsOrDeskMode(): Boolean {
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

        val uim = this.getSystemService(UI_MODE_SERVICE) as UiModeManager
        return uim.currentModeType == UI_MODE_TYPE_DESK
    }
}