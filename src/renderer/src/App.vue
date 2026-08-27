<template>
  <el-container class="app-root">
    <el-main>
      <h1>LocalShare</h1>
      <p>脚手架验证：{{ pingResult }}</p>
    </el-main>
  </el-container>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

const pingResult = ref('...')
onMounted(async () => {
  pingResult.value = await window.api.ping()
})
</script>

<style>
.app-root {
  height: 100vh;
}
</style>
