import {defineConfig} from 'vite';
import path from 'path';
import ViteRestart from 'vite-plugin-restart';
import viteCompression from 'vite-plugin-compression';
import terser from '@rollup/plugin-terser';
import VitePluginSvgSpritemap from '@spiriit/vite-plugin-svg-spritemap';
import critical from 'rollup-plugin-critical';

// https://vitejs.dev/config/
export default defineConfig(({command}) => ({
    base: command === 'serve' ? '' : '/dist/',
    publicDir: path.resolve(__dirname, './build/static'),
    build: {
        emptyOutDir: true,
        manifest: 'manifest.json',
        outDir: path.resolve('./public/dist'),
        sourcemap: false,
        assetsInlineLimit: 0,
        rollupOptions: {
            input: {
                'js/app': './build/js/app.js'
            },
            output: {
                entryFileNames: '[name].[hash].js',
                chunkFileNames: '[name].[hash].js',
                assetFileNames: ({name}) => {
                    if (/\.(gif|jpe?g|png|svg|webp|ico)$/.test(name ?? '')) {
                        return 'img/[name].[hash][extname]';
                    }

                    if (/\.(woff|woff2|otf|ttf)$/.test(name ?? '')) {
                        return 'fonts/[name].[hash][extname]';
                    }

                    if (/\.css$/.test(name ?? '')) {
                        return 'css/[name].[hash][extname]';
                    }

                    return 'assets/[name].[hash][extname]';
                },
            },
        },
    },
    css: {
        preprocessorOptions: {
            scss: {
                additionalData: command === 'serve'
                    ? `@use '@css/theme/setup' with ($sprite-type: uri);`
                    : `@use '@css/theme/setup' with ($sprite-type: fragment);`,
            },
        },
    },
    plugins: [
        VitePluginSvgSpritemap('./build/icons/*.svg', {
            output: {
                filename: '[name].[hash].[ext]',
            },
            styles: {
                lang: 'scss',
                filename: 'build/scss/templates/_sprite.scss',
            },
            svgo: {
                plugins: [
                    {
                        name: 'removeAttrs',
                        params: {
                            attrs: ['clip-path', 'mask']
                        }
                    }
                ]
            },
        }),
        viteCompression(),
        terser({
            format: {
                comments: false,
            },
        }),
        // Critical CSS. Runs on `writeBundle`, so it's build-only — `npm run dev`
        // never touches it. For each page below it loads the URL in headless
        // Chromium, works out which of the just-built CSS applies above the fold,
        // and writes that to public/dist/criticalcss/<template>_critical.min.css.
        //
        // It renders the LIVE site, so the site has to be up and serving the build
        // you just made. That means the order is: build, then critical — which is
        // what writeBundle gives us, since Craft reads the new manifest on the very
        // next request.
        //
        // Needs Chromium, installed into the web container by
        // .ddev/web-build/Dockerfile.chromium (Puppeteer's own download is x86-64
        // only and won't exec on arm64).
        critical({
            criticalUrl: process.env.URL,
            criticalBase: './public/dist/criticalcss/',
            // `template` is NOT a free label — it's the filename Craft will look for.
            // craft.vite.includeCriticalCssTags(tplPath) resolves tplPath (`_self`,
            // set in each view) to a path, strips everything up to `templates/`, and
            // appends `_critical.min.css`. So these have to be the view template
            // paths, minus the extension, or the lookup silently finds nothing.
            criticalPages: [
                {uri: '', template: '_views/single/home/default'},
                {uri: 'case-studies', template: '_views/single/case-studies/default'},
                {uri: 'contact', template: '_views/single/contact/default'},
                {uri: 'about', template: '_views/single/about/default'},
                // Stands in for every entry in the caseStudies structure — they all
                // render through one view, so one page's critical CSS covers the rest.
                // The URI has to be a LIVE entry: a 404 renders fine and generates a
                // critical file for the error page instead, with no warning.
                {uri: 'case-study/vaiie-product-branding', template: '_views/structure/caseStudies/default'},
                // Likewise one plain page stands in for the whole `pages` structure.
                {uri: 'ai-policy', template: '_views/structure/pages/default'},
            ],
            criticalConfig: {
                // Capture at every breakpoint the CSS actually has, not the plugin's
                // single 1200x1200 default. With one narrow capture the critical file
                // only carries the 48em and 64em blocks, so anything wider than 1200px
                // paints the ~1024px layout first and then jumps when the async
                // stylesheet arrives — the h1 alone moves rem(80) -> rem(100).
                // Breakpoints are 48em/64em/80em/108em = 768/1024/1280/1728.
                dimensions: [
                    {width: 390, height: 844},   // phone
                    {width: 768, height: 1024},  // md
                    {width: 1280, height: 900},  // lg
                    {width: 1728, height: 1000}, // xxl, and the page's max width
                ],
                // Write .css files rather than rewriting HTML. Craft inlines them
                // itself, gated on the criticalcss cookie (see FrontEndVariable).
                inline: false,
                extract: false,
                // ddev serves a self-signed cert, which critical's own fetch of the
                // page HTML rejects by default. Penthouse already passes
                // --ignore-certificate-errors to Chromium, so this is the only
                // TLS opt-out needed.
                request: {
                    https: {rejectUnauthorized: false},
                },
                penthouse: {
                    // The page-transition rules live in _utilities.scss, but neither
                    // class is on <html> when the page is captured, so penthouse would
                    // drop them as unmatched — and a first-time visitor gets the main
                    // CSS asynchronously, too late to hide the incoming page. Forcing
                    // them in is what lets the warp live in SCSS instead of an inline
                    // <style> in head.twig.
                    // A regex, not strings: penthouse compares string entries with
                    // `toMatchSelector.value === selector`, i.e. the WHOLE selector
                    // exactly, so a literal only ever covers one exact rule. The regex
                    // also picks up any descendant selector added later — otherwise
                    // that rule is dropped silently, with no error and no symptom
                    // except a flash on arrival for first-time visitors.
                    forceInclude: [/is-page-(leaving|entering)/],
                },
            },
        }),
        ViteRestart({
            reload: [
                'craft/templates/**/*',
                'build/icons/**/*',
            ],
            restart: [
                'vite.config.js',
                'craft/config/vite.php',
            ]
        }),
    ],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, 'build'),
            '@css': path.resolve(__dirname, 'build/scss'),
            '@js': path.resolve(__dirname, 'build/js'),
            '@fonts': path.resolve(__dirname, 'build/fonts'),
            '@images': path.resolve(__dirname, 'build/images'),
        },
    },
    server: {
        fs: {
            strict: false
        },
        cors: true,
        host: '0.0.0.0',
        origin: process.env.URL.substring(0, process.env.URL.length - 1) + ':3000',
        port: 3000,
        strictPort: true,
    },
}));
