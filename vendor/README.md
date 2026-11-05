# Bundled browser dependencies

These files are distributed with the application so editor startup, icons, QR preview and Markdown do not depend on a JavaScript CDN. Optional web fonts still use Google Fonts with local font fallbacks.

| File | Upstream package | License |
| --- | --- | --- |
| `markdown-it.min.js` | [markdown-it 15.0.3](https://www.npmjs.com/package/markdown-it/v/15.0.3), `dist/browser/markdown-it.umd.min.js` | MIT, `markdown-it.LICENSE.txt` |
| `lucide.min.js` | [lucide 1.69.0](https://www.npmjs.com/package/lucide/v/1.69.0), `dist/umd/lucide.min.js` | ISC, `lucide.LICENSE.txt` |
| `qrcodejs.min.js` | [qrcodejs 1.0.0](https://www.npmjs.com/package/qrcodejs/v/1.0.0), `qrcode.min.js` | MIT, `qrcodejs.LICENSE.txt` |

Downloaded package archives were checked against their npm registry SHA-512 integrity metadata before extraction. Keep the corresponding licenses when replacing bundles.
