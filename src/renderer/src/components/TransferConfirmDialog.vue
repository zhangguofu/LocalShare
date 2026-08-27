<template>
  <el-dialog
    :model-value="!!offer"
    title="接收传输"
    width="480px"
    :close-on-click-modal="false"
    :show-close="false"
    @close="reject"
  >
    <template v-if="offer">
      <div class="offer-info">
        <p>发送者：<b>{{ offer.senderName }}</b></p>
        <p>
          内容：<b>{{ offer.files.length === 1 ? offer.files[0].path : offer.fileCount + ' 项' }}</b>
          （{{ formatBytes(offer.totalBytes) }}）
        </p>
        <p>
          保存到：<el-link type="primary" @click="openSaveDir">{{ saveDir }}</el-link>
        </p>
        <el-alert
          v-if="offer.conflicts"
          type="warning"
          :closable="false"
          title="保存位置已存在同名文件/文件夹"
        />
      </div>
    </template>
    <template #footer>
      <el-button @click="reject">拒绝</el-button>
      <el-button @click="chooseOtherDir">选择其他位置</el-button>
      <el-button v-if="offer?.conflicts" type="warning" @click="accept">接受并覆盖</el-button>
      <el-button v-else type="primary" @click="accept">接受</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useTransferStore } from '../stores/transfer'

const transferStore = useTransferStore()
const offer = computed(() => transferStore.pendingOffer)
const saveDir = ref('')

onMounted(async () => {
  saveDir.value = (await window.api.getConfig()).saveDir
})

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}

async function accept(): Promise<void> {
  if (!offer.value) return
  // 冲突时按钮为「接受并覆盖」→ force；无冲突直接接受
  const force = offer.value.conflicts
  const result = await window.api.respondTransfer(offer.value.transferId, 'accept', undefined, force)
  if (result.ok) {
    transferStore.clearOffer()
  } else if (result.error) {
    ElMessage.error(result.error)
  }
}

function reject(): void {
  if (!offer.value) return
  void window.api.respondTransfer(offer.value.transferId, 'reject')
  transferStore.clearOffer()
}

async function chooseOtherDir(): Promise<void> {
  if (!offer.value) return
  const dir = await window.api.pickDirectory()
  if (!dir) return
  const result = await window.api.respondTransfer(offer.value.transferId, 'accept', dir)
  if (result.ok) {
    transferStore.clearOffer()
    ElMessage.success('已选择新位置接收')
    return
  }
  if (result.conflicts) {
    // 二次冲突确认：所选目录已存在同名内容，避免意外覆盖（设计 6.3）
    try {
      await ElMessageBox.confirm(
        `所选目录已存在同名文件/文件夹，继续将覆盖已有内容。是否覆盖？`,
        '存在同名内容',
        { confirmButtonText: '覆盖', cancelButtonText: '返回', type: 'warning' }
      )
      const forceResult = await window.api.respondTransfer(offer.value.transferId, 'accept', dir, true)
      if (forceResult.ok) {
        transferStore.clearOffer()
        ElMessage.success('已覆盖接收')
      } else if (forceResult.error) {
        ElMessage.error(forceResult.error)
      }
    } catch {
      // 用户选「返回」：对话框保持，可再次选择其他位置或回到覆盖流程
    }
    return
  }
  if (result.error) ElMessage.error(result.error)
}

async function openSaveDir(): Promise<void> {
  if (!saveDir.value) return
  const err = await window.api.openPath(saveDir.value)
  if (err) ElMessage.error('无法打开文件夹：' + err)
}
</script>

<style scoped>
.offer-info p { margin: 6px 0; }
</style>
