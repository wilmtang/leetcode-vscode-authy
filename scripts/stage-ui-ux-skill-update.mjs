// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProvenance, SKILL_PATH } from './update-ui-ux-skill.mjs';

function git(root, args) {
    const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], {
        cwd: root, encoding: 'utf8', maxBuffer: 60 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
    return result.stdout;
}

function checkPaths(paths) {
    if (!paths.length) throw new Error('The skill patch contains no changes.');
    for (const file of paths) {
        if (!file.startsWith(`${SKILL_PATH}/`) || /[\x00-\x1f\\]/.test(file)
            || file.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')
            || file === `${SKILL_PATH}/LICENSE`) {
            throw new Error(`Refusing a change outside the automatic skill update scope: ${file}`);
        }
    }
}

function projectGuidance(markdown) {
    const heading = '## LeetCode Auth Sync integration\n';
    const start = markdown.indexOf(heading);
    if (start < 0) throw new Error('The skill is missing its project guidance.');
    const next = markdown.indexOf('\n## ', start + heading.length);
    return markdown.slice(start, next < 0 ? undefined : next);
}

// Only trusted repository code runs in the publisher. Inspect the patch before
// applying it and the resulting index afterwards; never execute its helpers.
export async function stageSkillUpdate(root, patchFile, baseRevision) {
    if (!/^[a-f0-9]{40}$/.test(baseRevision)) throw new Error('Expected the checked base commit SHA.');
    if (git(root, ['status', '--porcelain']).trim()) throw new Error('The publisher checkout must be clean.');
    if (git(root, ['rev-parse', `${baseRevision}:${SKILL_PATH}`])
        !== git(root, ['rev-parse', `HEAD:${SKILL_PATH}`])) {
        throw new Error('The skill changed since validation; run the updater again.');
    }
    const patch = await readFile(patchFile);
    if (!patch.length) throw new Error('The skill patch contains no changes.');
    if (patch.length > 50 * 1024 * 1024) throw new Error('The skill patch exceeds the size limit.');
    const paths = git(root, ['apply', '--numstat', '-z', patchFile]).split('\0').filter(Boolean).map(entry => {
        const fields = entry.split('\t');
        return fields.length === 3 ? fields[2] : '';
    });
    checkPaths(paths);
    const guidance = projectGuidance(git(root, ['show', `HEAD:${SKILL_PATH}/SKILL.md`]));
    git(root, ['apply', '--index', '--', patchFile]);
    const staged = git(root, ['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean);
    checkPaths(staged);
    const raw = git(root, ['diff', '--cached', '--raw', '--no-renames', '-z']).split('\0');
    for (const entry of raw.filter(value => value.startsWith(':'))) {
        const mode = entry.split(' ')[1];
        if (!['000000', '100644', '100755'].includes(mode)) {
            throw new Error('The skill update contains a symlink or unsupported file mode.');
        }
    }
    if (projectGuidance(git(root, ['show', `:${SKILL_PATH}/SKILL.md`])) !== guidance) {
        throw new Error('The skill update changes project guidance.');
    }
    for (const file of ['SKILL.md', 'LICENSE', 'scripts/search.py', 'scripts/core.py', 'scripts/validate_data.py']) {
        git(root, ['cat-file', '-e', `:${SKILL_PATH}/${file}`]);
    }
    parseProvenance(git(root, ['show', `:${SKILL_PATH}/UPSTREAM.md`]));
    git(root, ['diff', '--cached', '--check']);
    return staged;
}

export async function main(args = process.argv.slice(2)) {
    if (args.length !== 2) throw new Error('Usage: node scripts/stage-ui-ux-skill-update.mjs PATCH BASE_SHA');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const files = await stageSkillUpdate(root, path.resolve(args[0]), args[1]);
    git(root, [
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'user.name=github-actions[bot]',
        '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit', '-m', 'chore: update ui ux skill from upstream',
        '-m', 'Sync the pinned upstream skill while preserving project guidance and its license. [skip ci]',
        '-m', 'Verification: skill data validation and the isolated Python example search passed in the read-only preparation job.',
    ]);
    const commit = git(root, ['rev-parse', 'HEAD']).trim();
    console.log(git(root, ['log', '-1', '--format=raw']));
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `commit=${commit}\n`);
    console.log(JSON.stringify({ commit, files }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
