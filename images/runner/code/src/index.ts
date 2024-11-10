import { Octokit } from 'octokit';
import fs from 'fs';
import { exit } from 'process';
import path from 'path';
import { Agent } from 'undici'
import { Ollama } from 'ollama';
import remarkStringify from 'remark-stringify';
import remarkParse from 'remark-parse';
import remarkBreakLine from 'remark-break-line';
import { unified } from 'unified';
import remarkWiki from 'remark-wiki-link';
import type { BlockContent, DefinitionContent, ListItem, Paragraph, Root, RootContent } from 'mdast';
import { simpleGit } from 'simple-git';



const noTimeoutFetch = (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const someInit = init || {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return fetch(input, { ...someInit, keepalive: true, dispatcher: new Agent({ headersTimeout: Number.MAX_SAFE_INTEGER }) as any })
}

type ModelPropertys = {
    context_window: number
}

const model_properties = {
    'qwen2.5:32b': {
        context_window: 27192,
    },
    'gemma2:27b': {
        context_window: 27192,
    },
    'gemma2:9b': {
        context_window: 27192,
    },
    'llama3.2:3b': {
        context_window: 27192,
    },
    'llama3.2:1b': {
        context_window: 27192,
    },
    'llama3.1:32b': {
        context_window: 27192,
    },
} as const satisfies Record<string, ModelPropertys>;

// the name of the repo
const repo = "test-github";
// where to store the repo locally
const clone_location = "/data/repo";
// the model to use
const model: keyof typeof model_properties = 'qwen2.5:32b';
// manly for debbugging purpus
const branch_prefix = 'debug-1/'

const githubApiToken = process.env.GITHUB_API_TOKEN;
const context_window = model_properties[model].context_window;

if (!githubApiToken) {
    throw new Error("GITHUB_API_TOKEN is not set");
}



console.time();

const transformToAst = (text: string) => unified()
    .use(remarkParse)
    .use(remarkWiki, { hrefTemplate: (x: string) => x.toLocaleLowerCase() })
    .use(remarkBreakLine, {
        "removeLinebreaksAndMultipleSpaces": true,
        "maxLineLength": 30,
        "mergableElements": [
            "emphasis",
            "strong"
        ]
    }).parse(text);



const formatMarkdown = (text: string) => unified()
    .use(remarkParse)
    .use(remarkWiki, { hrefTemplate: (x: string) => x.toLocaleLowerCase() })
    .use(remarkBreakLine, {
        "removeLinebreaksAndMultipleSpaces": true,
        "maxLineLength": 60,
        "mergableElements": [
            "emphasis",
            "strong"
        ]
    })
    .use(remarkStringify)
    .processSync(text).value as string;

const transformFromAst = (ast: Root) => unified()
    .use(remarkWiki, { hrefTemplate: (x: string) => x.toLocaleLowerCase() })
    .use(remarkBreakLine, {
        "removeLinebreaksAndMultipleSpaces": true,
        "maxLineLength": 30,
        "mergableElements": [
            "emphasis",
            "strong"
        ]
    }).use(remarkStringify)
    .stringify(ast)
    ;



// Create a personal access token at https://github.com/settings/tokens/new?scopes=repo
const octokit = new Octokit({ auth: githubApiToken });
console.timeLog(undefined, 'connect to ollama');
const storyFolder = "story";

const {
    data: { login },
} = await octokit.rest.users.getAuthenticated();



const ollama = new Ollama({ host: 'http://ollama:11434', fetch: noTimeoutFetch });
const models = await ollama.list();

const generateModel = (system) => `FROM ${model} 
PARAMETER num_ctx ${context_window}
SYSTEM """
${system}
"""
`;

const spellingSystem = fs.readFileSync('src/spelling.system', 'utf8');

if (models.models.every(m => m.name !== 'spelling')) {
    console.timeLog(undefined, 'create spelling model');
    await ollama.create({ model: 'spelling', modelfile: generateModel(spellingSystem) });
} else {
    console.timeLog(undefined, 'spelling model exists');
    await ollama.delete({ model: 'spelling' });
    await ollama.create({ model: 'spelling', modelfile: generateModel(spellingSystem) });
}







// checkout repository
const { data: repository } = await octokit.rest.repos.get({
    owner: login,
    repo,
});


const clone_url = new URL(repository.clone_url);
clone_url.username = login;
clone_url.password = githubApiToken;
// console.timeLog(undefined, JSON.stringify(repository, null, 2));


if (!fs.existsSync(clone_location)) {
    console.timeLog(undefined, 'clone repository');
    await simpleGit().clone(clone_url.toString(), clone_location);
    // clone repository
} else {
    console.timeLog(undefined, 'repository exists');
}

const git = simpleGit({ baseDir: clone_location });
await git.fetch(["--all"]);
await git.checkout('main');
await git.pull();

//  git config --global user.email "you@example.com"
//   git config --global user.name "Your Name"
await git.addConfig('user.email', 'no-reply@no.no', false, 'global');
await git.addConfig('user.name', 'Editor', false, 'global');


// change data




const now = () => new Date(Date.now());
// create a branch

const branches = await git.branch();
const getBranchForHash = async (file: string) => {
    const log = await git.log({ maxCount: 1, file: path.join(storyFolder, file) });
    const hash = log.all[0].hash;
    const date = new Date(log.all[0].date);
    const branch_name = `${branch_prefix}${file}/${date.getFullYear()}-${date.getMonth()}-${date.getDate()}'/'${date.getHours()}-${date.getMinutes()}-${date.getSeconds()}/${model.replaceAll(/[:.]/g, '_')}--${hash}`;
    const exists = branches.all.some(b => b.endsWith(branch_name));
    return {
        exists,
        date,
        branch: branch_name,
    };
};

// send files in story folder one after the other to ollama
const files = fs.readdirSync(path.join(clone_location, storyFolder));
for (const file of files) {
    await git.checkout('main');

    try {
        const messages: Array<BlockContent | DefinitionContent>[] = [];

        const { branch, date, exists } = await getBranchForHash(file);

        let pulls = await octokit.rest.pulls.list({ repo: repo, owner: login });
        if (!pulls.data.some(p => p.head.ref === branch)) {

            // we need to read the file in the main state, otherwise the number of paragraphs may be wrong
            // after we parsed the file we need to switch back to the branch
            let story = fs.readFileSync(path.join(clone_location, storyFolder, file), 'utf8');
            if (exists) {
                console.timeLog(undefined, `checkout branch ${branch}`);
                await git.checkout(branch);
            } else {
                console.timeLog(undefined, `create branch ${branch}`);
                await git.checkoutLocalBranch(branch);
            }

            const metadataFile = `${file}.metadata`;


            const metadata: { paragraph: number, messages: Array<BlockContent | DefinitionContent>[], time_in_ms: number } = fs.existsSync(path.join(clone_location, storyFolder, metadataFile))
                ? JSON.parse(fs.readFileSync(path.join(clone_location, storyFolder, metadataFile), 'utf8'))
                : { paragraph: 0, messages: [], time_in_ms: 0 };
            messages.push(...(metadata.messages ?? []));

            const ast = await transformToAst(story);
            // now read the current file so we get the old changes
            story = fs.readFileSync(path.join(clone_location, storyFolder, file), 'utf8');


            const textblocks = ast.children.reverse();

            for (let i = 0; i < textblocks.length; i++) {
                const startBlock = now();
                if (i < metadata.paragraph) {
                    console.timeLog(undefined, `skip paragraph ${i}`);
                    continue;
                }
                let element = [textblocks[i]];
                while (i + 1 < textblocks.length && textblocks[i + 1].type !== 'paragraph') {
                    // add previous non paragraph elements to current
                    element = [textblocks[i + 1], ...element];
                    i++;
                }
                metadata.paragraph = i;
                const text = transformFromAst({ type: 'root', children: element });
                let changes = false;
                let currentTime = 0;
                for (let trys = 0; trys < 10; trys++) {

                    console.timeLog(undefined, `Process Part\n\n${text}\n\n`);

                    const result = await ollama.chat({ model: 'spelling', messages: [{ role: 'user', content: text }], stream: true });
                    const parts = [] as string[];


                    console.timeLog(undefined, 'Response \n\n');

                    for await (const part of result) {
                        parts.push(part.message.content);
                        process.stdout.write(part.message.content);
                    }


                    console.timeLog(undefined, `Response Finished`);
                    // console.timeLog(undefined, part.message.content);

                    const corrected = parts.join('');
                    // console.timeLog(undefined, formatMarkdown(corrected));

                    if (corrected.length < text.length * 0.8) {
                        // probably not the result we want
                        console.timeLog(undefined, `retry  ${trys} of 10`);
                        try {

                            messages.push([
                                {
                                    type: 'paragraph',
                                    children: [
                                        {
                                            type: 'text',
                                            value: `retry ${trys} of 10 for textpart ${textblocks.length - 1}`
                                        }]
                                },
                                {
                                    type: 'blockquote',
                                    children: [
                                        ...transformToAst(corrected).children as any
                                    ]
                                }
                            ]
                            )
                        } catch (error) {
                            // this should always return an valid AST for this method, but to be safe
                            messages.push([ParagrahTexts(JSON.stringify(error))]);
                        }
                        continue;
                    }

                    const start_of_text = element[0].position!.start.offset!;
                    const end_of_text = element[element.length - 1].position!.end.offset!;

                    const newStory = story.substring(0, start_of_text)
                        + formatMarkdown(corrected) + (end_of_text < story.length ? (
                            story.substring(end_of_text + 1)) : ''
                        )
                        ;
                    metadata.paragraph
                    fs.writeFileSync(path.join(clone_location, storyFolder, file), newStory);
                    fs.writeFileSync(path.join(clone_location, storyFolder, metadataFile), JSON.stringify(metadata, null, 2));
                    changes = story !== newStory
                    story = newStory;
                    const endBlock = now();
                    currentTime = endBlock.getTime() - startBlock.getTime();
                    metadata.time_in_ms += currentTime;
                    // we got an updated text just stop now
                    break;
                }
                if (!changes) {
                    console.timeLog(undefined, `No Changes for ${textblocks.length - i} to ${textblocks.length - i + element.length - 1}`);
                    if (element.length > 1) {
                        messages.push([ParagrahTexts(`No changes for parts ${textblocks.length - i} to ${textblocks.length - i + element.length - 1}`)])
                    } else {
                        messages.push([ParagrahTexts(`No changes for part ${textblocks.length - i}`)])
                    }
                }

                metadata.messages = messages;
                fs.writeFileSync(path.join(clone_location, storyFolder, metadataFile), JSON.stringify(metadata, null, 2));

                console.timeLog(undefined, 'commit changes');
                // commit changes
                await git.add('.');
                await git.commit(`correct ${file} ${i + 1}/${textblocks.length}\n\nTime needed: **${printTime(currentTime)}**`);
                // push changes
                await git.push('origin', branch);

            }


            // create a pull request
            const { data: pullRequest } = await octokit.rest.pulls.create({
                owner: login,
                repo,
                title: `Correct ${file} ${date.toLocaleString('de')}`,
                head: branch,
                base: "main",
                body: transformFromAst({
                    type: 'root', children: [
                        {
                            type: 'paragraph', children: [
                                { type: 'text', value: `Time needed: ` },
                                { type: 'strong', children: [{ type: 'text', value: printTime(metadata.time_in_ms) }] }
                            ]
                        },
                        { type: 'paragraph', children: [{ type: 'text', value: 'Notable:' }] },
                        {
                            type: 'list', children: [
                                ...messages.map(m =>
                                ({
                                    type: 'listItem' as const, children:
                                        m
                                }))
                            ]
                        }
                    ]
                })
            });
            console.timeLog(undefined, `Created pull request ${pullRequest.html_url} for ${file}`);
            console.timeLog(undefined, 'remove metadata');
            fs.rmSync(path.join(clone_location, storyFolder, metadataFile));
            // commit changes
            await git.add('.');
            await git.commit(`correct ${file} clean up`);
            // push changes
            await git.push('origin', branch);

            await git.checkout('main');
        }


   

    } catch (error) {
        console.error(`Failed to process ${file}`, error);
        try {
            octokit.rest.issues.create({
                owner: login,
                repo,
                title: `Failed to process ${file}`,
                body: "```\n" + JSON.stringify(error, null, 2) + "\n```"
            })
        } catch (error1) {
            console.error('Failed to create issue', error1);
        }
    }
}



function ParagrahTexts(params: string): Paragraph {
    return {
        type: 'paragraph',
        children: [{ type: 'text', value: params }]
    }

}

function printTime(time_in_ms: number): string {
    const totalSeconds = time_in_ms / 1000;
    const seconds = Math.floor(totalSeconds % 60);
    const minutes = Math.floor(totalSeconds / 60 % 60);
    const hours = Math.floor(totalSeconds / 60 / 60);
    // only print parts that are not 0
    let result = '';
    if (hours > 0) {
        result += `${hours} h `;
    }
    if (minutes > 0) {
        result += `${minutes} min `;
    }
    if (seconds > 0) {
        result += `${seconds} s `;
    }
    return result.trimEnd();

}
