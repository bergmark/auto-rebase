import {
    getInput,
    setFailed,
} from "@actions/core";
// Use the following if debugging and comment out the `import` line
// const context = JSON.parse(getInput('context'));
import { context } from "@actions/github";
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
    // prsToRebase(octokit, owner, repo, base).then(console.log).catch(console.error);
    run(octokit, owner, repo, base);
} catch(error: any) {
    setFailed(error.message);
}

function searchRequestQuery(owner: string, repo: string, base: string) {
    return `repo:${owner}/${repo} is:pr is:open -review:changes_requested review:approved status:success draft:false base:${base}`;
}

async function getApprovedPassingPrs(octokit: Octokit, owner: string, repo: string, base: string) {
    const raw_query = searchRequestQuery(owner, repo, base);
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

function combineAndCategorize(prsFromSearch: Iterable<Pullish>, prsFromGet: Iterable<Pullish>): Categorized {
    let searchByNumber = groupByNumber(prsFromSearch)
    let getByNumber = groupByNumber(prsFromGet)

    let prs: Categorized  = {latent: {}, imminent: {}}

    for (const [number, pr] of Object.entries(getByNumber)) {
        if (pr.auto_merge && searchByNumber[number]) {
            prs.imminent[number] = pr
        } else {
            prs.latent[number] = pr
        }
    }

    return prs
}

type Categorized = {
    // PRs that need to be rebased but have conditions that will prevent
    // them from immediately being merged.
    latent: { [key: string]: Pullish },
    // PRs that need to be rebased but have nothing else that will
    // prevent them from immediately being merged. (I.e, they're
    // approved, have no failed CI checks, and are set to auto-merge.)
    imminent: { [key: string]: Pullish },
}

async function joinedPrs(octokit: Octokit, owner: string, repo: string, base: string):
    Promise<Categorized>
{
    let prsFromSearch = await getApprovedPassingPrs(octokit, owner, repo, base)
    let prsFromGet = await getPrs(octokit, owner, repo, base)

    return combineAndCategorize(prsFromSearch, prsFromGet)
}

function extract<T>(ary: T[], index: number): { value: T, rest: T[] } {
    let value = ary[index]
    let rest = ary.slice(0, index).concat(ary.slice(index + 1))
    return { value, rest }
}

// Return n random elements of ary
function select<T>(ary: T[], n: number): T[] {
    let values = []
    var rest = ary

    for (let i = 0; i < n && rest.length > 0; i++) {
        let randIndex = Math.floor(Math.random() * rest.length)
        let extraction = extract(rest, randIndex)
        let value = extraction.value
        rest = extraction.rest
        values.push(value)
    }

    return values
}

async function prsToRebase(octokit: Octokit, owner: string, repo: string, base: string): Promise<Pullish[]> {
    let {imminent, latent} = await joinedPrs(octokit, owner, repo, base)

    const imminentLimiter = () => {
        // The PRs categorized as imminent will end up being auto-merged
        // into their base branch as soon as we rebase them, so if _any_
        // PRs are imminent, we start there.
        //
        // We rely on the fact that this action should be retriggered
        // again when that auto-merge occurs and modifies the base
        // branch.
        //
        // Again, we could make things fancier. If rebases in the
        // imminent PR category fail we could proceed to the next
        // imminent PR. If all the imminent PRs fail to rebase, we can
        // go ahead with the latent PRs.
        return Object.keys(imminent).length === 0
            ? Object.values(latent)
            : select(Object.values(imminent), max_mergeable_rebases)
    }

    // If we don't intend to limit rebases, we'll pass through the
    // imminents and latents unmodified
    const prs = (max_mergeable_rebases === 0)
        ? Object.values(imminent).concat(Object.values(latent))
        : imminentLimiter()

    // Well, unmodified aside from reducing them down to only the
    // necessary fields.
    return prs.map(({number, title}) => ({number, title}))
}

async function run(octokit: Octokit, owner: string, repo: string, base: string) {
    const prs = await prsToRebase(octokit, owner, repo, base)
    await Promise.all(prs.map(async (pull) => await rebasePr(octokit, owner, repo, pull)));
}

async function rebasePr(octokit: Octokit, owner: string, repo: string, pull: Pullish): Promise<void> {
    try {
        const newSha = await rebasePullRequest({
            octokit,
            owner,
            pullRequestNumber: pull.number,
            repo
        })
        console.log(`updated PR "${pull.title}" to new HEAD ${newSha}`)
    } catch(error: any) {
        // Again, we could make things fancier. If rebases in the
        // imminent PR category fail we should proceed to the next
        // imminent PR. If all the imminent PRs fail to rebase, we can
        // go ahead with the latent PRs.
        console.log(error.message)
        if (error instanceof Error && error.message === "Merge conflict") {
            console.log(`Could not update "${pull.title}" because of merge conflicts`)
        } else {
            throw error;
        }
    }
}
