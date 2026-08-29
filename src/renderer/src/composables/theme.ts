import { ref, watchEffect, onMounted, onUnmounted } from 'vue'

export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'localshare:theme'

const mode = ref<ThemeMode>((localStorage.getItem(STORAGE_KEY) as ThemeMode) || 'system')
const systemDark = ref(window.matchMedia('(prefers-color-scheme: dark)').matches)
const resolved = ref<ResolvedTheme>('light')

let media: MediaQueryList | null = null
const mediaListener = (e: MediaQueryListEvent): void => {
  systemDark.value = e.matches
}

function apply(m: ResolvedTheme): void {
  resolved.value = m
  document.documentElement.classList.toggle('dark', m === 'dark')
  // Electron 原生控件（titlebar 等）跟随
  document.documentElement.style.colorScheme = m
}

export function useTheme() {
  // mode → 实际主题（system 时取系统值）
  watchEffect(() => {
    apply(mode.value === 'system' ? (systemDark.value ? 'dark' : 'light') : mode.value)
  })

  onMounted(() => {
    media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', mediaListener)
  })
  onUnmounted(() => {
    media?.removeEventListener('change', mediaListener)
  })

  function setMode(m: ThemeMode): void {
    mode.value = m
    localStorage.setItem(STORAGE_KEY, m)
  }

  // 快捷按钮循环切换：light → dark → system → light
  function cycleMode(): void {
    const order: ThemeMode[] = ['light', 'dark', 'system']
    setMode(order[(order.indexOf(mode.value) + 1) % order.length])
  }

  return { mode, resolved, setMode, cycleMode }
}
