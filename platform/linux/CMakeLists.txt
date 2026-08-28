# cmake -DARCH=[ arm64 | x64 ] .
# make

cmake_minimum_required(VERSION 3.22.1)
project(fullstacked)

if(NOT DEFINED ARCH)
    if(CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|amd64")
        set(ARCH "x64")
    else()
        set(ARCH "arm64")
    endif()
endif()

execute_process(
    COMMAND bash prebuild.sh ${ARCH} qt
    WORKING_DIRECTORY ${PROJECT_SOURCE_DIR}
)

set(CMAKE_CXX_STANDARD 20)

find_package(Qt6 COMPONENTS Core Widgets WebEngineWidgets WebEngineCore WebChannel REQUIRED)

qt_add_executable(${PROJECT_NAME} 
    src/main.cpp 
    src/app.cpp 
    src/core.cpp 
    src/utils.cpp 
    src/base64.cpp 
    src/qt/qt.cpp)
set_target_properties(${PROJECT_NAME} PROPERTIES AUTOMOC ON)
target_link_libraries(${PROJECT_NAME} PUBLIC 
    Qt6::Core Qt6::Widgets 
    Qt6::WebEngineWidgets
    Qt6::WebEngineCore 
    Qt6::WebChannel
    ${CMAKE_SOURCE_DIR}/bin/linux-${ARCH}.a
    pthread
    dl)

set(EXECUTABLE_OUTPUT_PATH ${CMAKE_SOURCE_DIR}/out/usr/bin)