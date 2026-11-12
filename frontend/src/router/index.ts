import { createRouter, createWebHashHistory } from 'vue-router'
// hash 路由：file:// 双击可用；history 模式在 file:// 下刷新会 404
import Cockpit from '@/views/Cockpit.vue'
import DecisionCard from '@/views/DecisionCard.vue'
import Portfolio from '@/views/Portfolio.vue'
import Review from '@/views/Review.vue'
import ReportView from '@/views/ReportView.vue'
import ModelCard from '@/views/ModelCard.vue'
import SceneView from '@/views/SceneView.vue'
import Evidence from '@/views/Evidence.vue'
import About from '@/views/About.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'panorama', component: Cockpit, meta: { act: 1, title: '区块价值全景' } },
    {
      path: '/well/:wellId',
      name: 'well',
      component: DecisionCard,
      meta: { act: 2, title: '单井决策卡' },
    },
    { path: '/portfolio', name: 'portfolio', component: Portfolio, meta: { act: 3, title: '措施会结算' } },
    { path: '/review', name: 'review', component: Review, meta: { act: 4, title: '数据与复盘' } },
    { path: '/report', name: 'report', component: ReportView, meta: { act: 5, title: '决策报告' } },
    {
      path: '/model-card',
      name: 'model-card',
      component: ModelCard,
      meta: { act: 6, title: '模型卡 / 状态混淆矩阵' },
    },
    {
      path: '/evidence',
      name: 'evidence',
      component: Evidence,
      meta: { act: 6, title: '证据中心 / 五张表' },
    },
    {
      path: '/about',
      name: 'about',
      component: About,
      meta: { act: 7, title: '关于 / 场景 · 单位 · 声明' },
    },
    { path: '/scene', name: 'scene', component: SceneView, meta: { act: 0, title: '三维场景' } },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

export default router
