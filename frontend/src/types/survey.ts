/** 复测：对同一条裂缝按测次追加的读数记录 */

/** 测次类型：normal 普通读数；occluded 暂不可见（防火板等遮挡登记，无读数） */
export type SurveyKind = 'normal' | 'occluded'

export const SURVEY_KINDS: SurveyKind[] = ['normal', 'occluded']

export const SURVEY_KIND_TEXT: Record<SurveyKind, string> = {
  normal: '普通读数',
  occluded: '暂不可见'
}

export interface Survey {
  id: string
  crackId: string
  /** 测次序号，从 1 开始 */
  seq: number
  /** 复测日期 YYYY-MM-DD */
  date: string
  widthMm: number
  lengthMm: number
  /** 与上一次可见测次相比的宽度变化量（mm），遮挡行恒为 0 */
  deltaWidthMm: number
  /** 复测人 */
  surveyor: string
  /** 测次类型，历史数据迁移补齐为 normal */
  kind: SurveyKind
  /** 遮挡原因（kind 为 occluded 时必填，如「防火板遮挡」） */
  occludeReason?: string
  /** 恢复测次指向其解除的遮挡测次 id（仅遮挡后第一条普通测次有值） */
  recoversOcclusionId?: string
  createdAt: number
  updatedAt: number
}

export interface SurveyDraft {
  crackId: string
  date: string
  widthMm: number
  lengthMm: number
  surveyor: string
  kind: SurveyKind
  /** 遮挡原因（kind 为 occluded 时使用） */
  occludeReason: string
}

export const EMPTY_SURVEY_DRAFT: SurveyDraft = {
  crackId: '',
  date: '',
  widthMm: 0,
  lengthMm: 0,
  surveyor: '',
  kind: 'normal',
  occludeReason: ''
}

/** 单个测次在折线图上的取点（仅可见测次参与取点） */
export interface SurveyPoint {
  seq: number
  date: string
  widthMm: number
  lengthMm: number
  deltaWidthMm: number
  /** 该测次距上一可见测次的月均速率（mm/月） */
  rate: number
  /** 是否为遮挡后的恢复测次（与最后可见读数比对、按实际间隔天数计速率） */
  resumed: boolean
  /** 该点之前连续跳过的遮挡测次数 */
  skippedBefore: number
  /** 与上一可见测次的实际间隔天数（含遮挡期） */
  spanDays: number
}

/** 一段遮挡区间：遮挡登记测次与其恢复测次的配对（recovery 为 null 表示仍处遮挡期） */
export interface OcclusionInterval {
  occlusion: Survey
  recovery: Survey | null
}
