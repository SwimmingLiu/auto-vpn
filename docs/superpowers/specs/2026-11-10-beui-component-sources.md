# beUI 图表接入依据

来源固定为官方提交 [`fb52f599d1550f006afe0344022cc45a913adab1`](https://github.com/starc007/ui-components/commit/fb52f599d1550f006afe0344022cc45a913adab1)。[Donut Chart](https://beui.dev/charts/donut-chart)、[Heat Calendar](https://beui.dev/charts/heat-calendar) 均为 React 源码组件，采用 [MIT 许可][license]，复制时保留版权和许可。

## API 与数据

| 组件 | 实际接口 |
| --- | --- |
| Donut | 导出 `DonutChart`、`DonutChartPlot`、`DonutChartCenter`、`DonutChartLegend`、`useDonutChart`，以及对应 Props、`DonutSegment`、`DonutPlacedSegment`。必填 `segments: readonly DonutSegment[]`，每项 `{ id, name, color, value }`；派生项另含 `share`、`path`。[入口][donut]、[类型][donut-model] |
| Donut 选项 | `thickness=22`、`gap=3`；`activeId/defaultActiveId/onActiveChange` 控制强调，`selectedId/onSelect` 控制选择。`formatValue` 默认 en-US，`label` 默认 Donut chart。Center 支持 `totalLabel`、渲染函数；Legend 支持 `renderDetail/renderValue`。[上下文][donut-context]、[Center][donut-center]、[Legend][donut-legend] |
| Heat | 导出 `HeatCalendar`、`HeatCalendarGrid`、`HeatCalendarLegend`、`HeatCalendarTooltip`、`useHeatCalendar`，类型 `HeatCalendarProps`、`HeatCalendarCell`、`HeatCalendarSelection`。`values?: number[][]` 按 `[week][day]` 提供 0..1 强度；`weeks=16`、`maxCount=14`、`unit="commits"`、`color="var(--accent)"`。[入口][heat]、[类型][heat-types]、[模型][heat-model] |
| Heat 选择 | `selection/defaultSelection/onSelectionChange`；结构 `{ start: { w, d }, end?: { w, d } }`，零起点，周一为 d=0。依次点击设置起点、锁定终点、清除；同一起点再点击清除。[模型][heat-model] |

Donut 对国家、加速器等互斥分组求和；零、负数及非有限值均被排除，空数据只留下底环、0 中心和空图例。Heat 缺值按 0 处理，显示次数为 `Math.round(intensity * maxCount)`，适配器用 `count / maxCount` 归一化，并验证有限次数和正数上限；源码裁切越界值，但不排除 NaN。未知历史应由宿主显示数据状态，避免映射为已确认的零次。[Donut 模型][donut-model]、[Plot][donut-plot]、[Heat 模型][heat-model]

Heat 使用 UTC 日界，起点为 `mondayOf(endDate) - (weeks - 1) * 7 天`，未来格不渲染。53 周表示当前周及前 52 周；应明确传入 UTC `endDate` 并按相同规则聚合。格宽 16px、间隔 4px，53 周宽 1056px；默认 max-width 会压缩格子，宿主可用横向滚动加 1056px 内层最小宽度保留尺寸。[日期模型][heat-model]、[尺寸/日期工具][heat-utils]、[Grid][heat-grid]

最小调用中，`sourceSegments` 为上述分段数组，`normalizedWeeks` 为 53×7 强度，`utcEndDate` 是明确的 UTC 日期。[Donut 组合][donut]、[Heat 组合][heat]

```tsx
<>
<DonutChart segments={sourceSegments} label="国家分布" formatValue={formatCount}>
  <DonutChartPlot>
    <DonutChartCenter totalLabel="节点数" />
  </DonutChartPlot>
  <DonutChartLegend />
</DonutChart>
<HeatCalendar weeks={53} values={normalizedWeeks} maxCount={dailyMaximum}
  endDate={utcEndDate} color="var(--accent)" unit="次运行" />
</>
```

## 交互与样式

Donut 图例支持 focus 和上下方向键循环；只有图例激活调用 `onSelect`，环本身只处理 hover。SVG 有名称，中心使用 polite live region。Heat 日期格均为按钮，支持 focus、激活和 Escape 清除，带次数/日期名称与 Tooltip 描述关联；源码没有方向键导航或 roving tabindex，53 周会产生数百个 Tab 停靠点。[Legend][donut-legend]、[Plot][donut-plot]、[Center][donut-center]、[Grid][heat-grid]

Heat 日期格式固定 en-US/UTC，图例含 less/more，Tooltip 含 days；需要在对应 vendored 文件中定点中文化。Tooltip children 可自定义，渲染函数收到 `date/count/total/startDate/endDate/days`。[工具][heat-utils]、[Legend][heat-legend]、[Tooltip][heat-tooltip]

Tooltip portal 到 body，以单元格 DOM 锚定，使用 fixed、8px 间隔、flip/shift 的 8px 边距、自动更新和裁切隐藏；内容宽度最多 `min(20rem, 100vw - 16px)`。位置容器 z-index 为 9999，不判断宿主弹窗遮挡。变量须在 root/body 可用；实测四角、滚动、长文案与弹窗。[Tooltip][tooltip]、[定位][position]、[容器][positioner]

两图读取 reduced-motion，减少环入场、波浪、抬升和数字滚动，仍保留部分淡入淡出；验收不能假定完全无动画。[Plot][donut-plot]、[Grid][heat-grid]、[数字滚动][number-ticker]、[Tooltip 表面][tooltip-surface]

| beUI token | AutoVPN 映射 |
| --- | --- |
| background / foreground | `var(--surface)` / `var(--text)` |
| muted / muted-foreground | `var(--surface-muted)` / `var(--text-soft)` |
| border / ring / accent | 保留 `--border` / `var(--accent)` / 保留 `--accent` |

以上均为 CSS `--` 变量，再以 `@theme inline` 映射 `--color-*`。`muted` 同时用于 Donut 底环、图例背景；浅色主色沿用 `#5b5ce2`。只构建岛及 vendor 所需 utilities；避免全站 Preflight，处理宿主未分层 button 背景、border、font 规则与 utilities 的覆盖关系。[上游主题][theme]、[AutoVPN 主题](/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/workspace.css)、[基础样式](/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/styles.css)、[Tailwind Preflight](https://tailwindcss.com/docs/preflight)

## 依赖与接入边界

| 当前固定依赖 | 上游声明 |
| --- | --- |
| React / React DOM 19.3.1 | 各 `^19.0.0` |
| Motion 14.11.1 | `^12` |
| Floating UI DOM 1.8.0、clsx 2.1.1、tailwind-merge 3.7.0 | `^1.8.0`、`^2.1.1`、`^3.6.0` |
| Tailwind / CLI 4.3.5、esbuild 0.28.2 | Tailwind `^4.0.0`；esbuild 为宿主构建工具 |

运行时包名为 `react`、`react-dom`、`motion`、`@floating-ui/dom`、`clsx`、`tailwind-merge`；源码导入 `motion/react`。Motion 14 超出上游声明范围，打包通过仅证明依赖可编译，交互仍需浏览器/Electron 验证。[上游 package.json][upstream-package]、[AutoVPN package.json](/Users/swimmingliu/data/VPN/vpn-subscription-automation/package.json)

采用 `electron/ui/vendor/beui` 保存源码，esbuild 解析 `@/` 并输出本地图表模块，Tailwind 输出配套 CSS。原生 `app.js` 保持页面管理，在图表占位节点使用 `createRoot`。现有 `renderAll()` 替换 pageContent 前必须 `root.unmount()` 清理 portal、监听和观察器；更新能复用节点时使用同一 root，需保留的选择状态交给宿主。[宿主渲染](/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js)、[React 局部挂载与卸载](https://react.dev/reference/react-dom/client/createRoot)

原始快照 `/tmp/autovpn-beui-source` 的 [COPY_FILES.txt](/tmp/autovpn-beui-source/COPY_FILES.txt) 列出 27 个源码文件及 [LICENSE](/tmp/autovpn-beui-source/LICENSE)；`source-manifest.json` 记录固定 URL/SHA256，`source-validation.json` 记录 imports、哈希、manifest 校验，`bundle-validation.json` 仅记录 browser ESM 打包通过。Heat 已包含完整 Tooltip 依赖；三处注册表入口差异仅为来源注释。随 vendor 保留这些来源与许可，单独记录本地适配。[来源清单](/tmp/autovpn-beui-source/source-manifest.json)、[源码验证](/tmp/autovpn-beui-source/source-validation.json)、[打包验证](/tmp/autovpn-beui-source/bundle-validation.json)

[donut]: https://github.com/starc007/ui-components/blob/fb52f599d1550f006afe0344022cc45a913adab1/components/charts/donut-chart.tsx
[donut-model]: https://github.com/starc007/ui-components/blob/fb52f599d1550f006afe0344022cc45a913adab1/components/charts/donut-chart/model.ts
[donut-context]: https://github.com/starc007/ui-components/blob/fb52f599d1550f006afe0344022cc45a913adab1/components/charts/donut-chart/context.tsx
[donut-plot]: https://github.com/starc007/ui-components/blob/fb52f599d1550f006afe0344022cc45a913adab1/components/charts/donut-chart/plot.tsx
[donut-center]: https://github.com/starc007/ui-components/blob/fb52f599d1550f006afe0344022cc45a913adab1/components/charts/donut-chart/center.tsx
[donut-legend]: https://github.com/starc007/ui-components/blob/fb52f599d1550f006afe0344022cc45a913adab1/components/charts/donut-chart/legend.tsx
[heat]: https://github.com/starc007/ui-components/blob/fb52f599d1550f006afe0344022cc45a913adab1/components/charts/heat-calendar.tsx
[heat-types]: https://github.com/starc007/ui-components/blob/fb52f599d1550f006afe0344022cc45a913adab1/components/charts/heat-calendar/types.ts
[heat-model]: https://github.com/starc007/ui-components/blob/fb52f599d1550f006afe0344022cc45a913adab1/components/charts/heat-calendar/context.ts
[heat-utils]: https://github.com/starc007/ui-components/blob/fb52f599d1550f006afe0344022cc45a913adab1/components/charts/heat-calendar/utils.ts
[heat-grid]: https://github.com/starc007/ui-components/blob/fb52f599d1550f006afe0344022cc45a913adab1/components/charts/heat-calendar/grid.tsx
[heat-legend]: https://github.com/starc007/ui-components/blob/fb52f599d1550f006afe0344022cc45a913adab1/components/charts/heat-calendar/legend.tsx
[heat-tooltip]: https://github.com/starc007/ui-components/blob/fb52f599d1550f006afe0344022cc45a913adab1/components/charts/heat-calendar/tooltip.tsx
[tooltip]: https://github.com/starc007/ui-components/blob/fb52f599d1550f006afe0344022cc45a913adab1/components/motion/tooltip.tsx
[position]: https://github.com/starc007/ui-components/blob/fb52f599d1550f006afe0344022cc45a913adab1/components/motion/tooltip/use-position.ts
[positioner]: https://github.com/starc007/ui-components/blob/fb52f599d1550f006afe0344022cc45a913adab1/components/motion/tooltip/positioner.tsx
[tooltip-surface]: https://github.com/starc007/ui-components/blob/fb52f599d1550f006afe0344022cc45a913adab1/components/motion/tooltip-surface.tsx
[number-ticker]: https://github.com/starc007/ui-components/blob/fb52f599d1550f006afe0344022cc45a913adab1/components/motion/number-ticker.tsx
[theme]: https://github.com/starc007/ui-components/blob/fb52f599d1550f006afe0344022cc45a913adab1/lib/theme-css.ts
[upstream-package]: https://github.com/starc007/ui-components/blob/fb52f599d1550f006afe0344022cc45a913adab1/package.json
[license]: https://github.com/starc007/ui-components/blob/fb52f599d1550f006afe0344022cc45a913adab1/LICENSE
