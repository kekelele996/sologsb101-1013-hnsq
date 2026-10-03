/**
 * 样带核定口径：管理站按礁区面积与保护级别核定本年度样带布设上限。
 * 核定与上限归管理站（写在 Reef 上），站位样带归外业队（写在 Belt 上）：
 * 上限调低后，超出核定的样带不撤回，先挂在礁区 / 站位平均之外，
 * 等管理站逐条对账认回后再计入。
 */
import type { Belt } from '@/types/belt'
import type { ProtectStatus, Reef } from '@/types/reef'
import type { Site } from '@/types/site'

/**
 * 保护级别系数：级别越高、管控越严，同等面积下核定上限越低。
 */
export const PROTECT_LEVEL_FACTOR: Record<ProtectStatus, number> = {
  核心区: 0.5,
  缓冲区: 1,
  实验区: 2,
  未设区: 3
}

/** 基准：每 10 km² 礁区面积在缓冲级别（系数 1）下可布 1 条样带 */
export const QUOTA_AREA_STEP_KM2 = 10

/** 核定上限下限：面积再小至少保留 1 条样带 */
export const MIN_QUOTA_BELTS = 1

/** 核定上限封顶：避免大礁区样带数失控 */
export const MAX_QUOTA_BELTS = 200

/**
 * 按面积与保护级别核定样带上限（条）。
 * 上限 = 面积 / 面积档位 × 级别系数，向下取整后夹在 [1, 200]。
 * 级别一提（系数变小）或面积改小，核定上限即下降。
 */
export function computeQuotaBelts(areaKm2: number, protectStatus: ProtectStatus): number {
  if (!Number.isFinite(areaKm2) || areaKm2 <= 0) return MIN_QUOTA_BELTS
  const raw = (areaKm2 / QUOTA_AREA_STEP_KM2) * PROTECT_LEVEL_FACTOR[protectStatus]
  return Math.min(MAX_QUOTA_BELTS, Math.max(MIN_QUOTA_BELTS, Math.floor(raw)))
}

/** 未核定（旧数据回填前）的提示文案 */
export const QUOTA_UNCHECKED_TEXT = '未核定'

/**
 * 样带对账状态：
 * - pending 待对账：外业队已布设，尚未经管理站逐条认回；
 * - accepted 已认回：管理站对账通过，永久计入核定口径。
 */
export type BeltReviewStatus = 'pending' | 'accepted'

export const BELT_REVIEW_STATUSES: BeltReviewStatus[] = ['pending', 'accepted']

export const BELT_REVIEW_LABEL: Record<BeltReviewStatus, string> = {
  pending: '待对账',
  accepted: '已认回'
}

/**
 * 样带在核定口径下的位置标记：
 * - counted 计入：已认回，或虽未认回但排在核定上限以内；
 * - excluded 暂挂：超出核定上限且尚未认回，先挡在平均之外；
 * - unlimited 未核定：礁区没有核定上限，全部计入。
 */
export type BeltQuotaMark = 'counted' | 'excluded' | 'unlimited'

export const BELT_QUOTA_MARK_LABEL: Record<BeltQuotaMark, string> = {
  counted: '已计入核定口径',
  excluded: '超出核定，暂挂待认回',
  unlimited: '礁区未核定上限'
}

/** 朝向排序权重：北 → 东 → 南 → 西（与 beltStore.ORIENTATION_ORDER 口径一致，此处避免跨层依赖） */
const ORIENTATION_ORDER: Record<Belt['orientation'], number> = {
  北: 0,
  东: 1,
  南: 2,
  西: 3
}

/**
 * 同一礁区内样带的对账排序：站位编号 → 朝向（北→东→南→西）→ 样带编号 → 调查日期。
 * 上限降下来以后，按此顺序取满核定上限条计入，其余暂挂。
 */
export function compareBeltsForQuota(a: Belt, b: Belt, siteOf: (id: string) => Site | undefined): number {
  const siteA = siteOf(a.siteId)
  const siteB = siteOf(b.siteId)
  const siteDiff = (siteA?.no ?? '').localeCompare(siteB?.no ?? '', 'zh-Hans-CN')
  if (siteDiff !== 0) return siteDiff
  const orientationDiff = ORIENTATION_ORDER[a.orientation] - ORIENTATION_ORDER[b.orientation]
  if (orientationDiff !== 0) return orientationDiff
  const noDiff = a.no.localeCompare(b.no, 'zh-Hans-CN')
  if (noDiff !== 0) return noDiff
  const dateDiff = a.surveyDate.localeCompare(b.surveyDate)
  if (dateDiff !== 0) return dateDiff
  return a.id.localeCompare(b.id)
}

/** 单个礁区的核定对账情况 */
export interface ReefQuotaState {
  reefId: string
  /** 核定上限；undefined 表示尚未核定（口径不封顶） */
  quotaBelts: number | undefined
  /** 已布设样带总数（含暂挂的） */
  laidCount: number
  /** 已认回条数 */
  acceptedCount: number
  /** 计入核定口径的条数（已认回 + 待对账中排在上限以内的） */
  countedCount: number
  /** 超出核定、暂挂在平均之外的条数 */
  excludedCount: number
  /** 已布设数是否超过核定上限 */
  overQuota: boolean
  /** 待管理站逐条对账的条数 */
  pendingCount: number
  /** 样带 id → 口径标记 */
  marks: Record<string, BeltQuotaMark>
  /** 礁区内样带按对账顺序排列 */
  orderedBeltIds: string[]
}

/**
 * 以礁区为单位构建核定索引：
 * 已认回的样带必计入；其余待对账样带按站位 / 朝向 / 编号顺序取满剩余上限。
 * 没有核定上限的旧礁区（undefined）全部计入并标记 unlimited。
 */
export function buildReefQuotaIndex(
  reefs: Reef[],
  sites: Site[],
  belts: Belt[]
): { byReef: Record<string, ReefQuotaState>; byBelt: Record<string, BeltQuotaMark> } {
  const siteById = new Map(sites.map((site) => [site.id, site]))
  const siteOf = (id: string): Site | undefined => siteById.get(id)
  const siteIdsByReef = new Map<string, Set<string>>()
  sites.forEach((site) => {
    const set = siteIdsByReef.get(site.reefId) ?? new Set<string>()
    set.add(site.id)
    siteIdsByReef.set(site.reefId, set)
  })

  const byReef: Record<string, ReefQuotaState> = {}
  const byBelt: Record<string, BeltQuotaMark> = {}

  reefs.forEach((reef) => {
    const reefSiteIds = siteIdsByReef.get(reef.id) ?? new Set<string>()
    const reefBelts = belts
      .filter((belt) => reefSiteIds.has(belt.siteId))
      .sort((a, b) => compareBeltsForQuota(a, b, siteOf))

    const marks: Record<string, BeltQuotaMark> = {}
    const quota = typeof reef.quotaBelts === 'number' && Number.isFinite(reef.quotaBelts)
      ? Math.max(0, Math.floor(reef.quotaBelts))
      : undefined

    if (quota === undefined) {
      reefBelts.forEach((belt) => {
        marks[belt.id] = 'unlimited'
        byBelt[belt.id] = 'unlimited'
      })
      byReef[reef.id] = {
        reefId: reef.id,
        quotaBelts: undefined,
        laidCount: reefBelts.length,
        acceptedCount: reefBelts.length,
        countedCount: reefBelts.length,
        excludedCount: 0,
        overQuota: false,
        pendingCount: 0,
        marks,
        orderedBeltIds: reefBelts.map((belt) => belt.id)
      }
      return
    }

    const accepted = reefBelts.filter((belt) => belt.reviewStatus === 'accepted')
    const pending = reefBelts.filter((belt) => belt.reviewStatus !== 'accepted')
    accepted.forEach((belt) => {
      marks[belt.id] = 'counted'
      byBelt[belt.id] = 'counted'
    })

    // 已认回的先占名额，剩余名额按对账顺序分给待对账样带；分不到的暂挂
    const pendingSlots = Math.max(0, quota - accepted.length)
    pending.forEach((belt, index) => {
      const mark: BeltQuotaMark = index < pendingSlots ? 'counted' : 'excluded'
      marks[belt.id] = mark
      byBelt[belt.id] = mark
    })

    const excludedCount = Math.max(0, pending.length - pendingSlots)
    byReef[reef.id] = {
      reefId: reef.id,
      quotaBelts: quota,
      laidCount: reefBelts.length,
      acceptedCount: accepted.length,
      countedCount: reefBelts.length - excludedCount,
      excludedCount,
      overQuota: reefBelts.length > quota,
      pendingCount: pending.length,
      marks,
      orderedBeltIds: reefBelts.map((belt) => belt.id)
    }
  })

  return { byReef, byBelt }
}

/** 样带是否计入核定口径（未建索引的兜底：查不到时按计入处理，保持旧行为） */
export function isBeltCounted(mark: BeltQuotaMark | undefined): boolean {
  return mark !== 'excluded'
}
