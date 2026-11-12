import { createContext, useContext, useMemo, useState } from 'react';
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
 * Five hues plus one neutral, defined as theme tokens in workspace.css.
 *
 * A run lists twenty countries, but a twenty-hue ring is unreadable: past a
 * handful of slices the eye stops resolving arcs and every added hue makes its
 * neighbours muddier. The ring therefore seats the five largest countries and
 * folds the rest into one neutral "其他" slice - a key, not confetti. The hues
 * are fixed and validated for colour-vision separation against both card
 * surfaces; the neutral can never be mistaken for a real country. The folded
 * countries stay visible in the footnote under the chips.
 */
const SERIES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];
const REST = 'var(--chart-other)';
const MAX_SLICES = SERIES.length;
const OTHER_ID = '__other';
const sourceNames: Record<string, string> = { leiting: '雷霆', heidong: '黑洞', mifeng: '蜜蜂', xuanfeng: '旋风' };
let active: { element: HTMLElement; root: Root } | null = null;

/** A ring slice plus the rows folded into it, kept for the "其他" chip's title. */
interface ChartSegment extends DonutSegment {
  folded?: string[];
}

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
 * read as one object rather than a chart plus a list. The tint is mixed from
 * the token itself, so it follows the theme like the slice it mirrors.
 */
function CardAura({ color, active }: { color: string; active: boolean }) {
  return <span
    aria-hidden="true"
    className="analytics-aura"
    style={{ background: `radial-gradient(58% 68% at 14% 42%, color-mix(in srgb, ${color} ${active ? 26 : 13}%, transparent) 0%, transparent 72%)` }}
  />;
}

/**
 * Horizontal legend chips.
 *
 * The vendored legend stacks one full-width row per segment, which stretches
 * the panel to the length of the list. Chips wrap across the row instead, so
 * the card keeps the ring's height and the countries read left to right.
 *
 * The shares come from the card through context rather than being rounded
 * here, so the chips and the ring's readout always quote the same figure and
 * the column sums to 100 instead of drifting to 99 or 101.
 */
function RingLegend() {
  const { placed, active: focused, setActive, canHover, formatValue } = useDonutChart();
  const shares = useContext(ShareContext);
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
          title={(segment as ChartSegment).folded?.length ? `含 ${(segment as ChartSegment).folded!.join('、')}` : undefined}
          whileHover={reduce ? undefined : { y: -2 }}
          whileTap={reduce ? undefined : { scale: 0.96 }}
          transition={SPRING_PRESS}
          onPointerEnter={canHover ? () => setActive(segment.id) : undefined}
          onPointerLeave={canHover ? () => setActive(null) : undefined}
          onFocus={() => setActive(segment.id)}
          onBlur={() => setActive(null)}
          aria-label={`${segment.name} ${segment.value} 个节点，占 ${shares[index] ?? 0}%`}
        >
          <span aria-hidden="true" className="distribution-dot" style={{ backgroundColor: segment.color }} />
          {flagOf(segment.id) ? <span aria-hidden="true" className="distribution-flag">{flagOf(segment.id)}</span> : null}
          <span className="min-w-0 distribution-name">{segment.name}</span>
          <strong className="distribution-value">{formatValue(segment.value)}</strong>
          <span className="distribution-share">{shares[index] ?? 0}%</span>
        </motion.button>
      </motion.li>
    ))}
  </ul>;
}

/** Rounded shares for the ring, in the same order as its placed segments. */
const ShareContext = createContext<number[]>([]);

/**
 * The ring's readout.
 *
 * Idle it shows the total; focused it shows that country's count, its flag and
 * its share, so the number in the hole always answers "of what".
 */
function RingReadout() {
  const { placed, active: focused, total, formatValue } = useDonutChart();
  const shares = useContext(ShareContext);
  const reduce = useReducedMotion() ?? false;
  const segment = placed.find((item) => item.id === focused) ?? null;
  const index = placed.findIndex((item) => item.id === focused);
  const value = segment?.value ?? total;
  const share = index >= 0 ? shares[index] ?? Math.round((segment!.value / total) * 100) : 0;
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
          {flagOf(segment.id)} {segment.name} · {share}%
        </> : '节点总数'}
      </motion.span>
    </AnimatePresence>
  </div>;
}

function Distribution({ title, segments, tail, label }: { title: string; segments: ChartSegment[]; tail: { region: string; count: number }[]; label: string }) {
  // Named countries by size; the folded tail always closes the ring, so the
  // neutral bucket never outranks a country the reader can act on.
  const sorted = useMemo(() => {
    const named = segments.filter((segment) => segment.id !== OTHER_ID).sort((left, right) => right.value - left.value);
    const rest = segments.filter((segment) => segment.id === OTHER_ID);
    return [...named, ...rest];
  }, [segments]);
  const total = sorted.reduce((sum, item) => sum + item.value, 0);
  const countryCount = sorted.filter((segment) => segment.id !== OTHER_ID).length + tail.length;
  const shares = sharesOf(sorted.map((segment) => segment.value));
  const [focused, setFocused] = useState<string | null>(null);
  const focusColor = sorted.find((segment) => segment.id === focused)?.color ?? sorted[0]?.color ?? SERIES[0];
  return <article className="panel analytics-distribution" aria-label={title}>
    {total > 0 ? <CardAura color={focusColor} active={focused !== null} /> : null}
    <div className="analytics-heading">
      <h3>{title}</h3>
      <span className="analytics-count">{total > 0 ? <><strong>{countryCount}</strong> 个{label}</> : null}</span>
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
      <ShareContext.Provider value={shares}>
        <div className="distribution-layout">
          <DonutChartPlot className="distribution-plot"><DonutChartCenter>{() => <RingReadout />}</DonutChartCenter></DonutChartPlot>
          <div className="distribution-legend">
            <RingLegend />
            {tail.length ? <div className="distribution-footnote">
              <span className="footnote-lead">其他包括</span>
              <span className="footnote-entries">
                {tail.map((item) => <span className="footnote-entry" key={item.region}>{item.region} {item.count}</span>)}
              </span>
            </div> : null}
          </div>
        </div>
      </ShareContext.Provider>
    </DonutChart> : <div className="chart-empty" role="status"><span className="empty-donut" aria-hidden="true" /><span>运行完成后显示</span></div>}
  </article>;
}

/**
 * The accelerators, one aligned meter per source.
 *
 * A 100% bar across a wide card left most of the row empty and stranded the
 * figures in pills at the left edge, far from the segments they named. Aligned
 * rows instead: every name, track, count and share sits in the same column, so
 * the four values compare by position and by bar length at once. Each track is
 * the whole, so a bar's length *is* its share - the figure beside it can be
 * checked by eye, and two equal sources read as two half bars rather than two
 * full ones. All four share one hue: length already carries the value, and a
 * second meaning in colour would only compete with the country ring above it.
 */
function SourceMeters({ title, segments, label }: { title: string; segments: DonutSegment[]; label: string }) {
  const reduce = useReducedMotion() ?? false;
  const sorted = useMemo(
    () => [...segments].filter((segment) => segment.value > 0).sort((left, right) => right.value - left.value),
    [segments]
  );
  const total = sorted.reduce((sum, item) => sum + item.value, 0);
  // Row order is the display order, so the shares line up with the bars.
  const shares = sharesOf(sorted.map((item) => item.value));
  return <article className="panel analytics-distribution" aria-label={title}>
    {total > 0 ? <CardAura color="var(--chart-source)" active={false} /> : null}
    <div className="analytics-heading">
      <h3>{title}</h3>
      <span className="analytics-count">{total > 0 ? <><strong>{sorted.length}</strong> 个{label}</> : null}</span>
    </div>
    {total > 0 ? <div className="source-meters">
      {sorted.map((segment, index) => (
        <div className="source-row" key={segment.id}>
          <span className="source-name">{segment.name}</span>
          <span className="source-track" aria-hidden="true">
            <motion.span
              className="source-fill"
              style={{ width: `${(segment.value / total) * 100}%` }}
              initial={reduce ? false : { scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: reduce ? 0 : 0.56, ease: EASE_OUT, delay: reduce ? 0 : 0.1 + index * 0.06 }}
            />
          </span>
          <strong className="source-value">{segment.value.toLocaleString('zh-CN')}</strong>
          <span className="source-share">{shares[index]}%</span>
        </div>
      ))}
    </div> : <div className="chart-empty" role="status"><span className="empty-donut" aria-hidden="true" /><span>运行完成后显示</span></div>}
  </article>;
}

/**
 * Integer percentages that add up to 100.
 *
 * Rounding each share on its own drifts - 396/233/82/82 of 793 renders as
 * 50+29+10+10 = 99, and a reader who adds the column finds a missing point.
 * Largest remainder hands the leftover points to the rows that lost the most
 * in rounding, so the column closes without any single figure moving more
 * than a point.
 */
function sharesOf(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return values.map(() => 0);
  const exact = values.map((value) => (value / total) * 100);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((left, right) => right.remainder - left.remainder);
  const result = [...floors];
  for (let i = 0; left > 0 && i < order.length; i += 1, left -= 1) result[order[i].index] += 1;
  return result;
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
  const { segments: regions, tail } = buildRegionSegments(input.regionStats);
  const sources = Object.entries(input.sourceCounts).map(([name, counts]) => ({
    id: name,
    name: sourceNames[name] ?? name,
    value: Number(counts.deduped_links ?? 0),
    color: 'var(--chart-source)'
  }));
  return <MotionConfig reducedMotion="user"><div className="dashboard-analytics" data-component-source="beui">
    <div className="analytics-distributions"><Distribution title="国家分布" label="国家" segments={regions} tail={tail} /><SourceMeters title="加速器贡献" label="来源" segments={sources} /></div>
    <ContributionCalendar activity={input.activity} unavailable={input.activityUnavailable} />
  </div></MotionConfig>;
}

/**
 * The ring's data: five named countries plus one folded tail.
 *
 * Hues are positional - slot 1 is the largest country - because the set of
 * countries changes with every run; the legend names each slice, so colour is
 * a key rather than the only label. The tail keeps a neutral of its own so no
 * real country ever shares a hue with "其他", and it is also returned
 * separately so the card can list what was folded.
 */
function buildRegionSegments(rows: AnalyticsInput['regionStats']): {
  segments: ChartSegment[];
  tail: { region: string; count: number }[];
} {
  const sorted = dedupeRegions(rows).sort((left, right) => right.count - left.count);
  const head = sorted.slice(0, MAX_SLICES);
  const tail = sorted.slice(MAX_SLICES);
  const segments: ChartSegment[] = head.map((item, index) => ({
    id: item.region,
    name: item.region,
    value: item.count,
    color: SERIES[index]
  }));
  if (tail.length) {
    segments.push({
      id: OTHER_ID,
      name: '其他',
      value: tail.reduce((sum, item) => sum + item.count, 0),
      color: REST,
      folded: tail.map((item) => `${item.region} ${item.count}`)
    });
  }
  return { segments, tail };
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
  return [...merged.entries()]
    .filter(([, count]) => count > 0)
    .map(([region, count]) => ({ region, count }));
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
