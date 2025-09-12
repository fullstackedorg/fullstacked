OUT = $(CURDIR)/../bin

$(shell ./copy.sh > /dev/null)

###### MacOS #######

darwin-x64-shared:
	CGO_ENABLED=1 \
	GOOS=darwin \
	GOARCH=amd64 \
	SDK=macosx \
	CC=$(CURDIR)/apple-clang.sh \
	CGO_CFLAGS="-target x86_64-apple-darwin" \
	go build -buildmode=c-shared -o $(OUT)/darwin-x64.so -v ..

darwin-x64-static:
	CGO_ENABLED=1 \
	GOOS=darwin \
	GOARCH=amd64 \
	SDK=macosx \
	CC=$(CURDIR)/apple-clang.sh \
	CGO_CFLAGS="-target x86_64-apple-darwin" \
	go build -buildmode=c-archive -o $(OUT)/darwin-x64.a -v ..

darwin-arm64-shared:
	CGO_ENABLED=1 \
	GOOS=darwin \
	GOARCH=arm64 \
	SDK=macosx \
	CC=$(CURDIR)/apple-clang.sh \
	CGO_CFLAGS="-target arm64-apple-darwin" \
	go build -buildmode=c-shared -o $(OUT)/darwin-arm64.so -v ..

darwin-arm64-static:
	CGO_ENABLED=1 \
	GOOS=darwin \
	GOARCH=arm64 \
	SDK=macosx \
	CC=$(CURDIR)/apple-clang.sh \
	CGO_CFLAGS="-target arm64-apple-darwin" \
	go build -buildmode=c-archive -o $(OUT)/darwin-arm64.a -v ..

darwin-static: darwin-x64-static darwin-arm64-static
	lipo $(OUT)/darwin-x64.a $(OUT)/darwin-arm64.a -create -output $(OUT)/darwin.a
	cp $(OUT)/darwin-arm64.h $(OUT)/darwin.h

###### iOS/iPadOS #######

ios-arm64:
	node ./typescript-go-patch/ios/patch.js
	CGO_ENABLED=1 \
	GOOS=ios \
	GOARCH=arm64 \
	SDK=iphoneos \
	CC=$(CURDIR)/apple-clang.sh \
	CGO_CFLAGS="-fembed-bitcode" \
	go build -buildmode=c-archive -tags ios -o $(OUT)/ios-arm64.a -v ..

###### Android #######

ANDROID_OUT = $(CURDIR)/../../platform/android/studio/app/src/main/cpp/core
NDK_VERSION = 28.2.13676358

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

android-x64:
	mkdir -p $(ANDROID_OUT)/x86_64 && \
	CGO_ENABLED=1 \
	GOOS=android \
	GOARCH=amd64 \
	CGO_LDFLAGS="-Wl,-soname,core.so" \
	CC=~/Library/Android/sdk/ndk/${NDK_VERSION}/toolchains/llvm/prebuilt/darwin-x86_64/bin/x86_64-linux-android34-clang \
	go build -buildmode=c-shared -o $(ANDROID_OUT)/x86_64/core.so -v .. 

android: android-arm android-arm64 android-x64

###### Linux #######

linux-x64-shared:
	CGO_ENABLED=1 \
	GOOS=linux \
	GOARCH=amd64 \
	go build -buildmode=c-shared -o $(OUT)/linux-x64.so -v ..

linux-arm64-shared:
	CGO_ENABLED=1 \
	GOOS=linux \
	GOARCH=arm64 \
	go build -buildmode=c-shared -o $(OUT)/linux-arm64.so -v ..

linux-x64-static:
	CGO_ENABLED=1 \
	GOOS=linux \
	GOARCH=amd64 \
	go build -buildmode=c-archive -o $(OUT)/linux-x64.a -v ..

linux-arm64-static:
	CGO_ENABLED=1 \
	GOOS=linux \
	GOARCH=arm64 \
	go build -buildmode=c-archive -o $(OUT)/linux-arm64.a -v ..


###### WebAssembly #######

wasm:
	GOOS=js \
	GOARCH=wasm \
	go build -o $(OUT)/wasm.wasm -v ../wasm && \
	cp $(shell go env GOROOT)/misc/wasm/wasm_exec.js $(OUT)/wasm.js


###### Clean #######

clean: 
	rm -rf $(OUT) && \
	go clean -cache