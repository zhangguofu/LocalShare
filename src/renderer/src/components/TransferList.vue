<template>
  <div class="transfer-list">
    <h3>传输队列</h3>
    <el-empty v-if="transferStore.items.length === 0" description="暂无传输" :image-size="60" />
    <el-card v-for="item in transferStore.items" :key="item.transferId" class="transfer-item" shadow="never">
      <div class="row">
        <span class="name">{{ item.name }}</span>
        <span class="row-right">
          <el-button
            v-if="item.state === 'transferring' && item.kind === 'outgoing'"
            size="small"
            text
            type="danger"
            @click="cancel(item.transferId)"
          >取消</el-button>
          <el-tag :type="tagType(item.state)" size="small">{{ stateText(item.state, item.kind) }}</el-tag>
        </span>
      </div>
      <el-progress
        v-if="item.state === 'transferring'"
        :percentage="percent(item)"
        :format="() => formatBytes(item.doneBytes) + ' / ' + formatBytes(item.totalBytes)"
      />
      <div v-if="item.reason" class="reason">{{ item.reason }}</div>
      <div v-if="item.state === 'complete' && item.saveDir" class="saved-row">
        <span class="saved-path">已保存到：{{ item.saveDir }}</span>
        <el-button size="small" text type="primary" @click="openFolder(item.saveDir)">打开文件夹</el-button>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { useTransferStore, type TransferItem } from '../stores/transfer'
import { ElMessage } from 'element-plus'

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
function stateText(s: TransferItem['state'], kind: TransferItem['kind']): string {
  if (s === 'complete') return kind === 'outgoing' ? '已发送' : '已接收'
  return { 'waiting-confirm': '等待确认', transferring: '传输中', failed: '失败', rejected: '已拒绝' }[s]
}
function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}

function cancel(transferId: string): void {
  window.api.cancelTransfer(transferId)
}

async function openFolder(dir: string): Promise<void> {
  const err = await window.api.openPath(dir)
  if (err) ElMessage.error('无法打开文件夹：' + err)
}
</script>

<style scoped>
.transfer-list { display: flex; flex-direction: column; gap: 8px; }
.transfer-item .row { display: flex; justify-content: space-between; align-items: center; }
.row-right { display: flex; align-items: center; gap: 8px; }
.reason { color: var(--el-color-danger); font-size: 12px; margin-top: 4px; }
.saved-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.saved-path { font-size: 12px; color: var(--el-text-color-secondary); word-break: break-all; }
</style>
