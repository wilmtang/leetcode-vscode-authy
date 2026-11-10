// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import nodeTest from 'node:test';
import yaml from 'js-yaml';
import { stageSkillUpdate, main } from '../../scripts/stage-ui-ux-skill-update.mjs';
import { SKILL_PATH } from '../../scripts/update-ui-ux-skill.mjs';

// The updater runs only in Linux CI. Its symlink, bash and python3 fixtures
// assume POSIX tooling that the Windows npm test job does not provide.
const test = (name, fn) => nodeTest(name, { skip: process.platform === 'win32' && 'POSIX-only skill updater' }, fn);

function git(root, args) {
    const result = spawnSync('git', [
        '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
        '-c', 'user.name=Skill test', '-c', 'user.email=skill-test@example.invalid', ...args,
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
}

async function fixture(t) {
    const temporary = await mkdtemp(path.join(tmpdir(), 'leetcode-auth-sync-skill-publisher-'));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    await mkdir(path.join(temporary, 'repo'));
    const root = await realpath(path.join(temporary, 'repo'));
    git(root, ['init', '-b', 'main']);
    const markdown = '# Skill\n\n## LeetCode Auth Sync integration\n\nKeep project guidance.\n\n## Usage\n\nSearch normally.\n';
    const files = new Map([
        [`${SKILL_PATH}/SKILL.md`, markdown], [`${SKILL_PATH}/LICENSE`, 'MIT\n'],
        [`${SKILL_PATH}/UPSTREAM.md`, `- Repository: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill\n- Revision: \`${'a'.repeat(40)}\`\n- Source directory: \`.claude/skills/ui-ux-pro-max\`\n`],
        [`${SKILL_PATH}/scripts/core.py`, 'before\n'],
        [`${SKILL_PATH}/scripts/search.py`, 'search\n'],
        [`${SKILL_PATH}/scripts/validate_data.py`, 'validate\n'],
        ['src/application.js', 'existing application\n'],
        ['scripts/stage-ui-ux-skill-update.mjs', await readFile(new URL('../../scripts/stage-ui-ux-skill-update.mjs', import.meta.url), 'utf8')],
        ['scripts/update-ui-ux-skill.mjs', await readFile(new URL('../../scripts/update-ui-ux-skill.mjs', import.meta.url), 'utf8')],
    ]);
    for (const [file, content] of files) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), content);
    }
    git(root, ['add', '--all']);
    git(root, ['commit', '-m', 'test: initial fixture']);
    const base = git(root, ['rev-parse', 'HEAD']).trim();
    const patch = path.join(temporary, 'update.patch');
    return {
        root, patch, base, markdown,
        async capture() {
            git(root, ['add', '--all']);
            await writeFile(patch, git(root, ['diff', '--cached', '--binary', '--no-renames']));
            // Only this disposable fixture is restored; never the user's checkout.
            git(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', '.']);
            assert.equal(git(root, ['status', '--porcelain']).trim(), '');
        },
    };
}

test('publisher stages changed and newly added skill helpers', async t => {
    const f = await fixture(t);
    await writeFile(path.join(f.root, SKILL_PATH, 'scripts/core.py'), 'after\n');
    await writeFile(path.join(f.root, SKILL_PATH, 'scripts/new.py'), 'new helper\n');
    await f.capture();
    const changed = await stageSkillUpdate(f.root, f.patch, f.base);
    assert.deepEqual(changed.sort(), [`${SKILL_PATH}/scripts/core.py`, `${SKILL_PATH}/scripts/new.py`]);
    assert.equal(git(f.root, ['show', `:${SKILL_PATH}/scripts/new.py`]), 'new helper\n');
});

test('publisher CLI makes one skill-only commit with the checked base and no application CI', async t => {
    const f = await fixture(t);
    await writeFile(path.join(f.root, SKILL_PATH, 'scripts/core.py'), 'checked update\n');
    await f.capture();
    const result = spawnSync(process.execPath, [
        path.join(f.root, 'scripts/stage-ui-ux-skill-update.mjs'), f.patch, f.base,
    ], { cwd: f.root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const published = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(git(f.root, ['rev-parse', 'HEAD^']).trim(), f.base);
    assert.equal(git(f.root, ['rev-parse', 'HEAD']).trim(), published.commit);
    assert.deepEqual(published.files, [`${SKILL_PATH}/scripts/core.py`]);
    assert.match(git(f.root, ['log', '-1', '--format=%B']), /\[skip ci\]/);
    assert.match(result.stdout, /parent [a-f0-9]{40}/, 'inspect the raw commit before publication');
    assert.equal(git(f.root, ['status', '--porcelain']).trim(), '');
});

test('publisher rejects application and license changes before writing them', async t => {
    for (const file of ['src/application.js', `${SKILL_PATH}/LICENSE`]) {
        await t.test(file, async subtest => {
            const f = await fixture(subtest);
            const original = await readFile(path.join(f.root, file), 'utf8');
            await writeFile(path.join(f.root, file), 'unapproved change\n');
            await f.capture();
            await assert.rejects(stageSkillUpdate(f.root, f.patch, f.base), /outside the automatic skill update scope/);
            assert.equal(await readFile(path.join(f.root, file), 'utf8'), original);
            assert.equal(git(f.root, ['status', '--porcelain']).trim(), '');
        });
    }
});

test('publisher rejects symlinks and changes to project guidance', async t => {
    await t.test('symlink', async subtest => {
        const f = await fixture(subtest);
        await symlink('core.py', path.join(f.root, SKILL_PATH, 'scripts/link.py'));
        await f.capture();
        await assert.rejects(stageSkillUpdate(f.root, f.patch, f.base), /symlink or unsupported file mode/);
    });
    await t.test('project guidance', async subtest => {
        const f = await fixture(subtest);
        await writeFile(path.join(f.root, SKILL_PATH, 'SKILL.md'), f.markdown.replace('Keep project guidance.', 'Remove project guidance.'));
        await f.capture();
        await assert.rejects(stageSkillUpdate(f.root, f.patch, f.base), /changes project guidance/);
    });
});

test('publisher tolerates a newer application commit but rejects a newer skill revision', async t => {
    for (const changedSkill of [false, true]) {
        await t.test(changedSkill ? 'skill advanced' : 'application advanced', async subtest => {
            const f = await fixture(subtest);
            await writeFile(path.join(f.root, SKILL_PATH, 'scripts/core.py'), 'checked update\n');
            await f.capture();
            const concurrent = changedSkill ? `${SKILL_PATH}/scripts/search.py` : 'src/application.js';
            await writeFile(path.join(f.root, concurrent), 'concurrent update\n');
            git(f.root, ['add', '--all']);
            git(f.root, ['commit', '-m', 'test: concurrent update']);
            if (changedSkill) {
                await assert.rejects(stageSkillUpdate(f.root, f.patch, f.base), /skill changed since validation/);
            } else {
                await stageSkillUpdate(f.root, f.patch, f.base);
                assert.equal(await readFile(path.join(f.root, 'src/application.js'), 'utf8'), 'concurrent update\n');
            }
        });
    }
});

test('publisher rejects empty patches, dirty checkouts and unknown CLI usage', async t => {
    const f = await fixture(t);
    await writeFile(f.patch, '');
    await assert.rejects(stageSkillUpdate(f.root, f.patch, f.base), /no changes/);
    await writeFile(path.join(f.root, 'src/application.js'), 'local work\n');
    await assert.rejects(stageSkillUpdate(f.root, f.patch, f.base), /checkout must be clean/);
    await assert.rejects(main([]), /Usage:/);
});

test('GitHub cron keeps validation read-only and grants the key only to the final direct-main push', async () => {
    const workflow = yaml.load(await readFile(new URL('../../.github/workflows/update-ui-ux-skill.yml', import.meta.url), 'utf8'));
    assert.deepEqual(workflow.on.schedule, [{ cron: '17 15 1 * *' }]);
    assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.doesNotMatch(JSON.stringify(workflow.jobs.prepare), /SKILL_UPDATE_SSH_KEY|secrets\./);
    assert.equal(workflow.jobs.publish.needs, 'prepare');
    assert.equal(workflow.jobs.publish.environment, 'skill-updates');
    const patch = workflow.jobs.prepare.steps.find(step => step.id === 'patch');
    assert.match(patch.run, /git add --all/);
    assert.match(patch.run, /git diff --cached --binary --no-renames/,
        'newly added helpers must be included in the transferred patch');
    const publish = workflow.jobs.publish.steps;
    assert.ok(!publish.some(step => /\bpython3?\b|\bnpm\b/.test(step.run || '')),
        'the credential-bearing job must not execute candidate helpers');
    assert.equal(publish.filter(step => JSON.stringify(step).includes('secrets.SKILL_UPDATE_SSH_KEY')).length, 1);
    const push = publish.at(-1);
    assert.equal(push.env.SKILL_UPDATE_SSH_KEY, '${{ secrets.SKILL_UPDATE_SSH_KEY }}');
    assert.match(push.run, /HEAD:refs\/heads\/main/);
    assert.doesNotMatch(push.run, /--force|StrictHostKeyChecking=no|ssh-keyscan/);
    assert.match(push.run, /trap 'rm -rf "\$key_dir"' EXIT/);
    for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps) {
            if (step.uses) assert.match(step.uses, /^[^@]+@[a-f0-9]{40}$/);
            if (step.run) {
                const syntax = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' });
                assert.equal(syntax.status, 0, `${step.name}: ${syntax.stderr}`);
            }
        }
    }
});
