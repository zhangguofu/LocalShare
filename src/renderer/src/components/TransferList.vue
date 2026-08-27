<template>
  <div class="transfer-list">
    <h3>传输队列</h3>
    <el-empty v-if="transferStore.items.length === 0" description="暂无传输" :image-size="60" />
    <el-card v-for="item in transferStore.items" :key="item.transferId" class="transfer-item" shadow="never">
      <div class="row">
        <span class="name">{{ item.name }}</span>
        <el-tag :type="tagType(item.state)" size="small">{{ stateText(item.state) }}</el-tag>
      </div>
      <el-progress
        v-if="item.state === 'transferring'"
        :percentage="percent(item)"
        :format="() => formatBytes(item.doneBytes) + ' / ' + formatBytes(item.totalBytes)"
      />
      <div v-if="item.reason" class="reason">{{ item.reason }}</div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { useTransferStore, type TransferItem } from '../stores/transfer'

const transferStore = useTransferStore()

function percent(item: TransferItem): number {
  if (item.totalBytes === 0) return item.state === 'complete' ? 100 : 0
  return Math.min(100, Math.round((item.doneBytes / item.totalBytes) * 100))
}
function tagType(s: TransferItem['state']): 'success' | 'danger' | 'warning' | 'info' {
  if (s === 'complete') return 'success'
  if (s === 'failed' || s === 'rejected') return 'danger'
  if (s === 'transferring') return 'warning'
  return 'info'
}
function stateText(s: TransferItem['state']): string {
  return { 'waiting-confirm': '等待确认', transferring: '传输中', complete: '已完成', failed: '失败', rejected: '已拒绝' }[s]
}
function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}
</script>

<style scoped>
.transfer-list { display: flex; flex-direction: column; gap: 8px; }
.transfer-item .row { display: flex; justify-content: space-between; align-items: center; }
.reason { color: var(--el-color-danger); font-size: 12px; margin-top: 4px; }
</style>
