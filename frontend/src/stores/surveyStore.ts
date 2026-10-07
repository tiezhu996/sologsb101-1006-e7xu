/**
 * 复测测次状态（Pinia）
 * 维护测次顺序、变化量缓存与按裂缝汇总的发展速率。
 * 支持「暂不可见」遮挡登记：遮挡期保留最后一次可见速率与预警等级，不生成新建议；
 * 恢复测次与最后一次可见读数比对，按实际间隔天数（含遮挡期）折算月均速率。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, type SurveyRow } from '@/utils/db'
import type { OcclusionInterval, Survey, SurveyDraft } from '@/types/survey'
import type { AdviceLevel } from '@/types/advice'
import { buildSurveyPoints, isOccluded, levelFromRate, occlusionIntervals, openOcclusionOf, round } from '@/utils/rate'

export interface CrackRateSummary {
  crackId: string
  /** 可见测次数量（遮挡登记不计入） */
  count: number
  /** 首测宽度（mm） */
  firstWidth: number
  /** 最新可见宽度（mm） */
  latestWidth: number
  /** 累计变化量（mm） */
  totalDelta: number
  /** 最新可见测次月均速率（mm/月），遮挡期保留最后一次可见速率 */
  rate: number
  level: AdviceLevel
  /** 最新可见测次日期 */
  lastDate: string
  /** 当前是否处于遮挡期 */
  occluded: boolean
  /** 遮挡原因（遮挡期时有值） */
  occludeReason: string
  /** 遮挡登记日期（遮挡期时有值） */
  occludedSince: string
}

export const useSurveyStore = defineStore('survey', () => {
  const surveyTable = useIdbTable<SurveyRow>((database) => database.surveys, { sortByUpdatedAt: false })

  /** 正在查看的裂缝 id（复测对比页与速率分级页共用） */
  const activeCrackId = ref<string | null>(null)

  const surveys = computed<SurveyRow[]>(() =>
    [...surveyTable.rows.value].sort((a, b) => {
      const crackDiff = a.crackId.localeCompare(b.crackId)
      if (crackDiff !== 0) return crackDiff
      return a.seq - b.seq
    })
  )

  function surveysOf(crackId: string): Survey[] {
    return surveys.value.filter((survey) => survey.crackId === crackId)
  }

  /** 按裂缝汇总的速率缓存（遮挡行不参与取点，遮挡期速率保持最后一次可见值） */
  const rates = computed<CrackRateSummary[]>(() => {
    const grouped = new Map<string, SurveyRow[]>()
    surveys.value.forEach((survey) => {
      const list = grouped.get(survey.crackId)
      if (list) list.push(survey)
      else grouped.set(survey.crackId, [survey])
    })
    const list: CrackRateSummary[] = []
    grouped.forEach((rows, crackId) => {
      const points = buildSurveyPoints(rows)
      const latest = points[points.length - 1]
      const first = points[0]
      const rate = latest ? latest.rate : 0
      const open = openOcclusionOf(rows)
      list.push({
        crackId,
        count: points.length,
        firstWidth: first ? first.widthMm : 0,
        latestWidth: latest ? latest.widthMm : 0,
        totalDelta: round((latest ? latest.widthMm : 0) - (first ? first.widthMm : 0), 2),
        rate,
        level: levelFromRate(rate),
        lastDate: latest ? latest.date : '',
        occluded: open !== null,
        occludeReason: open ? open.occlusion.occludeReason ?? '' : '',
        occludedSince: open ? open.occlusion.date : ''
      })
    })
    return list.sort((a, b) => b.rate - a.rate)
  })

  const rateMap = computed<Record<string, number>>(() => {
    const map: Record<string, number> = {}
    rates.value.forEach((item) => {
      map[item.crackId] = item.rate
    })
    return map
  })

  const levelMap = computed<Record<string, AdviceLevel>>(() => {
    const map: Record<string, AdviceLevel> = {}
    rates.value.forEach((item) => {
      map[item.crackId] = item.level
    })
    return map
  })

  const warningCrackIds = computed(() => rates.value.filter((item) => item.level !== '一般').map((item) => item.crackId))

  const summaryOf = (crackId: string): CrackRateSummary | null =>
    rates.value.find((item) => item.crackId === crackId) ?? null

  function setActiveCrack(id: string | null): void {
    activeCrackId.value = id
  }

  /* ---------------------------- 遮挡约束校验 ---------------------------- */

  /**
   * 校验普通测次的落位：
   * - 存在未恢复遮挡时，本次即为恢复测次，日期不得早于遮挡日期
   * - 日期不得落在历史遮挡区间内（遮挡期间不允许补登普通测次）
   */
  function assertNormalPlacement(existing: Survey[], date: string, ignoreId?: string): OcclusionInterval | null {
    const rows = ignoreId ? existing.filter((row) => row.id !== ignoreId) : existing
    const intervals = occlusionIntervals(rows)
    const open = intervals.find((interval) => interval.recovery === null) ?? null
    if (open && date < open.occlusion.date) {
      throw new Error(`恢复日期早于遮挡日期（${open.occlusion.date}），不能保存`)
    }
    for (const interval of intervals) {
      const recoveryDate = interval.recovery?.date
      if (recoveryDate && date > interval.occlusion.date && date < recoveryDate) {
        throw new Error(
          `该日期处于第 ${interval.occlusion.seq} 测次遮挡期间（${interval.occlusion.date} ~ ${recoveryDate}），不能补登普通测次`
        )
      }
    }
    return open
  }

  /** 校验遮挡登记的落位：不得重复遮挡，日期不得早于最后一次可见测次 */
  function assertOcclusionPlacement(existing: Survey[], date: string, ignoreId?: string): void {
    const rows = ignoreId ? existing.filter((row) => row.id !== ignoreId) : existing
    const open = openOcclusionOf(rows)
    if (open) {
      throw new Error(`第 ${open.occlusion.seq} 测次已登记「暂不可见」且尚未恢复，请先登记恢复测次`)
    }
    const lastVisible = [...rows].reverse().find((row) => !isOccluded(row))
    if (lastVisible && date < lastVisible.date) {
      throw new Error(`遮挡日期不能早于最后一次可见测次日期（${lastVisible.date}）`)
    }
  }

  /**
   * 追加一次复测：
   * - 普通读数：自动取下一个测次序号并与上一次可见测次比对生成变化量；
   *   存在未恢复遮挡时本次即恢复测次，自动关联遮挡记录并按实际间隔天数折算速率
   * - 暂不可见：登记遮挡原因，不产生读数、不同步裂缝台账宽度
   */
  async function createSurvey(draft: SurveyDraft): Promise<SurveyRow> {
    const existing = surveysOf(draft.crackId)
    const seq = existing.length > 0 ? existing[existing.length - 1].seq + 1 : 1

    if (draft.kind === 'occluded') {
      assertOcclusionPlacement(existing, draft.date)
      const reason = draft.occludeReason.trim()
      if (!reason) throw new Error('登记「暂不可见」必须填写遮挡原因')
      return (await surveyTable.create(
        {
          crackId: draft.crackId,
          seq,
          date: draft.date,
          widthMm: 0,
          lengthMm: 0,
          deltaWidthMm: 0,
          surveyor: draft.surveyor.trim() || '未署名',
          kind: 'occluded',
          occludeReason: reason
        },
        'sv'
      )) as SurveyRow
    }

    const open = assertNormalPlacement(existing, draft.date)
    const visible = existing.filter((row) => !isOccluded(row))
    const previous = visible.length > 0 ? visible[visible.length - 1] : null
    const delta = previous ? round(draft.widthMm - previous.widthMm, 2) : 0
    const row = (await surveyTable.create(
      {
        crackId: draft.crackId,
        seq,
        date: draft.date,
        widthMm: round(draft.widthMm, 2),
        lengthMm: Math.round(draft.lengthMm),
        deltaWidthMm: delta,
        surveyor: draft.surveyor.trim() || '未署名',
        kind: 'normal',
        recoversOcclusionId: open ? open.occlusion.id : undefined
      },
      'sv'
    )) as SurveyRow
    await syncCrackToLatest(draft.crackId)
    return row
  }

  /** 编辑测次后重排序号并重算全部变化量（类型不可改，遮挡行仅可改日期/原因/复测人） */
  async function updateSurvey(id: string, draft: SurveyDraft): Promise<void> {
    const row = surveyTable.rows.value.find((item) => item.id === id)
    if (!row) return
    const existing = surveysOf(row.crackId)
    if (isOccluded(row)) {
      assertOcclusionPlacement(existing, draft.date, id)
      const reason = draft.occludeReason.trim()
      if (!reason) throw new Error('登记「暂不可见」必须填写遮挡原因')
      // 遮挡日期不得晚于其恢复测次日期（否则等同恢复日期早于遮挡日期）
      const recovery = existing
        .filter((item) => item.id !== id && !isOccluded(item) && item.seq > row.seq)
        .sort((a, b) => a.seq - b.seq)[0]
      if (recovery && recovery.date < draft.date) {
        throw new Error(`恢复日期（${recovery.date}）早于遮挡日期，不能保存`)
      }
      await surveyTable.update(id, {
        date: draft.date,
        occludeReason: reason,
        surveyor: draft.surveyor.trim() || '未署名'
      })
    } else {
      assertNormalPlacement(existing, draft.date, id)
      await surveyTable.update(id, {
        date: draft.date,
        widthMm: round(draft.widthMm, 2),
        lengthMm: Math.round(draft.lengthMm),
        surveyor: draft.surveyor.trim() || '未署名'
      })
    }
    await recalculate(row.crackId)
  }

  async function removeSurvey(id: string): Promise<void> {
    const row = surveyTable.rows.value.find((item) => item.id === id)
    if (!row) return
    await surveyTable.remove(id)
    await recalculate(row.crackId)
  }

  /**
   * 重排某条裂缝的测次序号，并按日期顺序重算变化量：
   * 遮挡行变化量恒为 0；可见行与上一次可见行比对；
   * 恢复关联按顺序重新推导（遮挡行被删除后恢复标记自动清除）。
   */
  async function recalculate(crackId: string): Promise<void> {
    const rows = (await db.surveys.where('crackId').equals(crackId).toArray()).sort((a, b) =>
      a.date === b.date ? a.seq - b.seq : a.date.localeCompare(b.date)
    )
    let lastVisible: SurveyRow | null = null
    let openOcclusionId: string | null = null
    const patches = rows.map((row, index) => {
      if (isOccluded(row)) {
        openOcclusionId = row.id
        return { ...row, seq: index + 1, deltaWidthMm: 0, recoversOcclusionId: undefined, updatedAt: Date.now() }
      }
      const delta = lastVisible ? round(row.widthMm - lastVisible.widthMm, 2) : 0
      const recoversOcclusionId = openOcclusionId ?? undefined
      openOcclusionId = null
      lastVisible = row
      return { ...row, seq: index + 1, deltaWidthMm: delta, recoversOcclusionId, updatedAt: Date.now() }
    })
    if (patches.length > 0) await db.surveys.bulkPut(patches)
    await syncCrackToLatest(crackId)
  }

  /** 把裂缝台账上的宽度/长度同步为最新可见测次读数（遮挡登记不回写台账） */
  async function syncCrackToLatest(crackId: string): Promise<void> {
    const rows = (await db.surveys.where('crackId').equals(crackId).toArray())
      .filter((row) => !isOccluded(row))
      .sort((a, b) => a.seq - b.seq)
    const latest = rows[rows.length - 1]
    if (!latest) return
    await db.cracks.update(crackId, { widthMm: latest.widthMm, lengthMm: latest.lengthMm, updatedAt: Date.now() })
  }

  return {
    surveyTable,
    surveys,
    rates,
    rateMap,
    levelMap,
    warningCrackIds,
    activeCrackId,
    surveysOf,
    summaryOf,
    setActiveCrack,
    createSurvey,
    updateSurvey,
    removeSurvey,
    recalculate
  }
})
