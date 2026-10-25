# UI 技术边界

## 1. 范围与触发
用户于2026-10-24要求Ponytail检查和UIUX统一。目标是在既有四页与API契约内替换重复维护的组件、图标和状态处理，不改采集服务、数据库或用户归档。

## 2. 唯一选型
| 用途 | 采用 | 范围 |
|---|---|---|
| 组件源码 | shadcn/ui Base Nova | client/src/components/ui，按实际用途纳入源码；一个headless基础@base-ui/react |
| 图标 | lucide-react | 具名导入，装饰图标aria-hidden，图标按钮提供中文名称 |
| 样式 | Tailwind CSS 4与语义CSS变量 | Vite官方插件，Nova尺度和统一颜色/圆角/前景token |
| 类名/变体 | cn、class-variance-authority | 使用官方Nova源码声明的帮助库，不直接增加第二套clsx/tailwind-merge |
| UI状态 | Zustand 5 | 跨页筛选、选中范围、阅读偏好和分栏比例 |
| 动画 | motion/react | MotionConfig reducedMotion=user；只在真实视图/反馈变化时使用 |
| 阅读分栏 | react-resizable-panels 4 | 桌面目录/正文，可键盘调整；手机单栏 |

不加入dnd-kit：目前没有重排/拖放操作或排序持久化需求。不加入TanStack Table/Query、第二路由库、第二图标或状态库。Motion内部framer-motion属于其传递依赖，不能再把framer-motion作为项目直接依赖。Base UI内部辅助依赖同理，不等于另选一套UI体系。

## 3. 源码与数据契约
组件来源及上游SHA256见[ui-component-sources.json](ui-component-sources.json)，MIT全文见[shadcn-LICENSE.md](shadcn-LICENSE.md)。源码由官方base-nova registry生成，转换仅限本地import路径、Lucide占位符和中文关闭文本。`node scripts/sync-ui-components.mjs`是显式开发维护命令，会覆盖清单中的本地UI源码；不要在构建、启动或应用运行时调用。维护本地改动时先审diff，再决定是否重新同步。

Nova的方向/状态工具类依赖官方自定义variants。项目只保留[shadcn/src/tailwind.css](https://github.com/shadcn-ui/ui/blob/main/packages/shadcn/src/tailwind.css)中“Custom variants”必需子集，不复制未使用的shimmer/scroll工具，不为一段CSS安装整个CLI。缺少data-horizontal到data-orientation的映射会让Tabs横排并压窄图库，需通过实际图片宽度回归验证。

App按业务页面、共享反馈/弹窗、状态和请求分工。服务端实体仍以API为真；busy/loading/error属于运行期，不写localStorage。仅持久化验证过的readerMode与readerLayout，忽略不受信任或不合法的旧偏好。
时间显示：ISO时刻用Asia/Shanghai转换；文章已规范的YYYY-MM-DD HH:mm不是UTC，保留原值。键盘跳主内容只转移焦点，不更改hash路由。hash深链保持#accounts、#articles、#jobs和#reader?id=...。

## 4. 验证和错误
| 场景 | 要求 |
|---|---|
| 对话框 | 焦点进入/限制/Escape/关闭后恢复；操作中反馈可见 |
| 筛选/勾选 | 改筛选不静默丢选择，确认按ID冻结；分组部分成功仅清掉已建立组 |
| 轮询 | 不重播整页动画，不覆盖用户未提交输入；旧请求结果不盖新筛选 |
| 阅读 | 仅本地图文；缺图显示可操作恢复提示，窄屏不横向溢出 |
| 偏好载入 | 类型/数值范围校验，无效输入回到默认 |
| 依赖 | 一个组件基础、图标、状态和动画入口；不为未来需求预装包 |

## 5. 正常、基本与异常
正常：筛选文章、勾选、确认、创建任务；切换页再回来选择仍清楚。
基本：只浏览公众号/本地阅读，不发生真实微信请求；减少动态效果偏好生效。
异常：第二公众号建任务失败时，第一组不会重复提交，未建组仍保留；对话框显示错误与后续操作。

## 6. 回归
原33项后端/采集测试、类型与生产构建保持。纯UI用例覆盖上海时区、skip焦点/路由、跨筛选选择/快照、分组部分成功清理与偏好校验。浏览器在临时本地mock源下覆盖真实勾选/确认、无障碍焦点、阅读分栏/窄屏、图集/放大、更新策略与导入；不向微信发测试请求。

## 7. 错误与正确
错误：为了满足库清单同时安装Radix和Base UI、两套动画、两个状态库，或先加拖拽再找业务。
正确：先确定交互行为，按唯一职责引入实际使用的组件源码和依赖。

错误：为减少App行数把全部页面拆成几十个无行为小包装，或继续在新组件外叠旧样式。
正确：按公众号/文章/任务/阅读职责拆分，使用统一原子组件与权威token，删除被替代逻辑。

## 筛选控件补充

SelectControl使用现有@base-ui/react/select，DatePicker使用现有@base-ui/react/popover管理浮层与焦点；本地日期网格只实现当前范围过滤所需date-only逻辑，并有边界/键盘测试。不新增第二组件基础或日期依赖。两组件为项目本地受控组件，沿用Nova token，不能伪称由registry生成；来源单独记录在ui-component-sources.json的localComponents，显式sync不覆盖这些本地组件。

选择范围、最近检查和开源致谢采用原生details/summary按需披露，不另建折叠组件或引入库。视觉上移除重复说明时保留sr-only表单名称、条件aria-describedby、导航当前页与失败状态。设置草稿后果只在路径变化/迁移勾选时出现，正常阅读不重复成功声明。
