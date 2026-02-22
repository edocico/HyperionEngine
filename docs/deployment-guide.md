# Hyperion Engine Deployment Guide

This guide covers how to build and deploy Hyperion Engine applications across 7 platforms, with emphasis on the cross-origin isolation headers required for SharedArrayBuffer support.

## Table of Contents

- [Overview](#overview)
- [Building for Production](#building-for-production)
- [Required HTTP Headers](#required-http-headers)
- [WASM Caching](#wasm-caching)
- [Platform Configurations](#platform-configurations)
  - [Vercel](#vercel)
  - [Netlify](#netlify)
  - [Cloudflare Pages](#cloudflare-pages)
  - [GitHub Pages](#github-pages)
  - [Electron](#electron)
  - [Tauri](#tauri)
  - [Self-Hosted (Nginx / Apache)](#self-hosted-nginx--apache)
- [Troubleshooting](#troubleshooting)

---

## Overview

Hyperion Engine uses `SharedArrayBuffer` for lock-free cross-thread communication between the main thread and Web Workers (via a SPSC ring buffer). Modern browsers restrict `SharedArrayBuffer` to **cross-origin isolated** contexts, which requires two HTTP response headers on every HTML page that uses the engine:

- `Cross-Origin-Opener-Policy: same-origin` (COOP)
- `Cross-Origin-Embedder-Policy: require-corp` (COEP)

Without these headers, `SharedArrayBuffer` is `undefined` in the global scope, and the engine will fall back to Mode C (single-threaded), losing all multi-threaded performance benefits.

**Key files produced by the build:**

| File | Description |
|---|---|
| `index.html` | Entry point |
| `assets/*.js` | Bundled TypeScript (ES modules) |
| `assets/*.wasm` | Compiled Rust simulation core |
| `assets/*.wgsl` | WebGPU shaders (inlined by Vite) |

---

## Building for Production

### Prerequisites

```bash
# Rust toolchain with WASM target
rustup target add wasm32-unknown-unknown
cargo install wasm-pack

# Node.js (18+ recommended)
cd ts && npm install
```

### Build Commands

```bash
# Step 1: Compile Rust to WebAssembly
cd ts && npm run build:wasm

# Step 2: Build TypeScript + bundle with Vite
cd ts && npm run build
```

The production output is written to `ts/dist/`. This is the directory you deploy.

### Preview Locally

```bash
cd ts && npx vite preview
```

The preview server is pre-configured with COOP/COEP headers, so you can verify cross-origin isolation works before deploying.

---

## Required HTTP Headers

Every HTTP response serving your HTML page (and ideally all same-origin resources) must include:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### What These Headers Do

- **COOP `same-origin`** -- Isolates the browsing context so that cross-origin popups cannot access `window.opener`. This is required for the browser to trust the page with high-resolution timers and `SharedArrayBuffer`.

- **COEP `require-corp`** -- Ensures all subresources are either same-origin or explicitly opted-in via CORS headers (`Cross-Origin-Resource-Policy: cross-origin`). This prevents Spectre-style side-channel attacks.

### Impact on Third-Party Resources

With COEP `require-corp`, loading cross-origin resources (images, fonts, scripts from CDNs) requires them to include a `Cross-Origin-Resource-Policy: cross-origin` header. If a third-party CDN does not send this header, the browser will block the resource.

**Workarounds:**

1. Self-host the resources (recommended).
2. Use `crossorigin="anonymous"` on tags and ensure the server sends proper CORS headers.
3. Use `Cross-Origin-Embedder-Policy: credentialless` instead of `require-corp` (Chrome 96+, Firefox 119+). This is more permissive but not supported in all browsers.

---

## WASM Caching

WASM files are large (often 500KB-2MB) and change only when the Rust code is recompiled. Serve them with aggressive caching:

```
Cache-Control: public, max-age=31536000, immutable
```

This tells browsers and CDNs to cache the `.wasm` file for 1 year. Since Vite adds content hashes to filenames (e.g., `hyperion_core_bg-abc123.wasm`), cache busting happens automatically on rebuild.

Apply this header to all files matching `*.wasm`. Platform-specific examples below show how to configure this.

---

## Platform Configurations

### Vercel

Create `vercel.json` in your project root (or the directory you deploy from):

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        {
          "key": "Cross-Origin-Opener-Policy",
          "value": "same-origin"
        },
        {
          "key": "Cross-Origin-Embedder-Policy",
          "value": "require-corp"
        }
      ]
    },
    {
      "source": "/(.*)\\.wasm",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        },
        {
          "key": "Content-Type",
          "value": "application/wasm"
        }
      ]
    }
  ]
}
```

**Vercel deployment:**

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy the dist directory
cd ts && vercel deploy dist
```

---

### Netlify

Create a `_headers` file inside `ts/dist/` (or configure your build to copy it there). Alternatively, place it in `ts/public/` so Vite copies it automatically:

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp

/*.wasm
  Cache-Control: public, max-age=31536000, immutable
  Content-Type: application/wasm
```

Alternatively, configure headers in `netlify.toml`:

```toml
[[headers]]
  for = "/*"
  [headers.values]
    Cross-Origin-Opener-Policy = "same-origin"
    Cross-Origin-Embedder-Policy = "require-corp"

[[headers]]
  for = "/*.wasm"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"
    Content-Type = "application/wasm"
```

**Netlify deployment:**

```bash
# Install Netlify CLI
npm i -g netlify-cli

# Deploy the dist directory
cd ts && netlify deploy --dir=dist --prod
```

---

### Cloudflare Pages

Create a `_headers` file inside `ts/dist/` (or place it in `ts/public/`):

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp

/*.wasm
  Cache-Control: public, max-age=31536000, immutable
  Content-Type: application/wasm
```

Cloudflare Pages uses the same `_headers` format as Netlify.

**Cloudflare Pages deployment:**

```bash
# Install Wrangler CLI
npm i -g wrangler

# Deploy the dist directory
cd ts && wrangler pages deploy dist
```

---

### GitHub Pages

GitHub Pages does **not** support custom HTTP headers. There is no way to set COOP/COEP headers through GitHub Pages configuration.

**Recommended solution: `coi-serviceworker`**

[coi-serviceworker](https://github.com/nickcernis/coi-serviceworker) is a small service worker that intercepts responses and adds the required cross-origin isolation headers client-side.

**Step 1:** Download `coi-serviceworker.js` and place it in `ts/public/` (so Vite copies it to `dist/`):

```bash
curl -O https://raw.githubusercontent.com/nickcernis/coi-serviceworker/main/coi-serviceworker.min.js
mv coi-serviceworker.min.js ts/public/
```

**Step 2:** Add a script tag to `ts/index.html` **before** any other scripts:

```html
<script src="/coi-serviceworker.min.js"></script>
```

**Step 3:** Deploy to GitHub Pages:

```bash
cd ts && npm run build
# Push dist/ to gh-pages branch, or use gh-pages npm package
npx gh-pages -d dist
```

**Caveats:**
- The service worker requires a page reload on first visit (the SW installs, then reloads the page to apply headers).
- This adds ~1KB to initial page load.
- Service worker scope must cover all pages that use `SharedArrayBuffer`.

---

### Electron

Electron apps run in a same-origin context by default. `SharedArrayBuffer` is available without any special headers because Electron's main process controls the browsing context.

**BrowserWindow configuration:**

```javascript
const { app, BrowserWindow } = require("electron");

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    webPreferences: {
      // Enable SharedArrayBuffer (default in Electron 14+)
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Load your built Hyperion app
  win.loadFile("dist/index.html");
}

app.whenReady().then(createWindow);
```

**Notes:**
- Electron 14+ enables `SharedArrayBuffer` by default.
- If using Electron < 14, set `webPreferences.sharedArrayBuffer: true` (deprecated flag).
- WebGPU support in Electron requires Chromium 113+ (Electron 25+). Enable it with `app.commandLine.appendSwitch('enable-unsafe-webgpu')` if needed.
- No HTTP headers need to be configured.

---

### Tauri

Tauri apps use a custom protocol (`tauri://` or `https://tauri.localhost/`) that is inherently same-origin. `SharedArrayBuffer` is available without any header configuration.

**Tauri configuration (`tauri.conf.json`):**

```json
{
  "build": {
    "distDir": "../ts/dist",
    "devPath": "http://localhost:5173"
  },
  "tauri": {
    "windows": [
      {
        "title": "Hyperion Engine",
        "width": 1280,
        "height": 720,
        "resizable": true
      }
    ],
    "security": {
      "csp": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'"
    }
  }
}
```

**Notes:**
- `'wasm-unsafe-eval'` is required in the CSP for WASM execution.
- Tauri v2 uses WKWebView on macOS, WebView2 on Windows, and WebKitGTK on Linux.
- WebGPU support depends on the underlying webview engine. As of early 2026, WebGPU is available in WebView2 (Windows) and recent WebKitGTK (Linux). macOS WKWebView support may require enabling experimental features.
- No HTTP headers need to be configured.

---

### Self-Hosted (Nginx / Apache)

#### Nginx

Add the following to your `server` block or `location` block:

```nginx
server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    root /var/www/hyperion/dist;
    index index.html;

    # Cross-origin isolation headers (required for SharedArrayBuffer)
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;

    # WASM MIME type and caching
    location ~* \.wasm$ {
        types { application/wasm wasm; }
        add_header Cache-Control "public, max-age=31536000, immutable";
        # Re-add COOP/COEP (add_header in location overrides parent)
        add_header Cross-Origin-Opener-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "require-corp" always;
    }

    # JS module caching (Vite content-hashed filenames)
    location ~* \.js$ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        add_header Cross-Origin-Opener-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "require-corp" always;
    }

    # SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

**Important Nginx caveat:** `add_header` directives in a `location` block **replace** (not append to) headers from the parent `server` block. This is why the COOP/COEP headers are repeated in each `location` block. Alternatively, use the `ngx_headers_more` module with `more_set_headers` which does not have this limitation.

#### Apache

Add the following to your `.htaccess` file or virtual host configuration:

```apache
# Enable mod_headers (required)
# a2enmod headers

# Cross-origin isolation headers (required for SharedArrayBuffer)
Header always set Cross-Origin-Opener-Policy "same-origin"
Header always set Cross-Origin-Embedder-Policy "require-corp"

# WASM MIME type
AddType application/wasm .wasm

# WASM caching
<FilesMatch "\.wasm$">
    Header set Cache-Control "public, max-age=31536000, immutable"
</FilesMatch>

# JS caching (Vite content-hashed filenames)
<FilesMatch "\.js$">
    Header set Cache-Control "public, max-age=31536000, immutable"
</FilesMatch>

# SPA fallback
<IfModule mod_rewrite.c>
    RewriteEngine On
    RewriteBase /
    RewriteRule ^index\.html$ - [L]
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteCond %{REQUEST_FILENAME} !-d
    RewriteRule . /index.html [L]
</IfModule>
```

Make sure `mod_headers` is enabled:

```bash
sudo a2enmod headers
sudo systemctl restart apache2
```

---

## Troubleshooting

### `SharedArrayBuffer is not defined`

**Cause:** The COOP/COEP headers are missing or misconfigured.

**Diagnosis:** Open browser DevTools, go to the Console, and type:

```javascript
typeof SharedArrayBuffer
// Should print "function"
// If it prints "undefined", headers are missing
```

Check the response headers in the Network tab for your HTML page. Both headers must be present:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

**Fix:** Apply the headers for your platform as described above. If using GitHub Pages, add `coi-serviceworker`.

### `crossOriginIsolated` is `false`

**Diagnosis:**

```javascript
console.log(self.crossOriginIsolated);
// Should be true
```

If `crossOriginIsolated` is `false` even though headers appear to be set, check:

1. Both COOP and COEP must be set. Having only one is not enough.
2. Headers must be on the **HTML page response**, not just on subresources.
3. If any iframe on the page does not have matching headers, isolation may fail.

### WASM file returns 404 or wrong MIME type

**Cause:** The server does not recognize `.wasm` files or serves them with the wrong `Content-Type`.

**Fix:** Ensure your server sends `Content-Type: application/wasm` for `.wasm` files. See the Nginx/Apache configs above. Most CDN platforms (Vercel, Netlify, Cloudflare) handle this automatically.

If you see a console error like:

```
Uncaught (in promise) TypeError: Failed to execute 'compile' on 'WebAssembly':
Incorrect response MIME type. Expected 'application/wasm'.
```

This confirms the MIME type is wrong. Check the `Content-Type` header in the Network tab.

### Cross-origin resource blocked by COEP

**Error:**

```
net::ERR_BLOCKED_BY_RESPONSE.NotSameOriginAfterDefaultedToSameOriginByCoep
```

**Cause:** A cross-origin resource (image, font, script from a CDN) does not include a `Cross-Origin-Resource-Policy` header.

**Fix options:**

1. **Self-host the resource** (copy it into your `dist/` or `public/` directory).
2. **Add CORS headers** to the external server and use `crossorigin="anonymous"` on the HTML tag.
3. **Use `credentialless` COEP** instead of `require-corp` (less strict, Chrome 96+ / Firefox 119+):
   ```
   Cross-Origin-Embedder-Policy: credentialless
   ```

### WebGPU not available (`requestAdapter()` returns null)

**Cause:** The browser or hardware does not support WebGPU.

**Diagnosis:**

```javascript
const adapter = await navigator.gpu?.requestAdapter();
console.log(adapter); // null means no WebGPU
```

**Common reasons:**
- Browser does not support WebGPU (Safari < 18, Firefox without flags).
- Running in headless mode (no GPU adapter available).
- GPU driver is blocklisted by the browser.
- Running in a VM without GPU passthrough.

**Note:** Hyperion Engine runs the ECS/WASM simulation regardless of WebGPU availability. Only rendering is disabled when WebGPU is not present.

### Engine falls back to Mode C (single-threaded)

**Diagnosis:** Check the console for capability detection logs. The engine selects:

- **Mode A** if `SharedArrayBuffer` + `OffscreenCanvas` + WebGPU in Workers are all available.
- **Mode B** if `SharedArrayBuffer` is available but `OffscreenCanvas` or worker WebGPU is not.
- **Mode C** if `SharedArrayBuffer` is not available (headers missing or unsupported browser).

If you expected Mode A or B but got Mode C, the most likely cause is missing COOP/COEP headers.

### `vite preview` works but production deploy does not

**Cause:** The Vite preview server includes COOP/COEP headers automatically (configured in `vite.config.ts`). Your production server may not.

**Fix:** Apply the platform-specific header configuration from this guide.

### Audio does not play

**Cause:** Browsers require a user gesture (click, tap, keypress) before allowing `AudioContext` to start.

**Fix:** Ensure the first call to `engine.audio.load()` or `engine.audio.play()` happens inside a user-initiated event handler (e.g., a click listener). Hyperion's `AudioManager` lazily creates the `AudioContext` on first use, so this is handled automatically as long as the triggering code runs in response to a user action.
