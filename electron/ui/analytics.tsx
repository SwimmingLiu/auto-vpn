import { useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from 'motion/react';
import { DonutChart, DonutChartCenter, DonutChartPlot, useDonutChart, type DonutSegment } from './vendor/beui/components/charts/donut-chart';
import { HeatCalendar, HeatCalendarGrid, HeatCalendarTooltip, useHeatCalendar } from './vendor/beui/components/charts/heat-calendar';
import { EASE_OUT, SPRING_PRESS } from './vendor/beui/lib/ease';

interface AnalyticsInput {
  regionStats: { region: string; count: number }[];
  sourceCounts: Record<string, { deduped_links?: number }>;
  activity: { date: string; nodes: number; runs: number }[];
  activityUnavailable?: number;
}

/**
 * Nineteen hues, ordered so neighbours differ in both hue and lightness.
 *
 * A six-colour cycle repeats long before a real run's country count, and two
 * adjacent slices then read as one value. The first four are the brand family
 * (indigo → teal → amber → violet) so the dominant countries carry the identity.
 */
const colors = [
  '#5b5ce2', '#12a594', '#e08b1f', '#a259d6', '#2f86d8', '#e0507e',
  '#6f9a2e', '#d1622a', '#17a2b8', '#7c5cd6', '#b08a1e', '#3f74c4',
  '#d1508f', '#3f9e63', '#9a6b3f', '#6f74e0', '#1f8e70', '#d1453f',
  '#4f8ea3'
];
const sourceNames: Record<string, string> = { leiting: '雷霆', heidong: '黑洞', mifeng: '蜜蜂', xuanfeng: '旋风' };
let active: { element: HTMLElement; root: Root } | null = null;

/** Regional-indicator flag from an ISO alpha-2 code; '' for anything else. */
function flagOf(code: string): string {
  const value = String(code ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(value)) return '';
  return String.fromCodePoint(...[...value].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65));
}

/**
 * The card's own light.
 *
 * A soft radial wash sits behind the ring, tinted by whichever country is
 * focused, so hovering a chip moves the light as well as the arc — the two
 * read as one object rather than a chart plus a list.
 */
function CardAura({ color, active }: { color: string; active: boolean }) {
  return <span
    aria-hidden="true"
    className="analytics-aura"
    style={{ background: `radial-gradient(58% 68% at 14% 42%, ${color}${active ? '3d' : '20'} 0%, transparent 72%)` }}
  />;
}

/**
 * Horizontal legend chips.
 *
 * The vendored legend stacks one full-width row per segment. With nineteen
 * countries that is a tall column that stretches the panel and pushes the
 * calendar down: the ring becomes the short element and the legend the long
 * one. Chips wrap across the row instead, so the card keeps the ring's height
 * and the countries read left to right.
 */
function LegendChips() {
  const { placed, active: focused, setActive, canHover, formatValue, total } = useDonutChart();
  const reduce = useReducedMotion() ?? false;
  return <ul className="distribution-chips">
    {placed.map((segment, index) => (
      <motion.li
        key={segment.id}
        initial={reduce ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduce ? 0 : 0.34, ease: EASE_OUT, delay: reduce ? 0 : 0.12 + index * 0.022 }}
      >
        <motion.button
          type="button"
          data-donut-legend
          className={`distribution-chip${focused === segment.id ? ' is-active' : ''}`}
          style={{ ['--chip-color' as string]: segment.color }}
          whileHover={reduce ? undefined : { y: -2 }}
          whileTap={reduce ? undefined : { scale: 0.96 }}
          transition={SPRING_PRESS}
          onPointerEnter={canHover ? () => setActive(segment.id) : undefined}
          onPointerLeave={canHover ? () => setActive(null) : undefined}
          onFocus={() => setActive(segment.id)}
          onBlur={() => setActive(null)}
          aria-label={`${segment.name} ${segment.value} 个节点，占 ${Math.round(segment.share * 100)}%`}
        >
          <span aria-hidden="true" className="distribution-dot" style={{ backgroundColor: segment.color }} />
          {flagOf(segment.id) ? <span aria-hidden="true" className="distribution-flag">{flagOf(segment.id)}</span> : null}
          <span className="min-w-0 distribution-name">{segment.name}</span>
          <strong className="distribution-value">{formatValue(segment.value)}</strong>
          <span className="distribution-share">{Math.round((segment.value / total) * 100)}%</span>
        </motion.button>
      </motion.li>
    ))}
  </ul>;
}

/**
 * The ring's readout.
 *
 * Idle it shows the total; focused it shows that country's count, its flag and
 * its share, so the number in the hole always answers "of what".
 */
function RingReadout() {
  const { placed, active: focused, total, formatValue } = useDonutChart();
  const reduce = useReducedMotion() ?? false;
  const segment = placed.find((item) => item.id === focused) ?? null;
  const value = segment?.value ?? total;
  return <div className="ring-readout">
    <AnimatePresence initial={false} mode="popLayout">
      <motion.strong
        key={`value-${value}`}
        className="ring-value"
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: -10 }}
        transition={{ duration: reduce ? 0.1 : 0.24, ease: EASE_OUT }}
      >{formatValue(value)}</motion.strong>
    </AnimatePresence>
    <AnimatePresence initial={false} mode="popLayout">
      <motion.span
        key={segment?.id ?? 'total'}
        className="ring-caption"
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
        transition={{ duration: reduce ? 0.1 : 0.2, ease: EASE_OUT }}
      >
        {segment ? <>
          <span aria-hidden="true" className="distribution-dot" style={{ backgroundColor: segment.color }} />
          {flagOf(segment.id)} {segment.name} · {Math.round(segment.share * 100)}%
        </> : '节点总数'}
      </motion.span>
    </AnimatePresence>
  </div>;
}

function Distribution({ title, segments, label }: { title: string; segments: DonutSegment[]; label: string }) {
  // Largest first: the ring reads clockwise from the dominant country and the
  // chips start with the values worth acting on.
  const sorted = useMemo(
    () => [...segments].filter((segment) => segment.value > 0).sort((left, right) => right.value - left.value),
    [segments]
  );
  const total = sorted.reduce((sum, item) => sum + item.value, 0);
  const [focused, setFocused] = useState<string | null>(null);
  const focusColor = sorted.find((segment) => segment.id === focused)?.color ?? sorted[0]?.color ?? colors[0];
  return <article className="panel analytics-distribution" aria-label={title}>
    {total > 0 ? <CardAura color={focusColor} active={focused !== null} /> : null}
    <div className="analytics-heading">
      <h3>{title}</h3>
      <span className="analytics-count">{total > 0 ? <><strong>{sorted.length}</strong> 个{label}</> : null}</span>
    </div>
    {total > 0 ? <DonutChart
      segments={sorted}
      label={title}
      formatValue={(value) => value.toLocaleString('zh-CN')}
      thickness={24}
      gap={2.5}
      activeId={focused}
      onActiveChange={setFocused}
    >
      <div className="distribution-layout">
        <DonutChartPlot className="distribution-plot"><DonutChartCenter>{() => <RingReadout />}</DonutChartCenter></DonutChartPlot>
        <LegendChips />
      </div>
    </DonutChart> : <div className="chart-empty" role="status"><span className="empty-donut" aria-hidden="true" /><span>运行完成后显示</span></div>}
  </article>;
}

/**
 * A 100% stacked bar for a short list.
 *
 * Four accelerators in a ring leaves most of a full-width card empty, and four
 * arcs are hard to compare by angle. One bar split by share fills the row it
 * already has, lines the sources up against each other, and grows in from the
 * left so the split reads as one measurement rather than four boxes.
 */
function ShareBar({ title, segments, label }: { title: string; segments: DonutSegment[]; label: string }) {
  const reduce = useReducedMotion() ?? false;
  const sorted = useMemo(
    () => [...segments].filter((segment) => segment.value > 0).sort((left, right) => right.value - left.value),
    [segments]
  );
  const total = sorted.reduce((sum, item) => sum + item.value, 0);
  const [focused, setFocused] = useState<string | null>(null);
  return <article className="panel analytics-distribution analytics-share" aria-label={title}>
    {total > 0 ? <CardAura color={sorted.find((segment) => segment.id === focused)?.color ?? sorted[0]?.color ?? colors[0]} active={focused !== null} /> : null}
    <div className="analytics-heading">
      <h3>{title}</h3>
      <span className="analytics-count">{total > 0 ? <><strong>{sorted.length}</strong> 个{label}</> : null}</span>
    </div>
    {total > 0 ? <>
      <div className="share-track" role="img" aria-label={`${title}：${sorted.map((segment) => `${segment.name} ${segment.value}`).join('，')}`}>
        {sorted.map((segment, index) => <motion.span
          key={segment.id}
          className={`share-segment${focused === segment.id ? ' is-active' : ''}${focused !== null && focused !== segment.id ? ' is-dimmed' : ''}`}
          style={{ flexGrow: segment.value, ['--segment-color' as string]: segment.color }}
          initial={reduce ? false : { scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: reduce ? 0 : 0.62, ease: EASE_OUT, delay: reduce ? 0 : 0.08 + index * 0.07 }}
          title={`${segment.name} ${segment.value}（${Math.round((segment.value / total) * 100)}%）`}
        />)}
      </div>
      <ul className="distribution-chips share-chips">
        {sorted.map((segment, index) => <motion.li
          key={segment.id}
          initial={reduce ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduce ? 0 : 0.34, ease: EASE_OUT, delay: reduce ? 0 : 0.3 + index * 0.06 }}
        >
          <motion.button
            type="button"
            className={`distribution-chip${focused === segment.id ? ' is-active' : ''}`}
            style={{ ['--chip-color' as string]: segment.color }}
            whileHover={reduce ? undefined : { y: -2 }}
            whileTap={reduce ? undefined : { scale: 0.96 }}
            transition={SPRING_PRESS}
            onPointerEnter={() => setFocused(segment.id)}
            onPointerLeave={() => setFocused(null)}
            onFocus={() => setFocused(segment.id)}
            onBlur={() => setFocused(null)}
            aria-label={`${segment.name} ${segment.value} 个节点，占 ${Math.round((segment.value / total) * 100)}%`}
          >
            <span aria-hidden="true" className="distribution-dot" style={{ backgroundColor: segment.color }} />
            <span className="distribution-name">{segment.name}</span>
            <strong className="distribution-value">{segment.value.toLocaleString('zh-CN')}</strong>
            <span className="distribution-share">{Math.round((segment.value / total) * 100)}%</span>
          </motion.button>
        </motion.li>)}
      </ul>
    </> : <div className="chart-empty" role="status"><span className="empty-donut" aria-hidden="true" /><span>运行完成后显示</span></div>}
  </article>;
}

function ContributionLegend() {
  const { start, end, fill } = useHeatCalendar();
  return <div className="contribution-legend"><span>{start?.toISOString().slice(0, 7)} 至 {end?.toISOString().slice(0, 7)}</span><span className="contribution-scale">少{[0, 1, 2, 3, 4].map((level) => <i key={level} style={{ background: fill(level) }} aria-hidden="true" />)}多</span></div>;
}

function ContributionCalendar({ activity, unavailable = 0 }: { activity: AnalyticsInput['activity']; unavailable?: number }) {
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
  const flat = counts.flat();
  const total = flat.reduce((sum, value) => sum + value, 0);
  const activeDays = flat.filter((value) => value > 0).length;
  const best = Math.max(0, ...flat);
  return <article className="panel analytics-calendar" aria-label="每日节点产出">
    <div className="analytics-heading">
      <h3>每日产出</h3>
      <span className="analytics-count" title="按保留的运行记录累计最终可用节点，同一节点在不同运行中会分别计数">
        <strong>{total.toLocaleString('zh-CN')}</strong> 个节点
        {unavailable > 0 ? <span className="activity-unavailable" title={`${unavailable} 次运行缺少可确认的最终节点记录`}> · {unavailable} 次记录不完整</span> : null}
      </span>
    </div>
    <div className="calendar-stats">
      <span className="calendar-stat"><span>有产出</span><strong>{activeDays}</strong><span>天</span></span>
      <span className="calendar-stat"><span>单日最高</span><strong>{best.toLocaleString('zh-CN')}</strong><span>个</span></span>
      <span className="calendar-stat"><span>日均</span><strong>{activeDays ? Math.round(total / activeDays).toLocaleString('zh-CN') : '0'}</strong><span>个</span></span>
    </div>
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
  const regions = dedupeRegions(input.regionStats).map((item, index) => ({ id: item.region, name: item.region, value: item.count, color: colors[index % colors.length] }));
  const sources = Object.entries(input.sourceCounts).map(([name, counts], index) => ({ id: name, name: sourceNames[name] ?? name, value: Number(counts.deduped_links ?? 0), color: colors[index % colors.length] }));
  return <MotionConfig reducedMotion="user"><div className="dashboard-analytics" data-component-source="beui">
    <div className="analytics-distributions"><Distribution title="国家分布" label="国家" segments={regions} /><ShareBar title="加速器贡献" label="来源" segments={sources} /></div>
    <ContributionCalendar activity={input.activity} unavailable={input.activityUnavailable} />
  </div></MotionConfig>;
}

/**
 * One entry per region code.
 *
 * Counts arrive already aggregated, but a caller that concatenates several
 * snapshots would otherwise draw the same country twice on the ring.
 */
function dedupeRegions(rows: AnalyticsInput['regionStats']): AnalyticsInput['regionStats'] {
  const merged = new Map<string, number>();
  for (const row of rows ?? []) {
    const region = String(row?.region ?? '').trim().toUpperCase();
    if (!region) continue;
    merged.set(region, (merged.get(region) ?? 0) + Number(row.count ?? 0));
  }
  return [...merged.entries()].map(([region, count]) => ({ region, count }));
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
