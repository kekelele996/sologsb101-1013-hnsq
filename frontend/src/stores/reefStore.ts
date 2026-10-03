/**
 * 礁区 store：维护礁区与站位列表、当前选中站位与筛选条件。
 * 数据经 utils/db.ts 的 Dexie liveQuery 订阅，页面只读消费。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, readLastReefId, watchTable, writeLastReefId } from '@/utils/db'
import type { Reef, ReefFilterState } from '@/types/reef'
import { createEmptyReefFilter } from '@/types/reef'
import type { Site, SiteFilterState } from '@/types/site'
import { createEmptySiteFilter } from '@/types/site'
import type { Belt } from '@/types/belt'
import { bleachIndex, round } from '@/utils/bleach'
import {
  buildReefQuotaIndex,
  computeQuotaBelts,
  isBeltCounted,
  type BeltQuotaMark,
  type ReefQuotaState
} from '@/utils/quota'

export const useReefStore = defineStore('reef', () => {
  const reefs = ref<Reef[]>([])
  const sites = ref<Site[]>([])
  const belts = ref<Belt[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const currentReefId = ref<string | null>(readLastReefId())
  const currentSiteId = ref<string | null>(null)
  const filter = ref<ReefFilterState>(createEmptyReefFilter())
  const siteFilter = ref<SiteFilterState>(createEmptySiteFilter())

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Reef>(() => db.reefs).subscribe((rows) => {
      reefs.value = rows
      ready.value = true
      error.value = null
      if (currentReefId.value === null && rows.length > 0) selectReef(rows[0].id)
    })
    watchTable<Site>(() => db.sites).subscribe((rows) => {
      sites.value = rows
    })
    // 核定口径要用到样带布设与对账状态（与 beltStore 各自订阅同一张表）
    watchTable<Belt>(() => db.belts).subscribe((rows) => {
      belts.value = rows
    })
  }

  const currentReef = computed<Reef | null>(
    () => reefs.value.find((reef) => reef.id === currentReefId.value) ?? null
  )

  const currentSite = computed<Site | null>(
    () => sites.value.find((site) => site.id === currentSiteId.value) ?? null
  )

  /** 某礁区下的站位（按站位编号排序） */
  function sitesOfReef(reefId: string | null | undefined): Site[] {
    if (!reefId) return []
    return sites.value
      .filter((site) => site.reefId === reefId)
      .sort((a, b) => a.no.localeCompare(b.no, 'zh-Hans-CN'))
  }

  /** 按筛选条件过滤后的礁区 */
  const filteredReefs = computed<Reef[]>(() =>
    reefs.value.filter((reef) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${reef.name}${reef.location}${reef.manager}${reef.protectStatus}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.protectStatuses.length > 0 && !filter.value.protectStatuses.includes(reef.protectStatus)) {
        return false
      }
      if (filter.value.minAreaKm2 !== null && reef.areaKm2 < filter.value.minAreaKm2) return false
      if (filter.value.maxAreaKm2 !== null && reef.areaKm2 > filter.value.maxAreaKm2) return false
      return true
    })
  )

  /** 按筛选条件过滤后的站位 */
  const filteredSites = computed<Site[]>(() =>
    sites.value.filter((site) => {
      const keyword = siteFilter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${site.no}${site.substrate}`
        if (!haystack.includes(keyword)) return false
      }
      if (siteFilter.value.minDepthM !== null && site.depthM < siteFilter.value.minDepthM) return false
      if (siteFilter.value.maxDepthM !== null && site.depthM > siteFilter.value.maxDepthM) return false
      return true
    })
  )

  const hasFilter = computed<boolean>(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.protectStatuses.length > 0 ||
      filter.value.minAreaKm2 !== null ||
      filter.value.maxAreaKm2 !== null
  )

  /** 礁区 id → 站位数与总面积 */
  const reefStats = computed<Record<string, { siteCount: number; areaKm2: number }>>(() => {
    const stats: Record<string, { siteCount: number; areaKm2: number }> = {}
    reefs.value.forEach((reef) => {
      stats[reef.id] = {
        siteCount: sites.value.filter((site) => site.reefId === reef.id).length,
        areaKm2: reef.areaKm2
      }
    })
    return stats
  })

  /**
   * 核定对账索引：随礁区 / 站位 / 样带变化重算。
   * 超出核定上限且未认回的样带标记为 excluded，先挡在平均之外。
   */
  const quotaIndex = computed(() => buildReefQuotaIndex(reefs.value, sites.value, belts.value))

  /** 各礁区核定情况 */
  const reefQuotaStates = computed<Record<string, ReefQuotaState>>(() => quotaIndex.value.byReef)

  /** 取某礁区核定情况（尚未建索引时返回 null） */
  function quotaStateOf(reefId: string | null | undefined): ReefQuotaState | null {
    if (!reefId) return null
    return quotaIndex.value.byReef[reefId] ?? null
  }

  /** 取某样带在核定口径下的标记 */
  function beltQuotaMark(beltId: string): BeltQuotaMark | undefined {
    return quotaIndex.value.byBelt[beltId]
  }

  /** 某样带是否计入核定口径（查不到索引时按计入处理，保持未核定时的旧行为） */
  function isBeltInQuota(beltId: string): boolean {
    return isBeltCounted(quotaIndex.value.byBelt[beltId])
  }

  /** 某礁区下「计入核定口径」的样带（顺序与外业布设一致） */
  function countedBeltsOfReef(reefId: string): Belt[] {
    const siteIds = new Set(sites.value.filter((site) => site.reefId === reefId).map((site) => site.id))
    return belts.value.filter((belt) => siteIds.has(belt.siteId) && isBeltInQuota(belt.id))
  }

  /** 某站位下「计入核定口径」的样带 */
  function countedBeltsOfSite(siteId: string): Belt[] {
    return belts.value.filter((belt) => belt.siteId === siteId && isBeltInQuota(belt.id))
  }

  /** 按当前面积与保护级别算出的建议核定上限（管理站核定 / 回填用） */
  function suggestQuota(areaKm2: number, protectStatus: Reef['protectStatus']): number {
    return computeQuotaBelts(areaKm2, protectStatus)
  }

  function patchFilter(patch: Partial<ReefFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyReefFilter()
  }

  function patchSiteFilter(patch: Partial<SiteFilterState>): void {
    siteFilter.value = { ...siteFilter.value, ...patch }
  }

  function resetSiteFilter(): void {
    siteFilter.value = createEmptySiteFilter()
  }

  function selectReef(id: string | null): void {
    currentReefId.value = id
    writeLastReefId(id)
  }

  function selectSite(id: string | null): void {
    currentSiteId.value = id
  }

  function reefById(id: string | null | undefined): Reef | null {
    if (!id) return null
    return reefs.value.find((reef) => reef.id === id) ?? null
  }

  function siteById(id: string | null | undefined): Site | null {
    if (!id) return null
    return sites.value.find((site) => site.id === id) ?? null
  }

  /* ------------------------------- 礁区 ------------------------------- */

  async function createReef(payload: Omit<Reef, 'id' | 'createdAt' | 'updatedAt'>): Promise<Reef> {
    const now = Date.now()
    const row: Reef = {
      ...payload,
      ...(typeof payload.quotaBelts === 'number' ? { quotaCheckedAt: payload.quotaCheckedAt ?? now } : {}),
      id: createId('reef'),
      createdAt: now,
      updatedAt: now
    }
    await db.reefs.put(row)
    return row
  }

  async function updateReef(id: string, patch: Partial<Reef>): Promise<void> {
    await db.reefs.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  /** 删除礁区：级联删除其站位、样带、珊瑚记录与鱼类计数 */
  async function removeReef(id: string): Promise<void> {
    await db.transaction('rw', [db.reefs, db.sites, db.belts, db.corals, db.fishes], async () => {
      const siteIds = (await db.sites.where('reefId').equals(id).toArray()).map((row) => row.id)
      if (siteIds.length > 0) {
        const beltIds = (await db.belts.where('siteId').anyOf(siteIds).toArray()).map((row) => row.id)
        if (beltIds.length > 0) {
          await db.corals.where('beltId').anyOf(beltIds).delete()
          await db.fishes.where('beltId').anyOf(beltIds).delete()
          await db.belts.bulkDelete(beltIds)
        }
        await db.sites.bulkDelete(siteIds)
      }
      await db.reefs.delete(id)
    })
    if (currentReefId.value === id) selectReef(null)
  }

  /* ------------------------------- 站位 ------------------------------- */

  async function createSite(payload: Omit<Site, 'id' | 'createdAt' | 'updatedAt'>): Promise<Site> {
    const now = Date.now()
    const row: Site = { ...payload, id: createId('site'), createdAt: now, updatedAt: now }
    await db.sites.put(row)
    return row
  }

  async function updateSite(id: string, patch: Partial<Site>): Promise<void> {
    await db.sites.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  /** 删除站位：级联删除其样带、珊瑚记录与鱼类计数 */
  async function removeSite(id: string): Promise<void> {
    await db.transaction('rw', [db.sites, db.belts, db.corals, db.fishes], async () => {
      const beltIds = (await db.belts.where('siteId').equals(id).toArray()).map((row) => row.id)
      if (beltIds.length > 0) {
        await db.corals.where('beltId').anyOf(beltIds).delete()
        await db.fishes.where('beltId').anyOf(beltIds).delete()
        await db.belts.bulkDelete(beltIds)
      }
      await db.sites.delete(id)
    })
    if (currentSiteId.value === id) selectSite(null)
  }

  /** 站位 id → 样带数与平均白化指数（列表回显用，仅计入核定口径内的样带） */
  async function siteBleachAverages(): Promise<Record<string, number>> {
    const result: Record<string, number> = {}
    for (const site of sites.value) {
      const countedBeltIds = new Set(countedBeltsOfSite(site.id).map((belt) => belt.id))
      if (countedBeltIds.size === 0) {
        result[site.id] = 0
        continue
      }
      const corals = await db.corals.where('beltId').anyOf([...countedBeltIds]).toArray()
      result[site.id] = round(bleachIndex(corals), 2)
    }
    return result
  }

  /* ----------------------------- 核定口径 ----------------------------- */

  /** 管理站手动核定（或调整）礁区样带上限 */
  async function setReefQuota(reefId: string, quotaBelts: number, note?: string): Promise<void> {
    const now = Date.now()
    await db.reefs.update(reefId, {
      quotaBelts: Math.max(0, Math.floor(quotaBelts)),
      quotaCheckedAt: now,
      quotaNote: note?.trim() || '管理站手动核定',
      updatedAt: now
    } as never)
  }

  /** 旧数据没核定：按当前面积与保护级别回填一版上限 */
  async function backfillReefQuota(reefId: string): Promise<number> {
    const reef = reefById(reefId)
    if (!reef) return 0
    const quota = computeQuotaBelts(reef.areaKm2, reef.protectStatus)
    await setReefQuota(reefId, quota, '按面积与保护级别回填')
    return quota
  }

  return {
    reefs,
    sites,
    belts,
    ready,
    error,
    currentReefId,
    currentReef,
    currentSiteId,
    currentSite,
    filter,
    siteFilter,
    filteredReefs,
    filteredSites,
    hasFilter,
    reefStats,
    reefQuotaStates,
    quotaIndex,
    start,
    sitesOfReef,
    quotaStateOf,
    beltQuotaMark,
    isBeltInQuota,
    countedBeltsOfReef,
    countedBeltsOfSite,
    suggestQuota,
    setReefQuota,
    backfillReefQuota,
    patchFilter,
    resetFilter,
    patchSiteFilter,
    resetSiteFilter,
    selectReef,
    selectSite,
    reefById,
    siteById,
    createReef,
    updateReef,
    removeReef,
    createSite,
    updateSite,
    removeSite,
    siteBleachAverages
  }
})
