// Build the same production modules using the shipped bundler contract. This
// file is then executed with the minimum extension-host Node runtime.
const path = require("path");
require("esbuild").buildSync({
    stdin: { contents: `
        const assert = require('assert');
        const renderer = require('./src/webview/textRenderer');
        const { markdownEngine } = require('./src/webview/markdownEngine');
        const html = renderer.renderDescriptionHtml('<img src=x onerror=evil()><script>evil()</script>$$\\\\frac{a}{b}$$');
        assert(!html.includes('onerror') && !html.includes('<script'));
        assert(html.includes('katex'));
        const styles = renderer.collectMathStyles(html);
        assert(styles.css.includes('height:') && !styles.html.includes(' style='));
        assert(markdownEngine.render('**OK**').includes('<strong>OK</strong>'));
        assert(markdownEngine.render('a@b.co\\n'.repeat(10000)).includes('mailto:'));
        console.log('Bundled renderer smoke passed on Node ' + process.versions.node);
    `, resolveDir: path.resolve(__dirname, "..") },
    outfile: process.argv[2] || path.join(require("os").tmpdir(), "authy-runtime-smoke.cjs"), bundle: true, platform: "node", format: "cjs",
    target: "node14", external: ["vscode"], logLevel: "warning",
    define: { "Object.hasOwn": "bundledHasOwn" },
    inject: [path.resolve(__dirname, "../src/runtimeCompat.ts")],
});
