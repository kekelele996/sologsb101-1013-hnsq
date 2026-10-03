/**
 * 核定口径工具：管理站按礁区面积与保护级别核定年度样带条数上限，
 * 并判定已布样带中哪些可计入礁区/站位平均白化指数。
 *
 * 规则：
 * - 上限随保护级别提高而降低（核心区 < 缓冲区 < 实验区 < 未设区），随面积缩小而降低；
 * - 样带布设后不撤回；「已认」样带始终计入，「待认」样带按布设先后
 *   （createdAt 升序）在上限剩余名额内计入，超出名额的先挡在平均之外；
 * - 管理站逐条对账认过（待认 → 已认）后才算回去；撤销认账后重新按名额判定。
 *
 * 核定与上限归管理站，站位样带归外业队：本模块只做纯口径计算，不触碰数据库。
 */
import type { Belt } from '@/types/belt'
import type { ProtectStatus, Reef } from '@/types/reef'

/** 各级别的核定密度系数（条 / km²）：保护越严、单位面积允许的样带越少 */
export const QUOTA_DENSITY: Record<ProtectStatus, number> = {
  核心区: 0.1,
  缓冲区: 0.2,
  实验区: 0.35,
  未设区: 0.5
}

/** 核定年度：今年能布多少条样带 */
export function currentQuotaYear(): number {
  return new Date().getFullYear()
}

/**
 * 按面积与保护级别计算核定上限（条）。
 * round(密度 × 面积)，至少保留 1 条，保证任何级别/面积下都能布设。
 */
export function computeBeltCap(areaKm2: number, protectStatus: ProtectStatus): number {
  const area = Number.isFinite(areaKm2) && areaKm2 > 0 ? areaKm2 : 0
  return Math.max(1, Math.round(QUOTA_DENSITY[protectStatus] * area))
}

/** 样带核定（对账）状态 */
export type BeltReviewStatus = 'approved' | 'pending'

/** 上限来源：管理站核定 / 旧数据按面积级别公式回填 */
export type CapSource = 'approved' | 'backfilled'

/** 一条样带在当前核定口径下的计入状态 */
export interface BeltAdmission {
  /** 是否计入礁区/站位平均白化指数等对外口径 */
  counted: boolean
  /** 管理站是否已逐条对账认过 */
  approved: boolean
  /** 未被计入的原因 */
  reason: '' | '超出核定上限'
}

/** 一个礁区的核定结果 */
export interface QuotaState {
  /** 核定上限（条） */
  cap: number
  /** 上限来源 */
  capSource: CapSource
  /** 核定年度 */
  capYear: number
  /** 已布样带总数（不撤回，全部保留） */
  total: number
  /** 已对账认过条数 */
  approvedCount: number
  /** 计入平均口径的条数 */
  countedCount: number
  /** 被挡在平均之外的条数（待认且超出上限名额） */
  blockedCount: number
  /** 剩余可自动计入名额（待认样带按布设先后占用） */
  slotsLeft: number
  /** 样带 id → 计入状态 */
  admission: Map<string, BeltAdmission>
}

/** 待认样带的布设先后：先布的先占名额 */
function layingOrder(a: Belt, b: Belt): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  return a.id.localeCompare(b.id)
}

/**
 * 由礁区与其全部样带推导核定结果。
 * 「已认」始终计入；「待认」先布的在上限扣除已认条数后的剩余名额内计入。
 */
export function buildQuotaState(reef: Pick<Reef, 'beltCap' | 'capSource' | 'capYear' | 'areaKm2' | 'protectStatus'>, belts: Belt[]): QuotaState {
  const cap = Number.isFinite(reef.beltCap) && reef.beltCap > 0 ? reef.beltCap : computeBeltCap(reef.areaKm2, reef.protectStatus)
  const capSource = reef.capSource ?? 'backfilled'
  const capYear = reef.capYear ?? currentQuotaYear()

  const sorted = [...belts].sort(layingOrder)
  const approved = sorted.filter((belt) => belt.reviewStatus === 'approved')
  const pending = sorted.filter((belt) => belt.reviewStatus !== 'approved')
  const pendingSlots = Math.max(0, cap - approved.length)

  const admission = new Map<string, BeltAdmission>()
  approved.forEach((belt) => {
    admission.set(belt.id, { counted: true, approved: true, reason: '' })
  })
  pending.forEach((belt, index) => {
    const counted = index < pendingSlots
    admission.set(belt.id, {
      counted,
      approved: false,
      reason: counted ? '' : '超出核定上限'
    })
  })

  const countedCount = approved.length + Math.min(pending.length, pendingSlots)
  return {
    cap,
    capSource,
    capYear,
    total: sorted.length,
    approvedCount: approved.length,
    countedCount,
    blockedCount: sorted.length - countedCount,
    slotsLeft: Math.max(0, pendingSlots - pending.length),
    admission
  }
}

/** 礁区 id → 核定结果（缺礁区的孤立样带不计入任何礁区口径） */
export function buildQuotaStates(
  reefs: Array<Pick<Reef, 'id' | 'beltCap' | 'capSource' | 'capYear' | 'areaKm2' | 'protectStatus'>>,
  sites: Array<{ id: string; reefId: string }>,
  belts: Belt[]
): Map<string, QuotaState> {
  const siteReef = new Map(sites.map((site) => [site.id, site.reefId]))
  const beltsByReef = new Map<string, Belt[]>()
  belts.forEach((belt) => {
    const reefId = siteReef.get(belt.siteId)
    if (!reefId) return
    const list = beltsByReef.get(reefId) ?? []
    list.push(belt)
    beltsByReef.set(reefId, list)
  })
  const result = new Map<string, QuotaState>()
  reefs.forEach((reef) => {
    result.set(reef.id, buildQuotaState(reef, beltsByReef.get(reef.id) ?? []))
  })
  return result
}

/** 取单条样带的计入状态（无法定位礁区时按可计入处理，避免孤立数据被误挡） */
export function admissionOf(states: Map<string, QuotaState>, belt: Belt, reefIdOf: (siteId: string) => string | undefined): BeltAdmission {
  const reefId = reefIdOf(belt.siteId)
  if (!reefId) return { counted: true, approved: belt.reviewStatus === 'approved', reason: '' }
  return states.get(reefId)?.admission.get(belt.id) ?? { counted: true, approved: false, reason: '' }
}
