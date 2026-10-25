<p align="center">
  <img src="client/public/brand/shiye-mark.png" width="120" alt="Shiye logo">
</p>

<h1 align="center">拾页 · Shiye</h1>

<p align="center">Save selected WeChat public-account articles and read them offline on Windows.</p>
<p align="center">Discover the list, choose what to download, and keep text and images in your local library.</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.2-245c49?style=flat" alt="Version 0.1.2">
  <img src="https://img.shields.io/badge/platform-Windows_x64-245c49?style=flat" alt="Windows x64">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-245c49?style=flat" alt="MIT License"></a>
</p>

<p align="center">
  <a href="https://github.com/V-ChuXuan/shiye/releases/latest">Download</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="docs/usage.md">Guide (Chinese)</a> ·
  <a href="README.md">简体中文</a>
</p>

## Demo

![Reading room with local test articles and account filtering](docs/images/reading-room.png)

The interface is currently in Chinese; control names below are translated into English. The screenshot uses a test library.

## Install

Download the Windows x64 installer from [Releases](https://github.com/V-ChuXuan/shiye/releases/latest) and follow the setup wizard. A ZIP is also available: extract the complete folder and open `拾页.exe`. No separate Node.js installation is needed.

New libraries use the `library` folder beside the application, with images in `library/pictures`. Upgrades and uninstall preserve the library. Existing users keep their original location.

## Quick Start

1. Open Shiye and paste a public article link to add its account.
2. Open an article from that account in desktop WeChat, then click **Connect WeChat** in Shiye.
3. Click **Discover Articles** to get the list and set this run's article and batch limits.
4. Select articles in **Article Catalog** and download them. Discovery does not download articles automatically.
5. Open **Reading Room** to read saved text and images. Enlarged images stay in the same window.

Closing the window hides it to the tray. Choose **Quit Shiye** in the tray menu to quit.

## Features

- Discover history and new articles, then download only the articles you choose.
- Keep task progress after interruptions and continue when ready.
- Read article text and galleries offline, with adjustable columns and saved reading positions.
- Save images in account-name/article-title folders and choose their location in Settings.
- Back up and restore the complete library through the native application menu.

## Usage

Change the image folder in **Settings**. Existing images stay readable at their original location unless you select **Move existing images too**. For backups, use the tray or Alt application menu and keep the whole backup folder.

If WeChat requests verification or the connection expires, handle it in WeChat, reconnect and explicitly continue the task. Detailed discovery limits, selection behavior and recovery steps are in the [Chinese guide](docs/usage.md).

## Limitations

- Collection depends on Windows desktop WeChat and its non-public listing interface. Complete history and unattended operation are not guaranteed.
- Windows x64 only. The application is unsigned and does not support automatic updates.
- Saved articles and images retain their authors' rights; MIT applies to the software. See [further limitations (Chinese)](docs/usage.md#已知限制).

## Development

Build from source on Windows x64 with Node.js 24 LTS:

```sh
npm ci
npm run desktop:package
```

See [development and configuration (Chinese)](docs/usage.md#源码开发), [desktop behavior (Chinese)](docs/desktop.md), [UI sources (Chinese)](docs/ui-foundation.md) and the [publication checklist (Chinese)](docs/publishing.md). Verification commands and known reliability limits are documented there.

## License

[MIT](LICENSE)

## Credits

- [shadcn/ui](https://github.com/shadcn-ui/ui) and [Base UI](https://github.com/mui/base-ui) provide the component source and interaction primitives.
- [Lucide](https://github.com/lucide-icons/lucide) provides the interface icons.
- [Electron](https://github.com/electron/electron) hosts the desktop application. See [third-party notices](THIRD_PARTY_NOTICES.md) for the full attribution details.

<p align="center"><sub>If Shiye is useful to you, a ⭐ helps others find it.</sub></p>
