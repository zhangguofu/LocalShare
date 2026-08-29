<template>
  <div class="app-root">
    <header class="topbar">
      <div class="brand">
        <svg class="brand-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="var(--ls-primary)" />
          <path d="M7 10.2 4.6 12.5 7 14.8" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M17 10.2 19.4 12.5 17 14.8" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M5.2 12.5h13.6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" />
        </svg>
        <span class="brand-name">LocalShare</span>
      </div>
      <div class="topbar-actions">
        <el-tooltip :content="themeTip" placement="bottom" :show-after="300">
          <button class="icon-btn" :aria-label="themeTip" @click="cycleMode()">
            <svg v-if="mode === 'light'" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4.2" fill="currentColor"/><path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.4 5.4l1.7 1.7M16.9 16.9l1.7 1.7M18.6 5.4l-1.7 1.7M7.1 16.9l-1.7 1.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            <svg v-else-if="mode === 'dark'" viewBox="0 0 24 24" fill="none"><path d="M20.4 14.2A8.6 8.6 0 1 1 9.8 3.6a7 7 0 1 0 10.6 10.6Z" fill="currentColor"/></svg>
            <svg v-else viewBox="0 0 24 24" fill="none"><rect x="2.6" y="4.2" width="18.8" height="15.6" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 4.2v15.6" stroke="currentColor" stroke-width="1.8"/><path class="half" d="M12 4.2h5.8a3 3 0 0 1 3 3v9.6a3 3 0 0 1-3 3H12Z" fill="currentColor" stroke="none"/></svg>
          </button>
        </el-tooltip>
        <el-tooltip content="设置" placement="bottom" :show-after="300">
          <button class="icon-btn" aria-label="设置" @click="settingsVisible = true">
            <svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true"><path d="M1016.815716 431.057063l-4.310571-26.821329-82.379794-27.30028a435.367633 435.367633 0 0 0-26.821329-64.65856l38.795136-77.590271-15.805426-22.031805A526.847521 526.847521 0 0 0 811.345182 95.790458l-22.031805-15.805425-77.590271 38.795135a439.678204 439.678204 0 0 0-64.65856-26.821328L619.764266 11.015903l-26.821329-3.831619A506.731525 506.731525 0 0 0 512 0 508.647334 508.647334 0 0 0 431.057063 7.184284l-27.300281 4.310571L376.456501 95.790458a455.004677 455.004677 0 0 0-64.658559 26.821329L234.207671 81.42189l-22.031806 14.368568A514.394761 514.394761 0 0 0 95.790458 212.175865l-15.805425 22.031806 38.795135 77.590271A443.988775 443.988775 0 0 0 95.790458 376.456501l-84.774555 27.300281L7.184284 431.057063A516.310571 516.310571 0 0 0 0 512a511.521048 511.521048 0 0 0 7.184284 80.942937l4.310571 26.821329 84.295603 27.779233a433.930776 433.930776 0 0 0 26.821329 64.658559l-38.795136 77.111319 15.805426 22.031805a504.815716 504.815716 0 0 0 52.2058 62.263798 521.100094 521.100094 0 0 0 62.263797 52.684752l22.031806 15.805426 77.590271-38.795136a431.057063 431.057063 0 0 0 64.65856 26.821329l27.30028 82.379794 26.821329 4.310571a510.084191 510.084191 0 0 0 80.942937 7.184284 512.478952 512.478952 0 0 0 80.942937-7.184284l26.821329-4.310571 27.30028-82.379794a469.852198 469.852198 0 0 0 64.65856-26.821329l77.590271 38.795136 22.031805-15.805426a476.078578 476.078578 0 0 0 62.263798-52.684752A517.747428 517.747428 0 0 0 926.293732 814.218896l15.805426-22.031805-38.795136-77.590272a431.057063 431.057063 0 0 0 26.821329-64.658559l82.379794-27.300281 4.310571-26.821328a511.521048 511.521048 0 0 0 7.184284-80.942937A454.525725 454.525725 0 0 0 1016.815716 431.057063z m-504.815716 276.355472a195.412535 195.412535 0 1 1 195.891487-195.412535 195.891487 195.891487 0 0 1-195.891487 195.412535z"/><path d="M512 397.05145a114.94855 114.94855 0 1 0 80.942937 33.52666 113.990645 113.990645 0 0 0-80.942937-33.52666z"/></svg>
          </button>
        </el-tooltip>
      </div>
    </header>

    <div class="body">
      <aside class="aside">
        <DeviceList />
      </aside>
      <main class="main-area">
        <DropZone />
        <TransferList />
      </main>
    </div>

    <TransferConfirmDialog />
    <SettingsDialog v-model="settingsVisible" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import DeviceList from './components/DeviceList.vue'
import DropZone from './components/DropZone.vue'
import TransferList from './components/TransferList.vue'
import TransferConfirmDialog from './components/TransferConfirmDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import { useDeviceStore } from './stores/device'
import { useTransferStore } from './stores/transfer'
import { useTheme } from './composables/theme'

const deviceStore = useDeviceStore()
const transferStore = useTransferStore()
const settingsVisible = ref(false)
const { mode, cycleMode } = useTheme()

const themeTip = computed(() => ({
  light: '主题：明亮（点击切换为深色）',
  dark: '主题：深色（点击切换为跟随系统）',
  system: '主题：跟随系统（点击切换为明亮）'
}[mode.value]))

onMounted(() => {
  void deviceStore.refresh()
  window.api.onDeviceChange((upd) => deviceStore.applyUpdate(upd))
  window.api.onTransferUpdate((u) => transferStore.applyUpdate(u))
  window.api.onOffer((offer) => transferStore.pushOffer(offer))
})
</script>

<style>
.app-root {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--ls-bg-app);
  color: var(--ls-text-1);
}

/* 顶栏 */
.topbar {
  height: 52px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  background: var(--ls-bg-panel);
  border-bottom: 1px solid var(--ls-border);
}
.brand { display: flex; align-items: center; gap: 10px; }
.brand-icon { width: 24px; height: 24px; }
.brand-name { font-weight: 650; font-size: 15px; letter-spacing: 0.2px; }
.topbar-actions { display: flex; align-items: center; gap: 4px; }

.icon-btn {
  width: 34px;
  height: 34px;
  border: none;
  border-radius: var(--ls-radius-sm);
  background: transparent;
  color: var(--ls-text-2);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
}
.icon-btn:hover { background: var(--ls-bg-hover); color: var(--ls-text-1); }
.icon-btn svg { width: 19px; height: 19px; }

/* 主体 */
.body {
  flex: 1;
  display: flex;
  min-height: 0; /* 允许子列独立滚动 */
}
.aside {
  width: 264px;
  flex: none;
  background: var(--ls-bg-panel);
  border-right: 1px solid var(--ls-border);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px 16px;
  min-width: 0;
  min-height: 0;
}
</style>
