@REM download this compiler and add to PATH env
@REM https://github.com/mstorsjo/llvm-mingw

node ./typescript-go-patch/patch.js

xcopy .\typescript-go-patch\module ..\typescript-go\cmd\module /y /q

@ECHO off
SET CGO_ENABLED=1
SET GOOS=windows

SET CC=aarch64-w64-mingw32-gcc
SET CXX=aarch64-w64-mingw32-g++
SET GOARCH=arm64
go build -buildmode=c-shared -o ../bin/win32-arm64.dll -v ..

SET CC=x86_64-w64-mingw32-gcc
SET CXX=x86_64-w64-mingw32-g++
SET GOARCH=amd64
go build -buildmode=c-shared -o ../bin/win32-x64.dll -v ..

xcopy ..\bin\win32-x64.dll ..\..\platform\windows /y /q
xcopy ..\bin\win32-arm64.dll ..\..\platform\windows /y /q
xcopy ..\..\out\editor ..\..\platform\windows\editor /y /s /e /q