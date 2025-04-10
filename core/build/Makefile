OUT = $(CURDIR)/../bin

###### MacOS #######

macos-x86_64-shared:
	CGO_ENABLED=1 \
	GOOS=darwin \
	GOARCH=amd64 \
	SDK=macosx \
	CC=$(CURDIR)/apple-clang.sh \
	CGO_CFLAGS="-target x86_64-apple-darwin" \
	go build -buildmode=c-shared -o $(OUT)/macos-x86_64 -v ..

macos-x86_64-static:
	CGO_ENABLED=1 \
	GOOS=darwin \
	GOARCH=amd64 \
	SDK=macosx \
	CC=$(CURDIR)/apple-clang.sh \
	CGO_CFLAGS="-target x86_64-apple-darwin" \
	go build -buildmode=c-archive -o $(OUT)/macos-x86_64.a -v ..

macos-arm64-static:
	CGO_ENABLED=1 \
	GOOS=darwin \
	GOARCH=arm64 \
	SDK=macosx \
	CC=$(CURDIR)/apple-clang.sh \
	CGO_CFLAGS="-target arm64-apple-darwin" \
	go build -buildmode=c-archive -o $(OUT)/macos-arm64.a -v ..

macos-static: macos-x86_64-static macos-arm64-static
	lipo $(OUT)/macos-x86_64.a $(OUT)/macos-arm64.a -create -output $(OUT)/macos.a
	cp $(OUT)/macos-arm64.h $(OUT)/macos.h

###### iOS/iPadOS #######

ios-arm64:
	CGO_ENABLED=1 \
	GOOS=ios \
	GOARCH=arm64 \
	SDK=iphoneos \
	CC=$(CURDIR)/apple-clang.sh \
	CGO_CFLAGS="-fembed-bitcode" \
	go build -buildmode=c-archive -tags ios -o $(OUT)/ios-arm64.a -v ..

###### Android #######

ANDROID_OUT = $(CURDIR)/../../platform/android/studio/app/src/main/cpp/core
NDK_VERSION = 26.1.10909125

android-arm:
	mkdir -p $(ANDROID_OUT)/armeabi-v7a && \
	CGO_ENABLED=1 \
	GOOS=android \
	GOARCH=arm \
	CGO_LDFLAGS="-Wl,-soname,core.so" \
	CC=~/Library/Android/sdk/ndk/$(NDK_VERSION)/toolchains/llvm/prebuilt/darwin-x86_64/bin/armv7a-linux-androideabi34-clang \
	go build -buildmode=c-shared -o $(ANDROID_OUT)/armeabi-v7a/core.so -v ..

android-arm64:
	mkdir -p $(ANDROID_OUT)/arm64-v8a && \
	CGO_ENABLED=1 \
	GOOS=android \
	GOARCH=arm64 \
	CGO_LDFLAGS="-Wl,-soname,core.so" \
	CC=~/Library/Android/sdk/ndk/${NDK_VERSION}/toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android34-clang \
	go build -buildmode=c-shared -o $(ANDROID_OUT)/arm64-v8a/core.so -v .. 

android-x86_64:
	mkdir -p $(ANDROID_OUT)/x86_64 && \
	CGO_ENABLED=1 \
	GOOS=android \
	GOARCH=amd64 \
	CGO_LDFLAGS="-Wl,-soname,core.so" \
	CC=~/Library/Android/sdk/ndk/${NDK_VERSION}/toolchains/llvm/prebuilt/darwin-x86_64/bin/x86_64-linux-android34-clang \
	go build -buildmode=c-shared -o $(ANDROID_OUT)/x86_64/core.so -v .. 

android: android-arm android-arm64 android-x86_64

###### Windows #######

win-x86_64:
	CGO_ENABLED=1 \
	GOOS=windows \
	GOARCH=amd64 \
	CC=x86_64-w64-mingw32-gcc \
	go build -buildmode=c-shared -o $(OUT)/win-x86_64.dll -v ..

###### Linux #######

linux-x86_64-shared:
	CGO_ENABLED=1 \
	GOOS=linux \
	GOARCH=amd64 \
	go build -buildmode=c-shared -o $(OUT)/linux-x86_64 -v ..

linux-x86_64-static:
	CGO_ENABLED=1 \
	GOOS=linux \
	GOARCH=amd64 \
	go build -buildmode=c-archive -o $(OUT)/linux-x86_64 -v ..


###### WebAssembly #######

wasm:
	GOOS=js \
	GOARCH=wasm \
	go build -o $(OUT)/wasm.wasm -v ../wasm && \
	cp $(shell go env GOROOT)/misc/wasm/wasm_exec.js $(OUT)/wasm.js


###### All #######

clean: 
	rm -rf $(OUT) && \
	go clean -cache

all: macos-static \
	macos-x86_64-shared \
	ios-arm64 \
	android \
	win-x86_64 \
	wasm