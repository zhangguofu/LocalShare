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
          保存到：<el-link type="primary" @click="openCurrentDir">{{ currentDir }}</el-link>
        </p>
        <el-alert
          v-if="currentConflicts"
          type="warning"
          :closable="false"
          title="保存位置已存在同名文件/文件夹，接受将覆盖已有内容"
        />
      </div>
    </template>
    <template #footer>
      <el-button :disabled="checking" @click="reject">拒绝</el-button>
      <el-button :loading="checking" @click="chooseOtherDir">选择其他位置</el-button>
      <el-button v-if="currentConflicts" type="warning" @click="accept">接受并覆盖</el-button>
      <el-button v-else type="primary" @click="accept">接受</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { useTransferStore } from '../stores/transfer'

const transferStore = useTransferStore()
const offer = computed(() => transferStore.pendingOffer)

const defaultDir = ref('') // 默认保存目录（配置项）
const currentDir = ref('') // 当前目标目录（初始=默认，可反复更换）
const currentConflicts = ref(false) // 当前目标目录的冲突检测结果
const checking = ref(false)

onMounted(async () => {
  defaultDir.value = (await window.api.getConfig()).saveDir
})

// 打开确认框：重新读最新默认目录（可能因上次“换位置接收”已更新），
// 目标目录重置为默认，冲突状态取 OFFER 已计算的默认目录冲突
watch(offer, async (o) => {
  if (o) {
    defaultDir.value = (await window.api.getConfig()).saveDir
    currentDir.value = defaultDir.value
    currentConflicts.value = o.conflicts
    checking.value = false
  }
})

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}

// 选其他位置：只查询冲突并更新内嵌提示，不提交；可反复选择直到覆盖或选到干净目录
async function chooseOtherDir(): Promise<void> {
  if (!offer.value) return
  const dir = await window.api.pickDirectory()
  if (!dir) return
  checking.value = true
  try {
    const result = await window.api.checkDirConflicts(offer.value.transferId, dir)
    currentDir.value = dir
    currentConflicts.value = result.conflicts
    if (result.conflicts) {
      ElMessage.warning('所选目录存在同名文件/文件夹，可选择覆盖或继续更换目录')
    } else {
      ElMessage.success('该目录无同名内容，可正常接收')
    }
  } finally {
    checking.value = false
  }
}

// 接受（无冲突）/ 接受并覆盖（冲突）：提交当前目录与是否覆盖
async function accept(): Promise<void> {
  if (!offer.value) return
  const result = await window.api.respondTransfer(
    offer.value.transferId,
    'accept',
    currentDir.value,
    currentConflicts.value
  )
  if (result.ok) {
    transferStore.clearOffer()
    // 换位置接收：主进程已把新位置持久化为默认，提示用户（下次自动存到这里）
    if (currentDir.value && currentDir.value !== defaultDir.value) {
      ElMessage.success(`已接收，默认保存位置已更新为：${currentDir.value}`)
    }
    return
  }
  if (result.conflicts) {
    // 防御兜底：磁盘状态在检测后发生变化（如该目录刚被写入同名文件），重新提示
    currentConflicts.value = true
    ElMessage.warning('目标目录出现同名内容，请选择覆盖或更换目录')
    return
  }
  if (result.error) ElMessage.error(result.error)
}

function reject(): void {
  if (!offer.value) return
  void window.api.respondTransfer(offer.value.transferId, 'reject')
  transferStore.clearOffer()
}

async function openCurrentDir(): Promise<void> {
  if (!currentDir.value) return
  const err = await window.api.openPath(currentDir.value)
  if (err) ElMessage.error('无法打开文件夹：' + err)
}
</script>

<style scoped>
.offer-info p { margin: 6px 0; }
</style>
