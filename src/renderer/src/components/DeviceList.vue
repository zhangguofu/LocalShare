<template>
  <div class="device-panel">
    <div class="panel-head">
      <span class="panel-title">设备</span>
      <span class="count-badge">{{ deviceStore.devices.length }}</span>
    </div>

    <!-- 搜索：多设备时快速定位 -->
    <div v-if="deviceStore.devices.length > 4" class="search-row">
      <el-input
        v-model="keyword"
        size="small"
        placeholder="搜索设备名 / IP"
        clearable
        :prefix-icon="SearchIcon"
      />
    </div>

    <div class="device-scroll">
      <div v-if="filtered.length === 0" class="empty-devices">
        <template v-if="deviceStore.devices.length === 0">
          <p class="empty-title">未发现设备</p>
          <p class="empty-hint">同一局域网的设备运行本应用后<br/>会自动出现在这里</p>
        </template>
        <template v-else>
          <p class="empty-title">无匹配设备</p>
          <p class="empty-hint">换个关键词试试</p>
        </template>
      </div>

      <div
        v-for="d in filtered"
        :key="d.id"
        class="device-item"
        :class="{ active: deviceStore.target?.id === d.id }"
        @click="deviceStore.target = d"
      >
        <span class="platform-icon" :class="'pf-' + platformOf(d)">{{ platformLabel(d) }}</span>
        <span class="device-info">
          <span class="device-name">{{ d.name }}</span>
          <span class="device-meta">{{ d.host }}</span>
        </span>
        <svg v-if="deviceStore.target?.id === d.id" class="check" viewBox="0 0 24 24" fill="none">
          <path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
    </div>

    <!-- 手动直连：收进底部，弱化为次要入口 -->
    <div class="manual-block">
      <div class="manual-row">
        <el-input
          v-model="manualIp"
          size="small"
          placeholder="IP:端口 直连"
          @keyup.enter="connectManual"
        />
        <el-button size="small" @click="connectManual">连接</el-button>
      </div>
      <div v-if="manualTarget" class="manual-target">
        <span class="manual-tag">
          直连 {{ manualTarget.host }}:{{ manualTarget.tcpPort }}
          <button class="tag-close" aria-label="取消直连目标" @click="deviceStore.target = null">×</button>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { Search as SearchIcon } from '@element-plus/icons-vue'
import { useDeviceStore } from '../stores/device'
import type { DeviceInfo } from '../../../main/network/deviceTable'
import { platformOf, platformLabel } from '../utils/platform'

const deviceStore = useDeviceStore()
const manualIp = ref('')
const keyword = ref('')

// 按设备名 / IP 过滤（多设备场景）
const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return deviceStore.devices
  return deviceStore.devices.filter(
    (d) => d.name.toLowerCase().includes(kw) || d.host.toLowerCase().includes(kw)
  )
})

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
  ElMessage.success(`已设置直连目标 ${host}:${port}，拖拽文件即可发送`)
}
</script>

<style scoped>
.device-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 12px 10px 10px;
}

.panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 4px 10px;
}
.panel-title { font-size: 13px; font-weight: 600; color: var(--ls-text-2); }
.count-badge {
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 10px;
  background: var(--ls-primary-weak);
  color: var(--ls-primary);
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.search-row { padding: 0 2px 10px; }

.device-scroll {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}

.empty-devices {
  padding: 28px 12px;
  text-align: center;
}
.empty-title { margin: 0 0 6px; font-size: 13px; color: var(--ls-text-2); }
.empty-hint { margin: 0; font-size: 12px; line-height: 1.7; color: var(--ls-text-3); }

.device-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--ls-radius-sm);
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 0.12s;
}
.device-item:hover { background: var(--ls-bg-hover); }
.device-item.active {
  background: var(--ls-bg-active);
  border-color: var(--ls-primary);
}

.platform-icon {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: var(--ls-radius-sm);
  font-size: 11px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}
.pf-win { background: #0078d4; }
.pf-mac { background: #555; }
html.dark .pf-mac { background: #8e8e93; }
.pf-linux { background: #dd6b10; }

.device-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.device-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.device-meta { font-size: 12px; color: var(--ls-text-3); }

.check { width: 16px; height: 16px; color: var(--ls-primary); flex: none; }

.manual-block {
  flex: none;
  border-top: 1px solid var(--ls-border);
  padding-top: 10px;
  margin-top: 8px;
}
.manual-row { display: flex; gap: 6px; }
.manual-target { margin-top: 8px; }
.manual-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 12px;
  background: var(--ls-primary-weak);
  color: var(--ls-primary);
}
.tag-close {
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0;
}
.tag-close:hover { color: var(--ls-danger); }
</style>
