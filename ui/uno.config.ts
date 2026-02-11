import { defineConfig, presetIcons, presetWind3, transformerDirectives } from 'unocss'

export default defineConfig({
  presets: [
    presetWind3(),
    presetIcons({
      prefix: 'i-',
      scale: 1.2,
      extraProperties: {
        'display': 'inline-block',
        'vertical-align': 'middle',
      },
    }),
  ],
  transformers: [
    transformerDirectives(),
  ],
  theme: {
    colors: {
      // Map to CSS custom properties from _tokens.scss
      deep: 'var(--bg-deep)',
      field: 'var(--bg-field)',
      surface: 'var(--bg-surface)',
      raised: 'var(--bg-raised)',
    },
  },
  shortcuts: {
    'mono': 'font-mono',
    'text-dim': 'color-[var(--text-dim)]',
    'text-muted': 'color-[var(--text-muted)]',
    'text-secondary': 'color-[var(--text-secondary)]',
    'text-primary': 'color-[var(--text-primary)]',
    'border-base': 'border-[var(--border-dim)]',
    'border-mid': 'border-[var(--border-mid)]',
    'bg-hover': 'bg-[var(--bg-hover)]',
  },
})
