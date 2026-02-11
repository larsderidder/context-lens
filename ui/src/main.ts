import { createApp } from 'vue'
import { createPinia } from 'pinia'
import FloatingVue from 'floating-vue'
import App from './App.vue'

import 'floating-vue/dist/style.css'
import 'virtual:uno.css'
import './styles/main.scss'

const app = createApp(App)
app.use(createPinia())
app.use(FloatingVue)
app.mount('#app')
