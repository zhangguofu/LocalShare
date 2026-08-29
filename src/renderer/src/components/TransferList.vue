<template>
  <div class="transfer-panel">
    <div class="panel-head">
      <el-tabs v-model="activeTab" class="tabs">
        <el-tab-pane name="active">
          <template #label>
            进行中<el-badge v-if="counts.active > 0" :value="counts.active" class="tab-badge" />
          </template>
        </el-tab-pane>
        <el-tab-pane name="done">
          <template #label>
            已完成<el-badge v-if="counts.done > 0" :value="counts.done" class="tab-badge" type="success" />
          </template>
        </el-tab-pane>
        <el-tab-pane name="failed">
          <template #label>
            失败 / 拒绝<el-badge v-if="counts.failed > 0" :value="counts.failed" class="tab-badge" type="danger" />
          </template>
        </el-tab-pane>
      </el-tabs>
      <el-button
        v-if="activeTab !== 'active' && currentItems.length > 0"
        text
        size="small"
        class="clear-btn"
        @click="clearCurrent"
      >清空</el-button>
    </div>

    <div class="list-scroll">
      <div v-if="currentItems.length === 0" class="empty-list">
        <p class="empty-title">{{ emptyText }}</p>
      </div>

      <div v-for="item in currentItems" :key="item.transferId" class="transfer-item">
        <!-- 方向 + 对端设备：一眼看出谁发给谁 -->
        <span class="dir-block">
          <span class="dir-icon" :class="item.kind">
            <svg v-if="item.kind === 'outgoing'" viewBox="0 0 24 24" fill="none"><path d="M12 19V5m0 0-6 6m6-6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <svg v-else viewBox="0 0 24 24" fill="none"><path d="M12 5v14m0 0 6-6m-6 6-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
          <span class="dir-label" :title="item.peerName">
            <span class="dir-peer">{{ item.peerName }}</span>
          </span>
        </span>

        <div class="item-body">
          <div class="line1">
            <span class="name" :title="item.name">{{ item.name }}</span>
            <span class="size">{{ formatBytes(item.totalBytes) }}</span>
          </div>
          <div v-if="item.state === 'transferring'" class="line2">
            <div class="bar"><div class="bar-fill" :style="{ width: percent(item) + '%' }"></div></div>
            <span class="pct">{{ progressText(item) }}</span>
          </div>
          <div v-else-if="item.state === 'complete' && item.kind === 'incoming' && item.saveDir" class="line2">
            <span class="saved" :title="item.saveDir">{{ item.saveDir }}</span>
            <button class="link-btn" @click="openFolder(item.saveDir)">打开</button>
          </div>
          <div v-else-if="item.reason" class="line2">
            <span class="reason">{{ item.reason }}</span>
          </div>
          <div v-else-if="item.state === 'waiting-confirm'" class="line2">
            <span class="hint">等待对方确认…</span>
          </div>
          <div v-else-if="item.state === 'delivered'" class="line2">
            <span class="hint">已送达对端（{{ item.ackedFiles }}/{{ item.fileCount }} 个文件），等待对方落盘…</span>
          </div>
        </div>

        <div class="item-side">
          <el-tag v-if="item.state === 'transferring' || item.state === 'delivered'" :type="item.state === 'transferring' ? 'warning' : 'info'" size="small" effect="plain" round>
            {{ stateText(item) }}
          </el-tag>
          <el-tag v-else :type="tagType(item.state)" size="small" effect="plain" round>
            {{ stateText(item) }}
          </el-tag>
          <el-button
            v-if="item.state === 'transferring' || (item.state === 'waiting-confirm' && item.kind === 'outgoing')"
            size="small"
            text
            type="danger"
            @click="cancel(item.transferId)"
          >取消</el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { useTransferStore, type TransferItem } from '../stores/transfer'

const transferStore = useTransferStore()
const activeTab = ref<'active' | 'done' | 'failed'>('active')

// 分类：进行中（含等待确认/已送达待落盘）；已完成；失败/拒绝
const counts = computed(() => {
  const c = { active: 0, done: 0, failed: 0 }
  for (const t of transferStore.items) {
    if (t.state === 'transferring' || t.state === 'waiting-confirm' || t.state === 'delivered') c.active++
    else if (t.state === 'complete') c.done++
    else c.failed++
  }
  return c
})

const currentItems = computed(() => {
  const list = transferStore.items
  if (activeTab.value === 'active')
    return list.filter((t) => t.state === 'transferring' || t.state === 'waiting-confirm' || t.state === 'delivered')
  if (activeTab.value === 'done') return list.filter((t) => t.state === 'complete')
  return list.filter((t) => t.state === 'failed' || t.state === 'rejected')
})

const emptyText = computed(() => ({
  active: '暂无进行中的传输',
  done: '还没有完成的传输',
  failed: '没有失败的传输'
}[activeTab.value]))

function percent(item: TransferItem): number {
  if (item.totalBytes === 0) return 0
  return Math.min(100, (item.doneBytes / item.totalBytes) * 100)
}
function percentText(item: TransferItem): string {
  if (item.totalBytes === 0) return '0.00'
  return ((item.doneBytes / item.totalBytes) * 100).toFixed(2)
}
// 进度文字：百分比 + 数据量（12.3 MB / 48.3 MB）
function progressText(item: TransferItem): string {
  return `${percentText(item)}% · ${formatBytes(item.doneBytes)} / ${formatBytes(item.totalBytes)}`
}
function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}
function tagType(s: TransferItem['state']): 'success' | 'danger' | 'warning' | 'info' {
  if (s === 'complete') return 'success'
  if (s === 'failed' || s === 'rejected') return 'danger'
  if (s === 'transferring') return 'warning'
  return 'info'
}
function stateText(item: TransferItem): string {
  if (item.state === 'complete') return item.kind === 'outgoing' ? '已发送' : '已接收'
  if (item.state === 'delivered') return '已送达对端'
  return { 'waiting-confirm': '等待确认', transferring: '传输中', failed: '失败', rejected: '已拒绝' }[item.state]
}
function cancel(transferId: string): void {
  window.api.cancelTransfer(transferId)
}
async function openFolder(dir: string): Promise<void> {
  const err = await window.api.openPath(dir)
  if (err) ElMessage.error('无法打开文件夹：' + err)
}
function clearCurrent(): void {
  transferStore.clearItems(currentItems.value.map((i) => i.transferId))
}
</script>

<style scoped>
.transfer-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--ls-bg-panel);
  border: 1px solid var(--ls-border);
  border-radius: var(--ls-radius);
  box-shadow: var(--ls-shadow);
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 12px;
  border-bottom: 1px solid var(--ls-border);
}
.tabs { flex: 1; min-width: 0; }
.tabs :deep(.el-tabs__header) { margin: 0; }
.tabs :deep(.el-tabs__nav-wrap::after) { display: none; }
.tabs :deep(.el-tabs__item) { height: 44px; font-size: 13px; }
.tab-badge { margin-left: 6px; transform: translateY(-8px); }
.clear-btn { color: var(--ls-text-3); }
.clear-btn:hover { color: var(--ls-danger); }

.list-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 6px 10px;
  min-height: 0;
}
.empty-list { padding: 36px 0; text-align: center; }
.empty-title { margin: 0; font-size: 13px; color: var(--ls-text-3); }

.transfer-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 8px;
  border-radius: var(--ls-radius-sm);
}
.transfer-item:hover { background: var(--ls-bg-hover); }

.dir-block {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 58px;
}
.dir-icon {
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--ls-primary-weak);
  color: var(--ls-primary);
}
.dir-icon svg { width: 14px; height: 14px; }
.dir-label {
  max-width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 1.2;
}
.dir-peer {
  max-width: 100%;
  font-size: 10px;
  font-weight: 500;
  color: var(--ls-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-body { flex: 1; min-width: 0; }
.line1 { display: flex; align-items: baseline; gap: 8px; }
.name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.size { flex: none; font-size: 12px; color: var(--ls-text-3); }

.line2 { display: flex; align-items: center; gap: 8px; margin-top: 5px; }
.bar {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--ls-border);
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--ls-primary);
}
.pct { flex: none; font-size: 11px; color: var(--ls-text-3); white-space: nowrap; }

.saved {
  flex: 1;
  font-size: 12px;
  color: var(--ls-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.link-btn {
  flex: none;
  border: none;
  background: transparent;
  color: var(--ls-primary);
  font-size: 12px;
  cursor: pointer;
  padding: 0;
}
.link-btn:hover { text-decoration: underline; }

.reason {
  font-size: 12px;
  color: var(--ls-danger);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hint { font-size: 12px; color: var(--ls-text-3); }

.item-side { flex: none; display: flex; align-items: center; }
</style>
