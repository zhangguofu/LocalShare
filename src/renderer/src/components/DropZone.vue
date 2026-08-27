<template>
  <div class="drop-zone" @dragover.prevent="over = true" @dragleave="over = false" @drop.prevent="onDrop">
    <el-empty :image-size="80" description="拖拽文件/文件夹到此处，或点击选择" />
    <el-button type="primary" @click="pick">选择文件/文件夹</el-button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useDeviceStore } from '../stores/device'
import type { TransferTarget } from '../../../preload'
import type { DeviceInfo } from '../../../main/network/deviceTable'

const over = ref(false)
const deviceStore = useDeviceStore()

// DeviceInfo → TransferTarget：手动直连设备走 host/port，发现设备走 deviceId
function toTarget(d: DeviceInfo): TransferTarget {
  if (d.id.startsWith('manual-')) return { host: d.host, port: d.tcpPort }
  return { deviceId: d.id }
}

async function onDrop(e: DragEvent): Promise<void> {
  over.value = false
  const files = Array.from(e.dataTransfer?.files ?? [])
  const paths = files.map((f) => window.api.getPathForFile(f)).filter((p): p is string => Boolean(p))
  await send(paths)
}

async function pick(): Promise<void> {
  const paths = await window.api.pickPaths()
  if (paths.length > 0) await send(paths)
}

async function send(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  if (!deviceStore.target) {
    ElMessage.warning('请先在左侧选择目标设备（或手动输入 IP）')
    return
  }
  try {
    await window.api.sendTransfer(toTarget(deviceStore.target), paths)
    ElMessage.success('已发起传输，等待对方确认')
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}
</script>

<style scoped>
.drop-zone {
  border: 2px dashed var(--el-border-color);
  border-radius: 8px;
  padding: 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.drop-zone:hover { border-color: var(--el-color-primary); }
</style>
