/**
 * 复测测次状态（Pinia）
 * 维护测次顺序、变化量缓存与按裂缝汇总的发展速率。
 * 遮挡口径：暂不可见测次跳过读数，遮挡期沿用最后一次可见速率与预警；
 * 恢复测次与最后一次可见测次比对，按实际间隔天数换算速率。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, type SurveyRow } from '@/utils/db'
import type { Survey, SurveyDraft } from '@/types/survey'
import type { AdviceLevel } from '@/types/advice'
import { buildSurveyPoints, levelFromRate, round } from '@/utils/rate'

export interface CrackRateSummary {
  crackId: string
  /** 测次数量（含暂不可见测次） */
  count: number
  /** 首测宽度（mm） */
  firstWidth: number
  /** 最新宽度（mm），遮挡期为最后一次可见读数 */
  latestWidth: number
  /** 累计变化量（mm） */
  totalDelta: number
  /** 最新测次月均速率（mm/月），遮挡期为沿用的最后一次可见速率 */
  rate: number
  level: AdviceLevel
  lastDate: string
  /** 当前是否处于遮挡期（最新测次为暂不可见） */
  blocked: boolean
  /** 遮挡原因（未遮挡为空串） */
  blockReason: string
}

/** 按测次升序（同序号按日期）排列 */
function bySeq(a: Survey, b: Survey): number {
  return a.seq === b.seq ? a.date.localeCompare(b.date) : a.seq - b.seq
}

/** 序列中最后一次可见测次 */
function latestVisibleOf(rows: Survey[]): Survey | null {
  const visible = rows.filter((row) => row.visibility !== '暂不可见')
  return visible.length > 0 ? visible[visible.length - 1] : null
}

/** 序列中尚未恢复的遮挡测次（遮挡之后没有任何普通测次） */
function openBlockOf(rows: Survey[]): Survey | null {
  const sorted = [...rows].sort(bySeq)
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const row = sorted[index]
    if (row.visibility === '暂不可见') return row
    if (row.visibility === '可见') return null
  }
  return null
}

/**
 * 校验测次登记（新增/编辑共用，编辑时传入 excludeId 排除自身）。
 * 返回错误文案；null 表示可保存。规则：
 * - 恢复日期早于遮挡日期不能保存
 * - 遮挡与恢复必须属于同一条裂缝（调用方只传本裂缝测次，跨裂缝序列在此不可见）
 * - 遮挡期间（遮挡测次与恢复测次之间）不能再补普通测次
 */
export function validateSurveyDraft(existing: Survey[], draft: SurveyDraft, excludeId?: string): string | null {
  const rows = existing.filter((row) => row.id !== excludeId).sort(bySeq)
  if (draft.visibility === '暂不可见') {
    if (!draft.blockReason.trim()) return '请填写暂不可见原因（如 夜间检修防火板遮挡）'
    const lastVisible = latestVisibleOf(rows)
    if (!lastVisible) return '该裂缝还没有可见测次，不能登记暂不可见'
    const openBlock = openBlockOf(rows)
    if (openBlock) return `已存在未恢复的遮挡登记（${openBlock.date}），请先登记恢复测次`
    if (draft.date < lastVisible.date) {
      return `遮挡日期不能早于最后一次可见测次日期（${lastVisible.date}）`
    }
    return null
  }
  for (const block of rows.filter((row) => row.visibility === '暂不可见')) {
    const resume = rows.find((row) => row.visibility === '可见' && row.seq > block.seq)
    if (!resume) {
      // 遮挡未恢复：本次普通测次即恢复测次，日期不得早于遮挡日期
      if (draft.date < block.date) {
        return `恢复日期 ${draft.date} 早于遮挡日期 ${block.date}，不能保存`
      }
    } else if (draft.date >= block.date && draft.date < resume.date) {
      return `遮挡期间（${block.date} ~ ${resume.date}）已按跳过处理，不能再补普通测次`
    }
  }
  return null
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

  /** 按裂缝汇总的速率缓存 */
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
      const blocked = latest ? latest.visibility === '暂不可见' : false
      list.push({
        crackId,
        count: points.length,
        firstWidth: first ? first.widthMm : 0,
        latestWidth: latest ? latest.widthMm : 0,
        totalDelta: round((latest ? latest.widthMm : 0) - (first ? first.widthMm : 0), 2),
        rate,
        level: levelFromRate(rate),
        lastDate: latest ? latest.date : '',
        blocked,
        blockReason: blocked && latest ? latest.blockReason : ''
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

  /**
   * 追加一次复测读数：自动取下一个测次序号并与最后一次可见测次比对生成变化量。
   * 登记「暂不可见」时不产生读数，快照最后一次可见读数仅用于台账回显。
   */
  async function createSurvey(draft: SurveyDraft): Promise<SurveyRow> {
    const existing = surveysOf(draft.crackId)
    const invalid = validateSurveyDraft(existing, draft)
    if (invalid) throw new Error(invalid)
    const sorted = [...existing].sort(bySeq)
    const previous = sorted.length > 0 ? sorted[sorted.length - 1] : null
    const seq = previous ? previous.seq + 1 : 1
    const lastVisible = latestVisibleOf(sorted)
    const blocked = draft.visibility === '暂不可见'
    const delta = blocked || !lastVisible ? 0 : round(draft.widthMm - lastVisible.widthMm, 2)
    const row = (await surveyTable.create(
      {
        crackId: draft.crackId,
        seq,
        date: draft.date,
        widthMm: blocked ? (lastVisible ? lastVisible.widthMm : 0) : round(draft.widthMm, 2),
        lengthMm: blocked ? (lastVisible ? lastVisible.lengthMm : 0) : Math.round(draft.lengthMm),
        deltaWidthMm: delta,
        surveyor: draft.surveyor.trim() || '未署名',
        visibility: draft.visibility,
        blockReason: blocked ? draft.blockReason.trim() : ''
      },
      'sv'
    )) as SurveyRow
    await syncCrackToLatest(draft.crackId)
    return row
  }

  /** 编辑测次后重排序号并重算全部变化量（不允许跨裂缝转移测次） */
  async function updateSurvey(id: string, draft: SurveyDraft): Promise<void> {
    const row = surveyTable.rows.value.find((item) => item.id === id)
    if (!row) return
    if (draft.crackId !== row.crackId) throw new Error('测次不能跨裂缝转移，遮挡与恢复必须属于同一条裂缝')
    const invalid = validateSurveyDraft(surveysOf(row.crackId), draft, id)
    if (invalid) throw new Error(invalid)
    if (row.visibility === '暂不可见') {
      await surveyTable.update(id, {
        date: draft.date,
        surveyor: draft.surveyor.trim() || '未署名',
        blockReason: draft.blockReason.trim()
      })
    } else {
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

  /** 重排某条裂缝的测次序号，并按日期顺序跳过遮挡测次重算变化量 */
  async function recalculate(crackId: string): Promise<void> {
    const rows = (await db.surveys.where('crackId').equals(crackId).toArray()).sort((a, b) =>
      a.date === b.date ? a.seq - b.seq : a.date.localeCompare(b.date)
    )
    let lastVisible: SurveyRow | null = null
    const patches = rows.map((row, index) => {
      if (row.visibility === '暂不可见') {
        return {
          ...row,
          seq: index + 1,
          widthMm: lastVisible ? lastVisible.widthMm : row.widthMm,
          lengthMm: lastVisible ? lastVisible.lengthMm : row.lengthMm,
          deltaWidthMm: 0,
          updatedAt: Date.now()
        }
      }
      const patch = {
        ...row,
        seq: index + 1,
        deltaWidthMm: lastVisible ? round(row.widthMm - lastVisible.widthMm, 2) : 0,
        updatedAt: Date.now()
      }
      lastVisible = row
      return patch
    })
    if (patches.length > 0) await db.surveys.bulkPut(patches)
    await syncCrackToLatest(crackId)
  }

  /** 把裂缝台账上的宽度/长度同步为最后一次可见测次读数（遮挡期不被快照冲掉） */
  async function syncCrackToLatest(crackId: string): Promise<void> {
    const rows = (await db.surveys.where('crackId').equals(crackId).toArray()).sort((a, b) => a.seq - b.seq)
    const latest = latestVisibleOf(rows)
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
