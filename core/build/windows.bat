@REM download this compiler and add to PATH env
@REM https://github.com/mstorsjo/llvm-mingw
@REM Last tested: llvm-mingw-20250613-ucrt

@ECHO off
SET CGO_ENABLED=1
SET GOOS=windows

set arg1=%1

IF "%arg1%" == "arm64" (
    SET CC=aarch64-w64-mingw32-gcc
    SET CXX=aarch64-w64-mingw32-g++
    SET GOARCH=arm64
    go build -buildmode=c-shared -tags=WIN -o ../bin/win32-arm64.dll -v ..
    xcopy ..\bin\win32-arm64.dll ..\..\platform\windows /y /q
)

IF "%arg1%" == "x64" (
    SET CC=x86_64-w64-mingw32-gcc
    SET CXX=x86_64-w64-mingw32-g++
    SET GOARCH=amd64
    go build -buildmode=c-shared -tags=WIN -o ../bin/win32-x64.dll -v ..
    xcopy ..\bin\win32-x64.dll ..\..\platform\windows /y /q
)

@REM SET SOURCE_DIR="..\..\out\build"
@REM SET TARGET_DIR="..\..\platform\windows\build"

@REM IF "%arg1%" == "copy" (    
@REM     IF EXIST "%TARGET_DIR%" (
@REM         RD /S /Q "%TARGET_DIR%"
@REM     )
@REM     IF EXIST "%SOURCE_DIR%" (
@REM         xcopy "%SOURCE_DIR%" "%TARGET_DIR%"\ /y /s /e /q
@REM     )
@REM )
