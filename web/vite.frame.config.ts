import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The custom view frame (src/view-runtime) as one self-contained HTML file at
// public/view-frame/index.html, so both the dev server and the main build
// serve it. It runs in a sandboxed iframe with an opaque origin, where 'self'
// and module scripts are unreliable, so everything is inline: the script
// (allowed by its hash), the styles and the fonts. 'unsafe-eval' runs the
// view's compiled module; connect-src 'none' keeps view code off the network.
function singleHtml(): Plugin {
  return {
    name: 'pcrm-view-frame-html',
    apply: 'build',
    // after Vite's CSS plugin has emitted the stylesheet
    enforce: 'post',
    generateBundle(_options, bundle) {
      let js = '';
      let css = '';
      for (const [name, item] of Object.entries(bundle)) {
        if (item.type === 'chunk') js += item.code;
        else if (name.endsWith('.css')) css += String(item.source);
        delete bundle[name];
      }
      // a literal "</script" inside the bundle would end the tag early
      js = js.replace(/<\/script/gi, '<\\/script');
      css = css.replace(/<\/style/gi, '<\\/style');
      const hash = createHash('sha256').update(js).digest('base64');
      const policy = [
        "default-src 'none'",
        `script-src 'sha256-${hash}' 'unsafe-eval'`,
        "style-src 'unsafe-inline'",
        "img-src data: blob: https:",
        "font-src data:",
        "connect-src 'none'",
        "base-uri 'none'",
        "form-action 'none'"
      ].join('; ');
      this.emitFile({
        type: 'asset',
        fileName: 'index.html',
        source: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>
`
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), singleHtml()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'public/view-frame',
    emptyOutDir: true,
    copyPublicDir: false,
    cssCodeSplit: false,
    assetsInlineLimit: () => true,
    lib: {
      entry: fileURLToPath(new URL('src/view-runtime/main.tsx', import.meta.url)),
      formats: ['iife'],
      name: 'PcrmViewFrame',
      fileName: () => 'frame.js'
    }
  }
});
