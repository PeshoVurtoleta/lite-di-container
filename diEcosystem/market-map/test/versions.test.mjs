// versions.test.mjs -- drift guard: index.html's import map is the single source of
// truth for dependency versions. Every version pinned in package.json must appear
// VERBATIM in the import map, so the node_modules the tests run against can never drift
// from the CDN versions the browser demo loads.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const html = readFileSync(join(root, 'index.html'), 'utf8');

test('every dependency version is pinned verbatim in the index.html import map', () => {
    for (const [name, version] of Object.entries(pkg.dependencies)) {
        const specifier = 'https://esm.sh/' + name + '@' + version;
        assert.ok(html.includes(specifier), name + '@' + version + ' missing from import map (' + specifier + ')');
    }
});
