<script setup lang="ts">
</script>

<template>
  <div class="empty">
    <svg class="empty-icon" width="48" height="48" viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="20" fill="none" stroke="var(--border-mid)" stroke-width="1" />
      <circle cx="24" cy="24" r="10" fill="none" stroke="var(--border-bright)" stroke-width="0.8" />
      <circle cx="24" cy="24" r="3" fill="var(--accent-blue)" opacity="0.4" />
    </svg>

    <div class="empty-title">No requests captured</div>
    <div class="empty-sub">
      Point API calls to <code>localhost:4040</code>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  flex-direction: column;
  gap: 14px;
  user-select: none;
}

.empty-icon {
  opacity: 0.6;
}

.empty-title {
  font-size: var(--text-base);
  color: var(--text-dim);
  font-weight: 500;
}

.empty-sub {
  @include sans-text;
  font-size: var(--text-sm);
  color: var(--text-muted);

  code {
    @include mono-text;
    font-size: var(--text-sm);
    color: var(--accent-blue);
    background: var(--accent-blue-dim);
    padding: 1px 6px;
    border-radius: var(--radius-sm);
  }
}
</style>
