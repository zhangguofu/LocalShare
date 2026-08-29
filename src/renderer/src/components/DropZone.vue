<template>
  <div
    class="drop-zone"
    :class="{ over, disabled: !deviceStore.target }"
    @dragover.prevent="over = true"
    @dragleave="over = false"
    @drop.prevent="onDrop"
  >
    <svg class="dz-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 16V7m0 0-3.5 3.5M12 7l3.5 3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M4 15.5v2A3.5 3.5 0 0 0 7.5 21h9a3.5 3.5 0 0 0 3.5-3.5v-2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>
    <div class="dz-text">
      <template v-if="deviceStore.target">
        <span class="dz-main">发送到 <b>{{ deviceStore.target.name }}</b></span>
        <span class="dz-sub">拖拽文件/文件夹到此处，或点击选择</span>
      </template>
      <template v-else>
        <span class="dz-main">先选择目标设备</span>
        <span class="dz-sub">在左侧选择在线设备或输入 IP 直连后，即可拖拽发送</span>
      </template>
    </div>
    <div class="dz-actions">
      <el-button size="default" :disabled="!deviceStore.target" @click="pick('file')">选择文件</el-button>
      <el-button size="default" :disabled="!deviceStore.target" @click="pick('dir')">选择文件夹</el-button>
    </div>
    <span v-if="over" class="dz-overlay">松开即发送到 {{ deviceStore.target?.name }}</span>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useDeviceStore } from '../stores/device'
import { useTransferStore } from '../stores/transfer'
import type { TransferTarget } from '../../../preload'
import type { DeviceInfo } from '../../../main/network/deviceTable'

const over = ref(false)
const deviceStore = useDeviceStore()
const transferStore = useTransferStore()

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

async function pick(kind: 'file' | 'dir'): Promise<void> {
  const paths = await window.api.pickPaths(kind)
  if (paths.length > 0) await send(paths)
}

async function send(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  if (!deviceStore.target) {
    ElMessage.warning('请先在左侧选择目标设备（或手动输入 IP）')
    return
  }
  try {
    const result = await window.api.sendTransfer(toTarget(deviceStore.target), paths)
    transferStore.pushOutgoing({ ...result, peerName: deviceStore.target.name })
    if (result.skippedSymlinks > 0) {
      ElMessage.warning(`已跳过 ${result.skippedSymlinks} 个符号链接（不支持传输链接本身）`)
    }
    ElMessage.success('已发起传输，等待对方确认')
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}
</script>

<style scoped>
.drop-zone {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  border: 1.5px dashed var(--ls-border-strong);
  border-radius: var(--ls-radius);
  background: var(--ls-bg-inset);
  position: relative;
  transition: border-color 0.15s, background 0.15s;
}
.drop-zone:not(.disabled):hover { border-color: var(--ls-primary); }
.drop-zone.over {
  border-color: var(--ls-primary);
  background: var(--ls-primary-weak);
}

.dz-icon { width: 22px; height: 22px; color: var(--ls-text-3); flex: none; }
.drop-zone.over .dz-icon { color: var(--ls-primary); }

.dz-text { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dz-main { font-size: 13px; font-weight: 500; }
.dz-main b { color: var(--ls-primary); }
.dz-sub { font-size: 12px; color: var(--ls-text-3); }

.dz-actions { display: flex; gap: 8px; flex: none; }

.dz-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--ls-radius);
  background: var(--ls-primary-weak);
  backdrop-filter: blur(1px);
  color: var(--ls-primary);
  font-size: 14px;
  font-weight: 600;
  pointer-events: none;
}
</style>
