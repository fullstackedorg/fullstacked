<img height=100 width=100 src="https://files.fullstacked.org/app-icon.svg" />

# FullStacked

**Code, Run, Share. Anywhere.**

Create, run and share projects built with web technologies in a fully cross-platform, local-first environment.

[Documentation](https://docs.fullstacked.org) | [Demo](https://demo.fullstacked.org) | [Roadmap](https://fullstacked.notion.site/FullStacked-Editor-Roadmap-ebfcb685b77446c7a7898c05b219215e) | [Figma](https://www.figma.com/design/xb3JBRCvEWpbwGda03T5QQ/Mockups)

![FullStacked](https://files.fullstacked.org/fullstacked.png)

## Installation

### Latest stable release is available on all major app marketplaces

- [Apple App Store](https://apps.apple.com/ca/app/fullstacked/id6477835950) (MacOS, iOS, iPadOS)
- [Google Play](https://play.google.com/store/apps/details?id=org.fullstacked.editor) (Android, Chromebook)
- [Microsoft Store](https://apps.microsoft.com/detail/9p987qm508vc?hl=en-us) (Windows 10/11)

You can always find those links and access to the beta apps on FullStacked [download page](https://fullstacked.org/download)

### Build from source

#### Requirements

- Go `>=1.25`
- NodeJS `>=20`

1. Clone this repo and enter the directory
```
git clone https://github.com/fullstackedorg/fullstacked.git
cd fullstacked
```
2. Init the submodules.
```
git submodule update --init
```
3. Go to the `core/build` directory and build the **shared** library for your current platform.
```
cd core/build
make darwin-arm64-shared
```
For windows users, use the batch file.
```
cd core/build
./windows.bat
```
4. Return to the root directory, install the dependencies and start.
```
cd ../..
npm install
npm start
```

## License

FullStacked is licensed under [MIT](https://github.com/fullstackedorg/fullstacked/blob/main/LICENSE), but the Editor is under [GPL-3](https://github.com/fullstackedorg/editor/blob/main/LICENSE). [Read more.](https://docs.fullstacked.org/#/license)