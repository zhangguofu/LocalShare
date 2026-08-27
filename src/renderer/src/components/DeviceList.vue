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
      <el-button size="small" @click="connectManual">连接</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useDeviceStore } from '../stores/device'
import type { DeviceInfo } from '../../../main/network/deviceTable'

const deviceStore = useDeviceStore()
const manualIp = ref('')

async function connectManual(): Promise<void> {
  if (!manualIp.value.trim()) return
  const [host, portStr] = manualIp.value.split(':')
  const port = portStr ? Number(portStr) : (await window.api.getConfig()).tcpPort
  deviceStore.target = {
    id: 'manual-' + host + '-' + port,
    name: host,
    platform: 'unknown',
    version: 'manual',
    host,
    tcpPort: port,
    lastSeen: Date.now()
  } as DeviceInfo
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
</style>
