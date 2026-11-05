# R8 shrinks, optimizes and obfuscates the release build. These rules keep what
# is reached by name from outside Kotlin.

# JNI: bridge.cpp exports Java_org_fullstacked_<Class>_<method>, so the classes
# and their native methods keep their names
-keepclasseswithmembernames,includedescriptorclasses class org.fullstacked.** {
    native <methods>;
}

# bridge.cpp calls MainActivity.onStreamData(III)V with GetMethodID
-keep class org.fullstacked.MainActivity {
    void onStreamData(int, int, int);
}

# the page calls the methods of the fullstackedCore interface (Bridge) by name
-keepclassmembers class org.fullstacked.Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface

# readable stack traces: Play deobfuscates with the mapping file in the bundle
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
