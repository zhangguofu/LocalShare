<template>
  <div class="device-panel">
    <h3>在线设备</h3>
    <el-empty v-if="deviceStore.devices.length === 0" description="未发现设备" :image-size="60" />
    <div v-else class="device-items">
      <div
        v-for="d in deviceStore.devices"
        :key="d.id"
        class="device-item"
        :class="{ active: deviceStore.target?.id === d.id }"
        @click="deviceStore.target = d"
      >
        <span class="device-name">{{ d.name }}</span>
        <span class="device-meta">{{ d.host }}:{{ d.tcpPort }}</span>
      </div>
    </div>
    <el-divider />
    <div class="manual">
      <el-input v-model="manualIp" placeholder="IP 或 IP:端口 手动直连" size="small" @keyup.enter="connectManual" />
      <el-button size="small" @click="connectManual">设置目标</el-button>
    </div>
    <div v-if="manualTarget" class="manual-target">
      <el-tag type="warning" size="small" closable @close="deviceStore.target = null">
        手动目标：{{ manualTarget.host }}:{{ manualTarget.tcpPort }}
      </el-tag>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { useDeviceStore } from '../stores/device'
import type { DeviceInfo } from '../../../main/network/deviceTable'

const deviceStore = useDeviceStore()
const manualIp = ref('')

// 当前是否选中了手动目标（区别于在线设备）
const manualTarget = computed(() => {
  const t = deviceStore.target
  return t && t.id.startsWith('manual-') ? t : null
})

async function connectManual(): Promise<void> {
  const input = manualIp.value.trim()
  if (!input) return
  const [host, portStr] = input.split(':')
  if (!host) {
    ElMessage.warning('请输入 IP 地址')
    return
  }
  const port = portStr ? Number(portStr) : (await window.api.getConfig()).tcpPort
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    ElMessage.warning('端口无效（1-65535），格式：IP 或 IP:端口')
    return
  }
  deviceStore.target = {
    id: 'manual-' + host + '-' + port,
    name: host,
    platform: 'unknown',
    version: 'manual',
    host,
    tcpPort: port,
    lastSeen: Date.now()
  } as DeviceInfo
  ElMessage.success(`已设置手动目标 ${host}:${port}，拖拽文件即可发送`)
}
</script>

<style scoped>
.device-panel { padding: 12px; }
.device-items { display: flex; flex-direction: column; gap: 8px; }
.device-item {
  padding: 8px 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
}
.device-item.active { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.device-meta { color: var(--el-text-color-secondary); font-size: 12px; }
.manual { display: flex; gap: 6px; }
.manual-target { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
</style>
