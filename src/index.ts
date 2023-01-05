import {
    getInput,
    setFailed,
} from "@actions/core";
// Use the following if debugging and comment out the `import` line
const context = JSON.parse(getInput('context'));
// import { context } from "@actions/github";
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
    // Use the following if debugging and comment out the `run` line
    prsToRebase(octokit, owner, repo, base).then(console.log).catch(console.error);
    // run(octokit, owner, repo, base);
} catch(error: any) {
    setFailed(error.message);
}

function searchRequestQuery(owner: string, repo: string) {
    return `repo:${owner}/${repo} is:pr is:open -review:changes_requested review:approved status:success draft:false`;
}

async function getApprovedPassingPrs(octokit: Octokit, owner: string, repo: string) {
    const raw_query = searchRequestQuery(owner, repo);
    console.log({ raw_query });
    const pulls = await octokit.paginate("GET /search/issues", { q: raw_query });

    return pulls
}

async function getPrs(octokit: Octokit, owner: string, repo: string, base: string) {
    const pulls = await octokit.paginate("GET /repos/{owner}/{repo}/pulls", {
        owner,
        repo,
        base,
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

interface BasicMap {
    [key: string]: any,
}

interface Pullish extends BasicMap {
    number: number,
    title: string,
}

function groupByNumber(prs: Iterable<Pullish>): { [key: string]: Pullish } {
    let prsByNumber: { [key: string]: Pullish } = {}

    for (const pr of prs) {
        let num = pr.number as number
        prsByNumber[num] = pr
    }

    return prsByNumber
}

function combineAndCategorize(prsFromSearch: Iterable<Pullish>, prsFromGet: Iterable<Pullish>) {
    let searchByNumber = groupByNumber(prsFromSearch)
    let getByNumber = groupByNumber(prsFromGet)

    let prsByBase: { [key: string]: { latent: any, imminent: any } } = {}

    for (const [number, pr] of Object.entries(getByNumber)) {
        prsByBase[pr.base.ref] ||= {
            latent: {},
            imminent: {},
        }

        if (pr.auto_merge && searchByNumber[number]) {
            prsByBase[pr.base.ref].imminent[number] = pr
        } else {
            prsByBase[pr.base.ref].latent[number] = pr
        }
    }

    return prsByBase
}

// Notes:
// It might make things more sane to limit the action to a single base
// branch (i.e., the one that just changed and triggered the action).

type CategorizedByBranch = {
    // The branch name
    [key: string]: {
        // PRs that need to be rebased but have else that will prevent
        // them from immediately being merged
        latent: { [key: string]: Pullish },
        // PRs that we expect to be immediately auto-merged upon
        // rebasing.
        imminent: { [key: string]: Pullish },
    }
}

async function joinedPrs(octokit: Octokit, owner: string, repo: string, base: string):
    Promise<CategorizedByBranch>
{
    let prsFromSearch = await getApprovedPassingPrs(octokit, owner, repo)
    let prsFromGet = await getPrs(octokit, owner, repo, base)

    return combineAndCategorize(prsFromSearch, prsFromGet)
}

function prsToRebaseByBranch(joinedPrs: CategorizedByBranch): { [key: string]: Array<Pullish> } {
    let out: { [key: string]: Array<Pullish> } = {}

    // If we don't intend to limit rebases, we'll pass through the
    // imminents unmodified
    //
    // TODO: If we limit the number of rebases, should we pick them in
    // deterministic or random order? If deterministic, what should the
    // sorting mechanism be?
    const imminentLimiter = max_mergeable_rebases === 0
        ? <T,>(values: Array<T>) => values
        : <T,>(values: Array<T>) => values.slice(0, max_mergeable_rebases)

        for (const [branch, { latent, imminent }] of Object.entries(joinedPrs)) {
            // The PRs categorized as imminent will end up being
            // auto-merged into their base branch as soon as we rebase
            // them, so if _any_ PRs are imminent, we start there.
            //
            // We rely on the fact that this action should be
            // retriggered again when that auto-merge occurs and
            // modifies the base branch.
            out[branch] = (
                Object.keys(imminent).length === 0
                    ? Object.values(latent)
                    : imminentLimiter(Object.values(imminent))
            ).map(({ number, title }) => ({ number, title }))
        }

        // Note: Even with all this filtering, it's still incomplete. If
        // we were to fetch the individual pulls rather than the group,
        // we'd be able to see whether they're rebaseable. Also whether
        // they're mergeable, although I'm less clear on how that's
        // defined. (Is it whether we can merge updates from the base
        // branch into the PR branch or that the PR branch can be merged
        // into the base branch?)

        return out
}

async function prsToRebase(octokit: Octokit, owner: string, repo: string, base: string) {
    let eligiblePrs = await joinedPrs(octokit, owner, repo, base)
    return Object.values(prsToRebaseByBranch(eligiblePrs)).flat()
}

async function run(octokit: Octokit, owner: string, repo: string, base: string) {
    const prs = await prsToRebase(octokit, owner, repo, base)
    await Promise.all(prs.map(async (pull) => {
        try {
            const newSha = await rebasePullRequest({
                octokit,
                owner: owner,
                pullRequestNumber: pull.number,
                repo: repo
            })
            console.log(`updated PR "${pull.title}" to new HEAD ${newSha}`)
        } catch(error: any) {
            // TODO: Again, we can make things fancier. If rebases in
            // the imminent PR category fail we should proceed to the
            // next imminent PR. If all the imminent PRs fail to rebase,
            // we can go ahead with the latent PRs.
            console.log(error.message)
            if (error instanceof Error && error.message === "Merge conflict") {
                console.log(`Could not update "${pull.title}" because of merge conflicts`)
            } else {
                throw error;
            }
        }
    }));
}
