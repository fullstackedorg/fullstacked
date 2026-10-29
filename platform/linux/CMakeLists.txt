# cmake -DARCH=[ arm64 | x64 ] .
# make
#
# ARCH defaults to the host architecture. Building for another one also needs
# its compilers, e.g. -DCMAKE_C_COMPILER=x86_64-linux-gnu-gcc
# -DCMAKE_CXX_COMPILER=x86_64-linux-gnu-g++ (see publish.js).

cmake_minimum_required(VERSION 3.22.1)
project(fullstacked)

# -DARCH applies to the configure it is passed to, it is not kept in the
# cache: a later configure without it builds for the host again
if(DEFINED CACHE{ARCH})
    set(REQUESTED_ARCH "${ARCH}")
    unset(ARCH CACHE)
    set(ARCH "${REQUESTED_ARCH}")
endif()

if(NOT DEFINED ARCH OR ARCH STREQUAL "")
    if(CMAKE_HOST_SYSTEM_PROCESSOR MATCHES "x86_64|amd64|AMD64")
        set(ARCH "x64")
    else()
        set(ARCH "arm64")
    endif()
endif()

# the compilers stay in the cache, a cache configured for another
# architecture would build for it whatever ARCH says
if(CMAKE_LIBRARY_ARCHITECTURE MATCHES "x86_64")
    set(COMPILER_ARCH "x64")
elseif(CMAKE_LIBRARY_ARCHITECTURE MATCHES "aarch64")
    set(COMPILER_ARCH "arm64")
endif()
if(DEFINED COMPILER_ARCH AND NOT COMPILER_ARCH STREQUAL ARCH)
    message(FATAL_ERROR
        "ARCH is ${ARCH} but ${CMAKE_CXX_COMPILER} builds for "
        "${COMPILER_ARCH}. Pass the compilers for ${ARCH} or remove "
        "CMakeCache.txt to use the host ones.")
endif()

execute_process(
    COMMAND bash prebuild.sh ${ARCH} qt
    WORKING_DIRECTORY ${PROJECT_SOURCE_DIR}
)

set(CMAKE_CXX_STANDARD 20)

find_package(Qt6 COMPONENTS Core Widgets Network WebEngineWidgets WebEngineCore WebChannel REQUIRED)

qt_add_executable(${PROJECT_NAME} 
    src/main.cpp 
    src/app.cpp 
    src/core.cpp 
    src/utils.cpp 
    src/base64.cpp 
    src/qt/qt.cpp
    src/qt/bridge.cpp)
set_target_properties(${PROJECT_NAME} PROPERTIES AUTOMOC ON)
target_link_libraries(${PROJECT_NAME} PUBLIC 
    Qt6::Core Qt6::Widgets 
    Qt6::Network
    Qt6::WebEngineWidgets
    Qt6::WebEngineCore 
    Qt6::WebChannel
    ${CMAKE_SOURCE_DIR}/bin/linux-${ARCH}.a
    pthread
    dl)

set(EXECUTABLE_OUTPUT_PATH ${CMAKE_SOURCE_DIR}/out/usr/bin)