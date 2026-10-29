# For more information about using CMake with Android Studio, read the
# documentation: https://d.android.com/studio/projects/add-native-code.html.
# For more examples on how to use CMake, see https://github.com/android/ndk-samples.

# Sets the minimum CMake version required for this project.
cmake_minimum_required(VERSION 3.22.1)

# Declares the project name.
project(fullstacked-android)

set(core_DIR ${CMAKE_CURRENT_SOURCE_DIR}/core)

if(${ANDROID_ABI} MATCHES "arm64-v8a")
    add_compile_definitions(ANDROID_ABI_arm64)
endif ()

if(${ANDROID_ABI} MATCHES "x86_64")
    add_compile_definitions(ANDROID_ABI_x64)
endif ()

add_library(core SHARED IMPORTED)
set_target_properties(core PROPERTIES IMPORTED_LOCATION
        ${core_DIR}/${ANDROID_ABI}/libcore.so)

set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS}")

# Creates and names a library, sets it as either STATIC
# or SHARED, and provides the relative paths to its source code.
add_library(fullstacked-android SHARED
        bridge.cpp)

# Specifies libraries CMake should link to your target library.
target_link_libraries(fullstacked-android
        android
        core
        log)

# Copy libcore.so into target output directory so AGP packages libcore.so into APK nativeLibs
add_custom_command(TARGET fullstacked-android POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${core_DIR}/${ANDROID_ABI}/libcore.so"
        "$<TARGET_FILE_DIR:fullstacked-android>/libcore.so"
)
