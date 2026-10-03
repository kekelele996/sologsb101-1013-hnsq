<script setup lang="ts">
/**
 * 模块 1：/reefs 礁区台账
 * 新建礁区、按保护区状态筛选；卡片汇总站位总数与本礁区平均白化指数。
 * 复用 <FilterBar>、<EmptyPanel>。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, MagicStick, Plus, Right, Stamp, Check } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import { buildQuery, queryToArray, queryToNumber } from '@/types/filter'
import StatBadge from '@/components/common/StatBadge.vue'
import BleachTag from '@/components/common/BleachTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { AREA_BUCKETS, createEmptyReefFilter, PROTECT_STATUSES } from '@/types/reef'
import type { ProtectStatus, Reef } from '@/types/reef'
import { bleachGrade, bleachIndex } from '@/utils/bleach'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const reefStore = useReefStore()
const beltStore = useBeltStore()
const surveyStore = useSurveyStore()

const dialogVisible = ref(false)
const quotaDialogVisible = ref(false)
const reviewDialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const areaBucket = ref(AREA_BUCKETS[0].label)
const form = reactive({
  name: '',
  location: '',
  areaKm2: 10,
  protectStatus: '实验区' as ProtectStatus,
  manager: '',
  quotaBelts: 2,
  quotaNote: ''
})

/** 核定弹窗状态 */
const quotaForm = reactive({
  reefId: '',
  reefName: '',
  areaKm2: 0,
  protectStatus: '实验区' as ProtectStatus,
  quotaBelts: 1,
  suggested: 1,
  note: ''
})

/** 对账弹窗状态 */
const reviewState = reactive({
  reefId: '',
  reefName: '',
  loading: false
})
const reviewRows = ref<
  Array<{
    beltId: string
    beltNo: string
    siteNo: string
    orientation: string
    lengthM: number
    surveyDate: string
    observer: string
    reviewStatus: 'pending' | 'accepted'
    quotaMark: 'counted' | 'excluded' | 'unlimited'
  }>
>([])

/** 礁区卡片：站位/样带统计按核定口径，超出核定且未认回的样带不计入平均 */
const cards = computed(() =>
  reefStore.filteredReefs.map((reef: Reef) => {
    const sites = reefStore.sites.filter((site) => site.reefId === reef.id)
    const siteIds = new Set(sites.map((site) => site.id))
    const belts = beltStore.belts.filter((belt) => siteIds.has(belt.siteId))
    const quota = reefStore.quotaStateOf(reef.id)
    const countedBelts = belts.filter((belt) => reefStore.isBeltInQuota(belt.id))
    const countedBeltIds = new Set(countedBelts.map((belt) => belt.id))
    const corals = surveyStore.corals.filter((coral) => countedBeltIds.has(coral.beltId))
    const fishes = surveyStore.fishes.filter((fish) => countedBeltIds.has(fish.beltId))
    const index = bleachIndex(corals)
    return {
      reef,
      sites,
      siteCount: sites.length,
      beltCount: belts.length,
      countedBeltCount: countedBelts.length,
      excludedCount: quota?.excludedCount ?? 0,
      acceptedCount: quota?.acceptedCount ?? 0,
      pendingCount: quota?.pendingCount ?? 0,
      quotaBelts: reef.quotaBelts,
      coralCount: corals.length,
      fishTotal: fishes.reduce((sum, fish) => sum + fish.count, 0),
      bleachIndex: index,
      grade: bleachGrade(index)
    }
  })
)

const filterModel = computed<FilterModel>(() => ({
  keyword: reefStore.filter.keyword,
  protectStatuses: reefStore.filter.protectStatuses,
  minAreaKm2: reefStore.filter.minAreaKm2,
  maxAreaKm2: reefStore.filter.maxAreaKm2
}))

const totals = computed(() => ({
  reefs: cards.value.length,
  sites: cards.value.reduce((sum, card) => sum + card.siteCount, 0),
  belts: cards.value.reduce((sum, card) => sum + card.countedBeltCount, 0),
  beltsExcluded: cards.value.reduce((sum, card) => sum + card.excludedCount, 0),
  corals: cards.value.reduce((sum, card) => sum + card.coralCount, 0),
  avgBleachIndex:
    cards.value.length === 0
      ? 0
      : Number((cards.value.reduce((sum, card) => sum + card.bleachIndex, 0) / cards.value.length).toFixed(2))
}))

async function syncQuery(): Promise<void> {
  const query = buildQuery({
    kw: reefStore.filter.keyword,
    status: reefStore.filter.protectStatuses,
    minArea: reefStore.filter.minAreaKm2,
    maxArea: reefStore.filter.maxAreaKm2
  })
  await router.replace({ query })
}

function applyQuery(): void {
  const query = route.query
  reefStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    protectStatuses: queryToArray(query.status) as ProtectStatus[],
    minAreaKm2: queryToNumber(query.minArea),
    maxAreaKm2: queryToNumber(query.maxArea)
  })
  const bucket = AREA_BUCKETS.find(
    (item) => item.min === reefStore.filter.minAreaKm2 && item.max === reefStore.filter.maxAreaKm2
  )
  areaBucket.value = bucket ? bucket.label : AREA_BUCKETS[0].label
}

function handleFilterChange(): void {
  void syncQuery()
}

function handleBucketChange(label: string): void {
  const bucket = AREA_BUCKETS.find((item) => item.label === label)
  reefStore.patchFilter({ minAreaKm2: bucket?.min ?? null, maxAreaKm2: bucket?.max ?? null })
  void syncQuery()
}

function handleReset(): void {
  reefStore.resetFilter()
  areaBucket.value = AREA_BUCKETS[0].label
  void syncQuery()
}

function openCreate(): void {
  editingId.value = null
  form.name = ''
  form.location = ''
  form.areaKm2 = 10
  form.protectStatus = '实验区'
  form.manager = ''
  form.quotaBelts = reefStore.suggestQuota(10, '实验区')
  form.quotaNote = ''
  dialogVisible.value = true
}

function openEdit(reef: Reef): void {
  editingId.value = reef.id
  form.name = reef.name
  form.location = reef.location
  form.areaKm2 = reef.areaKm2
  form.protectStatus = reef.protectStatus
  form.manager = reef.manager
  form.quotaBelts = typeof reef.quotaBelts === 'number' ? reef.quotaBelts : reefStore.suggestQuota(reef.areaKm2, reef.protectStatus)
  form.quotaNote = reef.quotaNote ?? ''
  dialogVisible.value = true
}

/** 面积 / 级别变化时，按口径重算建议上限（手动核定值不覆盖，仅提供「按口径回填」按钮） */
const suggestedQuota = computed(() => reefStore.suggestQuota(form.areaKm2, form.protectStatus))

function applySuggestedQuota(): void {
  form.quotaBelts = suggestedQuota.value
}

async function submitForm(): Promise<void> {
  if (!form.name.trim()) {
    ElMessage.warning('请填写礁区名称')
    return
  }
  if (!Number.isFinite(form.areaKm2) || form.areaKm2 <= 0) {
    ElMessage.warning('面积应为大于 0 的数字（km²）')
    return
  }
  if (!Number.isFinite(form.quotaBelts) || form.quotaBelts < 0) {
    ElMessage.warning('核定样带上限应为不小于 0 的整数（条）')
    return
  }
  submitting.value = true
  try {
    if (editingId.value) {
      await reefStore.updateReef(editingId.value, {
        name: form.name.trim(),
        location: form.location.trim(),
        areaKm2: form.areaKm2,
        protectStatus: form.protectStatus,
        manager: form.manager.trim()
      })
      ElMessage.success('礁区信息已更新；如需调整核定上限请点「核定上限」')
    } else {
      const created = await reefStore.createReef({
        name: form.name.trim(),
        location: form.location.trim(),
        areaKm2: form.areaKm2,
        protectStatus: form.protectStatus,
        manager: form.manager.trim(),
        quotaBelts: Math.floor(form.quotaBelts),
        quotaNote: form.quotaNote.trim() || '新建时按面积与保护级别核定'
      })
      reefStore.selectReef(created.id)
      ElMessage.success('礁区已新建，核定上限已按面积与保护级别写入')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

/* ------------------------------ 管理站核定 ------------------------------ */

function openQuotaDialog(reef: Reef): void {
  quotaForm.reefId = reef.id
  quotaForm.reefName = reef.name
  quotaForm.areaKm2 = reef.areaKm2
  quotaForm.protectStatus = reef.protectStatus
  quotaForm.suggested = reefStore.suggestQuota(reef.areaKm2, reef.protectStatus)
  quotaForm.quotaBelts = typeof reef.quotaBelts === 'number' ? reef.quotaBelts : quotaForm.suggested
  quotaForm.note = reef.quotaNote ?? ''
  quotaDialogVisible.value = true
}

const quotaDialogSuggestion = computed(() =>
  reefStore.suggestQuota(quotaForm.areaKm2, quotaForm.protectStatus)
)

async function submitQuota(): Promise<void> {
  if (!Number.isFinite(quotaForm.quotaBelts) || quotaForm.quotaBelts < 0) {
    ElMessage.warning('核定上限应为不小于 0 的整数（条）')
    return
  }
  const reef = reefStore.reefById(quotaForm.reefId)
  const laidCount = reef ? reefStore.quotaStateOf(reef.id)?.laidCount ?? 0 : 0
  if (quotaForm.quotaBelts < laidCount) {
    try {
      await ElMessageBox.confirm(
        `当前已布设 ${laidCount} 条样带，新上限只有 ${quotaForm.quotaBelts} 条。已认回的样带照算，其余超出的样带不撤回、先挡在礁区平均之外，等逐条对账认回。确认下调？`,
        '下调核定上限',
        { type: 'warning', confirmButtonText: '确认下调', cancelButtonText: '取消' }
      )
    } catch {
      return
    }
  }
  await reefStore.setReefQuota(quotaForm.reefId, Math.floor(quotaForm.quotaBelts), quotaForm.note)
  quotaDialogVisible.value = false
  ElMessage.success(`「${quotaForm.reefName}」核定上限已更新为 ${Math.floor(quotaForm.quotaBelts)} 条`)
}

/** 旧数据没核定：按面积和级别回填一版 */
async function backfillQuota(reef: Reef): Promise<void> {
  const quota = await reefStore.backfillReefQuota(reef.id)
  ElMessage.success(`已按面积 ${reef.areaKm2} km² 与${reef.protectStatus}回填核定上限 ${quota} 条`)
}

/* ------------------------------ 管理站对账 ------------------------------ */

function openReviewDialog(reef: Reef): void {
  reviewState.reefId = reef.id
  reviewState.reefName = reef.name
  reviewDialogVisible.value = true
  refreshReviewRows()
}

function refreshReviewRows(): void {
  const quota = reefStore.quotaStateOf(reviewState.reefId)
  if (!quota) {
    reviewRows.value = []
    return
  }
  const siteById = new Map(reefStore.sites.map((site) => [site.id, site]))
  reviewRows.value = quota.orderedBeltIds.map((beltId) => {
    const belt = beltStore.beltById(beltId)
    return {
      beltId,
      beltNo: belt?.no ?? '—',
      siteNo: belt ? siteById.get(belt.siteId)?.no ?? '—' : '—',
      orientation: belt?.orientation ?? '—',
      lengthM: belt?.lengthM ?? 0,
      surveyDate: belt?.surveyDate ?? '',
      observer: belt?.observer ?? '',
      reviewStatus: belt?.reviewStatus === 'accepted' ? 'accepted' : 'pending',
      quotaMark: quota.marks[beltId] ?? 'counted'
    }
  })
}

async function acceptBelt(beltId: string): Promise<void> {
  reviewState.loading = true
  try {
    await beltStore.acceptBelt(beltId)
    ElMessage.success('该样带已认回，计入核定口径')
    await nextTickUi()
    refreshReviewRows()
  } finally {
    reviewState.loading = false
  }
}

async function unacceptBelt(beltId: string): Promise<void> {
  reviewState.loading = true
  try {
    await beltStore.unacceptBelt(beltId)
    ElMessage.success('已取消认回，样带回到待对账')
    await nextTickUi()
    refreshReviewRows()
  } finally {
    reviewState.loading = false
  }
}

/** 等 liveQuery 把订阅推完再刷新对账行 */
function nextTickUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60))
}

async function removeReef(reef: Reef): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除礁区「${reef.name}」将同时删除其站位、样带、珊瑚记录与鱼类计数，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await reefStore.removeReef(reef.id)
  ElMessage.success('礁区及其下级数据已删除')
}

function gotoSites(reef: Reef): void {
  reefStore.selectReef(reef.id)
  void router.push(`/reefs/${reef.id}/sites`)
}

async function reseed(): Promise<void> {
  await initDatabase()
  ElMessage.success('已按需补齐演示数据（幂等播种）')
}

onMounted(() => {
  applyQuery()
  if (reefStore.reefs.length === 0) void reseed()
})

watch(
  () => route.query,
  () => {
    if (route.path !== '/reefs') return
    applyQuery()
  }
)
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">礁区台账</h2>
        <p class="gb-hint">
          维护礁区基本信息与保护区状态，卡片汇总站位总数、样带条数与平均白化指数。点击「站位布设」进入子页面。
        </p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新建礁区</el-button>
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="[
        {
          key: 'protectStatuses',
          label: '保护区状态',
          options: PROTECT_STATUSES.map((item) => ({ label: item, value: item }))
        }
      ]"
      keyword-placeholder="搜索礁区名 / 位置 / 管理单位"
      @change="handleFilterChange"
      @reset="handleReset"
    >
      <template #extra>
        <div class="page__bucket">
          <span class="page__bucket-label">礁区面积</span>
          <el-select :model-value="areaBucket" class="page__bucket-select" @change="handleBucketChange">
            <el-option v-for="bucket in AREA_BUCKETS" :key="bucket.label" :label="bucket.label" :value="bucket.label" />
          </el-select>
        </div>
      </template>
      <template #actions>
        <el-button size="small" :icon="MagicStick" @click="reseed">补齐演示数据</el-button>
      </template>
    </FilterBar>

    <div class="gb-stats-row">
      <StatBadge label="筛选后礁区" :value="totals.reefs" suffix="个" icon="Odometer" />
      <StatBadge label="站位总数" :value="totals.sites" suffix="个" tone="info" icon="Grid" />
      <StatBadge label="核定内样带" :value="totals.belts" suffix="条" tone="success" icon="Files" />
      <StatBadge
        v-if="totals.beltsExcluded > 0"
        label="暂挂待认回"
        :value="totals.beltsExcluded"
        suffix="条"
        tone="warning"
        icon="WarningFilled"
      />
      <StatBadge label="珊瑚记录" :value="totals.corals" suffix="条" icon="Histogram" />
      <StatBadge
        label="核定口径平均白化指数"
        :value="totals.avgBleachIndex"
        suffix="/ 4"
        :tone="totals.avgBleachIndex > 1 ? 'warning' : 'success'"
        :icon="totals.avgBleachIndex > 1 ? 'WarningFilled' : 'DataLine'"
      />
    </div>

    <EmptyPanel
      v-if="cards.length === 0"
      :title="reefStore.hasFilter ? '没有符合条件的礁区' : '还没有礁区'"
      :description="
        reefStore.hasFilter
          ? '当前筛选条件（保护区状态 / 面积 / 关键字）下没有礁区，可重置条件或新建一个礁区。'
          : '新建第一个礁区后即可布设站位、样带并录入珊瑚分类覆盖与鱼类计数。'
      "
      action-text="新建礁区"
      secondary-text="重置筛选"
      @action="openCreate"
      @secondary="handleReset"
    />

    <div v-else class="reef-grid">
      <el-card v-for="card in cards" :key="card.reef.id" shadow="hover" class="reef-card">
        <template #header>
          <div class="reef-card__head">
            <div>
              <strong class="reef-card__name">{{ card.reef.name }}</strong>
              <el-tag size="small" effect="plain" class="reef-card__status">{{ card.reef.protectStatus }}</el-tag>
            </div>
            <BleachTag :level="card.grade" size="small" />
          </div>
          <div class="reef-card__quota">
            <el-tag v-if="typeof card.quotaBelts === 'number'" size="small" :type="card.excludedCount > 0 ? 'warning' : 'success'" effect="light">
              核定上限 {{ card.quotaBelts }} 条 · 已布 {{ card.beltCount }} 条 · 计入 {{ card.countedBeltCount }}
            </el-tag>
            <el-tag v-else size="small" type="info" effect="light">尚未核定（暂不封顶）</el-tag>
            <el-tag v-if="card.excludedCount > 0" size="small" type="warning" effect="dark">
              {{ card.excludedCount }} 条暂挂待认回
            </el-tag>
          </div>
        </template>

        <div class="reef-card__stats">
          <StatBadge label="站位" :value="card.siteCount" suffix="个" size="small" tone="info" icon="Grid" />
          <StatBadge label="核定内样带" :value="card.countedBeltCount" suffix="条" size="small" icon="Files" />
          <StatBadge label="珊瑚记录" :value="card.coralCount" suffix="条" size="small" tone="success" icon="Histogram" />
          <StatBadge
            label="白化指数"
            :value="card.bleachIndex"
            suffix="/ 4"
            size="small"
            :tone="card.bleachIndex > 1 ? 'warning' : 'success'"
            icon="TrendCharts"
          />
        </div>

        <el-alert
          v-if="card.excludedCount > 0"
          class="reef-card__alert"
          type="warning"
          :closable="false"
          show-icon
          :title="`有 ${card.excludedCount} 条已布样带超出核定上限，记录保留、暂不计入礁区平均，等待管理站逐条认回`"
        />

        <div class="reef-card__meta">
          <span>面积 <b class="gb-mono">{{ card.reef.areaKm2 }}</b> km²</span>
          <span>鱼获计数 <b class="gb-mono">{{ card.fishTotal }}</b></span>
          <span>认回 <b class="gb-mono">{{ card.acceptedCount }}</b> · 待对账 <b class="gb-mono">{{ card.pendingCount }}</b></span>
          <span v-if="card.reef.quotaCheckedAt" class="reef-card__quota-time">
            核定于 {{ new Date(card.reef.quotaCheckedAt).toLocaleDateString('zh-CN') }}
          </span>
          <span v-if="card.reef.manager">管理单位：{{ card.reef.manager }}</span>
        </div>

        <p v-if="card.reef.location" class="reef-card__location">{{ card.reef.location }}</p>

        <div class="reef-card__actions">
          <el-button type="primary" size="small" :icon="Right" @click="gotoSites(card.reef)">站位布设</el-button>
          <el-button size="small" :icon="Check" :type="card.excludedCount > 0 ? 'warning' : 'default'" @click="openReviewDialog(card.reef)">
            逐条对账{{ card.excludedCount > 0 ? `（${card.excludedCount} 待认回）` : '' }}
          </el-button>
          <el-button size="small" :icon="Stamp" @click="openQuotaDialog(card.reef)">核定上限</el-button>
          <el-button v-if="typeof card.quotaBelts !== 'number'" size="small" @click="backfillQuota(card.reef)">按面积级别回填</el-button>
          <el-button size="small" :icon="Edit" @click="openEdit(card.reef)">编辑</el-button>
          <el-button size="small" type="danger" plain :icon="Delete" @click="removeReef(card.reef)">删除</el-button>
        </div>
      </el-card>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑礁区' : '新建礁区'" width="540px" :close-on-click-modal="false">
      <el-form label-width="100px">
        <el-form-item label="礁区名称" required>
          <el-input v-model="form.name" placeholder="如：清澜湾珊瑚礁区" maxlength="40" show-word-limit />
        </el-form-item>
        <el-form-item label="位置">
          <el-input v-model="form.location" placeholder="如：海南文昌清澜湾东侧 3.5 km 海域" maxlength="80" />
        </el-form-item>
        <el-form-item label="面积" required>
          <el-input-number v-model="form.areaKm2" :min="0.01" :max="100000" :step="0.1" :precision="2" controls-position="right" />
          <span class="page__unit">km²</span>
        </el-form-item>
        <el-form-item label="保护区状态" required>
          <el-radio-group v-model="form.protectStatus" @change="applySuggestedQuota">
            <el-radio-button v-for="status in PROTECT_STATUSES" :key="status" :value="status">{{ status }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="管理单位">
          <el-input v-model="form.manager" placeholder="如：清澜湾海洋保护站" maxlength="60" />
        </el-form-item>
        <el-form-item v-if="!editingId" label="核定样带上限" required>
          <el-input-number v-model="form.quotaBelts" :min="0" :max="200" :step="1" controls-position="right" />
          <span class="page__unit">条</span>
          <el-button size="small" text type="primary" :icon="Stamp" @click="applySuggestedQuota">
            按面积与级别回填（建议 {{ suggestedQuota }} 条）
          </el-button>
          <div class="page__quota-hint">
            级别越高、面积越小，上限越低：核心区 ×0.5、缓冲区 ×1、实验区 ×2、未设区 ×3（每 10 km² 计 1 条，下限 1 条）。新建后仍可在卡片「核定上限」中调整。
          </div>
        </el-form-item>
        <el-form-item v-if="!editingId" label="核定依据">
          <el-input v-model="form.quotaNote" placeholder="如：按面积与保护级别核定" maxlength="80" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '新建并布设站位' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 管理站核定上限 -->
    <el-dialog v-model="quotaDialogVisible" title="管理站核定样带上限" width="560px" :close-on-click-modal="false">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="上限归管理站、样带归外业队：上限下调后，已布设的样带不撤回；已认回的照算，其余超出的先挡在礁区平均之外，等逐条对账认回。"
        class="page__quota-banner"
      />
      <el-form label-width="120px">
        <el-form-item label="礁区">
          <strong>{{ quotaForm.reefName }}</strong>
          <el-tag size="small" effect="plain" class="page__quota-tag">{{ quotaForm.protectStatus }}</el-tag>
          <el-tag size="small" type="info" effect="plain">{{ quotaForm.areaKm2 }} km²</el-tag>
        </el-form-item>
        <el-form-item label="核定上限">
          <el-input-number v-model="quotaForm.quotaBelts" :min="0" :max="200" :step="1" controls-position="right" />
          <span class="page__unit">条</span>
          <el-button size="small" text type="primary" :icon="Stamp" @click="quotaForm.quotaBelts = quotaDialogSuggestion">
            按口径取 {{ quotaDialogSuggestion }} 条
          </el-button>
        </el-form-item>
        <el-form-item label="核定依据">
          <el-input v-model="quotaForm.note" placeholder="如：核心区提级，按级别系数 0.5 重新核定" maxlength="80" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="quotaDialogVisible = false">取消</el-button>
        <el-button type="primary" :icon="Stamp" @click="submitQuota">保存核定</el-button>
      </template>
    </el-dialog>

    <!-- 管理站逐条对账 -->
    <el-dialog v-model="reviewDialogVisible" :title="`逐条对账认回 · ${reviewState.reefName}`" width="820px" :close-on-click-modal="false">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="认回顺序按站位 → 朝向（北东南西）→ 编号排列；上限以内的待对账样带已先计入，认回后即使再降上限也保留在口径内。"
        class="page__quota-banner"
      />
      <el-table :data="reviewRows" border stripe size="small" max-height="420">
        <el-table-column label="站位 / 样带" min-width="150">
          <template #default="{ row }">
            <div>站位 {{ row.siteNo }} · {{ row.beltNo }}</div>
            <div class="gb-hint">{{ row.orientation }}向 {{ row.lengthM }} m · {{ row.surveyDate }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="observer" label="调查人" width="100" />
        <el-table-column label="对账状态" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="row.reviewStatus === 'accepted' ? 'success' : 'info'" size="small" effect="plain">
              {{ row.reviewStatus === 'accepted' ? '已认回' : '待对账' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="核定口径" width="170">
          <template #default="{ row }">
            <el-tag v-if="row.quotaMark === 'excluded'" type="warning" size="small" effect="dark">暂挂，不计入平均</el-tag>
            <el-tag v-else-if="row.quotaMark === 'unlimited'" type="info" size="small" effect="plain">未核定，先计入</el-tag>
            <el-tag v-else type="success" size="small" effect="plain">已计入</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" align="center">
          <template #default="{ row }">
            <el-button v-if="row.reviewStatus !== 'accepted'" size="small" type="primary" :icon="Check" :loading="reviewState.loading" @click="acceptBelt(row.beltId)">
              认回
            </el-button>
            <el-button v-else size="small" plain :loading="reviewState.loading" @click="unacceptBelt(row.beltId)">
              取消认回
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button type="primary" @click="reviewDialogVisible = false">完成对账</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0b5d5a;
}

.page__bucket {
  display: flex;
  align-items: center;
  gap: 6px;
}

.page__bucket-label {
  font-size: 13px;
  color: #4c6663;
}

.page__bucket-select {
  width: 160px;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #7c9995;
}

.reef-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
  gap: 14px;
}

.reef-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.reef-card__name {
  font-size: 16px;
  color: #10312f;
}

.reef-card__status {
  margin-left: 8px;
}

.reef-card__quota {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.reef-card__alert {
  margin: 8px 0 4px;
}

.reef-card__quota-time {
  color: #7c9995;
}

.page__quota-hint {
  flex-basis: 100%;
  margin-top: 4px;
  font-size: 12px;
  color: #7c9995;
  line-height: 1.6;
}

.page__quota-banner {
  margin-bottom: 12px;
}

.page__quota-tag {
  margin: 0 6px;
}

.reef-card__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 10px;
}

.reef-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 13px;
  color: #4c6663;
}

.reef-card__location {
  margin: 8px 0 0;
  font-size: 12px;
  color: #7c9995;
  line-height: 1.7;
}

.reef-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
</style>
