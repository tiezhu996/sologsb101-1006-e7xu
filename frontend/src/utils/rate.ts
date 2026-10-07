/**
 * 裂缝发展速率计算与分级
 * 速率口径：相邻两次可见复测的宽度变化量 ÷ 间隔天数 × 30，单位 mm/月
 * 遮挡（暂不可见）测次不参与取点：恢复测次与最后一次可见读数比对，
 * 按实际间隔天数（含遮挡期）折算速率，避免遮挡期累计扩展量被漏计。
 */
import type { AdviceLevel } from '@/types/advice'
import type { OcclusionInterval, Survey, SurveyPoint } from '@/types/survey'

/** 预警阈值：月均速率 ≥ 0.10 mm/月 记预警（较重及以上） */
export const RATE_WARNING = 0.1
/** 严重阈值：月均速率 ≥ 0.25 mm/月 */
export const RATE_SEVERE = 0.25

/** 四舍五入到指定小数位 */
export function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** 两个 YYYY-MM-DD 日期之间的天数（至少为 1，避免除零） */
export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00`)
  const end = Date.parse(`${to}T00:00:00`)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 1
  const days = Math.round((end - start) / 86400000)
  return days > 0 ? days : 1
}

/** 月均速率（mm/月） */
export function monthlyRate(deltaWidthMm: number, days: number): number {
  const span = days > 0 ? days : 1
  return round((deltaWidthMm / span) * 30, 3)
}

/** 由速率分级：< 0.10 一般，< 0.25 较重，≥ 0.25 严重 */
export function levelFromRate(rate: number): AdviceLevel {
  if (rate >= RATE_SEVERE) return '严重'
  if (rate >= RATE_WARNING) return '较重'
  return '一般'
}

/** 速率对应的 Element Plus 语义色 */
export function rateTone(rate: number): 'success' | 'warning' | 'danger' {
  const level = levelFromRate(rate)
  if (level === '严重') return 'danger'
  if (level === '较重') return 'warning'
  return 'success'
}

export const LEVEL_COLOR: Record<AdviceLevel, string> = {
  一般: '#1e8449',
  较重: '#d68910',
  严重: '#c0392b'
}

export const LEVEL_BG: Record<AdviceLevel, string> = {
  一般: '#eaf6ee',
  较重: '#fdf3e3',
  严重: '#fdecea'
}

/** Element Plus 图标组件名，供 <LevelTag> 动态渲染 */
export const LEVEL_ICON: Record<AdviceLevel, string> = {
  一般: 'SuccessFilled',
  较重: 'WarningFilled',
  严重: 'CircleCloseFilled'
}

export const LEVEL_WEIGHT: Record<AdviceLevel, number> = {
  一般: 10,
  较重: 20,
  严重: 30
}

/** 判断测次是否为遮挡登记（历史数据缺 kind 字段时按普通读数处理） */
export function isOccluded(survey: Survey): boolean {
  return survey.kind === 'occluded'
}

/**
 * 把某条裂缝的测次按顺序配对成遮挡区间：
 * 每条遮挡登记与其后第一条普通测次（恢复测次）配对；recovery 为 null 表示仍处遮挡期。
 */
export function occlusionIntervals(surveys: Survey[]): OcclusionInterval[] {
  const sorted = [...surveys].sort((a, b) => a.seq - b.seq)
  const intervals: OcclusionInterval[] = []
  let open: Survey | null = null
  sorted.forEach((row) => {
    if (isOccluded(row)) {
      if (open) intervals.push({ occlusion: open, recovery: null })
      open = row
    } else if (open) {
      intervals.push({ occlusion: open, recovery: row })
      open = null
    }
  })
  if (open) intervals.push({ occlusion: open, recovery: null })
  return intervals
}

/** 当前是否处于遮挡期（末次测次为未恢复的遮挡登记） */
export function openOcclusionOf(surveys: Survey[]): OcclusionInterval | null {
  const intervals = occlusionIntervals(surveys)
  return intervals.find((interval) => interval.recovery === null) ?? null
}

/**
 * 把某条裂缝的全部测次整理成折线取点（按测次升序）。
 * 遮挡行跳过不取点；恢复测次与最后一次可见读数比对，按实际间隔天数折算速率。
 */
export function buildSurveyPoints(surveys: Survey[]): SurveyPoint[] {
  const sorted = [...surveys].sort((a, b) => a.seq - b.seq)
  const visible = sorted.filter((survey) => !isOccluded(survey))
  const points: SurveyPoint[] = []
  visible.forEach((survey, index) => {
    const previous = index === 0 ? null : visible[index - 1]
    const rawDelta = previous ? survey.widthMm - previous.widthMm : 0
    const days = previous ? daysBetween(previous.date, survey.date) : 1
    let skipped = 0
    if (previous) {
      const from = sorted.indexOf(previous)
      const to = sorted.indexOf(survey)
      skipped = sorted.slice(from + 1, to).filter((row) => isOccluded(row)).length
    }
    points.push({
      seq: survey.seq,
      date: survey.date,
      widthMm: survey.widthMm,
      lengthMm: survey.lengthMm,
      deltaWidthMm: round(previous ? rawDelta : survey.deltaWidthMm, 2),
      rate: previous ? monthlyRate(rawDelta, days) : 0,
      resumed: typeof survey.recoversOcclusionId === 'string' && survey.recoversOcclusionId.length > 0,
      skippedBefore: skipped,
      spanDays: previous ? days : 0
    })
  })
  return points
}

/** 最新测次的月均速率 */
export function latestRate(points: SurveyPoint[]): number {
  if (points.length === 0) return 0
  return points[points.length - 1].rate
}

/** 累计宽度变化量（末测次 - 首测次） */
export function totalDelta(points: SurveyPoint[]): number {
  if (points.length < 2) return 0
  return round(points[points.length - 1].widthMm - points[0].widthMm, 2)
}

/** 判定依据文案 */
export function basisText(rate: number, level: AdviceLevel): string {
  return `月均发展速率 ${formatRate(rate)}，按阈值分级判定为「${level}」（预警 ${RATE_WARNING} mm/月、严重 ${RATE_SEVERE} mm/月）`
}

/** 毫米格式化 */
export function formatMm(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—'
  return `${round(value, digits).toFixed(digits)} mm`
}

/** 速率格式化 */
export function formatRate(rate: number): string {
  if (!Number.isFinite(rate)) return '—'
  return `${rate.toFixed(3)} mm/月`
}

/** 长度（mm → m）格式化 */
export function formatLengthMm(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return value >= 1000 ? `${(value / 1000).toFixed(2)} m` : `${round(value, 0)} mm`
}
