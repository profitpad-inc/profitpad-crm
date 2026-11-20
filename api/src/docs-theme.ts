// ReadMe-style look for the Scalar docs at /docs: clean white page, light
// gray sidebar with blue active items, roomier type. Only Scalar's documented
// CSS variables are overridden, so upgrades keep working.
export const docsCss = `
.light-mode {
  --scalar-background-1: #ffffff;
  --scalar-background-2: #f7f9fb;
  --scalar-background-3: #eef1f5;
  --scalar-border-color: #e3e8ee;
  --scalar-color-1: #1a2533;
  --scalar-color-2: #4f5a66;
  --scalar-color-3: #8792a2;
  --scalar-color-accent: #118cfd;

  --scalar-sidebar-background-1: #f7f9fb;
  --scalar-sidebar-border-color: #e3e8ee;
  --scalar-sidebar-color-1: #1a2533;
  --scalar-sidebar-color-2: #4f5a66;
  --scalar-sidebar-color-active: #118cfd;
  --scalar-sidebar-item-hover-background: #eef1f5;
  --scalar-sidebar-item-hover-color: #1a2533;
  --scalar-sidebar-item-active-background: #e6f2ff;
  --scalar-sidebar-search-background: #ffffff;
  --scalar-sidebar-search-border-color: #d5dbe3;
  --scalar-sidebar-search-color: #8792a2;
}

.dark-mode {
  --scalar-background-1: #0f1720;
  --scalar-background-2: #16202b;
  --scalar-background-3: #1e2a37;
  --scalar-border-color: #263443;
  --scalar-color-1: #e6edf3;
  --scalar-color-2: #a9b4c0;
  --scalar-color-3: #76828f;
  --scalar-color-accent: #4aa8ff;

  --scalar-sidebar-background-1: #121b25;
  --scalar-sidebar-border-color: #263443;
  --scalar-sidebar-color-1: #e6edf3;
  --scalar-sidebar-color-2: #a9b4c0;
  --scalar-sidebar-color-active: #4aa8ff;
  --scalar-sidebar-item-hover-background: #1e2a37;
  --scalar-sidebar-item-hover-color: #e6edf3;
  --scalar-sidebar-item-active-background: #16314d;
  --scalar-sidebar-search-background: #0f1720;
  --scalar-sidebar-search-border-color: #2c3b4b;
  --scalar-sidebar-search-color: #76828f;
}

:root {
  --scalar-radius: 6px;
  --scalar-radius-lg: 8px;
  --scalar-radius-xl: 10px;
  --scalar-sidebar-width: 280px;
  --scalar-sidebar-font-weight: 500;
  --scalar-sidebar-font-weight-active: 600;
  --scalar-sidebar-padding: 12px;
}

/* Scalar shows a sticky breadcrumb bar once the sidebar has nested tags (the
   Objects parent). For a top-level section it shows the first nested path
   instead (Objects > Users above Schema), so it is hidden. */
nav.context-bar {
  display: none !important;
}
`;

// Sidebar accordion for the docs: opening a group closes the other open
// groups at the same level (Currencies closes Files; Contacts closes Deals
// inside Objects). Scalar has no option for it, so this finds its event bus
// (exposed by the ApiReference component) through the mounted Vue tree and
// closes siblings with its own toggle event, which does not navigate. If a
// Scalar upgrade moves things, it quietly does nothing.
export const docsScript = `<script data-pcrm-docs-accordion>
(() => {
  let bus;
  const find = (v, depth) => {
    if (!v || depth > 400) return;
    const c = v.component;
    if (c) return c.exposed && c.exposed.eventBus ? c.exposed.eventBus : find(c.subTree, depth + 1);
    if (v.suspense) return find(v.suspense.activeBranch, depth + 1);
    if (Array.isArray(v.children)) {
      for (const child of v.children) {
        const found = find(child, depth + 1);
        if (found) return found;
      }
    }
  };
  const getBus = () => {
    if (bus) return bus;
    for (const el of document.querySelectorAll('[data-v-app]')) {
      bus = find(el._vnode, 0);
      if (bus) return bus;
    }
  };
  const isOpen = (item) => {
    const button = item.querySelector('button[aria-expanded]');
    return !!button && button.getAttribute('aria-expanded') === 'true';
  };
  document.addEventListener('click', (e) => {
    // a group's header row holds the name (a link that opens and selects it)
    // and the chevron (a button that only toggles); either one counts
    const header = e.target instanceof Element ? e.target.closest('[data-sidebar-id] > div') : null;
    const item = header && header.parentElement;
    const button = header && header.querySelector('button[aria-expanded]');
    if (!button || !item.parentElement) return;
    setTimeout(() => {
      if (button.getAttribute('aria-expanded') !== 'true') return;
      const eventBus = getBus();
      if (!eventBus) return;
      for (const sibling of item.parentElement.children) {
        const id = sibling.getAttribute('data-sidebar-id');
        if (sibling === item || !id || !isOpen(sibling)) continue;
        eventBus.emit('toggle:nav-item', { id, open: false });
      }
    }, 50);
  });
})();
</script>`;
