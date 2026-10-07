/** 复测：对同一条裂缝按测次追加的读数记录 */

/** 测次可见性：夜间检修防火板遮挡等情况登记「暂不可见」，该测次无读数 */
export type SurveyVisibility = '可见' | '暂不可见'

export const SURVEY_VISIBILITIES: SurveyVisibility[] = ['可见', '暂不可见']

export interface Survey {
  id: string
  crackId: string
  /** 测次序号，从 1 开始 */
  seq: number
  /** 复测日期 YYYY-MM-DD */
  date: string
  /**
   * 复测宽度（mm）。
   * 「暂不可见」测次无读数，快照最后一次可见读数，仅用于台账回显，不参与变化量计算。
   */
  widthMm: number
  /** 复测长度（mm），暂不可见测次同样快照最后一次可见读数 */
  lengthMm: number
  /** 与上一次可见测次相比的宽度变化量（mm），暂不可见测次恒为 0 */
  deltaWidthMm: number
  /** 复测人 */
  surveyor: string
  /** 可见性标记：暂不可见表示裂缝被遮挡，本测次跳过读数 */
  visibility: SurveyVisibility
  /** 暂不可见原因（如「夜间检修防火板遮挡」），可见测次为空串 */
  blockReason: string
  createdAt: number
  updatedAt: number
}

export interface SurveyDraft {
  crackId: string
  date: string
  widthMm: number
  lengthMm: number
  surveyor: string
  visibility: SurveyVisibility
  /** 暂不可见时必填 */
  blockReason: string
}

export const EMPTY_SURVEY_DRAFT: SurveyDraft = {
  crackId: '',
  date: '',
  widthMm: 0,
  lengthMm: 0,
  surveyor: '',
  visibility: '可见',
  blockReason: ''
}

/** 单个测次在折线图上的取点 */
export interface SurveyPoint {
  seq: number
  date: string
  widthMm: number
  lengthMm: number
  deltaWidthMm: number
  /** 该测次距上一可见测次的月均速率（mm/月）；暂不可见测次沿用最后一次可见速率 */
  rate: number
  visibility: SurveyVisibility
  blockReason: string
  /** 是否为遮挡解除后的首个普通测次（与最后一次可见测次比对、按实际间隔天数换算速率） */
  resumed: boolean
  /** 恢复测次之前被跳过的遮挡测次序号；非恢复测次为 null */
  skippedFromSeq: number | null
}

/** 一段遮挡跳过区间：从暂不可见测次到恢复测次（未恢复时右端开放） */
export interface BlockSpan {
  /** 遮挡测次序号与日期 */
  fromSeq: number
  fromDate: string
  /** 恢复测次序号与日期；遮挡未解除时为 null */
  toSeq: number | null
  toDate: string | null
  reason: string
}
