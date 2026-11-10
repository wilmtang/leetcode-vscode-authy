// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'nextlevelbuilder/ui-ux-pro-max-skill';
const SOURCE = '.claude/skills/ui-ux-pro-max';
export const SKILL_PATH = '.agents/skills/ui-ux-pro-max';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const REQUIRED_FILES = ['SKILL.md', 'scripts/search.py', 'scripts/core.py', 'scripts/validate_data.py'];

export function blobHash(content) {
    const bytes = Buffer.from(content);
    return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function parseProvenance(content) {
    const revisions = [...content.matchAll(/^- Revision: `([a-f0-9]{40})`$/gm)];
    if (revisions.length !== 1
        || !content.includes(`- Repository: https://github.com/${REPOSITORY}\n`)
        || !content.includes(`- Source directory: \`${SOURCE}\`\n`)) {
        throw new Error('Unrecognized skill provenance; update the integration manually.');
    }
    return revisions[0][1];
}

export function selectSkillFiles(tree) {
    if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('Incomplete upstream tree.');
    const files = new Map();
    let totalBytes = 0;
    for (const entry of tree.tree) {
        if (!entry.path.startsWith(`${SOURCE}/`) || entry.type === 'tree') continue;
        const relative = entry.path.slice(SOURCE.length + 1);
        if (relative.split('/').some(part => !part || part === '.' || part === '..')
            || relative.includes('\\')) throw new Error(`Unsafe upstream path: ${relative}`);
        const selected = relative === 'SKILL.md'
            || relative.startsWith('data/') || relative.startsWith('references/')
            || (relative.startsWith('scripts/') && !relative.startsWith('scripts/tests/'));
        if (!selected) continue;
        if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)
            || (relative.startsWith('scripts/') && !relative.endsWith('.py'))) {
            throw new Error(`Unsupported upstream file: ${relative}`);
        }
        if (!/^[a-f0-9]{40}$/.test(entry.sha)
            || !Number.isSafeInteger(entry.size) || entry.size < 0
            || entry.size > MAX_FILE_BYTES || files.has(relative)) {
            throw new Error(`Invalid upstream file metadata: ${relative}`);
        }
        totalBytes += entry.size;
        files.set(relative, entry);
    }
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Upstream skill exceeds the size limit.');
    for (const file of REQUIRED_FILES) {
        if (!files.has(file)) throw new Error(`Upstream skill is missing ${file}.`);
    }
    return files;
}

async function installedFiles(root) {
    const files = new Map();
    async function visit(relative) {
        const target = path.join(root, relative);
        const stat = await lstat(target);
        if (stat.isSymbolicLink()) throw new Error(`Unexpected local symlink: ${relative}`);
        if (stat.isDirectory()) {
            for (const name of await readdir(target)) {
                if (name === '__pycache__' || name.endsWith('.pyc')) continue;
                await visit(`${relative}/${name}`);
            }
        } else if (stat.isFile()) {
            files.set(relative, await readFile(target));
        } else {
            throw new Error(`Unsupported local file: ${relative}`);
        }
    }
    for (const directory of ['scripts', 'data', 'references']) await visit(directory);
    return files;
}

export async function mergeSkillMarkdown(local, base, upstream) {
    const temporary = await mkdtemp(path.join(tmpdir(), 'leetcode-auth-sync-skill-merge-'));
    try {
        const files = ['local', 'base', 'upstream'].map(name => path.join(temporary, name));
        await Promise.all(files.map((file, index) => writeFile(file, [local, base, upstream][index])));
        const result = spawnSync('git', ['merge-file', '-p', '--', ...files], {
            encoding: 'utf8', maxBuffer: MAX_FILE_BYTES,
        });
        if (result.error) throw result.error;
        if (result.status !== 0) {
            throw new Error('Upstream SKILL.md conflicts with local guidance; resolve it manually.');
        }
        return Buffer.from(result.stdout);
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}

// Prepare every byte before writing anything. Download failures, local changes,
// unsupported layouts, license changes and merge conflicts leave the copy intact.
export async function planSkillUpdate({ root, baseTree, headTree, revision, readUpstream, date }) {
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Expected a full upstream commit SHA.');
    const provenance = await readFile(path.join(root, 'UPSTREAM.md'), 'utf8');
    const previous = parseProvenance(provenance);
    if (previous === revision) return [];
    for (const file of ['SKILL.md', 'LICENSE', 'UPSTREAM.md']) {
        if (!(await lstat(path.join(root, file))).isFile()) {
            throw new Error(`Expected a regular local file: ${file}`);
        }
    }
    const base = selectSkillFiles(baseTree);
    const head = selectSkillFiles(headTree);
    const local = await installedFiles(root);
    for (const [file, bytes] of local) {
        if (!base.has(file) || blobHash(bytes) !== base.get(file).sha) {
            throw new Error(`Local upstream file has changed: ${file}`);
        }
    }
    for (const file of base.keys()) {
        if (file !== 'SKILL.md' && !local.has(file)) throw new Error(`Missing local upstream file: ${file}`);
    }
    const license = headTree.tree.find(entry => entry.path === 'LICENSE');
    if (license?.type !== 'blob' || license.mode !== '100644'
        || blobHash(await readFile(path.join(root, 'LICENSE'))) !== license.sha) {
        throw new Error('Upstream license changed; review it manually.');
    }
    async function download(commit, entry) {
        const bytes = Buffer.from(await readUpstream(commit, entry.path));
        if (bytes.length !== entry.size || blobHash(bytes) !== entry.sha) {
            throw new Error(`Upstream download did not match its pinned blob: ${entry.path}`);
        }
        return bytes;
    }
    const changes = [];
    for (const [file, entry] of head) {
        if (file === 'SKILL.md') continue;
        if (local.has(file) && blobHash(local.get(file)) === entry.sha
            && base.get(file).mode === entry.mode) continue;
        changes.push({ file, content: await download(revision, entry), mode: entry.mode });
    }
    for (const file of local.keys()) {
        if (!head.has(file)) changes.push({ file, content: null });
    }
    if (base.get('SKILL.md').sha !== head.get('SKILL.md').sha) {
        const content = await mergeSkillMarkdown(
            await readFile(path.join(root, 'SKILL.md')),
            await download(previous, base.get('SKILL.md')),
            await download(revision, head.get('SKILL.md')),
        );
        changes.push({ file: 'SKILL.md', content, mode: '100644' });
    }
    let updated = provenance.replace(`- Revision: \`${previous}\``, `- Revision: \`${revision}\``);
    const updatedLine = `- Updated: ${date.toISOString().slice(0, 10)}`;
    if (/^- Updated: .+$/m.test(updated)) updated = updated.replace(/^- Updated: .+$/m, updatedLine);
    else updated = updated.replace(/^(- Installed: .+)$/m, `$1\n${updatedLine}`);
    changes.push({ file: 'UPSTREAM.md', content: Buffer.from(updated), mode: '100644' });
    return changes;
}

export async function applySkillUpdate(root, changes) {
    for (const { file, content, mode } of changes) {
        const target = path.join(root, file);
        if (content === null) await rm(target);
        else {
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, content);
            await chmod(target, mode === '100755' ? 0o755 : 0o644);
        }
    }
}

async function upstreamRequest(url, json = true) {
    const response = await fetch(url, {
        redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'leetcode-auth-sync-skill-updater' },
    });
    if (!response.ok) throw new Error(`Upstream request failed (${response.status}): ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_TOTAL_BYTES) throw new Error('Upstream response exceeds the size limit.');
    return json ? JSON.parse(bytes.toString('utf8')) : bytes;
}

function assertCleanSkill(repositoryRoot) {
    const status = spawnSync('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain', '--', SKILL_PATH], {
        cwd: repositoryRoot, encoding: 'utf8',
    });
    if (status.error) throw status.error;
    if (status.status !== 0 || status.stdout.trim()) throw new Error('The skill working tree must be clean.');
}

export async function main(args = process.argv.slice(2)) {
    if (args.some(arg => arg !== '--check') || args.length > 1) {
        throw new Error('Usage: node scripts/update-ui-ux-skill.mjs [--check]');
    }
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const root = path.join(repositoryRoot, SKILL_PATH);
    if (!(await lstat(root)).isDirectory()) throw new Error('Expected the canonical skill directory.');
    assertCleanSkill(repositoryRoot);
    const previous = parseProvenance(await readFile(path.join(root, 'UPSTREAM.md'), 'utf8'));
    const api = `https://api.github.com/repos/${REPOSITORY}`;
    const { sha: revision } = await upstreamRequest(`${api}/commits/main`);
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid upstream head.');
    if (previous === revision) {
        console.log(JSON.stringify({ previous, revision, changed: false, files: [] }));
        return;
    }
    const comparison = await upstreamRequest(`${api}/compare/${previous}...${revision}`);
    if (comparison.status !== 'ahead' || comparison.merge_base_commit?.sha !== previous) {
        throw new Error('Upstream history diverged from the installed revision; review it manually.');
    }
    const [baseTree, headTree] = await Promise.all([previous, revision].map(commit =>
        upstreamRequest(`${api}/git/trees/${commit}?recursive=1`)));
    const changes = await planSkillUpdate({
        root, baseTree, headTree, revision, date: new Date(),
        readUpstream: (commit, file) => upstreamRequest(
            `https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${file}`, false,
        ),
    });
    if (!args.includes('--check')) {
        assertCleanSkill(repositoryRoot);
        await applySkillUpdate(root, changes);
    }
    console.log(JSON.stringify({ previous, revision, changed: changes.length > 0, files: changes.map(change => change.file) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
