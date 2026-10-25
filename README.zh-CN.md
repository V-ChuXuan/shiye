<p align="center">
  <img src="client/public/brand/shiye-mark.png" width="120" alt="拾页图标">
</p>

<h1 align="center">拾页 · Shiye</h1>

<p align="center">在 Windows 上保存选定的公众号文章，离线阅读正文和图片。</p>
<p align="center">先发现清单，再选择下载，让需要的图文留在本地文库。</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.1-245c49?style=flat" alt="Version 0.1.1">
  <img src="https://img.shields.io/badge/platform-Windows_x64-245c49?style=flat" alt="Windows x64">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-245c49?style=flat" alt="MIT License"></a>
</p>

<p align="center">
  <a href="https://github.com/V-ChuXuan/shiye/releases/latest">下载应用</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="docs/usage.md">使用指南</a> ·
  <a href="README.md">English</a>
</p>

## 演示

![使用本地测试文章和公众号筛选的阅读室](docs/images/reading-room.png)

当前界面为中文，截图来自测试文库。

## 安装

从 [Releases](https://github.com/V-ChuXuan/shiye/releases/latest) 下载 Windows x64 ZIP，完整解压后打开 `拾页.exe`。保留旁边的文件和文件夹，无需单独安装 Node.js。

## 快速开始

1. 打开拾页，粘贴一篇公开文章链接，添加公众号。
2. 在电脑微信打开该公众号的一篇文章，再到拾页点击 **连接微信**。
3. 点击 **发现文章** 获取清单，设置本次篇数和批次上限。
4. 在 **文章目录** 选择文章并下载。发现文章不会自动下载正文。
5. 到 **阅读室** 阅读已保存的图文，放大图片也在当前窗口查看。

关闭窗口会隐藏到托盘。在托盘菜单选择 **退出拾页** 即可退出。

## 功能

- 发现历史和新增文章，选择需要的内容下载。
- 中断后保留任务进度，准备好后继续。
- 离线阅读正文和图集，调整阅读分栏，记住阅读位置。
- 按公众号名和文章标题保存图片，在设置中选择保存位置。
- 通过原生应用菜单备份和恢复完整文库。

## 用法

在 **设置** 更改图片目录。已有图片仍从原位置读取，勾选 **同时迁移已有图片** 才会迁移。备份通过托盘或 Alt 应用菜单操作，请保留整个备份文件夹。

微信要求验证或连接过期时，在微信处理后重新连接，再明确继续任务。发现上限、选择规则和恢复操作详见[使用指南](docs/usage.md)。

## 什么时候不该用

- 采集依赖 Windows 电脑微信及其非公开清单接口，不保证完整历史或无人值守运行。
- 当前是未签名的 Windows x64 便携应用，没有安装器或自动更新。
- 保存的文章和图片仍属于各自作者，MIT 协议适用于软件。[其他已知限制](docs/usage.md#已知限制)见使用指南。

## 开发

从源码构建需要 Windows x64 和 Node.js 24 LTS：

```sh
npm ci
npm run desktop:package
```

详见[开发与配置](docs/usage.md#source-development)、[桌面行为](docs/desktop.md)、[UI 来源](docs/ui-foundation.md)及[发布检查](docs/publishing.md)，其中列有验证命令和已知可靠性限制。

## 许可

[MIT](LICENSE)

## 致谢

- [shadcn/ui](https://github.com/shadcn-ui/ui) 和 [Base UI](https://github.com/mui/base-ui) 提供组件源码与交互基础。
- [Lucide](https://github.com/lucide-icons/lucide) 提供界面图标。
- [Electron](https://github.com/electron/electron) 承载桌面应用，完整来源说明见[第三方声明](THIRD_PARTY_NOTICES.md)。

<p align="center"><sub>如果拾页对你有帮助，欢迎点亮 ⭐，让更多人发现它。</sub></p>
