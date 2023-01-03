import {
    getInput,
    setFailed,
} from "@actions/core";
// import { context } from "@actions/github";
const context_raw = getInput('context');
console.log({ context_raw });
const context = JSON.parse(context_raw);
import { Octokit } from "@octokit/rest";

const { rebasePullRequest } = require('github-rebase');

const token = getInput('github_token');
const filter = getInput('filter');
// TODO: better error on failed parse
const max_mergeable_rebases = parseInt(getInput('max_mergeable_rebases'));
if (!['always', 'auto-merge'].includes(filter)) {
    setFailed("Illegal filter used");
}

const octokit = new Octokit({ auth: token });

const owner = context.repo.owner
const repo = context.repo.repo
const base = context.ref
console.log(`Owner: ${owner}`)
console.log(`Repository: ${repo}`)
console.log(`Current branch: ${base}`)

try {
    // run(octokit, owner, repo, base);
    getPullsToRebase(octokit, owner, repo, base).then(console.log);
} catch(error: any) {
    setFailed(error.message);
}

async function getPullsToRebase(octokit: Octokit, owner: string, repo: string, base: string) {
    const url = "/repos/{owner}/{repo}/pulls";
    console.log({ url });
    const pulls = await octokit.paginate(`GET ${url}`, {
        owner,
        repo,
        base
    }, res => res.data);

    let pullsToRebase;
    if (filter === 'auto-merge') {
        pullsToRebase = pulls.filter(pull => pull.auto_merge !== null)

        if (pullsToRebase.length === 0) {
            console.log(`No PR's updated. There are ${pulls.length} PR's open, but none are on auto merge`)
        }
    } else {
        pullsToRebase = pulls
    }

    return pullsToRebase
}

async function run(octokit: Octokit, owner: string, repo: string, base: string) {
    let pullsToRebase = await getPullsToRebase(octokit, owner, repo, base)

    await Promise.all(pullsToRebase.map(async (pull) => {
        try {
            const newSha = await rebasePullRequest({
                octokit,
                owner: owner,
                pullRequestNumber: pull.number,
                repo: repo
            })
            console.log(`updated PR "${pull.title}" to new HEAD ${newSha}`)
        } catch(error: any) {
            console.log(error.message)
            if (error instanceof Error && error.message === "Merge conflict") {
                console.log(`Could not update "${pull.title}" because of merge conflicts`)
            } else {
                throw error;
            }
        }
    }));
}
