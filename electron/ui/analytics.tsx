import { createRoot, type Root } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import { DonutChart, DonutChartCenter, DonutChartLegend, DonutChartPlot, type DonutSegment } from './vendor/beui/components/charts/donut-chart';
import { HeatCalendar, HeatCalendarGrid, HeatCalendarTooltip, useHeatCalendar } from './vendor/beui/components/charts/heat-calendar';

interface AnalyticsInput {
  regionStats: { region: string; count: number }[];
  sourceCounts: Record<string, { deduped_links?: number }>;
  activity: { date: string; nodes: number; runs: number }[];
}

const colors = ['#6663df', '#23a79b', '#df9e40', '#a677d4', '#5499d8', '#d37293'];
const sourceNames: Record<string, string> = { leiting: '雷霆', heidong: '黑洞', mifeng: '蜜蜂', xuanfeng: '旋风' };
let active: { element: HTMLElement; root: Root } | null = null;

function Distribution({ title, segments }: { title: string; segments: DonutSegment[] }) {
  const total = segments.reduce((sum, item) => sum + item.value, 0);
  return <article className="panel analytics-distribution" aria-label={title}>
    <h3>{title}</h3>
    {total > 0 ? <DonutChart segments={segments} label={title} formatValue={(value) => `${value} 个`} thickness={25}>
      <div className="distribution-layout">
        <DonutChartPlot><DonutChartCenter totalLabel="节点" /></DonutChartPlot>
        <DonutChartLegend renderValue={(segment) => <><strong>{segment.value}</strong><span className="distribution-share">{Math.round(segment.share * 100)}%</span></>} />
      </div>
    </DonutChart> : <div className="chart-empty" role="status"><span className="empty-donut" aria-hidden="true" /><span>暂无数据</span></div>}
  </article>;
}

function ContributionLegend() {
  const { start, end, fill } = useHeatCalendar();
  return <div className="contribution-legend"><span>{start?.toISOString().slice(0, 7)} 至 {end?.toISOString().slice(0, 7)}</span><span className="contribution-scale">少{[0, 1, 2, 3, 4].map((level) => <i key={level} style={{ background: fill(level) }} aria-hidden="true" />)}多</span></div>;
}

function ContributionCalendar({ activity }: { activity: AnalyticsInput['activity'] }) {
  // The component uses UTC calendar arithmetic; encode the user's local date
  // as a UTC date-only value so midnight does not move the highlighted day.
  const now = new Date(Date.now());
  const end = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const monday = new Date(end);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  const start = new Date(monday);
  start.setUTCDate(start.getUTCDate() - 52 * 7);
  const byDay = new Map(activity.map((day) => [day.date, day.nodes]));
  const counts = Array.from({ length: 53 }, (_, week) => Array.from({ length: 7 }, (_, day) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + week * 7 + day);
    return date > end ? 0 : byDay.get(date.toISOString().slice(0, 10)) ?? 0;
  }));
  const maximum = Math.max(1, ...counts.flat());
  const total = counts.flat().reduce((sum, value) => sum + value, 0);
  return <article className="panel analytics-calendar" aria-label="每日节点产出">
    <div className="analytics-heading"><h3>每日产出</h3><span title="按保留的运行记录累计最终可用节点，同一节点在不同运行中会分别计数">{total.toLocaleString('zh-CN')} 个节点</span></div>
    <div className="calendar-scroll" tabIndex={0} role="region" aria-label="53 周节点贡献，可横向滚动">
      <div className="calendar-canvas">
        <HeatCalendar weeks={53} values={counts.map((week) => week.map((count) => count / maximum))} maxCount={maximum} endDate={end} color="var(--accent)" unit="个节点">
          <HeatCalendarGrid><HeatCalendarTooltip>{(tip) => <span>{tip.date.toISOString().slice(0, 10)} · {tip.days > 1 ? tip.total : tip.count} 个节点</span>}</HeatCalendarTooltip></HeatCalendarGrid>
          <ContributionLegend />
        </HeatCalendar>
      </div>
    </div>
  </article>;
}

function Analytics({ input }: { input: AnalyticsInput }) {
  const regions = input.regionStats.map((item, index) => ({ id: item.region, name: item.region, value: item.count, color: colors[index % colors.length] }));
  const sources = Object.entries(input.sourceCounts).map(([name, counts], index) => ({ id: name, name: sourceNames[name] ?? name, value: Number(counts.deduped_links ?? 0), color: colors[index % colors.length] }));
  return <MotionConfig reducedMotion="user"><div className="dashboard-analytics" data-component-source="beui">
    <div className="analytics-distributions"><Distribution title="国家分布" segments={regions} /><Distribution title="加速器贡献" segments={sources} /></div>
    <ContributionCalendar activity={input.activity} />
  </div></MotionConfig>;
}

export function renderAnalytics(element: HTMLElement | null, input: AnalyticsInput) {
  if (!element) return;
  if (active?.element !== element) {
    clearAnalytics();
    active = { element, root: createRoot(element) };
  }
  active.root.render(<Analytics input={input} />);
}

export function clearAnalytics() {
  active?.root.unmount();
  active = null;
}
