# clipfish

mobile-first skateboarding camera PWA.

live webgl fisheye. clean / classic / deep lens presets. records the filtered canvas with microphone audio. front and rear cameras. replay, share, download, home-screen install.

static only: html, css, javascript, webgl, mediarecorder, pwa files.

## run local

serve the `dist` folder over https (or localhost):

```bash
npx --yes serve dist
```

## github

https://github.com/saintsola13/clipfish

## cloudflare pages

this repo deploys `dist` with wrangler.

1. create a Cloudflare Pages project named `clipfish`
2. add repo secrets:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
3. push `main` or run the **cloudflare-pages** workflow

or from a machine with wrangler logged in:

```bash
npx wrangler pages deploy dist --project-name=clipfish
```

branding and icons live in `dist/branding` and `dist/icons`.
