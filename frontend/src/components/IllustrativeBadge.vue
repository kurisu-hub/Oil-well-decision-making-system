<script setup lang="ts">
// 示意数据角标：source=illustrative 的条目/区块必打
withDefaults(defineProps<{ text?: string; title?: string }>(), {
  text: '示意',
  title: '该数据来自 mock_supplement.json（示意补充），不是实测结果，也不进入主 bundle',
})
</script>

<template>
  <span class="badge badge-illus" :title="title">{{ text }}</span>
</template>
