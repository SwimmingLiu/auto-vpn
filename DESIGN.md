---
colors:
  bg: "#f5f7ff"
  surface: "#ffffff"
  surface_soft: "#f8faff"
  surface_muted: "#f2f5ff"
  border: "#dfe5f5"
  border_strong: "#cfd7ef"
  text: "#1e2746"
  text_soft: "#6d7794"
  accent: "#5b5ce2"
  accent_strong: "#4b4dcc"
  accent_soft: "#eeedff"
  success: "#2db36a"
  success_soft: "#e8faf0"
  warning: "#ff9b2f"
  warning_soft: "#fff4e8"
  danger: "#f05b69"
  danger_soft: "#ffecef"
  terminal: "#111826"
  terminal_soft: "#1b2436"
  terminal_text: "#d6e2ff"

typography:
  font_family: 'Inter, "SF Pro Display", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
  mono_font_family: 'ui-monospace, SFMono-Regular, Menlo, monospace'
  
shadows:
  default: "0 20px 44px rgba(29, 39, 71, 0.08)"
  drawer: "0 16px 48px rgba(29, 39, 71, 0.16)"
  
radii:
  small: "14px"
  medium: "18px"
  large: "20px"
  xlarge: "26px"
  pill: "999px"
---

# VPN Subscription Automation - 设计文档 (Design Spec)

## 项目背景与目标 (Background & Objective)
本项目是一个 **Electron 桌面前端 + Python 自动化后端** 应用。其核心目标是为用户提供一个自动化的 VPN 节点处理平台，包含从多数据源抓取节点、去重、代理连通性检测、测速过滤、地区可用性验证到最终产物渲染与 Cloudflare Pages 部署的全生命周期。

目前的客户端 UI 设计旨在为复杂的后端数据处理提供一个直观、现代、响应迅速的控制中心 (Dashboard)。

## 设计语言与原则 (Design Principles)
当前项目遵循以下核心设计原则，打造出一种 "Modern Tech Utility" (现代科技工具) 风格的设计：

1. **清晰的层级感 (Clear Visual Hierarchy)**
   - 大量使用柔和的背景色 (`#f5f7ff`) 与纯白 (`#ffffff`) 或微灰卡片 (`#f8faff`) 进行对比。
   - 使用柔和的阴影 (Soft Shadows) 为面板和浮层（如设置 Drawer）创造纵深。
2. **圆润柔和的视觉体验 (Friendly & Rounded Aesthetics)**
   - 卡片和按钮使用了非常圆润的倒角（Border Radii 集中在 14px、18px、20px 和 26px），赋予专业工具一种更易亲近、现代化、类似 Apple 平台级应用的质感。
3. **明亮且高对比度的主题强调色 (Vibrant Accents)**
   - 强调色选用了富有活力的靛蓝色 (`#5b5ce2`)，以渐变或纯色的方式运用于按钮、徽章和页面标题中。
4. **功能性状态指引 (Functional State Indicators)**
   - 利用浅色的背景配合亮色的文字 (`success-soft` + `success`)，在不破坏页面整洁度的前提下，为系统状态提供了一目了然的指引。
5. **专业沉浸的终端区域 (Immersive Terminal Areas)**
   - 在涉及后端运行日志输出时，使用了极高对比度的暗色背景 (`#111826`) 和终端等宽字体，保证了技术用户在查看日志时的专业沉浸感和阅读性。

## 布局与组件模式 (Layout & Component Patterns)
- **左侧导航 (Sidebar Navigation)**: 左侧为包含应用 Brand 和各个功能模块（概览、运行、结果、订阅、日志、设置）的导航栏，选中状态具有轻微的偏移和柔和的高亮底色。
- **动态控制面板 (Dashboards & Grids)**: 页面中运用了大量的 `Grid` 布局，并配合不同宽度和比例的卡片 (Metric Cards, Panel) 用于展示数据概览。
- **悬浮抽屉 (Floating Drawer)**: 在设置界面中，次级详细配置通过屏幕中央带背景模糊的 Overlay Drawer 展示，以保持用户的当前上下文。

## 现有页面截图一览 (Screenshots Reference)

下面是当前客户端的主要页面视图，作为接下来重新设计的参考。

### 1. 概览 (Dashboard)
展示了总体节点信息、系统状态和关键指标。
![Dashboard](/Users/swimmingliu/data/VPN/vpn-subscription-automation/artifacts/screenshots/dashboard.png)

### 2. 运行 (Runs Workspace)
流程控制、数据源选取以及流水线各阶段可视化展示。
![Runs](/Users/swimmingliu/data/VPN/vpn-subscription-automation/artifacts/screenshots/runs.png)

### 3. 结果 (Results)
自动化产物的归档和生成文件列表展示。
![Results](/Users/swimmingliu/data/VPN/vpn-subscription-automation/artifacts/screenshots/results.png)

### 4. 订阅 (Subscriptions)
各类客户端订阅链接的汇总与二维码预览。
![Subscriptions](/Users/swimmingliu/data/VPN/vpn-subscription-automation/artifacts/screenshots/subscriptions.png)

### 5. 日志 (Logs)
后端全生命周期的输出流向以及运行细节，包含深色终端组件。
![Logs](/Users/swimmingliu/data/VPN/vpn-subscription-automation/artifacts/screenshots/logs.png)

### 6. 设置 (Settings)
整体配置入口。
![Settings](/Users/swimmingliu/data/VPN/vpn-subscription-automation/artifacts/screenshots/settings.png)

### 7. 设置抽屉层 (Settings Drawer)
在设置中展开具体配置项时使用的沉浸式浮层设计。
![Settings Drawer](/Users/swimmingliu/data/VPN/vpn-subscription-automation/artifacts/screenshots/settings_drawer.png)

---
*此文档涵盖了所有现有的 UI 状态和设计基准，可用于在 Stitch 中指导接下来的 Electron 客户端页面重设计。*
